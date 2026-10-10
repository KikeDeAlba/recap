import { createWriteStream, existsSync, mkdirSync, mkdtempSync, renameSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import type { ReadableStream as WebReadableStream } from 'node:stream/web'
import type { Config } from '../core/config.ts'
import { home } from '../core/paths.ts'
import { exec } from '../core/proc.ts'
import { suffix, trimmed } from '../core/text.ts'
import { installHint, locateTool, type ToolName } from '../core/tools.ts'
import { RecapError } from '../errors.ts'
import { which } from '@kikedealba/kit/platform'

export const BREW_CANDIDATES = ['/opt/homebrew/bin/brew', '/usr/local/bin/brew']

const BREW_FORMULAE: Partial<Record<ToolName, string>> = { ffmpeg: 'ffmpeg', 'whisper-cli': 'whisper-cpp' }
const WINGET_IDS: Partial<Record<ToolName, string>> = { ffmpeg: 'Gyan.FFmpeg' }

export interface InstallReport {
  installed: string[]
  manual: string[]
}

export async function installMissing(config: Config, progress: (line: string) => void, platform: NodeJS.Platform = process.platform): Promise<InstallReport> {
  const missing: ToolName[] = []
  for (const tool of ['ffmpeg', 'whisper-cli'] as ToolName[]) if (!(await locateTool(tool, config))) missing.push(tool)
  const report: InstallReport = { installed: [], manual: [] }
  if (missing.length === 0) return report
  if (platform === 'darwin') {
    const brew = BREW_CANDIDATES.find((candidate) => existsSync(candidate)) ?? (await which('brew'))
    const formulae = missing.map((tool) => BREW_FORMULAE[tool] ?? tool)
    if (!brew) throw new RecapError('BREW_MISSING', `Install Homebrew, or install ${formulae.join(' and ')} by hand`)
    progress(`Installing ${formulae.join(', ')} with Homebrew...`)
    const result = await exec(brew, ['install', ...formulae], { env: { ...process.env, HOMEBREW_NO_AUTO_UPDATE: '1' } })
    if (result.status !== 0) throw new RecapError('BREW_FAILED', `brew install ${formulae.join(' ')} failed: ${suffix(trimmed(result.stderr), 400)}`)
    report.installed.push(...formulae)
    return report
  }
  if (platform === 'win32') {
    const winget = await which('winget')
    for (const tool of missing) {
      const id = WINGET_IDS[tool]
      if (!id || !winget) {
        report.manual.push(`${tool}: ${installHint(tool, platform)}`)
        continue
      }
      progress(`Installing ${id} with winget...`)
      const result = await exec(winget, ['install', '--id', id, '-e', '--accept-source-agreements', '--accept-package-agreements'])
      if (result.status === 0) report.installed.push(id)
      else report.manual.push(`${tool}: winget install ${id} failed (${suffix(trimmed(result.stdout + result.stderr), 200)})`)
    }
    return report
  }
  for (const tool of missing) report.manual.push(`${tool}: ${installHint(tool, platform)}`)
  return report
}

export async function download(url: string, target: string, progress: (line: string) => void): Promise<void> {
  mkdirSync(path.dirname(target), { recursive: true })
  const partial = `${target}.part`
  let offset = 0
  try {
    offset = statSync(partial).size
  } catch {
    offset = 0
  }
  const response = await fetch(url, { redirect: 'follow', headers: offset > 0 ? { Range: `bytes=${offset}-` } : {} })
  if (response.status === 416) {
    renameSync(partial, target)
    return
  }
  if (!response.ok || !response.body) throw new RecapError('DOWNLOAD_FAILED', `Cannot download ${path.basename(url)}: HTTP ${response.status}`)
  const append = offset > 0 && response.status === 206
  if (!append) offset = 0
  progress(`Downloading ${path.basename(target)}${append ? ` (resuming at ${offset} bytes)` : ''}...`)
  await pipeline(Readable.fromWeb(response.body as unknown as WebReadableStream<Uint8Array>), createWriteStream(partial, { flags: append ? 'a' : 'w' }))
  rmSync(target, { force: true })
  renameSync(partial, target)
}

export const RECAP_REPO = 'KikeDeAlba/recap'
export const RECAP_ASSET_SUFFIX = '-macos-arm64.zip'

export function recapAppTarget(): string {
  return path.join(home(), 'Applications', 'Recap.app')
}

export async function installRecapApp(progress: (line: string) => void): Promise<string> {
  if (process.platform !== 'darwin' || process.arch !== 'arm64') throw new RecapError('CAPTURE_UNAVAILABLE', 'Recap.app only runs on Apple Silicon Macs')
  const work = mkdtempSync(path.join(tmpdir(), 'recap-app-'))
  try {
    let zip = process.env['RECAP_APP_ZIP'] ?? null
    if (!zip) {
      const response = await fetch(`https://api.github.com/repos/${RECAP_REPO}/releases/latest`, { headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'recap-setup' } })
      if (!response.ok) throw new RecapError('DOWNLOAD_FAILED', `Cannot reach the recap releases: HTTP ${response.status}`)
      const release = (await response.json()) as { tag_name?: string; assets?: { name: string; browser_download_url: string }[] }
      const asset = (release.assets ?? []).find((item) => item.name.endsWith(RECAP_ASSET_SUFFIX))
      if (!asset) throw new RecapError('DOWNLOAD_FAILED', `The ${release.tag_name ?? 'latest'} release of recap has no ${RECAP_ASSET_SUFFIX} asset`)
      zip = path.join(work, asset.name)
      await download(asset.browser_download_url, zip, progress)
    }
    const unpacked = path.join(work, 'unpacked')
    const extracted = await exec('/usr/bin/ditto', ['-x', '-k', zip, unpacked])
    const source = path.join(unpacked, 'Recap.app')
    if (extracted.status !== 0 || !existsSync(source)) throw new RecapError('INSTALL_FAILED', `Could not unpack ${zip}: ${trimmed(extracted.stderr)}`)
    const target = recapAppTarget()
    mkdirSync(path.dirname(target), { recursive: true })
    rmSync(target, { recursive: true, force: true })
    const copied = await exec('/usr/bin/ditto', [source, target])
    if (copied.status !== 0) throw new RecapError('INSTALL_FAILED', `Could not copy Recap.app: ${trimmed(copied.stderr)}`)
    return target
  } finally {
    rmSync(work, { recursive: true, force: true })
  }
}
