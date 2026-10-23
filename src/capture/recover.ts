import { spawnSync } from 'node:child_process'
import { rmSync, statSync } from 'node:fs'
import path from 'node:path'
import { loadConfig } from '../core/config.ts'
import { exists } from '../core/fsutil.ts'
import type { Meeting, MeetingMode } from '../core/meeting.ts'
import { expandTilde } from '../core/paths.ts'
import type { Channel } from '../pipeline/transcript.ts'
import { CAPTURE_DIR, CAPTURE_RATE, captureChannels, channelCount, encoderBitrate, intermediateFile, muxArguments } from './sources.ts'

export const RECOVERED_FILE = 'recording.m4a'

export interface Recovery {
  file: string
  channels: Channel[]
  synthetic: Channel[]
}

export function recoveryArguments(dir: string, expected: readonly Channel[], present: readonly Channel[], output: string): string[] {
  if (present.length === expected.length) return muxArguments(present.map((channel) => intermediateFile(dir, channel)), output)
  const args = ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y']
  const codecs: string[] = []
  expected.forEach((channel, index) => {
    if (present.includes(channel)) {
      args.push('-i', intermediateFile(dir, channel))
      codecs.push(`-c:a:${index}`, 'copy')
    } else {
      args.push('-f', 'lavfi', '-i', `anullsrc=r=${CAPTURE_RATE}:cl=${channelCount(channel) === 1 ? 'mono' : 'stereo'}`)
      codecs.push(`-c:a:${index}`, 'aac', `-b:a:${index}`, encoderBitrate(channel), `-ac:a:${index}`, String(channelCount(channel)), `-ar:a:${index}`, String(CAPTURE_RATE))
    }
  })
  expected.forEach((_, index) => args.push('-map', `${index}:a:0`))
  args.push(...codecs, '-shortest', '-movflags', '+faststart', output)
  return args
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
  const result = spawnSync(ffmpeg, recoveryArguments(dir, expected, channels, output), { stdio: 'ignore', windowsHide: true, timeout: 120_000 })
  if (result.status !== 0 || !nonEmpty(output)) {
    rmSync(output, { force: true })
    return null
  }
  rmSync(path.join(dir, CAPTURE_DIR), { recursive: true, force: true })
  return { file: output, channels, synthetic: expected.filter((channel) => !channels.includes(channel)) }
}

export function recoveryNote(recovery: Recovery): string {
  const missing = recovery.synthetic.length > 0 ? `; the ${recovery.synthetic.join(' and ')} track is synthetic silence` : ''
  return `The recorder exited without finishing; recovered ${path.basename(recovery.file)} from ${CAPTURE_DIR}/ with ${recovery.channels.join(' and ')}${missing}`
}

export function applyRecovery(meeting: Meeting, recovery: Recovery | null): void {
  if (!recovery) return
  meeting.error = recoveryNote(recovery)
  if (recovery.synthetic.length > 0) meeting['syntheticTracks'] = recovery.synthetic
}
