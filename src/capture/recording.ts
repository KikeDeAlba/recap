import { rmSync } from 'node:fs'
import type { Config } from '../core/config.ts'
import { loadConfig, settingsOf } from '../core/config.ts'
import { clearActive, currentRecording, loadActive, saveActive } from '../core/active.ts'
import { isoNow } from '../core/dates.ts'
import { exists } from '../core/fsutil.ts'
import { MeetingStore, isActiveStatus, loadMeeting, recordingPath, updateMeeting, type BitaTarget, type Located, type Meeting, type MeetingMode } from '../core/meeting.ts'
import { isAlive, signalProcess, signalTree, waitUntil } from '../core/proc.ts'
import { RecapError, errorMessage } from '../errors.ts'
import { selectRecorder, type Recorder } from './recorder.ts'
import { applyRecovery, recoverCapture, withRecoveryLock } from './recover.ts'
import { assembleMeeting } from './assemble.ts'
import { removeControlDir } from './control.ts'
import { needsAssembly } from './manifest.ts'
import path from 'node:path'

export function defaultTitle(mode: MeetingMode): string {
  if (mode === 'remote') return 'Remote meeting'
  return mode === 'in-person' ? 'In-person meeting' : 'Meeting'
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
  const fallback = options.mode === 'meeting' && !(await recorder.supports('meeting')) ? 'in-person' : undefined
  const mode = fallback ?? options.mode
  const store = new MeetingStore(config)
  const { meeting, dir } = store.create({
    title: options.title.length === 0 ? defaultTitle(options.mode) : options.title,
    mode,
    fallback,
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
  if (fallback !== undefined && latest.fallback !== fallback) {
    latest = updateMeeting(dir, (item) => {
      item.fallback = fallback
    })
  }
  saveActive({ meetingId: latest.id, dir, mode, startedAt: latest.startedAt ?? isoNow() })
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
    const mode = current.mode
    const attempt = recorder.kind === 'mac-app' ? null : withRecoveryLock(dir, () => recoverCapture(dir, mode))
    const recovery = attempt?.ok ? attempt.value : null
    current = updateMeeting(dir, (item) => {
      item.status = exists(recordingPath(dir, item.mode)) || needsAssembly(dir, item.mode) ? 'recorded' : 'failed'
      item.endedAt = isoNow()
      delete item.recorderPid
      item.error = 'The recorder exited without closing the file cleanly'
      applyRecovery(item, recovery)
    })
  }
  return current
}

export async function assembleAfterStop(meeting: Meeting, dir: string, config: Config, warn: (line: string) => void): Promise<Meeting> {
  if (meeting.status !== 'recorded' || !needsAssembly(dir, meeting.mode)) return meeting
  try {
    return await assembleMeeting(dir, config, process.platform, warn)
  } catch (error) {
    warn(`could not assemble the recording yet, \`recap process\` retries it: ${errorMessage(error)}`)
    return loadMeeting(dir)
  }
}

export async function stopRecording(timeout: number, warn: (line: string) => void = (line) => process.stderr.write(`recap: ${line}\n`)): Promise<Located> {
  const current = currentRecording()
  if (!current) throw new RecapError('NOT_RECORDING', 'There is no active recording')
  const dir = current.active.dir
  const stopped = await stopRecorder(current.meeting, dir, timeout)
  clearActive()
  removeControlDir(dir)
  const meeting = await assembleAfterStop(stopped, dir, loadConfig(), warn)
  return { meeting, dir }
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
