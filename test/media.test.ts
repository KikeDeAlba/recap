import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'
import { recordingPath, saveMeeting } from '../src/core/meeting.ts'
import { meetingRecord } from '../src/core/record.ts'
import { hasVideo, measureStorage, presetParameters, presetVideoArguments } from '../src/media/media.ts'
import { enableAudio, stripVideo } from '../src/media/operations.ts'
import { inspectMedia, parseProbe, verifyMedia } from '../src/media/probe.ts'
import { stageComplete, stageSkipped } from '../src/pipeline/stages.ts'
import { importArguments, importMode } from '../src/capture/import.ts'
import { RecapError } from '../src/errors.ts'
import { meeting, tempDir, writeBytes } from './helpers.ts'

test('prefers the video for remote meetings and falls back to the audio', (t) => {
  const dir = tempDir(t)
  writeBytes(path.join(dir, 'recording.mov'), 10)
  writeBytes(path.join(dir, 'recording.m4a'), 10)
  assert.equal(path.basename(recordingPath(dir, 'remote')), 'recording.mov')
  assert.ok(hasVideo(dir, 'remote'))
  assert.equal(path.basename(recordingPath(dir, 'in-person')), 'recording.m4a')
  assert.ok(!hasVideo(dir, 'in-person'))
  const audioOnly = tempDir(t)
  writeBytes(path.join(audioOnly, 'recording.m4a'), 10)
  assert.equal(path.basename(recordingPath(audioOnly, 'remote')), 'recording.m4a')
  assert.ok(!hasVideo(audioOnly, 'remote'))
  const empty = tempDir(t)
  assert.equal(path.basename(recordingPath(empty, 'remote')), 'recording.mov')
})

test('splits the meeting directory by kind', (t) => {
  const dir = tempDir(t)
  writeBytes(path.join(dir, 'recording.mov'), 1000)
  writeBytes(path.join(dir, 'mic.wav'), 300)
  writeBytes(path.join(dir, 'system.wav'), 200)
  writeBytes(path.join(dir, 'transcript-mic.json'), 40)
  writeBytes(path.join(dir, 'transcript-system.json'), 60)
  writeBytes(path.join(dir, 'frames', '00-00-01.jpg'), 70)
  writeBytes(path.join(dir, 'frames', '00-05-00.jpg'), 30)
  writeBytes(path.join(dir, 'summary.md'), 25)
  writeBytes(path.join(dir, 'live', 'chunks', 'mic-00001.wav'), 50)
  writeBytes(path.join(dir, 'live', 'transcript.jsonl'), 5)
  assert.deepEqual(measureStorage(dir, 'remote'), { recordingBytes: 1000, intermediateBytes: 650, framesBytes: 100, otherBytes: 30, totalBytes: 1780 })
  assert.deepEqual(measureStorage(path.join(dir, 'missing'), 'remote'), { recordingBytes: 0, intermediateBytes: 0, framesBytes: 0, otherBytes: 0, totalBytes: 0 })
})

test('the record includes video and storage', (t) => {
  const dir = tempDir(t)
  writeBytes(path.join(dir, 'recording.m4a'), 50)
  const value = meeting({ status: 'processed', videoRemovedAt: '2026-01-01T00:00:00Z' })
  const record = meetingRecord(value, dir)
  assert.equal(record['hasVideo'], false)
  assert.ok(String(record['recording']).endsWith('recording.m4a'))
  assert.ok(record['videoRemovedAt'])
  assert.equal(record['video'], undefined)
  assert.equal(record['liveTranscript'], null)
  assert.deepEqual(Object.keys(record['storage'] as object).sort(), ['framesBytes', 'intermediateBytes', 'otherBytes', 'recordingBytes', 'totalBytes'])
})

test('frames are skipped when the recording has no video and skipped counts as complete', (t) => {
  const dir = tempDir(t)
  const value = meeting({ status: 'recorded' })
  writeBytes(path.join(dir, 'recording.m4a'), 10)
  assert.ok(stageSkipped('frames', value, dir))
  assert.ok(!stageSkipped('audio', value, dir))
  writeBytes(path.join(dir, 'recording.mov'), 10)
  assert.ok(!stageSkipped('frames', value, dir))
  assert.ok(stageComplete({ status: 'skipped', updatedAt: '' }))
  assert.ok(stageComplete({ status: 'done', updatedAt: '' }))
  assert.ok(!stageComplete({ status: 'failed', updatedAt: '' }))
  assert.ok(!stageComplete(undefined))
})

test('presets keep their parameters and pick the HEVC encoder of the platform', () => {
  assert.equal(presetParameters('light').durationTolerance, 1.5)
  assert.equal(presetParameters('medium').durationTolerance, 2)
  assert.equal(presetParameters('max').durationTolerance, 3)
  const mac = presetVideoArguments('medium', 'darwin')
  assert.ok(mac.includes('hevc_videotoolbox') && mac.includes('hvc1') && mac.includes("fps=1,scale='min(960,iw)':-2") && mac.includes('140k'))
  const other = presetVideoArguments('max', 'linux')
  assert.ok(other.includes('libx265') && !other.includes('hevc_videotoolbox') && other.includes('70k'))
  assert.ok(presetVideoArguments('light', 'win32').includes('libx265'))
})

test('enables every audio track and verifies the result', () => {
  assert.deepEqual(enableAudio({ audioTracks: 2 }), ['-disposition:a:0', 'default', '-disposition:a:1', 'default'])
  const original = { duration: 60, audioTracks: 2, enabledAudioTracks: 1, videoTracks: 1 }
  verifyMedia(original, { duration: 60.4, audioTracks: 2, enabledAudioTracks: 2, videoTracks: 0 }, false)
  assert.throws(() => verifyMedia(original, { duration: 50, audioTracks: 2, enabledAudioTracks: 2, videoTracks: 0 }, false), RecapError)
  assert.throws(() => verifyMedia(original, { duration: 60, audioTracks: 1, enabledAudioTracks: 1, videoTracks: 0 }, false), RecapError)
  assert.throws(() => verifyMedia(original, { duration: 60, audioTracks: 2, enabledAudioTracks: 1, videoTracks: 0 }, false), RecapError)
  assert.throws(() => verifyMedia(original, { duration: 60, audioTracks: 2, enabledAudioTracks: 2, videoTracks: 1 }, false), RecapError)
})

test('reads ffprobe output and picks the import mode', () => {
  const info = parseProbe(
    JSON.stringify({
      streams: [
        { codec_type: 'video', disposition: { default: 1, attached_pic: 0 } },
        { codec_type: 'audio', disposition: { default: 1 } },
        { codec_type: 'audio', disposition: { default: 0 } },
      ],
      format: { duration: '12.5', tags: { creation_time: '2026-10-10T10:00:00.000000Z' } },
    }),
  )
  assert.deepEqual(info, { duration: 12.5, audioTracks: 2, enabledAudioTracks: 1, videoTracks: 1, creationTime: '2026-10-10T10:00:00.000000Z' })
  assert.equal(importMode(info), 'remote')
  assert.equal(importMode({ ...info, audioTracks: 1 }), 'in-person')
  assert.equal(importMode(info, 'in-person'), 'in-person')
  assert.throws(() => importMode({ ...info, audioTracks: 1 }, 'remote'), RecapError)
  assert.ok(importArguments('/in.mp3', 'in-person', '/out.m4a').includes('aac'))
  assert.ok(importArguments('/in.mov', 'remote', '/out.mov').includes('copy'))
})

const ffmpeg = spawnSync('ffmpeg', ['-version']).status === 0 && spawnSync('ffprobe', ['-version']).status === 0

test('strips the video and keeps both audio tracks', { skip: !ffmpeg && 'ffmpeg is not installed' }, async (t) => {
  const dir = tempDir(t)
  const source = path.join(dir, 'recording.mov')
  const made = spawnSync('ffmpeg', ['-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc=d=2:s=160x120:r=5', '-f', 'lavfi', '-i', 'sine=d=2', '-f', 'lavfi', '-i', 'sine=d=2:f=880', '-map', '0', '-map', '1', '-map', '2', '-c:v', 'mjpeg', '-c:a', 'aac', '-shortest', source])
  assert.equal(made.status, 0, made.stderr.toString())
  writeBytes(path.join(dir, 'mic.wav'), 10)
  writeBytes(path.join(dir, 'transcript-system.json'), 10)
  const value = meeting({ status: 'processed' })
  saveMeeting(value, dir)
  assert.equal((await inspectMedia(source, {})).audioTracks, 2)
  const updated = await stripVideo({}, value, dir, true)
  assert.ok(updated.videoRemovedAt)
  assert.ok(!existsSync(source))
  assert.ok(!existsSync(path.join(dir, 'mic.wav')))
  const audio = await inspectMedia(path.join(dir, 'recording.m4a'), {})
  assert.equal(audio.videoTracks, 0)
  assert.equal(audio.audioTracks, 2)
})
