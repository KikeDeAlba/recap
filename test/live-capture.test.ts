import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'
import { parseEnvelope } from '@kikedealba/kit/envelope'
import { PACKAGE_ROOT } from '../src/version.ts'
import { captureState, decodeSources, listSources, readCaptureState, readSourcesOutput, requireMeetingRecording, sendControl, setCapture, sourcesArguments, standaloneSources } from '../src/capture/control.ts'
import { decodeManifest, needsAssembly, pendingCaptureBytes } from '../src/capture/manifest.ts'
import { capabilities, captureFeatures } from '../src/setup/integration.ts'
import { stateText, sourcesText, targetFrom } from '../src/cli/commands/capture.ts'
import { saveMeeting, type Located } from '../src/core/meeting.ts'
import { RecapError } from '../src/errors.ts'
import { isAlive } from '../src/core/proc.ts'
import { meeting, sandboxEnv, tempDir } from './helpers.ts'

const BIN = path.join(PACKAGE_ROOT, 'src', 'bin', 'recap.ts')
const FAKE = path.join(import.meta.dirname, 'fakes', 'fake-recap-capture.cjs')
const onMac = process.platform === 'darwin'

const ZOOM = { kind: 'window', id: 4242, title: 'Zoom Meeting', app: 'zoom.us', since: '2026-10-25T12:00:00Z' }

function code(name: string) {
  return (error: unknown) => error instanceof RecapError && error.code === name
}

function located(t: { after: (fn: () => void) => void }, overrides: Parameters<typeof meeting>[0] = {}): Located {
  const dir = tempDir(t)
  const value = meeting({ mode: 'meeting', status: 'recording', recorderPid: process.pid, ...overrides })
  saveMeeting(value, dir)
  return { meeting: value, dir }
}

function writeManifest(dir: string, manifest: Record<string, unknown>): void {
  writeFileSync(path.join(dir, 'capture.json'), JSON.stringify({ version: 1, mic: 'mic.m4a', startedAt: '2026-10-25T12:00:00Z', video: null, segments: [], ...manifest }))
}

function fakeRecorder(dir: string, answer: (request: Record<string, unknown>) => Record<string, unknown>): () => void {
  const control = path.join(dir, 'control')
  const timer = setInterval(() => {
    if (!existsSync(control)) return
    for (const name of readdirSync(control).filter((item) => item.endsWith('.request.json') && !item.startsWith('.'))) {
      const id = name.slice(0, -'.request.json'.length)
      const request = JSON.parse(readFileSync(path.join(control, name), 'utf8')) as Record<string, unknown>
      rmSync(path.join(control, name))
      writeFileSync(path.join(control, `${id}.response.json`), JSON.stringify({ id, ...answer(request) }))
    }
  }, 10)
  return () => clearInterval(timer)
}

test('capture.json is read defensively and tells when a recording still needs assembling', (t) => {
  const manifest = decodeManifest(JSON.stringify({
    mic: '../escape.m4a',
    video: ZOOM,
    segments: [{ file: 'screen-1.mov', startMs: 1200.7, endMs: 5000 }, { file: '../x.mov', startMs: 1 }, { file: 'screen-2.mov' }, { file: 'screen-3.mov', startMs: 9000 }],
  }))
  assert.deepEqual(manifest, {
    mic: 'mic.m4a',
    startedAt: undefined,
    endedAt: undefined,
    video: ZOOM,
    segments: [{ file: 'screen-1.mov', startMs: 1200, endMs: 5000 }, { file: 'screen-3.mov', startMs: 9000, endMs: undefined }],
    error: undefined,
  })
  assert.equal(decodeManifest('not json'), null)
  const { dir } = located(t)
  assert.equal(needsAssembly(dir, 'meeting'), false)
  writeManifest(dir, {})
  assert.equal(needsAssembly(dir, 'meeting'), false)
  writeFileSync(path.join(dir, 'mic.m4a'), Buffer.alloc(10))
  assert.equal(pendingCaptureBytes(dir, 'meeting'), 10)
  assert.equal(needsAssembly(dir, 'meeting'), true)
  assert.equal(needsAssembly(dir, 'remote'), false)
  writeFileSync(path.join(dir, 'recording.mov'), 'x')
  assert.equal(needsAssembly(dir, 'meeting'), false)
})

test('the capture state JSON has exactly meetingId, mic, systemAudio and video', () => {
  assert.equal(JSON.stringify(captureState({ id: 'm1', status: 'recording' }, null)), '{"meetingId":"m1","mic":true,"systemAudio":false,"video":null}')
  assert.equal(
    JSON.stringify(captureState({ id: 'm1', status: 'recording' }, ZOOM as never)),
    '{"meetingId":"m1","mic":true,"systemAudio":true,"video":{"kind":"window","id":4242,"title":"Zoom Meeting","app":"zoom.us","since":"2026-10-25T12:00:00Z"}}',
  )
  assert.equal(JSON.stringify(captureState({ id: 'm1', status: 'recorded' }, ZOOM as never)), '{"meetingId":"m1","mic":false,"systemAudio":false,"video":null}')
})

test('sources keep their contract keys in order and drop malformed entries', () => {
  const sources = decodeSources({
    displays: [{ main: true, height: 982, width: 1512, name: 'Built-in Retina Display', id: 1, extra: 1 }, { id: 'x' }],
    windows: [
      { thumbnail: 'data:image/jpeg;base64,AA', height: 800, width: 1280, pid: 777, title: 'Zoom Meeting', bundleId: 'us.zoom.xos', app: 'zoom.us', id: 4242 },
      { id: 9, app: 'x', bundleId: 'y', title: 'z', pid: 1, width: 1, height: 1, thumbnail: 'javascript:alert(1)' },
      { id: 10 },
    ],
  })
  assert.equal(
    JSON.stringify(sources),
    '{"displays":[{"id":1,"name":"Built-in Retina Display","width":1512,"height":982,"main":true}],' +
      '"windows":[{"id":4242,"app":"zoom.us","bundleId":"us.zoom.xos","title":"Zoom Meeting","pid":777,"width":1280,"height":800,"thumbnail":"data:image/jpeg;base64,AA"},' +
      '{"id":9,"app":"x","bundleId":"y","title":"z","pid":1,"width":1,"height":1}]}',
  )
  assert.equal(sourcesText(sources), 'display 1 (main): Built-in Retina Display 1512x982\nwindow 4242: zoom.us — Zoom Meeting\nwindow 9: x — z')
  assert.throws(() => decodeSources(null), code('CAPTURE_FAILED'))
})

test('capture commands need a meeting being recorded by Recap.app on macOS', (t) => {
  assert.throws(() => requireMeetingRecording('linux', () => null), code('CAPTURE_UNSUPPORTED'))
  assert.throws(() => requireMeetingRecording('win32', () => null), code('CAPTURE_UNSUPPORTED'))
  assert.throws(() => requireMeetingRecording('darwin', () => null), code('NOT_RECORDING'))
  const remote = located(t, { mode: 'remote' })
  assert.throws(() => requireMeetingRecording('darwin', () => remote), code('CAPTURE_UNSUPPORTED'))
  const fallback = located(t, { mode: 'in-person', fallback: 'in-person' })
  assert.throws(() => requireMeetingRecording('darwin', () => fallback), code('CAPTURE_UNSUPPORTED'))
  const starting = located(t, { status: 'starting' })
  assert.throws(() => requireMeetingRecording('darwin', () => starting), code('NOT_RECORDING'))
  const current = located(t)
  assert.equal(requireMeetingRecording('darwin', () => current), current)
  assert.deepEqual(readCaptureState({ platform: 'darwin', current: () => current }), { meetingId: 'm', mic: true, systemAudio: false, video: null })
  writeManifest(current.dir, { video: ZOOM })
  assert.deepEqual(readCaptureState({ platform: 'darwin', current: () => current }).video, ZOOM)
})

test('an older recorder without capture.json cannot switch', async (t) => {
  const current = located(t)
  await assert.rejects(setCapture({ kind: 'display', id: 1 }, { platform: 'darwin', current: () => current }), code('CAPTURE_UNSUPPORTED'))
})

test('set and clear go through request and response files of the running recorder', async (t) => {
  const current = located(t)
  writeManifest(current.dir, {})
  const seen: Record<string, unknown>[] = []
  const stop = fakeRecorder(current.dir, (request) => {
    seen.push(request)
    if (request['action'] === 'clear') return { ok: true, data: { mic: true, systemAudio: false, video: null } }
    return { ok: true, data: { mic: true, systemAudio: true, video: ZOOM } }
  })
  t.after(stop)
  const deps = { platform: 'darwin' as const, current: () => current }
  assert.deepEqual(await setCapture({ kind: 'window', id: 4242 }, deps), { meetingId: 'm', mic: true, systemAudio: true, video: ZOOM })
  assert.deepEqual(await setCapture({ kind: 'display', id: 1 }, deps), { meetingId: 'm', mic: true, systemAudio: true, video: ZOOM })
  const { clearCapture } = await import('../src/capture/control.ts')
  assert.deepEqual(await clearCapture(deps), { meetingId: 'm', mic: true, systemAudio: false, video: null })
  assert.deepEqual(seen.map((request) => [request['action'], request['target']]), [
    ['set', { kind: 'window', id: 4242 }],
    ['set', { kind: 'display', id: 1 }],
    ['clear', undefined],
  ])
  assert.ok(seen.every((request) => typeof request['id'] === 'string' && /^[0-9a-f-]{36}$/.test(String(request['id']))))
  assert.deepEqual(readdirSync(path.join(current.dir, 'control')), [])
})

test('recorder errors keep their code: WINDOW_GONE and SCREEN_PERMISSION_DENIED', async (t) => {
  const current = located(t)
  writeManifest(current.dir, {})
  const stop = fakeRecorder(current.dir, (request) => {
    const target = request['target'] as { kind: string }
    return target.kind === 'window'
      ? { ok: false, error: { code: 'WINDOW_GONE', message: 'Window 5 is closed or no longer on screen' } }
      : { ok: false, error: { code: 'SCREEN_PERMISSION_DENIED', message: 'Recap has no screen recording access.' } }
  })
  t.after(stop)
  const deps = { platform: 'darwin' as const, current: () => current }
  await assert.rejects(setCapture({ kind: 'window', id: 5 }, deps), (error: unknown) => error instanceof RecapError && error.code === 'WINDOW_GONE' && /Window 5/.test(error.message))
  await assert.rejects(setCapture({ kind: 'display', id: 2 }, deps), code('SCREEN_PERMISSION_DENIED'))
})

test('a recorder that does not answer times out and its request is withdrawn', async (t) => {
  const { dir } = located(t)
  await assert.rejects(sendControl(dir, { action: 'clear' }, { timeoutMs: 150, pollMs: 10, id: 'late' }), code('CAPTURE_TIMEOUT'))
  assert.equal(existsSync(path.join(dir, 'control', 'late.request.json')), false)
  await assert.rejects(sendControl(dir, { action: 'clear' }, { timeoutMs: 5_000, pollMs: 10, id: 'dead', alive: () => false }), code('NOT_RECORDING'))
  assert.equal(existsSync(path.join(dir, 'control', 'dead.request.json')), false)
})

test('a garbled or foreign answer is rejected', async (t) => {
  const { dir } = located(t)
  mkdirSync(path.join(dir, 'control'), { recursive: true })
  writeFileSync(path.join(dir, 'control', 'g1.response.json'), '{"id":"other","ok":true}')
  await assert.rejects(sendControl(dir, { action: 'clear' }, { id: 'g1', timeoutMs: 1_000, pollMs: 10 }), code('CAPTURE_FAILED'))
})

test('sources come from the recorder while a meeting records and from recap-capture otherwise', async (t) => {
  const current = located(t)
  writeManifest(current.dir, {})
  const stop = fakeRecorder(current.dir, (request) => ({ ok: true, data: { displays: [{ id: 1, name: 'LG', width: 2560, height: 1440, main: false, thumbnail: request['thumbnails'] ? 'data:image/jpeg;base64,AA' : undefined }], windows: [] } }))
  t.after(stop)
  const live = await listSources(true, { platform: 'darwin', current: () => current, find: async () => null })
  assert.deepEqual(live, { displays: [{ id: 1, name: 'LG', width: 2560, height: 1440, main: false, thumbnail: 'data:image/jpeg;base64,AA' }], windows: [] })
  const calls: string[] = []
  const idle = await listSources(false, {
    platform: 'darwin',
    current: () => null,
    find: async () => ({ kind: 'binary', binary: '/x/recap-capture' }),
    standalone: async (launcher, thumbnails) => {
      calls.push(`${launcher.kind} ${thumbnails}`)
      return { displays: [], windows: [] }
    },
  })
  assert.deepEqual(idle, { displays: [], windows: [] })
  assert.deepEqual(calls, ['binary false'])
  await assert.rejects(listSources(false, { platform: 'darwin', current: () => null, find: async () => null }), code('CAPTURE_UNAVAILABLE'))
  await assert.rejects(listSources(false, { platform: 'linux' }), code('CAPTURE_UNSUPPORTED'))
})

test('standalone sources run recap-capture sources --json and map its errors', async () => {
  assert.deepEqual(sourcesArguments(true), ['sources', '--thumbnails', '--json'])
  assert.deepEqual(sourcesArguments(false), ['sources', '--json'])
  const ran: string[][] = []
  const envelope = (body: Record<string, unknown>) => ({ status: 0, signal: null, stdout: `${JSON.stringify({ schemaVersion: 1, command: 'sources', generatedAt: 'now', ...body })}\n`, stderr: '' })
  const ok = await standaloneSources({ kind: 'binary', binary: '/x/recap-capture' }, true, 1000, async (command, args) => {
    ran.push([command, ...args])
    return envelope({ ok: true, data: { displays: [{ id: 3, name: 'Studio', width: 5120, height: 2880, main: true }], windows: [] } })
  })
  assert.deepEqual(ran, [['/x/recap-capture', 'sources', '--thumbnails', '--json']])
  assert.equal(ok.displays[0]?.name, 'Studio')
  assert.throws(() => readSourcesOutput(JSON.stringify({ schemaVersion: 1, ok: false, command: 'sources', generatedAt: 'now', error: { code: 'USAGE', message: 'Unexpected argument' } }), ''), code('CAPTURE_UNSUPPORTED'))
  assert.throws(() => readSourcesOutput(JSON.stringify({ schemaVersion: 1, ok: false, command: 'sources', generatedAt: 'now', error: { code: 'SCREEN_PERMISSION_DENIED', message: 'no access' } }), ''), code('SCREEN_PERMISSION_DENIED'))
  assert.throws(() => readSourcesOutput(null, 'crashed'), code('CAPTURE_FAILED'))
})

test('capture set takes exactly one target and the text output describes the state', () => {
  assert.deepEqual(targetFrom(2, undefined), { kind: 'display', id: 2 })
  assert.deepEqual(targetFrom(undefined, 4242), { kind: 'window', id: 4242 })
  assert.throws(() => targetFrom(undefined, undefined), code('USAGE'))
  assert.throws(() => targetFrom(1, 2), code('USAGE'))
  assert.throws(() => targetFrom(-1, undefined), code('USAGE'))
  assert.equal(stateText({ meetingId: 'm', mic: true, systemAudio: false, video: null }), 'Microphone: recording\nScreen: none, microphone only')
  assert.equal(stateText({ meetingId: 'm', mic: true, systemAudio: true, video: ZOOM as never }), 'Microphone: recording\nScreen: window 4242 "Zoom Meeting" (zoom.us) with its app audio since 2026-10-25T12:00:00Z')
  assert.match(stateText({ meetingId: 'm', mic: true, systemAudio: true, video: { kind: 'display', id: 1, title: 'LG', app: null, since: 's' } }), /display 1 "LG" with system audio/)
})

test('recap announces the capture capabilities only when the recorder does', () => {
  assert.deepEqual(captureFeatures(['capture.meeting', 'capture.switch', 'capture.sources']), ['meeting.capture.sources', 'meeting.capture.switch'])
  assert.deepEqual(captureFeatures(['capture.meeting']), [])
  assert.ok(capabilities(true, ['capture.sources', 'capture.switch']).includes('meeting.capture.switch'))
  assert.ok(capabilities(true, ['capture.sources', 'capture.switch']).includes('meeting.capture.sources'))
  assert.ok(!capabilities(false, ['capture.sources', 'capture.switch']).includes('meeting.capture.switch'))
  assert.ok(!capabilities(true).includes('meeting.capture.sources'))
})

interface Run {
  code: number
  stdout: string
  stderr: string
}

function recap(args: string[], env: NodeJS.ProcessEnv): Promise<Run> {
  return new Promise((resolve) => {
    execFile(process.execPath, [BIN, ...args], { env, maxBuffer: 16 * 1024 * 1024 }, (error, stdout, stderr) => {
      resolve({ code: error ? Number((error as { code?: number }).code ?? 1) : 0, stdout: String(stdout), stderr: String(stderr) })
    })
  })
}

function helperEnv(t: { after: (fn: () => void) => void }, extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const dir = tempDir(t)
  const helper = path.join(dir, 'recap-capture')
  writeFileSync(helper, `#!${process.execPath}\n${readFileSync(FAKE, 'utf8')}`)
  chmodSync(helper, 0o755)
  return sandboxEnv(dir, { PATH: path.dirname(process.execPath), RECAP_CAPTURE: helper, FAKE_CAPTURE_CAPS: 'switch', ...extra })
}

function envelope(run: Run): { ok: boolean; data?: Record<string, unknown>; error?: { code: string } } {
  const parsed = parseEnvelope(run.stdout)
  assert.ok(parsed, run.stdout + run.stderr)
  return parsed as never
}

function data(run: Run): Record<string, unknown> {
  const parsed = envelope(run)
  assert.equal(parsed.ok, true, run.stdout + run.stderr)
  return parsed.data ?? {}
}

test('recap capture end to end against a fake recorder', { skip: !onMac }, async (t) => {
  const env = helperEnv(t)
  assert.equal(envelope(await recap(['capture', 'state', '--json'], env)).error?.code, 'NOT_RECORDING')
  const idleSources = data(await recap(['capture', 'sources', '--thumbnails', '--json'], env))
  assert.equal((idleSources['windows'] as Record<string, unknown>[])[0]?.['thumbnail'], 'data:image/jpeg;base64,/9j/4AAQ')

  const started = data(await recap(['start', 'Sync', '--timeout', '15', '--json'], env))
  assert.equal(started['mode'], 'meeting')
  const id = String(started['id'])
  const dir = String(started['dir'])
  const recorderPid = Number(JSON.parse(readFileSync(path.join(dir, 'meeting.json'), 'utf8'))['recorderPid'])
  t.after(() => {
    if (Number.isInteger(recorderPid) && isAlive(recorderPid)) process.kill(recorderPid, 'SIGKILL')
  })

  assert.deepEqual(data(await recap(['capture', 'state', '--json'], env)), { meetingId: id, mic: true, systemAudio: false, video: null })
  const window = data(await recap(['capture', 'set', '--window', '4242', '--json'], env))
  assert.deepEqual(Object.keys(window), ['meetingId', 'mic', 'systemAudio', 'video'])
  assert.deepEqual(Object.keys(window['video'] as object), ['kind', 'id', 'title', 'app', 'since'])
  assert.equal(window['systemAudio'], true)
  assert.deepEqual({ ...(window['video'] as object), since: 'x' }, { kind: 'window', id: 4242, title: 'Zoom Meeting', app: 'zoom.us', since: 'x' })
  assert.deepEqual(data(await recap(['capture', 'state', '--json'], env))['video'], window['video'])

  const display = data(await recap(['capture', 'set', '--display', '1', '--json'], env))
  assert.deepEqual({ ...(display['video'] as object), since: 'x' }, { kind: 'display', id: 1, title: 'Built-in Retina Display', app: null, since: 'x' })

  const gone = await recap(['capture', 'set', '--window', '1', '--json'], env)
  assert.equal(gone.code, 1)
  assert.equal(envelope(gone).error?.code, 'WINDOW_GONE')
  const usage = await recap(['capture', 'set', '--window', '1', '--display', '1', '--json'], env)
  assert.equal(usage.code, 2)
  assert.equal(envelope(usage).error?.code, 'USAGE')

  const live = data(await recap(['capture', 'sources', '--json'], env))
  assert.equal((live['displays'] as unknown[]).length, 1)
  assert.equal((live['windows'] as Record<string, unknown>[])[0]?.['thumbnail'], undefined)

  assert.deepEqual(data(await recap(['capture', 'clear', '--json'], env)), { meetingId: id, mic: true, systemAudio: false, video: null })
  const text = await recap(['capture', 'state'], env)
  assert.equal(text.stdout, 'Microphone: recording\nScreen: none, microphone only\n')

  const stopped = data(await recap(['stop', '--no-process', '--timeout', '15', '--json'], env))
  assert.equal(stopped['status'], 'recorded')
  assert.ok(String(stopped['recording']).endsWith('recording.m4a'))
  assert.equal((stopped['stages'] as Record<string, { status: string }>)['assemble']?.status, 'done')
  assert.ok(!existsSync(path.join(dir, 'mic.m4a')))
  assert.deepEqual(JSON.parse(readFileSync(path.join(dir, 'meeting.json'), 'utf8'))['channels'], ['mic'])
  assert.equal(envelope(await recap(['capture', 'clear', '--json'], env)).error?.code, 'NOT_RECORDING')

  const caps = data(await recap(['capabilities', '--json'], env))
  assert.ok((caps['capabilities'] as string[]).includes('meeting.capture.sources'))
  assert.ok((caps['capabilities'] as string[]).includes('meeting.capture.switch'))
})

test('recap capture refuses a remote recording and an old recorder', { skip: !onMac }, async (t) => {
  const env = helperEnv(t)
  const remote = data(await recap(['start', '--remote', '--timeout', '15', '--json'], env))
  assert.equal(remote['mode'], 'remote')
  const refused = await recap(['capture', 'set', '--display', '1', '--json'], env)
  assert.equal(envelope(refused).error?.code, 'CAPTURE_UNSUPPORTED')
  assert.equal(envelope(await recap(['capture', 'state', '--json'], env)).error?.code, 'CAPTURE_UNSUPPORTED')
  await recap(['stop', '--no-process', '--timeout', '15'], env)

  const old = helperEnv(t, { FAKE_CAPTURE_CAPS: 'announce' })
  data(await recap(['start', '--timeout', '15', '--json'], old))
  assert.equal(envelope(await recap(['capture', 'set', '--display', '1', '--json'], old)).error?.code, 'CAPTURE_UNSUPPORTED')
  assert.equal(envelope(await recap(['capture', 'sources', '--json'], old)).error?.code, 'CAPTURE_UNSUPPORTED')
  const caps = data(await recap(['capabilities', '--json'], old))
  assert.ok(!(caps['capabilities'] as string[]).includes('meeting.capture.switch'))
  await recap(['stop', '--no-process', '--timeout', '15'], old)
})

test('a recorder that never answers makes capture set time out', { skip: !onMac }, async (t) => {
  const env = helperEnv(t, { FAKE_CAPTURE_CONTROL: 'silent' })
  data(await recap(['start', '--timeout', '15', '--json'], env))
  const run = await recap(['capture', 'set', '--display', '1', '--timeout', '1', '--json'], env)
  assert.equal(envelope(run).error?.code, 'CAPTURE_TIMEOUT')
  await recap(['stop', '--no-process', '--timeout', '15'], env)
})

test('capture with no subcommand prints the usage', async (t) => {
  const env = helperEnv(t)
  const run = await recap(['capture', '--json'], env)
  assert.equal(run.code, 2)
  assert.equal(envelope(run).error?.code, 'USAGE')
  const unknown = await recap(['capture', 'bogus', '--json'], env)
  assert.equal(envelope(unknown).error?.code, 'USAGE')
})
