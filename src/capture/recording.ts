import { rmSync } from 'node:fs'
import type { Config } from '../core/config.ts'
import { loadConfig } from '../core/config.ts'
import { clearActive, currentRecording, loadActive, saveActive } from '../core/active.ts'
import { isoNow } from '../core/dates.ts'
import { exists } from '../core/fsutil.ts'
import { MeetingStore, isActiveStatus, loadMeeting, recordingPath, updateMeeting, type BitaTarget, type Located, type Meeting, type MeetingMode } from '../core/meeting.ts'
import { isAlive, signalProcess, waitUntil } from '../core/proc.ts'
import { RecapError } from '../errors.ts'
import { launchRecorder } from './capture.ts'
import path from 'node:path'

export function defaultTitle(mode: MeetingMode): string {
  return mode === 'remote' ? 'Remote meeting' : 'In-person meeting'
}

export async function startRecording(options: {
  title: string
  mode: MeetingMode
  display?: number | undefined
  bitaEntryId?: number | undefined
  bita?: BitaTarget | undefined
  timeout: number
  config?: Config
}): Promise<Located> {
  const current = currentRecording()
  if (current) throw new RecapError('ALREADY_RECORDING', `"${current.meeting.title}" is already being recorded. Stop it first.`)
  const config = options.config ?? loadConfig()
  const store = new MeetingStore(config)
  const { meeting, dir } = store.create({
    title: options.title.length === 0 ? defaultTitle(options.mode) : options.title,
    mode: options.mode,
    display: options.display,
    bitaEntryId: options.bitaEntryId,
    bita: options.bita,
  })
  try {
    await launchRecorder(dir)
  } catch (error) {
    rmSync(dir, { recursive: true, force: true })
    throw error
  }
  let latest: Meeting = meeting
  const settled = await waitUntil(options.timeout, 0.25, () => {
    try {
      latest = loadMeeting(dir)
    } catch {
      return false
    }
    return latest.status !== 'starting'
  })
  if (latest.status === 'failed') {
    throw new RecapError('RECORDER_FAILED', latest.error ?? `The recorder failed to start. See ${path.join(dir, 'recorder.log')}`)
  }
  if (!settled || latest.status !== 'recording') {
    if (latest.recorderPid !== undefined) signalProcess(latest.recorderPid, 'SIGKILL')
    try {
      updateMeeting(dir, (item) => {
        item.status = 'failed'
        item.error = `The recorder did not confirm within ${Math.trunc(options.timeout)}s`
      })
    } catch {
      undefined
    }
    throw new RecapError('RECORDER_TIMEOUT', `The recorder did not start within ${Math.trunc(options.timeout)}s. Check the permissions with \`recap setup\`.`)
  }
  saveActive({ meetingId: latest.id, dir, mode: options.mode, startedAt: latest.startedAt ?? isoNow() })
  return { meeting: latest, dir }
}

async function stopRecorder(meeting: Meeting, dir: string, timeout: number): Promise<Meeting> {
  const pid = meeting.recorderPid
  if (pid === undefined) throw new RecapError('RECORDER_UNKNOWN', `The recorder process for "${meeting.title}" is unknown`)
  signalProcess(pid, 'SIGINT')
  let current = meeting
  const stopped = await waitUntil(timeout, 0.25, () => {
    try {
      current = loadMeeting(dir)
    } catch {
      return !isAlive(pid)
    }
    return current.status === 'recorded' || current.status === 'failed' || !isAlive(pid)
  })
  if (!stopped) signalProcess(pid, 'SIGKILL')
  if (isActiveStatus(current.status)) {
    current = updateMeeting(dir, (item) => {
      item.status = exists(recordingPath(dir, item.mode)) ? 'recorded' : 'failed'
      item.endedAt = isoNow()
      delete item.recorderPid
      item.error = 'The recorder exited without closing the file cleanly'
    })
  }
  return current
}

export async function stopRecording(timeout: number): Promise<Located> {
  const current = currentRecording()
  if (!current) throw new RecapError('NOT_RECORDING', 'There is no active recording')
  const meeting = await stopRecorder(current.meeting, current.active.dir, timeout)
  clearActive()
  return { meeting, dir: current.active.dir }
}

export async function discardRecording(reference: string | undefined, bitaEntryId: number | undefined): Promise<Located> {
  const store = new MeetingStore(loadConfig())
  let target: Located
  if (bitaEntryId !== undefined) {
    const found = store.find(bitaEntryId)
    if (!found) throw new RecapError('MEETING_NOT_FOUND', `No meeting is linked to bita entry ${bitaEntryId}`)
    target = found
  } else if (reference !== undefined) {
    target = store.resolve(reference)
  } else {
    const current = currentRecording()
    if (!current) throw new RecapError('NOT_RECORDING', 'There is no active recording. Pass the meeting to delete.')
    target = { meeting: current.meeting, dir: current.active.dir }
  }
  const { meeting, dir } = target
  if (meeting.recorderPid !== undefined && isAlive(meeting.recorderPid)) {
    await stopRecorder(meeting, dir, 15).catch(() => undefined)
  }
  if (loadActive()?.meetingId === meeting.id) clearActive()
  rmSync(dir, { recursive: true, force: true })
  return { meeting, dir }
}
