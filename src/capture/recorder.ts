import { writeFileSync } from 'node:fs'
import path from 'node:path'
import { platformContext, type PlatformContext } from '@kikedealba/kit/platform'
import { loadConfig, type Config } from '../core/config.ts'
import { isoNow } from '../core/dates.ts'
import { exists } from '../core/fsutil.ts'
import type { Meeting } from '../core/meeting.ts'
import { home } from '../core/paths.ts'
import { exec, signalProcess } from '../core/proc.ts'
import { spawnSelf } from '../core/self.ts'
import { trimmed } from '../core/text.ts'
import { installHint, locateTool, requireTool } from '../core/tools.ts'
import { RecapError } from '../errors.ts'
import { capturePermissions, captureUnavailable, findCapture, launchRecorder, type PermissionReport } from './capture.ts'
import { DEFAULT_MONITOR, STOP_REQUEST, hasPulseInput, loopbackPath, micDevice, monitorOf, parseDefaultSink, type SourceTools } from './sources.ts'

export type RecorderKind = 'mac-app' | 'ffmpeg-linux' | 'windows'

export interface RecorderCheck {
  ok: boolean
  missing: string[]
  hint?: string
}

export interface Recorder {
  readonly kind: RecorderKind
  check(): Promise<RecorderCheck>
  permissions(request: boolean): Promise<PermissionReport>
  launch(dir: string, options: { live: boolean }): Promise<void>
  stop(meeting: Meeting, dir: string): Promise<void>
}

export const LOOPBACK_HINT = 'run `recap setup` to download recap-loopback'

function requirePid(meeting: Meeting): number {
  const pid = meeting.recorderPid
  if (pid === undefined) throw new RecapError('RECORDER_UNKNOWN', `The recorder process for "${meeting.title}" is unknown`)
  return pid
}

export class MacAppRecorder implements Recorder {
  readonly kind = 'mac-app' as const

  async check(): Promise<RecorderCheck> {
    if (await findCapture()) return { ok: true, missing: [] }
    const hint = captureUnavailable().hint
    return { ok: false, missing: ['Recap.app'], ...(hint ? { hint } : {}) }
  }

  async permissions(request: boolean): Promise<PermissionReport> {
    const launcher = await findCapture()
    if (!launcher) throw captureUnavailable()
    return capturePermissions(launcher, request)
  }

  launch(dir: string): Promise<void> {
    return launchRecorder(dir)
  }

  async stop(meeting: Meeting): Promise<void> {
    signalProcess(requirePid(meeting), 'SIGINT')
  }
}

export async function defaultMonitor(pactl: string, log: (line: string) => void = () => undefined): Promise<string> {
  const env = { ...process.env, LC_ALL: 'C', LANG: 'C' }
  const direct = await exec(pactl, ['get-default-sink'], { env }).catch(() => null)
  const sink = direct?.status === 0 ? trimmed(direct.stdout) : ''
  if (sink.length > 0) return monitorOf(sink)
  const info = await exec(pactl, ['info'], { env }).catch(() => null)
  const parsed = info?.status === 0 ? parseDefaultSink(info.stdout) : null
  if (parsed) return monitorOf(parsed)
  log(`pactl did not report the default output; recording ${DEFAULT_MONITOR}`)
  return DEFAULT_MONITOR
}

export class FfmpegRecorder implements Recorder {
  readonly kind: 'ffmpeg-linux' | 'windows'
  readonly ctx: PlatformContext
  private readonly configSource: () => Config

  constructor(ctx: PlatformContext, config?: Config) {
    this.ctx = ctx
    this.kind = ctx.platform === 'win32' ? 'windows' : 'ffmpeg-linux'
    this.configSource = () => config ?? loadConfig()
  }

  async check(): Promise<RecorderCheck> {
    const config = this.configSource()
    const missing: string[] = []
    const hints: string[] = []
    const ffmpeg = await locateTool('ffmpeg', config)
    if (!ffmpeg) {
      missing.push('ffmpeg')
      hints.push(installHint('ffmpeg', this.ctx.platform))
    }
    if (this.kind === 'ffmpeg-linux') {
      if (!(await locateTool('pactl', config))) {
        missing.push('pactl')
        hints.push(installHint('pactl', this.ctx.platform))
      }
      if (ffmpeg) {
        const devices = await exec(ffmpeg, ['-hide_banner', '-devices'])
        if (!hasPulseInput(devices.stdout + devices.stderr)) {
          missing.push('ffmpeg-pulse')
          hints.push('install an ffmpeg built with PulseAudio input (libpulse); PipeWire needs pipewire-pulse')
        }
      }
    } else if (!exists(loopbackPath(this.ctx))) {
      missing.push('recap-loopback')
      hints.push(LOOPBACK_HINT)
    }
    return { ok: missing.length === 0, missing, ...(hints.length > 0 ? { hint: hints.join('; ') } : {}) }
  }

  async permissions(): Promise<PermissionReport> {
    return { microphone: 'not-checked', screen: 'not-required' }
  }

  async tools(config: Config = this.configSource()): Promise<SourceTools> {
    const ffmpeg = await requireTool('ffmpeg', config)
    if (this.kind === 'windows') return { ffmpeg, loopback: loopbackPath(this.ctx), micDevice: micDevice(config) }
    return { ffmpeg, monitor: await defaultMonitor(await requireTool('pactl', config)) }
  }

  async launch(dir: string, options: { live: boolean }): Promise<void> {
    const report = await this.check()
    if (!report.ok) throw captureUnavailable(report.missing, report.hint)
    spawnSelf(['capture-worker', dir, ...(options.live ? [] : ['--no-live'])], path.join(dir, 'recorder.log'))
  }

  async stop(meeting: Meeting, dir: string): Promise<void> {
    const pid = requirePid(meeting)
    writeFileSync(path.join(dir, STOP_REQUEST), `${isoNow()}\n`)
    if (this.ctx.platform !== 'win32') signalProcess(pid, 'SIGINT')
  }
}

export function selectRecorder(ctx: PlatformContext = platformContext({ home: home() }), config?: Config): Recorder {
  if (ctx.platform === 'darwin') return new MacAppRecorder()
  return new FfmpegRecorder(ctx, config)
}
