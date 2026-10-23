import { renameSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'

export const BYTES_PER_SAMPLE = 2

export function downmix(pcm: Buffer, channels: number): Float32Array {
  const frames = Math.floor(pcm.length / (BYTES_PER_SAMPLE * channels))
  const mono = new Float32Array(frames)
  for (let frame = 0; frame < frames; frame += 1) {
    let sum = 0
    for (let channel = 0; channel < channels; channel += 1) sum += pcm.readInt16LE((frame * channels + channel) * BYTES_PER_SAMPLE)
    mono[frame] = sum / channels / 32_768
  }
  return mono
}

export class FrameAligner {
  private pending: Buffer = Buffer.alloc(0)
  readonly frameBytes: number

  constructor(channels: number) {
    this.frameBytes = channels * BYTES_PER_SAMPLE
  }

  push(chunk: Buffer): Buffer {
    const joined = this.pending.length === 0 ? chunk : Buffer.concat([this.pending, chunk])
    const usable = joined.length - (joined.length % this.frameBytes)
    this.pending = Buffer.from(joined.subarray(usable))
    return joined.subarray(0, usable)
  }
}

export class Resampler {
  readonly inputRate: number
  readonly outputRate: number
  private readonly step: number
  private readonly width: number
  private history: number[] = []
  private position = 0
  private previous = 0

  constructor(inputRate: number, outputRate: number) {
    this.inputRate = inputRate
    this.outputRate = outputRate
    this.step = inputRate / outputRate
    this.width = Math.max(1, Math.round(this.step))
  }

  process(input: Float32Array): Float32Array {
    if (this.inputRate === this.outputRate) return input
    const filtered = new Float32Array(input.length)
    for (let index = 0; index < input.length; index += 1) {
      this.history.push(input[index] ?? 0)
      if (this.history.length > this.width) this.history.shift()
      let sum = 0
      for (const value of this.history) sum += value
      filtered[index] = sum / this.history.length
    }
    const output: number[] = []
    while (this.position < filtered.length) {
      const base = Math.floor(this.position)
      const fraction = this.position - base
      const left = base < 0 ? this.previous : (filtered[base] ?? 0)
      const right = filtered[base + 1] ?? left
      output.push(left + (right - left) * fraction)
      this.position += this.step
    }
    this.position -= filtered.length
    if (filtered.length > 0) this.previous = filtered[filtered.length - 1] ?? 0
    return Float32Array.from(output)
  }
}

function roundHalfAway(value: number): number {
  return Math.sign(value) * Math.round(Math.abs(value))
}

export function encodeWav(samples: Float32Array, sampleRate: number): Buffer {
  const dataBytes = samples.length * BYTES_PER_SAMPLE
  const buffer = Buffer.alloc(44 + dataBytes)
  buffer.write('RIFF', 0, 'ascii')
  buffer.writeUInt32LE(36 + dataBytes, 4)
  buffer.write('WAVE', 8, 'ascii')
  buffer.write('fmt ', 12, 'ascii')
  buffer.writeUInt32LE(16, 16)
  buffer.writeUInt16LE(1, 20)
  buffer.writeUInt16LE(1, 22)
  buffer.writeUInt32LE(sampleRate, 24)
  buffer.writeUInt32LE(sampleRate * BYTES_PER_SAMPLE, 28)
  buffer.writeUInt16LE(BYTES_PER_SAMPLE, 32)
  buffer.writeUInt16LE(16, 34)
  buffer.write('data', 36, 'ascii')
  buffer.writeUInt32LE(dataBytes, 40)
  for (let index = 0; index < samples.length; index += 1) {
    const sample = samples[index] ?? 0
    const clamped = Math.max(-1, Math.min(1, Number.isFinite(sample) ? sample : 0))
    buffer.writeInt16LE(roundHalfAway(Math.fround(clamped * 32_767)), 44 + index * BYTES_PER_SAMPLE)
  }
  return buffer
}

export function writeWavAtomically(samples: Float32Array, sampleRate: number, file: string): void {
  const temporary = path.join(path.dirname(file), `.${path.basename(file)}.tmp`)
  writeFileSync(temporary, encodeWav(samples, sampleRate))
  try {
    renameSync(temporary, file)
  } catch (error) {
    rmSync(temporary, { force: true })
    throw error
  }
}
