import { spawn } from 'node:child_process'
import { readText, writeAtomic } from '../core/fsutil.ts'
import { isRecord, swiftLine } from '../core/json.ts'
import { isoNow } from '../core/dates.ts'
import type { Meeting } from '../core/meeting.ts'
import { sleep, signalTree } from '../core/proc.ts'
import { prefix, replaceAll, suffix, trimmed } from '../core/text.ts'
import { RecapError, describeError } from '../errors.ts'
import { loadResource } from '../pipeline/resources.ts'
import { decodeSegment, orderSegments, type Segment } from '../pipeline/transcript.ts'
import { boardEntries, makeAskId, removeBoard, writeBoard, type AskPhase, type AskingState } from './asking.ts'
import type { ProjectContext } from './context.ts'
import { isDuplicateQuestion } from './dedupe.ts'
import { liveFiles, readLines } from './files.ts'
import { renderLive } from './merger.ts'
import { clockMilliseconds, resolveOrigin, type QuestionOrigin } from './origin.ts'
import { decodeAnswer } from './stream.ts'

export interface DetectedQuestion {
  text: string
  atMs: number | null
}

function detectorError(text: string): RecapError {
  return new RecapError('DETECTOR_OUTPUT', `Unexpected detector output: ${prefix(trimmed(text), 200)}`)
}

function findJson(text: string): unknown {
  const candidates: [string, string][] = [
    ['{', '}'],
    ['[', ']'],
  ]
  const position = (char: string) => {
    const index = text.indexOf(char)
    return index === -1 ? text.length : index
  }
  candidates.sort((left, right) => position(left[0]) - position(right[0]))
  for (const [open, close] of candidates) {
    const start = text.indexOf(open)
    const end = text.lastIndexOf(close)
    if (start === -1 || end === -1 || start >= end) continue
    try {
      return JSON.parse(text.slice(start, end + 1)) as unknown
    } catch {
      continue
    }
  }
  return undefined
}

function cleanQuestion(question: string): string | null {
  const text = trimmed(question)
  return text.length === 0 || text.toLowerCase() === 'null' ? null : text
}

function questionItem(object: Record<string, unknown>): DetectedQuestion | null {
  const value = object['question']
  if (value === undefined || value === null) return null
  if (typeof value !== 'string') throw new RecapError('DETECTOR_OUTPUT', `Unexpected detector question: ${prefix(JSON.stringify(value), 200)}`)
  const text = cleanQuestion(value)
  return text === null ? null : { text, atMs: clockMilliseconds(object['at']) }
}

function questionItems(list: unknown[]): DetectedQuestion[] {
  const result: DetectedQuestion[] = []
  for (const element of list) {
    if (typeof element === 'string') {
      const text = cleanQuestion(element)
      if (text !== null) result.push({ text, atMs: null })
      continue
    }
    if (!isRecord(element)) throw new RecapError('DETECTOR_OUTPUT', `Unexpected detector question: ${prefix(JSON.stringify(element) ?? String(element), 200)}`)
    const item = questionItem(element)
    if (item) result.push(item)
  }
  return result
}

export function parseDetectorResponse(text: string): DetectedQuestion[] {
  const value = findJson(text)
  if (value === undefined) throw detectorError(text)
  if (Array.isArray(value)) return questionItems(value)
  if (!isRecord(value)) throw detectorError(text)
  if ('questions' in value) {
    const list = value['questions']
    if (list === null) return []
    if (!Array.isArray(list)) throw new RecapError('DETECTOR_OUTPUT', `Unexpected detector questions: ${prefix(JSON.stringify(list), 200)}`)
    return questionItems(list)
  }
  if (!('question' in value)) throw detectorError(text)
  const item = questionItem(value)
  return item ? [item] : []
}

export class DetectionPacer {
  readonly minSeconds: number
  lastRun: number | null = null
  pending = true

  constructor(minSeconds: number) {
    this.minSeconds = minSeconds
  }

  grew(): void {
    this.pending = true
  }

  settle(remaining: boolean): void {
    if (remaining) this.pending = true
  }

  shouldRun(now: number): boolean {
    if (!this.pending) return false
    if (this.lastRun !== null && (now - this.lastRun) / 1000 < this.minSeconds) return false
    this.pending = false
    this.lastRun = now
    return true
  }
}

export interface DetectorCursor {
  detectedThroughMs: number
  examinedSegments: number
}

export const START_CURSOR: DetectorCursor = { detectedThroughMs: 0, examinedSegments: 0 }

export function loadCursor(meetingDir: string): DetectorCursor {
  const text = readText(liveFiles.detectorState(meetingDir))
  if (text === null) return { ...START_CURSOR }
  try {
    const value = JSON.parse(text) as unknown
    if (isRecord(value) && typeof value['detectedThroughMs'] === 'number' && typeof value['examinedSegments'] === 'number') {
      return { detectedThroughMs: value['detectedThroughMs'], examinedSegments: value['examinedSegments'] }
    }
  } catch {
    return { ...START_CURSOR }
  }
  return { ...START_CURSOR }
}

export function saveCursor(meetingDir: string, cursor: DetectorCursor): void {
  writeAtomic(liveFiles.detectorState(meetingDir), swiftLine({ detectedThroughMs: cursor.detectedThroughMs, examinedSegments: cursor.examinedSegments }))
}

export const REVIEWED_SECONDS = 60

export interface DetectorBatch {
  reviewed: Segment[]
  fresh: Segment[]
  cursor: DetectorCursor
}

export function detectorBatch(segments: readonly Segment[], cursor: DetectorCursor): DetectorBatch {
  const examined = Math.min(Math.max(0, cursor.examinedSegments), segments.length)
  const from = cursor.detectedThroughMs - REVIEWED_SECONDS * 1000
  const reviewed = orderSegments(segments.slice(0, examined).filter((segment) => segment.endMs >= from && trimmed(segment.text).length > 0))
  const tail = segments.slice(examined)
  const fresh = orderSegments(tail.filter((segment) => trimmed(segment.text).length > 0))
  const through = tail.length > 0 ? Math.max(...tail.map((segment) => segment.endMs)) : cursor.detectedThroughMs
  return { reviewed, fresh, cursor: { detectedThroughMs: Math.max(cursor.detectedThroughMs, through), examinedSegments: segments.length } }
}

export function renderDetectPrompt(template: string, meeting: Meeting, context: ProjectContext, batch: DetectorBatch, known: readonly string[]): string {
  const labelled = meeting.mode === 'remote'
  const title = meeting.bitaEntry?.title ?? meeting.title
  const pages =
    context.pages.length === 0
      ? '  (sin páginas registradas para este proyecto)'
      : context.pages.map((page) => `  ${'  '.repeat(Math.max(0, page.depth))}- ${page.title}`).join('\n')
  const speakers = labelled
    ? 'Es una reunión remota: «Sala» es el micrófono de quien graba y «Remotos» es el audio de la llamada. Las preguntas que vienen de «Remotos» suelen ir dirigidas a quien graba y pesan más; una pregunta de «Sala» solo cuenta si es claramente una duda técnica abierta.'
    : 'Es una reunión presencial con un solo micrófono («Sala»), sin separación por persona: juzga solo por el contenido de lo que se dice.'
  const knownList = known.length === 0 ? '(ninguna)' : known.map((question) => `- ${question}`).join('\n')
  const reviewed = batch.reviewed.length === 0 ? '(nada)' : renderLive(batch.reviewed, labelled)
  let text = template
  text = replaceAll(text, '{{title}}', title)
  text = replaceAll(text, '{{project}}', context.project ?? 'sin proyecto')
  text = replaceAll(text, '{{pages}}', pages)
  text = replaceAll(text, '{{speakers}}', speakers)
  text = replaceAll(text, '{{known}}', knownList)
  text = replaceAll(text, '{{reviewed}}', reviewed)
  text = replaceAll(text, '{{transcript}}', renderLive(batch.fresh, labelled))
  return text
}

export type DetectionOutcome = { type: 'idle' } | { type: 'examined'; queued: string[]; duplicates: string[] } | { type: 'failed'; message: string }

export interface DetectorDependencies {
  now?: () => number
  template?: () => string
  context: () => Promise<ProjectContext> | ProjectContext
  complete: (prompt: string) => Promise<string>
  enqueue: (question: string, origin: QuestionOrigin | null) => void
  cancelAsks?: () => Promise<void> | void
  log: (line: string) => void
}

export function readTranscript(meetingDir: string): Segment[] {
  return readLines(liveFiles.transcript(meetingDir), decodeSegment)
}

export class QuestionDetector {
  readonly dir: string
  readonly meeting: Meeting
  readonly dependencies: DetectorDependencies
  readonly pacer: DetectionPacer
  private busy: Promise<void> | null = null
  private stopped = false
  private detected: string[] = []
  private cachedContext: ProjectContext | null = null

  constructor(dir: string, meeting: Meeting, minSeconds: number, dependencies: DetectorDependencies) {
    this.dir = dir
    this.meeting = meeting
    this.dependencies = dependencies
    this.pacer = new DetectionPacer(minSeconds)
  }

  get detectedQuestions(): string[] {
    return [...this.detected]
  }

  private now(): number {
    return this.dependencies.now?.() ?? Date.now()
  }

  transcriptGrew(): void {
    this.pacer.grew()
  }

  tick(): boolean {
    if (this.stopped || this.busy !== null || !this.pacer.shouldRun(this.now())) return false
    this.busy = (async () => {
      const outcome = await this.runCycle()
      const remaining = outcome.type === 'failed' ? true : this.hasUnexamined()
      this.pacer.settle(remaining)
    })().finally(() => {
      this.busy = null
    })
    return true
  }

  async waitUntilIdle(timeoutSeconds: number): Promise<boolean> {
    const current = this.busy
    if (!current) return true
    const timeout = sleep(timeoutSeconds * 1000).then(() => false)
    return Promise.race([current.then(() => true), timeout])
  }

  async stop(timeoutSeconds = 20): Promise<void> {
    this.stopped = true
    if (!(await this.waitUntilIdle(timeoutSeconds))) this.dependencies.log(`question detector did not stop within ${timeoutSeconds} s`)
    await this.dependencies.cancelAsks?.()
  }

  hasUnexamined(): boolean {
    return readTranscript(this.dir).length > loadCursor(this.dir).examinedSegments
  }

  async runCycle(): Promise<DetectionOutcome> {
    const outcome = await this.detect()
    if (outcome.type === 'examined') for (const question of outcome.duplicates) this.dependencies.log(`auto ask: skipped duplicate «${question}»`)
    if (outcome.type === 'failed') this.dependencies.log(`auto ask: detection failed: ${outcome.message}`)
    return outcome
  }

  private async detect(): Promise<DetectionOutcome> {
    if (this.stopped) return { type: 'idle' }
    const segments = readTranscript(this.dir)
    const batch = detectorBatch(segments, loadCursor(this.dir))
    if (batch.fresh.length === 0) {
      if (batch.cursor.examinedSegments !== loadCursor(this.dir).examinedSegments) {
        try {
          saveCursor(this.dir, batch.cursor)
        } catch {
          return { type: 'idle' }
        }
      }
      return { type: 'idle' }
    }
    const known = this.knownQuestions()
    let found: DetectedQuestion[]
    try {
      const template = this.dependencies.template ? this.dependencies.template() : loadResource('detect-prompt.md')
      const prompt = renderDetectPrompt(template, this.meeting, await this.context(), batch, known)
      found = parseDetectorResponse(await this.dependencies.complete(prompt))
      saveCursor(this.dir, batch.cursor)
    } catch (error) {
      return { type: 'failed', message: describeError(error) }
    }
    const queued: string[] = []
    const duplicates: string[] = []
    for (const detection of found) {
      const question = detection.text
      if (isDuplicateQuestion(question, known)) {
        duplicates.push(question)
        continue
      }
      if (this.stopped) break
      this.detected.push(question)
      known.push(question)
      const origin = detection.atMs === null ? null : resolveOrigin(detection.atMs, [...batch.reviewed, ...batch.fresh], question)
      this.dependencies.log(`auto ask: detected «${question}»${origin ? ` at ${origin.questionMs} ms (${origin.channel})` : ''}`)
      this.dependencies.enqueue(question, origin)
      queued.push(question)
    }
    return { type: 'examined', queued, duplicates }
  }

  private knownQuestions(): string[] {
    const answered = readLines(liveFiles.answers(this.dir), decodeAnswer).map((answer) => answer.question)
    const asking = boardEntries(this.dir).flatMap((state) => (state.question === null ? [] : [state.question]))
    const seen = new Set<string>()
    return [...answered, ...asking, ...this.detected].filter((question) => {
      if (trimmed(question).length === 0 || seen.has(question)) return false
      seen.add(question)
      return true
    })
  }

  private async context(): Promise<ProjectContext> {
    if (this.cachedContext) return this.cachedContext
    this.cachedContext = await this.dependencies.context()
    return this.cachedContext
  }
}

export interface AutoAskJob {
  id: string
  question: string
  origin: QuestionOrigin | null
  queuedAt: string
}

export class AutoAskQueue {
  readonly dir: string
  readonly concurrency: number
  readonly pid: number
  readonly now: () => string
  readonly execute: (job: AutoAskJob) => Promise<void>
  readonly cancelRunning: () => void
  readonly log: (line: string) => void
  private waiting: AutoAskJob[] = []
  private running = new Map<string, Promise<void>>()
  private stopped = false

  constructor(options: {
    dir: string
    concurrency: number
    pid?: number
    now?: () => string
    run: (job: AutoAskJob) => Promise<void>
    cancelRunning?: () => void
    log: (line: string) => void
  }) {
    this.dir = options.dir
    this.concurrency = Math.max(1, options.concurrency)
    this.pid = options.pid ?? process.pid
    this.now = options.now ?? isoNow
    this.execute = options.run
    this.cancelRunning = options.cancelRunning ?? (() => undefined)
    this.log = options.log
  }

  get runningCount(): number {
    return this.running.size
  }

  get waitingCount(): number {
    return this.waiting.length
  }

  enqueue(question: string, origin: QuestionOrigin | null): AutoAskJob | null {
    if (this.stopped) return null
    const job: AutoAskJob = { id: makeAskId(), question, origin, queuedAt: this.now() }
    try {
      writeBoard(this.dir, this.asking(job, 'queued'))
    } catch (error) {
      this.log(`auto ask: cannot write the queued ask: ${describeError(error)}`)
    }
    this.waiting.push(job)
    const ahead = this.waiting.length - 1
    this.log(`auto ask: queued «${question}» as ${job.id}${ahead > 0 ? ` (${ahead} waiting ahead)` : ''}`)
    this.pump()
    return job
  }

  async waitUntilIdle(timeoutSeconds: number): Promise<boolean> {
    const deadline = Date.now() + timeoutSeconds * 1000
    while (this.running.size > 0 || (this.waiting.length > 0 && !this.stopped)) {
      if (Date.now() > deadline) return false
      const pending = [...this.running.values()]
      if (pending.length === 0) {
        await sleep(10)
        continue
      }
      await Promise.race([Promise.allSettled(pending), sleep(Math.max(0, deadline - Date.now()))])
    }
    return true
  }

  async cancelAll(timeoutSeconds = 10): Promise<void> {
    this.stopped = true
    const dropped = this.waiting
    this.waiting = []
    for (const job of dropped) {
      removeBoard(this.dir, job.id)
      this.log(`auto ask: dropped «${job.question}» because the worker stopped`)
    }
    this.cancelRunning()
    if (!(await this.waitUntilIdle(timeoutSeconds))) this.log(`auto asks did not stop within ${timeoutSeconds} s`)
  }

  private pump(): void {
    while (!this.stopped && this.running.size < this.concurrency && this.waiting.length > 0) {
      const job = this.waiting.shift()
      if (!job) break
      try {
        writeBoard(this.dir, this.asking(job, 'running'))
      } catch {
        this.log(`auto ask: cannot mark ${job.id} as running`)
      }
      this.running.set(job.id, this.run(job))
    }
  }

  private async run(job: AutoAskJob): Promise<void> {
    const started = Date.now()
    this.log(`auto ask: started «${job.question}» (${job.id})`)
    try {
      await this.execute(job)
      this.log(`auto ask: answered «${job.question}» in ${((Date.now() - started) / 1000).toFixed(1)} s`)
    } catch (error) {
      this.log(`auto ask: failed «${job.question}»: ${describeError(error)}`)
    }
    removeBoard(this.dir, job.id)
    this.running.delete(job.id)
    this.pump()
  }

  private asking(job: AutoAskJob, phase: AskPhase): AskingState {
    return {
      id: job.id,
      question: job.question,
      startedAt: phase === 'queued' ? job.queuedAt : this.now(),
      auto: true,
      questionMs: job.origin?.questionMs,
      channel: job.origin?.channel,
      state: phase,
      pid: this.pid,
    }
  }
}

export function autoAskArguments(dir: string, question: string, origin: QuestionOrigin | null = null, askId?: string): string[] {
  const args = ['ask', '--dir', dir, '--question', question, '--auto', '--json']
  if (origin) args.push('--question-ms', String(origin.questionMs), '--channel', origin.channel)
  if (askId) args.push('--ask-id', askId)
  return args
}

export function envelopeFailure(output: string): RecapError | null {
  for (const line of output.split('\n').reverse()) {
    try {
      const object = JSON.parse(line) as unknown
      if (isRecord(object) && isRecord(object['error']) && typeof object['error']['code'] === 'string') {
        const error = object['error']
        return new RecapError(error['code'] as string, typeof error['message'] === 'string' ? error['message'] : (error['code'] as string))
      }
    } catch {
      continue
    }
  }
  return null
}

export class AutoAskProcess {
  readonly dir: string
  readonly command: string[]
  private processes = new Map<string, number>()

  constructor(dir: string, command: string[]) {
    this.dir = dir
    this.command = command
  }

  run(job: AutoAskJob): Promise<void> {
    const [executable, ...prefixArgs] = this.command
    return new Promise<void>((resolve, reject) => {
      const child = spawn(executable ?? process.execPath, [...prefixArgs, ...autoAskArguments(this.dir, job.question, job.origin, job.id)], {
        cwd: this.dir,
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: process.platform !== 'win32',
        windowsHide: true,
      })
      let stdout = ''
      let stderr = ''
      child.stdout.setEncoding('utf8').on('data', (chunk: string) => (stdout += chunk))
      child.stderr.setEncoding('utf8').on('data', (chunk: string) => (stderr += chunk))
      if (child.pid !== undefined) this.processes.set(job.id, child.pid)
      child.once('error', (error) => {
        this.processes.delete(job.id)
        reject(new RecapError('ASK_FAILED', error.message))
      })
      child.once('close', (code, signal) => {
        this.processes.delete(job.id)
        if (signal !== null || code === 129 || code === 130 || code === 143) {
          reject(new RecapError('ASK_INTERRUPTED', `The auto ask was stopped (status ${code ?? signal})`))
          return
        }
        if (code !== 0) {
          const failure = envelopeFailure(stdout)
          if (failure) return reject(failure)
          const detail = trimmed(stderr)
          return reject(new RecapError('ASK_FAILED', detail.length === 0 ? `recap ask exited with status ${code}` : suffix(detail, 400)))
        }
        resolve()
      })
    })
  }

  cancel(): void {
    for (const pid of this.processes.values()) signalTree(pid, 'SIGTERM')
  }
}
