import { mkdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { RecapError } from '../errors.ts'
import { readText } from './fsutil.ts'
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

function steal(target: string): void {
  const aside = `${target}.stale-${process.pid}-${Math.random().toString(36).slice(2)}`
  try {
    renameSync(target, aside)
  } catch {
    return
  }
  rmSync(aside, { recursive: true, force: true })
}

export class ProcessLock {
  readonly file: string

  constructor(file: string, code = 'ALREADY_PROCESSING', message = (pid: number) => `The meeting is already being processed (pid ${pid})`) {
    this.file = file
    mkdirSync(path.dirname(file), { recursive: true })
    for (let attempt = 0; ; attempt += 1) {
      try {
        writeFileSync(file, String(process.pid), { flag: 'wx' })
        return
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      }
      const pid = lockOwner(file)
      if (pid === process.pid) return
      if (pid !== null && isAlive(pid)) throw new RecapError(code, message(pid))
      if (pid === null && attempt < 20) {
        sleepSync(10)
        continue
      }
      steal(file)
    }
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
    if ((pid !== null && pid !== process.pid && !isAlive(pid)) || (pid === null && age > 2_000)) steal(lockDir)
    return false
  }
}

function unlock(lockDir: string): void {
  if (lockOwner(path.join(lockDir, 'pid')) === process.pid) rmSync(lockDir, { recursive: true, force: true })
}

export function withDirectoryLock<T>(lockDir: string, body: () => T, timeoutMs = 15_000): T {
  mkdirSync(path.dirname(lockDir), { recursive: true })
  const deadline = Date.now() + timeoutMs
  while (!tryLock(lockDir)) {
    if (Date.now() > deadline) throw new RecapError('WRITE_FAILED', `Timed out waiting for the lock ${lockDir}`)
    sleepSync(5)
  }
  try {
    return body()
  } finally {
    unlock(lockDir)
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
    unlock(lockDir)
  }
}
