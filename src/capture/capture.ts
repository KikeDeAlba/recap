import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { which } from '@kikedealba/kit/platform'
import { exists, readText } from '../core/fsutil.ts'
import { isRecord } from '../core/json.ts'
import { home } from '../core/paths.ts'
import { exec, spawnDetached } from '../core/proc.ts'
import { selfCommand } from '../core/self.ts'
import { trimmed } from '../core/text.ts'
import { RecapError } from '../errors.ts'
import { parseEnvelope } from '@kikedealba/kit/envelope'

export type CaptureLauncher = { kind: 'app'; app: string } | { kind: 'binary'; binary: string }

export function appCandidates(): string[] {
  const override = process.env['RECAP_APP']
  return [...(override ? [override] : []), path.join(home(), 'Applications', 'Recap.app'), '/Applications/Recap.app']
}

export function findRecapApp(): string | null {
  if (process.platform !== 'darwin') return null
  return appCandidates().find((app) => exists(path.join(app, 'Contents', 'MacOS', 'recap')) || exists(path.join(app, 'Contents', 'MacOS', 'recap-capture'))) ?? null
}

export async function findCapture(): Promise<CaptureLauncher | null> {
  const app = findRecapApp()
  if (app) return { kind: 'app', app }
  const override = process.env['RECAP_CAPTURE']
  if (override && exists(override)) return { kind: 'binary', binary: override }
  const binary = await which('recap-capture')
  return binary ? { kind: 'binary', binary } : null
}

export function captureUnavailable(): RecapError {
  const hint =
    process.platform === 'darwin'
      ? 'Install Recap.app with `recap setup` (it downloads it from the GitHub release), or set RECAP_APP.'
      : 'Recording is only available on macOS for now. Record with any app and process the file with `recap import <file>`.'
  return new RecapError('CAPTURE_UNAVAILABLE', 'The recorder (recap-capture) is not available on this machine', { hint })
}

export function liveWorkerCommand(): string {
  return JSON.stringify([...selfCommand(), 'live-worker'])
}

export function hasCaptureBinary(app: string): boolean {
  return exists(path.join(app, 'Contents', 'MacOS', 'recap-capture'))
}

export function launchArguments(app: string, dir: string, log: string, modern = hasCaptureBinary(app)): string[] {
  if (!modern) return ['-g', '-n', '-a', app, '--stdout', log, '--stderr', log, '--args', 'record', dir]
  return ['-g', '-n', '-a', app, '--env', `RECAP_LIVE_WORKER=${liveWorkerCommand()}`, '--stdout', log, '--stderr', log, '--args', 'capture', 'record', dir]
}

export async function launchRecorder(dir: string): Promise<void> {
  const launcher = await findCapture()
  if (!launcher) throw captureUnavailable()
  const log = path.join(dir, 'recorder.log')
  if (launcher.kind === 'app') {
    const result = await exec('/usr/bin/open', launchArguments(launcher.app, dir, log))
    if (result.status !== 0) throw new RecapError('LAUNCH_FAILED', `Cannot launch ${path.basename(launcher.app)}: ${trimmed(result.stderr)}`)
    return
  }
  spawnDetached(launcher.binary, ['record', dir, '--live-worker', liveWorkerCommand()], log)
}

export interface PermissionReport {
  microphone: string
  screen: string
}

function readReport(text: string | null): PermissionReport | null {
  if (text === null) return null
  const envelope = parseEnvelope(text)
  const data = envelope?.data ?? (() => {
    try {
      return JSON.parse(text) as unknown
    } catch {
      return null
    }
  })()
  if (!isRecord(data) || typeof data['microphone'] !== 'string' || typeof data['screen'] !== 'string') return null
  return { microphone: data['microphone'], screen: data['screen'] }
}

export async function capturePermissions(launcher: CaptureLauncher, request: boolean): Promise<PermissionReport> {
  const args = ['permissions', ...(request ? ['--request'] : []), '--json']
  if (launcher.kind === 'binary') {
    const result = await exec(launcher.binary, args)
    const report = readReport(result.stdout)
    if (!report) throw new RecapError('PERMISSIONS_UNKNOWN', `recap-capture did not report its permissions. ${trimmed(result.stderr)}`)
    return report
  }
  const work = mkdtempSync(path.join(tmpdir(), 'recap-permissions-'))
  try {
    const out = path.join(work, 'out.json')
    const err = path.join(work, 'err.log')
    const tail = hasCaptureBinary(launcher.app) ? ['--stdout', out, '--stderr', err, '--args', 'capture', ...args] : ['--stderr', err, '--args', 'permissions', '--out', out, ...(request ? [] : ['--check'])]
    const result = await exec('/usr/bin/open', ['-W', '-g', '-n', '-a', launcher.app, ...tail])
    const report = readReport(readText(out))
    if (!report) throw new RecapError('PERMISSIONS_UNKNOWN', `Recap.app did not report its permissions. ${trimmed(result.stderr + (readText(err) ?? ''))}`)
    return report
  } finally {
    rmSync(work, { recursive: true, force: true })
  }
}
