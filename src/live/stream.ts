import { isRecord, parseJsonSafe } from '../core/json.ts'
import { home } from '../core/paths.ts'
import { fold, replaceAll, suffix, trimmed } from '../core/text.ts'
import { RecapError } from '../errors.ts'
import type { Channel, Segment } from '../pipeline/transcript.ts'
import type { RepoRef } from './context.ts'
import { clockMilliseconds, resolveOrigin } from './origin.ts'

export type ClaudeStreamEvent =
  | { type: 'text'; text: string }
  | { type: 'tool'; name: string; input: Record<string, string> }
  | { type: 'result'; text: string | null; isError: boolean }

export function parseStreamLine(line: string): ClaudeStreamEvent[] {
  const object = parseJsonSafe(line)
  if (!isRecord(object) || typeof object['type'] !== 'string') return []
  switch (object['type']) {
    case 'stream_event': {
      const event = object['event']
      if (!isRecord(event) || event['type'] !== 'content_block_delta') return []
      const delta = event['delta']
      if (!isRecord(delta) || delta['type'] !== 'text_delta' || typeof delta['text'] !== 'string' || delta['text'].length === 0) return []
      return [{ type: 'text', text: delta['text'] }]
    }
    case 'assistant': {
      const message = object['message']
      const content = isRecord(message) && Array.isArray(message['content']) ? message['content'] : []
      const events: ClaudeStreamEvent[] = []
      for (const block of content) {
        if (!isRecord(block) || block['type'] !== 'tool_use' || typeof block['name'] !== 'string') continue
        const input: Record<string, string> = {}
        if (isRecord(block['input'])) {
          for (const [key, value] of Object.entries(block['input'])) {
            if (typeof value === 'string') input[key] = value
            else if (typeof value === 'number') input[key] = String(value)
            else if (typeof value === 'boolean') input[key] = value ? '1' : '0'
          }
        }
        events.push({ type: 'tool', name: block['name'], input })
      }
      return events
    }
    case 'result': {
      const isError = typeof object['is_error'] === 'boolean' ? object['is_error'] : object['subtype'] !== 'success'
      return [{ type: 'result', text: typeof object['result'] === 'string' ? object['result'] : null, isError }]
    }
    default:
      return []
  }
}

export class ProgressDescriber {
  readonly roots: { prefix: string; label: string }[]

  constructor(docsRoot: string | null, repos: readonly RepoRef[]) {
    const roots = repos.map((repo) => ({ prefix: repo.path, label: repo.slug }))
    if (docsRoot) roots.push({ prefix: docsRoot, label: 'docs' })
    this.roots = roots.sort((left, right) => right.prefix.length - left.prefix.length)
  }

  describe(name: string, input: Record<string, string>): string {
    switch (name) {
      case 'Read':
        return `Leyendo ${this.short(input['file_path'] ?? input['path'] ?? '')}`
      case 'Grep': {
        const scope = input['path'] !== undefined ? ` en ${this.short(input['path'])}` : ''
        return `Buscando «${input['pattern'] ?? ''}»${scope}`
      }
      case 'Glob': {
        const scope = input['path'] !== undefined ? ` en ${this.short(input['path'])}` : ''
        return `Listando ${input['pattern'] ?? ''}${scope}`
      }
      case 'Bash': {
        let command = input['command']
        if (command === undefined) return 'Ejecutando un comando'
        for (const root of this.roots) command = replaceAll(command, root.prefix, root.label)
        return `Ejecutando ${command}`
      }
      default:
        return name
    }
  }

  short(file: string): string {
    for (const root of this.roots) {
      if (file === root.prefix || file.startsWith(`${root.prefix}/`)) return root.label + file.slice(root.prefix.length)
    }
    const base = home()
    if (file.startsWith(`${base}/`)) return `~${file.slice(base.length)}`
    return file
  }
}

export const SOURCES_MARKER = '```fuentes'
export const QUESTION_PREFIX = 'PREGUNTA:'

function headerQuestion(text: string): string | null {
  const clean = trimmed(text)
  if (!clean.toUpperCase().startsWith(QUESTION_PREFIX)) return null
  const question = trimmed(clean.slice(QUESTION_PREFIX.length))
  return question.length === 0 ? null : question
}

export function markerPrefixLength(text: string): number {
  for (let length = Math.min(SOURCES_MARKER.length - 1, text.length); length >= 1; length -= 1) {
    if (text.endsWith(SOURCES_MARKER.slice(0, length))) return length
  }
  return 0
}

export class AnswerAssembler {
  question: string | null = null
  emitted = ''
  sourcesText = ''
  private pending = ''
  private headerDone = false
  private inSources = false

  feed(delta: string): string {
    if (this.inSources) {
      this.sourcesText += delta
      return ''
    }
    this.pending += delta
    if (!this.headerDone && !this.resolveHeader()) return ''
    return this.drain(false)
  }

  finish(): string {
    if (!this.headerDone) {
      this.headerDone = true
      const parsed = headerQuestion(this.pending)
      if (parsed !== null) {
        this.question = parsed
        this.pending = ''
      }
    }
    return this.drain(true)
  }

  private resolveHeader(): boolean {
    const stripped = this.pending.replace(/^\s+/, '')
    if (stripped.length === 0) return false
    const head = stripped.slice(0, QUESTION_PREFIX.length).toUpperCase()
    if (QUESTION_PREFIX.startsWith(head) && head.length < QUESTION_PREFIX.length) return false
    if (head !== QUESTION_PREFIX) {
      this.headerDone = true
      return true
    }
    const newline = stripped.indexOf('\n')
    if (newline === -1) return false
    this.question = headerQuestion(stripped.slice(0, newline))
    this.pending = stripped.slice(newline + 1).replace(/^\s*\n/, '')
    this.headerDone = true
    return true
  }

  private drain(final: boolean): string {
    const marker = this.pending.indexOf(SOURCES_MARKER)
    if (marker !== -1) {
      const before = this.pending.slice(0, marker)
      this.sourcesText += this.pending.slice(marker + SOURCES_MARKER.length)
      this.pending = ''
      this.inSources = true
      this.emitted += before
      return before
    }
    let out = this.pending
    if (!final) {
      const hold = markerPrefixLength(this.pending)
      out = this.pending.slice(0, this.pending.length - hold)
      this.pending = this.pending.slice(this.pending.length - hold)
    } else {
      this.pending = ''
    }
    this.emitted += out
    return out
  }

  get answer(): string {
    return trimmed(this.emitted)
  }
}

export interface AnswerSource {
  kind: string
  label: string
  pageId?: number | undefined
  path?: string | undefined
  line?: number | undefined
  repo?: string | undefined
  sha?: string | undefined
}

export interface Answer {
  id: string
  askedAt: string
  question: string
  answer: string
  found: boolean
  sources: AnswerSource[]
  auto?: boolean | undefined
  answeredAt?: string | undefined
  questionMs?: number | undefined
  channel?: Channel | undefined
  askId?: string | undefined
}

export function encodeSource(source: AnswerSource): Record<string, unknown> {
  return { kind: source.kind, label: source.label, pageId: source.pageId, path: source.path, line: source.line, repo: source.repo, sha: source.sha }
}

export function encodeAnswer(answer: Answer): Record<string, unknown> {
  return {
    id: answer.id,
    askedAt: answer.askedAt,
    question: answer.question,
    answer: answer.answer,
    found: answer.found,
    sources: answer.sources.map(encodeSource),
    auto: answer.auto,
    answeredAt: answer.answeredAt,
    questionMs: answer.questionMs,
    channel: answer.channel,
    askId: answer.askId,
  }
}

function intLoose(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isInteger(value)) return value
  if (typeof value === 'string' && /^[+-]?\d+$/.test(value)) return Number(value)
  return undefined
}

function cleanOptional(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const text = trimmed(value)
  return text.length === 0 ? undefined : text
}

function decodeSourceLoose(item: unknown): AnswerSource | null {
  if (!isRecord(item) || typeof item['kind'] !== 'string') return null
  const kind = item['kind'].toLowerCase()
  if (!['page', 'file', 'commit'].includes(kind)) return null
  const pageId = intLoose(item['pageId'])
  const line = intLoose(item['line'])
  const sourcePath = cleanOptional(item['path'])
  const repo = cleanOptional(item['repo'])
  const sha = cleanOptional(item['sha'])
  if (kind === 'page' && pageId === undefined && sourcePath === undefined) return null
  if (kind === 'file' && sourcePath === undefined) return null
  if (kind === 'commit' && sha === undefined) return null
  let label = typeof item['label'] === 'string' ? trimmed(item['label']) : ''
  if (label.length === 0) {
    if (kind === 'page') label = pageId !== undefined ? `Página #${pageId}` : (sourcePath ?? '')
    else if (kind === 'file') label = [sourcePath ?? '', line !== undefined ? String(line) : ''].filter((part) => part.length > 0).join(':')
    else label = (sha ?? '').slice(0, 10)
  }
  return { kind, label, pageId, path: sourcePath, line, repo, sha }
}

export function decodeAnswer(value: unknown): Answer | null {
  if (!isRecord(value)) return null
  const { id, askedAt, question, answer, found } = value
  if (typeof id !== 'string' || typeof askedAt !== 'string' || typeof question !== 'string' || typeof answer !== 'string' || typeof found !== 'boolean') return null
  if (!Array.isArray(value['sources'])) return null
  const sources: AnswerSource[] = []
  for (const item of value['sources']) {
    if (!isRecord(item) || typeof item['kind'] !== 'string' || typeof item['label'] !== 'string') return null
    sources.push({
      kind: item['kind'],
      label: item['label'],
      pageId: typeof item['pageId'] === 'number' ? item['pageId'] : undefined,
      path: typeof item['path'] === 'string' ? item['path'] : undefined,
      line: typeof item['line'] === 'number' ? item['line'] : undefined,
      repo: typeof item['repo'] === 'string' ? item['repo'] : undefined,
      sha: typeof item['sha'] === 'string' ? item['sha'] : undefined,
    })
  }
  return {
    id,
    askedAt,
    question,
    answer,
    found,
    sources,
    auto: typeof value['auto'] === 'boolean' ? value['auto'] : undefined,
    answeredAt: typeof value['answeredAt'] === 'string' ? value['answeredAt'] : undefined,
    questionMs: typeof value['questionMs'] === 'number' ? value['questionMs'] : undefined,
    channel: value['channel'] === 'mic' || value['channel'] === 'system' ? value['channel'] : undefined,
    askId: typeof value['askId'] === 'string' ? value['askId'] : undefined,
  }
}

export interface SourcesBlock {
  question: string | null
  found: boolean | null
  sources: AnswerSource[]
  atMs: number | null
}

export function parseSourcesBlock(text: string): SourcesBlock | null {
  let body = text
  const close = body.indexOf('```')
  if (close !== -1) body = body.slice(0, close)
  const start = body.indexOf('{')
  const end = body.lastIndexOf('}')
  if (start === -1 || end === -1 || start >= end) return null
  const object = parseJsonSafe(body.slice(start, end + 1))
  if (!isRecord(object)) return null
  const items = Array.isArray(object['sources']) ? object['sources'] : []
  const question = typeof object['question'] === 'string' ? trimmed(object['question']) : null
  return {
    question: question && question.length > 0 ? question : null,
    found: typeof object['found'] === 'boolean' ? object['found'] : null,
    sources: items.map(decodeSourceLoose).filter((source): source is AnswerSource => source !== null),
    atMs: clockMilliseconds(object['at']),
  }
}

export const NOT_DOCUMENTED = 'no esta documentado'

export function buildAnswer(id: string, askedAt: string, explicitQuestion: string | null, assembler: AnswerAssembler, segments: readonly Segment[] = []): Answer {
  const block = parseSourcesBlock(assembler.sourcesText)
  const text = assembler.answer
  const sources = block?.sources ?? []
  const missing = fold(text).includes(NOT_DOCUMENTED)
  const found = !missing && (block?.found ?? sources.length > 0)
  const question = explicitQuestion ?? assembler.question ?? block?.question ?? ''
  const answer: Answer = { id, askedAt, question, answer: text, found, sources }
  if (explicitQuestion === null && block?.atMs !== null && block?.atMs !== undefined) {
    const origin = resolveOrigin(block.atMs, segments, question)
    if (origin) {
      answer.questionMs = origin.questionMs
      answer.channel = origin.channel
    }
  }
  return answer
}

export type AskEvent =
  | { type: 'question'; text: string }
  | { type: 'progress'; text: string }
  | { type: 'delta'; text: string }
  | { type: 'source'; source: AnswerSource }
  | { type: 'done'; answer: Answer }
  | { type: 'error'; code: string; message: string }

export function encodeAskEvent(event: AskEvent): Record<string, unknown> {
  switch (event.type) {
    case 'source':
      return { type: 'source', source: encodeSource(event.source) }
    case 'done':
      return { type: 'done', answer: encodeAnswer(event.answer) }
    case 'error':
      return { type: 'error', code: event.code, message: event.message }
    default:
      return { type: event.type, text: event.text }
  }
}

export class AskStreamReducer {
  readonly explicitQuestion: string | null
  private assembler = new AnswerAssembler()
  private questionSent: boolean
  private deltaSent = false
  private resultText: string | null = null
  private resultError = false

  constructor(explicitQuestion: string | null) {
    this.explicitQuestion = explicitQuestion
    this.questionSent = explicitQuestion !== null
  }

  consume(line: string, describer: ProgressDescriber): AskEvent[] {
    const events: AskEvent[] = []
    for (const event of parseStreamLine(line)) {
      if (event.type === 'text') {
        const out = this.assembler.feed(event.text)
        events.push(...this.questionEvent())
        if (out.length > 0) {
          this.deltaSent = true
          events.push({ type: 'delta', text: out })
        }
      } else if (event.type === 'tool') {
        events.push({ type: 'progress', text: describer.describe(event.name, event.input) })
      } else {
        this.resultText = event.text
        this.resultError = event.isError
      }
    }
    return events
  }

  private questionEvent(): AskEvent[] {
    if (this.questionSent || this.assembler.question === null) return []
    this.questionSent = true
    return [{ type: 'question', text: this.assembler.question }]
  }

  finish(status: number, stderr: string, id: string, askedAt: string, segments: readonly Segment[] = []): { events: AskEvent[]; answer: Answer } {
    const events: AskEvent[] = []
    const tail = this.assembler.finish()
    events.push(...this.questionEvent())
    if (tail.length > 0) {
      this.deltaSent = true
      events.push({ type: 'delta', text: tail })
    }
    if (this.resultError || (status !== 0 && this.resultText === null)) {
      const detail = this.resultText ?? trimmed(stderr)
      throw new RecapError('CLAUDE_FAILED', detail.length === 0 ? `claude exited with status ${status}` : suffix(detail, 500))
    }
    let canonical = this.assembler
    if (this.resultText !== null && trimmed(this.resultText).length > 0) {
      const fresh = new AnswerAssembler()
      fresh.feed(this.resultText)
      fresh.finish()
      canonical = fresh
    }
    const answer = buildAnswer(id, askedAt, this.explicitQuestion, canonical, segments)
    if (answer.answer.length === 0) throw new RecapError('CLAUDE_FAILED', 'claude returned an empty answer')
    if (!this.deltaSent) events.push({ type: 'delta', text: answer.answer })
    if (!this.questionSent && answer.question.length > 0) {
      this.questionSent = true
      events.push({ type: 'question', text: answer.question })
    }
    events.push(...answer.sources.map((source): AskEvent => ({ type: 'source', source })))
    return { events, answer }
  }
}

