import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, mkdirSync, rmSync } from 'node:fs'
import path from 'node:path'
import { isoNow } from '../core/dates.ts'
import { loadMeeting, updateMeeting, type Meeting } from '../core/meeting.ts'
import { AUDIO_FILE } from '../media/media.ts'
import { commandLine, exec, signalTree, spawnDetached, waitUntil } from '../core/proc.ts'
import { suffix, trimmed } from '../core/text.ts'
import { liveFiles } from '../live/files.ts'
import type { Channel } from '../pipeline/transcript.ts'
import { RecapError, errorMessage } from '../errors.ts'
import { FrameAligner, downmix } from './audio.ts'
import { LiveTap } from './live-tap.ts'
import { CAPTURE_DIR, STOP_REQUEST, encoderArguments, intermediateFile, muxArguments, type PcmFormat, type SourceSpec } from './sources.ts'

export interface SupervisorOptions {
  ffmpeg: string
  specs: SourceSpec[]
  live: { maxChunkSeconds: number } | null
  liveWorker: string[] | null
  log: (line: string) => void
  startTimeoutMs?: number
  stopTimeoutMs?: number
  pollMs?: number
}

interface SourceState {
  spec: SourceSpec
  process: ChildProcess
  format: PcmFormat | null
  aligner: FrameAligner | null
  encoder: ChildProcess | null
  pending: Buffer[]
  startedAt: number | null
  exited: Promise<number | null>
  exitCode: number | null | undefined
  stderr: string
}

function waitExit(child: ChildProcess): Promise<number | null> {
  return new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolve(child.exitCode)
      return
    }
    child.once('close', (code) => resolve(code))
    child.once('error', () => resolve(null))
  })
}

function startedEvent(line: string): PcmFormat | null {
  try {
    const value = JSON.parse(line) as { event?: unknown; channels?: unknown; rate?: unknown }
    if (value.event !== 'started' || typeof value.channels !== 'number' || typeof value.rate !== 'number') return null
    if (!Number.isInteger(value.channels) || value.channels < 1 || !Number.isInteger(value.rate) || value.rate < 1) return null
    return { channels: value.channels, rate: value.rate }
  } catch {
    return null
  }
}

function launch(command: string, args: readonly string[], stdout: 'pipe' | 'ignore'): ChildProcess {
  const line = commandLine(command, args)
  return spawn(line.command, line.args, { stdio: ['pipe', stdout, 'pipe'], windowsHide: true, shell: line.shell })
}

export class CaptureSupervisor {
  readonly dir: string
  private readonly options: SupervisorOptions
  private readonly sources: SourceState[] = []
  private tap: LiveTap | null = null
  private origin: number | null = null
  private stopping = false
  private stopSignal: () => void = () => undefined
  private readonly stopRequested: Promise<void>
  private failure: string | null = null

  constructor(dir: string, options: SupervisorOptions) {
    this.dir = dir
    this.options = options
    this.stopRequested = new Promise((resolve) => {
      this.stopSignal = resolve
    })
  }

  requestStop(): void {
    this.stopSignal()
  }

  async run(): Promise<number> {
    const { log } = this.options
    let meeting: Meeting
    try {
      meeting = updateMeeting(this.dir, (item) => {
        item.recorderPid = process.pid
      })
    } catch (error) {
      log(`failed: ${errorMessage(error)}`)
      return 1
    }
    const poll = setInterval(() => {
      if (existsSync(path.join(this.dir, STOP_REQUEST))) this.requestStop()
    }, this.options.pollMs ?? 250)
    try {
      mkdirSync(path.join(this.dir, CAPTURE_DIR), { recursive: true })
      rmSync(path.join(this.dir, STOP_REQUEST), { force: true })
      if (this.options.live) this.tap = new LiveTap(this.dir, this.options.live.maxChunkSeconds, log)
      for (const spec of this.options.specs) this.sources.push(this.startSource(spec))
      await this.waitStarted()
      updateMeeting(this.dir, (item) => {
        item.status = 'recording'
        item.startedAt = isoNow()
      })
      log(`recording ${meeting.mode} with ${this.sources.map((source) => source.spec.channel).join(' and ')}`)
      this.startLiveWorker()
      await Promise.race([this.stopRequested, ...this.sources.map((source) => source.exited.then(() => this.unexpectedExit(source)))])
      await this.finish()
      return this.failure === null ? 0 : 1
    } catch (error) {
      const message = errorMessage(error)
      await this.shutdown()
      try {
        updateMeeting(this.dir, (item) => {
          item.status = 'failed'
          delete item.recorderPid
          item.error = message
        })
      } catch {
        undefined
      }
      log(`failed: ${message}`)
      return 1
    } finally {
      clearInterval(poll)
    }
  }

  private startSource(spec: SourceSpec): SourceState {
    const child = launch(spec.command, spec.args, 'pipe')
    const state: SourceState = {
      spec,
      process: child,
      format: spec.format,
      aligner: spec.format ? new FrameAligner(spec.format.channels) : null,
      encoder: null,
      pending: [],
      startedAt: null,
      exited: waitExit(child),
      exitCode: undefined,
      stderr: '',
    }
    void state.exited.then((code) => {
      state.exitCode = code
    })
    child.stdin?.on('error', () => undefined)
    let partial = ''
    child.stderr?.setEncoding('utf8').on('data', (text: string) => {
      state.stderr = suffix(state.stderr + text, 4000)
      partial += text
      const lines = partial.split('\n')
      partial = lines.pop() ?? ''
      for (const line of lines) {
        const format = state.format === null ? startedEvent(line.trim()) : null
        if (format) {
          state.format = format
          state.aligner = new FrameAligner(format.channels)
          for (const chunk of state.pending.splice(0)) this.consume(state, chunk)
        } else if (line.trim().length > 0) {
          this.options.log(`${spec.channel}: ${line.trim()}`)
        }
      }
    })
    child.stdout?.on('data', (chunk: Buffer) => {
      if (state.format === null) state.pending.push(chunk)
      else this.consume(state, chunk)
    })
    return state
  }

  private consume(state: SourceState, chunk: Buffer): void {
    const format = state.format
    const aligner = state.aligner
    if (!format || !aligner) return
    const pcm = aligner.push(chunk)
    if (pcm.length === 0) return
    if (state.startedAt === null) {
      const now = Date.now()
      state.startedAt = now
      this.origin ??= now
      state.encoder = this.startEncoder(state.spec.channel, format)
      this.tap?.open(state.spec.channel, format.rate, now - this.origin)
    }
    state.encoder?.stdin?.write(pcm)
    this.tap?.append(state.spec.channel, downmix(pcm, format.channels))
  }

  private startEncoder(channel: Channel, format: PcmFormat): ChildProcess {
    const encoder = launch(this.options.ffmpeg, encoderArguments(channel, format, intermediateFile(this.dir, channel)), 'ignore')
    encoder.stdin?.on('error', () => undefined)
    encoder.stderr?.setEncoding('utf8').on('data', (text: string) => {
      for (const line of text.split('\n')) if (line.trim().length > 0) this.options.log(`${channel} encoder: ${line.trim()}`)
    })
    return encoder
  }

  private async waitStarted(): Promise<void> {
    const started = await waitUntil((this.options.startTimeoutMs ?? 20_000) / 1000, 0.05, () => {
      const dead = this.sources.find((source) => source.exitCode !== undefined && source.startedAt === null)
      if (dead) throw new RecapError('CAPTURE_FAILED', `The ${dead.spec.channel} capture exited before recording: ${trimmed(dead.stderr) || `exit ${dead.exitCode}`}`)
      return this.sources.every((source) => source.startedAt !== null)
    })
    if (!started) {
      const waiting = this.sources.filter((source) => source.startedAt === null).map((source) => source.spec.channel)
      throw new RecapError('CAPTURE_TIMEOUT', `No audio arrived from ${waiting.join(' and ')}`)
    }
  }

  private unexpectedExit(source: SourceState): void {
    if (this.stopping) return
    this.failure = `The ${source.spec.channel} capture stopped by itself: ${trimmed(source.stderr) || `exit ${source.exitCode}`}`
  }

  private startLiveWorker(): void {
    const command = this.options.liveWorker
    if (!this.tap || !command || command.length === 0) return
    const [executable, ...args] = command
    if (!executable) return
    try {
      const pid = spawnDetached(executable, [...args, this.dir], liveFiles.workerLog(this.dir))
      this.options.log(`live worker ${pid}`)
    } catch (error) {
      this.options.log(`live worker not started: ${errorMessage(error)}`)
    }
  }

  private async stopSources(): Promise<void> {
    this.stopping = true
    for (const source of this.sources) {
      if (source.exitCode !== undefined) continue
      source.process.stdin?.write('q')
      source.process.stdin?.end()
    }
    const timeout = this.options.stopTimeoutMs ?? 10_000
    const exited = await waitUntil(timeout / 1000, 0.05, () => this.sources.every((source) => source.exitCode !== undefined))
    if (!exited) {
      for (const source of this.sources) {
        if (source.exitCode === undefined && source.process.pid !== undefined) signalTree(source.process.pid, 'SIGKILL')
      }
      await Promise.all(this.sources.map((source) => source.exited))
    }
  }

  private async stopEncoders(): Promise<void> {
    const encoders = this.sources.map((source) => source.encoder).filter((encoder): encoder is ChildProcess => encoder !== null)
    for (const encoder of encoders) encoder.stdin?.end()
    const done = Promise.all(encoders.map(waitExit))
    const timeout = new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), this.options.stopTimeoutMs ?? 10_000).unref())
    if ((await Promise.race([done, timeout])) === 'timeout') {
      for (const encoder of encoders) if (encoder.pid !== undefined && encoder.exitCode === null) signalTree(encoder.pid, 'SIGKILL')
    }
  }

  private async shutdown(): Promise<void> {
    await this.stopSources()
    await this.stopEncoders()
  }

  private async finish(): Promise<void> {
    await this.shutdown()
    try {
      this.tap?.finish()
    } catch (error) {
      this.options.log(`live tap: ${errorMessage(error)}`)
    }
    const meeting = loadMeeting(this.dir)
    const output = path.join(this.dir, AUDIO_FILE)
    let muxError: string | null = null
    const recorded = this.sources.filter((source) => source.startedAt !== null && existsSync(intermediateFile(this.dir, source.spec.channel)))
    if (recorded.length === this.sources.length && recorded.length > 0) {
      const inputs = recorded.map((source) => ({ file: intermediateFile(this.dir, source.spec.channel), offsetMs: (source.startedAt ?? 0) - (this.origin ?? 0) }))
      const result = await exec(this.options.ffmpeg, muxArguments(inputs, output))
      if (result.status === 0 && existsSync(output)) rmSync(path.join(this.dir, CAPTURE_DIR), { recursive: true, force: true })
      else muxError = `Cannot write ${path.basename(output)}: ${trimmed(result.stderr) || `exit ${result.status}`}`
    } else {
      muxError = 'The capture produced no audio'
    }
    const error = this.failure ?? muxError
    updateMeeting(this.dir, (item) => {
      item.status = existsSync(output) ? 'recorded' : 'failed'
      item.endedAt = isoNow()
      delete item.recorderPid
      if (error) item.error = error
    })
    this.options.log(error ? `stopped with error: ${error}` : `stopped; wrote ${path.basename(output)} for the ${meeting.mode} meeting`)
    if (muxError) this.failure = muxError
  }
}
