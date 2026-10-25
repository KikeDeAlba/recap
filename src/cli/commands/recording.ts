import path from 'node:path'
import { currentRecording } from '../../core/active.ts'
import { loadConfig } from '../../core/config.ts'
import { MeetingStore, durationSeconds, type Meeting, type MeetingMode } from '../../core/meeting.ts'
import { meetingRecord } from '../../core/record.ts'
import { processInBackground } from '../../core/self.ts'
import { formatDuration } from '../../core/text.ts'
import { usageError } from '../../errors.ts'
import { discardRecording, startRecording, stopRecording } from '../../capture/recording.ts'
import { importRecording } from '../../capture/import.ts'
import { Pipeline } from '../../pipeline/pipeline.ts'
import { bitaLinked } from '../../setup/integration.ts'
import { parseArgs } from '../args.ts'
import { output, stderrLine } from '../output.ts'

export function modeFrom(remote: boolean, inPerson: boolean): MeetingMode | undefined {
  if (remote && inPerson) throw usageError('Choose only one of --remote or --in-person')
  if (remote) return 'remote'
  if (inPerson) return 'in-person'
  return undefined
}

export function recordingLine(meeting: Pick<Meeting, 'mode' | 'fallback' | 'title'>): string {
  const kind = meeting.fallback === undefined && meeting.mode !== 'meeting' ? `${meeting.mode} meeting` : 'meeting'
  return `Recording ${kind} "${meeting.title}"`
}

export function startText(meeting: Pick<Meeting, 'mode' | 'fallback' | 'title'>, dir: string): string {
  const note = meeting.fallback === undefined ? '' : '\nRecap.app does not support meeting mode yet; recording the microphone only. Update it with `recap setup`.'
  return `${recordingLine(meeting)}${note}\n${dir}`
}

export async function startCommand(argv: string[]): Promise<number> {
  return output('start', argv.includes('--json'), async () => {
    const args = parseArgs(argv, { booleans: ['remote', 'in-person'], values: ['display', 'bita-entry', 'timeout'] })
    const mode = modeFrom(args.has('remote'), args.has('in-person')) ?? 'meeting'
    const located = await startRecording({
      title: args.positionals.join(' '),
      mode,
      display: args.int('display'),
      bitaEntryId: args.int('bita-entry'),
      timeout: args.number('timeout') ?? 60,
    })
    return { data: meetingRecord(located.meeting, located.dir), text: startText(located.meeting, located.dir) }
  })
}

export async function stopCommand(argv: string[]): Promise<number> {
  return output('stop', argv.includes('--json'), async () => {
    const args = parseArgs(argv, { booleans: ['no-process'], values: ['timeout'], maxPositionals: 0 })
    const { meeting, dir } = await stopRecording(args.number('timeout') ?? 60)
    let text = `Stopped "${meeting.title}" after ${formatDuration(durationSeconds(meeting))}\n${dir}`
    if (!args.has('no-process') && meeting.status === 'recorded') {
      processInBackground(meeting.id, dir)
      text += `\nProcessing in the background; follow it with \`recap status\` or ${path.join(dir, 'process.log')}`
    }
    return { data: meetingRecord(meeting, dir), text }
  })
}

export async function discardCommand(argv: string[]): Promise<number> {
  return output('discard', argv.includes('--json'), async () => {
    const args = parseArgs(argv, { values: ['bita-entry'], maxPositionals: 1 })
    const { meeting, dir } = await discardRecording(args.positionals[0], args.int('bita-entry'))
    return { data: meetingRecord(meeting, dir), text: `Discarded "${meeting.title}"` }
  })
}

export async function statusCommand(argv: string[]): Promise<number> {
  return output('status', argv.includes('--json'), async () => {
    parseArgs(argv, { maxPositionals: 0 })
    const config = loadConfig()
    const linked = await bitaLinked(config)
    const current = currentRecording()
    if (current) {
      const elapsed = durationSeconds(current.meeting)
      return {
        data: { recording: true, active: meetingRecord(current.meeting, current.active.dir), elapsedSeconds: elapsed, bitaLinked: linked },
        text: `${recordingLine(current.meeting)} for ${formatDuration(elapsed)}\n${current.active.dir}`,
      }
    }
    const latest = new MeetingStore(config).all()[0]
    let text = 'Not recording'
    if (latest) text += `\nLatest: ${latest.meeting.id} [${latest.meeting.status}] "${latest.meeting.title}"`
    text += `\nbita: ${linked ? 'linked (meetings started from bita are recorded)' : 'not linked'}`
    return { data: { recording: false, latest: latest ? meetingRecord(latest.meeting, latest.dir) : undefined, bitaLinked: linked }, text }
  })
}

export async function importCommand(argv: string[]): Promise<number> {
  const json = argv.includes('--json')
  return output('import', json, async () => {
    const args = parseArgs(argv, { booleans: ['remote', 'in-person', 'no-process', 'background'], values: ['title'], maxPositionals: 1 })
    const file = args.positionals[0]
    if (!file) throw usageError('Usage: recap import <audio or video file> [--title <title>] [--remote|--in-person] [--no-process|--background]')
    const config = loadConfig()
    const located = await importRecording(config, file, { title: args.value('title'), mode: modeFrom(args.has('remote'), args.has('in-person')) })
    if (args.has('no-process')) return { data: meetingRecord(located.meeting, located.dir), text: `Imported "${located.meeting.title}"\n${located.dir}` }
    if (args.has('background')) {
      processInBackground(located.meeting.id, located.dir)
      return { data: meetingRecord(located.meeting, located.dir), text: `Imported "${located.meeting.title}"; processing in the background\n${path.join(located.dir, 'process.log')}` }
    }
    const pipeline = new Pipeline(located.dir, config, (line) => {
      if (!json) stderrLine(line)
    })
    const result = await pipeline.run()
    return { data: meetingRecord(result, located.dir), text: `Imported and processed "${result.title}" [${result.status}]\n${located.dir}` }
  })
}
