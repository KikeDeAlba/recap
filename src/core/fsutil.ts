import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'

export function writeAtomic(file: string, content: string | Uint8Array): void {
  mkdirSync(path.dirname(file), { recursive: true })
  const temporary = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.${Date.now()}.tmp`)
  writeFileSync(temporary, content)
  try {
    renameSync(temporary, file)
  } catch (error) {
    rmSync(temporary, { force: true })
    throw error
  }
}

export function readText(file: string): string | null {
  try {
    return readFileSync(file, 'utf8')
  } catch {
    return null
  }
}

export function exists(file: string): boolean {
  return existsSync(file)
}

export function isDirectory(file: string): boolean {
  try {
    return statSync(file).isDirectory()
  } catch {
    return false
  }
}

export function fileSize(file: string): number {
  try {
    return statSync(file).size
  } catch {
    return 0
  }
}

export function removePath(file: string): void {
  rmSync(file, { recursive: true, force: true })
}
