import { mkdirSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'
import { RecapError, errorMessage } from '../errors.ts'
import type { Config } from './config.ts'
import { rootDir } from './config.ts'
import { idStamp, isoDate, isoNow, parseDate } from './dates.ts'
import { exists, readText, writeAtomic } from './fsutil.ts'
import { isRecord, swiftPretty } from './json.ts'
import { isAlive } from './proc.ts'
import { slug } from './text.ts'

export type MeetingMode = 'remote' | 'in-person'
export type MeetingStatus = 'starting' | 'recording' | 'recorded' | 'failed' | 'processing' | 'processed'

export const MEETING_MODES: MeetingMode[] = ['remote', 'in-person']

export function recordingFileName(mode: MeetingMode): string {
  return mode === 'remote' ? 'recording.mov' : 'recording.m4a'
}

export interface BitaEntrySnapshot {
  title: string
  projectName?: string | undefined
  kind?: string | undefined
  pageIds: number[]
}

export interface Wrapup {
  title?: string | undefined
  titleChanged: boolean
  project?: string | undefined
  projectResolved: boolean
  pageId?: number | undefined
  pageCreated: boolean
  backlogKeys: Record<string, string>
}

export function emptyWrapup(): Wrapup {
  return { titleChanged: false, projectResolved: false, pageCreated: false, backlogKeys: {} }
}

export interface VideoCompression {
  compressedAt: string
  preset: string
  originalBytes: number
}

export interface StageState {
  status: string
  updatedAt: string
  error?: string | undefined
  reason?: string | undefined
  hint?: string | undefined
}

export interface Meeting {
  schemaVersion: number
  id: string
  title: string
  mode: MeetingMode
  status: MeetingStatus
  createdAt: string
  startedAt?: string | undefined
  endedAt?: string | undefined
  recorderPid?: number | undefined
  display?: number | undefined
  bitaEntryId?: number | undefined
  bitaDatabasePath?: string | undefined
  bitaDocsRoot?: string | undefined
  bitaEntry?: BitaEntrySnapshot | undefined
  wrapup?: Wrapup | undefined
  error?: string | undefined
  stages: Record<string, StageState>
  video?: VideoCompression | undefined
  videoRemovedAt?: string | undefined
  [key: string]: unknown
}

export interface BitaTarget {
  databasePath?: string | undefined
  docsRoot?: string | undefined
}

export const MEETING_FILE = 'meeting.json'

export function durationSeconds(meeting: Meeting, now: Date = new Date()): number | undefined {
  const started = parseDate(meeting.startedAt)
  if (!started) return undefined
  const ended = parseDate(meeting.endedAt) ?? now
  return Math.trunc((ended.getTime() - started.getTime()) / 1000)
}

function validMeeting(value: unknown): value is Meeting {
  if (!isRecord(value)) return false
  return (
    typeof value['id'] === 'string' &&
    typeof value['title'] === 'string' &&
    (value['mode'] === 'remote' || value['mode'] === 'in-person') &&
    typeof value['status'] === 'string' &&
    ['starting', 'recording', 'recorded', 'failed', 'processing', 'processed'].includes(value['status']) &&
    typeof value['createdAt'] === 'string' &&
    parseDate(value['createdAt']) !== null
  )
}

export function decodeMeeting(text: string): Meeting {
  const value = JSON.parse(text) as unknown
  if (!validMeeting(value)) throw new Error('the meeting file is missing required fields')
  const meeting = value
  meeting.schemaVersion = typeof meeting.schemaVersion === 'number' ? meeting.schemaVersion : 1
  meeting.stages = isRecord(meeting.stages) ? (meeting.stages as Record<string, StageState>) : {}
  for (const [key, item] of Object.entries(meeting)) if (item === null) delete meeting[key]
  if (meeting.wrapup) meeting.wrapup = { ...emptyWrapup(), ...meeting.wrapup }
  if (meeting.bitaEntry) meeting.bitaEntry = { ...meeting.bitaEntry, pageIds: Array.isArray(meeting.bitaEntry.pageIds) ? meeting.bitaEntry.pageIds : [] }
  return meeting
}

export function loadMeeting(dir: string): Meeting {
  const file = path.join(dir, MEETING_FILE)
  const text = readText(file)
  try {
    if (text === null) throw new Error('no such file')
    return decodeMeeting(text)
  } catch (error) {
    throw new RecapError('MEETING_UNREADABLE', `Cannot read ${file}: ${errorMessage(error)}`)
  }
}

export function encodeMeeting(meeting: Meeting): string {
  return swiftPretty({ ...meeting, schemaVersion: meeting.schemaVersion ?? 1, stages: meeting.stages ?? {} })
}

export function saveMeeting(meeting: Meeting, dir: string): void {
  writeAtomic(path.join(dir, MEETING_FILE), encodeMeeting(meeting))
}

export function updateMeeting(dir: string, change: (meeting: Meeting) => void): Meeting {
  const meeting = loadMeeting(dir)
  change(meeting)
  saveMeeting(meeting, dir)
  return meeting
}

export function recordingPath(dir: string, mode: MeetingMode): string {
  const primary = path.join(dir, recordingFileName(mode))
  if (mode !== 'remote' || exists(primary)) return primary
  const audio = path.join(dir, 'recording.m4a')
  return exists(audio) ? audio : primary
}

export function isActiveStatus(status: MeetingStatus): boolean {
  return status === 'recording' || status === 'starting'
}

export function reconcile(meeting: Meeting, dir: string): Meeting {
  if (!isActiveStatus(meeting.status)) return meeting
  if (meeting.recorderPid !== undefined && isAlive(meeting.recorderPid)) return meeting
  const created = parseDate(meeting.createdAt)
  if (meeting.recorderPid === undefined && meeting.status === 'starting' && created && Date.now() - created.getTime() < 300_000) return meeting
  let size = 0
  let modified: Date | null = null
  try {
    const info = statSync(recordingPath(dir, meeting.mode))
    size = info.size
    modified = info.mtime
  } catch {
    size = 0
  }
  try {
    return updateMeeting(dir, (current) => {
      current.status = size > 0 && current.startedAt !== undefined ? 'recorded' : 'failed'
      current.endedAt = modified ? isoDate(modified) : isoNow()
      delete current.recorderPid
      current.error = 'The recorder exited without closing the file cleanly'
    })
  } catch {
    return meeting
  }
}

export interface Located {
  meeting: Meeting
  dir: string
}

export class MeetingStore {
  readonly root: string

  constructor(config: Config) {
    this.root = rootDir(config)
  }

  create(options: { title: string; mode: MeetingMode; display?: number | undefined; bitaEntryId?: number | undefined; bita?: BitaTarget | undefined; now?: Date }): Located {
    mkdirSync(this.root, { recursive: true })
    const now = options.now ?? new Date()
    const base = `${idStamp(now)}-${slug(options.title)}`
    let id = base
    let suffix = 2
    while (exists(path.join(this.root, id))) {
      id = `${base}-${suffix}`
      suffix += 1
    }
    const dir = path.join(this.root, id)
    mkdirSync(dir, { recursive: true })
    const meeting: Meeting = {
      schemaVersion: 1,
      id,
      title: options.title,
      mode: options.mode,
      status: 'starting',
      createdAt: isoDate(now),
      display: options.display,
      bitaEntryId: options.bitaEntryId,
      bitaDatabasePath: options.bita?.databasePath,
      bitaDocsRoot: options.bita?.docsRoot,
      stages: {},
    }
    saveMeeting(meeting, dir)
    return { meeting, dir }
  }

  all(): Located[] {
    let names: string[]
    try {
      names = readdirSync(this.root)
    } catch {
      return []
    }
    const found: Located[] = []
    for (const name of names) {
      const dir = path.join(this.root, name)
      try {
        found.push({ meeting: reconcile(loadMeeting(dir), dir), dir })
      } catch {
        continue
      }
    }
    return found.sort((left, right) => (parseDate(right.meeting.createdAt)?.getTime() ?? 0) - (parseDate(left.meeting.createdAt)?.getTime() ?? 0))
  }

  resolve(reference: string | undefined | null): Located {
    const meetings = this.all()
    if (!reference || reference === 'last') {
      const latest = meetings[0]
      if (!latest) throw new RecapError('NO_MEETINGS', `No meetings in ${this.root}`)
      return latest
    }
    const exact = meetings.find((item) => item.meeting.id === reference)
    if (exact) return exact
    const matches = meetings.filter((item) => item.meeting.id.includes(reference))
    if (matches.length === 1 && matches[0]) return matches[0]
    if (matches.length === 0) throw new RecapError('MEETING_NOT_FOUND', `No meeting matches "${reference}"`)
    throw new RecapError('MEETING_AMBIGUOUS', `"${reference}" matches ${matches.length} meetings`)
  }

  find(bitaEntryId: number): Located | null {
    return this.all().find((item) => item.meeting.bitaEntryId === bitaEntryId) ?? null
  }
}

export function resolveTarget(store: MeetingStore, reference: string | undefined, bitaEntryId: number | undefined): Located {
  if (bitaEntryId !== undefined) {
    const found = store.find(bitaEntryId)
    if (!found) throw new RecapError('MEETING_NOT_FOUND', `No meeting is linked to bita entry ${bitaEntryId}`)
    return found
  }
  if (reference === undefined) throw new RecapError('MEETING_REQUIRED', 'Pass the meeting id, a unique part of it, "last" or --bita-entry')
  return store.resolve(reference)
}
