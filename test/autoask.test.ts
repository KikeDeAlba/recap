import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { test } from 'node:test'
import { boardEntries, decodeAskingState, encodeAskingState, isValidAskId, makeAskId, performAsk, pruneBoard, readLegacyAsking, removeBoard, writeBoard } from '../src/live/asking.ts'
import { emptyContext } from '../src/live/context.ts'
import { isDuplicateQuestion } from '../src/live/dedupe.ts'
import { AutoAskQueue, DetectionPacer, QuestionDetector, START_CURSOR, autoAskArguments, detectorBatch, loadCursor, parseDetectorResponse, renderDetectPrompt, type AutoAskJob } from '../src/live/detector.ts'
import { appendLines, jsonLine, liveFiles, parseLines } from '../src/live/files.ts'
import type { QuestionOrigin } from '../src/live/origin.ts'
import { decodeAnswer, encodeAnswer, type Answer } from '../src/live/stream.ts'
import { loadResource } from '../src/pipeline/resources.ts'
import type { Segment } from '../src/pipeline/transcript.ts'
import { RecapError } from '../src/errors.ts'
import { meetingDir } from './helpers.ts'

const seg = (startMs: number, endMs: number, channel: 'mic' | 'system', text: string): Segment => ({ startMs, endMs, channel, text })

function answer(question: string, auto?: boolean): Answer {
  return { id: makeAskId(), askedAt: '2026-10-10T10:00:00Z', question, answer: 'Con make release.', found: true, sources: [], auto }
}

function deadPid(): number {
  const result = spawnSync(process.execPath, ['-e', ''])
  return result.pid ?? 999_999
}

function boardFiles(dir: string): string[] {
  try {
    return readdirSync(liveFiles.askingDir(dir))
      .filter((name) => name.endsWith('.json'))
      .sort()
  } catch {
    return []
  }
}

class Recorder {
  prompts: string[] = []
  asked: string[] = []
  origins: (QuestionOrigin | null)[] = []
}

function detector(dir: string, value: ReturnType<typeof meetingDir>['meeting'], recorder: Recorder, reply: (prompt: string) => Promise<string> | string, options: { minSeconds?: number; now?: () => number; template?: () => string } = {}) {
  return new QuestionDetector(dir, value, options.minSeconds ?? 5, {
    ...(options.now ? { now: options.now } : {}),
    template: options.template ?? (() => '{{reviewed}}\n---\n{{transcript}}'),
    context: () => emptyContext(),
    complete: async (prompt) => {
      recorder.prompts.push(prompt)
      return reply(prompt)
    },
    enqueue: (question, origin) => {
      recorder.asked.push(question)
      recorder.origins.push(origin)
    },
    log: () => undefined,
  })
}

test('parses every question of the list and tolerates legacy shapes', () => {
  assert.deepEqual(parseDetectorResponse('{"questions": [{"question": "¿a?", "at": "00:00:05"}, "¿b?"]}'), [
    { text: '¿a?', atMs: 5_000 },
    { text: '¿b?', atMs: null },
  ])
  assert.deepEqual(parseDetectorResponse('```json\n{"questions": [{"question": "¿q?"}]}\n```'), [{ text: '¿q?', atMs: null }])
  assert.deepEqual(parseDetectorResponse('[{"question": "¿q?", "at": "[01:02:03]"}]'), [{ text: '¿q?', atMs: 3_723_000 }])
  assert.deepEqual(parseDetectorResponse('{"questions": []}'), [])
  assert.deepEqual(parseDetectorResponse('{"questions": null}'), [])
  assert.deepEqual(parseDetectorResponse('Aquí va: {"questions":[]}'), [])
  assert.deepEqual(parseDetectorResponse('{"questions": [{"question": null}, {"question": ""}, {"question": "null"}]}'), [])
  assert.deepEqual(parseDetectorResponse('{"question": "¿Dónde está el pipeline?", "at": "00:01:05"}'), [{ text: '¿Dónde está el pipeline?', atMs: 65_000 }])
  assert.deepEqual(parseDetectorResponse('{"question": null, "at": null}'), [])
  assert.equal(parseDetectorResponse('{"questions": [{"question": "¿q?", "at": "ayer"}]}')[0]?.atMs, null)
  for (const garbage of ['Lo siento', '{"answer": 1}', '{"questions": "x"}', '{"questions": [3]}']) assert.throws(() => parseDetectorResponse(garbage), RecapError)
})

test('flags rephrasings and keeps different questions', () => {
  assert.ok(isDuplicateQuestion('¿Cómo se despliega bita-desktop?', ['como se DESPLIEGA bita desktop']))
  assert.ok(isDuplicateQuestion('¿Cómo se despliega bita-desktop a producción?', ['¿Cómo se despliega bita-desktop?']))
  assert.ok(!isDuplicateQuestion('¿Cómo se ejecuta el recomendador?', ['¿Cómo se ejecuta el webhook de BBVA?']))
  assert.ok(!isDuplicateQuestion('¿Dónde está el pipeline de CoDi?', []))
})

test('the pacer runs while pending and at most once per interval', () => {
  const pacer = new DetectionPacer(5)
  const start = 1_000_000
  const runs: boolean[] = []
  const check = (offset: number) => runs.push(pacer.shouldRun(start + offset * 1000))
  check(0)
  check(1)
  pacer.grew()
  check(4)
  check(5)
  pacer.settle(false)
  check(20)
  pacer.settle(true)
  check(24)
  check(25)
  assert.deepEqual(runs, [true, false, false, true, false, true, false])
})

test('the detector reruns while segments remain unexamined even without growth', async (t) => {
  const { dir, meeting } = meetingDir(t)
  appendLines([seg(0, 2_000, 'system', '¿Cómo corro las pruebas?')], liveFiles.transcript(dir))
  let now = 5_000_000
  const recorder = new Recorder()
  const replies = ['Lo siento', '{"questions": []}', '{"questions": []}']
  const subject = detector(
    dir,
    meeting,
    recorder,
    () => {
      const reply = replies.shift() ?? ''
      if (replies.length === 1) appendLines([seg(3_000, 5_000, 'system', 'Y algo más.')], liveFiles.transcript(dir))
      return reply
    },
    { now: () => now },
  )
  assert.ok(subject.tick())
  assert.ok(await subject.waitUntilIdle(5))
  assert.deepEqual(loadCursor(dir), START_CURSOR)
  assert.ok(!subject.tick())
  now += 5_000
  assert.ok(subject.tick())
  assert.ok(await subject.waitUntilIdle(5))
  assert.equal(loadCursor(dir).examinedSegments, 1)
  now += 5_000
  assert.ok(subject.tick())
  assert.ok(await subject.waitUntilIdle(5))
  assert.deepEqual(loadCursor(dir), { detectedThroughMs: 5_000, examinedSegments: 2 })
  now += 60_000
  assert.ok(!subject.tick())
  assert.equal(recorder.prompts.length, 3)
  await subject.stop()
  subject.transcriptGrew()
  assert.ok(!subject.tick())
})

test('queues every question and sends only the new part as new', async (t) => {
  const { dir, meeting } = meetingDir(t, { mode: 'in-person' })
  appendLines([seg(0, 3_000, 'mic', 'Buenos días a todos.'), seg(16_000, 19_000, 'mic', '¿Cómo se despliega bita-desktop?'), seg(23_000, 26_000, 'mic', '¿Dónde está el pipeline de CoDi?')], liveFiles.transcript(dir))
  const recorder = new Recorder()
  let reply = '{"questions": [{"question": "¿Cómo se despliega bita-desktop?", "at": "00:00:16"}, {"question": "¿Dónde está el pipeline de CoDi?", "at": "00:00:23"}]}'
  const subject = detector(dir, meeting, recorder, () => reply)
  assert.deepEqual(await subject.runCycle(), { type: 'examined', queued: ['¿Cómo se despliega bita-desktop?', '¿Dónde está el pipeline de CoDi?'], duplicates: [] })
  assert.deepEqual(recorder.origins, [
    { questionMs: 16_000, channel: 'mic' },
    { questionMs: 23_000, channel: 'mic' },
  ])
  assert.deepEqual(loadCursor(dir), { detectedThroughMs: 26_000, examinedSegments: 3 })
  assert.ok(recorder.prompts[0]?.startsWith('(nada)\n---\n'))
  appendLines([seg(32_000, 35_000, 'mic', '¿Qué variables usa el webhook de BBVA?')], liveFiles.transcript(dir))
  reply = '{"questions": []}'
  assert.deepEqual(await subject.runCycle(), { type: 'examined', queued: [], duplicates: [] })
  const parts = (recorder.prompts.at(-1) ?? '').split('\n---\n')
  assert.equal(parts.length, 2)
  assert.ok(parts[0]?.includes('¿Dónde está el pipeline de CoDi?') && !parts[0].includes('webhook'))
  assert.ok(parts[1]?.includes('webhook') && !parts[1].includes('pipeline'))
  assert.deepEqual(await subject.runCycle(), { type: 'idle' })
  assert.equal(recorder.prompts.length, 2)
})

test('the reviewed context keeps only the last minute before the cursor', () => {
  const segments = [seg(0, 5_000, 'mic', 'Muy viejo.'), seg(70_000, 75_000, 'mic', 'Reciente.'), seg(76_000, 79_000, 'mic', '  '), seg(80_000, 84_000, 'mic', 'Nuevo.')]
  const batch = detectorBatch(segments, { detectedThroughMs: 79_000, examinedSegments: 3 })
  assert.deepEqual(
    batch.reviewed.map((item) => item.text),
    ['Reciente.'],
  )
  assert.deepEqual(
    batch.fresh.map((item) => item.text),
    ['Nuevo.'],
  )
  assert.deepEqual(batch.cursor, { detectedThroughMs: 84_000, examinedSegments: 4 })
  const late = detectorBatch([...segments, seg(60_000, 62_000, 'mic', 'Tardío.')], batch.cursor)
  assert.deepEqual(
    late.fresh.map((item) => item.text),
    ['Tardío.'],
  )
  assert.deepEqual(late.cursor, { detectedThroughMs: 84_000, examinedSegments: 5 })
})

test('the cursor advances only after a successful call', async (t) => {
  const { dir, meeting } = meetingDir(t)
  appendLines([seg(0, 3_000, 'system', '¿Cómo corro las pruebas?')], liveFiles.transcript(dir))
  const recorder = new Recorder()
  let reply: () => string = () => {
    throw new RecapError('CLAUDE_FAILED', 'boom')
  }
  const subject = detector(dir, meeting, recorder, () => reply())
  assert.deepEqual(await subject.runCycle(), { type: 'failed', message: 'CLAUDE_FAILED: boom' })
  assert.ok(subject.hasUnexamined())
  reply = () => 'Lo siento'
  assert.equal((await subject.runCycle()).type, 'failed')
  assert.deepEqual(loadCursor(dir), START_CURSOR)
  reply = () => '{"questions": [{"question": "¿Cómo se corren las pruebas de recap?", "at": "00:00:00"}]}'
  assert.deepEqual(await subject.runCycle(), { type: 'examined', queued: ['¿Cómo se corren las pruebas de recap?'], duplicates: [] })
  assert.deepEqual(loadCursor(dir), { detectedThroughMs: 3_000, examinedSegments: 1 })
  assert.ok(!subject.hasUnexamined())
  assert.equal(recorder.prompts.length, 3)
})

test('skips questions answered, running, queued or already detected', async (t) => {
  const { dir, meeting } = meetingDir(t)
  appendLines([seg(0, 3_000, 'system', 'Varias preguntas.')], liveFiles.transcript(dir))
  appendLines([encodeAnswer(answer('¿Qué cambió en el pipeline de CoDi?'))], liveFiles.answers(dir))
  const now = '2026-10-10T10:00:00Z'
  writeBoard(dir, { id: 'running-1', question: '¿Cómo se despliega bita-desktop?', startedAt: now, auto: false, state: 'running', pid: process.pid })
  writeBoard(dir, { id: 'queued-1', question: '¿Dónde vive el webhook de BBVA?', startedAt: now, auto: true, state: 'queued', pid: process.pid })
  writeBoard(dir, { id: 'stale-1', question: '¿Cómo se rota la llave de Datadog?', startedAt: now, auto: true, state: 'running', pid: deadPid() })
  const recorder = new Recorder()
  let reply =
    '{"questions": [{"question": "¿Qué cambió en el pipeline de CoDi la semana pasada?"}, {"question": "¿Cómo se despliega bita-desktop a producción?"}, {"question": "¿Dónde vive el webhook de BBVA?"}, {"question": "¿Cómo se rota la llave de Datadog?"}, {"question": "¿Cómo se rota la llave de Datadog en prod?"}]}'
  const subject = detector(dir, meeting, recorder, () => reply, { template: () => loadResource('detect-prompt.md') })
  assert.deepEqual(await subject.runCycle(), {
    type: 'examined',
    queued: ['¿Cómo se rota la llave de Datadog?'],
    duplicates: ['¿Qué cambió en el pipeline de CoDi la semana pasada?', '¿Cómo se despliega bita-desktop a producción?', '¿Dónde vive el webhook de BBVA?', '¿Cómo se rota la llave de Datadog en prod?'],
  })
  const prompt = recorder.prompts[0] ?? ''
  assert.ok(!prompt.includes('{{'))
  assert.ok(prompt.includes('- ¿Cómo se despliega bita-desktop?') && prompt.includes('- ¿Dónde vive el webhook de BBVA?'))
  assert.ok(!prompt.includes('- ¿Cómo se rota la llave de Datadog?'))
  appendLines([seg(4_000, 6_000, 'system', 'Otra vez.')], liveFiles.transcript(dir))
  reply = '{"questions": [{"question": "¿Cómo se rota la llave de Datadog?"}]}'
  assert.deepEqual(await subject.runCycle(), { type: 'examined', queued: [], duplicates: ['¿Cómo se rota la llave de Datadog?'] })
  assert.deepEqual(recorder.asked, ['¿Cómo se rota la llave de Datadog?'])
})

test('detect prompts keep the room and the speakers', (t) => {
  const inPerson = meetingDir(t, { mode: 'in-person' }).meeting
  const batch = detectorBatch([seg(0, 3_000, 'mic', '¿Dónde está el Makefile?')], START_CURSOR)
  const prompt = renderDetectPrompt(loadResource('detect-prompt.md'), inPerson, emptyContext({ project: 'bita', pages: [{ pageId: 1, title: 'Despliegue', relPath: 'd.md', depth: 0 }] }), batch, [])
  assert.ok(prompt.includes('presencial') && prompt.includes('(ninguna)') && prompt.includes('(nada)'))
  assert.ok(prompt.includes('Proyecto: bita') && prompt.includes('- Despliegue'))
  assert.ok(prompt.includes('] ¿Dónde está el Makefile?') && !prompt.includes('Remotos:'))
  assert.ok(prompt.includes('{"questions": []}') && !prompt.includes('{{'))
  const remote = meetingDir(t, { mode: 'remote' }).meeting
  assert.ok(renderDetectPrompt('{{transcript}}', remote, emptyContext(), detectorBatch([seg(0, 3_000, 'system', '¿q?')], START_CURSOR), []).includes('Remotos: ¿q?'))
})

test('the queue never runs more than the limit and drops nothing', async (t) => {
  const { dir } = meetingDir(t)
  let active = 0
  let peak = 0
  const started: string[] = []
  const queue = new AutoAskQueue({
    dir,
    concurrency: 2,
    run: async (job: AutoAskJob) => {
      active += 1
      peak = Math.max(peak, active)
      started.push(job.question)
      await new Promise((resolve) => setTimeout(resolve, 30))
      active -= 1
    },
    log: () => undefined,
  })
  const questions = ['¿1?', '¿2?', '¿3?', '¿4?', '¿5?']
  for (const question of questions) queue.enqueue(question, null)
  assert.ok(queue.runningCount <= 2)
  assert.ok(await queue.waitUntilIdle(10))
  assert.equal(peak, 2)
  assert.deepEqual(started, questions)
  assert.deepEqual(boardFiles(dir), [])
  assert.ok(!existsSync(liveFiles.asking(dir)))
})

test('the board follows queued, running and finished asks', async (t) => {
  const { dir } = meetingDir(t)
  const logs: string[] = []
  let release: (() => void) | null = null
  const queue = new AutoAskQueue({
    dir,
    concurrency: 1,
    run: (job) =>
      new Promise<void>((resolve, reject) => {
        release = () => (job.question === '¿Primera?' ? reject(new RecapError('ASK_FAILED', 'boom')) : resolve())
      }),
    log: (line) => logs.push(line),
  })
  const first = queue.enqueue('¿Primera?', { questionMs: 16_000, channel: 'mic' })
  const second = queue.enqueue('¿Segunda?', null)
  const entries = boardEntries(dir)
  assert.equal(entries.length, 2)
  const running = entries.find((entry) => entry.id === first?.id)
  assert.equal(running?.state, 'running')
  assert.equal(running?.questionMs, 16_000)
  assert.equal(running?.pid, process.pid)
  assert.equal(entries.find((entry) => entry.id === second?.id)?.state, 'queued')
  assert.equal(readLegacyAsking(dir)?.id, first?.id)
  ;(release as unknown as () => void)()
  await new Promise((resolve) => setTimeout(resolve, 20))
  assert.deepEqual(
    boardEntries(dir).map((entry) => entry.id),
    [second?.id],
  )
  assert.equal(readLegacyAsking(dir)?.id, second?.id)
  ;(release as unknown as () => void)()
  assert.ok(await queue.waitUntilIdle(5))
  assert.deepEqual(boardFiles(dir), [])
  assert.ok(logs.some((line) => line.includes('failed «¿Primera?»') && line.includes('boom')))
})

test('cancelling drops queued asks', async (t) => {
  const { dir } = meetingDir(t)
  let cancelled = false
  let finish: (() => void) | null = null
  const queue = new AutoAskQueue({
    dir,
    concurrency: 1,
    run: () => new Promise<void>((resolve) => (finish = resolve)),
    cancelRunning: () => {
      cancelled = true
      ;(finish as unknown as () => void)()
    },
    log: () => undefined,
  })
  queue.enqueue('¿Primera?', null)
  queue.enqueue('¿Segunda?', null)
  await queue.cancelAll()
  assert.ok(cancelled)
  assert.deepEqual(boardFiles(dir), [])
  assert.equal(queue.enqueue('¿Tercera?', null), null)
  assert.equal(queue.waitingCount + queue.runningCount, 0)
})

test('manual asks write the board and clean up, even on failure', async (t) => {
  const { dir } = meetingDir(t)
  let raw = ''
  await assert.rejects(
    performAsk({ dir, question: null, auto: false }, async () => {
      raw = readFileSync(liveFiles.asking(dir), 'utf8')
      throw new RecapError('CLAUDE_FAILED', 'boom')
    }),
    RecapError,
  )
  assert.ok(raw.includes('"auto":false') && raw.includes('"question":null') && raw.includes('"state":"running"'))
  assert.deepEqual(boardFiles(dir), [])
  const during: (string | undefined)[] = []
  await performAsk({ dir, id: 'outer', question: '¿a?', auto: false, now: '2026-09-21T14:13:20Z' }, async () => {
    during.push(readLegacyAsking(dir)?.id)
    await performAsk({ dir, id: 'inner', question: '¿b?', auto: false, now: '2026-09-21T14:13:22Z' }, async () => {
      during.push(readLegacyAsking(dir)?.id, String(boardEntries(dir).length))
    })
    during.push(readLegacyAsking(dir)?.id)
  })
  assert.deepEqual(during, ['outer', 'inner', '2', 'outer'])
  assert.deepEqual(boardFiles(dir), [])
})

test('the legacy file ignores queued and dead asks and prune removes dead ones', (t) => {
  const { dir } = meetingDir(t)
  writeBoard(dir, { id: 'queued', question: '¿q?', startedAt: '2026-09-21T14:13:29Z', auto: true, state: 'queued', pid: process.pid })
  assert.equal(readLegacyAsking(dir), null)
  writeBoard(dir, { id: 'dead', question: '¿d?', startedAt: '2026-09-21T14:13:25Z', auto: true, state: 'running', pid: deadPid() })
  assert.equal(readLegacyAsking(dir), null)
  writeBoard(dir, { id: 'live', question: '¿l?', startedAt: '2026-09-21T14:13:20Z', auto: true, state: 'running', pid: process.pid })
  assert.equal(readLegacyAsking(dir)?.id, 'live')
  assert.deepEqual(boardFiles(dir), ['dead.json', 'live.json', 'queued.json'])
  pruneBoard(dir)
  assert.deepEqual(boardFiles(dir), ['live.json', 'queued.json'])
  removeBoard(dir, 'live')
  assert.equal(readLegacyAsking(dir), null)
  assert.throws(() => writeBoard(dir, { id: '../escape', question: null, startedAt: '2026-09-21T14:13:20Z', auto: false }), RecapError)
})

test('asking states and answers keep the Swift encoding', () => {
  const old = decodeAskingState(JSON.parse('{"auto":false,"question":null,"startedAt":"2026-09-21T14:13:20Z"}'))
  assert.equal(old?.id, undefined)
  assert.equal(old?.state, undefined)
  const raw = encodeAskingState({ id: 'a', question: '¿q?', startedAt: '2026-09-21T14:13:20Z', auto: true, questionMs: 65_400, channel: 'mic', state: 'queued', pid: 7 })
  assert.equal(raw, '{"auto":true,"channel":"mic","id":"a","pid":7,"question":"¿q?","questionMs":65400,"startedAt":"2026-09-21T14:13:20Z","state":"queued"}')
  assert.ok(isValidAskId(makeAskId()))
  for (const bad of ['', '../x', 'A', 'a/b', '-x', 'a'.repeat(65), 'a b']) assert.ok(!isValidAskId(bad), bad)
  const tagged: Answer = { ...answer('¿a?', true), askId: 'ask-1', answeredAt: '2026-09-21T14:13:32Z', questionMs: 65_400, channel: 'system' }
  const line = jsonLine(encodeAnswer(tagged))
  assert.ok(line.includes('"askId":"ask-1"') && line.includes('"answeredAt":"2026-09-21T14:13:32Z"'))
  assert.deepEqual(parseLines(line, decodeAnswer)[0], tagged)
  const bare = jsonLine(encodeAnswer(answer('¿a?')))
  assert.ok(!bare.includes('auto') && !bare.includes('askId') && !bare.includes('channel'))
  const legacy = parseLines('{"id":"1","askedAt":"2026-10-08T10:00:00Z","question":"q","answer":"a","found":true,"sources":[]}', decodeAnswer)[0]
  assert.equal(legacy?.auto, undefined)
})

test('auto ask arguments carry the origin and the ask id', () => {
  assert.deepEqual(autoAskArguments('/m', '¿q?'), ['ask', '--dir', '/m', '--question', '¿q?', '--auto', '--json'])
  assert.deepEqual(autoAskArguments('/m', '¿q?', { questionMs: 65_400, channel: 'system' }, 'abc'), ['ask', '--dir', '/m', '--question', '¿q?', '--auto', '--json', '--question-ms', '65400', '--channel', 'system', '--ask-id', 'abc'])
})
