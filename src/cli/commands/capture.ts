import { platformContext } from '@kikedealba/kit/platform'
import { liveWorkerCommand as stableLiveWorker } from '../../capture/capture.ts'
import { FfmpegRecorder } from '../../capture/recorder.ts'
import { sourceSpecs } from '../../capture/sources.ts'
import { CaptureSupervisor } from '../../capture/worker.ts'
import { loadConfig, settingsOf } from '../../core/config.ts'
import { isoNow } from '../../core/dates.ts'
import { loadMeeting, updateMeeting } from '../../core/meeting.ts'
import { home } from '../../core/paths.ts'
import { errorMessage } from '../../errors.ts'

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
