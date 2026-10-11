import { readdirSync, statSync } from 'node:fs'
import path from 'node:path'
import { loadConfig, rootDir } from '../../core/config.ts'
import { MEETING_FILE, loadMeeting, type Meeting } from '../../core/meeting.ts'
import { sleep } from '../../core/proc.ts'
import { suffix, trimmed } from '../../core/text.ts'
import { usageError } from '../../errors.ts'
import { parseArgs } from '../args.ts'
import { output } from '../output.ts'
import { failedStage, isSettled } from './query.ts'

export const WATCH_OPT_OUT = 'RECAP_MONITOR'

const NOTICE = ' (FYI: act on it only if this session is handling that meeting)'

export interface WatchEvent {
  id: string
  title: string
  status: string
  dir: string
  failed: boolean
  message: string
}

interface Seen {
  mtimeMs: number
  settled: boolean
}

export function watchDisabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const value = trimmed(env[WATCH_OPT_OUT] ?? '').toLowerCase()
  return ['0', 'off', 'false', 'no'].includes(value)
}

export function describeSettled(meeting: Meeting, dir: string): WatchEvent {
  const failed = failedStage(meeting)
  const base = { id: meeting.id, title: meeting.title, status: meeting.status, dir }
  if (meeting.status !== 'processed') {
    const where = failed ? ` at ${failed[0]}` : ''
    const reason = suffix(trimmed((failed ? failed[1].error : meeting.error) ?? 'no reason given').replace(/\s+/g, ' '), 200)
    return { ...base, failed: true, message: `recap: meeting "${meeting.title}" failed${where}: ${reason} (${meeting.id}); run \`recap process ${meeting.id}\` to resume${NOTICE}` }
  }
  const parts = [`recap: meeting "${meeting.title}" finished processing (${meeting.id})`, `minutes at ${path.join(dir, 'summary.md')}`]
  const wrapup = meeting.wrapup
  if (wrapup?.pageId !== undefined) parts.push(`inkwell page #${wrapup.pageId}`)
  if (wrapup && !wrapup.projectResolved) parts.push('project unresolved')
  return { ...base, failed: false, message: `${parts.join('; ')}${NOTICE}` }
}

export class MeetingWatcher {
  readonly root: string
  private readonly seen = new Map<string, Seen>()
  private primed = false

  constructor(root: string) {
    this.root = root
  }

  tick(): WatchEvent[] {
    let names: string[]
    try {
      names = readdirSync(this.root)
    } catch {
      names = []
    }
    const events: WatchEvent[] = []
    const present = new Set<string>()
    for (const name of names) {
      const dir = path.join(this.root, name)
      let mtimeMs: number
      try {
        mtimeMs = statSync(path.join(dir, MEETING_FILE)).mtimeMs
      } catch {
        continue
      }
      present.add(name)
      const before = this.seen.get(name)
      if (before && before.mtimeMs === mtimeMs) continue
      let meeting: Meeting
      try {
        meeting = loadMeeting(dir)
      } catch {
        continue
      }
      const settled = isSettled(meeting)
      this.seen.set(name, { mtimeMs, settled })
      const wasSettled = before ? before.settled : !this.primed
      if (settled && !wasSettled) events.push(describeSettled(meeting, dir))
    }
    for (const name of [...this.seen.keys()]) if (!present.has(name)) this.seen.delete(name)
    this.primed = true
    return events
  }
}

export async function watchCommand(argv: string[]): Promise<number> {
  const json = argv.includes('--json')
  let interval: number
  let root: string
  try {
    const args = parseArgs(argv, { values: ['interval'], maxPositionals: 0 })
    interval = args.number('interval') ?? 5
    if (interval < 1 || interval > 300) throw usageError('--interval takes seconds between 1 and 300')
    root = rootDir(loadConfig())
  } catch (error) {
    return output('watch', json, () => {
      throw error
    })
  }
  if (watchDisabled()) return 0
  process.stdout.on('error', () => process.exit(0))
  const watcher = new MeetingWatcher(root)
  watcher.tick()
  for (;;) {
    await sleep(interval * 1000)
    for (const event of watcher.tick()) process.stdout.write(`${json ? JSON.stringify(event) : event.message}\n`)
  }
}
