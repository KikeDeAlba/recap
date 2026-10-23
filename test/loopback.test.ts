import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'
import { platformContext } from '@kikedealba/kit/platform'
import { loopbackPath } from '../src/capture/sources.ts'
import { installLoopback, loopbackAsset, loopbackUrl, parseChecksum, sha256 } from '../src/setup/loopback.ts'
import { sandboxEnv, tempDir } from './helpers.ts'

const posix = process.platform !== 'win32'

test('builds the recap-loopback release URL and verifies its checksum', () => {
  assert.equal(loopbackAsset('1.2.3'), 'recap-loopback-1.2.3-windows-x64.zip')
  assert.equal(loopbackUrl({}, '1.2.3'), 'https://github.com/KikeDeAlba/recap/releases/download/v1.2.3/recap-loopback-1.2.3-windows-x64.zip')
  assert.equal(loopbackUrl({ RECAP_RELEASE_BASE_URL: 'https://mirror.example/r/' }, '1.2.3'), 'https://mirror.example/r/v1.2.3/recap-loopback-1.2.3-windows-x64.zip')
  assert.equal(loopbackUrl({ RECAP_LOOPBACK_URL: 'https://x/y.zip' }, '1.2.3'), 'https://x/y.zip')
  const hash = 'a'.repeat(64)
  assert.equal(parseChecksum(`${hash}  recap-loopback.zip\n`), hash)
  assert.equal(parseChecksum('nope'), null)
})

function canZip(): boolean {
  return spawnSync('tar', ['--version'], { encoding: 'utf8' }).stdout.includes('bsdtar')
}

test('installs recap-loopback from the release zip into the recap data dir', { skip: !canZip() && 'needs bsdtar to build a zip' }, async (t) => {
  const dir = tempDir(t)
  const stage = path.join(dir, 'stage')
  mkdirSync(stage)
  writeFileSync(path.join(stage, 'recap-loopback.exe'), 'MZ fake')
  const zip = path.join(dir, 'release.zip')
  assert.equal(spawnSync('tar', ['-a', '-cf', zip, '-C', stage, 'recap-loopback.exe']).status, 0)
  const env = sandboxEnv(dir, { RECAP_LOOPBACK_URL: 'https://example.invalid/recap-loopback-9.9.9-windows-x64.zip', ...(posix ? { RECAP_LOOPBACK: path.join(dir, 'data', 'bin', 'recap-loopback.exe') } : {}) })
  const ctx = platformContext({ platform: 'win32', env, home: dir })
  const fetched: string[] = []
  const fetchFile = async (url: string, target: string) => {
    fetched.push(url)
    if (url.endsWith('.sha256')) writeFileSync(target, `${sha256(zip)}  release.zip\n`)
    else copyFileSync(zip, target)
  }
  const installed = await installLoopback(ctx, () => undefined, fetchFile)
  assert.equal(installed, loopbackPath(ctx))
  assert.equal(readFileSync(installed, 'utf8'), 'MZ fake')
  assert.deepEqual(fetched, ['https://example.invalid/recap-loopback-9.9.9-windows-x64.zip', 'https://example.invalid/recap-loopback-9.9.9-windows-x64.zip.sha256'])
  const bad = async (url: string, target: string) => {
    if (url.endsWith('.sha256')) writeFileSync(target, `${'0'.repeat(64)}\n`)
    else copyFileSync(zip, target)
  }
  await assert.rejects(installLoopback(ctx, () => undefined, bad), /CHECKSUM|SHA-256/)
})
