import { trimmed } from '../core/text.ts'
import { PARAGRAPH_GAP_MS, PARAGRAPH_SPAN_MS, orderSegments, type Channel, type Segment } from '../pipeline/transcript.ts'
import { questionSimilarity } from './dedupe.ts'

export interface QuestionOrigin {
  questionMs: number
  channel: Channel
}

export function clockMilliseconds(value: unknown): number | null {
  if (typeof value !== 'string') return null
  let body = trimmed(value)
  if (body.length === 0) return null
  if (body.startsWith('[') && body.endsWith(']')) body = body.slice(1, -1)
  const parts = body.split(':')
  if (parts.length !== 2 && parts.length !== 3) return null
  if (!parts.every((part) => /^[0-9]{1,2}$/.test(part))) return null
  const numbers = parts.map(Number)
  const [hours, minutes, seconds] = numbers.length === 3 ? (numbers as [number, number, number]) : [0, numbers[0] ?? 0, numbers[1] ?? 0]
  if (minutes >= 60 || seconds >= 60) return null
  return ((hours * 60 + minutes) * 60 + seconds) * 1000
}

function best(indices: readonly number[], ordered: readonly Segment[], question: string | null | undefined): number | null {
  const text = question ? trimmed(question) : ''
  if (text.length === 0) return null
  let winner: { index: number; score: number } | null = null
  for (const index of indices) {
    const segment = ordered[index]
    if (!segment) continue
    const score = questionSimilarity(text, segment.text)
    if (score > (winner?.score ?? 0)) winner = { index, score }
  }
  return winner?.index ?? null
}

function anchor(atMs: number, ordered: readonly Segment[], question: string | null | undefined): number | null {
  if (ordered.length === 0) return null
  const second = Math.trunc(atMs / 1000)
  const indices = ordered.map((_, index) => index)
  const exact = indices.filter((index) => Math.trunc((ordered[index]?.startMs ?? 0) / 1000) === second)
  if (exact.length > 0) return best(exact, ordered, question) ?? exact[0] ?? null
  const until = second * 1000 + 999
  const covering = indices.filter((index) => (ordered[index]?.startMs ?? 0) <= until && (ordered[index]?.endMs ?? 0) >= atMs).pop()
  if (covering !== undefined) return covering
  const before = indices.filter((index) => (ordered[index]?.startMs ?? 0) <= until).pop()
  if (before !== undefined) return before
  let closest = 0
  for (const index of indices) {
    if (Math.abs((ordered[index]?.startMs ?? 0) - atMs) < Math.abs((ordered[closest]?.startMs ?? 0) - atMs)) closest = index
  }
  return closest
}

function paragraphFrom(index: number, ordered: readonly Segment[]): Segment[] {
  const first = ordered[index]
  if (!first) return []
  const members = [first]
  let lastEnd = first.endMs
  for (const segment of ordered.slice(index + 1)) {
    if (segment.channel !== first.channel || segment.startMs - lastEnd > PARAGRAPH_GAP_MS || segment.startMs - first.startMs >= PARAGRAPH_SPAN_MS) break
    members.push(segment)
    lastEnd = Math.max(lastEnd, segment.endMs)
  }
  return members
}

export function resolveOrigin(atMs: number, segments: readonly Segment[], question?: string | null): QuestionOrigin | null {
  const ordered = orderSegments(segments.filter((segment) => trimmed(segment.text).length > 0))
  const index = anchor(atMs, ordered, question)
  if (index === null) return null
  const members = paragraphFrom(index, ordered)
  let chosen = ordered[index]
  if (members.length > 1) {
    const refined = best(
      members.map((_, i) => i),
      members,
      question,
    )
    if (refined !== null) chosen = members[refined]
  }
  return chosen ? { questionMs: chosen.startMs, channel: chosen.channel } : null
}

export function resolveOriginClock(value: unknown, segments: readonly Segment[], question?: string | null): QuestionOrigin | null {
  const atMs = clockMilliseconds(value)
  return atMs === null ? null : resolveOrigin(atMs, segments, question)
}
