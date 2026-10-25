import path from 'node:path'
import { readText } from '../core/fsutil.ts'
import { isRecord, parseJsonSafe } from '../core/json.ts'
import { hasSystemAudio, recordedChannels, type Meeting } from '../core/meeting.ts'
import { fold, trimmed } from '../core/text.ts'
import { RecapError } from '../errors.ts'
import { decodeSegment, paragraphs, speakerLabel, type Channel, type Segment } from './transcript.ts'

export interface TranscriptSegmentView {
  start: number
  end: number
  channel: Channel
  text: string
}

export interface TranscriptParagraphView {
  start: number
  channel: Channel
  speaker: string | null
  text: string
}

export interface TranscriptView {
  segments: TranscriptSegmentView[]
  paragraphs: TranscriptParagraphView[]
  channels: Channel[]
}

export interface ActionItemView {
  text: string
  backlogKey?: string
}

export interface SummaryView {
  markdown: string
  agreements: string[]
  actionItems: ActionItemView[]
}

const CHANNEL_ORDER: Channel[] = ['mic', 'system']

function seconds(ms: number): number {
  return ms / 1000
}

function readSegments(dir: string): Segment[] | null {
  const text = readText(path.join(dir, 'transcript.json'))
  if (text === null) return null
  const value = parseJsonSafe(text)
  if (!Array.isArray(value)) return null
  return value.flatMap((item) => {
    const segment = decodeSegment(item)
    return segment ? [segment] : []
  })
}

const MARKDOWN_PARAGRAPH = /^\*\*\[(\d+):(\d{2}):(\d{2})\](?:\s+(Sala|Remotos):)?\*\*\s+(.*)$/

export function parseTranscriptMarkdown(markdown: string): Segment[] {
  const segments: Segment[] = []
  for (const line of markdown.split('\n')) {
    const match = MARKDOWN_PARAGRAPH.exec(trimmed(line))
    if (!match) continue
    const [, hours, minutes, secs, speaker, text] = match
    const startMs = (Number(hours) * 3600 + Number(minutes) * 60 + Number(secs)) * 1000
    segments.push({ startMs, endMs: startMs, channel: speaker === 'Remotos' ? 'system' : 'mic', text: text ?? '' })
  }
  return segments
}

export function transcriptView(meeting: Meeting, dir: string): TranscriptView {
  let segments = readSegments(dir)
  if (segments === null) {
    const markdown = readText(path.join(dir, 'transcript.md'))
    if (markdown === null) throw new RecapError('NO_TRANSCRIPT', `"${meeting.title}" has no transcript yet; run \`recap process ${meeting.id}\``)
    segments = parseTranscriptMarkdown(markdown)
  }
  const labelled = hasSystemAudio(meeting, dir)
  const present = new Set<Channel>([...recordedChannels(meeting), ...segments.map((segment) => segment.channel)])
  return {
    segments: segments.map((segment) => ({ start: seconds(segment.startMs), end: seconds(segment.endMs), channel: segment.channel, text: segment.text })),
    paragraphs: paragraphs(segments).map((paragraph) => ({
      start: seconds(paragraph.startMs),
      channel: paragraph.channel,
      speaker: labelled ? speakerLabel(paragraph.channel) : null,
      text: paragraph.text,
    })),
    channels: CHANNEL_ORDER.filter((channel) => present.has(channel)),
  }
}

export function markdownSection(markdown: string, heading: string): string[] {
  const wanted = fold(heading)
  const lines: string[] = []
  let inside = false
  let inFence = false
  for (const line of markdown.split('\n')) {
    if (line.startsWith('```')) inFence = !inFence
    if (!inFence && line.startsWith('## ')) {
      inside = fold(line.slice(3)).startsWith(wanted)
      continue
    }
    if (!inFence && line.startsWith('# ')) {
      inside = false
      continue
    }
    if (inside) lines.push(line)
  }
  return lines
}

const LIST_ITEM = /^\s*(?:\d+[.)]|[-*+])\s+(.*)$/
const EMPTY_ITEMS = new Set(['ninguno', 'ninguna', 'no hay', 'sin acuerdos', 'sin pendientes', '—', '-'])

function meaningful(text: string): boolean {
  return text.length > 0 && !EMPTY_ITEMS.has(fold(text).replace(/[.«»]/g, '').trim())
}

export function listItems(lines: readonly string[]): string[] {
  const items: string[] = []
  for (const line of lines) {
    const match = LIST_ITEM.exec(line)
    if (match) {
      items.push(trimmed(match[1] ?? ''))
      continue
    }
    const last = items.length - 1
    if (last >= 0 && /^\s{2,}\S/.test(line)) items[last] = `${items[last]} ${trimmed(line)}`
  }
  return items.filter(meaningful)
}

function tableCells(line: string): string[] {
  return trimmed(line)
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map((cell) => trimmed(cell))
}

export function tableColumn(lines: readonly string[], column: string): string[] {
  const rows = lines.filter((line) => trimmed(line).startsWith('|'))
  const header = rows[0]
  if (header === undefined) return []
  const index = tableCells(header).findIndex((cell) => fold(cell) === fold(column))
  if (index === -1) return []
  return rows
    .slice(1)
    .map(tableCells)
    .filter((cells) => !cells.every((cell) => /^:?-+:?$/.test(cell)))
    .map((cells) => cells[index] ?? '')
    .filter(meaningful)
}

function wrapupActionItems(meeting: Meeting, dir: string): ActionItemView[] | null {
  const plan = parseJsonSafe(readText(path.join(dir, 'wrapup.json')) ?? '')
  if (!isRecord(plan) || !Array.isArray(plan['backlog'])) return null
  const keys = meeting.wrapup?.backlogKeys ?? {}
  return plan['backlog'].filter(isRecord).flatMap((item) => {
    if (item['kind'] !== 'pending' || typeof item['title'] !== 'string') return []
    const key = keys[item['title']]
    return [key !== undefined && key !== '?' ? { text: item['title'], backlogKey: key } : { text: item['title'] }]
  })
}

export function summaryView(meeting: Meeting, dir: string): SummaryView {
  const markdown = readText(path.join(dir, 'summary.md')) ?? ''
  const pending = markdownSection(markdown, 'Pendientes')
  const table = tableColumn(pending, 'Pendiente')
  const fromSummary = (table.length > 0 ? table : listItems(pending)).map((text) => ({ text }))
  const fromWrapup = wrapupActionItems(meeting, dir)
  return {
    markdown,
    agreements: listItems(markdownSection(markdown, 'Acuerdos')),
    actionItems: fromWrapup !== null && fromWrapup.length > 0 ? fromWrapup : fromSummary,
  }
}
