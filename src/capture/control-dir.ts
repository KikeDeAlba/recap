import { rmSync } from 'node:fs'
import path from 'node:path'
import type { Meeting } from '../core/meeting.ts'
import { isAlive } from '../core/proc.ts'

export const CONTROL_DIR = 'control'

export function controlDir(dir: string): string {
  return path.join(dir, CONTROL_DIR)
}

export function recorderMayUseControl(meeting: Pick<Meeting, 'status' | 'recorderPid'>, alive: (pid: number) => boolean = isAlive): boolean {
  if (meeting.status !== 'recording' && meeting.status !== 'starting') return false
  return meeting.recorderPid === undefined || alive(meeting.recorderPid)
}

export function discardControl(meeting: Pick<Meeting, 'status' | 'recorderPid'>, dir: string, alive: (pid: number) => boolean = isAlive): boolean {
  if (recorderMayUseControl(meeting, alive)) return false
  rmSync(controlDir(dir), { recursive: true, force: true })
  return true
}
