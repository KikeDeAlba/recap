import assert from 'node:assert/strict'
import path from 'node:path'
import { test } from 'node:test'
import { MeetingStore, loadMeeting, updateMeeting, encodeMeeting, decodeMeeting } from '../src/core/meeting.ts'
import { swiftPretty, swiftDefault, swiftLine } from '../src/core/json.ts'
import { RecapError } from '../src/errors.ts'
import { tempDir, meeting } from './helpers.ts'

function store(dir: string): MeetingStore {
  return new MeetingStore({ root: path.join(dir, 'root') })
}

test('creates unique ids for the same minute', (t) => {
  const subject = store(tempDir(t))
  const now = new Date(1_790_000_000_000)
  const first = subject.create({ title: 'Daily', mode: 'remote', now })
  const second = subject.create({ title: 'Daily', mode: 'in-person', now })
  assert.notEqual(first.meeting.id, second.meeting.id)
  assert.equal(second.meeting.id, `${first.meeting.id}-2`)
})

test('resolves by partial id and bita entry', (t) => {
  const subject = store(tempDir(t))
  const planning = subject.create({ title: 'Sprint planning', mode: 'remote', bitaEntryId: 42 })
  subject.create({ title: 'Retro', mode: 'in-person' })
  assert.equal(subject.resolve('planning').meeting.id, planning.meeting.id)
  assert.equal(subject.find(42)?.meeting.id, planning.meeting.id)
  assert.equal(subject.find(7), null)
})

test('rejects ambiguous references', (t) => {
  const subject = store(tempDir(t))
  subject.create({ title: 'Sync one', mode: 'remote' })
  subject.create({ title: 'Sync two', mode: 'remote' })
  assert.throws(() => subject.resolve('sync'), (error: unknown) => error instanceof RecapError && error.code === 'MEETING_AMBIGUOUS')
})

test('process locks are exclusive and recover from dead owners', async (t) => {
  const { ProcessLock } = await import('../src/core/lock.ts')
  const { writeFileSync } = await import('node:fs')
  const { spawnSync } = await import('node:child_process')
  const file = path.join(tempDir(t), 'process.lock')
  writeFileSync(file, String(spawnSync(process.execPath, ['-e', '']).pid))
  const lock = new ProcessLock(file)
  writeFileSync(file, String(process.ppid))
  assert.throws(() => new ProcessLock(file), (error: unknown) => error instanceof RecapError && error.code === 'ALREADY_PROCESSING')
  writeFileSync(file, String(process.pid))
  lock.release()
})

test('round trips the meeting file and keeps the keys Swift requires', (t) => {
  const subject = store(tempDir(t))
  const { dir } = subject.create({ title: 'Demo', mode: 'in-person', bitaEntryId: 9 })
  updateMeeting(dir, (item) => {
    item.status = 'recorded'
    item.stages['transcribe'] = { status: 'done', updatedAt: '2026-10-10T10:00:00Z' }
  })
  const loaded = loadMeeting(dir)
  assert.equal(loaded.status, 'recorded')
  assert.equal(loaded.mode, 'in-person')
  assert.equal(loaded.stages['transcribe']?.status, 'done')
  const raw = JSON.parse(encodeMeeting(meeting({ stages: {} }))) as Record<string, unknown>
  for (const key of ['schemaVersion', 'id', 'title', 'mode', 'status', 'createdAt', 'stages']) assert.ok(key in raw, key)
})

test('decodes Swift meeting files with unknown keys and without media fields', () => {
  const parsed = decodeMeeting('{"schemaVersion":1,"id":"x","title":"t","mode":"remote","status":"processed","createdAt":"2026-01-01T00:00:00Z","stages":{"audio":{"status":"done","updatedAt":"2026-01-01T00:00:00Z"}},"futureField":3}')
  assert.equal(parsed.video, undefined)
  assert.equal(parsed.stages['audio']?.status, 'done')
  assert.equal(parsed['futureField'], 3)
})

test('encodes JSON the way Swift JSONEncoder does', () => {
  assert.equal(
    swiftPretty({ zz: { aa: '2', Ab: '1', B: '3' }, a: {}, b: [], c: [1, 2], d: undefined, e: 'x/y', f: 22.5 }),
    '{\n  "a" : {\n\n  },\n  "b" : [\n\n  ],\n  "c" : [\n    1,\n    2\n  ],\n  "e" : "x/y",\n  "f" : 22.5,\n  "zz" : {\n    "Ab" : "1",\n    "B" : "3",\n    "aa" : "2"\n  }\n}',
  )
  assert.equal(swiftDefault({ file: 'frames/a.jpg' }), '{"file":"frames\\/a.jpg"}')
  assert.equal(swiftLine({ text: 'hola', channel: 'mic', startMs: 0, endMs: 1000 }), '{"channel":"mic","endMs":1000,"startMs":0,"text":"hola"}')
})
