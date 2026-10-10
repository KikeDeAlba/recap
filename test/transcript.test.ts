import assert from 'node:assert/strict'
import { test } from 'node:test'
import { formatDuration, slug, formatBytes } from '../src/core/text.ts'
import { clock } from '../src/core/dates.ts'
import { evenlySpaced, showinfoTimes } from '../src/pipeline/pipeline.ts'
import { extractSummary } from '../src/pipeline/summary.ts'
import { mergeTranscripts, paragraphs, parseWhisper, type Channel, type Segment } from '../src/pipeline/transcript.ts'
import { RecapError } from '../src/errors.ts'

const segment = (startMs: number, endMs: number, channel: Channel, text: string): Segment => ({ startMs, endMs, channel, text })

test('parses whisper json and drops hallucinations', () => {
  const json = `{"transcription":[
    {"timestamps":{"from":"00:00:00,000","to":"00:00:02,000"},"offsets":{"from":0,"to":2000},"text":" Buenos días a todos."},
    {"timestamps":{"from":"00:00:02,000","to":"00:00:04,000"},"offsets":{"from":2000,"to":4000},"text":" Subtítulos realizados por la comunidad de Amara.org"},
    {"timestamps":{"from":"00:00:04,000","to":"00:00:05,000"},"offsets":{"from":4000,"to":5000},"text":"   "}
  ]}`
  assert.deepEqual(parseWhisper(json, 'system'), [segment(0, 2000, 'system', 'Buenos días a todos.')])
})

test('drops microphone echo of system audio', () => {
  const system = [segment(10_000, 14_000, 'system', 'Acordamos entregar el reporte el viernes')]
  const mic = [segment(10_300, 14_200, 'mic', 'acordamos entregar el reporte el viernes'), segment(15_000, 17_000, 'mic', 'Perfecto, yo me encargo del reporte')]
  const merged = mergeTranscripts(mic, system)
  assert.deepEqual(
    merged.map((item) => item.channel),
    ['system', 'mic'],
  )
  assert.equal(merged.at(-1)?.text, 'Perfecto, yo me encargo del reporte')
})

test('keeps similar text far apart in time', () => {
  assert.equal(mergeTranscripts([segment(60_000, 62_000, 'mic', 'Sí, de acuerdo con eso')], [segment(10_000, 12_000, 'system', 'Sí, de acuerdo con eso')]).length, 2)
})

test('groups consecutive segments of the same channel', () => {
  const grouped = paragraphs([segment(0, 2_000, 'mic', 'Hola.'), segment(2_500, 4_000, 'mic', 'Empezamos.'), segment(4_500, 6_000, 'system', 'Adelante.'), segment(20_000, 21_000, 'system', 'Otra cosa.')])
  assert.equal(grouped.length, 3)
  assert.equal(grouped[0]?.text, 'Hola. Empezamos.')
  assert.equal(grouped[2]?.startMs, 20_000)
})

test('splits long monologues every thirty seconds', () => {
  const segments = Array.from({ length: 10 }, (_, index) => segment(index * 5_000, index * 5_000 + 4_500, 'system', `Frase ${index}.`))
  assert.deepEqual(
    paragraphs(segments).map((item) => item.startMs),
    [0, 30_000],
  )
})

test('formats timestamps, durations and sizes', () => {
  assert.equal(clock(3_723_456), '01:02:03')
  assert.equal(formatDuration(1_800), '30m00s')
  assert.equal(formatDuration(3_725), '1h02m')
  assert.equal(formatDuration(undefined), '-')
  assert.equal(formatBytes(0), 'Zero KB')
  assert.equal(formatBytes(999), '999 bytes')
  assert.equal(formatBytes(1_234_567), '1.2 MB')
  assert.equal(formatBytes(1_600_000_000), '1.6 GB')
})

test('parses showinfo times and caps frames evenly', () => {
  const log = ['[Parsed_showinfo_1 @ 0x1] n:   0 pts:      0 pts_time:0       duration:1', '[Parsed_showinfo_1 @ 0x1] n:   1 pts:  45000 pts_time:22.5    duration:1', '[Parsed_showinfo_1 @ 0x1] color_range:unknown'].join('\n')
  assert.deepEqual(showinfoTimes(log), [0, 22.5])
  assert.deepEqual(evenlySpaced(5, 40), [0, 1, 2, 3, 4])
  const picked = evenlySpaced(100, 40)
  assert.equal(picked.length, 40)
  assert.equal(picked[0], 0)
  assert.equal(picked.at(-1), 99)
})

test('extracts the summary from claude output and rejects errors', () => {
  assert.equal(extractSummary('{"type":"result","is_error":false,"result":"Aquí va:\\n\\n## Resumen\\nTodo bien."}'), '## Resumen\nTodo bien.')
  assert.throws(() => extractSummary('{"type":"result","is_error":true,"result":"Credit balance is too low"}'), RecapError)
})

test('slugs fold accents and punctuation', () => {
  assert.equal(slug('Reunión de diseño: API v2!'), 'reunion-de-diseno-api-v2')
  assert.equal(slug('¿¡ !?'), 'meeting')
  assert.equal(slug('a'.repeat(80)).length, 48)
})
