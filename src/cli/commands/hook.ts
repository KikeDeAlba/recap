import { readFileSync } from 'node:fs'
import { currentRecording } from '../../core/active.ts'
import { loadConfig } from '../../core/config.ts'
import { isoNow } from '../../core/dates.ts'
import { MeetingStore, updateMeeting } from '../../core/meeting.ts'
import { processInBackground } from '../../core/self.ts'
import { RecapError, describeError, errorMessage } from '../../errors.ts'
import { decodeHookEvent, describeAction, eventSnapshot, eventTarget, planHook, type BitaHookEvent } from '../../bita/hook.ts'
import { discardRecording, startRecording, stopRecording } from '../../capture/recording.ts'

function log(message: string): void {
  process.stdout.write(`${isoNow()} recap bita-hook: ${message}\n`)
}

export async function handleHookEvent(event: BitaHookEvent): Promise<number> {
  const active = currentRecording()
  const action = planHook(event, active?.meeting.bitaEntryId)
  log(`${event.event} #${event.entry.id} kind=${event.entry.kind ?? '-'}: ${describeAction(action)}`)
  try {
    switch (action.type) {
      case 'start': {
        const record = await startRecording({ title: event.entry.description, mode: action.mode, bitaEntryId: event.entry.id, bita: eventTarget(event), timeout: 90 })
        updateMeeting(record.dir, (meeting) => {
          meeting.bitaEntry = eventSnapshot(event)
        })
        log(`recording ${record.dir}`)
        break
      }
      case 'stopAndProcess': {
        const record = await stopRecording(60)
        updateMeeting(record.dir, (meeting) => {
          meeting.bitaEntry = eventSnapshot(event)
        })
        if (record.meeting.status === 'recorded') {
          processInBackground(record.meeting.id, record.dir)
          log(`processing ${record.dir}`)
        }
        break
      }
      case 'processIfRecorded': {
        const found = new MeetingStore(loadConfig()).find(event.entry.id)
        if (!found) {
          log(`nothing to do: no meeting for entry #${event.entry.id}`)
          break
        }
        if (found.meeting.status !== 'recorded' || Object.keys(found.meeting.stages).length > 0) {
          log(`nothing to do: ${found.meeting.id} is ${found.meeting.status}`)
          break
        }
        updateMeeting(found.dir, (meeting) => {
          meeting.bitaEntry = eventSnapshot(event)
        })
        processInBackground(found.meeting.id, found.dir)
        log(`processing ${found.dir}`)
        break
      }
      case 'stopWithoutProcessing': {
        const record = await stopRecording(60)
        log(`stopped without processing ${record.dir}`)
        break
      }
      case 'discard': {
        const record = await discardRecording(undefined, event.entry.id)
        log(`discarded ${record.dir}`)
        break
      }
      case 'refresh': {
        const found = new MeetingStore(loadConfig()).find(event.entry.id)
        if (!found) {
          log(`nothing to do: no meeting for entry #${event.entry.id}`)
          break
        }
        updateMeeting(found.dir, (meeting) => {
          meeting.bitaEntry = { ...eventSnapshot(event), pageIds: meeting.bitaEntry?.pageIds ?? [] }
          const renamed = event.previousTitle !== undefined && event.previousTitle !== event.entry.description
          if (renamed && event.entry.description.trim().length > 0) meeting.title = event.entry.description
        })
        log(`updated ${found.dir}`)
        break
      }
      case 'ignore':
        log(`nothing to do: ${action.reason}`)
        break
    }
    return 0
  } catch (error) {
    if (error instanceof RecapError && error.code === 'MEETING_NOT_FOUND') {
      log(`nothing to do: ${error.message}`)
      return 0
    }
    log(`failed: ${describeError(error)}`)
    return 1
  }
}

export async function bitaHookCommand(argv: string[]): Promise<number> {
  if (argv.includes('--help')) {
    process.stdout.write('recap bita-hook: handle a bita timer event read from stdin (registered through the kit tool registry by `recap setup`).\n')
    return 0
  }
  let event: BitaHookEvent
  try {
    event = decodeHookEvent(readFileSync(0, 'utf8'))
  } catch (error) {
    log(`ignored: unreadable event (${errorMessage(error)})`)
    return 1
  }
  return handleHookEvent(event)
}
