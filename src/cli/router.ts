import { readManifest } from '@kikedealba/kit/registry'
import { usageError } from '../errors.ts'
import { findCapture } from '../capture/capture.ts'
import { capabilities } from '../setup/integration.ts'
import { VERSION } from '../version.ts'
import { askCommand } from './commands/ask.ts'
import { configCommand } from './commands/config.ts'
import { bitaHookCommand } from './commands/hook.ts'
import { liveWorkerCommand } from './commands/live.ts'
import { compressVideoCommand, deleteCommand, pruneCommand, stripVideoCommand } from './commands/media.ts'
import { proposalsCommand } from './commands/proposals.ts'
import { listCommand, processCommand, promptCommand, saveSummaryCommand, showCommand, waitCommand } from './commands/query.ts'
import { discardCommand, importCommand, startCommand, statusCommand, stopCommand } from './commands/recording.ts'
import { setupCommand } from './commands/setup.ts'
import { watchCommand } from './commands/watch.ts'
import { output } from './output.ts'

type Command = (argv: string[]) => Promise<number>

async function capabilitiesCommand(argv: string[]): Promise<number> {
  return output('capabilities', argv.includes('--json'), async () => {
    const registered = await readManifest('recap').catch(() => null)
    const capture = (await findCapture()) !== null
    const data = { name: 'recap', version: VERSION, envelope: 1, capabilities: capabilities(capture), emits: [] as string[] }
    return { data: { ...data, ...(registered ? { subscribes: registered.subscribes } : {}) }, text: data.capabilities.join('\n') }
  })
}

const COMMANDS: Record<string, Command> = {
  start: startCommand,
  stop: stopCommand,
  discard: discardCommand,
  status: statusCommand,
  list: listCommand,
  show: showCommand,
  process: processCommand,
  import: importCommand,
  'compress-video': compressVideoCommand,
  'strip-video': stripVideoCommand,
  prune: pruneCommand,
  delete: deleteCommand,
  prompt: promptCommand,
  'save-summary': saveSummaryCommand,
  'bita-hook': bitaHookCommand,
  wait: waitCommand,
  setup: setupCommand,
  ask: askCommand,
  proposals: proposalsCommand,
  config: configCommand,
  watch: watchCommand,
  'live-worker': liveWorkerCommand,
  capabilities: capabilitiesCommand,
}

export function help(): string {
  return [
    `recap ${VERSION} — record meetings, transcribe them locally and summarize them with Claude Code`,
    '',
    'Recording (macOS, through Recap.app):',
    '  recap start --remote|--in-person [title] [--bita-entry id] [--display id] [--timeout s]',
    '  recap stop [--no-process] [--timeout s]',
    '  recap discard [meeting] [--bita-entry id]',
    '  recap status',
    '',
    'Any system:',
    '  recap import <audio|video file> [--title t] [--remote|--in-person] [--no-process|--background]',
    '  recap process [meeting] [--from stage] [--only stage] [--background]',
    '  recap list [--limit n] | show [meeting] [--bita-entry id] [--path] | wait [meeting] [--bita-entry id] [--timeout s]',
    '  recap prompt [meeting] | save-summary <meeting> <file|->',
    '  recap ask (--active|--meeting m|--bita-entry id) [--question q] [--window s] [--json-stream] | ask --sources --project p',
    '  recap proposals ls|show|accept|reject <meeting> [n] [--bita-entry id] [--md file]',
    '  recap compress-video <meeting> --preset light|medium|max | strip-video <meeting> | prune <meeting> --intermediates | delete <meeting>',
    '  recap config get [key] | config set <key> <value>',
    '  recap watch [--interval s]: one line per meeting that finishes processing; RECAP_MONITOR=off turns it off',
    '  recap setup [--install-deps] [--skip-models] [--skip-permissions] [--skip-bita] [--skip-app] [--agents detected|all|none|claude,opencode,codex,gemini]',
    '  recap capabilities',
    '',
    'Stages: audio, transcribe, frames, summarize, proposals, wrapup. Every command takes --json.',
  ].join('\n')
}

export async function main(argv: string[]): Promise<number> {
  const [name, ...rest] = argv
  if (name === undefined || name === '--help' || name === '-h' || name === 'help') {
    process.stdout.write(`${help()}\n`)
    return 0
  }
  if (name === '--version' || name === '-v' || name === 'version') {
    process.stdout.write(`${VERSION}\n`)
    return 0
  }
  const command = COMMANDS[name]
  if (!command) {
    return output(name, argv.includes('--json'), () => {
      throw usageError(`Unknown command "${name}"`, 'Run `recap --help` to see the commands.')
    })
  }
  if (rest.includes('--help') && name !== 'bita-hook') {
    process.stdout.write(`${help()}\n`)
    return 0
  }
  return command(rest)
}
