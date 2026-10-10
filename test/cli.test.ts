import assert from 'node:assert/strict'
import { execFile, spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'
import { promisify } from 'node:util'
import { assertConformance } from '@kikedealba/kit/conformance'
import { parseEnvelope } from '@kikedealba/kit/envelope'
import { manifest } from '../src/setup/integration.ts'
import { PACKAGE_ROOT } from '../src/version.ts'
import { sandboxEnv, tempDir } from './helpers.ts'

const BIN = path.join(PACKAGE_ROOT, 'src', 'bin', 'recap.ts')

async function recap(args: string[], env: NodeJS.ProcessEnv, input?: string): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = execFile(process.execPath, [BIN, ...args], { env, maxBuffer: 16 * 1024 * 1024 }, (error, stdout, stderr) => {
      resolve({ code: error ? Number((error as { code?: number }).code ?? 1) : 0, stdout: String(stdout), stderr: String(stderr) })
    })
    if (input !== undefined) child.stdin?.end(input)
  })
}

test('passes the kit conformance checks', async (t) => {
  const env = sandboxEnv(tempDir(t))
  await assertConformance([process.execPath, BIN], manifest(false), { platform: process.platform === 'win32' ? 'win32' : process.platform === 'darwin' ? 'darwin' : 'linux', env, home: env['HOME'] ?? '' })
})

test('prints one-line envelopes and fails with an error envelope', async (t) => {
  const env = sandboxEnv(tempDir(t))
  const listed = await recap(['list', '--json'], env)
  assert.equal(listed.code, 0)
  assert.equal(listed.stdout.trim().split('\n').length, 1)
  assert.deepEqual(parseEnvelope(listed.stdout)?.data, [])
  const missing = await recap(['show', 'nope', '--json'], env)
  assert.notEqual(missing.code, 0)
  assert.equal(parseEnvelope(missing.stdout)?.error?.code, 'MEETING_NOT_FOUND')
  const bad = await recap(['list', '--wat', '--json'], env)
  assert.equal(parseEnvelope(bad.stdout)?.error?.code, 'USAGE')
})

test('start fails with CAPTURE_UNAVAILABLE when there is no recorder', async (t) => {
  const env = sandboxEnv(tempDir(t), { PATH: path.dirname(process.execPath) })
  const result = await recap(['start', '--in-person', 'Daily', '--json'], env)
  const envelope = parseEnvelope(result.stdout)
  assert.equal(envelope?.error?.code, 'CAPTURE_UNAVAILABLE')
  assert.ok(envelope?.error?.hint)
  assert.ok(!existsSync(path.join(env['RECAP_ROOT'] ?? '', 'x')) || readdirSync(env['RECAP_ROOT'] ?? '').length === 0)
})

test('setup registers the manifest and installs the agent integration', async (t) => {
  const dir = tempDir(t)
  const env = sandboxEnv(dir, { PATH: path.dirname(process.execPath) })
  const result = await recap(['setup', '--skip-models', '--skip-permissions', '--skip-app', '--agents', 'codex,gemini', '--json'], env)
  const envelope = parseEnvelope(result.stdout)
  assert.equal(envelope?.ok, true, result.stdout + result.stderr)
  const checks = envelope?.data as { name: string; ok: boolean; detail: string }[]
  assert.ok(checks.some((check) => check.name === 'registry' && check.ok))
  const registered = JSON.parse(readFileSync(path.join(dir, 'registry', 'recap.json'), 'utf8')) as { name: string; capabilities: string[]; bin: string[] }
  assert.equal(registered.name, 'recap')
  assert.ok(registered.capabilities.includes('meeting.process'))
  assert.ok(existsSync(path.join(dir, '.agents', 'skills', 'recap')))
  assert.ok(existsSync(path.join(dir, '.gemini', 'extensions', 'recap', 'gemini-extension.json')))
  assert.ok(existsSync(path.join(dir, '.codex', 'prompts', 'recap-start.md')))
})

test('the bita hook ignores events that are not meetings', async (t) => {
  const env = sandboxEnv(tempDir(t))
  const result = await recap(['bita-hook'], env, JSON.stringify({ event: 'start', entry: { id: 3, description: 'Code', kind: 'pairing' }, source: 'bita' }))
  assert.equal(result.code, 0)
  assert.ok(result.stdout.includes('nothing to do: entry #3 is not a meeting'))
  const broken = await recap(['bita-hook'], env, 'not json')
  assert.equal(broken.code, 1)
})

const canFake = process.platform !== 'win32' && spawnSync('ffmpeg', ['-version']).status === 0 && spawnSync('ffprobe', ['-version']).status === 0

test('imports an audio file and processes it with fake whisper and claude', { skip: !canFake && 'needs ffmpeg and a POSIX shell' }, async (t) => {
  const dir = tempDir(t)
  const fakes = path.join(dir, 'fakebin')
  mkdirSync(fakes)
  writeFileSync(
    path.join(fakes, 'whisper-cli'),
    '#!/bin/sh\nout=""\nprev=""\nfor a in "$@"; do\n  if [ "$prev" = "-of" ]; then out="$a"; fi\n  prev="$a"\ndone\nprintf \'%s\' \'{"transcription":[{"offsets":{"from":0,"to":2000},"text":" Buenos días, revisamos el avance."}]}\' > "$out.json"\n',
  )
  writeFileSync(path.join(fakes, 'claude'), '#!/bin/sh\ncat > /dev/null\nprintf \'%s\\n\' \'{"type":"result","is_error":false,"result":"## Resumen\\nSe revisó el avance."}\'\n')
  chmodSync(path.join(fakes, 'whisper-cli'), 0o755)
  chmodSync(path.join(fakes, 'claude'), 0o755)
  const env = sandboxEnv(dir, { PATH: `${fakes}${path.delimiter}${process.env['PATH'] ?? ''}` })
  mkdirSync(path.join(dir, 'data', 'models'), { recursive: true })
  writeFileSync(path.join(dir, 'data', 'models', 'ggml-large-v3-turbo.bin'), '')
  const wav = path.join(dir, 'sample.wav')
  assert.equal(spawnSync('ffmpeg', ['-loglevel', 'error', '-f', 'lavfi', '-i', 'sine=d=3', wav]).status, 0)
  const imported = await recap(['import', wav, '--title', 'Revisión', '--json'], env)
  const envelope = parseEnvelope(imported.stdout)
  assert.equal(envelope?.ok, true, imported.stdout + imported.stderr)
  const data = envelope?.data as { id: string; status: string; dir: string; mode: string }
  assert.equal(data.status, 'processed')
  assert.equal(data.mode, 'in-person')
  assert.match(readFileSync(path.join(data.dir, 'summary.md'), 'utf8'), /^# Revisión\n\n.* · 0m0\ds · reunión presencial\n\n## Resumen\nSe revisó el avance\.\n$/)
  assert.ok(readFileSync(path.join(data.dir, 'transcript.md'), 'utf8').includes('**[00:00:00]** Buenos días, revisamos el avance.'))
  const shown = parseEnvelope((await recap(['show', data.id, '--json'], env)).stdout)
  assert.deepEqual((shown?.data as { answers: unknown[] }).answers, [])
  const prompt = await recap(['prompt', data.id], env)
  assert.ok(prompt.stdout.includes('Buenos días, revisamos el avance.'))
})
