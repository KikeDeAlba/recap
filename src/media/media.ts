import { lstatSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { exists } from '../core/fsutil.ts'
import { recordingPath, type MeetingMode } from '../core/meeting.ts'
import { LIVE_DIR, liveFiles } from '../live/files.ts'

export const VIDEO_FILE = 'recording.mov'
export const AUDIO_FILE = 'recording.m4a'
export const INTERMEDIATE_FILES = ['mic.wav', 'system.wav', 'transcript-mic.json', 'transcript-system.json']
export const FRAMES_DIR = 'frames'

export function hasVideo(dir: string, mode: MeetingMode): boolean {
  const file = recordingPath(dir, mode)
  return path.basename(file) === VIDEO_FILE && exists(file)
}

export function pathSize(file: string): number {
  let info
  try {
    info = lstatSync(file)
  } catch {
    return 0
  }
  if (info.isSymbolicLink()) return 0
  if (!info.isDirectory()) return info.size
  let total = 0
  let children: string[] = []
  try {
    children = readdirSync(file)
  } catch {
    return 0
  }
  for (const child of children) total += pathSize(path.join(file, child))
  return total
}

export interface MeetingStorage {
  recordingBytes: number
  intermediateBytes: number
  framesBytes: number
  otherBytes: number
  totalBytes: number
}

export function measureStorage(dir: string, mode: MeetingMode): MeetingStorage {
  const storage: MeetingStorage = { recordingBytes: 0, intermediateBytes: 0, framesBytes: 0, otherBytes: 0, totalBytes: 0 }
  const recording = path.basename(recordingPath(dir, mode))
  let entries: string[] = []
  try {
    entries = readdirSync(dir)
  } catch {
    return storage
  }
  for (const name of entries) {
    const bytes = pathSize(path.join(dir, name))
    storage.totalBytes += bytes
    if (name === recording) storage.recordingBytes += bytes
    else if (INTERMEDIATE_FILES.includes(name)) storage.intermediateBytes += bytes
    else if (name === FRAMES_DIR) storage.framesBytes += bytes
    else if (name === LIVE_DIR) {
      const chunks = pathSize(liveFiles.chunks(dir))
      storage.intermediateBytes += chunks
      storage.otherBytes += bytes - chunks
    } else storage.otherBytes += bytes
  }
  return storage
}

export type VideoPreset = 'light' | 'medium' | 'max'
export const VIDEO_PRESETS: VideoPreset[] = ['light', 'medium', 'max']

const PRESETS: Record<VideoPreset, { width: number; frameRate: string; videoBitrate: string }> = {
  light: { width: 1280, frameRate: '2', videoBitrate: '250k' },
  medium: { width: 960, frameRate: '1', videoBitrate: '140k' },
  max: { width: 720, frameRate: '0.5', videoBitrate: '70k' },
}

export function presetParameters(preset: VideoPreset): { width: number; frameRate: string; videoBitrate: string; durationTolerance: number } {
  const base = PRESETS[preset]
  return { ...base, durationTolerance: 1 + 1 / (Number(base.frameRate) || 1) }
}

export function hevcEncoder(platform: NodeJS.Platform = process.platform): string[] {
  return platform === 'darwin' ? ['-c:v', 'hevc_videotoolbox'] : ['-c:v', 'libx265', '-preset', 'medium']
}

export function presetVideoArguments(preset: VideoPreset, platform: NodeJS.Platform = process.platform): string[] {
  const p = PRESETS[preset]
  return [...hevcEncoder(platform), '-tag:v', 'hvc1', '-vf', `fps=${p.frameRate},scale='min(${p.width},iw)':-2`, '-b:v', p.videoBitrate]
}
