import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'
import { saveMeeting, type Meeting } from '../src/core/meeting.ts'
import { INTERMEDIATE_FILES, hasVideo, measureStorage } from '../src/media/media.ts'
import { compressVideo, pruneMeeting, stripVideo } from '../src/media/operations.ts'
import { inspectMedia } from '../src/media/probe.ts'
import { RecapError } from '../src/errors.ts'
import { meeting, tempDir, writeBytes } from './helpers.ts'

const ffmpeg = spawnSync('ffmpeg', ['-version']).status === 0 && spawnSync('ffprobe', ['-version']).status === 0

function meetingIn(t: { after: (fn: () => void) => void }, overrides: Partial<Meeting> = {}): { dir: string; value: Meeting } {
  const dir = tempDir(t)
  const value = meeting({ mode: 'meeting', status: 'processed', ...overrides })
  saveMeeting(value, dir)
  return { dir, value }
}

function synthesize(dir: string, seconds: number): void {
  const made = spawnSync('ffmpeg', [
    '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', `testsrc=d=${seconds}:s=1280x720:r=15`,
    '-f', 'lavfi', '-i', `sine=d=${seconds}`,
    '-f', 'lavfi', '-i', `sine=d=${seconds}:f=880`,
    '-map', '0', '-map', '1', '-map', '2',
    '-c:v', 'mjpeg', '-q:v', '2', '-c:a', 'aac', '-shortest',
    path.join(dir, 'recording.mov'),
  ])
  assert.equal(made.status, 0, made.stderr.toString())
}

function writeIntermediates(dir: string): void {
  for (const name of INTERMEDIATE_FILES) writeBytes(path.join(dir, name), 10)
}

test('compress-video and strip-video work on a meeting that assembled recording.mov', { skip: !ffmpeg && 'ffmpeg is not installed' }, async (t) => {
  const { dir, value } = meetingIn(t)
  synthesize(dir, 6)
  const source = path.join(dir, 'recording.mov')
  assert.ok(hasVideo(dir, 'meeting'))
  const before = measureStorage(dir, 'meeting').recordingBytes
  const compressed = await compressVideo({}, value, dir, 'max', false)
  assert.equal(compressed.video?.preset, 'max')
  assert.equal(compressed.video?.originalBytes, before)
  assert.ok(measureStorage(dir, 'meeting').recordingBytes < before)
  assert.equal((await inspectMedia(source, {})).videoTracks, 1)
  writeIntermediates(dir)
  const stripped = await stripVideo({}, compressed, dir, true)
  assert.ok(stripped.videoRemovedAt)
  assert.ok(!existsSync(source))
  assert.ok(!hasVideo(dir, 'meeting'))
  assert.equal(measureStorage(dir, 'meeting').intermediateBytes, 0)
  const audio = await inspectMedia(path.join(dir, 'recording.m4a'), {})
  assert.equal(audio.videoTracks, 0)
  assert.equal(audio.audioTracks, 2)
})

test('compress-video and strip-video fail with NO_VIDEO on a meeting recorded with the microphone only', async (t) => {
  const { dir, value } = meetingIn(t)
  writeBytes(path.join(dir, 'recording.m4a'), 10)
  const noVideo = (error: unknown) => error instanceof RecapError && error.code === 'NO_VIDEO'
  await assert.rejects(stripVideo({}, value, dir, false), noVideo)
  await assert.rejects(compressVideo({}, value, dir, 'medium', false), noVideo)
  assert.ok(existsSync(path.join(dir, 'recording.m4a')))
})

test('the NOT_REMOTE error of an in-person or fallback meeting names no modality', async (t) => {
  for (const overrides of [{ mode: 'in-person' as const }, { mode: 'in-person' as const, fallback: 'in-person' as const }]) {
    const { dir, value } = meetingIn(t, overrides)
    await assert.rejects(stripVideo({}, value, dir, false), (error: unknown) => {
      assert.ok(error instanceof RecapError)
      assert.equal(error.code, 'NOT_REMOTE')
      assert.doesNotMatch(error.message, /presencial|in-person/)
      return true
    })
  }
})

test('prune clears the intermediates of a meeting and keeps its recording, with and without video', (t) => {
  for (const file of ['recording.m4a', 'recording.mov']) {
    const { dir, value } = meetingIn(t)
    writeBytes(path.join(dir, file), 20)
    writeIntermediates(dir)
    writeBytes(path.join(dir, 'transcript.json'), 5)
    pruneMeeting(value, dir)
    const storage = measureStorage(dir, 'meeting')
    assert.equal(storage.intermediateBytes, 0)
    assert.equal(storage.recordingBytes, 20)
    assert.equal(hasVideo(dir, 'meeting'), file === 'recording.mov')
    assert.ok(existsSync(path.join(dir, 'transcript.json')))
  }
})

test('prune refuses a meeting that is still being recorded', (t) => {
  const { dir, value } = meetingIn(t, { status: 'recording' })
  assert.throws(() => pruneMeeting(value, dir), (error: unknown) => error instanceof RecapError && error.code === 'MEETING_ACTIVE')
})
