import { rmSync } from 'node:fs'
import { activeFile } from './paths.ts'
import { readText, writeAtomic } from './fsutil.ts'
import { isRecord, swiftPretty } from './json.ts'
import { isActiveStatus, loadMeeting, reconcile, type Meeting, type MeetingMode } from './meeting.ts'

export interface ActiveRecording {
  meetingId: string
  dir: string
  mode: MeetingMode
  startedAt: string
}

export function loadActive(): ActiveRecording | null {
  const text = readText(activeFile())
  if (text === null) return null
  try {
    const value = JSON.parse(text) as unknown
    if (!isRecord(value) || typeof value['meetingId'] !== 'string' || typeof value['dir'] !== 'string' || typeof value['startedAt'] !== 'string') return null
    if (value['mode'] !== 'remote' && value['mode'] !== 'in-person') return null
    return { meetingId: value['meetingId'], dir: value['dir'], mode: value['mode'], startedAt: value['startedAt'] }
  } catch {
    return null
  }
}

export function saveActive(active: ActiveRecording): void {
  writeAtomic(activeFile(), swiftPretty(active))
}

export function clearActive(): void {
  rmSync(activeFile(), { force: true })
}

export function currentRecording(): { active: ActiveRecording; meeting: Meeting } | null {
  const active = loadActive()
  if (!active) return null
  let stored: Meeting
  try {
    stored = loadMeeting(active.dir)
  } catch {
    clearActive()
    return null
  }
  const meeting = reconcile(stored, active.dir)
  if (!isActiveStatus(meeting.status)) {
    clearActive()
    return null
  }
  return { active, meeting }
}
