import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { chmodSync, existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'
import { parseEnvelope } from '@kikedealba/kit/envelope'
import { PACKAGE_ROOT } from '../src/version.ts'
import { sandboxEnv, tempDir } from './helpers.ts'
import { isAlive } from '../src/core/proc.ts'

const BIN = path.join(PACKAGE_ROOT, 'src', 'bin', 'recap.ts')
const FAKE = path.join(import.meta.dirname, 'fakes', 'fake-recap-capture.cjs')
const onMac = process.platform === 'darwin'

type Capabilities = 'announce' | 'legacy' | 'fail' | 'garbage' | 'hang'

interface Run {
  code: number
  stdout: string
  stderr: string
}

function recap(args: string[], env: NodeJS.ProcessEnv, input?: string): Promise<Run> {
  return new Promise((resolve) => {
    const child = execFile(process.execPath, [BIN, ...args], { env, maxBuffer: 16 * 1024 * 1024 }, (error, stdout, stderr) => {
      resolve({ code: error ? Number((error as { code?: number }).code ?? 1) : 0, stdout: String(stdout), stderr: String(stderr) })
    })
    if (input !== undefined) child.stdin?.end(input)
  })
}

function helperEnv(t: { after: (fn: () => void) => void }, capabilities: Capabilities | 'missing'): NodeJS.ProcessEnv {
  const dir = tempDir(t)
  const helper = path.join(dir, 'recap-capture')
  writeFileSync(helper, `#!${process.execPath}\n${readFileSync(FAKE, 'utf8')}`)
  chmodSync(helper, 0o755)
  return sandboxEnv(dir, {
    PATH: path.dirname(process.execPath),
    RECAP_CAPTURE: capabilities === 'missing' ? path.join(dir, 'does-not-exist') : helper,
    FAKE_CAPTURE_CAPS: capabilities === 'missing' ? 'announce' : capabilities,
  })
}

function active(run: Run): Record<string, unknown> {
  const status = data(run)
  assert.equal(status['recording'], true)
  return status['active'] as Record<string, unknown>
}

function data(run: Run): Record<string, unknown> {
  const envelope = parseEnvelope(run.stdout)
  assert.equal(envelope?.ok, true, run.stdout + run.stderr)
  return envelope?.data as Record<string, unknown>
}

function recorded(dir: string): string {
  return readFileSync(path.join(dir, 'fake-recorder-mode.txt'), 'utf8')
}

test('meeting mode end to end: start without a modality, stop, list, show and storage', { skip: !onMac }, async (t) => {
  const env = helperEnv(t, 'announce')
  const started = data(await recap(['start', '--timeout', '15', '--json'], env))
  assert.equal(started['mode'], 'meeting')
  assert.equal(started['title'], 'Meeting')
  assert.equal(started['status'], 'recording')
  assert.equal(started['fallback'], undefined)
  const dir = String(started['dir'])
  assert.equal(recorded(dir), 'meeting')

  assert.equal(active(await recap(['status', '--json'], env))['mode'], 'meeting')

  const stopped = data(await recap(['stop', '--no-process', '--timeout', '15', '--json'], env))
  assert.equal(stopped['mode'], 'meeting')
  assert.equal(stopped['status'], 'recorded')
  assert.ok(String(stopped['recording']).endsWith('recording.m4a'))
  assert.equal(stopped['hasVideo'], false)
  assert.equal((stopped['storage'] as { recordingBytes: number }).recordingBytes, 64)

  const listed = parseEnvelope((await recap(['list', '--json'], env)).stdout)?.data as Record<string, unknown>[]
  assert.equal(listed.length, 1)
  assert.equal(listed[0]?.['mode'], 'meeting')
  assert.equal(listed[0]?.['fallback'], undefined)

  const shown = data(await recap(['show', 'last', '--json'], env))
  assert.equal(shown['mode'], 'meeting')
  assert.equal(shown['id'], started['id'])
  assert.equal((shown['storage'] as { recordingBytes: number }).recordingBytes, 64)

  const stoppedAgain = await recap(['stop', '--json'], env)
  assert.equal(parseEnvelope(stoppedAgain.stdout)?.error?.code, 'NOT_RECORDING')
})

test('start with a title and the plain output names the meeting mode', { skip: !onMac }, async (t) => {
  const env = helperEnv(t, 'announce')
  const started = await recap(['start', 'Sprint', 'planning', '--timeout', '15'], env)
  assert.equal(started.code, 0, started.stderr)
  assert.match(started.stdout, /^Recording meeting "Sprint planning"\n/)
  assert.doesNotMatch(started.stdout, /does not support meeting mode/)
  await recap(['stop', '--no-process', '--timeout', '15'], env)
})

test('a second start while recording fails with ALREADY_RECORDING', { skip: !onMac }, async (t) => {
  const env = helperEnv(t, 'announce')
  data(await recap(['start', '--timeout', '15', '--json'], env))
  const second = await recap(['start', '--timeout', '15', '--json'], env)
  assert.notEqual(second.code, 0)
  assert.equal(parseEnvelope(second.stdout)?.error?.code, 'ALREADY_RECORDING')
  await recap(['stop', '--no-process', '--timeout', '15'], env)
})

for (const capabilities of ['legacy', 'fail', 'garbage'] as const) {
  test(`start falls back to in-person when the helper reports capabilities as "${capabilities}"`, { skip: !onMac }, async (t) => {
    const env = helperEnv(t, capabilities)
    const run = await recap(['start', '--timeout', '15', '--json'], env)
    const started = data(run)
    assert.equal(started['mode'], 'in-person')
    assert.equal(started['fallback'], 'in-person')
    assert.equal(started['title'], 'Meeting')
    assert.equal(recorded(String(started['dir'])), 'in-person')
    const stopped = data(await recap(['stop', '--no-process', '--timeout', '15', '--json'], env))
    assert.equal(stopped['mode'], 'in-person')
    assert.equal(stopped['fallback'], 'in-person')
    assert.ok(String(stopped['recording']).endsWith('recording.m4a'))
    const shown = data(await recap(['show', 'last', '--json'], env))
    assert.equal(shown['fallback'], 'in-person')
  })
}

test('the fallback tells the user to update Recap.app in plain output', { skip: !onMac }, async (t) => {
  const env = helperEnv(t, 'legacy')
  const started = await recap(['start', 'Daily', '--timeout', '15'], env)
  assert.equal(started.code, 0, started.stderr)
  assert.match(started.stdout, /^Recording meeting "Daily"\nRecap\.app does not support meeting mode yet; recording the microphone only\. Update it with `recap setup`\.\n/)
  assert.doesNotMatch(started.stdout, /in-person|presencial|meeting meeting/)
  const status = await recap(['status'], env)
  assert.match(status.stdout, /^Recording meeting "Daily" for /)
  await recap(['stop', '--no-process', '--timeout', '15'], env)
})

test('a helper that hangs on capabilities is killed after the timeout and start falls back to in-person', { skip: !onMac }, async (t) => {
  const env = helperEnv(t, 'hang')
  const pidFile = path.join(path.dirname(String(env['RECAP_CAPTURE'])), 'capabilities.pid')
  t.after(() => {
    if (!existsSync(pidFile)) return
    const pid = Number(readFileSync(pidFile, 'utf8'))
    if (isAlive(pid)) process.kill(pid, 'SIGKILL')
  })
  const began = Date.now()
  const started = data(await recap(['start', '--timeout', '15', '--json'], env))
  assert.ok(Date.now() - began < 14_000)
  assert.equal(started['mode'], 'in-person')
  assert.equal(started['fallback'], 'in-person')
  assert.ok(!isAlive(Number(readFileSync(pidFile, 'utf8'))))
  await recap(['stop', '--no-process', '--timeout', '15'], env)
})

test('explicit modalities never trigger the fallback, even with a legacy helper', { skip: !onMac }, async (t) => {
  for (const [flag, mode] of [['--remote', 'remote'], ['--in-person', 'in-person']] as const) {
    const env = helperEnv(t, 'legacy')
    const started = data(await recap(['start', flag, '--timeout', '15', '--json'], env))
    assert.equal(started['mode'], mode)
    assert.equal(started['fallback'], undefined)
    assert.equal(recorded(String(started['dir'])), mode)
    assert.equal(started['title'], mode === 'remote' ? 'Remote meeting' : 'In-person meeting')
    await recap(['stop', '--no-process', '--timeout', '15'], env)
  }
})

test('a helper that does not exist fails start with CAPTURE_UNAVAILABLE and leaves no meeting behind', { skip: !onMac }, async (t) => {
  const env = helperEnv(t, 'missing')
  const run = await recap(['start', '--json'], env)
  assert.notEqual(run.code, 0)
  assert.equal(parseEnvelope(run.stdout)?.error?.code, 'CAPTURE_UNAVAILABLE')
  const root = env['RECAP_ROOT'] ?? ''
  assert.ok(!existsSync(root) || readdirSync(root).length === 0)
  const state = data(await recap(['list', '--json'], env))
  assert.deepEqual(state, [])
})

function hookEvent(name: string, entry: Record<string, unknown>, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({ event: name, entry: { id: 7, description: 'Daily', running: true, ...entry }, databasePath: '/data/bita.db', docsRoot: '/data/docs', source: 'bita', ...extra })
}

test('the bita hook records kind meeting, and still handles the two old kinds', { skip: !onMac }, async (t) => {
  for (const [kind, mode, file] of [['meeting', 'meeting', 'recording.m4a'], ['remote-meeting', 'remote', 'recording.mov'], ['in-person-meeting', 'in-person', 'recording.m4a']] as const) {
    const env = helperEnv(t, 'announce')
    const started = await recap(['bita-hook'], env, hookEvent('start', { kind }))
    assert.equal(started.code, 0, started.stdout + started.stderr)
    assert.match(started.stdout, new RegExp(`start\\(${mode}\\)`))
    const status = active(await recap(['status', '--json'], env))
    assert.equal(status['mode'], mode)
    assert.equal(status['bitaEntryId'], 7)
    assert.equal(status['title'], 'Daily')
    assert.ok(String(status['dir']).length > 0)
    const entries = readdirSync(String(status['dir']))
    assert.ok(entries.includes(file), entries.join(','))
    const stopped = await recap(['bita-hook'], env, hookEvent('amend', { kind: null, running: true }, { previousKind: kind, previousTitle: 'Daily' }))
    assert.equal(stopped.code, 0, stopped.stdout + stopped.stderr)
    assert.match(stopped.stdout, /stopWithoutProcessing/)
    const shown = data(await recap(['show', 'last', '--json'], env))
    assert.equal(shown['status'], 'recorded')
    assert.equal(shown['mode'], mode)
  }
})

test('the bita hook falls back to in-person for kind meeting with a legacy helper and discards on cancel', { skip: !onMac }, async (t) => {
  const env = helperEnv(t, 'legacy')
  const started = await recap(['bita-hook'], env, hookEvent('start', { kind: 'meeting' }))
  assert.equal(started.code, 0, started.stdout + started.stderr)
  const status = active(await recap(['status', '--json'], env))
  assert.equal(status['mode'], 'in-person')
  assert.equal(status['fallback'], 'in-person')
  const second = await recap(['bita-hook'], env, hookEvent('start', { kind: 'meeting', id: 8 }))
  assert.match(second.stdout, /another meeting is already being recorded/)
  const cancelled = await recap(['bita-hook'], env, hookEvent('cancel', { kind: 'meeting' }))
  assert.equal(cancelled.code, 0, cancelled.stdout + cancelled.stderr)
  assert.deepEqual(data(await recap(['list', '--json'], env)), [])
})

test('the bita hook ignores kinds that are not meetings', { skip: !onMac }, async (t) => {
  const env = helperEnv(t, 'announce')
  const run = await recap(['bita-hook'], env, hookEvent('start', { kind: 'meetings' }))
  assert.equal(run.code, 0)
  assert.match(run.stdout, /is not a meeting/)
  assert.deepEqual(data(await recap(['list', '--json'], env)), [])
})
