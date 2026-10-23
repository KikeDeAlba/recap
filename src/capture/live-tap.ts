import { mkdirSync } from 'node:fs'
import path from 'node:path'
import type { Channel } from '../pipeline/transcript.ts'
import { appendLines, liveFiles } from '../live/files.ts'
import { LiveChunker, SAMPLE_RATE, samplesToMs, type LiveChunk } from './chunker.ts'
import { Resampler, writeWavAtomically } from './audio.ts'

export interface ChunkIndexEntry {
  file?: string | undefined
  channel: Channel
  seq: number
  startMs: number
  endMs: number
}

export function chunkFileName(channel: Channel, seq: number): string {
  return `${channel}-${String(seq).padStart(5, '0')}.wav`
}

interface ChannelState {
  chunker: LiveChunker
  resampler: Resampler
  offsetMs: number
  fed: number
}

export class LiveTap {
  readonly dir: string
  private readonly chunksDir: string
  private readonly indexFile: string
  private readonly maxChunkSeconds: number
  private readonly channels = new Map<Channel, ChannelState>()
  private reportedError = false
  private readonly log: (line: string) => void

  constructor(meetingDir: string, maxChunkSeconds: number, log: (line: string) => void = () => undefined) {
    this.dir = meetingDir
    this.chunksDir = liveFiles.chunks(meetingDir)
    this.indexFile = liveFiles.chunkIndex(meetingDir)
    this.maxChunkSeconds = maxChunkSeconds
    this.log = log
    mkdirSync(this.chunksDir, { recursive: true })
  }

  open(channel: Channel, inputRate: number, offsetMs: number): void {
    this.channels.set(channel, {
      chunker: new LiveChunker({ maxSeconds: this.maxChunkSeconds }),
      resampler: new Resampler(inputRate, SAMPLE_RATE),
      offsetMs: Math.max(0, Math.round(offsetMs)),
      fed: 0,
    })
  }

  append(channel: Channel, samples: Float32Array): void {
    const state = this.channels.get(channel)
    if (!state) return
    const resampled = state.resampler.process(samples)
    if (resampled.length === 0) return
    const atMs = state.offsetMs + samplesToMs(state.fed)
    state.fed += resampled.length
    this.store(state.chunker.append(resampled, atMs), channel)
  }

  finish(): void {
    for (const [channel, state] of this.channels) this.store(state.chunker.flush(), channel)
  }

  private store(chunks: LiveChunk[], channel: Channel): void {
    for (const chunk of chunks) {
      try {
        const entry: ChunkIndexEntry = { channel, seq: chunk.seq, startMs: chunk.startMs, endMs: chunk.endMs }
        if (chunk.hasSpeech) {
          const name = chunkFileName(channel, chunk.seq)
          writeWavAtomically(chunk.samples, SAMPLE_RATE, path.join(this.chunksDir, name))
          entry.file = name
        }
        appendLines([entry], this.indexFile)
      } catch (error) {
        if (this.reportedError) continue
        this.reportedError = true
        this.log(`live tap: ${(error as Error).message}`)
      }
    }
  }
}
