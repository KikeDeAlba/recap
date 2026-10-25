import { randomUUID } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { parseEnvelope } from '@kikedealba/kit/envelope'
import { currentRecording } from '../core/active.ts'
import { exists, readText, writeAtomic } from '../core/fsutil.ts'
import { isRecord, parseJsonSafe } from '../core/json.ts'
import type { Located, Meeting } from '../core/meeting.ts'
import { exec, isAlive, sleep, type ExecResult } from '../core/proc.ts'
import { trimmed } from '../core/text.ts'
import { RecapError } from '../errors.ts'
import { captureBinary, captureUnavailable, findCapture, hasCaptureBinary, type CaptureLauncher } from './capture.ts'
import { decodeVideo, readManifest, type CaptureTarget, type CaptureVideo } from './manifest.ts'

export const CONTROL_DIR = 'control'
export const REQUEST_SUFFIX = '.request.json'
export const RESPONSE_SUFFIX = '.response.json'
export const CONTROL_TIMEOUT_MS = 15_000
export const CONTROL_POLL_MS = 50
export const SOURCES_TIMEOUT_MS = 30_000

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

function thumbnail(value: unknown): { thumbnail?: string } {
  return typeof value === 'string' && value.startsWith('data:image/') ? { thumbnail: value } : {}
}

export function decodeSources(value: unknown): CaptureSources {
  if (!isRecord(value)) throw new RecapError('CAPTURE_FAILED', 'The recorder returned no sources')
  const displays = (Array.isArray(value['displays']) ? value['displays'] : []).flatMap((item): DisplaySource[] => {
    if (!isRecord(item)) return []
    const id = integer(item['id'])
    const width = integer(item['width'])
    const height = integer(item['height'])
    if (id === null || width === null || height === null || typeof item['name'] !== 'string') return []
    return [{ id, name: item['name'], width, height, main: item['main'] === true, ...thumbnail(item['thumbnail']) }]
  })
  const windows = (Array.isArray(value['windows']) ? value['windows'] : []).flatMap((item): WindowSource[] => {
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

export function controlDir(dir: string): string {
  return path.join(dir, CONTROL_DIR)
}

export interface ControlOptions {
  timeoutMs?: number
  pollMs?: number
  alive?: () => boolean
  id?: string
}

export function requestBody(id: string, request: ControlRequest): Record<string, unknown> {
  return { id, ...request }
}

export async function sendControl(dir: string, request: ControlRequest, options: ControlOptions = {}): Promise<unknown> {
  const id = options.id ?? randomUUID()
  const folder = controlDir(dir)
  mkdirSync(folder, { recursive: true })
  const requestFile = path.join(folder, `${id}${REQUEST_SUFFIX}`)
  const responseFile = path.join(folder, `${id}${RESPONSE_SUFFIX}`)
  writeAtomic(requestFile, `${JSON.stringify(requestBody(id, request))}\n`)
  const deadline = Date.now() + (options.timeoutMs ?? CONTROL_TIMEOUT_MS)
  const alive = options.alive ?? (() => true)
  for (;;) {
    const text = readText(responseFile)
    if (text !== null) {
      rmSync(responseFile, { force: true })
      return readReply(text, id)
    }
    if (!alive()) {
      rmSync(requestFile, { force: true })
      throw new RecapError('NOT_RECORDING', 'The recorder stopped before answering')
    }
    if (Date.now() >= deadline) {
      rmSync(requestFile, { force: true })
      throw new RecapError('CAPTURE_TIMEOUT', `The recorder did not answer within ${Math.round((options.timeoutMs ?? CONTROL_TIMEOUT_MS) / 1000)}s`, {
        hint: 'Check recorder.log in the meeting folder.',
      })
    }
    await sleep(options.pollMs ?? CONTROL_POLL_MS)
  }
}

function readReply(text: string, id: string): unknown {
  const reply = parseJsonSafe(text)
  if (!isRecord(reply) || reply['id'] !== id) throw new RecapError('CAPTURE_FAILED', 'The recorder sent an unreadable answer')
  if (reply['ok'] === true) return reply['data']
  const error = isRecord(reply['error']) ? reply['error'] : {}
  const code = typeof error['code'] === 'string' ? error['code'] : 'CAPTURE_FAILED'
  const message = typeof error['message'] === 'string' ? error['message'] : 'The recorder could not do it'
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

export async function setCapture(target: CaptureTarget, deps: CaptureDeps = {}): Promise<CaptureState> {
  const located = requireSwitchable(requireMeetingRecording(deps.platform, deps.current))
  const data = await sendControl(located.dir, { action: 'set', target }, { alive: recorderAlive(located.meeting), ...(deps.timeoutMs ? { timeoutMs: deps.timeoutMs } : {}) })
  return stateFromReply(located.meeting, data)
}

export async function clearCapture(deps: CaptureDeps = {}): Promise<CaptureState> {
  const located = requireSwitchable(requireMeetingRecording(deps.platform, deps.current))
  const data = await sendControl(located.dir, { action: 'clear' }, { alive: recorderAlive(located.meeting), ...(deps.timeoutMs ? { timeoutMs: deps.timeoutMs } : {}) })
  return stateFromReply(located.meeting, data)
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
