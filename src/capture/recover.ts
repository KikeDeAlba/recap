import { spawnSync } from 'node:child_process'
import { rmSync, statSync } from 'node:fs'
import path from 'node:path'
import { loadConfig } from '../core/config.ts'
import { exists } from '../core/fsutil.ts'
import type { MeetingMode } from '../core/meeting.ts'
import { expandTilde } from '../core/paths.ts'
import type { Channel } from '../pipeline/transcript.ts'
import { CAPTURE_DIR, captureChannels, intermediateFile, muxArguments } from './sources.ts'

export const RECOVERED_FILE = 'recording.m4a'

export interface Recovery {
  file: string
  channels: Channel[]
  missing: Channel[]
}

function nonEmpty(file: string): boolean {
  try {
    return statSync(file).size > 0
  } catch {
    return false
  }
}

export function findFfmpegSync(env: NodeJS.ProcessEnv = process.env): string | null {
  let configured: string | undefined
  try {
    configured = loadConfig().tools?.['ffmpeg']
  } catch {
    configured = undefined
  }
  if (configured && exists(expandTilde(configured))) return expandTilde(configured)
  const names = process.platform === 'win32' ? ['ffmpeg.exe'] : ['ffmpeg']
  const dirs = [...(env['PATH'] ?? '').split(path.delimiter), '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin']
  for (const dir of dirs) {
    if (dir.length === 0) continue
    for (const name of names) if (exists(path.join(dir, name))) return path.join(dir, name)
  }
  return null
}

export function recoverCapture(dir: string, mode: MeetingMode, ffmpeg: string | null = findFfmpegSync()): Recovery | null {
  const output = path.join(dir, RECOVERED_FILE)
  if (exists(output) || !exists(path.join(dir, CAPTURE_DIR))) return null
  const expected = captureChannels(mode)
  const channels = expected.filter((channel) => nonEmpty(intermediateFile(dir, channel)))
  if (channels.length === 0 || !ffmpeg) return null
  const result = spawnSync(ffmpeg, muxArguments(channels.map((channel) => intermediateFile(dir, channel)), output), { stdio: 'ignore', windowsHide: true, timeout: 120_000 })
  if (result.status !== 0 || !nonEmpty(output)) {
    rmSync(output, { force: true })
    return null
  }
  const missing = expected.filter((channel) => !channels.includes(channel))
  if (missing.length === 0) rmSync(path.join(dir, CAPTURE_DIR), { recursive: true, force: true })
  return { file: output, channels, missing }
}

export function recoveryNote(recovery: Recovery): string {
  const missing = recovery.missing.length > 0 ? `; the ${recovery.missing.join(' and ')} track is missing` : ''
  return `The recorder exited without finishing; recovered ${path.basename(recovery.file)} from ${CAPTURE_DIR}/ with ${recovery.channels.join(' and ')}${missing}`
}
