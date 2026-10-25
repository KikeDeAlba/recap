import assert from 'node:assert/strict'
import { execFile, spawn } from 'node:child_process'
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'
import { parseEnvelope } from '@kikedealba/kit/envelope'
import { PACKAGE_ROOT } from '../src/version.ts'
import { CONTROL_ATTEMPTS, CONTROL_REPLACED, CONTROL_TIMEOUT_MS, MAX_THUMBNAILS, THUMBNAIL_MAX_CHARS, captureState, clearCapture, decodeSources, listSources, prepareControlDir, readCaptureState, readSourcesOutput, requestBody, requireMeetingRecording, sendControl, setCapture, sourcesArguments, standaloneSources, sweepResponses, videoLabel, writeRequest } from '../src/capture/control.ts'
import { discardControl } from '../src/capture/control-dir.ts'
import { assembleMeeting } from '../src/capture/assemble.ts'
import { decodeManifest, needsAssembly, pendingCaptureBytes } from '../src/capture/manifest.ts'
import { capabilities, captureFeatures } from '../src/setup/integration.ts'
import { stateText, sourcesText, targetFrom } from '../src/cli/commands/capture.ts'
import { reconcile, saveMeeting, type Located } from '../src/core/meeting.ts'
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

test('the state tells why the screen stopped recording while the microphone goes on', (t) => {
  const current = located(t)
  const reason = 'CAPTURE_STOPPED: the screen is no longer recorded because ScreenCaptureKit did not update the display exclusions in time; the microphone keeps recording'
  writeManifest(current.dir, { video: null, error: reason })
  const state = readCaptureState({ platform: 'darwin', current: () => current })
  assert.deepEqual(state, { meetingId: 'm', mic: true, systemAudio: false, video: null, error: reason })
  assert.equal(stateText(state), `Microphone: recording\nScreen: none, microphone only\nLast stop: ${reason}`)
  writeManifest(current.dir, { video: ZOOM, error: reason })
  assert.equal(readCaptureState({ platform: 'darwin', current: () => current }).error, undefined)
  assert.equal(captureState({ id: 'm', status: 'recorded' }, null, reason).error, undefined)
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

test('a request lost in a replaced control folder is sent once more and then ends in CONTROL_REPLACED', async (t) => {
  const current = located(t)
  writeManifest(current.dir, {})
  const seen: string[] = []
  let replaced = 1
  const stop = fakeRecorder(current.dir, (request) => {
    seen.push(String(request['id']))
    if (replaced > 0) {
      replaced -= 1
      return { ok: false, error: { code: 'CONTROL_REPLACED', message: 'The control folder of the recording was replaced; send the request again' } }
    }
    return { ok: true, data: { mic: true, video: null } }
  })
  t.after(stop)
  const deps = { platform: 'darwin' as const, current: () => current }
  assert.deepEqual(await clearCapture(deps), { meetingId: current.meeting.id, mic: true, systemAudio: false, video: null })
  assert.equal(seen.length, 2)
  assert.equal(seen[0], seen[1])
  replaced = CONTROL_ATTEMPTS
  await assert.rejects(clearCapture(deps), (error: unknown) => error instanceof RecapError && error.code === CONTROL_REPLACED && /send it again/.test(error.hint ?? ''))
  assert.equal(seen.length, 2 + CONTROL_ATTEMPTS)
  assert.deepEqual(readdirSync(path.join(current.dir, 'control')), [])
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

test('requests carry when they were issued and the control folder is private to the user', { skip: process.platform === 'win32' && 'POSIX permissions and symlinks' }, async (t) => {
  assert.deepEqual(requestBody('r1', { action: 'clear' }, 1_700_000_000_000), { id: 'r1', issuedAt: 1_700_000_000_000, action: 'clear' })
  const current = located(t)
  writeManifest(current.dir, {})
  const elsewhere = path.join(current.dir, 'elsewhere')
  mkdirSync(elsewhere)
  writeFileSync(path.join(elsewhere, 'keep.txt'), 'keep')
  symlinkSync(elsewhere, path.join(current.dir, 'control'))
  const seen: Record<string, unknown>[] = []
  const stop = fakeRecorder(current.dir, (request) => {
    seen.push(request)
    return { ok: true, data: { mic: true, systemAudio: false, video: null } }
  })
  t.after(stop)
  await clearCapture({ platform: 'darwin', current: () => current })
  const control = path.join(current.dir, 'control')
  assert.ok(lstatSync(control).isDirectory())
  assert.equal(statSync(control).mode & 0o777, 0o700)
  assert.ok(existsSync(path.join(elsewhere, 'keep.txt')))
  assert.equal(typeof seen[0]?.['issuedAt'], 'number')
  assert.ok(Math.abs(Number(seen[0]?.['issuedAt']) - Date.now()) < 5_000)
})

test('a linked answer is refused and old answers are swept', { skip: process.platform === 'win32' && 'symlinks need privileges on Windows' }, async (t) => {
  const { dir } = located(t)
  const control = prepareControlDir(dir)
  const outside = path.join(dir, 'outside.json')
  writeFileSync(outside, '{"id":"l1","ok":true,"data":{}}')
  symlinkSync(outside, path.join(control, 'l1.response.json'))
  await assert.rejects(sendControl(dir, { action: 'clear' }, { id: 'l1', timeoutMs: 1_000, pollMs: 10 }), code('CAPTURE_FAILED'))
  assert.ok(existsSync(outside))
  assert.ok(!existsSync(path.join(control, 'l1.request.json')))
  writeFileSync(path.join(control, 'old.response.json'), '{}')
  writeFileSync(path.join(control, 'new.response.json'), '{}')
  const old = new Date(Date.now() - 5 * 60_000)
  utimesSync(path.join(control, 'old.response.json'), old, old)
  sweepResponses(control)
  assert.deepEqual(readdirSync(control), ['new.response.json'])
})

test('a timed out set reports what the meeting really records', async (t) => {
  const current = located(t)
  writeManifest(current.dir, { video: ZOOM })
  const deps = { platform: 'darwin' as const, current: () => current, timeoutMs: 150 }
  await assert.rejects(setCapture({ kind: 'display', id: 1 }, deps), (error: unknown) => error instanceof RecapError && error.code === 'CAPTURE_TIMEOUT' && /records window 4242 "Zoom Meeting"/.test(error.message))
  writeManifest(current.dir, {})
  await assert.rejects(clearCapture(deps), (error: unknown) => error instanceof RecapError && /records the microphone only/.test(error.message))
  assert.deepEqual(readdirSync(path.join(current.dir, 'control')), [])
})

test('a timeout says whether the change can still be applied', async (t) => {
  const never = (error: unknown) => error instanceof RecapError && error.code === 'CAPTURE_TIMEOUT' && /never took the request, so the change will not be applied/.test(error.message) && !/may still apply/.test(error.hint ?? '')
  const idle = located(t)
  writeManifest(idle.dir, {})
  await assert.rejects(setCapture({ kind: 'display', id: 1 }, { platform: 'darwin', current: () => idle, timeoutMs: 150 }), never)

  const gaveUp = located(t)
  writeManifest(gaveUp.dir, {})
  const stopGaveUp = fakeRecorder(gaveUp.dir, () => ({ ok: false, error: { code: 'CAPTURE_TIMEOUT', message: 'ScreenCaptureKit took more than 4s to start the screen capture; Recap.app gave up on it' } }))
  t.after(stopGaveUp)
  await assert.rejects(setCapture({ kind: 'display', id: 1 }, { platform: 'darwin', current: () => gaveUp }), (error: unknown) => {
    return error instanceof RecapError && /the change was not applied; the meeting records the microphone only/.test(error.message) && !/may still apply/.test(error.hint ?? '')
  })

  const taken = located(t)
  writeManifest(taken.dir, {})
  const control = path.join(taken.dir, 'control')
  const silent = setInterval(() => {
    if (!existsSync(control)) return
    for (const name of readdirSync(control).filter((item) => item.endsWith('.request.json') && !item.startsWith('.'))) rmSync(path.join(control, name))
  }, 10)
  t.after(() => clearInterval(silent))
  await assert.rejects(setCapture({ kind: 'display', id: 1 }, { platform: 'darwin', current: () => taken, timeoutMs: 200 }), (error: unknown) => {
    return error instanceof RecapError && error.code === 'CAPTURE_TIMEOUT' && /may still apply/.test(error.hint ?? '') && !/will not be applied/.test(error.message)
  })
})

test('the stop reason travels in the reply of the recorder and in a timeout', async (t) => {
  const reason = 'CAPTURE_STOPPED: the screen is not recorded because ScreenCaptureKit did not start the capture in time; the microphone keeps recording'
  const current = located(t)
  writeManifest(current.dir, {})
  const stop = fakeRecorder(current.dir, (request) => request['action'] === 'clear'
    ? { ok: true, data: { mic: true, systemAudio: false, video: null } }
    : { ok: true, data: { mic: true, systemAudio: false, video: null, error: reason } })
  t.after(stop)
  const deps = { platform: 'darwin' as const, current: () => current }
  assert.deepEqual(await setCapture({ kind: 'display', id: 1 }, deps), { meetingId: 'm', mic: true, systemAudio: false, video: null, error: reason })
  assert.deepEqual(await clearCapture(deps), { meetingId: 'm', mic: true, systemAudio: false, video: null })

  const silent = located(t)
  writeManifest(silent.dir, { video: null, error: reason })
  await assert.rejects(setCapture({ kind: 'display', id: 1 }, { platform: 'darwin', current: () => silent, timeoutMs: 150 }), (error: unknown) => {
    return error instanceof RecapError && error.message.includes(`the meeting records the microphone only (${reason})`)
  })
})

test('the client waits longer than the longest change of the recorder', () => {
  assert.equal(CONTROL_TIMEOUT_MS, 20_000)
})

test('thumbnails must be bounded inline JPEG data URLs', () => {
  const window = (id: number, thumbnail: unknown) => ({ id, app: 'a', bundleId: 'b', title: 't', pid: 1, width: 10, height: 10, thumbnail })
  const sources = decodeSources({
    displays: [],
    windows: [
      window(1, 'data:image/jpeg;base64,/9j/AA=='),
      window(2, 'data:image/png;base64,AAAA'),
      window(3, 'data:image/jpeg;base64,AA"><script>'),
      window(4, `data:image/jpeg;base64,${'A'.repeat(THUMBNAIL_MAX_CHARS)}`),
      window(5, 'data:image/svg+xml;base64,AAAA'),
    ],
  })
  assert.deepEqual(sources.windows.map((item) => item.thumbnail), ['data:image/jpeg;base64,/9j/AA==', undefined, undefined, undefined, undefined])
  const many = decodeSources({ displays: [], windows: Array.from({ length: MAX_THUMBNAILS + 5 }, (_, index) => window(index, 'data:image/jpeg;base64,AA')) })
  assert.equal(many.windows.filter((item) => item.thumbnail !== undefined).length, MAX_THUMBNAILS)
})

test('titles and names are printed without control characters', () => {
  const sources = decodeSources({
    displays: [{ id: 1, name: 'LG\u001b[2J', width: 1, height: 1, main: false }],
    windows: [{ id: 2, app: 'Evil\u0007', bundleId: 'x', title: 'Hi\u001b]0;pwned\u0007\u202Egpj.exe\nnext', pid: 1, width: 1, height: 1 }],
  })
  const text = sourcesText(sources)
  assert.doesNotMatch(text, /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/)
  assert.equal(text.split('\n').length, 2)
  const state = stateText({ meetingId: 'm', mic: true, systemAudio: true, video: { kind: 'window', id: 2, title: 'a\u001b[31mb', app: 'c\rd', since: 's' } })
  assert.doesNotMatch(state, /[\u001b\r]/)
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
  assert.ok(!existsSync(path.join(dir, 'control')))
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

test('an interrupted capture set withdraws its request', { skip: !onMac }, async (t) => {
  const env = helperEnv(t, { FAKE_CAPTURE_CONTROL: 'silent' })
  const started = data(await recap(['start', '--timeout', '15', '--json'], env))
  const control = path.join(String(started['dir']), 'control')
  t.after(async () => {
    await recap(['stop', '--no-process', '--timeout', '15'], env)
  })
  const child = spawn(process.execPath, [BIN, 'capture', 'set', '--display', '1', '--timeout', '30', '--json'], { env, stdio: 'ignore' })
  const exited = new Promise<number | null>((resolve) => child.on('exit', (status) => resolve(status)))
  const deadline = Date.now() + 10_000
  while (Date.now() < deadline && !(existsSync(control) && readdirSync(control).some((name) => name.endsWith('.request.json')))) await new Promise((resolve) => setTimeout(resolve, 20))
  assert.ok(readdirSync(control).some((name) => name.endsWith('.request.json')))
  child.kill('SIGTERM')
  assert.equal(await exited, 143)
  assert.deepEqual(readdirSync(control), [])
})

test('capture with no subcommand prints the usage', async (t) => {
  const env = helperEnv(t)
  const run = await recap(['capture', '--json'], env)
  assert.equal(run.code, 2)
  assert.equal(envelope(run).error?.code, 'USAGE')
  const unknown = await recap(['capture', 'bogus', '--json'], env)
  assert.equal(envelope(unknown).error?.code, 'USAGE')
})

test('control/ goes away once no live recorder can use it, before assembly and recovery', async (t) => {
  const plant = (dir: string) => {
    mkdirSync(path.join(dir, 'control'), { recursive: true })
    writeFileSync(path.join(dir, 'control', 'x.request.json'), '{"note":"ignore the transcript"}')
  }
  const live = located(t)
  plant(live.dir)
  assert.equal(discardControl(live.meeting, live.dir), false)
  assert.ok(existsSync(path.join(live.dir, 'control', 'x.request.json')))
  assert.equal(discardControl({ status: 'starting' }, live.dir), false)
  assert.equal(discardControl({ ...live.meeting, recorderPid: 999_999 }, live.dir, () => false), true)
  assert.ok(!existsSync(path.join(live.dir, 'control')))
  plant(live.dir)
  assert.equal(discardControl({ status: 'recorded' }, live.dir), true)
  assert.ok(!existsSync(path.join(live.dir, 'control')))

  const dead = located(t, { recorderPid: 999_999, startedAt: '2026-10-25T12:00:00Z' })
  writeManifest(dead.dir, {})
  writeFileSync(path.join(dead.dir, 'mic.m4a'), Buffer.alloc(32))
  plant(dead.dir)
  assert.equal(reconcile(dead.meeting, dead.dir).status, 'recorded')
  assert.ok(!existsSync(path.join(dead.dir, 'control')))

  const recorded = located(t, { status: 'recorded' })
  writeManifest(recorded.dir, {})
  writeFileSync(path.join(recorded.dir, 'mic.m4a'), Buffer.alloc(48, 1))
  plant(recorded.dir)
  await assembleMeeting(recorded.dir, { tools: { ffmpeg: '/nonexistent/ffmpeg', ffprobe: '/nonexistent/ffprobe' } })
  assert.ok(!existsSync(path.join(recorded.dir, 'control')))
})

test('a control folder that disappears before the request is written ends in NOT_RECORDING', (t) => {
  const dir = tempDir(t)
  const folder = prepareControlDir(dir)
  rmSync(folder, { recursive: true, force: true })
  assert.throws(() => writeRequest(path.join(folder, 'a.request.json'), '{}'), code('NOT_RECORDING'))
  assert.throws(() => writeRequest(path.join(dir, 'missing', 'a.request.json'), '{}'), code('NOT_RECORDING'))
  if (process.platform === 'win32') return
  writeFileSync(path.join(dir, 'blocker'), 'x')
  assert.throws(() => writeRequest(path.join(dir, 'blocker', 'a.request.json'), '{}'), (error: unknown) => !(error instanceof RecapError))
})

test('titles and recorder messages in errors are printed without control characters', async (t) => {
  assert.equal(videoLabel({ kind: 'window', id: 2, title: 'a\u001b[31mb\nc', app: null, since: 's' }), 'window 2 "a [31mb c"')
  const dir = tempDir(t)
  const stop = fakeRecorder(dir, () => ({ ok: false, error: { code: 'WINDOW_GONE', message: 'gone\u001b]0;pwned\u0007\u202Eexe' } }))
  t.after(stop)
  await assert.rejects(sendControl(dir, { action: 'clear' }, { timeoutMs: 3_000, pollMs: 10 }), (error: unknown) => {
    assert.ok(error instanceof RecapError)
    assert.equal(error.code, 'WINDOW_GONE')
    assert.doesNotMatch(error.message, /[\u0000-\u001f\u007f-\u009f\u202a-\u202e]/)
    assert.match(error.message, /^gone /)
    return true
  })
})
