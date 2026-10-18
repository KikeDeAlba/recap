import { findTool, invokeTool, type FoundTool } from '@kikedealba/kit/registry'
import { QUIET_ENV, neutralCwd, type ToolCalling, type ToolResponse } from '../bita/client.ts'
import { dayString, parseDate } from '../core/dates.ts'
import { isRecord } from '../core/json.ts'
import { trimmed } from '../core/text.ts'
import { errorMessage } from '../errors.ts'
import type { Answer, AnswerSource } from './stream.ts'

export interface BrainNote {
  id: string
  title: string
  kind: string
  project: string
  snippet: string
  score: number
}

export interface GazeCalling extends ToolCalling {
  readonly bin: string
  invoke(args: readonly string[], input?: string): Promise<ToolResponse>
}

export const GAZE_CAPABILITIES = ['memory.search', 'memory.write'] as const

export const BRAIN_LIMIT = 5

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

export async function findGaze(): Promise<GazeClient | null> {
  if (process.env['RECAP_NO_GAZE'] === '1') return null
  const tool = await findTool('gaze').catch(() => null)
  if (!tool) return null
  if (!GAZE_CAPABILITIES.every((capability) => tool.manifest.capabilities.includes(capability))) return null
  return new GazeClient(tool)
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

export async function searchBrain(gaze: ToolCalling | null, project: string | null, question: string | null | undefined): Promise<BrainNote[]> {
  const text = question ? trimmed(question) : ''
  if (!gaze || !project || text.length === 0) return []
  try {
    const response = await gaze.invoke(['search', text, '--project', project, '--limit', String(BRAIN_LIMIT), '--json'])
    return response.ok ? parseBrainNotes(response.data) : []
  } catch {
    return []
  }
}

export const REMEMBERED_SOURCE_KINDS = ['page', 'file', 'commit']

export function shouldRemember(answer: Answer): boolean {
  if (answer.found !== true) return false
  if (answer.sources.some((source) => source.kind === 'note')) return false
  return answer.sources.some((source) => REMEMBERED_SOURCE_KINDS.includes(source.kind))
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
  return [trimmed(answer.answer), '', 'Fuentes:', ...answer.sources.map((source) => `- ${sourceLine(source)}`), '', `Reunión: «${meeting.title}» (${dayString(date)})`].join('\n')
}

export async function rememberAnswer(
  gaze: GazeCalling | null,
  project: string | null,
  answer: Answer,
  meeting: MeetingStamp,
  log: (line: string) => void = () => {},
): Promise<boolean> {
  const title = trimmed(answer.question)
  if (!gaze || !project || title.length === 0 || !shouldRemember(answer)) return false
  try {
    const response = await gaze.invoke(['remember', '-', '--project', project, '--kind', 'fact', '--title', title, '--json'], brainNoteBody(answer, meeting))
    if (!response.ok) log(`gaze remember failed: ${response.errorMessage ?? 'no reason given'}`)
    return response.ok
  } catch (error) {
    log(`gaze remember failed: ${errorMessage(error)}`)
    return false
  }
}
