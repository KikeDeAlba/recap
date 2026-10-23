const f = Math.fround

export const SAMPLE_RATE = 16_000
export const FRAME_SAMPLES = 480

export interface LiveChunk {
  seq: number
  startMs: number
  endMs: number
  samples: Float32Array
  hasSpeech: boolean
}

export interface ChunkerOptions {
  minSeconds?: number
  maxSeconds?: number
  silenceSeconds?: number
  minThreshold?: number
  maxNoiseFloor?: number
  gapToleranceMs?: number
}

export function samplesToMs(samples: number): number {
  return Math.trunc((samples * 1000) / SAMPLE_RATE)
}

export function rms(samples: Float32Array, begin = 0, end = samples.length): number {
  if (end <= begin) return 0
  let sum = f(0)
  for (let index = begin; index < end; index += 1) {
    const sample = samples[index] ?? 0
    sum = f(sum + f(sample * sample))
  }
  return f(Math.sqrt(f(sum / f(end - begin))))
}

class SampleBuffer {
  private data = new Float32Array(SAMPLE_RATE)
  private length = 0

  get count(): number {
    return this.length
  }

  get view(): Float32Array {
    return this.data.subarray(0, this.length)
  }

  append(samples: Float32Array): void {
    if (this.length + samples.length > this.data.length) {
      const grown = new Float32Array(Math.max(this.data.length * 2, this.length + samples.length))
      grown.set(this.view)
      this.data = grown
    }
    this.data.set(samples, this.length)
    this.length += samples.length
  }

  removeFirst(count: number): void {
    this.data.copyWithin(0, count, this.length)
    this.length -= count
  }
}

export class LiveChunker {
  readonly minSamples: number
  readonly maxSamples: number
  readonly silenceFrames: number
  readonly minSpeechFrames = 5
  readonly minThreshold: number
  readonly maxNoiseFloor: number
  readonly gapToleranceMs: number

  private readonly buffer = new SampleBuffer()
  private energies: number[] = []
  private bufferStartMs: number | null = null
  private trailingSilent = 0
  private noiseFloor: number | null = null
  private nextSeq = 1

  constructor(options: ChunkerOptions = {}) {
    const minSeconds = options.minSeconds ?? 3
    const maxSeconds = options.maxSeconds ?? 10
    const silenceSeconds = options.silenceSeconds ?? 0.6
    this.minSamples = Math.trunc(minSeconds * SAMPLE_RATE)
    this.maxSamples = Math.max(Math.trunc(maxSeconds * SAMPLE_RATE), this.minSamples + FRAME_SAMPLES)
    this.silenceFrames = Math.max(1, Math.round((silenceSeconds * SAMPLE_RATE) / FRAME_SAMPLES))
    this.minThreshold = f(options.minThreshold ?? 0.006)
    this.maxNoiseFloor = f(options.maxNoiseFloor ?? 0.015)
    this.gapToleranceMs = options.gapToleranceMs ?? 1_000
  }

  get threshold(): number {
    return Math.max(this.minThreshold, f((this.noiseFloor ?? 0) * 3))
  }

  append(samples: Float32Array, atMs: number): LiveChunk[] {
    const chunks: LiveChunk[] = []
    if (this.bufferStartMs !== null) {
      const expected = this.bufferStartMs + samplesToMs(this.buffer.count)
      if (atMs - expected > this.gapToleranceMs) {
        chunks.push(...this.cutAll())
        this.bufferStartMs = atMs
      }
    } else {
      this.bufferStartMs = atMs
    }
    this.buffer.append(samples)
    while (this.energies.length * FRAME_SAMPLES + FRAME_SAMPLES <= this.buffer.count) {
      const begin = this.energies.length * FRAME_SAMPLES
      const energy = rms(this.buffer.view, begin, begin + FRAME_SAMPLES)
      this.energies.push(energy)
      this.track(energy)
      const chunk = this.cutIfReady()
      if (chunk) chunks.push(chunk)
    }
    return chunks
  }

  flush(): LiveChunk[] {
    return this.cutAll()
  }

  private cutAll(): LiveChunk[] {
    if (this.buffer.count === 0) return []
    const chunk = this.cut(this.buffer.count)
    this.bufferStartMs = null
    return [chunk]
  }

  private track(energy: number): void {
    const floor = this.noiseFloor ?? f(this.minThreshold / 3)
    const next = energy < floor ? energy : f(floor + f(f(energy - floor) * f(0.0005)))
    this.noiseFloor = Math.min(this.maxNoiseFloor, Math.max(f(0.0005), next))
    this.trailingSilent = energy < this.threshold ? this.trailingSilent + 1 : 0
  }

  private cutIfReady(): LiveChunk | null {
    const length = this.energies.length * FRAME_SAMPLES
    if (length >= this.minSamples && this.trailingSilent >= this.silenceFrames) return this.cut(length)
    if (length >= this.maxSamples) {
      const half = Math.trunc(this.energies.length / 2)
      let quietest = this.energies.length - 1
      for (let index = half; index < this.energies.length; index += 1) {
        if ((this.energies[index] ?? 0) < (this.energies[quietest] ?? 0)) quietest = index
      }
      return this.cut((quietest + 1) * FRAME_SAMPLES)
    }
    return null
  }

  private cut(sampleCount: number): LiveChunk {
    const count = Math.min(sampleCount, this.buffer.count)
    const frames = Math.min(this.energies.length, Math.trunc(count / FRAME_SAMPLES))
    const start = this.bufferStartMs ?? 0
    const level = this.threshold
    let speechFrames = 0
    for (let index = 0; index < frames; index += 1) if ((this.energies[index] ?? 0) >= this.minThreshold) speechFrames += 1
    const partialSpeech = frames === 0 && rms(this.buffer.view, 0, count) >= this.minThreshold
    const chunk: LiveChunk = {
      seq: this.nextSeq,
      startMs: start,
      endMs: start + samplesToMs(count),
      samples: this.buffer.view.slice(0, count),
      hasSpeech: speechFrames >= this.minSpeechFrames || partialSpeech,
    }
    this.nextSeq += 1
    this.buffer.removeFirst(count)
    this.energies = this.energies.slice(frames)
    this.bufferStartMs = start + samplesToMs(count)
    let silent = 0
    for (let index = this.energies.length - 1; index >= 0; index -= 1) {
      if ((this.energies[index] ?? 0) >= level) break
      silent += 1
    }
    this.trailingSilent = silent
    return chunk
  }
}
