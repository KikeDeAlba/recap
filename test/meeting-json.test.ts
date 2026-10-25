import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'
import { parseEnvelope } from '@kikedealba/kit/envelope'
import { MeetingStore, type Meeting, type MeetingMode } from '../src/core/meeting.ts'
import { PACKAGE_ROOT } from '../src/version.ts'
import { sandboxEnv, tempDir } from './helpers.ts'

const BIN = path.join(PACKAGE_ROOT, 'src', 'bin', 'recap.ts')

interface Run {
  code: number
  stdout: string
  stderr: string
}

function recap(args: string[], env: NodeJS.ProcessEnv): Promise<Run> {
  return new Promise((resolve) => {
    execFile(process.execPath, [BIN, ...args], { env, maxBuffer: 16 * 1024 * 1024 }, (error, stdout, stderr) => {
      resolve({ code: error ? Number((error as { code?: number }).code ?? 1) : 0, stdout: String(stdout), stderr: String(stderr) })
    })
  })
}

function inRoot<T>(env: NodeJS.ProcessEnv, body: (store: MeetingStore) => T): T {
  const previous = process.env['RECAP_ROOT']
  process.env['RECAP_ROOT'] = env['RECAP_ROOT'] ?? ''
  try {
    return body(new MeetingStore({}))
  } finally {
    if (previous === undefined) delete process.env['RECAP_ROOT']
    else process.env['RECAP_ROOT'] = previous
  }
}

function setup(t: { after: (fn: () => void) => void }, mode: MeetingMode = 'meeting'): { env: NodeJS.ProcessEnv; dir: string; meeting: Meeting } {
  const env = sandboxEnv(tempDir(t))
  const created = inRoot(env, (store) => store.create({ title: 'Planning', mode }))
  return { env, dir: created.dir, meeting: created.meeting }
}

function sorted(value: object): string[] {
  return Object.keys(value).sort()
}

const SEGMENTS = [
  { startMs: 0, endMs: 1_500, channel: 'mic', text: 'Hola.' },
  { startMs: 1_500, endMs: 3_723_000, channel: 'system', text: 'Largo.' },
]

test('transcript --json has exactly segments, paragraphs and channels with numeric seconds', async (t) => {
  const { env, dir, meeting } = setup(t)
  writeFileSync(path.join(dir, 'transcript.json'), JSON.stringify(SEGMENTS))
  const result = await recap(['transcript', meeting.id, '--json'], env)
  assert.equal(result.code, 0)
  assert.equal(result.stdout.trim().split('\n').length, 1)
  const envelope = parseEnvelope(result.stdout)
  assert.equal(envelope?.ok, true)
  const data = envelope?.data as { segments: Record<string, unknown>[]; paragraphs: Record<string, unknown>[]; channels: string[] }
  assert.deepEqual(sorted(data), ['channels', 'paragraphs', 'segments'])
  for (const segment of data.segments) {
    assert.deepEqual(sorted(segment), ['channel', 'end', 'start', 'text'])
    assert.equal(typeof segment['start'], 'number')
    assert.equal(typeof segment['end'], 'number')
    assert.equal(typeof segment['channel'], 'string')
    assert.equal(typeof segment['text'], 'string')
  }
  for (const paragraph of data.paragraphs) {
    assert.deepEqual(sorted(paragraph), ['channel', 'speaker', 'start', 'text'])
    assert.equal(typeof paragraph['start'], 'number')
    assert.equal(paragraph['speaker'], null)
  }
  assert.deepEqual(data.segments[0], { start: 0, end: 1.5, channel: 'mic', text: 'Hola.' })
  assert.equal(data.segments[1]?.['end'], 3723)
  assert.deepEqual(data.channels, ['mic', 'system'])
  assert.ok(Array.isArray(data.channels))
})

test('transcript --json with an empty transcript.json keeps the shape and the mode channels', async (t) => {
  const { env, dir, meeting } = setup(t)
  writeFileSync(path.join(dir, 'transcript.json'), '[]')
  const data = parseEnvelope((await recap(['transcript', meeting.id, '--json'], env)).stdout)?.data
  assert.deepEqual(data, { segments: [], paragraphs: [], channels: ['mic'] })
})

test('transcript --json skips malformed segments and falls back to transcript.md on a corrupt file', async (t) => {
  const { env, dir, meeting } = setup(t)
  writeFileSync(path.join(dir, 'transcript.json'), JSON.stringify([{ startMs: 'x', endMs: 1, channel: 'mic', text: 'a' }, { startMs: 0, endMs: 1_000, channel: 'tv', text: 'b' }, { startMs: 2_000, endMs: 3_000, channel: 'mic', text: 'ok' }]))
  const filtered = parseEnvelope((await recap(['transcript', meeting.id, '--json'], env)).stdout)?.data as { segments: unknown[] }
  assert.deepEqual(filtered.segments, [{ start: 2, end: 3, channel: 'mic', text: 'ok' }])
  writeFileSync(path.join(dir, 'transcript.json'), '{"not":"an array"')
  writeFileSync(path.join(dir, 'transcript.md'), '# T\n\n**[01:02:03]** Desde markdown.\n')
  const fallback = parseEnvelope((await recap(['transcript', meeting.id, '--json'], env)).stdout)?.data as { segments: { start: number }[]; paragraphs: { speaker: unknown }[] }
  assert.equal(fallback.segments[0]?.start, 3723)
  assert.equal(fallback.paragraphs[0]?.speaker, null)
})

test('transcript fails with NO_TRANSCRIPT as an error envelope and as plain text', async (t) => {
  const { env, meeting } = setup(t)
  const json = await recap(['transcript', meeting.id, '--json'], env)
  assert.notEqual(json.code, 0)
  const envelope = parseEnvelope(json.stdout)
  assert.equal(envelope?.ok, false)
  assert.equal(envelope?.error?.code, 'NO_TRANSCRIPT')
  assert.equal(envelope?.data, undefined)
  const text = await recap(['transcript', meeting.id], env)
  assert.notEqual(text.code, 0)
  assert.match(text.stderr, /NO_TRANSCRIPT/)
  assert.equal(text.stdout, '')
})

test('a remote meeting labels its speakers and always reports both channels', async (t) => {
  const { env, dir, meeting } = setup(t, 'remote')
  writeFileSync(path.join(dir, 'transcript.json'), JSON.stringify([SEGMENTS[0]]))
  const data = parseEnvelope((await recap(['transcript', meeting.id, '--json'], env)).stdout)?.data as { paragraphs: { speaker: string }[]; channels: string[] }
  assert.deepEqual(data.paragraphs.map((paragraph) => paragraph.speaker), ['Sala'])
  assert.deepEqual(data.channels, ['mic', 'system'])
})

test('summary --json has exactly markdown, agreements and actionItems', async (t) => {
  const { env, dir, meeting } = setup(t)
  writeFileSync(path.join(dir, 'summary.md'), '# Plan\n\n## Acuerdos\n- Uno\n\n## Pendientes\n- Hacer algo\n')
  const result = await recap(['summary', meeting.id, '--json'], env)
  assert.equal(result.code, 0)
  const data = parseEnvelope(result.stdout)?.data as { markdown: unknown; agreements: unknown[]; actionItems: Record<string, unknown>[] }
  assert.deepEqual(sorted(data), ['actionItems', 'agreements', 'markdown'])
  assert.equal(typeof data.markdown, 'string')
  assert.deepEqual(data.agreements, ['Uno'])
  assert.deepEqual(data.actionItems, [{ text: 'Hacer algo' }])
  assert.ok(!('backlogKey' in (data.actionItems[0] ?? {})))
})

test('summary --json omits backlogKey for unresolved keys and sets it for resolved ones', async (t) => {
  const { env, dir, meeting } = setup(t)
  writeFileSync(path.join(dir, 'summary.md'), '# Plan\n')
  writeFileSync(path.join(dir, 'wrapup.json'), JSON.stringify({ backlog: [{ kind: 'pending', title: 'A' }, { kind: 'pending', title: 'B' }] }))
  const located = inRoot(env, (store) => store.resolve(meeting.id))
  writeFileSync(path.join(dir, 'meeting.json'), JSON.stringify({ ...located.meeting, wrapup: { titleChanged: false, projectResolved: true, pageCreated: false, backlogKeys: { A: 'PEND-1', B: '?' } } }))
  const items = (parseEnvelope((await recap(['summary', meeting.id, '--json'], env)).stdout)?.data as { actionItems: Record<string, unknown>[] }).actionItems
  assert.deepEqual(items, [{ text: 'A', backlogKey: 'PEND-1' }, { text: 'B' }])
  assert.ok(!('backlogKey' in (items[1] ?? {})))
})

test('summary with no summary.md: --json succeeds with empty values, plain text fails with NO_SUMMARY', async (t) => {
  const { env, meeting } = setup(t)
  const json = await recap(['summary', meeting.id, '--json'], env)
  assert.equal(json.code, 0)
  const envelope = parseEnvelope(json.stdout)
  assert.equal(envelope?.ok, true)
  assert.deepEqual(envelope?.data, { markdown: '', agreements: [], actionItems: [] })
  const text = await recap(['summary', meeting.id], env)
  assert.notEqual(text.code, 0)
  assert.match(text.stderr, /NO_SUMMARY/)
})

test('summary with an empty summary.md behaves like a missing one', async (t) => {
  const { env, dir, meeting } = setup(t)
  writeFileSync(path.join(dir, 'summary.md'), '')
  assert.deepEqual(parseEnvelope((await recap(['summary', meeting.id, '--json'], env)).stdout)?.data, { markdown: '', agreements: [], actionItems: [] })
})

test('summary lists nothing for placeholder sections', async (t) => {
  const { env, dir, meeting } = setup(t)
  writeFileSync(path.join(dir, 'summary.md'), '# Plan\n\n## Acuerdos\nNinguno\n\n## Pendientes\n- Ninguno\n')
  const data = parseEnvelope((await recap(['summary', meeting.id, '--json'], env)).stdout)?.data as { agreements: unknown[]; actionItems: unknown[] }
  assert.deepEqual(data.agreements, [])
  assert.deepEqual(data.actionItems, [])
})
