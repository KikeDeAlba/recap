import path from 'node:path'
import { exists, fileSize, readText } from '../core/fsutil.ts'
import { isRecord, parseJsonSafe } from '../core/json.ts'

export const CAPTURE_MANIFEST = 'capture.json'
export const MIC_FILE = 'mic.m4a'
export const RECORDING_FILES = ['recording.m4a', 'recording.mov'] as const

export type TargetKind = 'display' | 'window'

export interface CaptureTarget {
  kind: TargetKind
  id: number
}

export interface CaptureVideo {
  kind: TargetKind
  id: number
  title: string
  app: string | null
  since: string
}

export interface CaptureSegment {
  file: string
  startMs: number
  endMs?: number | undefined
}

export interface CaptureManifest {
  mic: string
  startedAt?: string | undefined
  endedAt?: string | undefined
  video: CaptureVideo | null
  segments: CaptureSegment[]
  error?: string | undefined
}

export function isTargetKind(value: unknown): value is TargetKind {
  return value === 'display' || value === 'window'
}

function safeFile(value: unknown): string | null {
  if (typeof value !== 'string' || value.length === 0 || value !== path.basename(value) || value.startsWith('.')) return null
  return value
}

function count(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.trunc(value) : undefined
}

export function decodeVideo(value: unknown): CaptureVideo | null {
  if (!isRecord(value) || !isTargetKind(value['kind'])) return null
  const id = count(value['id'])
  if (id === undefined || typeof value['title'] !== 'string' || typeof value['since'] !== 'string') return null
  return { kind: value['kind'], id, title: value['title'], app: typeof value['app'] === 'string' ? value['app'] : null, since: value['since'] }
}

export function decodeManifest(text: string): CaptureManifest | null {
  const value = parseJsonSafe(text)
  if (!isRecord(value)) return null
  const mic = safeFile(value['mic']) ?? MIC_FILE
  const segments = (Array.isArray(value['segments']) ? value['segments'] : []).flatMap((item): CaptureSegment[] => {
    if (!isRecord(item)) return []
    const file = safeFile(item['file'])
    const startMs = count(item['startMs'])
    if (file === null || startMs === undefined) return []
    return [{ file, startMs, endMs: count(item['endMs']) }]
  })
  return {
    mic,
    startedAt: typeof value['startedAt'] === 'string' ? value['startedAt'] : undefined,
    endedAt: typeof value['endedAt'] === 'string' ? value['endedAt'] : undefined,
    video: decodeVideo(value['video']),
    segments,
    error: typeof value['error'] === 'string' ? value['error'] : undefined,
  }
}

export function readManifest(dir: string): CaptureManifest | null {
  const text = readText(path.join(dir, CAPTURE_MANIFEST))
  return text === null ? null : decodeManifest(text)
}

export function hasRecording(dir: string): boolean {
  return RECORDING_FILES.some((name) => exists(path.join(dir, name)))
}

export function pendingCaptureBytes(dir: string, mode: string): number {
  if (mode !== 'meeting' || hasRecording(dir)) return 0
  const manifest = readManifest(dir)
  return manifest ? fileSize(path.join(dir, manifest.mic)) : 0
}

export function needsAssembly(dir: string, mode: string): boolean {
  return pendingCaptureBytes(dir, mode) > 0
}
