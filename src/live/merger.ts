import { readText } from '../core/fsutil.ts'
import { setsEqual, tokens } from '../core/text.ts'
import { clock } from '../core/dates.ts'
import { ECHO_WINDOW_MS, decodeSegment, isEcho, orderSegments, paragraphs, speakerLabel, type Channel, type Segment } from '../pipeline/transcript.ts'
import { liveFiles, readLines } from './files.ts'
import path from 'node:path'

export const SYSTEM_MEMORY_MS = 60_000
export const REPEAT_WINDOW_MS = 30_000

export class LiveMerger {
  readonly hasSystem: boolean
  readonly holdSeconds: number
  systemCoveredMs = 0
  private recentSystem: Segment[] = []
  private pendingMic: { segment: Segment; addedAt: number }[] = []
  private lastText: Partial<Record<Channel, Segment>> = {}

  constructor(hasSystem: boolean, holdSeconds: number) {
    this.hasSystem = hasSystem
    this.holdSeconds = holdSeconds
  }

  get pendingCount(): number {
    return this.pendingMic.length
  }

  add(segments: readonly Segment[], channel: Channel, coveredUntilMs: number, now: number): Segment[] {
    const fresh = segments.filter((segment) => !this.isRepeat(segment))
    if (channel === 'system') {
      this.recentSystem.push(...fresh)
      this.systemCoveredMs = Math.max(this.systemCoveredMs, coveredUntilMs)
      const horizon = this.systemCoveredMs - SYSTEM_MEMORY_MS
      this.recentSystem = this.recentSystem.filter((segment) => segment.endMs >= horizon)
      return orderSegments([...fresh, ...this.release(now, false)])
    }
    if (!this.hasSystem) return orderSegments(fresh)
    this.pendingMic.push(...fresh.map((segment) => ({ segment, addedAt: now })))
    return orderSegments(this.release(now, false))
  }

  advance(channel: Channel, toMs: number, now: number): Segment[] {
    if (channel === 'system') this.systemCoveredMs = Math.max(this.systemCoveredMs, toMs)
    return orderSegments(this.release(now, false))
  }

  release(now: number, force: boolean): Segment[] {
    const ready: Segment[] = []
    const waiting: { segment: Segment; addedAt: number }[] = []
    for (const item of this.pendingMic) {
      const covered = item.segment.endMs + ECHO_WINDOW_MS <= this.systemCoveredMs
      const expired = (now - item.addedAt) / 1000 >= this.holdSeconds
      if (force || covered || expired) {
        if (!this.recentSystem.some((system) => isEcho(item.segment, system))) ready.push(item.segment)
      } else {
        waiting.push(item)
      }
    }
    this.pendingMic = waiting
    return orderSegments(ready)
  }

  private isRepeat(segment: Segment): boolean {
    const previous = this.lastText[segment.channel]
    this.lastText[segment.channel] = segment
    if (!previous) return false
    const current = tokens(segment.text)
    return segment.startMs - previous.endMs <= REPEAT_WINDOW_MS && current.size > 0 && setsEqual(tokens(previous.text), current)
  }
}

export function loadLiveTranscript(meetingDir: string): Segment[] {
  const live = readLines(liveFiles.transcript(meetingDir), decodeSegment)
  if (live.length > 0) return orderSegments(live)
  const text = readText(path.join(meetingDir, 'transcript.json'))
  if (text === null) return []
  try {
    const value = JSON.parse(text) as unknown
    if (!Array.isArray(value)) return []
    const segments = value.map(decodeSegment)
    if (segments.some((segment) => segment === null)) return []
    return orderSegments(segments as Segment[])
  } catch {
    return []
  }
}

export function transcriptWindow(segments: readonly Segment[], seconds: number): Segment[] {
  if (segments.length === 0) return []
  const latest = Math.max(...segments.map((segment) => segment.endMs))
  const from = latest - Math.max(1, seconds) * 1000
  return segments.filter((segment) => segment.endMs >= from)
}

export function renderLive(segments: readonly Segment[], labelled: boolean): string {
  const grouped = paragraphs(segments)
  if (grouped.length === 0) return '_Todavía no hay transcripción._'
  return grouped.map((paragraph) => `[${clock(paragraph.startMs)}]${labelled ? ` ${speakerLabel(paragraph.channel)}:` : ''} ${paragraph.text}`).join('\n')
}
