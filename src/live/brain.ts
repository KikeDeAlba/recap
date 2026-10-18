import { execFile } from 'node:child_process'
import { readFileSync, realpathSync, statSync } from 'node:fs'
import path from 'node:path'
import { findTool, invokeTool, type FoundTool, type InvokeResult } from '@kikedealba/kit/registry'
import { QUIET_ENV, neutralCwd, type ToolCalling, type ToolResponse } from '../bita/client.ts'
import { dayString, parseDate } from '../core/dates.ts'
import { isRecord } from '../core/json.ts'
import { prefix, suffix, trimmed } from '../core/text.ts'
import { errorMessage } from '../errors.ts'
import type { Segment } from '../pipeline/transcript.ts'
import type { PageRef, ProjectContext } from './context.ts'
import type { Answer, AnswerSource } from './stream.ts'

export interface BrainNote {
  id: string
  title: string
  kind: string
  project: string
  snippet: string
  score: number
  body?: string | undefined
}

export interface GazeCalling extends ToolCalling {
  readonly bin: string
  invoke(args: readonly string[], input?: string): Promise<ToolResponse>
}

export const GAZE_CAPABILITIES = ['memory.search', 'memory.write'] as const

export const BRAIN_LIMIT = 5
export const BRAIN_SHOWN = 3
export const BRAIN_QUERY_SECONDS = 30
export const BRAIN_QUERY_CHARS = 300
export const BRAIN_BODY_CHARS = 1200
export const NOTE_TITLE_CHARS = 200
export const NOTE_KIND_CHARS = 32
export const BRAIN_ANSWER_CHARS = 8000
export const GAZE_LOOKUP_MS = 10_000
export const GAZE_REMEMBER_MS = 60_000

const NOTE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]*$/

export type GazeInvoker = (
  tool: FoundTool,
  args: readonly string[],
  options: { env: NodeJS.ProcessEnv; cwd: string; timeoutMs: number; input?: string },
) => Promise<InvokeResult<unknown>>

export function gazeTimeout(args: readonly string[]): number {
  return args[0] === 'remember' ? GAZE_REMEMBER_MS : GAZE_LOOKUP_MS
}

export class GazeClient implements GazeCalling {
  readonly tool: FoundTool
  readonly run: GazeInvoker

  constructor(tool: FoundTool, run: GazeInvoker = invokeTool) {
    this.tool = tool
    this.run = run
  }

  get bin(): string {
    return this.tool.bin.join(' ')
  }

  async invoke(args: readonly string[], input?: string): Promise<ToolResponse> {
    try {
      const { envelope } = await this.run(this.tool, args, {
        env: { ...process.env, ...QUIET_ENV },
        cwd: neutralCwd(),
        timeoutMs: gazeTimeout(args),
        ...(input === undefined ? {} : { input }),
      })
      return { ok: envelope.ok, data: envelope.data, meta: envelope.meta, errorCode: envelope.error?.code, errorMessage: envelope.error?.message }
    } catch (error) {
      return { ok: false, errorCode: 'GAZE_FAILED', errorMessage: errorMessage(error) }
    }
  }
}

export async function findGaze(find: (name: string) => Promise<FoundTool | null> = findTool): Promise<GazeClient | null> {
  if (process.env['RECAP_NO_GAZE'] === '1') return null
  const tool = await find('gaze').catch(() => null)
  if (!tool) return null
  if (!GAZE_CAPABILITIES.every((capability) => tool.manifest.capabilities.includes(capability))) return null
  return new GazeClient(tool)
}

export function brainAvailable(context: ProjectContext): boolean {
  return context.project !== null && context.gaze !== null
}

export function parseBrainNotes(data: unknown): BrainNote[] {
  if (!Array.isArray(data)) return []
  const notes: BrainNote[] = []
  for (const item of data) {
    if (!isRecord(item)) continue
    const id = typeof item['id'] === 'number' ? String(item['id']) : item['id']
    if (typeof id !== 'string' || trimmed(id).length === 0) continue
    notes.push({
      id: trimmed(id),
      title: typeof item['title'] === 'string' ? trimmed(item['title']) : '',
      kind: typeof item['kind'] === 'string' ? item['kind'] : '',
      project: typeof item['project'] === 'string' ? item['project'] : '',
      snippet: typeof item['snippet'] === 'string' ? trimmed(item['snippet'].replace(/\s+/g, ' ')) : '',
      score: typeof item['score'] === 'number' ? item['score'] : 0,
    })
  }
  return notes
}

export function brainQuery(question: string | null | undefined, window: readonly Segment[]): string {
  const explicit = question ? trimmed(question) : ''
  if (explicit.length > 0) return explicit
  const joined = trimmed(
    window
      .map((segment) => trimmed(segment.text))
      .filter((text) => text.length > 0)
      .join(' '),
  )
  return trimmed(suffix(joined, BRAIN_QUERY_CHARS))
}

async function noteBody(gaze: ToolCalling, note: BrainNote): Promise<BrainNote> {
  try {
    const response = await gaze.invoke(['show', '--json', '--', note.id])
    const body = response.ok && isRecord(response.data) && typeof response.data['body'] === 'string' ? response.data['body'] : null
    return { ...note, body: body ?? note.snippet }
  } catch {
    return { ...note, body: note.snippet }
  }
}

export async function searchBrain(gaze: ToolCalling | null, project: string | null, query: string | null | undefined): Promise<BrainNote[]> {
  const text = query ? trimmed(query) : ''
  if (!gaze || !project || text.length === 0) return []
  try {
    const response = await gaze.invoke(['search', `--project=${project}`, '--limit', String(BRAIN_LIMIT), '--json', '--', text])
    if (!response.ok) return []
    const notes = parseBrainNotes(response.data)
      .filter((note) => NOTE_ID.test(note.id))
      .slice(0, BRAIN_SHOWN)
    return await Promise.all(notes.map((note) => noteBody(gaze, note)))
  } catch {
    return []
  }
}

export function scalarCount(text: string): number {
  return Array.from(text).length
}

export function cut(text: string, length: number): string {
  return scalarCount(text) > length ? `${prefix(text, length)}…` : text
}

const CONTROL = /\p{Cc}/gu
const BODY_CONTROL = /[^\P{Cc}\n\t]/gu

function angles(text: string): string {
  return text.replace(/</g, '‹').replace(/>/g, '›')
}

export function inlineNoteText(text: string): string {
  return trimmed(angles(text).replace(/\s+/g, ' ').replace(CONTROL, ''))
}

export function noteBodyText(text: string): string {
  return angles(text).replace(BODY_CONTROL, '')
}

export interface PromptNote {
  id: string
  title: string
  kind: string
  body: string
}

export function promptNotes(notes: readonly BrainNote[]): PromptNote[] {
  return notes
    .map((note) => ({
      id: inlineNoteText(note.id),
      title: cut(inlineNoteText(note.title), NOTE_TITLE_CHARS),
      kind: cut(inlineNoteText(note.kind), NOTE_KIND_CHARS),
      body: cut(trimmed(noteBodyText(note.body ?? note.snippet)), BRAIN_BODY_CHARS),
    }))
    .filter((note) => NOTE_ID.test(note.id))
}

export function brainNotesShown(available: boolean, notes: readonly BrainNote[]): number {
  return available ? promptNotes(notes).length : 0
}

export function renderBrain(available: boolean, notes: readonly BrainNote[]): string {
  if (!available) return '  (el cerebro no está disponible)'
  const shown = promptNotes(notes)
  if (shown.length === 0) return '  (sin notas en el cerebro)'
  return shown
    .map((note) => {
      const lines = note.body.length === 0 ? [] : note.body.split('\n').map((line) => `    ${line}`)
      return [`  - [${note.id}] ${note.title} (${note.kind})`, ...lines].join('\n')
    })
    .join('\n')
}

const SECRET_PATTERNS: readonly { name: string; pattern: RegExp }[] = [
  { name: 'aws-key', pattern: /(?:AKIA|ASIA)[0-9A-Z]{16}/ },
  { name: 'github-token', pattern: /gh[pousr]_[A-Za-z0-9]{36,}/ },
  { name: 'github-token', pattern: /github_pat_[A-Za-z0-9_]{20,}/ },
  { name: 'gitlab-token', pattern: /glpat-[A-Za-z0-9_-]{20,}/ },
  { name: 'api-key', pattern: /sk-[A-Za-z0-9_-]{20,}/ },
  { name: 'api-key', pattern: /(?:sk|pk|rk)_(?:live|test)_[A-Za-z0-9]{10,}/ },
  { name: 'slack-token', pattern: /xox[abprs]-[A-Za-z0-9-]{10,}/ },
  { name: 'npm-token', pattern: /npm_[A-Za-z0-9]{36}/ },
  { name: 'private-key', pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  { name: 'jwt', pattern: /eyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/ },
  { name: 'bearer', pattern: /bearer\s+[A-Za-z0-9._~+/-]{16,}=*/i },
  { name: 'uri-credentials', pattern: /[a-z][a-z0-9+.-]{0,20}:\/\/[^\s/:@]{1,64}:[^\s/@]{1,128}@/i },
  { name: 'credential', pattern: /(?:password|passwd|pwd|secret|token|api[_-]?key|client[_-]?secret|access[_-]?key)["']?\s*(?::|=|\bis\b)\s*\S+/i },
  { name: 'email', pattern: /[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9.-]{1,255}\.[A-Za-z]{2,24}/ },
]

const CARD_RUN = /[0-9](?:[\s./-]{0,3}[0-9]){0,63}/g
const CARD_MIN = 13
const CARD_MAX = 19

export function passesLuhn(digits: string): boolean {
  let sum = 0
  for (let index = 0; index < digits.length; index += 1) {
    let digit = Number(digits[digits.length - 1 - index])
    if (index % 2 === 1) {
      digit *= 2
      if (digit > 9) digit -= 9
    }
    sum += digit
  }
  return digits.length > 0 && sum % 10 === 0
}

export function hasCardNumber(digits: string, starts: readonly number[] = [0]): boolean {
  for (const start of starts) {
    for (let length = CARD_MIN; length <= CARD_MAX && start + length <= digits.length; length += 1) {
      if (passesLuhn(digits.slice(start, start + length))) return true
    }
  }
  return false
}

function cardRun(run: string): { digits: string; starts: number[] } {
  let digits = ''
  const starts = [0]
  let gap = false
  for (const char of run) {
    if (char >= '0' && char <= '9') {
      if (gap) starts.push(digits.length)
      digits += char
      gap = false
    } else {
      gap = true
    }
  }
  return { digits, starts }
}

export function sensitiveContent(text: string): string | null {
  const normalized = text.normalize('NFKC')
  for (const match of normalized.matchAll(CARD_RUN)) {
    const { digits, starts } = cardRun(match[0])
    if (hasCardNumber(digits, starts)) return 'card'
  }
  return SECRET_PATTERNS.find((entry) => entry.pattern.test(normalized))?.name ?? null
}

export interface SourceChecks {
  realpath(file: string): string | null
  isFile(file: string): boolean
  lineCount(file: string): number | null
  commitExists(repo: string, sha: string): Promise<boolean>
}

export const fileSystemChecks: SourceChecks = {
  realpath(file) {
    try {
      return realpathSync(file)
    } catch {
      return null
    }
  },
  isFile(file) {
    try {
      return statSync(file).isFile()
    } catch {
      return false
    }
  },
  lineCount(file) {
    try {
      const text = readFileSync(file, 'utf8')
      if (text.length === 0) return 0
      const lines = text.split('\n')
      return text.endsWith('\n') ? lines.length - 1 : lines.length
    } catch {
      return null
    }
  },
  commitExists(repo, sha) {
    return new Promise((resolve) => {
      execFile('git', ['-C', repo, 'cat-file', '-e', `${sha}^{commit}`], { timeout: 10_000, windowsHide: true }, (error) => resolve(error === null))
    })
  },
}

const SHA = /^[0-9a-f]{4,40}$/i

function within(file: string, root: string): boolean {
  const relative = path.relative(root, file)
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))
}

function repoPaths(context: ProjectContext): string[] {
  return context.repos.filter((repo) => repo.exists).map((repo) => repo.path)
}

export async function sourceVerified(source: AnswerSource, context: ProjectContext, checks: SourceChecks = fileSystemChecks): Promise<boolean> {
  switch (source.kind) {
    case 'page':
      if (source.path?.includes('\0')) return false
      return context.pages.some((page) => (source.pageId !== undefined && page.pageId === source.pageId) || (source.path !== undefined && page.relPath.length > 0 && page.relPath === source.path))
    case 'file': {
      if (source.path === undefined || source.path.length === 0 || source.path.includes('\0')) return false
      const candidate = path.isAbsolute(source.path) ? source.path : context.docsRoot ? path.join(context.docsRoot, source.path) : null
      const real = candidate === null ? null : checks.realpath(candidate)
      if (real === null) return false
      const roots = [...(context.docsRoot ? [context.docsRoot] : []), ...repoPaths(context)].map((root) => checks.realpath(root)).filter((root): root is string => root !== null)
      if (!roots.some((root) => within(real, root)) || !checks.isFile(real)) return false
      if (source.line === undefined) return true
      const count = checks.lineCount(real)
      return Number.isInteger(source.line) && count !== null && source.line >= 1 && source.line <= count
    }
    case 'commit': {
      if (source.repo === undefined || source.sha === undefined || source.repo.includes('\0') || !SHA.test(source.sha)) return false
      if (!repoPaths(context).includes(source.repo)) return false
      return checks.commitExists(source.repo, source.sha).catch(() => false)
    }
    default:
      return false
  }
}

export function eligibleForBrain(answer: Answer): boolean {
  return answer.found === true && answer.sources.length > 0 && !answer.sources.some((source) => source.kind === 'note')
}

async function unverifiedSource(answer: Answer, context: ProjectContext, checks: SourceChecks): Promise<AnswerSource | null> {
  const results = await Promise.all(answer.sources.map((source) => sourceVerified(source, context, checks)))
  return answer.sources.find((_, index) => !results[index]) ?? null
}

export async function verifiedForBrain(answer: Answer, context: ProjectContext, checks: SourceChecks = fileSystemChecks): Promise<boolean> {
  return eligibleForBrain(answer) && (await unverifiedSource(answer, context, checks)) === null
}

export function noteTitle(question: string): string {
  return cut(trimmed(question.replace(/\s+/g, ' ')), NOTE_TITLE_CHARS)
}

function sourcePage(source: AnswerSource, pages: readonly PageRef[]): PageRef | null {
  return (
    pages.find((page) => source.pageId !== undefined && page.pageId === source.pageId) ??
    pages.find((page) => source.path !== undefined && page.relPath.length > 0 && page.relPath === source.path) ??
    null
  )
}

export function sourceLine(source: AnswerSource, pages: readonly PageRef[] = []): string {
  const repo = source.repo ? ` (${source.repo})` : ''
  switch (source.kind) {
    case 'page': {
      const page = sourcePage(source, pages)
      const pageId = page ? page.pageId : source.pageId
      const relPath = page ? page.relPath : (source.path ?? '')
      const details = [pageId !== undefined ? `#${pageId}` : '', relPath].filter((part) => part.length > 0)
      return `«${page?.title ?? ''}»${details.length > 0 ? ` (${details.join(', ')})` : ''}`
    }
    case 'file':
      return `${source.path ?? ''}${source.line !== undefined ? `:${source.line}` : ''}${repo}`
    case 'commit':
      return `${source.sha ?? ''}${repo}`
    default:
      return ''
  }
}

export interface MeetingStamp {
  title: string
  createdAt: string
}

export function brainNoteBody(answer: Answer, meeting: MeetingStamp, pages: readonly PageRef[] = []): string {
  const date = parseDate(meeting.createdAt) ?? parseDate(answer.askedAt) ?? new Date()
  return [
    trimmed(answer.answer),
    '',
    'Fuentes:',
    ...answer.sources.map((source) => `- ${sourceLine(source, pages)}`),
    '',
    `Generada por recap a partir de la reunión «${trimmed(meeting.title.replace(/\s+/g, ' '))}» (${dayString(date)}); sin revisión humana.`,
  ].join('\n')
}

export async function rememberAnswer(
  context: ProjectContext,
  answer: Answer,
  meeting: MeetingStamp,
  log: (line: string) => void = () => {},
  notesUsed = false,
  checks: SourceChecks = fileSystemChecks,
): Promise<boolean> {
  const { gaze, project } = context
  if (!gaze || !project) return false
  if (notesUsed) {
    log('gaze: not saved (brain notes were used)')
    return false
  }
  if (!eligibleForBrain(answer)) return false
  if (scalarCount(answer.answer) > BRAIN_ANSWER_CHARS) {
    log('gaze: not saved (answer too long)')
    return false
  }
  const title = noteTitle(answer.question)
  if (title.length === 0) return false
  try {
    const body = brainNoteBody(answer, meeting, context.pages)
    const secret = sensitiveContent(title) ?? sensitiveContent(body)
    if (secret) {
      log(`gaze: not saved (sensitive content: ${secret})`)
      return false
    }
    const unverified = await unverifiedSource(answer, context, checks)
    if (unverified) {
      log(`gaze: not saved (unverified ${unverified.kind} source «${unverified.label}»)`)
      return false
    }
    const response = await gaze.invoke(['remember', `--project=${project}`, '--kind', 'fact', `--title=${title}`, '--json', '-'], body)
    if (!response.ok) log(`gaze remember failed: ${response.errorMessage ?? 'no reason given'}`)
    return response.ok
  } catch (error) {
    log(`gaze remember failed: ${errorMessage(error)}`)
    return false
  }
}
