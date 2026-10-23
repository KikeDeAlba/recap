import { createHash } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { PlatformContext } from '@kikedealba/kit/platform'
import { LOOPBACK_NAME, loopbackPath } from '../capture/sources.ts'
import { isRecord } from '../core/json.ts'
import { exec } from '../core/proc.ts'
import { trimmed } from '../core/text.ts'
import { RecapError } from '../errors.ts'
import { PACKAGE_ROOT, VERSION } from '../version.ts'
import { RECAP_REPO, download } from './deps.ts'

export const CHECKSUMS_FILE = path.join(PACKAGE_ROOT, 'assets', 'loopback-checksums.json')
export const LOOPBACK_EXE = `${LOOPBACK_NAME}.exe`

export function loopbackAsset(version: string = VERSION): string {
  return `${LOOPBACK_NAME}-${version}-windows-x64.zip`
}

export interface LoopbackSource {
  url: string
  sha256: string
}

export function isSha256(value: string | undefined): value is string {
  return typeof value === 'string' && /^[0-9a-f]{64}$/.test(value)
}

export function trustedUrl(raw: string): boolean {
  try {
    const url = new URL(raw)
    if (url.protocol === 'https:') return true
    return url.protocol === 'http:' && (url.hostname === '127.0.0.1' || url.hostname === 'localhost' || url.hostname === '[::1]')
  } catch {
    return false
  }
}

export function packagedChecksum(asset: string, file: string = CHECKSUMS_FILE): string | null {
  let value: unknown
  try {
    value = JSON.parse(readFileSync(file, 'utf8')) as unknown
  } catch {
    return null
  }
  if (!isRecord(value)) return null
  const hash = value[asset]
  return typeof hash === 'string' && isSha256(hash.toLowerCase()) ? hash.toLowerCase() : null
}

export function loopbackSource(env: NodeJS.ProcessEnv = process.env, version: string = VERSION, checksums: string = CHECKSUMS_FILE): LoopbackSource {
  const asset = loopbackAsset(version)
  const direct = env['RECAP_LOOPBACK_URL']
  const base = env['RECAP_RELEASE_BASE_URL']
  if (direct || base) {
    const url = direct || `${(base ?? '').replace(/\/+$/, '')}/v${version}/${asset}`
    if (!trustedUrl(url)) throw new RecapError('LOOPBACK_URL_UNTRUSTED', `${url} must use https (plain http only on 127.0.0.1 or localhost)`)
    const hash = env['RECAP_LOOPBACK_SHA256']?.trim().toLowerCase()
    if (!isSha256(hash)) throw new RecapError('LOOPBACK_SHA256_REQUIRED', 'Set RECAP_LOOPBACK_SHA256 to the SHA-256 of the zip when RECAP_LOOPBACK_URL or RECAP_RELEASE_BASE_URL is set')
    return { url, sha256: hash }
  }
  const hash = packagedChecksum(asset, checksums)
  if (!hash) throw new RecapError('LOOPBACK_SHA256_MISSING', `This recap ${version} package has no checksum for ${asset}; reinstall a published version or set RECAP_LOOPBACK_URL and RECAP_LOOPBACK_SHA256`)
  return { url: `https://github.com/${RECAP_REPO}/releases/download/v${version}/${asset}`, sha256: hash }
}

export function sha256(file: string): string {
  return createHash('sha256').update(readFileSync(file)).digest('hex')
}

export function tarCommand(ctx: PlatformContext): string {
  if (ctx.platform !== 'win32') return '/usr/bin/tar'
  return path.win32.join(ctx.env['SystemRoot'] ?? ctx.env['SYSTEMROOT'] ?? 'C:\\Windows', 'System32', 'tar.exe')
}

function findFile(dir: string, name: string): string | null {
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry)
    const info = statSync(full)
    if (info.isFile() && entry.toLowerCase() === name.toLowerCase()) return full
    if (info.isDirectory()) {
      const nested = findFile(full, name)
      if (nested) return nested
    }
  }
  return null
}

export async function installLoopback(ctx: PlatformContext, progress: (line: string) => void, fetchFile: typeof download = download, tar: string = tarCommand(ctx)): Promise<string> {
  const target = loopbackPath(ctx)
  const source = loopbackSource(ctx.env)
  const work = mkdtempSync(path.join(tmpdir(), 'recap-loopback-'))
  try {
    const zip = path.join(work, 'loopback.zip')
    await fetchFile(source.url, zip, progress)
    const actual = sha256(zip)
    if (actual !== source.sha256) throw new RecapError('CHECKSUM_MISMATCH', `${path.basename(new URL(source.url).pathname)} has SHA-256 ${actual}, expected ${source.sha256}`)
    const unpacked = path.join(work, 'unpacked')
    mkdirSync(unpacked, { recursive: true })
    const extracted = await exec(tar, ['-xf', zip, '-C', unpacked], { cwd: work })
    if (extracted.status !== 0) throw new RecapError('INSTALL_FAILED', `Cannot unpack the recap-loopback zip: ${trimmed(extracted.stderr)}`)
    const binary = findFile(unpacked, LOOPBACK_EXE)
    if (!binary) throw new RecapError('INSTALL_FAILED', `The recap-loopback zip has no ${LOOPBACK_EXE}`)
    mkdirSync(path.dirname(target), { recursive: true })
    rmSync(target, { force: true })
    copyFileSync(binary, target)
    if (!existsSync(target)) throw new RecapError('INSTALL_FAILED', `Cannot copy ${LOOPBACK_EXE} to ${path.dirname(target)}`)
    return target
  } finally {
    rmSync(work, { recursive: true, force: true })
  }
}
