import path from 'node:path'
import { readText } from '../core/fsutil.ts'
import { configDir } from '../core/paths.ts'
import { RecapError } from '../errors.ts'
import { PACKAGE_ROOT } from '../version.ts'

export function resourcePath(name: string): string {
  return path.join(PACKAGE_ROOT, 'Resources', name)
}

export function loadResource(name: string): string {
  for (const candidate of [path.join(configDir(), name), resourcePath(name)]) {
    const text = readText(candidate)
    if (text !== null) return text
  }
  throw new RecapError('PROMPT_MISSING', `${name} not found; reinstall recap`)
}
