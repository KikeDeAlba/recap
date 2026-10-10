import { currentRecording } from '../../core/active.ts'
import { loadConfig, type Config } from '../../core/config.ts'
import { isoNow } from '../../core/dates.ts'
import { MeetingStore, loadMeeting, resolveTarget, type Located } from '../../core/meeting.ts'
import { signalNumber, signalTree } from '../../core/proc.ts'
import { trimmed } from '../../core/text.ts'
import { RecapError, asRecapError, usageError } from '../../errors.ts'
import { BitaClient, docsClient, meetingTarget } from '../../bita/client.ts'
import { runAsk } from '../../live/ask.ts'
import { isValidAskId, makeAskId, performAsk, removeBoard } from '../../live/asking.ts'
import { loadProjectContext, meetingProject, meetingProjectName } from '../../live/context.ts'
import { jsonLine } from '../../live/files.ts'
import { encodeAnswer, encodeAskEvent, type AskEvent } from '../../live/stream.ts'
import type { Channel } from '../../pipeline/transcript.ts'
import { parseArgs, type Args } from '../args.ts'
import { output } from '../output.ts'

function target(args: Args, config: Config): Located {
  const dir = args.value('dir')
  if (dir !== undefined) return { meeting: loadMeeting(dir), dir }
  if (args.has('active')) {
    const current = currentRecording()
    if (!current) throw new RecapError('NOT_RECORDING', 'There is no active recording')
    return { meeting: current.meeting, dir: current.active.dir }
  }
  return resolveTarget(new MeetingStore(config), args.value('meeting'), args.int('bita-entry'))
}

function validate(args: Args): void {
  if (args.has('sources')) {
    if (!args.value('project') && !args.has('active') && !args.value('meeting') && args.value('bita-entry') === undefined) {
      throw usageError('--sources needs --project, --active, --meeting or --bita-entry')
    }
    return
  }
  const targets = [args.has('active'), args.value('meeting') !== undefined, args.value('bita-entry') !== undefined, args.value('dir') !== undefined].filter(Boolean).length
  if (targets !== 1) throw usageError('Choose one of --active, --meeting or --bita-entry')
  const window = args.int('window')
  if (window !== undefined && window <= 0) throw usageError('--window must be positive')
  if (args.has('auto') && trimmed(args.value('question') ?? '').length === 0) throw usageError('--auto needs --question')
  const questionMs = args.int('question-ms')
  if (questionMs !== undefined && questionMs < 0) throw usageError('--question-ms must not be negative')
  const channel = args.value('channel')
  if (channel !== undefined && channel !== 'mic' && channel !== 'system') throw usageError('--channel takes mic or system')
  const askId = args.value('ask-id')
  if (askId !== undefined && !isValidAskId(askId)) throw usageError('--ask-id takes lowercase letters, digits and dashes')
}

const SPEC = {
  booleans: ['active', 'auto', 'sources', 'json-stream'],
  values: ['meeting', 'bita-entry', 'dir', 'question-ms', 'channel', 'ask-id', 'question', 'window', 'project'],
  maxPositionals: 0,
}

function installCleanup(dir: string, id: string, child: () => number | null): void {
  for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP'] as NodeJS.Signals[]) {
    process.on(signal, () => {
      const pid = child()
      if (pid !== null) signalTree(pid, 'SIGKILL')
      removeBoard(dir, id)
      process.exit(128 + signalNumber(signal))
    })
  }
}

async function answer(args: Args, emit: (event: AskEvent) => void) {
  const config = loadConfig()
  const found = target(args, config)
  const id = args.value('ask-id') ?? makeAskId()
  const now = isoNow()
  const question = args.value('question')
  const questionMs = args.int('question-ms')
  const channel = args.value('channel') as Channel | undefined
  let childPid: number | null = null
  installCleanup(found.dir, id, () => childPid)
  return performAsk({ dir: found.dir, id, question, auto: args.has('auto'), now, questionMs, channel }, async () => {
    const docs = await docsClient(config, meetingTarget(found.meeting))
    const context = await loadProjectContext(await meetingProject(found.meeting, docs), found.meeting.bitaDocsRoot, docs)
    return runAsk(
      config,
      { meeting: found.meeting, dir: found.dir, question, windowSeconds: args.int('window') ?? 180, now, auto: args.has('auto'), questionMs, channel, askId: id },
      context,
      emit,
      (pid) => {
        childPid = pid
      },
    )
  })
}

export async function askCommand(argv: string[]): Promise<number> {
  const json = argv.includes('--json')
  if (argv.includes('--json-stream')) {
    try {
      const args = parseArgs(argv, SPEC)
      validate(args)
      await answer(args, (event) => process.stdout.write(`${jsonLine(encodeAskEvent(event))}\n`))
      return 0
    } catch (error) {
      const failure = asRecapError(error)
      process.stdout.write(`${jsonLine(encodeAskEvent({ type: 'error', code: failure.code, message: failure.message }))}\n`)
      return failure.exitCode
    }
  }
  return output('ask', json, async () => {
    const args = parseArgs(argv, SPEC)
    validate(args)
    if (args.has('sources')) {
      const config = loadConfig()
      const found = args.has('active') || args.value('meeting') !== undefined || args.value('bita-entry') !== undefined ? target(args, config) : null
      const docs = found ? await docsClient(config, meetingTarget(found.meeting)) : await docsClient(config, {})
      const name = args.value('project') ?? (found ? meetingProjectName(found.meeting) : null)
      const context = await loadProjectContext(name, found?.meeting.bitaDocsRoot, docs ?? (await BitaClient.create(config, {})))
      const lines = [`Project: ${context.project ?? '(none)'}`, `Docs: ${context.docsRoot ?? '(unknown)'}`, ...context.repos.map((repo) => `Repo: ${repo.slug} ${repo.path}${repo.exists ? '' : ' (missing)'}`)]
      return { data: { project: context.project ?? undefined, docsRoot: context.docsRoot ?? undefined, repos: context.repos }, text: lines.join('\n') }
    }
    const result = await answer(args, (event) => {
      if (json) return
      if (event.type === 'delta') process.stdout.write(event.text)
      else if (event.type === 'progress') process.stderr.write(`· ${event.text}\n`)
    })
    let text = json ? '' : '\n'
    if (result.sources.length > 0) text += `\nFuentes:\n${result.sources.map((source) => `- ${source.label}`).join('\n')}`
    return { data: encodeAnswer(result), text: text.replace(/^\n+|\n+$/g, '').length === 0 ? '' : text }
  })
}
