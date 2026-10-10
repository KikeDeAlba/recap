import { readFileSync } from 'node:fs'
import path from 'node:path'
import { loadConfig } from '../../core/config.ts'
import { isoNow } from '../../core/dates.ts'
import { readText } from '../../core/fsutil.ts'
import { MeetingStore, durationSeconds, loadMeeting, reconcile, updateMeeting, type Located, type Meeting } from '../../core/meeting.ts'
import { waitUntil } from '../../core/proc.ts'
import { meetingRecord } from '../../core/record.ts'
import { processInBackground } from '../../core/self.ts'
import { formatDuration, padEnd } from '../../core/text.ts'
import { RecapError, usageError } from '../../errors.ts'
import { saveMinutes } from '../../bita/wrapup.ts'
import { INKWELL_HINT } from '../../bita/client.ts'
import { Pipeline } from '../../pipeline/pipeline.ts'
import { STAGES, allStagesSatisfied, isStage, type Stage } from '../../pipeline/stages.ts'
import { saveSummary, summaryPromptFor } from '../../pipeline/summary.ts'
import { parseArgs } from '../args.ts'
import { output, stderrLine } from '../output.ts'

export async function listCommand(argv: string[]): Promise<number> {
  return output('list', argv.includes('--json'), () => {
    const args = parseArgs(argv, { values: ['limit'], maxPositionals: 0 })
    const limit = args.int('limit') ?? 20
    const store = new MeetingStore(loadConfig())
    const all = store.all()
    const records = (limit > 0 ? all.slice(0, limit) : all).map((item) => ({ item, record: meetingRecord(item.meeting, item.dir) }))
    const lines = records.map(({ item }) => {
      const m = item.meeting
      return `${m.id}  ${padEnd(m.mode, 9)} ${padEnd(m.status, 10)} ${padEnd(formatDuration(durationSeconds(m)), 8)} ${m.title}`
    })
    return { data: records.map(({ record }) => record), text: lines.length === 0 ? `No meetings in ${store.root}` : lines.join('\n') }
  })
}

function locate(store: MeetingStore, reference: string | undefined, bitaEntry: number | undefined): Located {
  if (bitaEntry !== undefined) {
    const found = store.find(bitaEntry)
    if (!found) throw new RecapError('MEETING_NOT_FOUND', `No meeting is linked to bita entry ${bitaEntry}`)
    return found
  }
  return store.resolve(reference ?? 'last')
}

export async function showCommand(argv: string[]): Promise<number> {
  return output('show', argv.includes('--json'), () => {
    const args = parseArgs(argv, { booleans: ['path'], values: ['bita-entry'], maxPositionals: 1 })
    const { meeting, dir } = locate(new MeetingStore(loadConfig()), args.positionals[0], args.int('bita-entry'))
    const record = meetingRecord(meeting, dir, true)
    if (args.has('path')) return { data: record, text: dir }
    const summary = readText(path.join(dir, 'summary.md'))
    if (summary !== null) return { data: record, text: summary }
    let text = `${meeting.title}\n${meeting.id}  ${meeting.mode}  ${meeting.status}  ${formatDuration(durationSeconds(meeting))}\n${dir}`
    if (meeting.error) text += `\nError: ${meeting.error}`
    return { data: record, text }
  })
}

function stageOption(value: string | undefined, name: string): Stage | undefined {
  if (value === undefined) return undefined
  if (!isStage(value)) throw usageError(`--${name} takes one of ${STAGES.join(', ')}`)
  return value
}

export async function processCommand(argv: string[]): Promise<number> {
  const json = argv.includes('--json')
  return output('process', json, async () => {
    const args = parseArgs(argv, { booleans: ['background'], values: ['from', 'only'], maxPositionals: 1 })
    const from = stageOption(args.value('from'), 'from')
    const only = stageOption(args.value('only'), 'only')
    const config = loadConfig()
    const { meeting, dir } = new MeetingStore(config).resolve(args.positionals[0] ?? 'last')
    if (args.has('background')) {
      processInBackground(meeting.id, dir, [...(from ? ['--from', from] : []), ...(only ? ['--only', only] : [])])
      return { data: meetingRecord(meeting, dir), text: `Processing "${meeting.title}" in the background\n${path.join(dir, 'process.log')}` }
    }
    const pipeline = new Pipeline(dir, config, (line) => {
      if (!json) stderrLine(line)
    })
    const result = await pipeline.run(from, only)
    const summary = path.join(dir, 'summary.md')
    const text = readText(summary) !== null ? `Processed "${result.title}"\n${summary}` : `Processed "${result.title}" [${result.status}]\n${dir}`
    return { data: meetingRecord(result, dir), text }
  })
}

export async function promptCommand(argv: string[]): Promise<number> {
  return output('prompt', false, () => {
    const args = parseArgs(argv, { maxPositionals: 1 })
    const { meeting, dir } = new MeetingStore(loadConfig()).resolve(args.positionals[0] ?? 'last')
    return { data: '', text: `Directorio de la reunión: ${dir}\n\n${summaryPromptFor(meeting, dir)}` }
  })
}

export async function saveSummaryCommand(argv: string[]): Promise<number> {
  return output('save-summary', argv.includes('--json'), async () => {
    const args = parseArgs(argv, { maxPositionals: 2 })
    const [reference, file] = args.positionals
    if (!reference || !file) throw usageError('Usage: recap save-summary <meeting> <file|->')
    const config = loadConfig()
    const { meeting, dir } = new MeetingStore(config).resolve(reference)
    let body: string
    try {
      body = file === '-' ? readFileSync(0, 'utf8') : readFileSync(file, 'utf8')
    } catch (error) {
      throw new RecapError('FILE_UNREADABLE', `Cannot read ${file}: ${(error as Error).message}`)
    }
    saveSummary(body, meeting, dir)
    let minutes: string | null = null
    if (meeting.bitaEntryId !== undefined) {
      const result = await saveMinutes(meeting, dir)
      minutes = result.saved ? `Minutes saved in the note of entry #${meeting.bitaEntryId}` : `Minutes not saved in the entry note: ${result.reason ?? 'no reason given'} (${INKWELL_HINT})`
    }
    const updated = updateMeeting(dir, (current) => {
      current.stages['summarize'] = { status: 'done', updatedAt: isoNow() }
      if (allStagesSatisfied({ ...meeting, stages: current.stages })) current.status = 'processed'
    })
    return { data: meetingRecord(updated, dir), text: minutes === null ? path.join(dir, 'summary.md') : `${path.join(dir, 'summary.md')}\n${minutes}` }
  })
}

export function failedStage(meeting: Meeting): [string, { status: string; error?: string | undefined }] | null {
  return Object.entries(meeting.stages).find(([, state]) => state.status === 'failed') ?? null
}

export function isSettled(meeting: Meeting): boolean {
  if (meeting.status === 'processed' || meeting.status === 'failed') return true
  if (meeting.status === 'recorded') return failedStage(meeting) !== null
  return false
}

export function describeWait(meeting: Meeting, dir: string): string {
  const lines = [`${meeting.title} [${meeting.status}] ${formatDuration(durationSeconds(meeting))}`]
  const failed = failedStage(meeting)
  if (failed) lines.push(`Failed at ${failed[0]}: ${failed[1].error ?? 'no reason given'}`)
  for (const [stage, state] of Object.entries(meeting.stages)) {
    if (state.status === 'skipped' && state.reason !== undefined) lines.push(`Skipped ${stage}: ${state.reason}${state.hint !== undefined ? ` (${state.hint})` : ''}`)
  }
  const wrapup = meeting.wrapup
  if (wrapup) {
    lines.push(`Title   : ${wrapup.title ?? meeting.title}`)
    lines.push(`Project : ${wrapup.project ?? '(none)'}${wrapup.projectResolved ? '' : ' — not clear from the meeting'}`)
    if (wrapup.pageId !== undefined) lines.push(`Page    : #${wrapup.pageId}${wrapup.pageCreated ? ' (new)' : ''}`)
    lines.push(`Backlog : ${Object.keys(wrapup.backlogKeys).length} items`)
  }
  lines.push(path.join(dir, 'summary.md'))
  return lines.join('\n')
}

export async function waitCommand(argv: string[]): Promise<number> {
  return output('wait', argv.includes('--json'), async () => {
    const args = parseArgs(argv, { values: ['bita-entry', 'timeout'], maxPositionals: 1 })
    const bitaEntry = args.int('bita-entry')
    const timeout = args.number('timeout') ?? 900
    const store = new MeetingStore(loadConfig())
    let found: Located | null = null
    const settled = await waitUntil(timeout, 2, () => {
      try {
        if (found) found = { meeting: reconcile(loadMeeting(found.dir), found.dir), dir: found.dir }
        else found = bitaEntry !== undefined ? store.find(bitaEntry) : store.resolve(args.positionals[0])
      } catch {
        if (!found) found = null
      }
      return found !== null && isSettled(found.meeting)
    })
    const result = found as Located | null
    if (!result) throw new RecapError('MEETING_NOT_FOUND', bitaEntry !== undefined ? `No meeting is linked to bita entry ${bitaEntry}` : 'No meeting found')
    if (!settled) throw new RecapError('WAIT_TIMEOUT', `"${result.meeting.title}" is still ${result.meeting.status} after ${Math.trunc(timeout)}s`)
    return { data: meetingRecord(result.meeting, result.dir), text: describeWait(result.meeting, result.dir) }
  })
}
