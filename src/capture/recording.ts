import { rmSync } from 'node:fs'
import type { Config } from '../core/config.ts'
import { loadConfig, settingsOf } from '../core/config.ts'
import { clearActive, currentRecording, loadActive, saveActive } from '../core/active.ts'
import { isoNow } from '../core/dates.ts'
import { exists } from '../core/fsutil.ts'
import { MeetingStore, isActiveStatus, loadMeeting, recordingPath, updateMeeting, type BitaTarget, type Located, type Meeting, type MeetingMode } from '../core/meeting.ts'
import { isAlive, signalProcess, signalTree, waitUntil } from '../core/proc.ts'
import { RecapError } from '../errors.ts'
import { selectRecorder, type Recorder } from './recorder.ts'
import { recoverCapture, recoveryNote } from './recover.ts'
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
  recorder?: Recorder
}): Promise<Located> {
  const current = currentRecording()
  if (current) throw new RecapError('ALREADY_RECORDING', `"${current.meeting.title}" is already being recorded. Stop it first.`)
  const config = options.config ?? loadConfig()
  const recorder = options.recorder ?? selectRecorder(undefined, config)
  const store = new MeetingStore(config)
  const { meeting, dir } = store.create({
    title: options.title.length === 0 ? defaultTitle(options.mode) : options.title,
    mode: options.mode,
    display: options.display,
    bitaEntryId: options.bitaEntryId,
    bita: options.bita,
  })
  try {
    await recorder.launch(dir, { live: settingsOf(config).enabled })
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
    if (latest.recorderPid !== undefined) forceKill(recorder, latest.recorderPid)
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

function forceKill(recorder: Recorder, pid: number): void {
  if (recorder.kind === 'mac-app') signalProcess(pid, 'SIGKILL')
  else signalTree(pid, 'SIGKILL')
}

async function stopRecorder(meeting: Meeting, dir: string, timeout: number, recorder: Recorder = selectRecorder()): Promise<Meeting> {
  const pid = meeting.recorderPid
  if (pid === undefined) throw new RecapError('RECORDER_UNKNOWN', `The recorder process for "${meeting.title}" is unknown`)
  await recorder.stop(meeting, dir)
  let current = meeting
  const stopped = await waitUntil(timeout, 0.25, () => {
    try {
      current = loadMeeting(dir)
    } catch {
      return !isAlive(pid)
    }
    return current.status === 'recorded' || current.status === 'failed' || !isAlive(pid)
  })
  if (!stopped) {
    forceKill(recorder, pid)
    if (recorder.kind !== 'mac-app') await waitUntil(5, 0.1, () => !isAlive(pid))
  }
  if (isActiveStatus(current.status)) {
    const recovery = recorder.kind === 'mac-app' ? null : recoverCapture(dir, current.mode)
    current = updateMeeting(dir, (item) => {
      item.status = exists(recordingPath(dir, item.mode)) ? 'recorded' : 'failed'
      item.endedAt = isoNow()
      delete item.recorderPid
      item.error = recovery ? recoveryNote(recovery) : 'The recorder exited without closing the file cleanly'
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
