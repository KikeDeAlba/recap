import { existsSync } from 'node:fs'
import path from 'node:path'
import { PACKAGE_ROOT } from '../version.ts'
import { spawnDetached } from './proc.ts'

export function binEntry(): string {
  const built = path.join(PACKAGE_ROOT, 'dist', 'bin', 'recap.js')
  return existsSync(built) ? built : path.join(PACKAGE_ROOT, 'src', 'bin', 'recap.ts')
}

export function selfCommand(): string[] {
  return [process.execPath, binEntry()]
}

export function spawnSelf(args: readonly string[], logPath: string): number {
  const [node, entry] = selfCommand()
  return spawnDetached(node ?? process.execPath, [entry ?? binEntry(), ...args], logPath)
}

export function processInBackground(meetingId: string, dir: string, extra: readonly string[] = []): number {
  return spawnSelf(['process', meetingId, ...extra], path.join(dir, 'process.log'))
}
