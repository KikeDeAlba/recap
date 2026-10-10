import { mkdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { RecapError } from '../errors.ts'
import { readText, writeAtomic } from './fsutil.ts'
import { isAlive } from './proc.ts'
import { trimmed } from './text.ts'

export function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

export function lockOwner(file: string): number | null {
  const text = readText(file)
  if (text === null) return null
  const value = trimmed(text)
  return /^\d+$/.test(value) ? Number(value) : null
}

export class ProcessLock {
  readonly file: string

  constructor(file: string, code = 'ALREADY_PROCESSING', message = (pid: number) => `The meeting is already being processed (pid ${pid})`) {
    this.file = file
    const pid = lockOwner(file)
    if (pid !== null && pid !== process.pid && isAlive(pid)) throw new RecapError(code, message(pid))
    writeAtomic(file, String(process.pid))
  }

  release(): void {
    if (lockOwner(this.file) === process.pid) rmSync(this.file, { force: true })
  }
}


function tryLock(lockDir: string): boolean {
  const owner = path.join(lockDir, 'pid')
  try {
    mkdirSync(lockDir)
    writeFileSync(owner, String(process.pid))
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw new RecapError('WRITE_FAILED', `Cannot take the lock ${lockDir}: ${(error as Error).message}`)
    const pid = lockOwner(owner)
    let age = 0
    try {
      age = Date.now() - statSync(lockDir).mtimeMs
    } catch {
      return false
    }
    if ((pid !== null && !isAlive(pid)) || (pid === null && age > 2_000)) rmSync(lockDir, { recursive: true, force: true })
    return false
  }
}

export function withDirectoryLock<T>(lockDir: string, body: () => T, timeoutMs = 15_000): T {
  mkdirSync(path.dirname(lockDir), { recursive: true })
  const deadline = Date.now() + timeoutMs
  while (!tryLock(lockDir)) {
    if (Date.now() > deadline) throw new RecapError('WRITE_FAILED', `Timed out waiting for the lock ${lockDir}`)
    sleepSync(15)
  }
  try {
    return body()
  } finally {
    rmSync(lockDir, { recursive: true, force: true })
  }
}

export async function withDirectoryLockAsync<T>(lockDir: string, body: () => Promise<T>, timeoutMs = 60_000): Promise<T> {
  mkdirSync(path.dirname(lockDir), { recursive: true })
  const deadline = Date.now() + timeoutMs
  while (!tryLock(lockDir)) {
    if (Date.now() > deadline) throw new RecapError('WRITE_FAILED', `Timed out waiting for the lock ${lockDir}`)
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  try {
    return await body()
  } finally {
    rmSync(lockDir, { recursive: true, force: true })
  }
}
