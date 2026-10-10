import path from 'node:path'
import type { Config } from '../core/config.ts'
import { isRecord, parseJsonSafe } from '../core/json.ts'
import { exec } from '../core/proc.ts'
import { requireTool } from '../core/tools.ts'
import { RecapError } from '../errors.ts'

export interface MediaInfo {
  duration: number
  audioTracks: number
  enabledAudioTracks: number
  videoTracks: number
  creationTime?: string | undefined
}

export function parseProbe(text: string): MediaInfo {
  const value = parseJsonSafe(text)
  if (!isRecord(value)) throw new Error('ffprobe returned no JSON')
  const streams = Array.isArray(value['streams']) ? value['streams'].filter(isRecord) : []
  const format = isRecord(value['format']) ? value['format'] : {}
  const audio = streams.filter((stream) => stream['codec_type'] === 'audio')
  const video = streams.filter((stream) => stream['codec_type'] === 'video' && !(isRecord(stream['disposition']) && stream['disposition']['attached_pic'] === 1))
  const enabled = audio.filter((stream) => !isRecord(stream['disposition']) || stream['disposition']['default'] !== 0).length
  const tags = isRecord(format['tags']) ? format['tags'] : {}
  const creation = typeof tags['creation_time'] === 'string' ? tags['creation_time'] : undefined
  return {
    duration: Number(format['duration'] ?? Number.NaN),
    audioTracks: audio.length,
    enabledAudioTracks: enabled,
    videoTracks: video.length,
    creationTime: creation,
  }
}

export async function inspectMedia(file: string, config: Config): Promise<MediaInfo> {
  const ffprobe = await requireTool('ffprobe', config)
  const result = await exec(ffprobe, ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', file])
  if (result.status !== 0) throw new RecapError('MEDIA_UNREADABLE', `Cannot read ${path.basename(file)}: ${result.stderr.trim()}`)
  try {
    return parseProbe(result.stdout)
  } catch (error) {
    throw new RecapError('MEDIA_UNREADABLE', `Cannot read ${path.basename(file)}: ${error instanceof Error ? error.message : String(error)}`)
  }
}

export function verifyMedia(original: MediaInfo, output: MediaInfo, expectVideo: boolean, tolerance = 1): void {
  if (!Number.isFinite(output.duration) || Math.abs(output.duration - original.duration) > tolerance) {
    throw new RecapError('VERIFY_FAILED', `The new file lasts ${output.duration.toFixed(1)}s instead of ${original.duration.toFixed(1)}s`)
  }
  if (output.audioTracks !== original.audioTracks) {
    throw new RecapError('VERIFY_FAILED', `The new file has ${output.audioTracks} audio tracks instead of ${original.audioTracks}`)
  }
  if (output.enabledAudioTracks !== output.audioTracks) {
    throw new RecapError('VERIFY_FAILED', `Only ${output.enabledAudioTracks} of ${output.audioTracks} audio tracks are enabled in the new file`)
  }
  if (output.videoTracks > 0 !== expectVideo) {
    throw new RecapError('VERIFY_FAILED', expectVideo ? 'The new file has no video track' : 'The new file still has a video track')
  }
}
