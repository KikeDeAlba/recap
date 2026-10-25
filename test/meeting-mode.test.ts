import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'
import { clearActive, loadActive, saveActive } from '../src/core/active.ts'
import { MeetingStore, decodeMeeting, encodeMeeting, loadMeeting, recordingFileName, recordingPath, updateMeeting } from '../src/core/meeting.ts'
import { meetingRecord } from '../src/core/record.ts'
import { captureChannels } from '../src/capture/sources.ts'
import { defaultTitle, startRecording } from '../src/capture/recording.ts'
import { MacAppRecorder, type Recorder } from '../src/capture/recorder.ts'
import { captureCapabilities } from '../src/capture/capture.ts'
import { modeFrom } from '../src/cli/commands/recording.ts'
import { hasVideo } from '../src/media/media.ts'
import { channelsOf } from '../src/pipeline/pipeline.ts'
import { stageApplies, stageSkipped } from '../src/pipeline/stages.ts'
import { listItems, markdownSection, parseTranscriptMarkdown, summaryView, tableColumn, transcriptView } from '../src/pipeline/views.ts'
import { RecapError } from '../src/errors.ts'
import { meeting, tempDir, writeBytes } from './helpers.ts'

const SUMMARY = `# Planeación

24 de octubre de 2026 · 00:30:00 · reunión presencial

## Resumen
Se revisó el avance del sprint.

## Acuerdos
1. Liberar la versión 0.14 el viernes.
2. Mover la demo al lunes
   por la tarde.

## Pendientes
| # | Pendiente | Responsable | Fecha | Minuto |
|---|---|---|---|---|
| 1 | Preparar notas de la versión | Ana | viernes | [00:12:00] |
| 2 | Revisar el pipeline | — | — | [00:20:00] |

## Preguntas abiertas
Ninguna
`

const SEGMENTS = [
  { startMs: 0, endMs: 2_000, channel: 'mic', text: 'Buenos días.' },
  { startMs: 2_500, endMs: 4_250, channel: 'mic', text: 'Empezamos con el sprint.' },
  { startMs: 40_000, endMs: 42_000, channel: 'mic', text: 'Siguiente tema.' },
]

function fakeRecorder(meetingMode = true): Recorder {
  return {
    kind: 'ffmpeg-linux',
    check: async () => ({ ok: true, missing: [] }),
    permissions: async () => ({ microphone: 'granted', screen: 'not-required' }),
    supports: async (mode) => mode !== 'meeting' || meetingMode,
    launch: async (dir: string) => {
      updateMeeting(dir, (current) => {
        current.status = 'recording'
        current.startedAt = '2026-10-24T10:00:00Z'
        current.recorderPid = process.pid
      })
    },
    stop: async () => undefined,
  }
}

test('start without a mode flag records a meeting; the old flags still pick their mode', () => {
  assert.equal(modeFrom(false, false), undefined)
  assert.equal(modeFrom(true, false), 'remote')
  assert.equal(modeFrom(false, true), 'in-person')
  assert.throws(() => modeFrom(true, true), (error: unknown) => error instanceof RecapError && error.code === 'USAGE')
  assert.equal(defaultTitle('meeting'), 'Meeting')
  assert.equal(defaultTitle('in-person'), 'In-person meeting')
})

test('a meeting records the microphone only to recording.m4a', () => {
  assert.equal(recordingFileName('meeting'), 'recording.m4a')
  assert.deepEqual(captureChannels('meeting'), ['mic'])
  assert.deepEqual(channelsOf(meeting({ mode: 'meeting' })), [['mic', 0]])
})

test('startRecording keeps the meeting mode in meeting.json and active.json', async (t) => {
  const root = tempDir(t)
  t.after(clearActive)
  const located = await startRecording({ title: '', mode: 'meeting', timeout: 2, config: { root }, recorder: fakeRecorder() })
  assert.equal(located.meeting.mode, 'meeting')
  assert.equal(located.meeting.title, 'Meeting')
  assert.equal(loadMeeting(located.dir).mode, 'meeting')
  assert.equal(loadActive()?.mode, 'meeting')
  assert.equal(loadMeeting(located.dir).fallback, undefined)
  assert.equal(meetingRecord(located.meeting, located.dir)['fallback'], undefined)
})

test('startRecording falls back to in-person when the recorder lacks capture.meeting', async (t) => {
  const root = tempDir(t)
  t.after(clearActive)
  const located = await startRecording({ title: '', mode: 'meeting', timeout: 2, config: { root }, recorder: fakeRecorder(false) })
  assert.equal(located.meeting.mode, 'in-person')
  assert.equal(located.meeting.fallback, 'in-person')
  assert.equal(located.meeting.title, 'Meeting')
  assert.equal(loadMeeting(located.dir).fallback, 'in-person')
  assert.equal(loadActive()?.mode, 'in-person')
  assert.equal(meetingRecord(located.meeting, located.dir)['fallback'], 'in-person')
})

test('startRecording keeps an explicit mode even when the recorder lacks capture.meeting', async (t) => {
  t.after(clearActive)
  const located = await startRecording({ title: 'Retro', mode: 'remote', timeout: 2, config: { root: tempDir(t) }, recorder: fakeRecorder(false) })
  assert.equal(located.meeting.mode, 'remote')
  assert.equal(located.meeting.fallback, undefined)
})

test('the mac recorder supports meeting mode only when recap-capture announces capture.meeting', async () => {
  const app = { kind: 'app', app: '/Applications/Recap.app' } as const
  const modern = new MacAppRecorder(async () => app, async () => ['capture.in-person', 'capture.meeting'])
  const legacy = new MacAppRecorder(async () => app, async () => ['capture.remote', 'capture.in-person'])
  const missing = new MacAppRecorder(async () => null, async () => [])
  assert.equal(await modern.supports('meeting'), true)
  assert.equal(await legacy.supports('meeting'), false)
  assert.equal(await legacy.supports('in-person'), true)
  assert.equal(await missing.supports('meeting'), true)
})

test('captureCapabilities reads the envelope and treats failures as no capabilities', async (t) => {
  const binary = { kind: 'binary', binary: '/usr/local/bin/recap-capture' } as const
  const envelope = JSON.stringify({ schemaVersion: 1, ok: true, command: 'capabilities', generatedAt: '2026-10-24T10:00:00Z', data: { name: 'recap-capture', capabilities: ['capture.meeting', 3] } })
  const calls: string[][] = []
  const found = await captureCapabilities(binary, async (command, args) => {
    calls.push([command, ...args])
    return { status: 0, stdout: envelope, stderr: '', signal: null }
  })
  assert.deepEqual(found, ['capture.meeting'])
  assert.deepEqual(calls, [['/usr/local/bin/recap-capture', 'capabilities', '--json']])
  assert.deepEqual(await captureCapabilities(binary, async () => ({ status: 64, stdout: '', stderr: 'unknown command', signal: null })), [])
  assert.deepEqual(await captureCapabilities(binary, async () => Promise.reject(new Error('ENOENT'))), [])
  assert.deepEqual(await captureCapabilities({ kind: 'app', app: tempDir(t) }, async () => ({ status: 0, stdout: envelope, stderr: '', signal: null })), [])
})

test('meeting.json and active.json round-trip the meeting mode', (t) => {
  const created = new MeetingStore({ root: tempDir(t) }).create({ title: 'Sync', mode: 'meeting', bitaEntryId: 5 })
  assert.equal(decodeMeeting(encodeMeeting(created.meeting)).mode, 'meeting')
  assert.throws(() => decodeMeeting(JSON.stringify({ ...created.meeting, mode: 'webinar' })))
  t.after(clearActive)
  saveActive({ meetingId: created.meeting.id, dir: created.dir, mode: 'meeting', startedAt: '2026-10-24T10:00:00Z' })
  assert.equal(loadActive()?.mode, 'meeting')
})

test('a meeting is listed, measured and resolved like the other modes', (t) => {
  const store = new MeetingStore({ root: tempDir(t) })
  const created = store.create({ title: 'Planning', mode: 'meeting', bitaEntryId: 11 })
  store.create({ title: 'Retro', mode: 'in-person' })
  writeBytes(path.join(created.dir, 'recording.m4a'), 40)
  assert.equal(store.find(11)?.meeting.mode, 'meeting')
  assert.equal(store.resolve('planning').meeting.id, created.meeting.id)
  const record = meetingRecord(created.meeting, created.dir)
  assert.equal(record['mode'], 'meeting')
  assert.ok(String(record['recording']).endsWith('recording.m4a'))
  assert.equal((record['storage'] as { recordingBytes: number }).recordingBytes, 40)
  assert.equal(record['hasVideo'], false)
})

test('a meeting without video skips frames, and one with recording.mov keeps its video', (t) => {
  const dir = tempDir(t)
  const value = meeting({ mode: 'meeting', status: 'recorded' })
  writeBytes(path.join(dir, 'recording.m4a'), 10)
  assert.ok(stageApplies('frames', value))
  assert.ok(stageSkipped('frames', value, dir))
  assert.ok(!stageApplies('frames', meeting({ mode: 'in-person' })))
  const video = tempDir(t)
  writeBytes(path.join(video, 'recording.mov'), 10)
  assert.equal(path.basename(recordingPath(video, 'meeting')), 'recording.mov')
  assert.ok(hasVideo(video, 'meeting'))
  assert.ok(!stageSkipped('frames', value, video))
})

test('the transcript view reads transcript.json in seconds with paragraphs and channels', (t) => {
  const dir = tempDir(t)
  writeFileSync(path.join(dir, 'transcript.json'), JSON.stringify(SEGMENTS))
  const view = transcriptView(meeting({ mode: 'meeting' }), dir)
  assert.deepEqual(view.segments[1], { start: 2.5, end: 4.25, channel: 'mic', text: 'Empezamos con el sprint.' })
  assert.deepEqual(view.paragraphs, [
    { start: 0, channel: 'mic', speaker: null, text: 'Buenos días. Empezamos con el sprint.' },
    { start: 40, channel: 'mic', speaker: null, text: 'Siguiente tema.' },
  ])
  assert.deepEqual(view.channels, ['mic'])
})

test('the transcript view labels remote speakers and falls back to transcript.md', (t) => {
  const dir = tempDir(t)
  writeFileSync(path.join(dir, 'transcript.md'), '# Transcripción: Demo\n\nfecha\n\n**[00:00:05] Remotos:** Hola.\n\n**[00:01:10] Sala:** Adelante.\n')
  const view = transcriptView(meeting({ mode: 'remote' }), dir)
  assert.deepEqual(view.channels, ['mic', 'system'])
  assert.deepEqual(view.paragraphs, [
    { start: 5, channel: 'system', speaker: 'Remotos', text: 'Hola.' },
    { start: 70, channel: 'mic', speaker: 'Sala', text: 'Adelante.' },
  ])
  assert.deepEqual(parseTranscriptMarkdown('**[00:00:03]** Sin hablante.'), [{ startMs: 3_000, endMs: 3_000, channel: 'mic', text: 'Sin hablante.' }])
  assert.throws(() => transcriptView(meeting(), tempDir(t)), (error: unknown) => error instanceof RecapError && error.code === 'NO_TRANSCRIPT')
})

test('the summary view parses agreements and pending items from summary.md', (t) => {
  const dir = tempDir(t)
  writeFileSync(path.join(dir, 'summary.md'), SUMMARY)
  const view = summaryView(meeting({ mode: 'meeting' }), dir)
  assert.equal(view.markdown, SUMMARY)
  assert.deepEqual(view.agreements, ['Liberar la versión 0.14 el viernes.', 'Mover la demo al lunes por la tarde.'])
  assert.deepEqual(view.actionItems, [{ text: 'Preparar notas de la versión' }, { text: 'Revisar el pipeline' }])
})

test('the summary view prefers the wrap-up backlog with its keys', (t) => {
  const dir = tempDir(t)
  writeFileSync(path.join(dir, 'summary.md'), SUMMARY)
  writeFileSync(
    path.join(dir, 'wrapup.json'),
    JSON.stringify({ title: 'x', pageTitle: 'x', pageMarkdown: 'x', backlog: [{ kind: 'pending', title: 'Preparar notas' }, { kind: 'finding', title: 'Hallazgo' }, { kind: 'pending', title: 'Sin clave' }] }),
  )
  const value = meeting({ mode: 'meeting', wrapup: { titleChanged: false, projectResolved: true, pageCreated: false, backlogKeys: { 'Preparar notas': 'PEND-4', 'Sin clave': '?' } } })
  assert.deepEqual(summaryView(value, dir).actionItems, [{ text: 'Preparar notas', backlogKey: 'PEND-4' }, { text: 'Sin clave' }])
})

test('the summary view returns empty data when nothing was written yet', (t) => {
  assert.deepEqual(summaryView(meeting(), tempDir(t)), { markdown: '', agreements: [], actionItems: [] })
})

test('the section helpers ignore placeholders, fences and other sections', () => {
  const markdown = '## Acuerdos\nNinguno.\n\n```\n## Pendientes\n```\n## Pendientes\n- Llamar al cliente\n* Ninguno\n'
  assert.deepEqual(listItems(markdownSection(markdown, 'Acuerdos')), [])
  assert.deepEqual(listItems(markdownSection(markdown, 'Pendientes')), ['Llamar al cliente'])
  assert.deepEqual(tableColumn(['| a | b |', '|---|---|', '| 1 | 2 |'], 'B'), ['2'])
  assert.deepEqual(tableColumn(['| a |'], 'b'), [])
})
