import { createHash } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { PlatformContext } from '@kikedealba/kit/platform'
import { LOOPBACK_NAME, loopbackPath } from '../capture/sources.ts'
import { exec } from '../core/proc.ts'
import { trimmed } from '../core/text.ts'
import { RecapError } from '../errors.ts'
import { VERSION } from '../version.ts'
import { RECAP_REPO, download } from './deps.ts'

export function loopbackAsset(version: string = VERSION): string {
  return `${LOOPBACK_NAME}-${version}-windows-x64.zip`
}

export function loopbackUrl(env: NodeJS.ProcessEnv = process.env, version: string = VERSION): string {
  const override = env['RECAP_LOOPBACK_URL']
  if (override && override.length > 0) return override
  const base = env['RECAP_RELEASE_BASE_URL'] ?? `https://github.com/${RECAP_REPO}/releases/download`
  return `${base.replace(/\/+$/, '')}/v${version}/${loopbackAsset(version)}`
}

export function parseChecksum(text: string): string | null {
  const token = trimmed(text).split(/\s+/)[0]?.toLowerCase() ?? ''
  return /^[0-9a-f]{64}$/.test(token) ? token : null
}

export function sha256(file: string): string {
  return createHash('sha256').update(readFileSync(file)).digest('hex')
}

function findFile(dir: string, name: string): string | null {
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry)
    if (entry.toLowerCase() === name.toLowerCase() && statSync(full).isFile()) return full
    if (statSync(full).isDirectory()) {
      const nested = findFile(full, name)
      if (nested) return nested
    }
  }
  return null
}

export async function installLoopback(ctx: PlatformContext, progress: (line: string) => void, fetchFile: typeof download = download): Promise<string> {
  const target = loopbackPath(ctx)
  const url = loopbackUrl(ctx.env)
  const work = mkdtempSync(path.join(tmpdir(), 'recap-loopback-'))
  try {
    const zip = path.join(work, path.basename(new URL(url).pathname) || 'loopback.zip')
    const sum = `${zip}.sha256`
    await fetchFile(url, zip, progress)
    await fetchFile(`${url}.sha256`, sum, progress)
    const expected = parseChecksum(readFileSync(sum, 'utf8'))
    if (!expected) throw new RecapError('CHECKSUM_INVALID', `${path.basename(sum)} does not hold a SHA-256 checksum`)
    const actual = sha256(zip)
    if (actual !== expected) throw new RecapError('CHECKSUM_MISMATCH', `${path.basename(zip)} has SHA-256 ${actual}, expected ${expected}`)
    const unpacked = path.join(work, 'unpacked')
    mkdirSync(unpacked, { recursive: true })
    const extracted = await exec('tar', ['-xf', zip, '-C', unpacked])
    if (extracted.status !== 0) throw new RecapError('INSTALL_FAILED', `Cannot unpack ${path.basename(zip)}: ${trimmed(extracted.stderr)}`)
    const binary = findFile(unpacked, path.basename(target))
    if (!binary) throw new RecapError('INSTALL_FAILED', `${path.basename(zip)} has no ${path.basename(target)}`)
    mkdirSync(path.dirname(target), { recursive: true })
    rmSync(target, { force: true })
    copyFileSync(binary, target)
    if (!existsSync(target)) throw new RecapError('INSTALL_FAILED', `Cannot copy ${path.basename(target)} to ${path.dirname(target)}`)
    return target
  } finally {
    rmSync(work, { recursive: true, force: true })
  }
}
