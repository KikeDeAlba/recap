import { isRecord } from '../core/json.ts'
import type { BitaEntrySnapshot, BitaTarget, MeetingMode } from '../core/meeting.ts'

export const MEETING_KINDS: Record<string, MeetingMode> = {
  'remote-meeting': 'remote',
  'in-person-meeting': 'in-person',
}

export const HOOK_EVENTS = ['start', 'stop', 'cancel', 'amend']

export interface BitaHookEvent {
  event: string
  entry: { id: number; description: string; kind?: string | undefined; running?: boolean | undefined; projectName?: string | undefined }
  previousKind?: string | undefined
  databasePath?: string | undefined
  docsRoot?: string | undefined
  pageIds?: number[] | undefined
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

export function decodeHookEvent(text: string): BitaHookEvent {
  const value = JSON.parse(text) as unknown
  if (!isRecord(value) || typeof value['event'] !== 'string' || !isRecord(value['entry'])) throw new Error('the event has no event name or entry')
  const entry = value['entry']
  if (typeof entry['id'] !== 'number' || !Number.isInteger(entry['id']) || typeof entry['description'] !== 'string') throw new Error('the entry has no id or description')
  const pageIds = Array.isArray(value['pageIds']) ? value['pageIds'].filter((id): id is number => typeof id === 'number' && Number.isInteger(id)) : undefined
  return {
    event: value['event'],
    entry: {
      id: entry['id'],
      description: entry['description'],
      kind: optionalString(entry['kind']),
      running: typeof entry['running'] === 'boolean' ? entry['running'] : undefined,
      projectName: optionalString(entry['projectName']),
    },
    previousKind: optionalString(value['previousKind']),
    databasePath: optionalString(value['databasePath']),
    docsRoot: optionalString(value['docsRoot']),
    pageIds,
  }
}

export function eventSnapshot(event: BitaHookEvent): BitaEntrySnapshot {
  return { title: event.entry.description, projectName: event.entry.projectName, kind: event.entry.kind, pageIds: event.pageIds ?? [] }
}

export function eventMode(event: BitaHookEvent): MeetingMode | undefined {
  return event.entry.kind === undefined ? undefined : MEETING_KINDS[event.entry.kind]
}

export function previousMode(event: BitaHookEvent): MeetingMode | undefined {
  return event.previousKind === undefined ? undefined : MEETING_KINDS[event.previousKind]
}

export function eventTarget(event: BitaHookEvent): BitaTarget {
  return { databasePath: event.databasePath, docsRoot: event.docsRoot }
}

export type HookAction =
  | { type: 'start'; mode: MeetingMode }
  | { type: 'stopAndProcess' }
  | { type: 'processIfRecorded' }
  | { type: 'stopWithoutProcessing' }
  | { type: 'discard' }
  | { type: 'ignore'; reason: string }

export function describeAction(action: HookAction): string {
  switch (action.type) {
    case 'start':
      return `start(${action.mode})`
    case 'ignore':
      return `ignore(${action.reason})`
    default:
      return action.type
  }
}

export function planHook(event: BitaHookEvent, activeEntryId: number | undefined): HookAction {
  const isActive = activeEntryId === event.entry.id
  const mode = eventMode(event)
  switch (event.event) {
    case 'start':
      if (!mode) return { type: 'ignore', reason: `entry #${event.entry.id} is not a meeting` }
      return activeEntryId === undefined ? { type: 'start', mode } : { type: 'ignore', reason: 'another meeting is already being recorded' }
    case 'stop':
      return isActive ? { type: 'stopAndProcess' } : { type: 'processIfRecorded' }
    case 'cancel':
      return { type: 'discard' }
    case 'amend': {
      const previous = previousMode(event)
      if (mode && previous === undefined) {
        if (event.entry.running === false) return { type: 'ignore', reason: `entry #${event.entry.id} already stopped` }
        return activeEntryId === undefined ? { type: 'start', mode } : { type: 'ignore', reason: 'another meeting is already being recorded' }
      }
      if (mode === undefined && previous !== undefined && isActive) return { type: 'stopWithoutProcessing' }
      return { type: 'ignore', reason: 'kind change does not affect the recording' }
    }
    default:
      return { type: 'ignore', reason: `unknown event ${event.event}` }
  }
}
