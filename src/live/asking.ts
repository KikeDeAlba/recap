import { randomUUID } from 'node:crypto'
import { existsSync, readdirSync, rmSync, statSync } from 'node:fs'
import path from 'node:path'
import { parseDate } from '../core/dates.ts'
import { readText, writeAtomic } from '../core/fsutil.ts'
import { isRecord, swiftLine } from '../core/json.ts'
import { withDirectoryLock } from '../core/lock.ts'
import { isAlive } from '../core/proc.ts'
import { RecapError } from '../errors.ts'
import type { Channel } from '../pipeline/transcript.ts'
import { liveFiles } from './files.ts'

export type AskPhase = 'queued' | 'running'

export interface AskingState {
  id?: string | undefined
  question: string | null
  startedAt: string
  auto: boolean
  questionMs?: number | undefined
  channel?: Channel | undefined
  state?: AskPhase | undefined
  pid?: number | undefined
}

export function decodeAskingState(value: unknown): AskingState | null {
  if (!isRecord(value) || typeof value['startedAt'] !== 'string' || parseDate(value['startedAt']) === null) return null
  if (value['id'] !== undefined && value['id'] !== null && typeof value['id'] !== 'string') return null
  if (value['question'] !== undefined && value['question'] !== null && typeof value['question'] !== 'string') return null
  return {
    id: typeof value['id'] === 'string' ? value['id'] : undefined,
    question: typeof value['question'] === 'string' ? value['question'] : null,
    startedAt: value['startedAt'],
    auto: value['auto'] === true,
    questionMs: typeof value['questionMs'] === 'number' && Number.isInteger(value['questionMs']) ? value['questionMs'] : undefined,
    channel: value['channel'] === 'mic' || value['channel'] === 'system' ? value['channel'] : undefined,
    state: value['state'] === 'queued' || value['state'] === 'running' ? value['state'] : undefined,
    pid: typeof value['pid'] === 'number' && Number.isInteger(value['pid']) ? value['pid'] : undefined,
  }
}

export function encodeAskingState(state: AskingState): string {
  return swiftLine({
    id: state.id,
    question: state.question,
    startedAt: state.startedAt,
    auto: state.auto,
    questionMs: state.questionMs,
    channel: state.channel,
    state: state.state,
    pid: state.pid,
  })
}

export function isRunningAsk(state: AskingState): boolean {
  return state.state !== 'queued'
}

export function readLegacyAsking(meetingDir: string): AskingState | null {
  const text = readText(liveFiles.asking(meetingDir))
  if (text === null) return null
  try {
    return decodeAskingState(JSON.parse(text) as unknown)
  } catch {
    return null
  }
}

export function makeAskId(): string {
  return randomUUID().toLowerCase()
}

export function isValidAskId(id: string): boolean {
  return id.length > 0 && id.length <= 64 && !id.startsWith('-') && /^[a-z0-9-]+$/.test(id)
}

function boardFile(meetingDir: string, id: string): string {
  return path.join(liveFiles.askingDir(meetingDir), `${id}.json`)
}

function lockDir(meetingDir: string): string {
  return path.join(liveFiles.askingDir(meetingDir), '.board.lock')
}

interface Stored {
  file: string
  state: AskingState
  alive: boolean
}

function stored(meetingDir: string): Stored[] {
  const folder = liveFiles.askingDir(meetingDir)
  let names: string[] = []
  try {
    names = readdirSync(folder).filter((name) => name.endsWith('.json') && !name.startsWith('.'))
  } catch {
    return []
  }
  const found: (Stored & { modified: number })[] = []
  for (const name of names) {
    const file = path.join(folder, name)
    const text = readText(file)
    if (text === null) continue
    let state: AskingState | null = null
    try {
      state = decodeAskingState(JSON.parse(text) as unknown)
    } catch {
      state = null
    }
    if (!state) continue
    let modified = 0
    try {
      modified = statSync(file).mtimeMs
    } catch {
      modified = 0
    }
    found.push({ file, state, alive: state.pid === undefined ? true : isAlive(state.pid), modified })
  }
  return found
    .sort((left, right) => (left.modified === right.modified ? (left.file < right.file ? -1 : left.file > right.file ? 1 : 0) : left.modified - right.modified))
    .map(({ file, state, alive }) => ({ file, state, alive }))
}

export function boardEntries(meetingDir: string): AskingState[] {
  return stored(meetingDir)
    .filter((item) => item.alive)
    .map((item) => item.state)
}

export function latestRunning(entries: readonly AskingState[]): AskingState | null {
  let winner: { state: AskingState; time: number } | null = null
  for (const state of entries) {
    if (!isRunningAsk(state)) continue
    const time = parseDate(state.startedAt)?.getTime() ?? 0
    if (!winner || time >= winner.time) winner = { state, time }
  }
  return winner?.state ?? null
}

function refreshLegacy(meetingDir: string): void {
  const legacy = liveFiles.asking(meetingDir)
  const latest = latestRunning(boardEntries(meetingDir))
  if (!latest) {
    rmSync(legacy, { force: true })
    return
  }
  writeAtomic(legacy, encodeAskingState(latest))
}

export function writeBoard(meetingDir: string, state: AskingState): void {
  if (!state.id || !isValidAskId(state.id)) throw new RecapError('ASK_ID_INVALID', `Invalid ask id ${state.id ?? '(none)'}`)
  const id = state.id
  withDirectoryLock(lockDir(meetingDir), () => {
    writeAtomic(boardFile(meetingDir, id), encodeAskingState(state))
    refreshLegacy(meetingDir)
  })
}

export function removeBoard(meetingDir: string, id: string): void {
  if (!isValidAskId(id)) return
  try {
    withDirectoryLock(lockDir(meetingDir), () => {
      rmSync(boardFile(meetingDir, id), { force: true })
      refreshLegacy(meetingDir)
    })
  } catch {
    return
  }
}

export function pruneBoard(meetingDir: string): void {
  if (!existsSync(liveFiles.askingDir(meetingDir))) return
  try {
    withDirectoryLock(lockDir(meetingDir), () => {
      for (const item of stored(meetingDir)) if (!item.alive) rmSync(item.file, { force: true })
      refreshLegacy(meetingDir)
    })
  } catch {
    return
  }
}

export async function performAsk<T>(
  options: { dir: string; id?: string; question: string | null | undefined; auto: boolean; now?: string; questionMs?: number | undefined; channel?: Channel | undefined; pid?: number },
  body: () => Promise<T>,
): Promise<T> {
  const id = options.id ?? makeAskId()
  const question = options.question && options.question.trim().length > 0 ? options.question.trim() : null
  writeBoard(options.dir, {
    id,
    question,
    startedAt: options.now ?? new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
    auto: options.auto,
    questionMs: options.questionMs,
    channel: options.channel,
    state: 'running',
    pid: options.pid ?? process.pid,
  })
  try {
    return await body()
  } finally {
    removeBoard(options.dir, id)
  }
}
