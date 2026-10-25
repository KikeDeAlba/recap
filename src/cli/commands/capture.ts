import { platformContext } from '@kikedealba/kit/platform'
import { liveWorkerCommand as stableLiveWorker } from '../../capture/capture.ts'
import { FfmpegRecorder } from '../../capture/recorder.ts'
import { sourceSpecs } from '../../capture/sources.ts'
import { CaptureSupervisor } from '../../capture/worker.ts'
import { loadConfig, settingsOf } from '../../core/config.ts'
import { isoNow } from '../../core/dates.ts'
import { loadMeeting, updateMeeting } from '../../core/meeting.ts'
import { home } from '../../core/paths.ts'
import { printable } from '../../core/text.ts'
import { errorMessage, usageError } from '../../errors.ts'
import { clearCapture, listSources, readCaptureState, setCapture, type CaptureSources, type CaptureState } from '../../capture/control.ts'
import type { CaptureTarget } from '../../capture/manifest.ts'
import { parseArgs } from '../args.ts'
import { output } from '../output.ts'

const DISABLED = new Set(['none', 'off', 'false', '0'])

export async function liveWorkerFor(env: NodeJS.ProcessEnv, fallback: () => Promise<string[]>): Promise<string[] | null> {
  const configured = env['RECAP_LIVE_WORKER']?.trim()
  if (!configured) return fallback()
  if (DISABLED.has(configured.toLowerCase())) return null
  if (configured.startsWith('[')) {
    const parsed = JSON.parse(configured) as unknown
    if (Array.isArray(parsed) && parsed.length > 0 && parsed.every((item) => typeof item === 'string')) return parsed as string[]
    throw new Error(`RECAP_LIVE_WORKER must be a JSON array of strings, got ${configured}`)
  }
  return [configured, 'live-worker']
}

export async function captureWorkerCommand(argv: string[]): Promise<number> {
  const log = (message: string) => process.stderr.write(`${isoNow()} ${message}\n`)
  const dir = argv.find((arg) => !arg.startsWith('--'))
  if (!dir) {
    log('Usage: recap capture-worker <meeting dir> [--no-live]')
    return 2
  }
  try {
    const config = loadConfig()
    const meeting = loadMeeting(dir)
    const ctx = platformContext({ home: home() })
    const recorder = new FfmpegRecorder(ctx, config)
    const tools = await recorder.tools(config)
    const settings = settingsOf(config)
    const live = !argv.includes('--no-live') && settings.enabled ? { maxChunkSeconds: settings.maxChunkSeconds } : null
    const supervisor = new CaptureSupervisor(dir, {
      ffmpeg: tools.ffmpeg,
      specs: sourceSpecs(meeting.mode, ctx, tools),
      live,
      liveWorker: live ? await liveWorkerFor(process.env, () => stableLiveWorker(ctx)) : null,
      log,
    })
    for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) process.on(signal, () => supervisor.requestStop())
    return await supervisor.run()
  } catch (error) {
    const message = errorMessage(error)
    try {
      updateMeeting(dir, (item) => {
        item.status = 'failed'
        delete item.recorderPid
        item.error = message
      })
    } catch {
      undefined
    }
    log(`failed: ${message}`)
    return 1
  }
}

export function stateText(state: CaptureState): string {
  const mic = `Microphone: ${state.mic ? 'recording' : 'off'}`
  const video = state.video
  if (!video) return `${mic}\nScreen: none, microphone only`
  const title = printable(video.title)
  const what = video.kind === 'display' ? `display ${video.id} "${title}"` : `window ${video.id} "${title}"${video.app ? ` (${printable(video.app)})` : ''}`
  const audio = video.kind === 'display' ? 'system audio' : 'its app audio'
  return `${mic}\nScreen: ${what} with ${audio} since ${printable(video.since)}`
}

export function sourcesText(sources: CaptureSources): string {
  const displays = sources.displays.map((display) => `display ${display.id}${display.main ? ' (main)' : ''}: ${printable(display.name)} ${display.width}x${display.height}`)
  const windows = sources.windows.map((window) => `window ${window.id}: ${printable(window.app)} — ${printable(window.title)}`)
  const lines = [...displays, ...windows]
  return lines.length > 0 ? lines.join('\n') : 'No displays or windows to record'
}

export function targetFrom(display: number | undefined, window: number | undefined): CaptureTarget {
  if ((display === undefined) === (window === undefined)) throw usageError('Pass exactly one of --display <id> or --window <id>', 'List them with `recap capture sources`.')
  const kind = display !== undefined ? 'display' : 'window'
  const id = display ?? window ?? 0
  if (id < 0) throw usageError(`--${kind} expects a positive id, got ${id}`)
  return { kind, id }
}

function timeoutMs(seconds: number | undefined): number | undefined {
  return seconds === undefined ? undefined : Math.max(1, seconds) * 1000
}

export const CAPTURE_USAGE = 'Usage: recap capture sources [--thumbnails] | set --display <id>|--window <id> | clear | state'

export async function captureCommand(argv: string[]): Promise<number> {
  const [sub, ...rest] = argv
  const json = rest.includes('--json')
  switch (sub) {
    case 'sources':
      return output('capture sources', json, async () => {
        const args = parseArgs(rest, { booleans: ['thumbnails'], values: ['timeout'], maxPositionals: 0 })
        const ms = timeoutMs(args.number('timeout'))
        const sources = await listSources(args.has('thumbnails'), ms === undefined ? {} : { timeoutMs: ms })
        return { data: sources, text: sourcesText(sources) }
      })
    case 'set':
      return output('capture set', json, async () => {
        const args = parseArgs(rest, { values: ['display', 'window', 'timeout'], maxPositionals: 0 })
        const target = targetFrom(args.int('display'), args.int('window'))
        const ms = timeoutMs(args.number('timeout'))
        const state = await setCapture(target, ms === undefined ? {} : { timeoutMs: ms })
        return { data: state, text: stateText(state) }
      })
    case 'clear':
      return output('capture clear', json, async () => {
        const args = parseArgs(rest, { values: ['timeout'], maxPositionals: 0 })
        const ms = timeoutMs(args.number('timeout'))
        const state = await clearCapture(ms === undefined ? {} : { timeoutMs: ms })
        return { data: state, text: stateText(state) }
      })
    case 'state':
      return output('capture state', json, () => {
        parseArgs(rest, { maxPositionals: 0 })
        const state = readCaptureState()
        return { data: state, text: stateText(state) }
      })
    default:
      return output('capture', argv.includes('--json'), () => {
        throw usageError(sub === undefined ? CAPTURE_USAGE : `Unknown capture command "${sub}". ${CAPTURE_USAGE}`)
      })
  }
}
