import { clock, esHeaderDate, parseDate } from '../core/dates.ts'
import { durationSeconds, type Meeting } from '../core/meeting.ts'
import { isRecord } from '../core/json.ts'
import { fold, formatDuration, jaccard, trimmed } from '../core/text.ts'

export type Channel = 'mic' | 'system'

export function speakerLabel(channel: Channel): string {
  return channel === 'mic' ? 'Sala' : 'Remotos'
}

export interface Segment {
  startMs: number
  endMs: number
  channel: Channel
  text: string
}

export function decodeSegment(value: unknown): Segment | null {
  if (!isRecord(value)) return null
  const { startMs, endMs, channel, text } = value
  if (typeof startMs !== 'number' || typeof endMs !== 'number' || typeof text !== 'string') return null
  if (channel !== 'mic' && channel !== 'system') return null
  return { startMs: Math.trunc(startMs), endMs: Math.trunc(endMs), channel, text }
}

export function orderedSegment(segment: Segment): Segment {
  return { startMs: segment.startMs, endMs: segment.endMs, channel: segment.channel, text: segment.text }
}

export const HALLUCINATIONS = [
  'amara.org',
  'subtitulos realizados por',
  'subtitulos por la comunidad',
  'gracias por ver el video',
  'suscribete al canal',
  'thanks for watching',
  '[musica]',
  '(musica)',
  '[blank_audio]',
]

export function isHallucination(text: string): boolean {
  const normalized = fold(text)
  if (normalized.length === 0) return true
  return HALLUCINATIONS.some((pattern) => normalized.includes(pattern))
}

export function parseWhisper(text: string, channel: Channel): Segment[] {
  const value = JSON.parse(text) as unknown
  if (!isRecord(value) || !Array.isArray(value['transcription'])) throw new Error('whisper output has no transcription')
  const segments: Segment[] = []
  for (const item of value['transcription']) {
    if (!isRecord(item) || !isRecord(item['offsets']) || typeof item['text'] !== 'string') throw new Error('whisper output has an invalid segment')
    const from = item['offsets']['from']
    const to = item['offsets']['to']
    if (typeof from !== 'number' || typeof to !== 'number') throw new Error('whisper output has an invalid offset')
    const content = trimmed(item['text'])
    if (content.length === 0 || isHallucination(content)) continue
    segments.push({ startMs: from, endMs: to, channel, text: content })
  }
  return segments
}

export const ECHO_WINDOW_MS = 2_500
export const ECHO_SIMILARITY = 0.5

export function isEcho(mic: Segment, system: Segment): boolean {
  const overlaps = mic.startMs <= system.endMs + ECHO_WINDOW_MS && system.startMs <= mic.endMs + ECHO_WINDOW_MS
  return overlaps && jaccard(mic.text, system.text) >= ECHO_SIMILARITY
}

export function orderSegments(segments: readonly Segment[]): Segment[] {
  return segments
    .map((segment, index) => ({ segment, index }))
    .sort((left, right) => {
      const a = left.segment
      const b = right.segment
      if (a.startMs !== b.startMs) return a.startMs - b.startMs
      if (a.channel !== b.channel) return a.channel === 'system' ? -1 : 1
      return left.index - right.index
    })
    .map((item) => item.segment)
}

export function mergeTranscripts(mic: readonly Segment[], system: readonly Segment[]): Segment[] {
  const filtered = mic.filter((segment) => !system.some((other) => isEcho(segment, other)))
  return orderSegments([...filtered, ...system])
}

export interface Paragraph {
  startMs: number
  channel: Channel
  text: string
}

export const PARAGRAPH_GAP_MS = 4_000
export const PARAGRAPH_SPAN_MS = 30_000

export function paragraphs(segments: readonly Segment[]): Paragraph[] {
  const result: Paragraph[] = []
  let lastEnd = Number.MIN_SAFE_INTEGER
  for (const segment of segments) {
    const last = result[result.length - 1]
    if (last && last.channel === segment.channel && segment.startMs - lastEnd <= PARAGRAPH_GAP_MS && segment.startMs - last.startMs < PARAGRAPH_SPAN_MS) {
      last.text += ` ${segment.text}`
    } else {
      result.push({ startMs: segment.startMs, channel: segment.channel, text: segment.text })
    }
    lastEnd = Math.max(lastEnd, segment.endMs)
  }
  return result
}

export function meetingHeader(meeting: Meeting): string {
  const date = parseDate(meeting.startedAt) ?? parseDate(meeting.createdAt) ?? new Date()
  const mode = meeting.mode === 'remote' ? 'remota' : 'presencial'
  return `${esHeaderDate(date)} · ${formatDuration(durationSeconds(meeting))} · reunión ${mode}`
}

export function transcriptMarkdown(meeting: Meeting, segments: readonly Segment[]): string {
  const lines = [`# Transcripción: ${meeting.title}`, '', meetingHeader(meeting), '']
  if (meeting.mode === 'remote') {
    lines.push('> **Sala**: micrófono local (quien graba y quien esté en la misma sala). **Remotos**: audio de la llamada.', '')
  }
  const grouped = paragraphs(segments)
  if (grouped.length === 0) lines.push('_No se detectó voz en la grabación._')
  for (const paragraph of grouped) {
    const speaker = meeting.mode === 'remote' ? ` ${speakerLabel(paragraph.channel)}:` : ''
    lines.push(`**[${clock(paragraph.startMs)}]${speaker}** ${paragraph.text}`, '')
  }
  return lines.join('\n')
}
