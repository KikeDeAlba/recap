import { existsSync, mkdirSync, rmSync } from 'node:fs'
import path from 'node:path'
import type { Config } from '../core/config.ts'
import { settingsOf, whisperModelPath } from '../core/config.ts'
import { readText, writeAtomic } from '../core/fsutil.ts'
import { isRecord } from '../core/json.ts'
import { ProcessLock } from '../core/lock.ts'
import { isActiveStatus, loadMeeting, reconcile, type Meeting } from '../core/meeting.ts'
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
import { AutoAskProcess, AutoAskQueue, QuestionDetector } from './detector.ts'
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

export class LiveWorker {
  readonly dir: string
  readonly config: Config
  readonly log: (line: string) => void
  readonly pollSeconds: number
  readonly detectorFactory: DetectorFactory | null
  private previousText: Partial<Record<Channel, string>> = {}

  constructor(dir: string, config: Config, log: (line: string) => void, options: { pollSeconds?: number; detectorFactory?: DetectorFactory | null } = {}) {
    this.dir = dir
    this.config = config
    this.log = log
    this.pollSeconds = options.pollSeconds ?? 1
    this.detectorFactory = options.detectorFactory ?? null
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
    let detector: QuestionDetector | null = null
    try {
      const meeting = loadMeeting(this.dir)
      const whisper = await requireTool('whisper-cli', this.config)
      const model = whisperModelPath(this.config)
      if (!existsSync(model)) throw new RecapError('MODEL_MISSING', `Whisper model not found at ${model}. Run \`recap setup\`.`)
      const settings = settingsOf(this.config)
      const merger = new LiveMerger(meeting.mode === 'remote', settings.maxChunkSeconds + 10)
      let processed = this.loadState()
      this.log(`live worker started at chunk ${processed}`)
      detector = this.detectorFactory?.(this.dir, meeting) ?? null
      if (detector) {
        this.log(`question detector on (model ${settings.autoAskModel}, every ${settings.autoAskMinSeconds} s at most, ${settings.autoAskConcurrency} answers at a time)`)
      }
      pruneBoard(this.dir)
      let lastPrune = Date.now()
      let finalPass = false
      for (;;) {
        detector?.tick()
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
            if (ready.length > 0) detector?.transcriptGrew()
            processed += 1
            writeAtomic(liveFiles.workerState(this.dir), JSON.stringify({ processed }))
            detector?.tick()
          }
          finalPass = false
          continue
        }
        const released = merger.release(Date.now(), false)
        appendLines(released, liveFiles.transcript(this.dir))
        if (released.length > 0) detector?.transcriptGrew()
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
      await detector?.stop()
      lock.release()
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
  if (!settings.autoAsk) return null
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

