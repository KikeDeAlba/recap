import { appendFileSync, mkdirSync } from 'node:fs'
import path from 'node:path'
import { readText } from '../core/fsutil.ts'
import { swiftLine } from '../core/json.ts'

export const LIVE_DIR = 'live'
export const CHUNKS_DIR = 'chunks'

export const liveFiles = {
  dir: (meetingDir: string) => path.join(meetingDir, LIVE_DIR),
  chunks: (meetingDir: string) => path.join(meetingDir, LIVE_DIR, CHUNKS_DIR),
  chunkIndex: (meetingDir: string) => path.join(meetingDir, LIVE_DIR, CHUNKS_DIR, 'index.jsonl'),
  transcript: (meetingDir: string) => path.join(meetingDir, LIVE_DIR, 'transcript.jsonl'),
  answers: (meetingDir: string) => path.join(meetingDir, LIVE_DIR, 'answers.jsonl'),
  workerLock: (meetingDir: string) => path.join(meetingDir, LIVE_DIR, 'worker.pid'),
  workerState: (meetingDir: string) => path.join(meetingDir, LIVE_DIR, 'worker-state.json'),
  detectorState: (meetingDir: string) => path.join(meetingDir, LIVE_DIR, 'detector-state.json'),
  asking: (meetingDir: string) => path.join(meetingDir, LIVE_DIR, 'asking.json'),
  askingDir: (meetingDir: string) => path.join(meetingDir, LIVE_DIR, 'asking'),
  workerLog: (meetingDir: string) => path.join(meetingDir, LIVE_DIR, 'worker.log'),
}

export function jsonLine(value: unknown): string {
  return swiftLine(value)
}

export function appendLines(values: readonly unknown[], file: string): void {
  if (values.length === 0) return
  mkdirSync(path.dirname(file), { recursive: true })
  appendFileSync(file, values.map((value) => `${jsonLine(value)}\n`).join(''))
}

export function parseLines<T>(text: string, decode: (value: unknown) => T | null): T[] {
  const result: T[] = []
  for (const line of text.split('\n')) {
    if (line.trim().length === 0) continue
    try {
      const decoded = decode(JSON.parse(line) as unknown)
      if (decoded !== null) result.push(decoded)
    } catch {
      continue
    }
  }
  return result
}

export function readLines<T>(file: string, decode: (value: unknown) => T | null): T[] {
  const text = readText(file)
  return text === null ? [] : parseLines(text, decode)
}
