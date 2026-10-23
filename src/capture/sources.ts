import path from 'node:path'
import { toolDirs, type PlatformContext } from '@kikedealba/kit/platform'
import type { Config } from '../core/config.ts'
import { isRecord } from '../core/json.ts'
import type { MeetingMode } from '../core/meeting.ts'
import type { Channel } from '../pipeline/transcript.ts'

export const CAPTURE_RATE = 48_000
export const CAPTURE_DIR = 'capture'
export const STOP_REQUEST = 'stop.request'
export const LOOPBACK_NAME = 'recap-loopback'

export interface PcmFormat {
  channels: number
  rate: number
}

export interface SourceSpec {
  channel: Channel
  command: string
  args: string[]
  format: PcmFormat | null
}

export interface SourceTools {
  ffmpeg: string
  loopback?: string | undefined
  monitor?: string | undefined
  micDevice?: string | undefined
}

export function captureChannels(mode: MeetingMode): Channel[] {
  return mode === 'remote' ? ['mic', 'system'] : ['mic']
}

export function channelCount(channel: Channel): number {
  return channel === 'mic' ? 1 : 2
}

export function encoderBitrate(channel: Channel): string {
  return channel === 'mic' ? '64k' : '96k'
}

export function micDevice(config: Config): string | undefined {
  const capture = config['capture']
  if (!isRecord(capture)) return undefined
  const value = capture['micDevice']
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined
}

export function loopbackPath(ctx: PlatformContext): string {
  const override = ctx.env['RECAP_LOOPBACK']
  if (override && override.length > 0) return override
  return path.join(toolDirs('recap', ctx).data, 'bin', `${LOOPBACK_NAME}${ctx.platform === 'win32' ? '.exe' : ''}`)
}

function pcmOutput(channels: number): string[] {
  return ['-f', 's16le', '-ac', String(channels), '-ar', String(CAPTURE_RATE), 'pipe:1']
}

export function pulseArguments(device: string, channels: number): string[] {
  return ['-hide_banner', '-loglevel', 'error', '-nostats', '-f', 'pulse', '-sample_rate', String(CAPTURE_RATE), '-channels', String(channels), '-i', device, ...pcmOutput(channels)]
}

export function dshowArguments(device: string, channels: number): string[] {
  return ['-hide_banner', '-loglevel', 'error', '-nostats', '-f', 'dshow', '-i', `audio=${device}`, ...pcmOutput(channels)]
}

export function sourceSpecs(mode: MeetingMode, ctx: PlatformContext, tools: SourceTools): SourceSpec[] {
  return captureChannels(mode).map((channel) => {
    const channels = channelCount(channel)
    const format = { channels, rate: CAPTURE_RATE }
    if (ctx.platform === 'win32') {
      if (channel === 'mic' && tools.micDevice) return { channel, command: tools.ffmpeg, args: dshowArguments(tools.micDevice, channels), format }
      return { channel, command: tools.loopback ?? loopbackPath(ctx), args: ['--source', channel, '--rate', String(CAPTURE_RATE), '--channels', String(channels)], format: null }
    }
    const device = channel === 'mic' ? 'default' : (tools.monitor ?? 'default.monitor')
    return { channel, command: tools.ffmpeg, args: pulseArguments(device, channels), format }
  })
}

export function intermediateFile(dir: string, channel: Channel): string {
  return path.join(dir, CAPTURE_DIR, `${channel}.aac`)
}

export function encoderArguments(channel: Channel, format: PcmFormat, output: string): string[] {
  return [
    '-hide_banner',
    '-loglevel',
    'error',
    '-nostdin',
    '-y',
    '-f',
    's16le',
    '-ar',
    String(format.rate),
    '-ac',
    String(format.channels),
    '-i',
    'pipe:0',
    '-c:a',
    'aac',
    '-b:a',
    encoderBitrate(channel),
    '-ac',
    String(channelCount(channel)),
    '-ar',
    String(CAPTURE_RATE),
    '-f',
    'adts',
    output,
  ]
}

export interface MuxInput {
  file: string
  offsetMs: number
}

export function muxArguments(inputs: readonly MuxInput[], output: string): string[] {
  const args = ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y']
  for (const input of inputs) {
    if (input.offsetMs > 0) args.push('-itsoffset', (input.offsetMs / 1000).toFixed(3))
    args.push('-i', input.file)
  }
  inputs.forEach((_, index) => args.push('-map', `${index}:a:0`))
  args.push('-c', 'copy', '-movflags', '+faststart', output)
  return args
}

export function monitorOf(sink: string): string {
  return sink.endsWith('.monitor') ? sink : `${sink}.monitor`
}

export function parseDefaultSink(pactlInfo: string): string | null {
  for (const line of pactlInfo.split('\n')) {
    const match = /^\s*Default Sink:\s*(\S+)\s*$/.exec(line)
    if (match?.[1]) return match[1]
  }
  return null
}

export function hasPulseInput(devicesOutput: string): boolean {
  return devicesOutput.split('\n').some((line) => /^\s*D\S*\s+pulse\b/.test(line))
}
