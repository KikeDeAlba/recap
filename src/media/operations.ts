import { renameSync, rmSync } from 'node:fs'
import path from 'node:path'
import type { Config } from '../core/config.ts'
import { isoNow } from '../core/dates.ts'
import { ProcessLock, lockOwner } from '../core/lock.ts'
import { isActiveStatus, loadMeeting, updateMeeting, type Meeting } from '../core/meeting.ts'
import { exec, isAlive } from '../core/proc.ts'
import { formatBytes, suffix, trimmed } from '../core/text.ts'
import { requireTool } from '../core/tools.ts'
import { RecapError } from '../errors.ts'
import { liveFiles } from '../live/files.ts'
import { AUDIO_FILE, INTERMEDIATE_FILES, VIDEO_FILE, hasVideo, pathSize, presetParameters, presetVideoArguments, type VideoPreset } from './media.ts'
import { inspectMedia, verifyMedia, type MediaInfo } from './probe.ts'

export interface DeletedMeeting {
  id: string
  dir: string
  freedBytes: number
}

export function requireIdle(meeting: Meeting): void {
  if (isActiveStatus(meeting.status)) throw new RecapError('MEETING_ACTIVE', `"${meeting.title}" is still being recorded`)
}

export function removeIntermediates(dir: string): void {
  for (const name of INTERMEDIATE_FILES) rmSync(path.join(dir, name), { force: true })
  rmSync(liveFiles.chunks(dir), { recursive: true, force: true })
}

export function enableAudio(info: Pick<MediaInfo, 'audioTracks'>): string[] {
  return Array.from({ length: info.audioTracks }, (_, index) => [`-disposition:a:${index}`, 'default']).flat()
}

function requireVideo(meeting: Meeting, dir: string): void {
  if (meeting.mode !== 'remote') throw new RecapError('NOT_REMOTE', `"${meeting.title}" is an in-person meeting and has no video`)
  requireIdle(meeting)
  if (!hasVideo(dir, meeting.mode)) throw new RecapError('NO_VIDEO', `"${meeting.title}" has no ${VIDEO_FILE}`)
}

function replace(temporary: string, target: string): void {
  try {
    renameSync(temporary, target)
  } catch (error) {
    rmSync(temporary, { force: true })
    throw new RecapError('RENAME_FAILED', `Cannot move ${path.basename(temporary)} to ${path.basename(target)}: ${(error as Error).message}`)
  }
}

async function transcode(config: Config, source: string, temporary: string, original: MediaInfo, expectVideo: boolean, tolerance: number, args: string[]): Promise<void> {
  const ffmpeg = await requireTool('ffmpeg', config)
  rmSync(temporary, { force: true })
  try {
    const result = await exec(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y', '-i', source, ...args, '-movflags', '+faststart', temporary])
    if (result.status !== 0) throw new RecapError('FFMPEG_FAILED', suffix(trimmed(result.stderr), 500))
    verifyMedia(original, await inspectMedia(temporary, config), expectVideo, tolerance)
  } catch (error) {
    rmSync(temporary, { force: true })
    throw error
  }
}

export async function stripVideo(config: Config, meeting: Meeting, dir: string, pruneIntermediates: boolean): Promise<Meeting> {
  requireVideo(meeting, dir)
  const lock = new ProcessLock(path.join(dir, 'process.lock'))
  try {
    const source = path.join(dir, VIDEO_FILE)
    const target = path.join(dir, AUDIO_FILE)
    const temporary = path.join(dir, '.recording-strip.m4a')
    const original = await inspectMedia(source, config)
    await transcode(config, source, temporary, original, false, 1, ['-map', '0:a', '-c', 'copy', ...enableAudio(original), '-f', 'mp4'])
    replace(temporary, target)
    rmSync(source, { force: true })
    if (pruneIntermediates) removeIntermediates(dir)
    return updateMeeting(dir, (current) => {
      current.videoRemovedAt = isoNow()
    })
  } finally {
    lock.release()
  }
}

export async function compressVideo(config: Config, meeting: Meeting, dir: string, preset: VideoPreset, pruneIntermediates: boolean): Promise<Meeting> {
  requireVideo(meeting, dir)
  const lock = new ProcessLock(path.join(dir, 'process.lock'))
  try {
    const source = path.join(dir, VIDEO_FILE)
    const temporary = path.join(dir, '.recording-compress.mov')
    const original = await inspectMedia(source, config)
    const originalBytes = pathSize(source)
    await transcode(config, source, temporary, original, true, presetParameters(preset).durationTolerance, [
      '-map',
      '0:v:0',
      '-map',
      '0:a',
      ...presetVideoArguments(preset),
      '-c:a',
      'copy',
      ...enableAudio(original),
      '-f',
      'mov',
    ])
    const compressedBytes = pathSize(temporary)
    if (compressedBytes >= originalBytes) {
      rmSync(temporary, { force: true })
      throw new RecapError('NOT_SMALLER', `The ${preset} preset produced ${formatBytes(compressedBytes)}, not smaller than ${formatBytes(originalBytes)}; the original was kept`)
    }
    replace(temporary, source)
    if (pruneIntermediates) removeIntermediates(dir)
    return updateMeeting(dir, (current) => {
      current.video = { compressedAt: isoNow(), preset, originalBytes: current.video?.originalBytes ?? originalBytes }
    })
  } finally {
    lock.release()
  }
}

export function pruneMeeting(meeting: Meeting, dir: string): Meeting {
  requireIdle(meeting)
  const lock = new ProcessLock(path.join(dir, 'process.lock'))
  try {
    removeIntermediates(dir)
    return loadMeeting(dir)
  } finally {
    lock.release()
  }
}

export function deleteMeeting(meeting: Meeting, dir: string): DeletedMeeting {
  requireIdle(meeting)
  const pid = lockOwner(path.join(dir, 'process.lock'))
  if (pid !== null && pid !== process.pid && isAlive(pid)) throw new RecapError('MEETING_ACTIVE', `"${meeting.title}" is being processed (pid ${pid})`)
  const freed = pathSize(dir)
  rmSync(dir, { recursive: true, force: true })
  return { id: meeting.id, dir, freedBytes: freed }
}
