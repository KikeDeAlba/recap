import { renameSync, rmSync } from 'node:fs'
import path from 'node:path'
import type { Config } from '../core/config.ts'
import { isoNow } from '../core/dates.ts'
import { exists, fileSize } from '../core/fsutil.ts'
import { isRecord, parseJsonSafe } from '../core/json.ts'
import { updateMeeting, type Meeting } from '../core/meeting.ts'
import { exec } from '../core/proc.ts'
import { suffix, trimmed } from '../core/text.ts'
import { requireTool } from '../core/tools.ts'
import { RecapError, errorMessage } from '../errors.ts'
import { AUDIO_FILE, VIDEO_FILE } from '../media/media.ts'
import type { Channel } from '../pipeline/transcript.ts'
import { CAPTURE_RATE } from './sources.ts'
import { hasRecording, readManifest, type CaptureManifest } from './manifest.ts'

export const ASSEMBLE_FPS = 2
export const ASSEMBLE_TOLERANCE_S = 1.5
export const ASSEMBLE_TEMPORARY = '.recording.assemble.mov'

export interface MediaFacts {
  duration: number
  audio: boolean
  video: boolean
  width: number
  height: number
}

export type AssemblePiece = { kind: 'gap'; seconds: number } | { kind: 'segment'; input: number; seconds: number; audio: boolean }

export interface AssemblePlan {
  output: typeof AUDIO_FILE | typeof VIDEO_FILE
  mic: string
  inputs: string[]
  pieces: AssemblePiece[]
  seconds: number
  width: number
  height: number
}

export interface AssembleResult {
  file: string
  channels: Channel[]
  segments: number
}

export function parseFacts(text: string): MediaFacts | null {
  const value = parseJsonSafe(text)
  if (!isRecord(value)) return null
  const streams = Array.isArray(value['streams']) ? value['streams'].filter(isRecord) : []
  const format = isRecord(value['format']) ? value['format'] : {}
  const video = streams.find((stream) => stream['codec_type'] === 'video')
  const duration = Number(format['duration'] ?? Number.NaN)
  return {
    duration: Number.isFinite(duration) ? duration : 0,
    audio: streams.some((stream) => stream['codec_type'] === 'audio'),
    video: video !== undefined,
    width: typeof video?.['width'] === 'number' ? video['width'] : 0,
    height: typeof video?.['height'] === 'number' ? video['height'] : 0,
  }
}

function even(value: number): number {
  return Math.max(2, Math.floor(value / 2) * 2)
}

function round(seconds: number): number {
  return Math.round(seconds * 1000) / 1000
}

export function planAssembly(manifest: CaptureManifest, micSeconds: number, facts: ReadonlyMap<string, MediaFacts>): AssemblePlan {
  const total = round(micSeconds)
  const inputs: string[] = []
  const pieces: AssemblePiece[] = []
  let cursor = 0
  let width = 0
  let height = 0
  const ordered = [...manifest.segments].sort((left, right) => left.startMs - right.startMs)
  for (const segment of ordered) {
    const media = facts.get(segment.file)
    if (!media || !media.video || media.duration <= 0) continue
    const start = round(Math.max(segment.startMs / 1000, cursor))
    if (start >= total) break
    const planned = segment.endMs === undefined ? Number.POSITIVE_INFINITY : segment.endMs / 1000 - start
    const seconds = round(Math.min(media.duration, planned, total - start))
    if (seconds < 0.05) continue
    if (start - cursor >= 0.001) pieces.push({ kind: 'gap', seconds: round(start - cursor) })
    if (inputs.length === 0) {
      width = even(media.width || 1280)
      height = even(media.height || 720)
    }
    pieces.push({ kind: 'segment', input: inputs.length, seconds, audio: media.audio })
    inputs.push(segment.file)
    cursor = round(start + seconds)
  }
  if (inputs.length === 0) return { output: AUDIO_FILE, mic: manifest.mic, inputs: [], pieces: [], seconds: total, width: 0, height: 0 }
  if (total - cursor >= 0.001) pieces.push({ kind: 'gap', seconds: round(total - cursor) })
  return { output: VIDEO_FILE, mic: manifest.mic, inputs, pieces, seconds: total, width, height }
}

export function videoEncoder(platform: NodeJS.Platform = process.platform): string[] {
  return platform === 'darwin' ? ['-c:v', 'h264_videotoolbox', '-b:v', '600k'] : ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '28']
}

const AUDIO_FORMAT = `aformat=sample_fmts=fltp:channel_layouts=stereo:sample_rates=${CAPTURE_RATE}`

function silence(seconds: number, label: string): string {
  return `anullsrc=r=${CAPTURE_RATE}:cl=stereo,atrim=duration=${seconds},${AUDIO_FORMAT}[${label}]`
}

export function assembleFilter(plan: AssemblePlan): string {
  const size = `${plan.width}x${plan.height}`
  const parts: string[] = []
  const labels: string[] = []
  plan.pieces.forEach((piece, index) => {
    const video = `v${index}`
    const audio = `a${index}`
    if (piece.kind === 'gap') {
      parts.push(`color=c=black:s=${size}:r=${ASSEMBLE_FPS}:d=${piece.seconds},format=yuv420p,setsar=1[${video}]`)
      parts.push(silence(piece.seconds, audio))
    } else {
      const input = piece.input + 1
      parts.push(
        `[${input}:v:0]scale=${plan.width}:${plan.height}:force_original_aspect_ratio=decrease,pad=${plan.width}:${plan.height}:(ow-iw)/2:(oh-ih)/2,setsar=1,format=yuv420p,` +
          `fps=${ASSEMBLE_FPS}:start_time=0,tpad=stop_mode=clone:stop_duration=${piece.seconds},trim=duration=${piece.seconds},setpts=PTS-STARTPTS[${video}]`,
      )
      parts.push(
        piece.audio
          ? `[${input}:a:0]aresample=${CAPTURE_RATE},${AUDIO_FORMAT},apad,atrim=duration=${piece.seconds},asetpts=PTS-STARTPTS[${audio}]`
          : silence(piece.seconds, audio),
      )
    }
    labels.push(`[${video}][${audio}]`)
  })
  parts.push(`${labels.join('')}concat=n=${plan.pieces.length}:v=1:a=1[v][system]`)
  return parts.join(';')
}

export function assembleArguments(plan: AssemblePlan, dir: string, output: string, platform: NodeJS.Platform = process.platform): string[] {
  const args = ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y', '-i', path.join(dir, plan.mic)]
  for (const input of plan.inputs) args.push('-i', path.join(dir, input))
  args.push('-filter_complex', assembleFilter(plan))
  args.push('-map', '[v]', '-map', '0:a:0', '-map', '[system]')
  args.push(...videoEncoder(platform), '-pix_fmt', 'yuv420p')
  args.push('-c:a:0', 'copy', '-c:a:1', 'aac', '-b:a:1', '96k', '-ac:a:1', '2', '-ar:a:1', String(CAPTURE_RATE))
  args.push('-disposition:a:0', 'default', '-disposition:a:1', 'default')
  args.push('-t', String(plan.seconds), '-movflags', '+faststart', '-f', 'mov', output)
  return args
}

async function probe(ffprobe: string, file: string): Promise<MediaFacts | null> {
  const result = await exec(ffprobe, ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', file]).catch(() => null)
  if (result === null || result.status !== 0) return null
  return parseFacts(result.stdout)
}

function removeSources(dir: string, manifest: CaptureManifest, keep: string): void {
  for (const name of [manifest.mic, ...manifest.segments.map((segment) => segment.file)]) {
    if (name !== keep) rmSync(path.join(dir, name), { force: true })
  }
}

export async function assembleCapture(dir: string, config: Config, platform: NodeJS.Platform = process.platform): Promise<AssembleResult | null> {
  if (hasRecording(dir)) return null
  const manifest = readManifest(dir)
  if (!manifest) return null
  const mic = path.join(dir, manifest.mic)
  if (fileSize(mic) === 0) throw new RecapError('ASSEMBLE_FAILED', `The meeting has no microphone recording (${manifest.mic})`)
  const usable = manifest.segments.filter((segment) => fileSize(path.join(dir, segment.file)) > 0)
  if (usable.length === 0) {
    renameSync(mic, path.join(dir, AUDIO_FILE))
    removeSources(dir, manifest, manifest.mic)
    return { file: path.join(dir, AUDIO_FILE), channels: ['mic'], segments: 0 }
  }
  const ffprobe = await requireTool('ffprobe', config)
  const micFacts = await probe(ffprobe, mic)
  if (!micFacts || micFacts.duration <= 0) throw new RecapError('ASSEMBLE_FAILED', `Cannot read ${manifest.mic}`)
  const facts = new Map<string, MediaFacts>()
  for (const segment of usable) {
    const found = await probe(ffprobe, path.join(dir, segment.file))
    if (found) facts.set(segment.file, found)
  }
  const plan = planAssembly(manifest, micFacts.duration, facts)
  if (plan.output === AUDIO_FILE) {
    renameSync(mic, path.join(dir, AUDIO_FILE))
    removeSources(dir, manifest, manifest.mic)
    return { file: path.join(dir, AUDIO_FILE), channels: ['mic'], segments: 0 }
  }
  const ffmpeg = await requireTool('ffmpeg', config)
  const temporary = path.join(dir, ASSEMBLE_TEMPORARY)
  rmSync(temporary, { force: true })
  try {
    const result = await exec(ffmpeg, assembleArguments(plan, dir, temporary, platform))
    if (result.status !== 0) throw new RecapError('ASSEMBLE_FAILED', suffix(trimmed(result.stderr), 500))
    const made = await probe(ffprobe, temporary)
    if (!made || !made.video || Math.abs(made.duration - plan.seconds) > ASSEMBLE_TOLERANCE_S) {
      throw new RecapError('ASSEMBLE_FAILED', `The assembled recording lasts ${made?.duration.toFixed(1) ?? '?'}s instead of ${plan.seconds.toFixed(1)}s`)
    }
    renameSync(temporary, path.join(dir, VIDEO_FILE))
  } catch (error) {
    rmSync(temporary, { force: true })
    throw error
  }
  removeSources(dir, manifest, '')
  return { file: path.join(dir, VIDEO_FILE), channels: ['mic', 'system'], segments: plan.inputs.length }
}

export function assembledChannels(dir: string): Channel[] {
  return exists(path.join(dir, VIDEO_FILE)) ? ['mic', 'system'] : ['mic']
}

export async function assembleMeeting(dir: string, config: Config, platform: NodeJS.Platform = process.platform): Promise<Meeting> {
  try {
    const result = await assembleCapture(dir, config, platform)
    return updateMeeting(dir, (meeting) => {
      if (result) meeting.channels = result.channels
      else if (!Array.isArray(meeting.channels)) meeting.channels = assembledChannels(dir)
      meeting.stages['assemble'] = { status: 'done', updatedAt: isoNow() }
    })
  } catch (error) {
    const message = errorMessage(error)
    updateMeeting(dir, (meeting) => {
      meeting.stages['assemble'] = { status: 'failed', updatedAt: isoNow(), error: message }
    })
    throw error instanceof RecapError ? error : new RecapError('ASSEMBLE_FAILED', message)
  }
}
