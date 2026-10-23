import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'
import { platformContext, type Platform, type PlatformContext } from '@kikedealba/kit/platform'
import { FfmpegRecorder, MacAppRecorder, defaultMonitor, selectRecorder } from '../src/capture/recorder.ts'
import {
  CAPTURE_DIR,
  STOP_REQUEST,
  captureChannels,
  encoderArguments,
  hasPulseInput,
  loopbackPath,
  micDevice,
  monitorOf,
  muxArguments,
  parseDefaultSink,
  sourceSpecs,
} from '../src/capture/sources.ts'
import { CaptureSupervisor, leadingSilence } from '../src/capture/worker.ts'
import { liveWorkerFor } from '../src/cli/commands/capture.ts'
import { loadMeeting, reconcile } from '../src/core/meeting.ts'
import { recoverCapture, recoveryArguments } from '../src/capture/recover.ts'
import { isAlive, waitUntil } from '../src/core/proc.ts'
import { channelsOf } from '../src/pipeline/pipeline.ts'
import { meeting, meetingDir, tempDir } from './helpers.ts'

const posix = process.platform !== 'win32'
const FAKE = path.join(import.meta.dirname, 'fakes', 'fake-ffmpeg.cjs')

function ctxFor(platform: Platform, env: NodeJS.ProcessEnv = {}): PlatformContext {
  return platformContext({ platform, env: { HOME: '/home/ana', LOCALAPPDATA: 'C:\\Users\\ana\\AppData\\Local', ...env }, home: '/home/ana' })
}

test('builds the Linux sources with PulseAudio: default mic and the monitor of the default sink', () => {
  const ctx = ctxFor('linux')
  const specs = sourceSpecs('remote', ctx, { ffmpeg: '/usr/bin/ffmpeg', monitor: 'alsa_output.pci.analog-stereo.monitor' })
  assert.deepEqual(
    specs.map((spec) => [spec.channel, spec.command, spec.args[spec.args.indexOf('-i') + 1], spec.args[spec.args.indexOf('-channels') + 1]]),
    [
      ['mic', '/usr/bin/ffmpeg', 'default', '1'],
      ['system', '/usr/bin/ffmpeg', 'alsa_output.pci.analog-stereo.monitor', '2'],
    ],
  )
  for (const spec of specs) {
    assert.deepEqual(spec.args.slice(spec.args.indexOf('-f'), spec.args.indexOf('-f') + 2), ['-f', 'pulse'])
    assert.deepEqual(spec.args.slice(-7), ['-f', 's16le', '-ac', String(spec.format?.channels), '-ar', '48000', 'pipe:1'])
    assert.ok(!spec.args.includes('-nostdin'))
  }
  assert.deepEqual(sourceSpecs('in-person', ctx, { ffmpeg: 'ffmpeg' }).map((spec) => spec.channel), ['mic'])
  assert.deepEqual(captureChannels('remote'), channelsOf(meeting({ mode: 'remote' })).map(([channel]) => channel))
  assert.deepEqual(captureChannels('in-person'), channelsOf(meeting({ mode: 'in-person' })).map(([channel]) => channel))
})

test('builds the Windows sources with recap-loopback, or dshow for a configured microphone', () => {
  const ctx = ctxFor('win32')
  const helper = loopbackPath(ctx)
  assert.equal(path.basename(helper), 'recap-loopback.exe')
  assert.ok(helper.includes(path.join('bin', 'recap-loopback.exe')))
  assert.equal(loopbackPath(ctxFor('win32', { RECAP_LOOPBACK: 'D:\\x.exe' })), 'D:\\x.exe')
  const specs = sourceSpecs('remote', ctx, { ffmpeg: 'C:\\ffmpeg.exe', loopback: helper })
  assert.deepEqual(
    specs.map((spec) => [spec.command, ...spec.args, spec.format]),
    [
      [helper, '--source', 'mic', '--rate', '48000', '--channels', '1', null],
      [helper, '--source', 'system', '--rate', '48000', '--channels', '2', null],
    ],
  )
  const dshow = sourceSpecs('remote', ctx, { ffmpeg: 'C:\\ffmpeg.exe', loopback: helper, micDevice: 'Micrófono (USB)' })
  assert.equal(dshow[0]?.command, 'C:\\ffmpeg.exe')
  assert.deepEqual(dshow[0]?.args.slice(dshow[0].args.indexOf('-f'), dshow[0].args.indexOf('-f') + 4), ['-f', 'dshow', '-i', 'audio=Micrófono (USB)'])
  assert.deepEqual(dshow[0]?.format, { channels: 1, rate: 48_000 })
  assert.equal(dshow[1]?.command, helper)
  assert.equal(micDevice({ capture: { micDevice: '  Mic  ' } }), 'Mic')
  assert.equal(micDevice({ capture: { micDevice: '' } }), undefined)
  assert.equal(micDevice({}), undefined)
})

test('encodes each source to AAC and muxes them with -c copy in the channelsOf order', () => {
  const mic = encoderArguments('mic', { channels: 2, rate: 44_100 }, '/m/capture/mic.aac')
  assert.deepEqual(mic.slice(mic.indexOf('-f'), mic.indexOf('pipe:0') + 1), ['-f', 's16le', '-ar', '44100', '-ac', '2', '-i', 'pipe:0'])
  assert.deepEqual(mic.slice(mic.indexOf('-c:a')), ['-c:a', 'aac', '-b:a', '64k', '-ac', '1', '-ar', '48000', '-f', 'adts', '/m/capture/mic.aac'])
  assert.ok(mic.includes('-nostdin'))
  const system = encoderArguments('system', { channels: 2, rate: 48_000 }, 'system.aac')
  assert.deepEqual(system.slice(system.indexOf('-b:a'), system.indexOf('-b:a') + 4), ['-b:a', '96k', '-ac', '2'])
  const mux = muxArguments(['mic.aac', 'system.aac'], 'recording.m4a')
  assert.deepEqual(mux.slice(5), ['-i', 'mic.aac', '-i', 'system.aac', '-map', '0:a:0', '-map', '1:a:0', '-c', 'copy', '-movflags', '+faststart', 'recording.m4a'])
  assert.ok(!mux.includes('-itsoffset'))
  assert.equal(leadingSilence(250, { channels: 2, rate: 48_000 }).length, 12_000 * 2 * 2)
  assert.equal(leadingSilence(0, { channels: 1, rate: 48_000 }).length, 0)
  assert.ok(leadingSilence(10, { channels: 1, rate: 48_000 }).every((byte) => byte === 0))
})

test('reads the default sink and the PulseAudio input of ffmpeg', () => {
  assert.equal(monitorOf('alsa_output.x'), 'alsa_output.x.monitor')
  assert.equal(monitorOf('alsa_output.x.monitor'), 'alsa_output.x.monitor')
  assert.equal(parseDefaultSink('Server Name: PulseAudio (on PipeWire 1.2.7)\nDefault Sink: alsa_output.usb\nDefault Source: x\n'), 'alsa_output.usb')
  assert.equal(parseDefaultSink('nothing'), null)
  assert.ok(hasPulseInput('Devices:\n D. = Demuxing supported\n --\n DE alsa    ALSA\n D  pulse   Pulse audio input\n'))
  assert.ok(!hasPulseInput(' D  alsa   ALSA\n  E pulse  Pulse audio output\n'))
})

test('selects the recorder by platform', () => {
  assert.ok(selectRecorder(ctxFor('darwin'), {}) instanceof MacAppRecorder)
  assert.equal(selectRecorder(ctxFor('linux'), {}).kind, 'ffmpeg-linux')
  assert.equal(selectRecorder(ctxFor('win32'), {}).kind, 'windows')
})

function fakeTool(t: { after: (fn: () => void) => void }, name: string, body?: string): string {
  const dir = tempDir(t)
  const file = path.join(dir, name)
  writeFileSync(file, body ?? `#!/bin/sh\nexec "${process.execPath}" "${FAKE}" "$@"\n`)
  chmodSync(file, 0o755)
  return file
}

test('the Linux recorder reports what is missing', { skip: !posix && 'needs a POSIX shell' }, async (t) => {
  const ffmpeg = fakeTool(t, 'ffmpeg')
  const pactl = fakeTool(t, 'pactl', '#!/bin/sh\nexit 0\n')
  const sandboxed = process.env['RECAP_PACTL']
  t.after(() => {
    process.env['RECAP_PACTL'] = sandboxed
  })
  assert.deepEqual((await new FfmpegRecorder(ctxFor('linux'), { tools: { ffmpeg, pactl } }).check()).missing, ['pactl'])
  process.env['RECAP_PACTL'] = pactl
  const ready = await new FfmpegRecorder(ctxFor('linux'), { tools: { ffmpeg } }).check()
  assert.deepEqual(ready, { ok: true, missing: [] })
  process.env['FAKE_NO_PULSE'] = '1'
  t.after(() => delete process.env['FAKE_NO_PULSE'])
  const noPulse = await new FfmpegRecorder(ctxFor('linux'), { tools: { ffmpeg } }).check()
  assert.deepEqual(noPulse.missing, ['ffmpeg-pulse'])
  const windows = await new FfmpegRecorder(ctxFor('win32', { RECAP_LOOPBACK: path.join(tempDir(t), 'none.exe') }), { tools: { ffmpeg } }).check()
  assert.deepEqual(windows.missing, ['recap-loopback'])
  assert.match(windows.hint ?? '', /recap setup/)
})

test('finds the monitor with pactl get-default-sink, or pactl info on older versions', { skip: !posix && 'needs a POSIX shell' }, async (t) => {
  const modern = fakeTool(t, 'pactl', '#!/bin/sh\n[ "$1" = get-default-sink ] && echo alsa_output.pci && exit 0\nexit 1\n')
  assert.equal(await defaultMonitor(modern), 'alsa_output.pci.monitor')
  const old = fakeTool(t, 'pactl', '#!/bin/sh\n[ "$1" = info ] && printf "Server: x\\nDefault Sink: bluez_sink.headset\\n" && exit 0\necho "No valid command" >&2\nexit 1\n')
  assert.equal(await defaultMonitor(old), 'bluez_sink.headset.monitor')
  const localized = fakeTool(t, 'pactl', '#!/bin/sh\n[ "$LC_ALL" = C ] || { echo "Receptor predeterminado: x"; exit 0; }\n[ "$1" = info ] && echo "Default Sink: english.sink" && exit 0\nexit 1\n')
  assert.equal(await defaultMonitor(localized), 'english.sink.monitor')
  const broken = fakeTool(t, 'pactl', '#!/bin/sh\nexit 1\n')
  const notes: string[] = []
  assert.equal(await defaultMonitor(broken, (line) => notes.push(line)), '@DEFAULT_MONITOR@')
  assert.equal(notes.length, 1)
  assert.equal(sourceSpecs('remote', ctxFor('linux'), { ffmpeg: 'ffmpeg' })[1]?.args.includes('@DEFAULT_MONITOR@'), true)
})

async function supervise(t: { after: (fn: () => void) => void }, platform: Platform, mode: 'remote' | 'in-person', options: { fail?: string; die?: string; stop?: 'file' | 'call' } = {}) {
  const ffmpeg = fakeTool(t, 'ffmpeg')
  const { dir } = meetingDir(t, { status: 'starting', mode })
  const logFile = path.join(dir, 'fake.log')
  process.env['FAKE_LOG'] = logFile
  if (options.fail) process.env['FAKE_FAIL'] = options.fail
  if (options.die) process.env['FAKE_DIE'] = options.die
  t.after(() => {
    delete process.env['FAKE_LOG']
    delete process.env['FAKE_FAIL']
    delete process.env['FAKE_DIE']
  })
  const ctx = ctxFor(platform)
  const specs = sourceSpecs(mode, ctx, { ffmpeg, loopback: ffmpeg, monitor: 'sink.monitor' })
  const lines: string[] = []
  const supervisor = new CaptureSupervisor(dir, { ffmpeg, specs, live: { maxChunkSeconds: 10 }, liveWorker: null, log: (line) => lines.push(line), pollMs: 20, startTimeoutMs: 5_000, stopTimeoutMs: 3_000 })
  const running = supervisor.run()
  const started = await waitUntil(5, 0.02, () => loadMeeting(dir).status !== 'starting')
  assert.ok(started)
  if (loadMeeting(dir).status === 'recording') {
    assert.equal(loadMeeting(dir).recorderPid, process.pid)
    await new Promise((resolve) => setTimeout(resolve, 1_200))
    if (options.die) await waitUntil(5, 0.02, () => loadMeeting(dir).status !== 'recording')
    else if (options.stop === 'call') supervisor.requestStop()
    else writeFileSync(path.join(dir, STOP_REQUEST), 'now')
  }
  const code = await running
  const calls = readFileSync(logFile, 'utf8').trim().split('\n').map((line) => JSON.parse(line) as string[])
  return { dir, code, calls, lines }
}

test('the supervisor records Linux mic and monitor, writes live chunks and muxes recording.m4a', { skip: !posix && 'needs a POSIX shell' }, async (t) => {
  const { dir, code, calls, lines } = await supervise(t, 'linux', 'remote')
  assert.equal(code, 0, lines.join('\n'))
  const stored = loadMeeting(dir)
  assert.equal(stored.status, 'recorded')
  assert.equal(stored.recorderPid, undefined)
  assert.ok(stored.startedAt && stored.endedAt)
  assert.equal(stored.error, undefined)
  assert.ok(existsSync(path.join(dir, 'recording.m4a')))
  assert.ok(!existsSync(path.join(dir, CAPTURE_DIR)))
  const sources = calls.filter((args) => args.includes('pulse'))
  assert.deepEqual(sources.map((args) => args[args.indexOf('-i') + 1]).sort(), ['default', 'sink.monitor'])
  const mux = calls.find((args) => args.includes('copy')) ?? []
  assert.deepEqual(mux.filter((arg) => arg.endsWith('.aac')).map((file) => path.basename(file)), ['mic.aac', 'system.aac'])
  const index = readFileSync(path.join(dir, 'live', 'chunks', 'index.jsonl'), 'utf8').trim().split('\n').map((line) => JSON.parse(line) as { file?: string; channel: string; seq: number; startMs: number; endMs: number })
  assert.deepEqual(index.map((entry) => entry.channel).sort(), ['mic', 'system'])
  for (const entry of index) {
    assert.equal(entry.seq, 1)
    assert.ok(entry.endMs - entry.startMs >= 900, JSON.stringify(entry))
    assert.equal(entry.file, `${entry.channel}-00001.wav`)
    assert.ok(readFileSync(path.join(dir, 'live', 'chunks', entry.file ?? '')).length > 44)
  }
  assert.match(readFileSync(path.join(dir, 'live', 'chunks', 'index.jsonl'), 'utf8').split('\n')[0] ?? '', /^\{"channel":"(mic|system)","endMs":\d+,"file":"\w+-00001\.wav","seq":1,"startMs":\d+\}$/)
})

test('the supervisor reads the format from recap-loopback on Windows and stops on request', { skip: !posix && 'needs a POSIX shell' }, async (t) => {
  const { dir, code, calls, lines } = await supervise(t, 'win32', 'in-person', { stop: 'call' })
  assert.equal(code, 0, lines.join('\n'))
  assert.equal(loadMeeting(dir).status, 'recorded')
  assert.deepEqual(calls.filter((args) => args.includes('--source')).map((args) => args[1]), ['mic'])
  const encoder = calls.find((args) => args.includes('pipe:0')) ?? []
  assert.deepEqual(encoder.slice(encoder.indexOf('-ar'), encoder.indexOf('-ar') + 4), ['-ar', '48000', '-ac', '1'])
  assert.ok(existsSync(path.join(dir, 'recording.m4a')))
})

test('the supervisor marks the meeting failed when a source cannot start', { skip: !posix && 'needs a POSIX shell' }, async (t) => {
  const { dir, code } = await supervise(t, 'linux', 'remote', { fail: 'sink.monitor' })
  assert.equal(code, 1)
  const stored = loadMeeting(dir)
  assert.equal(stored.status, 'failed')
  assert.match(stored.error ?? '', /system capture exited before recording: device busy/)
  assert.equal(stored.recorderPid, undefined)
})

test('the supervisor keeps the audio and says which source stopped by itself', { skip: !posix && 'needs a POSIX shell' }, async (t) => {
  const { dir, code } = await supervise(t, 'linux', 'remote', { die: 'sink.monitor' })
  assert.equal(code, 1)
  const stored = loadMeeting(dir)
  assert.equal(stored.status, 'recorded')
  assert.match(stored.error ?? '', /The system capture stopped by itself/)
  assert.ok(existsSync(path.join(dir, 'recording.m4a')))
})

test('reconcile recovers capture/*.aac when the supervisor died', { skip: !posix && 'needs a POSIX shell' }, async (t) => {
  const ffmpeg = fakeTool(t, 'ffmpeg')
  mkdirSync(path.dirname(process.env['RECAP_CONFIG_PATH'] ?? ''), { recursive: true })
  writeFileSync(process.env['RECAP_CONFIG_PATH'] ?? '', JSON.stringify({ tools: { ffmpeg } }))
  t.after(() => rmSync(process.env['RECAP_CONFIG_PATH'] ?? '', { force: true }))
  const { dir, meeting: stored } = meetingDir(t, { status: 'recording', mode: 'remote', recorderPid: 999_999, startedAt: '2026-01-01T00:00:00Z' })
  mkdirSync(path.join(dir, CAPTURE_DIR))
  writeFileSync(path.join(dir, CAPTURE_DIR, 'mic.aac'), 'mic')
  writeFileSync(path.join(dir, CAPTURE_DIR, 'system.aac'), 'system')
  const recovered = reconcile(stored, dir)
  assert.equal(recovered.status, 'recorded')
  assert.match(recovered.error ?? '', /recovered recording\.m4a from capture\/ with mic and system/)
  assert.ok(existsSync(path.join(dir, 'recording.m4a')))
  assert.ok(!existsSync(path.join(dir, CAPTURE_DIR)))
  assert.equal(recovered['syntheticTracks'], undefined)
  const partial = meetingDir(t, { status: 'recording', mode: 'remote', recorderPid: 999_999, startedAt: '2026-01-01T00:00:00Z' })
  mkdirSync(path.join(partial.dir, CAPTURE_DIR))
  writeFileSync(path.join(partial.dir, CAPTURE_DIR, 'mic.aac'), 'mic')
  const filled = reconcile(partial.meeting, partial.dir)
  assert.equal(filled.status, 'recorded')
  assert.deepEqual(filled['syntheticTracks'], ['system'])
  assert.deepEqual(loadMeeting(partial.dir)['syntheticTracks'], ['system'])
  assert.match(filled.error ?? '', /system track is synthetic silence/)
  assert.ok(existsSync(path.join(partial.dir, 'recording.m4a')))
  assert.ok(!existsSync(path.join(partial.dir, CAPTURE_DIR)))
  assert.equal(recoverCapture(partial.dir, 'remote', ffmpeg), null)
})

test('recovery fills a missing track with silence in its own format', () => {
  const both = recoveryArguments('/m', ['mic', 'system'], ['mic', 'system'], '/m/recording.m4a')
  assert.ok(!both.includes('lavfi'))
  const noSystem = recoveryArguments('/m', ['mic', 'system'], ['mic'], '/m/recording.m4a')
  assert.deepEqual(noSystem.slice(5, 12), ['-i', path.join('/m', 'capture', 'mic.aac'), '-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=stereo', '-map'])
  assert.deepEqual(noSystem.slice(noSystem.indexOf('-c:a:0')), ['-c:a:0', 'copy', '-c:a:1', 'aac', '-b:a:1', '96k', '-ac:a:1', '2', '-ar:a:1', '48000', '-shortest', '-movflags', '+faststart', '/m/recording.m4a'])
  const noMic = recoveryArguments('/m', ['mic', 'system'], ['system'], '/m/recording.m4a')
  assert.equal(noMic[noMic.indexOf('lavfi') + 2], 'anullsrc=r=48000:cl=mono')
  assert.deepEqual(noMic.slice(noMic.indexOf('-c:a:0'), noMic.indexOf('-c:a:0') + 10), ['-c:a:0', 'aac', '-b:a:0', '64k', '-ac:a:0', '1', '-ar:a:0', '48000', '-c:a:1', 'copy'])
})

test('integration: real ffmpeg recovers a remote capture with a synthetic system track', { skip: (!posix || realFfmpeg() === null) && 'needs ffmpeg on PATH' }, (t) => {
  const ffmpeg = realFfmpeg() ?? 'ffmpeg'
  const { dir } = meetingDir(t, { status: 'recording', mode: 'remote' })
  mkdirSync(path.join(dir, CAPTURE_DIR))
  const mic = path.join(dir, CAPTURE_DIR, 'mic.aac')
  assert.equal(spawnSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'sine=f=440:r=48000:d=2', '-c:a', 'aac', '-b:a', '64k', '-ac', '1', '-f', 'adts', mic]).status, 0)
  const recovery = recoverCapture(dir, 'remote', ffmpeg)
  assert.deepEqual(recovery?.synthetic, ['system'])
  const probe = spawnSync(path.join(path.dirname(ffmpeg), 'ffprobe'), ['-v', 'error', '-show_entries', 'stream=codec_name,channels,sample_rate,duration', '-of', 'csv=p=0', path.join(dir, 'recording.m4a')], { encoding: 'utf8' })
  const streams = probe.stdout.trim().split('\n').map((line) => line.split(','))
  assert.deepEqual(streams.map(([codec, rate, channels]) => [codec, rate, channels]), [['aac', '48000', '1'], ['aac', '48000', '2']])
  const [micDuration, systemDuration] = streams.map((stream) => Number(stream[3]))
  assert.ok(Math.abs((micDuration ?? 0) - (systemDuration ?? 0)) < 0.2, probe.stdout)
})

test('stopping the ffmpeg recorder writes stop.request and interrupts the supervisor', { skip: !posix && 'needs POSIX signals' }, async (t) => {
  const { dir, meeting: stored } = meetingDir(t)
  const child = spawn(process.execPath, ['-e', 'process.on("SIGINT", () => process.exit(0)); setInterval(() => {}, 1000)'], { stdio: 'ignore' })
  t.after(() => child.kill('SIGKILL'))
  await new Promise((resolve) => setTimeout(resolve, 200))
  await new FfmpegRecorder(ctxFor('linux'), {}).stop({ ...stored, recorderPid: child.pid }, dir)
  assert.ok(existsSync(path.join(dir, STOP_REQUEST)))
  assert.ok(await waitUntil(3, 0.05, () => !isAlive(child.pid ?? 0)))
  const windows = meetingDir(t)
  await new FfmpegRecorder(ctxFor('win32'), {}).stop({ ...windows.meeting, recorderPid: 999_999 }, windows.dir)
  assert.ok(existsSync(path.join(windows.dir, STOP_REQUEST)))
  await assert.rejects(new FfmpegRecorder(ctxFor('linux'), {}).stop({ ...windows.meeting, recorderPid: undefined }, windows.dir), /RECORDER_UNKNOWN|unknown/)
})

test('the live worker command honors RECAP_LIVE_WORKER', async () => {
  const fallback = async () => ['recap', 'live-worker']
  assert.deepEqual(await liveWorkerFor({}, fallback), ['recap', 'live-worker'])
  assert.equal(await liveWorkerFor({ RECAP_LIVE_WORKER: 'off' }, fallback), null)
  assert.deepEqual(await liveWorkerFor({ RECAP_LIVE_WORKER: '["node","/x.js","live-worker"]' }, fallback), ['node', '/x.js', 'live-worker'])
  assert.deepEqual(await liveWorkerFor({ RECAP_LIVE_WORKER: '/bin/recap' }, fallback), ['/bin/recap', 'live-worker'])
  await assert.rejects(liveWorkerFor({ RECAP_LIVE_WORKER: '[1]' }, fallback))
})

function realFfmpeg(): string | null {
  const found = spawnSync('ffmpeg', ['-hide_banner', '-version'], { encoding: 'utf8' })
  if (found.status !== 0) return null
  return spawnSync('sh', ['-c', 'command -v ffmpeg'], { encoding: 'utf8' }).stdout.trim() || null
}

test('integration: real ffmpeg encodes and muxes two tracks into recording.m4a', { skip: (!posix || realFfmpeg() === null) && 'needs ffmpeg on PATH' }, async (t) => {
  const ffmpeg = realFfmpeg() ?? 'ffmpeg'
  const fake = fakeTool(t, 'source')
  const { dir } = meetingDir(t, { status: 'starting', mode: 'remote' })
  const specs = sourceSpecs('remote', ctxFor('linux'), { ffmpeg: fake, monitor: 'sink.monitor' })
  const supervisor = new CaptureSupervisor(dir, { ffmpeg, specs, live: null, liveWorker: null, log: () => undefined, pollMs: 20 })
  const running = supervisor.run()
  assert.ok(await waitUntil(5, 0.02, () => loadMeeting(dir).status === 'recording'))
  await new Promise((resolve) => setTimeout(resolve, 1_500))
  supervisor.requestStop()
  assert.equal(await running, 0)
  assert.equal(loadMeeting(dir).status, 'recorded')
  const probe = spawnSync(path.join(path.dirname(ffmpeg), 'ffprobe'), ['-v', 'error', '-show_entries', 'stream=codec_name,channels', '-of', 'csv=p=0', path.join(dir, 'recording.m4a')], { encoding: 'utf8' })
  assert.deepEqual(probe.stdout.trim().split('\n'), ['aac,1', 'aac,2'])
  assert.ok(!readdirSync(dir).includes(CAPTURE_DIR))
})
