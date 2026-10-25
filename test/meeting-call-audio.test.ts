import assert from 'node:assert/strict'
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'
import { ProposalGenerator } from '../src/bita/proposals.ts'
import { assembleMeeting, assembledChannels } from '../src/capture/assemble.ts'
import { destinationSpans, hadDestination, readManifest, type DestinationSpan } from '../src/capture/manifest.ts'
import { hasSystemAudio, loadMeeting, saveMeeting } from '../src/core/meeting.ts'
import { renderAskPrompt, type AskRequest } from '../src/live/ask.ts'
import { emptyContext } from '../src/live/context.ts'
import { QuestionDetector, START_CURSOR, detectorBatch, renderDetectPrompt } from '../src/live/detector.ts'
import { appendLines, liveFiles, readLines } from '../src/live/files.ts'
import { LiveMerger, duringSpans, systemSpansOf } from '../src/live/merger.ts'
import { LiveWorker } from '../src/live/worker.ts'
import { Pipeline, channelsOf } from '../src/pipeline/pipeline.ts'
import { renderSummaryPrompt } from '../src/pipeline/summary.ts'
import { decodeSegment, type Channel, type Segment } from '../src/pipeline/transcript.ts'
import { transcriptView } from '../src/pipeline/views.ts'
import { FakeTool, meeting, meetingDir, tempDir } from './helpers.ts'

const segment = (startMs: number, endMs: number, channel: Channel, text: string): Segment => ({ startMs, endMs, channel, text })

const ZOOM = { kind: 'window', id: 4242, title: 'Zoom Meeting', app: 'zoom.us', since: '2026-10-25T12:00:00Z' }

function writeManifest(dir: string, manifest: Record<string, unknown>): void {
  writeFileSync(path.join(dir, 'capture.json'), JSON.stringify({ version: 1, mic: 'mic.m4a', startedAt: '2026-10-25T12:00:00Z', video: null, segments: [], ...manifest }))
}

test('the destination spans come from the screen segments of capture.json', (t) => {
  const dir = tempDir(t)
  assert.deepEqual(destinationSpans(readManifest(dir)), [])
  assert.equal(hadDestination(dir), false)
  writeManifest(dir, { video: ZOOM, segments: [{ file: 'screen-2.mov', startMs: 40_000 }, { file: 'screen-1.mov', startMs: 10_000, endMs: 30_000 }] })
  assert.deepEqual(destinationSpans(readManifest(dir)), [{ startMs: 10_000, endMs: 30_000 }, { startMs: 40_000, endMs: undefined }])
  assert.equal(hadDestination(dir), true)
  writeManifest(dir, { video: ZOOM })
  assert.equal(hadDestination(dir), true)
})

test('a meeting carries call audio only once it had a destination, and the assembled channels win', (t) => {
  const dir = tempDir(t)
  assert.equal(hasSystemAudio(meeting({ mode: 'remote' }), dir), true)
  assert.equal(hasSystemAudio(meeting({ mode: 'meeting' }), dir), false)
  writeManifest(dir, { segments: [{ file: 'screen-1.mov', startMs: 0, endMs: 5_000 }] })
  assert.equal(hasSystemAudio(meeting({ mode: 'meeting' }), dir), true)
  assert.equal(hasSystemAudio(meeting({ mode: 'in-person' }), dir), false)
  assert.equal(hasSystemAudio(meeting({ mode: 'meeting', channels: ['mic'] }), dir), false)
  assert.equal(hasSystemAudio(meeting({ mode: 'meeting', channels: ['mic', 'system'] }), tempDir(t)), true)
})

test('in a meeting the merger holds the microphone only while a destination records and drops its echo', () => {
  let spans: DestinationSpan[] = [{ startMs: 10_000, endMs: 30_000 }]
  const merger = new LiveMerger(() => spans, 30)
  const now = Date.now()
  const before = segment(1_000, 4_000, 'mic', 'Buenos días a todos')
  assert.deepEqual(merger.add([before], 'mic', 4_000, now), [before])
  const echo = segment(12_300, 16_200, 'mic', 'acordamos entregar el reporte el viernes')
  const own = segment(17_000, 19_000, 'mic', 'Perfecto, yo me encargo del reporte')
  assert.deepEqual(merger.add([echo, own], 'mic', 19_000, now), [])
  const call = segment(12_000, 16_000, 'system', 'Acordamos entregar el reporte el viernes')
  assert.deepEqual(merger.add([call], 'system', 22_000, now), [call, own])
  const after = segment(40_000, 42_000, 'mic', 'Ya colgaron, sigamos')
  assert.deepEqual(merger.add([after], 'mic', 42_000, now), [after])
  spans = [...spans, { startMs: 50_000 }]
  const open = segment(60_000, 62_000, 'mic', 'Otra vez en llamada')
  assert.deepEqual(merger.add([open], 'mic', 62_000, now), [])
  assert.deepEqual(merger.advance('system', 65_000, now), [open])
})

test('the merger spans follow the meeting mode and capture.json', (t) => {
  const dir = tempDir(t)
  const probe = segment(5_000, 6_000, 'mic', 'x')
  assert.equal(duringSpans(probe, systemSpansOf(meeting({ mode: 'remote' }), dir)()), true)
  assert.equal(duringSpans(probe, systemSpansOf(meeting({ mode: 'in-person' }), dir)()), false)
  const spans = systemSpansOf(meeting({ mode: 'meeting' }), dir)
  assert.equal(duringSpans(probe, spans()), false)
  writeManifest(dir, { video: ZOOM, segments: [{ file: 'screen-1.mov', startMs: 7_000 }] })
  assert.equal(duringSpans(probe, spans()), true)
  assert.equal(duringSpans(segment(1_000, 2_000, 'mic', 'x'), spans()), false)
})

function fakeWhisper(dir: string): string {
  const file = path.join(dir, 'fake-whisper.cjs')
  writeFileSync(
    file,
    `#!/usr/bin/env node
const fs = require('node:fs')
const args = process.argv.slice(2)
const wav = args[args.length - 1]
const base = args[args.indexOf('-of') + 1]
const said = JSON.parse(fs.readFileSync(wav + '.json', 'utf8'))
fs.writeFileSync(base + '.json', JSON.stringify({ transcription: said.map(([from, to, text]) => ({ offsets: { from, to }, text })) }))
`,
  )
  chmodSync(file, 0o755)
  return file
}

function chunk(dir: string, channel: Channel, seq: number, startMs: number, endMs: number, said: [number, number, string][] | null): Record<string, unknown> {
  if (said === null) return { channel, seq, startMs, endMs }
  const name = `${channel}-${String(seq).padStart(5, '0')}.wav`
  writeFileSync(path.join(liveFiles.chunks(dir), name), Buffer.alloc(64))
  writeFileSync(path.join(liveFiles.chunks(dir), `${name}.json`), JSON.stringify(said))
  return { file: name, channel, seq, startMs, endMs }
}

async function runWorker(t: { after: (fn: () => void) => void }, withDestination: boolean): Promise<Segment[]> {
  const { dir } = meetingDir(t, { mode: 'meeting', status: 'recorded', startedAt: '2026-10-25T12:00:00Z' })
  const tools = tempDir(t)
  const model = path.join(tools, 'model.bin')
  writeFileSync(model, 'model')
  if (withDestination) writeManifest(dir, { segments: [{ file: 'screen-1.mov', startMs: 10_000, endMs: 30_000 }] })
  else writeManifest(dir, {})
  mkdirSync(liveFiles.chunks(dir), { recursive: true })
  const entries = [
    chunk(dir, 'mic', 1, 0, 5_000, [[0, 4_000, 'Buenos días a todos']]),
    chunk(dir, 'mic', 2, 12_000, 20_000, [[300, 4_200, 'acordamos entregar el reporte el viernes'], [5_000, 7_000, 'Perfecto, yo me encargo del reporte']]),
    ...(withDestination
      ? [chunk(dir, 'system', 1, 10_000, 20_000, [[2_000, 6_000, 'Acordamos entregar el reporte el viernes']]), chunk(dir, 'system', 2, 20_000, 30_000, null)]
      : []),
    chunk(dir, 'mic', 3, 35_000, 40_000, [[0, 3_000, 'Listo, cerramos']]),
  ]
  appendLines(entries, liveFiles.chunkIndex(dir))
  const config = { tools: { 'whisper-cli': fakeWhisper(tools) }, whisperModel: model }
  await new LiveWorker(dir, config, () => undefined, { pollSeconds: 0.01, autoAskEnabled: () => false }).run()
  return readLines(liveFiles.transcript(dir), decodeSegment)
}

test('the live worker of a meeting with a destination labels the call and drops the echo of the microphone', { skip: process.platform === 'win32' }, async (t) => {
  const written = await runWorker(t, true)
  assert.deepEqual(
    written.map((item) => [item.channel, item.text]),
    [
      ['mic', 'Buenos días a todos'],
      ['system', 'Acordamos entregar el reporte el viernes'],
      ['mic', 'Perfecto, yo me encargo del reporte'],
      ['mic', 'Listo, cerramos'],
    ],
  )
})

test('the live worker of a meeting without a destination keeps every microphone segment as it comes', { skip: process.platform === 'win32' }, async (t) => {
  const written = await runWorker(t, false)
  assert.deepEqual(
    written.map((item) => item.text),
    ['Buenos días a todos', 'acordamos entregar el reporte el viernes', 'Perfecto, yo me encargo del reporte', 'Listo, cerramos'],
  )
})

test('ask labels the speakers of a meeting only after it had a destination', (t) => {
  const { dir, meeting: value } = meetingDir(t, { mode: 'meeting' })
  const segments = [segment(0, 3_000, 'mic', 'Hola.'), segment(4_000, 6_000, 'system', '¿Cómo se despliega?')]
  const request: AskRequest = { meeting: value, dir, question: null, windowSeconds: 180, now: '2026-10-25T12:00:00Z', auto: false }
  const bare = renderAskPrompt('{{speakers}}\n{{transcript}}', request, emptyContext(), segments.slice(0, 1))
  assert.match(bare, /^Un solo micrófono/)
  assert.ok(bare.includes('] Hola.') && !bare.includes('Sala:'))
  writeManifest(dir, { video: ZOOM, segments: [{ file: 'screen-1.mov', startMs: 3_500 }] })
  const labelled = renderAskPrompt('{{speakers}}\n{{transcript}}', request, emptyContext(), segments)
  assert.match(labelled, /^«Sala» es el micrófono local/)
  assert.ok(labelled.includes('Solo hay «Remotos» en los tramos'))
  assert.ok(labelled.includes('Sala: Hola.') && labelled.includes('Remotos: ¿Cómo se despliega?'))
  const remote = renderAskPrompt('{{speakers}}', { ...request, meeting: { ...value, mode: 'remote' } }, emptyContext(), segments)
  assert.ok(remote.startsWith('«Sala»') && !remote.includes('tramos'))
})

test('the detector labels the speakers of a meeting with a destination', async (t) => {
  const { dir, meeting: value } = meetingDir(t, { mode: 'meeting' })
  writeManifest(dir, { video: ZOOM, segments: [{ file: 'screen-1.mov', startMs: 0 }] })
  appendLines([segment(0, 3_000, 'system', '¿Cómo se rota la llave?')], liveFiles.transcript(dir))
  const prompts: string[] = []
  const detector = new QuestionDetector(dir, value, 0, {
    template: () => '{{speakers}}\n{{transcript}}',
    context: () => emptyContext(),
    complete: async (prompt) => {
      prompts.push(prompt)
      return '{"questions": []}'
    },
    enqueue: () => undefined,
    log: () => undefined,
  })
  await detector.runCycle()
  await detector.stop()
  assert.match(prompts[0] ?? '', /^Es una reunión con el audio de una pantalla o ventana grabada: «Sala»/)
  assert.ok(prompts[0]?.includes('Remotos: ¿Cómo se rota la llave?'))
  const plain = renderDetectPrompt('{{speakers}}', value, emptyContext(), detectorBatch([], START_CURSOR), [])
  assert.match(plain, /^Es una reunión con un solo micrófono/)
  const remote = renderDetectPrompt('{{speakers}}', { ...value, mode: 'remote' }, emptyContext(), detectorBatch([], START_CURSOR), [])
  assert.match(remote, /^Es una reunión remota: «Sala»/)
})

test('proposals, summary and the transcript view label a meeting that recorded call audio', (t) => {
  const generator = new ProposalGenerator({}, new FakeTool(() => ({ ok: true, data: null })), () => undefined, async () => '')
  const withCall = meeting({ mode: 'meeting', channels: ['mic', 'system'] })
  assert.ok(generator.render(withCall, '/d', [], 't').includes('«Remotos» es el audio de la llamada.'))
  assert.ok(generator.render(meeting({ mode: 'meeting' }), '/d', [], 't').includes('un solo micrófono'))
  assert.match(renderSummaryPrompt(withCall, 'texto', [], '{{speakers}}'), /«Remotos».*Solo hay «Remotos» en los tramos/)
  const { dir, meeting: live } = meetingDir(t, { mode: 'meeting', status: 'recording' })
  writeFileSync(path.join(dir, 'transcript.json'), JSON.stringify([segment(0, 1_000, 'mic', 'Hola.')]))
  assert.equal(transcriptView(live, dir).paragraphs[0]?.speaker, null)
  writeManifest(dir, { segments: [{ file: 'screen-1.mov', startMs: 0, endMs: 1_000 }] })
  assert.equal(transcriptView(live, dir).paragraphs[0]?.speaker, 'Sala')
})

test('a meeting already assembled into recording.mov keeps both channels after a crash', async (t) => {
  const dir = tempDir(t)
  assert.deepEqual(assembledChannels(dir), ['mic'])
  saveMeeting(meeting({ mode: 'meeting', status: 'recorded' }), dir)
  writeManifest(dir, { segments: [{ file: 'screen-1.mov', startMs: 0, endMs: 5_000 }] })
  writeFileSync(path.join(dir, 'recording.mov'), Buffer.alloc(32))
  assert.deepEqual(assembledChannels(dir), ['mic', 'system'])
  const assembled = await assembleMeeting(dir, { tools: { ffmpeg: '/nonexistent/ffmpeg', ffprobe: '/nonexistent/ffprobe' } })
  assert.deepEqual(assembled.channels, ['mic', 'system'])
  assert.deepEqual(channelsOf(loadMeeting(dir)), [['mic', 0], ['system', 1]])
})

test('processing a meeting whose recording.mov already exists labels it with both channels', async (t) => {
  const dir = tempDir(t)
  saveMeeting(meeting({ mode: 'meeting', status: 'recorded', startedAt: '2026-10-25T12:00:00Z' }), dir)
  writeFileSync(path.join(dir, 'recording.mov'), Buffer.alloc(32))
  await new Pipeline(dir, {}, () => undefined).run(undefined, 'assemble')
  assert.deepEqual(loadMeeting(dir).channels, ['mic', 'system'])
})
