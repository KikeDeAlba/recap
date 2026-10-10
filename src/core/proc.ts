import { spawn, spawnSync } from 'node:child_process'
import { closeSync, mkdirSync, openSync } from 'node:fs'
import path from 'node:path'
import { RecapError } from '../errors.ts'

export interface ExecResult {
  status: number
  signal: NodeJS.Signals | null
  stdout: string
  stderr: string
}

export interface ExecOptions {
  input?: string
  env?: NodeJS.ProcessEnv
  cwd?: string
  onStdout?: (chunk: string) => void
  onSpawn?: (pid: number) => void
  detached?: boolean
}

export function isAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export async function waitUntil(timeoutSeconds: number, intervalSeconds: number, condition: () => boolean | Promise<boolean>): Promise<boolean> {
  const deadline = Date.now() + timeoutSeconds * 1000
  while (Date.now() < deadline) {
    if (await condition()) return true
    await sleep(intervalSeconds * 1000)
  }
  return condition()
}

function needsShell(command: string): boolean {
  return process.platform === 'win32' && /\.(cmd|bat)$/i.test(command)
}

function quoteForCmd(arg: string): string {
  if (arg.length > 0 && !/[\s"&|<>^%()!,;=]/.test(arg)) return arg
  return `"${arg.replace(/"/g, '""')}"`
}

export function commandLine(command: string, args: readonly string[]): { command: string; args: string[]; shell: boolean } {
  if (!needsShell(command)) return { command, args: [...args], shell: false }
  return { command: quoteForCmd(command), args: args.map(quoteForCmd), shell: true }
}

export function exec(command: string, args: readonly string[], options: ExecOptions = {}): Promise<ExecResult> {
  return new Promise((resolve, reject) => {
    const line = commandLine(command, args)
    const child = spawn(line.command, line.args, {
      env: options.env ?? process.env,
      cwd: options.cwd,
      windowsHide: true,
      shell: line.shell,
      detached: options.detached ?? false,
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    child.once('spawn', () => {
      if (child.pid !== undefined) options.onSpawn?.(child.pid)
    })
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
      stdout += chunk
      options.onStdout?.(chunk)
    })
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => {
      stderr += chunk
    })
    child.once('error', (error) => {
      reject(new RecapError('SPAWN_FAILED', `Cannot start ${path.basename(command)}: ${error.message}`))
    })
    child.once('close', (code, signal) => {
      resolve({ status: code ?? (signal ? 128 + signalNumber(signal) : 1), signal, stdout, stderr })
    })
    child.stdin.on('error', () => undefined)
    child.stdin.end(options.input ?? '')
  })
}

export function signalNumber(signal: NodeJS.Signals): number {
  const table: Partial<Record<NodeJS.Signals, number>> = { SIGHUP: 1, SIGINT: 2, SIGKILL: 9, SIGTERM: 15 }
  return table[signal] ?? 1
}

export function spawnDetached(command: string, args: readonly string[], logPath: string, env: NodeJS.ProcessEnv = process.env): number {
  mkdirSync(path.dirname(logPath), { recursive: true })
  const log = openSync(logPath, 'a')
  try {
    const line = commandLine(command, args)
    const child = spawn(line.command, line.args, {
      detached: true,
      stdio: ['ignore', log, log],
      env,
      windowsHide: true,
      shell: line.shell,
    })
    if (child.pid === undefined) throw new RecapError('SPAWN_FAILED', `Cannot start ${path.basename(command)}`)
    child.unref()
    return child.pid
  } finally {
    closeSync(log)
  }
}

export function signalProcess(pid: number, signal: NodeJS.Signals): boolean {
  try {
    process.kill(pid, signal)
    return true
  } catch {
    return false
  }
}

export function signalTree(pid: number, signal: NodeJS.Signals): void {
  if (pid <= 1 || pid === process.pid) return
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/T', '/F', '/PID', String(pid)], { windowsHide: true, stdio: 'ignore' })
    return
  }
  try {
    process.kill(-pid, signal)
  } catch {
    signalProcess(pid, signal)
  }
}

export async function terminateTree(pid: number): Promise<void> {
  signalTree(pid, 'SIGTERM')
  if (await waitUntil(3, 0.05, () => !isAlive(pid))) return
  signalTree(pid, 'SIGKILL')
  await waitUntil(1, 0.05, () => !isAlive(pid))
}
