import { execFile } from 'node:child_process'
import { readFileSync, realpathSync, statSync } from 'node:fs'
import path from 'node:path'
import { findTool, invokeTool, type FoundTool } from '@kikedealba/kit/registry'
import { QUIET_ENV, neutralCwd, type ToolCalling, type ToolResponse } from '../bita/client.ts'
import { dayString, parseDate } from '../core/dates.ts'
import { isRecord } from '../core/json.ts'
import { prefix, suffix, trimmed } from '../core/text.ts'
import { errorMessage } from '../errors.ts'
import type { Segment } from '../pipeline/transcript.ts'
import type { ProjectContext } from './context.ts'
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

const NOTE_ID = /^[A-Za-z0-9_-]+$/

export class GazeClient implements GazeCalling {
  readonly tool: FoundTool

  constructor(tool: FoundTool) {
    this.tool = tool
  }

  get bin(): string {
    return this.tool.bin.join(' ')
  }

  async invoke(args: readonly string[], input?: string): Promise<ToolResponse> {
    try {
      const { envelope } = await invokeTool(this.tool, args, {
        env: { ...process.env, ...QUIET_ENV },
        cwd: neutralCwd(),
        timeoutMs: 60_000,
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
    const response = await gaze.invoke(['show', note.id, '--json'])
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
    const response = await gaze.invoke(['search', '--project', project, '--limit', String(BRAIN_LIMIT), '--json', '--', text])
    if (!response.ok) return []
    const notes = parseBrainNotes(response.data)
      .filter((note) => NOTE_ID.test(note.id))
      .slice(0, BRAIN_SHOWN)
    return await Promise.all(notes.map((note) => noteBody(gaze, note)))
  } catch {
    return []
  }
}

function cut(text: string, length: number): string {
  return [...text].length > length ? `${prefix(text, length)}…` : text
}

export function renderBrain(available: boolean, notes: readonly BrainNote[]): string {
  if (!available) return '  (el cerebro no está disponible)'
  if (notes.length === 0) return '  (sin notas en el cerebro)'
  return notes
    .map((note) => {
      const body = cut(trimmed(note.body ?? note.snippet), BRAIN_BODY_CHARS)
      const lines = body.length === 0 ? [] : body.split('\n').map((line) => `    ${line}`)
      return [`  - [${note.id}] ${note.title} (${note.kind})`, ...lines].join('\n')
    })
    .join('\n')
}

const SECRET_PATTERNS: { name: string; pattern: RegExp }[] = [
  { name: 'aws key', pattern: /(?:AKIA|ASIA)[0-9A-Z]{16}/ },
  { name: 'github token', pattern: /gh[pousr]_[A-Za-z0-9]{36,}/ },
  { name: 'gitlab token', pattern: /glpat-[A-Za-z0-9_-]{20,}/ },
  { name: 'api key', pattern: /sk-[A-Za-z0-9_-]{20,}/ },
  { name: 'slack token', pattern: /xox[abprs]-[A-Za-z0-9-]{10,}/ },
  { name: 'private key', pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  { name: 'credential', pattern: /(password|passwd|pwd|secret|token|api[_-]?key)\s*[:=]\s*\S+/i },
  { name: 'email', pattern: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/ },
]

const CARD_CANDIDATE = /(?<!\d)\d(?:[ -]?\d){12,18}(?!\d)/g

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

export function sensitiveContent(text: string): string | null {
  for (const match of text.matchAll(CARD_CANDIDATE)) {
    if (passesLuhn(match[0].replace(/[ -]/g, ''))) return 'card number'
  }
  return SECRET_PATTERNS.find((entry) => entry.pattern.test(text))?.name ?? null
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
      return context.pages.some((page) => (source.pageId !== undefined && page.pageId === source.pageId) || (source.path !== undefined && page.relPath.length > 0 && page.relPath === source.path))
    case 'file': {
      if (source.path === undefined || source.path.length === 0) return false
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
      if (source.repo === undefined || source.sha === undefined || !SHA.test(source.sha)) return false
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

export function sourceLine(source: AnswerSource): string {
  const repo = source.repo ? ` (${source.repo})` : ''
  switch (source.kind) {
    case 'page': {
      const details = [source.pageId !== undefined ? `#${source.pageId}` : '', source.path ?? ''].filter((part) => part.length > 0)
      return `«${source.label}»${details.length > 0 ? ` (${details.join(', ')})` : ''}`
    }
    case 'file':
      return `${source.path ?? source.label}${source.line !== undefined ? `:${source.line}` : ''}${repo}`
    case 'commit':
      return `${source.sha ?? ''} ${source.label}${repo}`
    default:
      return source.label
  }
}

export interface MeetingStamp {
  title: string
  createdAt: string
}

export function brainNoteBody(answer: Answer, meeting: MeetingStamp): string {
  const date = parseDate(meeting.createdAt) ?? parseDate(answer.askedAt) ?? new Date()
  return [
    trimmed(answer.answer),
    '',
    'Fuentes:',
    ...answer.sources.map((source) => `- ${sourceLine(source)}`),
    '',
    `Generada por recap a partir de la reunión «${meeting.title}» (${dayString(date)}); sin revisión humana.`,
  ].join('\n')
}

export async function rememberAnswer(
  context: ProjectContext,
  answer: Answer,
  meeting: MeetingStamp,
  log: (line: string) => void = () => {},
  checks: SourceChecks = fileSystemChecks,
): Promise<boolean> {
  const { gaze, project } = context
  if (!gaze || !project || !eligibleForBrain(answer)) return false
  const title = noteTitle(answer.question)
  if (title.length === 0) return false
  try {
    const secret = [answer.question, title, answer.answer].map(sensitiveContent).find((reason) => reason !== null)
    if (secret) {
      log(`gaze: not saved (${secret})`)
      return false
    }
    const unverified = await unverifiedSource(answer, context, checks)
    if (unverified) {
      log(`gaze: not saved (unverified ${unverified.kind} source «${unverified.label}»)`)
      return false
    }
    const response = await gaze.invoke(['remember', '--project', project, '--kind', 'fact', `--title=${title}`, '--json', '-'], brainNoteBody(answer, meeting))
    if (!response.ok) log(`gaze remember failed: ${response.errorMessage ?? 'no reason given'}`)
    return response.ok
  } catch (error) {
    log(`gaze remember failed: ${errorMessage(error)}`)
    return false
  }
}
