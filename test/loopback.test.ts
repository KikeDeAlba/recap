import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'
import { platformContext } from '@kikedealba/kit/platform'
import { loopbackPath } from '../src/capture/sources.ts'
import { installLoopback, loopbackAsset, loopbackSource, packagedChecksum, sha256, tarCommand, trustedUrl } from '../src/setup/loopback.ts'
import { sandboxEnv, tempDir } from './helpers.ts'

const posix = process.platform !== 'win32'
const HASH = 'ab'.repeat(32)

test('takes the recap-loopback checksum from the npm package, never from the release', (t) => {
  const file = path.join(tempDir(t), 'checksums.json')
  writeFileSync(file, JSON.stringify({ [loopbackAsset('1.2.3')]: HASH.toUpperCase() }))
  assert.equal(loopbackAsset('1.2.3'), 'recap-loopback-1.2.3-windows-x64.zip')
  assert.deepEqual(loopbackSource({}, '1.2.3', file), { url: 'https://github.com/KikeDeAlba/recap/releases/download/v1.2.3/recap-loopback-1.2.3-windows-x64.zip', sha256: HASH })
  assert.equal(packagedChecksum(loopbackAsset('9.9.9'), file), null)
  assert.throws(() => loopbackSource({}, '9.9.9', file), /LOOPBACK_SHA256_MISSING|no checksum/)
  assert.throws(() => loopbackSource({}, '1.2.3', path.join(tempDir(t), 'missing.json')), /no checksum/)
})

test('an overridden URL needs https and its own RECAP_LOOPBACK_SHA256', () => {
  assert.throws(() => loopbackSource({ RECAP_LOOPBACK_URL: 'https://x/y.zip' }, '1.2.3'), /RECAP_LOOPBACK_SHA256/)
  assert.throws(() => loopbackSource({ RECAP_LOOPBACK_URL: 'http://mirror.example/y.zip', RECAP_LOOPBACK_SHA256: HASH }, '1.2.3'), /https/)
  assert.deepEqual(loopbackSource({ RECAP_LOOPBACK_URL: 'http://127.0.0.1:8080/y.zip', RECAP_LOOPBACK_SHA256: HASH }, '1.2.3'), { url: 'http://127.0.0.1:8080/y.zip', sha256: HASH })
  assert.equal(loopbackSource({ RECAP_RELEASE_BASE_URL: 'https://mirror.example/r/', RECAP_LOOPBACK_SHA256: HASH }, '1.2.3').url, 'https://mirror.example/r/v1.2.3/recap-loopback-1.2.3-windows-x64.zip')
  assert.ok(trustedUrl('https://a/b') && trustedUrl('http://localhost/b') && !trustedUrl('file:///x') && !trustedUrl('nope'))
})

test('runs tar from System32 on Windows', () => {
  assert.equal(tarCommand(platformContext({ platform: 'win32', env: { SystemRoot: 'D:\\Win' }, home: 'C:\\Users\\a' })), 'D:\\Win\\System32\\tar.exe')
  assert.equal(tarCommand(platformContext({ platform: 'win32', env: {}, home: 'C:\\Users\\a' })), 'C:\\Windows\\System32\\tar.exe')
})

function canZip(): boolean {
  return spawnSync('/usr/bin/tar', ['--version'], { encoding: 'utf8' }).stdout?.includes('bsdtar') ?? false
}

test('installs recap-loopback from the release zip after checking the expected hash', { skip: (!posix || !canZip()) && 'needs bsdtar to build a zip' }, async (t) => {
  const dir = tempDir(t)
  const stage = path.join(dir, 'stage')
  mkdirSync(stage)
  writeFileSync(path.join(stage, 'recap-loopback.exe'), 'MZ fake')
  const zip = path.join(dir, 'release.zip')
  assert.equal(spawnSync('/usr/bin/tar', ['-a', '-cf', zip, '-C', stage, 'recap-loopback.exe']).status, 0)
  const target = path.join(dir, 'data', 'bin', 'recap-loopback.exe')
  const fetched: string[] = []
  const fetchFile = async (url: string, file: string) => {
    fetched.push(url)
    copyFileSync(zip, file)
  }
  const ctxWith = (hash: string) =>
    platformContext({ platform: 'win32', env: sandboxEnv(dir, { RECAP_LOOPBACK: target, RECAP_LOOPBACK_URL: 'https://example.invalid/l.zip', RECAP_LOOPBACK_SHA256: hash }), home: dir })
  const installed = await installLoopback(ctxWith(sha256(zip)), () => undefined, fetchFile, '/usr/bin/tar')
  assert.equal(installed, loopbackPath(ctxWith(sha256(zip))))
  assert.equal(readFileSync(installed, 'utf8'), 'MZ fake')
  assert.deepEqual(fetched, ['https://example.invalid/l.zip'])
  await assert.rejects(installLoopback(ctxWith('0'.repeat(64)), () => undefined, fetchFile, '/usr/bin/tar'), /CHECKSUM_MISMATCH|expected/)
})
