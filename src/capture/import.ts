import { rmSync, statSync } from 'node:fs'
import path from 'node:path'
import type { Config } from '../core/config.ts'
import { isoDate } from '../core/dates.ts'
import { MeetingStore, updateMeeting, type Located, type MeetingMode } from '../core/meeting.ts'
import { exec } from '../core/proc.ts'
import { suffix, trimmed } from '../core/text.ts'
import { requireTool } from '../core/tools.ts'
import { RecapError } from '../errors.ts'
import { AUDIO_FILE, VIDEO_FILE } from '../media/media.ts'
import { inspectMedia, type MediaInfo } from '../media/probe.ts'

export function importMode(info: MediaInfo, requested?: MeetingMode): MeetingMode {
  if (requested === 'remote' && info.audioTracks < 2) {
    throw new RecapError('IMPORT_UNSUITABLE', 'A remote meeting needs two audio tracks (microphone and call audio); import it as --in-person')
  }
  if (requested) return requested
  return info.videoTracks > 0 && info.audioTracks >= 2 ? 'remote' : 'in-person'
}

export function importArguments(source: string, mode: MeetingMode, target: string): string[] {
  const base = ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y', '-i', source]
  if (mode === 'remote') return [...base, '-map', '0:v:0', '-map', '0:a', '-c', 'copy', '-f', 'mov', target]
  return [...base, '-vn', '-map', '0:a:0', '-c:a', 'aac', '-b:a', '128k', '-f', 'mp4', target]
}

export function importTimes(info: MediaInfo, file: string): { startedAt: Date; endedAt: Date } {
  const duration = Number.isFinite(info.duration) ? info.duration : 0
  const tagged = info.creationTime ? Date.parse(info.creationTime) : Number.NaN
  let started: number
  if (!Number.isNaN(tagged) && tagged > 0) started = tagged
  else {
    let modified = Date.now()
    try {
      modified = statSync(file).mtimeMs
    } catch {
      modified = Date.now()
    }
    started = modified - duration * 1000
  }
  const startedAt = new Date(Math.round(started / 1000) * 1000)
  return { startedAt, endedAt: new Date(startedAt.getTime() + Math.round(duration) * 1000) }
}

export async function importRecording(config: Config, file: string, options: { title?: string | undefined; mode?: MeetingMode | undefined }): Promise<Located> {
  const source = path.resolve(file)
  try {
    if (!statSync(source).isFile()) throw new Error('not a file')
  } catch {
    throw new RecapError('FILE_NOT_FOUND', `${file} is not a readable file`)
  }
  const info = await inspectMedia(source, config)
  if (info.audioTracks === 0) throw new RecapError('IMPORT_UNSUITABLE', `${path.basename(source)} has no audio track`)
  const mode = importMode(info, options.mode)
  const ffmpeg = await requireTool('ffmpeg', config)
  const { startedAt, endedAt } = importTimes(info, source)
  const title = options.title && trimmed(options.title).length > 0 ? trimmed(options.title) : path.basename(source, path.extname(source))
  const created = new MeetingStore(config).create({ title, mode, now: startedAt })
  try {
    const target = path.join(created.dir, mode === 'remote' ? VIDEO_FILE : AUDIO_FILE)
    const result = await exec(ffmpeg, importArguments(source, mode, target))
    if (result.status !== 0) throw new RecapError('FFMPEG_FAILED', suffix(trimmed(result.stderr), 500))
    const meeting = updateMeeting(created.dir, (item) => {
      item.status = 'recorded'
      item.startedAt = isoDate(startedAt)
      item.endedAt = isoDate(endedAt)
      item['importedFrom'] = source
    })
    return { meeting, dir: created.dir }
  } catch (error) {
    rmSync(created.dir, { recursive: true, force: true })
    throw error
  }
}
