import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'
import { FrameAligner, Resampler, downmix, encodeWav } from '../src/capture/audio.ts'
import { LiveChunker, samplesToMs } from '../src/capture/chunker.ts'
import { chunkFileName } from '../src/capture/live-tap.ts'

interface Segment {
  kind: string
  samples: number
  amp: number
  period?: number
  seed?: number
}

interface ParityCase {
  name: string
  options: { minSeconds?: number; maxSeconds?: number; silenceSeconds?: number }
  feeds: { segments: Segment[]; startMs: number; block: number }[]
  flush: boolean
  expected: { seq: number; startMs: number; endMs: number; count: number; hasSpeech: boolean }[]
}

function render(segment: Segment): Float32Array {
  const out = new Float32Array(segment.samples)
  let state = (segment.seed ?? 1) >>> 0
  const period = Math.max(2, segment.period ?? 2)
  for (let index = 0; index < segment.samples; index += 1) {
    let value = 0
    if (segment.kind === 'triangle') value = Math.trunc((segment.amp * (2 * Math.abs(2 * (index % period) - period) - period)) / period)
    else if (segment.kind === 'square') value = Math.trunc(index / Math.trunc(period / 2)) % 2 === 0 ? segment.amp : -segment.amp
    else if (segment.kind === 'alternate') value = index % 2 === 0 ? segment.amp : -segment.amp
    else if (segment.kind === 'noise') {
      state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0
      value = ((state >>> 16) % (2 * segment.amp + 1)) - segment.amp
    }
    out[index] = value / 32_768
  }
  return out
}

function concat(parts: Float32Array[]): Float32Array {
  const out = new Float32Array(parts.reduce((total, part) => total + part.length, 0))
  let offset = 0
  for (const part of parts) {
    out.set(part, offset)
    offset += part.length
  }
  return out
}

const fixture = JSON.parse(readFileSync(path.join(import.meta.dirname, 'fixtures', 'chunker-parity.json'), 'utf8')) as { cases: ParityCase[] }

for (const item of fixture.cases) {
  test(`chunker matches LiveChunker.swift: ${item.name}`, () => {
    const chunker = new LiveChunker(item.options)
    const chunks = []
    for (const feed of item.feeds) {
      const samples = concat(feed.segments.map(render))
      for (let offset = 0; offset < samples.length; offset += feed.block) {
        chunks.push(...chunker.append(samples.subarray(offset, Math.min(samples.length, offset + feed.block)), feed.startMs + samplesToMs(offset)))
      }
    }
    if (item.flush) chunks.push(...chunker.flush())
    assert.deepEqual(
      chunks.map((chunk) => ({ seq: chunk.seq, startMs: chunk.startMs, endMs: chunk.endMs, count: chunk.samples.length, hasSpeech: chunk.hasSpeech })),
      item.expected,
    )
  })
}

test('encodes 16-bit mono WAV like WavFile.swift', () => {
  const wav = encodeWav(Float32Array.from([0, 0.5, -0.5, 1, 2, Number.NaN]), 16_000)
  assert.equal(wav.toString('ascii', 0, 4), 'RIFF')
  assert.equal(wav.readUInt32LE(4), 36 + 12)
  assert.equal(wav.readUInt32LE(24), 16_000)
  assert.equal(wav.readUInt32LE(28), 32_000)
  assert.equal(wav.readUInt32LE(40), 12)
  assert.deepEqual([0, 1, 2, 3, 4, 5].map((index) => wav.readInt16LE(44 + index * 2)), [0, 16_384, -16_384, 32_767, 32_767, 0])
  assert.equal(chunkFileName('system', 12), 'system-00012.wav')
})

test('downmixes interleaved PCM, keeps whole frames and resamples to 16 kHz', () => {
  const pcm = Buffer.alloc(8)
  pcm.writeInt16LE(16_384, 0)
  pcm.writeInt16LE(0, 2)
  pcm.writeInt16LE(-16_384, 4)
  pcm.writeInt16LE(-16_384, 6)
  assert.deepEqual(Array.from(downmix(pcm, 2)), [0.25, -0.5])
  const aligner = new FrameAligner(2)
  assert.equal(aligner.push(Buffer.alloc(7)).length, 4)
  assert.equal(aligner.push(Buffer.alloc(1)).length, 4)
  const resampler = new Resampler(48_000, 16_000)
  let total = 0
  for (let block = 0; block < 10; block += 1) total += resampler.process(new Float32Array(4_801).fill(0.5)).length
  assert.ok(Math.abs(total - 16_003) <= 1, String(total))
  const constant = resampler.process(new Float32Array(300).fill(0.5))
  assert.ok(constant.every((value) => Math.abs(value - 0.5) < 1e-6))
  assert.equal(new Resampler(16_000, 16_000).process(Float32Array.from([1, 2])).length, 2)
})
