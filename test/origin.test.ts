import assert from 'node:assert/strict'
import { test } from 'node:test'
import { QuestionDetector } from '../src/live/detector.ts'
import { emptyContext } from '../src/live/context.ts'
import { appendLines, liveFiles } from '../src/live/files.ts'
import { clockMilliseconds, resolveOrigin, resolveOriginClock, type QuestionOrigin } from '../src/live/origin.ts'
import { AnswerAssembler, buildAnswer } from '../src/live/stream.ts'
import type { Segment } from '../src/pipeline/transcript.ts'
import { meetingDir } from './helpers.ts'

const conversation: Segment[] = [
  { startMs: 1_200, endMs: 4_000, channel: 'mic', text: 'Buenos días a todos.' },
  { startMs: 9_500, endMs: 12_000, channel: 'system', text: 'Oye, una duda rápida.' },
  { startMs: 12_400, endMs: 16_000, channel: 'system', text: '¿Cómo se despliega bita-desktop a producción?' },
  { startMs: 30_000, endMs: 33_000, channel: 'mic', text: 'Déjame revisar.' },
  { startMs: 30_200, endMs: 31_000, channel: 'system', text: 'Claro.' },
]

const origin = (questionMs: number, channel: 'mic' | 'system'): QuestionOrigin => ({ questionMs, channel })

test('reads clock strings and rejects anything else', () => {
  assert.equal(clockMilliseconds('00:00:09'), 9_000)
  assert.equal(clockMilliseconds(' [00:01:05] '), 65_000)
  assert.equal(clockMilliseconds('1:02:03'), 3_723_000)
  assert.equal(clockMilliseconds('02:03'), 123_000)
  for (const value of [null, undefined, 65, '', 'ayer', '00:60:00', '00:00:60', '1:2:3:4', '00:0a:10', '-1:00', '001:00:00']) assert.equal(clockMilliseconds(value), null)
})

test('uses the segment that starts at the rendered second', () => {
  assert.deepEqual(resolveOrigin(1_000, conversation), origin(1_200, 'mic'))
  assert.deepEqual(resolveOrigin(30_000, conversation), origin(30_000, 'mic'))
  assert.deepEqual(resolveOrigin(30_000, conversation, '¿Claro?'), origin(30_200, 'system'))
})

test('prefers the paragraph line that matches the question', () => {
  assert.deepEqual(resolveOrigin(9_000, conversation), origin(9_500, 'system'))
  assert.deepEqual(resolveOrigin(9_000, conversation, '¿Cómo se despliega bita-desktop en producción?'), origin(12_400, 'system'))
})

test('falls back to the covering or previous segment', () => {
  assert.deepEqual(resolveOrigin(14_000, conversation), origin(12_400, 'system'))
  assert.deepEqual(resolveOrigin(20_000, conversation), origin(12_400, 'system'))
  assert.deepEqual(resolveOrigin(0, conversation), origin(1_200, 'mic'))
  assert.equal(resolveOrigin(5_000, []), null)
  assert.deepEqual(resolveOriginClock('00:00:12', conversation), origin(12_400, 'system'))
  assert.equal(resolveOriginClock('nunca', conversation), null)
})

function assembled(text: string): AnswerAssembler {
  const assembler = new AnswerAssembler()
  assembler.feed(text)
  assembler.finish()
  return assembler
}

test('a manual ask without question resolves the sources clock', () => {
  const text = 'PREGUNTA: ¿Cómo se despliega bita-desktop?\nCon `pnpm release`.\n```fuentes\n{"question":"¿Cómo se despliega bita-desktop?","at":"00:00:09","found":true,"sources":[]}\n```'
  const answer = buildAnswer('a', '2026-01-01T00:00:00Z', null, assembled(text), conversation)
  assert.equal(answer.questionMs, 12_400)
  assert.equal(answer.channel, 'system')
})

test('typed questions and missing clocks stay without origin', () => {
  const typed = buildAnswer('a', '2026-01-01T00:00:00Z', '¿Cómo se despliega?', assembled('Con `pnpm release`.\n```fuentes\n{"at":"00:00:09","found":true,"sources":[]}\n```'), conversation)
  assert.equal(typed.questionMs, undefined)
  const missing = buildAnswer('a', '2026-01-01T00:00:00Z', null, assembled('Con `pnpm release`.\n```fuentes\n{"at":null,"found":true,"sources":[]}\n```'), conversation)
  assert.equal(missing.channel, undefined)
})

test('the detector passes the resolved origin to the ask', async (t) => {
  const { dir, meeting } = meetingDir(t)
  appendLines(conversation, liveFiles.transcript(dir))
  const received: [string, QuestionOrigin | null][] = []
  const detector = new QuestionDetector(dir, meeting, 20, {
    template: () => '{{transcript}}',
    context: () => emptyContext(),
    complete: async () => '{"questions": [{"question": "¿Cómo se despliega bita-desktop a producción?", "at": "00:00:09"}]}',
    enqueue: (question, found) => received.push([question, found]),
    log: () => undefined,
  })
  assert.deepEqual(await detector.runCycle(), { type: 'examined', queued: ['¿Cómo se despliega bita-desktop a producción?'], duplicates: [] })
  assert.deepEqual(received[0]?.[1], origin(12_400, 'system'))
})
