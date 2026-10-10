import assert from 'node:assert/strict'
import { appendFileSync, existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'
import { applyConfigValue, configSnapshot, configValue, liveSettings, parseConfigKey } from '../src/core/live-settings.ts'
import { parseConfig } from '../src/core/config.ts'
import { appendLines, liveFiles, readLines } from '../src/live/files.ts'
import { LiveMerger, renderLive, transcriptWindow } from '../src/live/merger.ts'
import { liveWhisperArguments } from '../src/live/worker.ts'
import { measureStorage } from '../src/media/media.ts'
import { removeIntermediates } from '../src/media/operations.ts'
import { decodeSegment, type Channel, type Segment } from '../src/pipeline/transcript.ts'
import { RecapError } from '../src/errors.ts'
import { tempDir, writeBytes } from './helpers.ts'

const segment = (startMs: number, endMs: number, channel: Channel, text: string): Segment => ({ startMs, endMs, channel, text })

test('appends and reads JSON lines, skipping broken ones', (t) => {
  const dir = tempDir(t)
  const file = liveFiles.transcript(dir)
  appendLines([segment(0, 1_000, 'mic', 'hola')], file)
  appendFileSync(file, '{not json\n')
  appendLines([segment(2_000, 3_000, 'system', 'qué tal')], file)
  assert.equal(readFileSync(file, 'utf8').split('\n')[0], '{"channel":"mic","endMs":1000,"startMs":0,"text":"hola"}')
  assert.deepEqual(
    readLines(file, decodeSegment).map((item) => item.text),
    ['hola', 'qué tal'],
  )
})

test('prune removes the live chunks but keeps the transcript', (t) => {
  const dir = tempDir(t)
  writeBytes(path.join(liveFiles.chunks(dir), 'mic-00001.wav'), 3)
  appendLines([segment(0, 1, 'mic', 'x')], liveFiles.transcript(dir))
  assert.equal(measureStorage(dir, 'remote').intermediateBytes, 3)
  removeIntermediates(dir)
  assert.ok(!existsSync(liveFiles.chunks(dir)))
  assert.ok(existsSync(liveFiles.transcript(dir)))
})

test('the merger holds the microphone until the call audio covers it and drops echo', () => {
  const merger = new LiveMerger(true, 30)
  const now = Date.now()
  const echo = segment(10_300, 14_200, 'mic', 'acordamos entregar el reporte el viernes')
  const own = segment(15_000, 17_000, 'mic', 'Perfecto, yo me encargo del reporte')
  assert.deepEqual(merger.add([echo, own], 'mic', 17_000, now), [])
  const system = segment(10_000, 14_000, 'system', 'Acordamos entregar el reporte el viernes')
  assert.deepEqual(merger.add([system], 'system', 20_000, now), [system, own])
  assert.equal(merger.pendingCount, 0)
})

test('the merger releases the microphone when the call is silent or after the hold time', () => {
  const merger = new LiveMerger(true, 30)
  const now = Date.now()
  const own = segment(1_000, 3_000, 'mic', 'Buenos días')
  assert.deepEqual(merger.add([own], 'mic', 3_000, now), [])
  assert.deepEqual(merger.advance('system', 4_000, now), [])
  assert.deepEqual(merger.advance('system', 6_000, now), [own])
  const held = new LiveMerger(true, 30)
  held.add([own], 'mic', 3_000, now)
  assert.deepEqual(held.release(now + 10_000, false), [])
  assert.deepEqual(held.release(now + 31_000, false), [own])
})

test('in-person segments pass straight through and repeats are dropped', () => {
  const merger = new LiveMerger(false, 30)
  const first = segment(0, 2_000, 'mic', 'Hola a todos.')
  assert.deepEqual(merger.add([first, segment(5_000, 7_000, 'mic', 'hola a todos')], 'mic', 7_000, Date.now()), [first])
})

test('the window keeps the last seconds and renders speakers', () => {
  const segments = [segment(0, 5_000, 'system', 'Arrancamos con el estado del sprint.'), segment(200_000, 204_000, 'system', '¿Cómo se despliega el servicio?'), segment(205_000, 207_000, 'mic', 'Déjame revisar.')]
  const window = transcriptWindow(segments, 60)
  assert.deepEqual(
    window.map((item) => item.startMs),
    [200_000, 205_000],
  )
  assert.equal(renderLive(window, true), '[00:03:20] Remotos: ¿Cómo se despliega el servicio?\n[00:03:25] Sala: Déjame revisar.')
  assert.ok(renderLive([], true).includes('Todavía no hay'))
})

test('live whisper arguments carry the previous text and the glossary', () => {
  const args = liveWhisperArguments({ vocabulary: ['CoDi'] }, '/m.bin', '/c/mic-00001', '/c/mic-00001.wav', 'el webhook de BBVA')
  assert.equal(args[args.indexOf('-t') + 1], '4')
  assert.equal(args[args.indexOf('--prompt') + 1], 'Glosario: CoDi. el webhook de BBVA')
  assert.equal(args.at(-1), '/c/mic-00001.wav')
})

test('live settings default on and clamp out-of-range values', () => {
  const settings = liveSettings(parseConfig('{"language":"es"}').live)
  assert.ok(settings.enabled && settings.openWindow && settings.proposals && settings.autoAsk)
  assert.equal(settings.maxChunkSeconds, 10)
  assert.equal(settings.assistModel, null)
  assert.equal(settings.autoAskModel, 'haiku')
  assert.equal(settings.autoAskMinSeconds, 5)
  assert.equal(settings.autoAskConcurrency, 3)
  assert.equal(liveSettings({ autoAskMinSeconds: 1 }).autoAskMinSeconds, 3)
  assert.equal(liveSettings({ autoAskMinSeconds: 900 }).autoAskMinSeconds, 120)
  assert.equal(liveSettings({ autoAskConcurrency: 0 }).autoAskConcurrency, 1)
  assert.equal(liveSettings({ autoAskConcurrency: 9 }).autoAskConcurrency, 6)
  assert.equal(liveSettings({ maxChunkSeconds: 2 }).maxChunkSeconds, 5)
})

test('config keys set and read every value', () => {
  let live = applyConfigValue(parseConfigKey('live.autoAsk'), 'off', undefined)
  live = applyConfigValue(parseConfigKey('live.autoAskModel'), 'sonnet', live)
  live = applyConfigValue(parseConfigKey('live.autoAskMinSeconds'), '45', live)
  assert.equal(configValue('live.autoAsk', live), false)
  assert.equal(configValue('live.autoAskModel', live), 'sonnet')
  assert.equal(configValue('live.autoAskMinSeconds', live), 45)
  live = applyConfigValue('live.autoAskModel', 'default', live)
  assert.equal(configValue('live.autoAskModel', live), 'haiku')
  assert.throws(() => applyConfigValue('live.autoAskMinSeconds', '2', live), RecapError)
  assert.throws(() => applyConfigValue('live.autoAskMinSeconds', '121', live), RecapError)
  live = applyConfigValue(parseConfigKey('live.autoaskconcurrency'), '1', live)
  assert.throws(() => applyConfigValue('live.autoAskConcurrency', '0', live), RecapError)
  assert.throws(() => applyConfigValue('live.autoAskConcurrency', 'two', live), RecapError)
  live = applyConfigValue('live.enabled', 'off', live)
  live = applyConfigValue('live.maxChunkSeconds', '12', live)
  live = applyConfigValue('live.assistModel', 'haiku', live)
  assert.equal(configValue('live.assistModel', live), 'haiku')
  live = applyConfigValue('live.assistModel', 'null', live)
  assert.equal(configValue('live.assistModel', live), null)
  assert.throws(() => applyConfigValue('live.maxChunkSeconds', '2', live), RecapError)
  assert.throws(() => applyConfigValue('live.enabled', 'maybe', live), RecapError)
  assert.throws(() => parseConfigKey('live.nope'), RecapError)
  const snapshot = configSnapshot(live)
  assert.equal(snapshot['live.enabled'], false)
  assert.equal(snapshot['live.autoAskConcurrency'], 1)
  assert.ok(JSON.stringify(snapshot).includes('"live.assistModel":null'))
})
