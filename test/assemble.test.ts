import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, readdirSync, utimesSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'
import { ASSEMBLE_ORPHAN_MS, assembleArguments, assembleFilter, assembleMeeting, assembleTimeoutMs, assembledProblem, isAssembleTemporary, omission, parseFacts, planAssembly, sweepTemporaries, temporaryName, videoEncoder, type MediaFacts } from '../src/capture/assemble.ts'
import { decodeManifest, isCaptureSource, type CaptureManifest } from '../src/capture/manifest.ts'
import { loadMeeting, reconcile, recordedChannels, saveMeeting } from '../src/core/meeting.ts'
import { inspectMedia } from '../src/media/probe.ts'
import { Pipeline, channelsOf } from '../src/pipeline/pipeline.ts'
import { STAGES, stageApplies, stageSkipped } from '../src/pipeline/stages.ts'
import { transcriptMarkdown } from '../src/pipeline/transcript.ts'
import { meeting, tempDir } from './helpers.ts'

const ffmpeg = spawnSync('ffmpeg', ['-version']).status === 0 && spawnSync('ffprobe', ['-version']).status === 0

function manifest(segments: CaptureManifest['segments']): CaptureManifest {
  return { mic: 'mic.m4a', video: null, segments }
}

function facts(duration: number, audio = true, width = 1280, height = 830, audioStart = 0): MediaFacts {
  return { duration, audio, video: true, width, height, videoStreams: 1, audioStreams: audio ? 1 : 0, audioStart }
}

test('the plan fills the time without a target with black video and silence', () => {
  const plan = planAssembly(
    manifest([
      { file: 'screen-1.mov', startMs: 2_000, endMs: 5_000 },
      { file: 'screen-2.mov', startMs: 7_000 },
    ]),
    10,
    new Map([
      ['screen-1.mov', facts(3.2)],
      ['screen-2.mov', facts(2.5, false, 640, 480)],
    ]),
  )
  assert.equal(plan.output, 'recording.mov')
  assert.deepEqual(plan.inputs, ['screen-1.mov', 'screen-2.mov'])
  assert.deepEqual(plan.pieces, [
    { kind: 'gap', seconds: 2 },
    { kind: 'segment', input: 0, seconds: 3, audio: true, delay: 0 },
    { kind: 'gap', seconds: 2 },
    { kind: 'segment', input: 1, seconds: 2.5, audio: false, delay: 0 },
    { kind: 'gap', seconds: 0.5 },
  ])
  assert.equal(plan.seconds, 10)
  assert.deepEqual([plan.width, plan.height], [1280, 830])
})

test('the plan never overlaps, never runs past the microphone and skips unreadable segments', () => {
  const plan = planAssembly(
    manifest([
      { file: 'screen-3.mov', startMs: 9_500 },
      { file: 'screen-1.mov', startMs: 0, endMs: 4_000 },
      { file: 'screen-2.mov', startMs: 3_000, endMs: 6_000 },
      { file: 'missing.mov', startMs: 7_000, endMs: 8_000 },
    ]),
    10,
    new Map([
      ['screen-1.mov', facts(4)],
      ['screen-2.mov', facts(3)],
      ['screen-3.mov', facts(5)],
    ]),
  )
  assert.deepEqual(plan.pieces, [
    { kind: 'segment', input: 0, seconds: 4, audio: true, delay: 0 },
    { kind: 'segment', input: 1, seconds: 2, audio: true, delay: 0 },
    { kind: 'gap', seconds: 3.5 },
    { kind: 'segment', input: 2, seconds: 0.5, audio: true, delay: 0 },
  ])
  assert.equal(plan.pieces.reduce((total, piece) => total + piece.seconds, 0), 10)
})

test('a closed segment keeps its planned span and the audio starts where the file puts it', () => {
  const plan = planAssembly(
    manifest([
      { file: 'screen-1.mov', startMs: 1_000, endMs: 5_000 },
      { file: 'screen-2.mov', startMs: 6_000 },
    ]),
    10,
    new Map([
      ['screen-1.mov', facts(2.4, true, 1280, 830, 0.75)],
      ['screen-2.mov', facts(1.5)],
    ]),
  )
  assert.deepEqual(plan.pieces, [
    { kind: 'gap', seconds: 1 },
    { kind: 'segment', input: 0, seconds: 4, audio: true, delay: 0.75 },
    { kind: 'gap', seconds: 1 },
    { kind: 'segment', input: 1, seconds: 1.5, audio: true, delay: 0 },
    { kind: 'gap', seconds: 2.5 },
  ])
  assert.match(assembleFilter(plan), /\[1:a:0\]aresample=48000,[^;]*asetpts=PTS-STARTPTS,adelay=delays=750:all=1,apad,atrim=duration=4,/)
  assert.match(assembleFilter(plan), /tpad=stop_mode=clone:stop_duration=4,trim=duration=4/)
})

test('only mic.m4a and screen-N.mov can come from capture.json', () => {
  const decoded = decodeManifest(JSON.stringify({
    mic: 'meeting.json',
    segments: [
      { file: 'meeting.json', startMs: 0 },
      { file: 'recording.mov', startMs: 0 },
      { file: 'recording.m4a', startMs: 0 },
      { file: 'capture.json', startMs: 0 },
      { file: 'screen-0.mov', startMs: 0 },
      { file: 'screen-1.mov.bak', startMs: 0 },
      { file: 'screen-12.mov', startMs: 0 },
    ],
  }))
  assert.equal(decoded?.mic, 'mic.m4a')
  assert.deepEqual(decoded?.segments.map((segment) => segment.file), ['screen-12.mov'])
  assert.ok(isCaptureSource('mic.m4a'))
  assert.ok(isCaptureSource('screen-3.mov'))
  for (const name of ['meeting.json', 'recording.mov', 'recording.m4a', 'transcript.md', '../screen-1.mov', 'screen-a.mov']) assert.ok(!isCaptureSource(name), name)
})

test('the assembled file must have one video track, two audio tracks and the planned length', () => {
  const plan = planAssembly(manifest([{ file: 'screen-1.mov', startMs: 0, endMs: 2_000 }]), 5, new Map([['screen-1.mov', facts(2)]]))
  const made = (audioStreams: number, duration = 5, videoStreams = 1): MediaFacts => ({ ...facts(duration), videoStreams, audioStreams })
  assert.equal(assembledProblem(made(2), plan), null)
  assert.match(String(assembledProblem(made(1), plan)), /1 audio tracks instead of 2/)
  assert.match(String(assembledProblem(made(2, 5, 0), plan)), /0 video tracks instead of 1/)
  assert.match(String(assembledProblem(made(2, 2), plan)), /lasts 2\.0s instead of 5\.0s/)
  assert.match(String(assembledProblem(null, plan)), /cannot read/)
  assert.notEqual(temporaryName(), temporaryName())
  assert.match(temporaryName(), /^\.recording\.assemble-[0-9a-f-]{36}\.mov$/)
  assert.equal(assembleTimeoutMs(3_600), 120_000 + 3_600_000)
})

test('a meeting that never had a target keeps the microphone in recording.m4a', () => {
  const plan = planAssembly(manifest([{ file: 'screen-1.mov', startMs: 0, endMs: 100 }]), 30, new Map())
  assert.equal(plan.output, 'recording.m4a')
  assert.deepEqual(plan.pieces, [])
})

test('ffmpeg keeps the microphone first and puts the target audio in a second track', () => {
  const plan = planAssembly(manifest([{ file: 'screen-1.mov', startMs: 1_000, endMs: 3_000 }]), 5, new Map([['screen-1.mov', facts(2)]]))
  const filter = assembleFilter(plan)
  assert.match(filter, /^color=c=black:s=1280x830:r=2:d=1,format=yuv420p,setsar=1\[v0\];anullsrc=r=48000:cl=stereo,atrim=duration=1,/)
  assert.match(filter, /\[1:v:0\]scale=1280:830:force_original_aspect_ratio=decrease,pad=1280:830/)
  assert.match(filter, /\[1:a:0\]aresample=48000,/)
  assert.match(filter, /\[v0\]\[a0\]\[v1\]\[a1\]\[v2\]\[a2\]concat=n=3:v=1:a=1\[v\]\[system\]$/)
  const args = assembleArguments(plan, '/m', '/m/out.mov', 'linux')
  assert.deepEqual(args.slice(0, 9), ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y', '-i', '/m/mic.m4a', '-i', '/m/screen-1.mov'])
  const joined = args.join(' ')
  assert.match(joined, /-map \[v\] -map 0:a:0 -map \[system\]/)
  assert.match(joined, /-c:a:0 copy -c:a:1 aac -b:a:1 96k -ac:a:1 2/)
  assert.match(joined, /-disposition:a:0 default -disposition:a:1 default/)
  assert.match(joined, /-t 5 -movflags \+faststart -f mov \/m\/out\.mov$/)
  assert.deepEqual(videoEncoder('darwin').slice(0, 2), ['-c:v', 'h264_videotoolbox'])
  assert.deepEqual(videoEncoder('linux').slice(0, 2), ['-c:v', 'libx264'])
})

test('ffprobe facts tell duration, tracks and size', () => {
  assert.deepEqual(parseFacts(JSON.stringify({ format: { duration: '3.5' }, streams: [{ codec_type: 'video', width: 1280, height: 830, start_time: '0.000000' }, { codec_type: 'audio', start_time: '0.420000' }] })), { duration: 3.5, audio: true, video: true, width: 1280, height: 830, videoStreams: 1, audioStreams: 1, audioStart: 0.42 })
  assert.deepEqual(parseFacts(JSON.stringify({ format: {}, streams: [{ codec_type: 'audio', start_time: '-0.02' }, { codec_type: 'audio' }] })), { duration: 0, audio: true, video: false, width: 0, height: 0, videoStreams: 0, audioStreams: 2, audioStart: 0 })
  assert.equal(parseFacts('nope'), null)
})

test('the assemble stage runs first and only for meetings that still need it', (t) => {
  assert.equal(STAGES[0], 'assemble')
  assert.ok(stageApplies('assemble', meeting({ mode: 'meeting' })))
  assert.ok(!stageApplies('assemble', meeting({ mode: 'remote' })))
  assert.ok(!stageApplies('assemble', meeting({ mode: 'in-person' })))
  const dir = tempDir(t)
  assert.ok(stageSkipped('assemble', meeting({ mode: 'meeting' }), dir))
  writeFileSync(path.join(dir, 'capture.json'), JSON.stringify(manifest([])))
  writeFileSync(path.join(dir, 'mic.m4a'), 'x')
  assert.ok(!stageSkipped('assemble', meeting({ mode: 'meeting' }), dir))
})

test('the channels of a meeting follow what was assembled', () => {
  assert.deepEqual(channelsOf(meeting({ mode: 'meeting' })), [['mic', 0]])
  assert.deepEqual(channelsOf(meeting({ mode: 'meeting', channels: ['mic', 'system'] })), [['mic', 0], ['system', 1]])
  assert.deepEqual(channelsOf(meeting({ mode: 'remote' })), [['mic', 0], ['system', 1]])
  assert.deepEqual(recordedChannels({ mode: 'in-person', channels: ['mic'] }), ['mic'])
  const markdown = transcriptMarkdown(meeting({ mode: 'meeting', channels: ['mic', 'system'], title: 'Sync' }), [{ startMs: 0, endMs: 1000, channel: 'system', text: 'Hola.' }])
  assert.match(markdown, /\*\*\[00:00:00\] Remotos:\*\* Hola\./)
  assert.doesNotMatch(transcriptMarkdown(meeting({ mode: 'meeting', title: 'Sync' }), [{ startMs: 0, endMs: 1000, channel: 'mic', text: 'Hola.' }]), /Sala/)
})

test('a meeting whose recorder died keeps its microphone for assembly', (t) => {
  const dir = tempDir(t)
  const value = meeting({ mode: 'meeting', status: 'recording', startedAt: '2026-10-25T12:00:00Z', recorderPid: 999_999 })
  saveMeeting(value, dir)
  writeFileSync(path.join(dir, 'capture.json'), JSON.stringify(manifest([])))
  writeFileSync(path.join(dir, 'mic.m4a'), Buffer.alloc(32))
  const reconciled = reconcile(value, dir)
  assert.equal(reconciled.status, 'recorded')
  assert.equal(reconciled.recorderPid, undefined)
})

test('a microphone-only meeting is assembled by renaming mic.m4a, without ffmpeg', async (t) => {
  const dir = tempDir(t)
  saveMeeting(meeting({ mode: 'meeting', status: 'recorded' }), dir)
  writeFileSync(path.join(dir, 'capture.json'), JSON.stringify(manifest([])))
  writeFileSync(path.join(dir, 'mic.m4a'), Buffer.alloc(48, 1))
  const assembled = await assembleMeeting(dir, { tools: { ffmpeg: '/nonexistent/ffmpeg', ffprobe: '/nonexistent/ffprobe' } })
  assert.deepEqual(assembled.channels, ['mic'])
  assert.equal(assembled.stages['assemble']?.status, 'done')
  assert.deepEqual(readdirSync(dir).sort(), ['capture.json', 'meeting.json', 'recording.m4a'])
})

function synth(args: string[]): void {
  const made = spawnSync('ffmpeg', ['-loglevel', 'error', '-y', ...args])
  assert.equal(made.status, 0, made.stderr.toString())
}

function meanVolume(file: string, stream: string, from: number, seconds: number): number {
  const result = spawnSync('ffmpeg', ['-hide_banner', '-nostats', '-ss', String(from), '-t', String(seconds), '-i', file, '-map', stream, '-af', 'volumedetect', '-f', 'null', '-'], { encoding: 'utf8' })
  const match = /mean_volume: (-?[\d.]+) dB/.exec(result.stderr)
  return match ? Number(match[1]) : Number.NEGATIVE_INFINITY
}

test('assemble builds recording.mov from mic.m4a and the screen segments with ffmpeg', { skip: !ffmpeg && 'ffmpeg is not installed' }, async (t) => {
  const dir = tempDir(t)
  saveMeeting(meeting({ mode: 'meeting', status: 'recorded' }), dir)
  synth(['-f', 'lavfi', '-i', 'sine=f=300:r=48000:d=10', '-c:a', 'aac', '-b:a', '64k', '-ac', '1', path.join(dir, 'mic.m4a')])
  synth(['-f', 'lavfi', '-i', 'testsrc=d=3:s=1280x830:r=2', '-f', 'lavfi', '-i', 'sine=f=900:r=48000:d=3', '-map', '0', '-map', '1', '-c:v', 'mjpeg', '-c:a', 'aac', '-ac', '2', '-shortest', path.join(dir, 'screen-1.mov')])
  synth(['-f', 'lavfi', '-i', 'testsrc=d=2:s=640x480:r=2', '-c:v', 'mjpeg', path.join(dir, 'screen-2.mov')])
  writeFileSync(path.join(dir, 'capture.json'), JSON.stringify({ version: 1, mic: 'mic.m4a', video: null, segments: [{ file: 'screen-1.mov', startMs: 1_000, endMs: 4_000 }, { file: 'screen-2.mov', startMs: 6_000 }] }))
  assert.ok(decodeManifest(JSON.stringify({ mic: 'mic.m4a', segments: [] })))

  const assembled = await assembleMeeting(dir, {})
  assert.deepEqual(assembled.channels, ['mic', 'system'])
  assert.equal(assembled.stages['assemble']?.status, 'done')
  assert.deepEqual(readdirSync(dir).sort(), ['capture.json', 'meeting.json', 'recording.mov'])
  const file = path.join(dir, 'recording.mov')
  const info = await inspectMedia(file, {})
  assert.equal(info.videoTracks, 1)
  assert.equal(info.audioTracks, 2)
  assert.equal(info.enabledAudioTracks, 2)
  assert.ok(Math.abs(info.duration - 10) < 0.5, `duration ${info.duration}`)
  const size = spawnSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'csv=p=0', file], { encoding: 'utf8' }).stdout.trim()
  assert.equal(size, '1280,830')
  assert.ok(meanVolume(file, '0:a:0', 0.2, 0.6) > -40, 'the microphone plays from the start')
  assert.ok(meanVolume(file, '0:a:1', 0.1, 0.6) < -80, 'no target audio before the first segment')
  assert.ok(meanVolume(file, '0:a:1', 1.5, 2) > -40, 'the window audio plays during the first segment')
  assert.ok(meanVolume(file, '0:a:1', 4.4, 1.2) < -80, 'silence between segments')
  assert.ok(meanVolume(file, '0:a:1', 6.2, 1.5) < -80, 'a segment without audio stays silent')
  assert.ok(meanVolume(file, '0:a:0', 8.5, 1) > -40, 'the microphone plays to the end')
})

function lumaAt(file: string, at: number): number {
  const result = spawnSync('ffmpeg', ['-hide_banner', '-i', file, '-an', '-vf', 'signalstats,metadata=print:key=lavfi.signalstats.YAVG:file=-', '-f', 'null', '-'], { encoding: 'utf8' })
  const frames = [...result.stdout.matchAll(/pts_time:([\d.]+)\s+lavfi\.signalstats\.YAVG=([\d.e+-]+)/g)].map((match) => ({ time: Number(match[1]), luma: Number(match[2]) }))
  const frame = frames.filter((item) => item.time <= at).at(-1)
  return frame ? frame.luma : Number.NaN
}

test('assemble aligns late target audio, holds the last frame and keeps what it could not read', { skip: !ffmpeg && 'ffmpeg is not installed' }, async (t) => {
  const dir = tempDir(t)
  saveMeeting(meeting({ mode: 'meeting', status: 'recorded' }), dir)
  synth(['-f', 'lavfi', '-i', 'sine=f=300:r=48000:d=8', '-c:a', 'aac', '-ac', '1', path.join(dir, 'mic.m4a')])
  synth(['-f', 'lavfi', '-i', 'testsrc=d=3:s=640x480:r=2', '-itsoffset', '1.5', '-f', 'lavfi', '-i', 'sine=f=900:r=48000:d=1.5', '-map', '0', '-map', '1', '-c:v', 'mjpeg', '-c:a', 'aac', '-ac', '2', path.join(dir, 'screen-1.mov')])
  writeFileSync(path.join(dir, 'screen-2.mov'), Buffer.alloc(256, 3))
  writeFileSync(path.join(dir, 'capture.json'), JSON.stringify({ mic: 'mic.m4a', segments: [{ file: 'screen-1.mov', startMs: 1_000, endMs: 5_000 }, { file: 'screen-2.mov', startMs: 6_000, endMs: 7_000 }, { file: 'meeting.json', startMs: 7_000 }] }))
  const warnings: string[] = []
  const assembled = await assembleMeeting(dir, {}, process.platform, (line) => warnings.push(line))
  assert.deepEqual(assembled.channels, ['mic', 'system'])
  assert.deepEqual(readdirSync(dir).sort(), ['capture.json', 'meeting.json', 'recording.mov', 'screen-2.mov'])
  assert.equal(warnings.length, 1)
  assert.match(warnings[0] ?? '', /screen-2\.mov/)
  const file = path.join(dir, 'recording.mov')
  assert.ok(meanVolume(file, '0:a:1', 1.1, 1.2) < -80, 'no target audio before its own start time')
  assert.ok(meanVolume(file, '0:a:1', 2.7, 1) > -40, 'the target audio plays once it starts')
  assert.ok(lumaAt(file, 4.6) > 40, 'the last frame stays until the segment ends')
  assert.ok(lumaAt(file, 5.6) < 25, 'black after the segment')
})

test('a meeting whose segments cannot be read keeps them next to recording.m4a', { skip: !ffmpeg && 'ffmpeg is not installed' }, async (t) => {
  const dir = tempDir(t)
  saveMeeting(meeting({ mode: 'meeting', status: 'recorded' }), dir)
  synth(['-f', 'lavfi', '-i', 'sine=f=300:r=48000:d=2', '-c:a', 'aac', '-ac', '1', path.join(dir, 'mic.m4a')])
  writeFileSync(path.join(dir, 'screen-1.mov'), Buffer.alloc(256, 3))
  writeFileSync(path.join(dir, 'capture.json'), JSON.stringify({ mic: 'mic.m4a', segments: [{ file: 'screen-1.mov', startMs: 0, endMs: 1_000 }] }))
  const warnings: string[] = []
  const assembled = await assembleMeeting(dir, {}, process.platform, (line) => warnings.push(line))
  assert.deepEqual(assembled.channels, ['mic'])
  assert.deepEqual(readdirSync(dir).sort(), ['capture.json', 'meeting.json', 'recording.m4a', 'screen-1.mov'])
  assert.match(warnings.join('\n'), /kept screen-1\.mov/)
})

test('the pipeline assembles before extracting both channels', { skip: !ffmpeg && 'ffmpeg is not installed' }, async (t) => {
  const dir = tempDir(t)
  saveMeeting(meeting({ mode: 'meeting', status: 'recorded', startedAt: '2026-10-25T12:00:00Z', endedAt: '2026-10-25T12:00:04Z' }), dir)
  synth(['-f', 'lavfi', '-i', 'sine=f=300:r=48000:d=4', '-c:a', 'aac', '-ac', '1', path.join(dir, 'mic.m4a')])
  synth(['-f', 'lavfi', '-i', 'testsrc=d=2:s=320x240:r=2', '-f', 'lavfi', '-i', 'sine=f=900:r=48000:d=2', '-map', '0', '-map', '1', '-c:v', 'mjpeg', '-c:a', 'aac', '-ac', '2', '-shortest', path.join(dir, 'screen-1.mov')])
  writeFileSync(path.join(dir, 'capture.json'), JSON.stringify({ mic: 'mic.m4a', segments: [{ file: 'screen-1.mov', startMs: 500, endMs: 2_500 }] }))
  const lines: string[] = []
  const pipeline = new Pipeline(dir, {}, (line) => lines.push(line))
  await pipeline.run(undefined, 'assemble')
  await pipeline.run(undefined, 'audio')
  assert.ok(existsSync(path.join(dir, 'mic.wav')))
  assert.ok(existsSync(path.join(dir, 'system.wav')))
  assert.deepEqual(loadMeeting(dir).channels, ['mic', 'system'])
  assert.ok(lines.includes('assemble: running'))
  await pipeline.run(undefined, 'assemble')
  assert.ok(lines.includes('assemble: already done'), lines.join('\n'))
})

test('a segment left out is told apart as empty, outside the microphone or unreadable', () => {
  assert.equal(omission(0, undefined), 'empty')
  assert.equal(omission(256, undefined), 'unreadable')
  assert.equal(omission(256, { ...facts(2), video: false }), 'unreadable')
  assert.equal(omission(256, facts(0)), 'unreadable')
  assert.equal(omission(256, facts(2)), 'outside')
})

test('only old assembly temporaries are swept, never other files', (t) => {
  const dir = tempDir(t)
  const now = Date.now()
  const old = temporaryName()
  const fresh = temporaryName()
  assert.ok(isAssembleTemporary(old))
  assert.ok(!isAssembleTemporary('.recording.assemble-x.mov'))
  for (const name of [old, fresh, '.recording.assemble-x.mov', 'recording.mov']) writeFileSync(path.join(dir, name), 'x')
  const past = new Date(now - ASSEMBLE_ORPHAN_MS - 60_000)
  for (const name of [old, '.recording.assemble-x.mov', 'recording.mov']) utimesSync(path.join(dir, name), past, past)
  assert.deepEqual(sweepTemporaries(dir, now), [old])
  assert.deepEqual(readdirSync(dir).sort(), [fresh, '.recording.assemble-x.mov', 'recording.mov'].sort())
})

test('assemble says why it kept each segment and sweeps what an interrupted run left', { skip: !ffmpeg && 'ffmpeg is not installed' }, async (t) => {
  const dir = tempDir(t)
  saveMeeting(meeting({ mode: 'meeting', status: 'recorded' }), dir)
  synth(['-f', 'lavfi', '-i', 'sine=f=300:r=48000:d=2', '-c:a', 'aac', '-ac', '1', path.join(dir, 'mic.m4a')])
  synth(['-f', 'lavfi', '-i', 'testsrc=d=1:s=320x240:r=2', '-c:v', 'mjpeg', path.join(dir, 'screen-1.mov')])
  writeFileSync(path.join(dir, 'screen-2.mov'), '')
  writeFileSync(path.join(dir, 'screen-3.mov'), Buffer.alloc(256, 3))
  const orphan = temporaryName()
  writeFileSync(path.join(dir, orphan), 'partial')
  const past = new Date(Date.now() - ASSEMBLE_ORPHAN_MS - 60_000)
  utimesSync(path.join(dir, orphan), past, past)
  writeFileSync(path.join(dir, 'capture.json'), JSON.stringify({ mic: 'mic.m4a', segments: [{ file: 'screen-3.mov', startMs: 0, endMs: 500 }, { file: 'screen-2.mov', startMs: 600, endMs: 900 }, { file: 'screen-1.mov', startMs: 5_000, endMs: 6_000 }] }))
  const warnings: string[] = []
  const assembled = await assembleMeeting(dir, {}, process.platform, (line) => warnings.push(line))
  assert.deepEqual(assembled.channels, ['mic'])
  assert.ok(!existsSync(path.join(dir, orphan)))
  assert.deepEqual(readdirSync(dir).sort(), ['capture.json', 'meeting.json', 'recording.m4a', 'screen-1.mov', 'screen-2.mov', 'screen-3.mov'])
  assert.ok(warnings.some((line) => line.startsWith(`removed ${orphan}`)), warnings.join('\n'))
  assert.ok(warnings.includes('kept screen-1.mov: it starts after the microphone ends or is too short, so it is not in the recording and was not deleted'), warnings.join('\n'))
  assert.ok(warnings.includes('kept screen-2.mov: it is empty, so it is not in the recording and was not deleted'), warnings.join('\n'))
  assert.ok(warnings.includes('kept screen-3.mov: it could not be read, so it is not in the recording and was not deleted'), warnings.join('\n'))
})
