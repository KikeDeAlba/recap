import { randomUUID } from 'node:crypto'
import { chmodSync, closeSync, constants, fstatSync, lstatSync, mkdirSync, mkdtempSync, openSync, readdirSync, readSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { parseEnvelope } from '@kikedealba/kit/envelope'
import { currentRecording } from '../core/active.ts'
import { exists, readText } from '../core/fsutil.ts'
import { isRecord, parseJsonSafe } from '../core/json.ts'
import type { Located, Meeting } from '../core/meeting.ts'
import { exec, isAlive, signalNumber, sleep, type ExecResult } from '../core/proc.ts'
import { printable, trimmed } from '../core/text.ts'
import { RecapError } from '../errors.ts'
import { controlDir } from './control-dir.ts'
import { captureBinary, captureUnavailable, findCapture, hasCaptureBinary, type CaptureLauncher } from './capture.ts'
import { decodeVideo, readManifest, type CaptureTarget, type CaptureVideo } from './manifest.ts'

export { CONTROL_DIR, controlDir } from './control-dir.ts'
export const REQUEST_SUFFIX = '.request.json'
export const RESPONSE_SUFFIX = '.response.json'
export const CONTROL_TIMEOUT_MS = 15_000
export const CONTROL_POLL_MS = 50
export const SOURCES_TIMEOUT_MS = 30_000
export const RESPONSE_LIFETIME_MS = 60_000
export const RESPONSE_MAX_BYTES = 16 * 1024 * 1024
export const THUMBNAIL_MAX_CHARS = 512 * 1024
export const MAX_THUMBNAILS = 64
export const MAX_DISPLAYS = 32
export const MAX_WINDOWS = 256
export const CONTROL_REPLACED = 'CONTROL_REPLACED'
export const CONTROL_ATTEMPTS = 2
const THUMBNAIL = /^data:image\/jpeg;base64,[A-Za-z0-9+/=]+$/

export interface DisplaySource {
  id: number
  name: string
  width: number
  height: number
  main: boolean
  thumbnail?: string | undefined
}

export interface WindowSource {
  id: number
  app: string
  bundleId: string
  title: string
  pid: number
  width: number
  height: number
  thumbnail?: string | undefined
}

export interface CaptureSources {
  displays: DisplaySource[]
  windows: WindowSource[]
}

export interface CaptureState {
  meetingId: string
  mic: boolean
  systemAudio: boolean
  video: CaptureVideo | null
}

export type ControlRequest = { action: 'set'; target: CaptureTarget } | { action: 'clear' } | { action: 'sources'; thumbnails: boolean }

function integer(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) ? value : null
}

export function isThumbnail(value: unknown): value is string {
  return typeof value === 'string' && value.length <= THUMBNAIL_MAX_CHARS && THUMBNAIL.test(value)
}

export function decodeSources(value: unknown): CaptureSources {
  if (!isRecord(value)) throw new RecapError('CAPTURE_FAILED', 'The recorder returned no sources')
  let thumbnails = 0
  const thumbnail = (value: unknown): { thumbnail?: string } => {
    if (!isThumbnail(value) || thumbnails >= MAX_THUMBNAILS) return {}
    thumbnails += 1
    return { thumbnail: value }
  }
  const displays = (Array.isArray(value['displays']) ? value['displays'] : []).slice(0, MAX_DISPLAYS).flatMap((item): DisplaySource[] => {
    if (!isRecord(item)) return []
    const id = integer(item['id'])
    const width = integer(item['width'])
    const height = integer(item['height'])
    if (id === null || width === null || height === null || typeof item['name'] !== 'string') return []
    return [{ id, name: item['name'], width, height, main: item['main'] === true, ...thumbnail(item['thumbnail']) }]
  })
  const windows = (Array.isArray(value['windows']) ? value['windows'] : []).slice(0, MAX_WINDOWS).flatMap((item): WindowSource[] => {
    if (!isRecord(item)) return []
    const id = integer(item['id'])
    const pid = integer(item['pid'])
    const width = integer(item['width'])
    const height = integer(item['height'])
    const { app, bundleId, title } = item
    if (id === null || pid === null || width === null || height === null) return []
    if (typeof app !== 'string' || typeof bundleId !== 'string' || typeof title !== 'string') return []
    return [{ id, app, bundleId, title, pid, width, height, ...thumbnail(item['thumbnail']) }]
  })
  return { displays, windows }
}

export function captureState(meeting: Pick<Meeting, 'id' | 'status'>, video: CaptureVideo | null): CaptureState {
  const mic = meeting.status === 'recording'
  const current = mic ? video : null
  return { meetingId: meeting.id, mic, systemAudio: current !== null, video: current }
}

export function stateOf(located: Located): CaptureState {
  return captureState(located.meeting, readManifest(located.dir)?.video ?? null)
}

export function requireMeetingRecording(platform: NodeJS.Platform = process.platform, current: () => Located | null = activeLocated): Located {
  if (platform !== 'darwin') {
    throw new RecapError('CAPTURE_UNSUPPORTED', 'Adding a screen or a window to a meeting needs Recap.app on macOS', {
      hint: 'On Linux and Windows a meeting records the microphone only.',
    })
  }
  const located = current()
  if (!located) throw new RecapError('NOT_RECORDING', 'There is no active recording')
  const { meeting } = located
  if (meeting.mode !== 'meeting') {
    throw new RecapError('CAPTURE_UNSUPPORTED', `"${meeting.title}" is a ${meeting.mode} recording; only a meeting started without --remote or --in-person can add a screen or a window`)
  }
  if (meeting.status !== 'recording') throw new RecapError('NOT_RECORDING', `"${meeting.title}" is still starting`)
  return located
}

export function requireSwitchable(located: Located): Located {
  if (readManifest(located.dir) === null) {
    throw new RecapError('CAPTURE_UNSUPPORTED', `The Recap.app that records "${located.meeting.title}" cannot add a screen or a window`, {
      hint: 'Update Recap.app with `recap setup` and start a new meeting.',
    })
  }
  return located
}

function activeLocated(): Located | null {
  const current = currentRecording()
  return current ? { meeting: current.meeting, dir: current.active.dir } : null
}

export interface ControlOptions {
  timeoutMs?: number
  pollMs?: number
  alive?: () => boolean
  id?: string
  now?: () => number
}

export function requestBody(id: string, request: ControlRequest, issuedAt: number = Date.now()): Record<string, unknown> {
  return { id, issuedAt, ...request }
}

function ownUid(): number | null {
  return typeof process.getuid === 'function' ? process.getuid() : null
}

export function prepareControlDir(dir: string): string {
  const folder = controlDir(dir)
  try {
    const info = lstatSync(folder)
    const uid = ownUid()
    if (!info.isDirectory() || (uid !== null && info.uid !== uid)) rmSync(folder, { recursive: true, force: true })
  } catch {
    undefined
  }
  mkdirSync(folder, { recursive: true, mode: 0o700 })
  const info = lstatSync(folder)
  const uid = ownUid()
  if (!info.isDirectory() || (uid !== null && info.uid !== uid)) throw new RecapError('CAPTURE_FAILED', `${folder} is not a private folder of this user`)
  chmodSync(folder, 0o700)
  return folder
}

export function sweepResponses(folder: string, now: number = Date.now()): void {
  let names: string[]
  try {
    names = readdirSync(folder)
  } catch {
    return
  }
  for (const name of names) {
    if (!name.endsWith(RESPONSE_SUFFIX) && !name.endsWith('.tmp')) continue
    try {
      const info = lstatSync(path.join(folder, name))
      if (now - info.mtimeMs > RESPONSE_LIFETIME_MS) rmSync(path.join(folder, name), { force: true })
    } catch {
      undefined
    }
  }
}

function controlVanished(error: unknown): unknown {
  if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return error
  return new RecapError('NOT_RECORDING', 'The control folder of the recording disappeared before the request was sent', {
    hint: 'The recording probably stopped; check it with `recap capture state`.',
  })
}

export function writeRequest(file: string, content: string): void {
  const temporary = path.join(path.dirname(file), `.${randomUUID()}.tmp`)
  try {
    writeFileSync(temporary, content, { flag: 'wx', mode: 0o600 })
  } catch (error) {
    throw controlVanished(error)
  }
  try {
    renameSync(temporary, file)
  } catch (error) {
    rmSync(temporary, { force: true })
    throw controlVanished(error)
  }
}

export function readResponse(file: string): string | null {
  let descriptor: number
  try {
    descriptor = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw new RecapError('CAPTURE_FAILED', 'The recorder sent an unreadable answer')
  }
  try {
    const info = fstatSync(descriptor)
    const uid = ownUid()
    if (!info.isFile() || (uid !== null && info.uid !== uid) || info.size > RESPONSE_MAX_BYTES) {
      throw new RecapError('CAPTURE_FAILED', 'The recorder sent an unreadable answer')
    }
    const buffer = Buffer.alloc(info.size)
    let offset = 0
    while (offset < buffer.length) {
      const count = readSync(descriptor, buffer, offset, buffer.length - offset, offset)
      if (count === 0) break
      offset += count
    }
    return buffer.subarray(0, offset).toString('utf8')
  } finally {
    closeSync(descriptor)
  }
}

export async function sendControl(dir: string, request: ControlRequest, options: ControlOptions = {}): Promise<unknown> {
  const id = options.id ?? randomUUID()
  const folder = prepareControlDir(dir)
  sweepResponses(folder)
  const requestFile = path.join(folder, `${id}${REQUEST_SUFFIX}`)
  const responseFile = path.join(folder, `${id}${RESPONSE_SUFFIX}`)
  const withdraw = () => {
    rmSync(requestFile, { force: true })
    rmSync(responseFile, { force: true })
  }
  const onSignal = (signal: NodeJS.Signals) => {
    withdraw()
    process.exit(128 + signalNumber(signal))
  }
  process.once('SIGINT', onSignal)
  process.once('SIGTERM', onSignal)
  try {
    const send = () => writeRequest(requestFile, `${JSON.stringify(requestBody(id, request, (options.now ?? Date.now)()))}\n`)
    send()
    const deadline = Date.now() + (options.timeoutMs ?? CONTROL_TIMEOUT_MS)
    const alive = options.alive ?? (() => true)
    let attempts = 1
    for (;;) {
      const text = readResponse(responseFile)
      if (text !== null) {
        rmSync(responseFile, { force: true })
        try {
          return readReply(text, id)
        } catch (error) {
          if (!(error instanceof RecapError) || error.code !== CONTROL_REPLACED || attempts >= CONTROL_ATTEMPTS || Date.now() >= deadline) throw error
          attempts += 1
          prepareControlDir(dir)
          send()
          continue
        }
      }
      if (!alive()) {
        withdraw()
        throw new RecapError('NOT_RECORDING', 'The recorder stopped before answering')
      }
      if (Date.now() >= deadline) {
        withdraw()
        throw new RecapError('CAPTURE_TIMEOUT', `The recorder did not answer within ${Math.round((options.timeoutMs ?? CONTROL_TIMEOUT_MS) / 1000)}s`, {
          hint: 'Check recorder.log in the meeting folder.',
        })
      }
      await sleep(options.pollMs ?? CONTROL_POLL_MS)
    }
  } catch (error) {
    withdraw()
    throw error
  } finally {
    process.removeListener('SIGINT', onSignal)
    process.removeListener('SIGTERM', onSignal)
  }
}

function readReply(text: string, id: string): unknown {
  const reply = parseJsonSafe(text)
  if (!isRecord(reply) || reply['id'] !== id) throw new RecapError('CAPTURE_FAILED', 'The recorder sent an unreadable answer')
  if (reply['ok'] === true) return reply['data']
  const error = isRecord(reply['error']) ? reply['error'] : {}
  const code = typeof error['code'] === 'string' ? error['code'] : 'CAPTURE_FAILED'
  const message = typeof error['message'] === 'string' ? printable(error['message']) : 'The recorder could not do it'
  if (code === CONTROL_REPLACED) throw new RecapError(code, message, { hint: 'The request was not run; send it again.' })
  throw new RecapError(code, message)
}

function recorderAlive(meeting: Meeting): () => boolean {
  return () => meeting.recorderPid === undefined || isAlive(meeting.recorderPid)
}

export function stateFromReply(meeting: Meeting, data: unknown): CaptureState {
  const video = isRecord(data) ? decodeVideo(data['video']) : null
  return captureState(meeting, video)
}

export interface CaptureDeps {
  platform?: NodeJS.Platform
  current?: () => Located | null
  timeoutMs?: number
}

export function videoLabel(video: CaptureVideo | null): string {
  if (!video) return 'the microphone only'
  return `${video.kind} ${video.id} "${printable(video.title)}"`
}

export function confirmAfterTimeout(error: unknown, current: () => Located | null): never {
  if (!(error instanceof RecapError) || error.code !== 'CAPTURE_TIMEOUT') throw error
  const located = current()
  const state = located ? captureState(located.meeting, readManifest(located.dir)?.video ?? null) : null
  const now = state === null || !state.mic ? 'the meeting is no longer recording' : `the meeting records ${videoLabel(state.video)}`
  throw new RecapError('CAPTURE_TIMEOUT', `${error.message}; ${now}`, {
    hint: 'The recorder may still apply the change; check it with `recap capture state` and recorder.log in the meeting folder.',
  })
}

async function control(request: ControlRequest, deps: CaptureDeps): Promise<CaptureState> {
  const current = deps.current ?? activeLocated
  const located = requireSwitchable(requireMeetingRecording(deps.platform, current))
  try {
    const data = await sendControl(located.dir, request, { alive: recorderAlive(located.meeting), ...(deps.timeoutMs ? { timeoutMs: deps.timeoutMs } : {}) })
    return stateFromReply(located.meeting, data)
  } catch (error) {
    return confirmAfterTimeout(error, current)
  }
}

export async function setCapture(target: CaptureTarget, deps: CaptureDeps = {}): Promise<CaptureState> {
  return control({ action: 'set', target }, deps)
}

export async function clearCapture(deps: CaptureDeps = {}): Promise<CaptureState> {
  return control({ action: 'clear' }, deps)
}

export function readCaptureState(deps: CaptureDeps = {}): CaptureState {
  return stateOf(requireMeetingRecording(deps.platform, deps.current))
}

export type SourcesRunner = (launcher: CaptureLauncher, thumbnails: boolean, timeoutMs: number) => Promise<CaptureSources>

export interface SourcesDeps extends CaptureDeps {
  find?: () => Promise<CaptureLauncher | null>
  standalone?: SourcesRunner
}

export async function listSources(thumbnails: boolean, deps: SourcesDeps = {}): Promise<CaptureSources> {
  if ((deps.platform ?? process.platform) !== 'darwin') {
    throw new RecapError('CAPTURE_UNSUPPORTED', 'Listing screens and windows needs Recap.app on macOS')
  }
  const timeoutMs = deps.timeoutMs ?? SOURCES_TIMEOUT_MS
  const located = (deps.current ?? activeLocated)()
  if (located && located.meeting.mode === 'meeting' && located.meeting.status === 'recording' && readManifest(located.dir) !== null) {
    const data = await sendControl(located.dir, { action: 'sources', thumbnails }, { alive: recorderAlive(located.meeting), timeoutMs })
    return decodeSources(data)
  }
  const launcher = await (deps.find ?? findCapture)()
  if (!launcher) throw captureUnavailable()
  return (deps.standalone ?? standaloneSources)(launcher, thumbnails, timeoutMs)
}

export function sourcesArguments(thumbnails: boolean): string[] {
  return ['sources', ...(thumbnails ? ['--thumbnails'] : []), '--json']
}

export function readSourcesOutput(stdout: string | null, stderr: string): CaptureSources {
  const envelope = stdout === null ? null : parseEnvelope(stdout)
  if (!envelope) throw new RecapError('CAPTURE_FAILED', `Recap.app did not list the sources. ${trimmed(stderr)}`.trim())
  if (envelope.ok) return decodeSources(envelope.data)
  const code = envelope.error?.code ?? 'CAPTURE_FAILED'
  if (code === 'USAGE') {
    throw new RecapError('CAPTURE_UNSUPPORTED', 'The installed Recap.app cannot list screens and windows', { hint: 'Update it with `recap setup`.' })
  }
  throw new RecapError(code, envelope.error?.message ?? 'Recap.app could not list the sources')
}

export async function standaloneSources(launcher: CaptureLauncher, thumbnails: boolean, timeoutMs: number, run: (command: string, args: string[], timeoutMs: number) => Promise<ExecResult> = (command, args, ms) => exec(command, args, { timeoutMs: ms })): Promise<CaptureSources> {
  const args = sourcesArguments(thumbnails)
  if (launcher.kind === 'binary') {
    const result = await run(launcher.binary, args, timeoutMs)
    return readSourcesOutput(result.stdout, result.stderr)
  }
  if (!hasCaptureBinary(launcher.app) || captureBinary(launcher) === null) {
    throw new RecapError('CAPTURE_UNSUPPORTED', 'The installed Recap.app cannot list screens and windows', { hint: 'Update it with `recap setup`.' })
  }
  const work = mkdtempSync(path.join(tmpdir(), 'recap-sources-'))
  try {
    const out = path.join(work, 'out.json')
    const err = path.join(work, 'err.log')
    const result = await run('/usr/bin/open', ['-W', '-g', '-n', '-a', launcher.app, '--stdout', out, '--stderr', err, '--args', 'capture', ...args], timeoutMs)
    return readSourcesOutput(exists(out) ? readText(out) : null, `${result.stderr}${readText(err) ?? ''}`)
  } finally {
    rmSync(work, { recursive: true, force: true })
  }
}
