import { existsSync, mkdirSync, rmSync, statSync } from 'node:fs'
import path from 'node:path'
import type { Config } from '../core/config.ts'
import { loadConfig, settingsOf, whisperModelPath } from '../core/config.ts'
import { readText, writeAtomic } from '../core/fsutil.ts'
import { isRecord } from '../core/json.ts'
import { ProcessLock } from '../core/lock.ts'
import { isActiveStatus, loadMeeting, reconcile, type Meeting } from '../core/meeting.ts'
import { configFile } from '../core/paths.ts'
import { exec, sleep } from '../core/proc.ts'
import { selfCommand } from '../core/self.ts'
import { suffix, trimmed } from '../core/text.ts'
import { requireTool } from '../core/tools.ts'
import { RecapError, errorMessage } from '../errors.ts'
import { resultText, runClaude } from '../pipeline/claude.ts'
import { whisperArguments } from '../pipeline/pipeline.ts'
import { parseWhisper, type Channel, type Segment } from '../pipeline/transcript.ts'
import { pruneBoard } from './asking.ts'
import { meetingContext } from './context.ts'
import { AutoAskProcess, AutoAskQueue, QuestionDetector, readTranscript, saveCursor } from './detector.ts'
import { appendLines, liveFiles, readLines } from './files.ts'
import { LiveMerger } from './merger.ts'

export const LIVE_THREADS = 4
export const PROMPT_CHARACTERS = 220
export const PRUNE_SECONDS = 5

export interface ChunkIndexEntry {
  file?: string | undefined
  channel: Channel
  seq: number
  startMs: number
  endMs: number
}

export function decodeChunk(value: unknown): ChunkIndexEntry | null {
  if (!isRecord(value)) return null
  const { channel, seq, startMs, endMs, file } = value
  if (channel !== 'mic' && channel !== 'system') return null
  if (typeof seq !== 'number' || typeof startMs !== 'number' || typeof endMs !== 'number') return null
  if (file !== undefined && file !== null && typeof file !== 'string') return null
  return { file: typeof file === 'string' ? file : undefined, channel, seq, startMs, endMs }
}

export function liveWhisperArguments(config: Config, model: string, outputBase: string, wav: string, previous?: string | null): string[] {
  return whisperArguments(config, model, outputBase, wav, LIVE_THREADS, previous)
}

export type DetectorFactory = (dir: string, meeting: Meeting) => QuestionDetector | null

function modifiedAt(file: string): number | null {
  try {
    return statSync(file).mtimeMs
  } catch {
    return null
  }
}

export function autoAskWatcher(initial: Config, file: string = configFile()): () => boolean {
  let stamp = modifiedAt(file)
  let enabled = settingsOf(initial).autoAsk
  return () => {
    const current = modifiedAt(file)
    if (current !== stamp) {
      stamp = current
      try {
        enabled = settingsOf(loadConfig()).autoAsk
      } catch {
        return enabled
      }
    }
    return enabled
  }
}

export function skipToTranscriptEnd(meetingDir: string): void {
  const segments = readTranscript(meetingDir)
  saveCursor(meetingDir, { detectedThroughMs: segments.reduce((end, segment) => Math.max(end, segment.endMs), 0), examinedSegments: segments.length })
}

export class DetectorSwitch {
  private detector: QuestionDetector | null = null
  private synced = false

  readonly dir: string
  readonly meeting: Meeting
  readonly factory: DetectorFactory | null
  readonly enabled: () => boolean
  readonly log: (line: string) => void
  readonly describe: () => string

  constructor(dir: string, meeting: Meeting, factory: DetectorFactory | null, enabled: () => boolean, log: (line: string) => void, describe: () => string = () => '') {
    this.dir = dir
    this.meeting = meeting
    this.factory = factory
    this.enabled = enabled
    this.log = log
    this.describe = describe
  }

  get current(): QuestionDetector | null {
    return this.detector
  }

  async sync(): Promise<void> {
    if (!this.factory) return
    const wanted = this.enabled()
    if (wanted && !this.detector) {
      if (this.synced) skipToTranscriptEnd(this.dir)
      this.detector = this.factory(this.dir, this.meeting)
      if (this.detector) this.log(`question detector on${this.describe()}`)
    } else if (!wanted && this.detector) {
      const detector = this.detector
      this.detector = null
      await detector.stop()
      this.log('question detector off')
    }
    this.synced = true
  }

  async stop(): Promise<void> {
    const detector = this.detector
    this.detector = null
    await detector?.stop()
  }
}

export class LiveWorker {
  readonly dir: string
  readonly config: Config
  readonly log: (line: string) => void
  readonly pollSeconds: number
  readonly detectorFactory: DetectorFactory | null
  readonly autoAskEnabled: () => boolean
  private previousText: Partial<Record<Channel, string>> = {}

  constructor(dir: string, config: Config, log: (line: string) => void, options: { pollSeconds?: number; detectorFactory?: DetectorFactory | null; autoAskEnabled?: () => boolean } = {}) {
    this.dir = dir
    this.config = config
    this.log = log
    this.pollSeconds = options.pollSeconds ?? 1
    this.detectorFactory = options.detectorFactory ?? null
    this.autoAskEnabled = options.autoAskEnabled ?? autoAskWatcher(config)
  }

  private loadState(): number {
    const text = readText(liveFiles.workerState(this.dir))
    if (text === null) return 0
    try {
      const value = JSON.parse(text) as unknown
      return isRecord(value) && typeof value['processed'] === 'number' ? value['processed'] : 0
    } catch {
      return 0
    }
  }

  private isRecording(): boolean {
    try {
      return isActiveStatus(reconcile(loadMeeting(this.dir), this.dir).status)
    } catch {
      return false
    }
  }

  async run(): Promise<void> {
    mkdirSync(liveFiles.dir(this.dir), { recursive: true })
    const lock = new ProcessLock(liveFiles.workerLock(this.dir))
    let detectors: DetectorSwitch | null = null
    try {
      const meeting = loadMeeting(this.dir)
      const whisper = await requireTool('whisper-cli', this.config)
      const model = whisperModelPath(this.config)
      if (!existsSync(model)) throw new RecapError('MODEL_MISSING', `Whisper model not found at ${model}. Run \`recap setup\`.`)
      const settings = settingsOf(this.config)
      const merger = new LiveMerger(meeting.mode === 'remote', settings.maxChunkSeconds + 10)
      let processed = this.loadState()
      this.log(`live worker started at chunk ${processed}`)
      detectors = new DetectorSwitch(this.dir, meeting, this.detectorFactory, this.autoAskEnabled, this.log, () => {
        const current = this.currentSettings()
        return ` (model ${current.autoAskModel}, every ${current.autoAskMinSeconds} s at most, ${current.autoAskConcurrency} answers at a time)`
      })
      const switcher = detectors
      pruneBoard(this.dir)
      let lastPrune = Date.now()
      let finalPass = false
      for (;;) {
        await switcher.sync()
        switcher.current?.tick()
        if ((Date.now() - lastPrune) / 1000 >= PRUNE_SECONDS) {
          pruneBoard(this.dir)
          lastPrune = Date.now()
        }
        const entries = readLines(liveFiles.chunkIndex(this.dir), decodeChunk)
        if (entries.length > processed) {
          for (const entry of entries.slice(processed)) {
            const segments = await this.transcribe(entry, whisper, model)
            const ready = entry.file === undefined ? merger.advance(entry.channel, entry.endMs, Date.now()) : merger.add(segments, entry.channel, entry.endMs, Date.now())
            appendLines(ready, liveFiles.transcript(this.dir))
            if (ready.length > 0) switcher.current?.transcriptGrew()
            processed += 1
            writeAtomic(liveFiles.workerState(this.dir), JSON.stringify({ processed }))
            await switcher.sync()
            switcher.current?.tick()
          }
          finalPass = false
          continue
        }
        const released = merger.release(Date.now(), false)
        appendLines(released, liveFiles.transcript(this.dir))
        if (released.length > 0) switcher.current?.transcriptGrew()
        if (!this.isRecording()) {
          if (finalPass) break
          finalPass = true
          continue
        }
        await sleep(this.pollSeconds * 1000)
      }
      appendLines(merger.release(Date.now(), true), liveFiles.transcript(this.dir))
      this.log(`live worker finished after ${processed} chunks`)
    } finally {
      await detectors?.stop()
      lock.release()
    }
  }

  private currentSettings() {
    try {
      return settingsOf(loadConfig())
    } catch {
      return settingsOf(this.config)
    }
  }

  private async transcribe(entry: ChunkIndexEntry, whisper: string, model: string): Promise<Segment[]> {
    if (entry.file === undefined) return []
    const wav = path.join(liveFiles.chunks(this.dir), entry.file)
    if (!existsSync(wav)) return []
    const base = wav.replace(/\.[^./\\]+$/, '')
    const json = `${base}.json`
    try {
      const result = await exec(whisper, liveWhisperArguments(this.config, model, base, wav, this.previousText[entry.channel]))
      if (result.status !== 0) {
        this.log(`whisper failed on ${entry.file}: ${suffix(trimmed(result.stderr), 300)}`)
        return []
      }
      const text = readText(json)
      if (text === null) throw new Error(`${json} was not written`)
      const segments = parseWhisper(text, entry.channel).map((segment) => ({
        ...segment,
        startMs: segment.startMs + entry.startMs,
        endMs: Math.min(segment.endMs + entry.startMs, Math.max(entry.endMs, segment.startMs + entry.startMs)),
      }))
      if (segments.length > 0) {
        const joined = trimmed(`${this.previousText[entry.channel] ?? ''} ${segments.map((segment) => segment.text).join(' ')}`)
        this.previousText[entry.channel] = suffix(joined, PROMPT_CHARACTERS)
      }
      return segments
    } catch (error) {
      this.log(`whisper failed on ${entry.file}: ${errorMessage(error)}`)
      return []
    } finally {
      rmSync(json, { force: true })
    }
  }
}

export function makeLiveDetector(dir: string, meeting: Meeting, config: Config, log: (line: string) => void): QuestionDetector | null {
  const settings = settingsOf(config)
  const runner = new AutoAskProcess(dir, selfCommand())
  const asks = new AutoAskQueue({ dir, concurrency: settings.autoAskConcurrency, run: (job) => runner.run(job), cancelRunning: () => runner.cancel(), log })
  return new QuestionDetector(dir, meeting, settings.autoAskMinSeconds, {
    context: () => meetingContext(meeting, config),
    complete: async (prompt) => resultText(await runClaude({ prompt, cwd: dir, config, tools: [], addDirs: [], model: settings.autoAskModel, restrictTools: [] })),
    enqueue: (question, origin) => {
      asks.enqueue(question, origin)
    },
    cancelAsks: () => asks.cancelAll(),
    log,
  })
}

