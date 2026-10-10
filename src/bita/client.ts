import path from 'node:path'
import { findTool, invokeTool, type FoundTool } from '@kikedealba/kit/registry'
import { parseEnvelope } from '@kikedealba/kit/envelope'
import type { Config } from '../core/config.ts'
import { isRecord } from '../core/json.ts'
import type { BitaTarget, Meeting } from '../core/meeting.ts'
import { home } from '../core/paths.ts'
import { exec } from '../core/proc.ts'
import { suffix, trimmed } from '../core/text.ts'
import { locateTool, toolEnvironment } from '../core/tools.ts'
import { RecapError, errorMessage } from '../errors.ts'

export interface BitaResponse {
  ok: boolean
  data?: unknown
  meta?: Record<string, unknown> | undefined
  errorCode?: string | undefined
  errorMessage?: string | undefined
}

export interface BitaCalling {
  invoke(args: readonly string[]): Promise<BitaResponse>
}

export function parseResponse(stdout: string, stderr: string, status: number): BitaResponse {
  const envelope = parseEnvelope(stdout) as Record<string, unknown> | null
  const error = isRecord(envelope?.['error']) ? envelope['error'] : undefined
  const ok = status === 0 && envelope?.['ok'] === true
  return {
    ok,
    data: envelope?.['data'],
    meta: isRecord(envelope?.['meta']) ? envelope['meta'] : undefined,
    errorCode: typeof error?.['code'] === 'string' ? error['code'] : undefined,
    errorMessage: typeof error?.['message'] === 'string' ? error['message'] : ok ? undefined : suffix(trimmed(stdout + stderr), 300),
  }
}

export async function callBita(bita: BitaCalling, args: readonly string[]): Promise<unknown> {
  const response = await bita.invoke(args)
  if (!response.ok) throw new RecapError('BITA_FAILED', `bita ${args.slice(0, 3).join(' ')} failed: ${response.errorMessage ?? 'no reason given'}`)
  return response.data
}

export const QUIET_ENV = { BITA_NO_HOOKS: '1', KIT_NO_EVENTS: '1' }

export function neutralCwd(): string {
  return path.parse(home()).root || '/'
}

export async function bitaCommand(config: Config): Promise<string[] | null> {
  const registered = await findTool('bita').catch(() => null)
  if (registered) return registered.bin
  const located = await locateTool('bita', config)
  return located ? [located] : null
}

export class BitaClient implements BitaCalling {
  readonly command: string[]
  readonly config: Config
  readonly target: BitaTarget

  constructor(command: string[], config: Config, target: BitaTarget) {
    this.command = command
    this.config = config
    this.target = target
  }

  static async create(config: Config, target: BitaTarget): Promise<BitaClient | null> {
    const command = await bitaCommand(config)
    return command ? new BitaClient(command, config, target) : null
  }

  targetArgs(): string[] {
    const args: string[] = []
    if (this.target.databasePath) args.push('--db-path', this.target.databasePath)
    if (this.target.docsRoot) args.push('--docs-dir', this.target.docsRoot)
    return args
  }

  async run(args: readonly string[]): Promise<{ status: number; stdout: string; stderr: string }> {
    const [executable, ...prefix] = this.command
    if (!executable) throw new RecapError('DEPENDENCY_MISSING', 'bita not found')
    const env = { ...toolEnvironment(executable, this.config), ...QUIET_ENV }
    return exec(executable, [...prefix, ...args], { env, cwd: neutralCwd() })
  }

  async invoke(args: readonly string[]): Promise<BitaResponse> {
    const result = await this.run([...args, '--json', ...this.targetArgs()])
    return parseResponse(result.stdout, result.stderr, result.status)
  }
}

export function inkwellArguments(args: readonly string[]): string[] | null {
  if (args[0] === 'backlog') return [...args]
  if (args[0] !== 'docs') return null
  if (args[1] === 'propose') return ['git', 'propose', ...args.slice(2)]
  return args.slice(1)
}

let inkwellCache: Promise<FoundTool | null> | null = null

export function resetInkwellCache(): void {
  inkwellCache = null
}

async function discoverInkwell(): Promise<FoundTool | null> {
  if (process.env['RECAP_NO_INKWELL'] === '1') return null
  const tool = await findTool('inkwell', { capability: 'docs.page.write' }).catch(() => null)
  if (!tool) return null
  try {
    const { envelope } = await invokeTool<{ migrated?: boolean }>(tool, ['migrate', 'status'], { env: { ...process.env, ...QUIET_ENV }, timeoutMs: 20_000 })
    return envelope.ok && envelope.data?.migrated === true ? tool : null
  } catch {
    return null
  }
}

export function findInkwell(): Promise<FoundTool | null> {
  inkwellCache ??= discoverInkwell()
  return inkwellCache
}

export class InkwellClient implements BitaCalling {
  readonly tool: FoundTool

  constructor(tool: FoundTool) {
    this.tool = tool
  }

  async invoke(args: readonly string[]): Promise<BitaResponse> {
    try {
      const { envelope } = await invokeTool(this.tool, args, { env: { ...process.env, ...QUIET_ENV }, cwd: neutralCwd(), timeoutMs: 300_000 })
      return {
        ok: envelope.ok,
        data: envelope.data,
        meta: envelope.meta,
        errorCode: envelope.error?.code,
        errorMessage: envelope.error?.message,
      }
    } catch (error) {
      return { ok: false, errorCode: 'INKWELL_FAILED', errorMessage: errorMessage(error) }
    }
  }
}

export class DocsRouter implements BitaCalling {
  readonly bita: BitaCalling | null
  readonly inkwell: BitaCalling | null

  constructor(bita: BitaCalling | null, inkwell: BitaCalling | null) {
    this.bita = bita
    this.inkwell = inkwell
  }

  async invoke(args: readonly string[]): Promise<BitaResponse> {
    const mapped = this.inkwell ? inkwellArguments(args) : null
    if (mapped && this.inkwell) return this.inkwell.invoke(mapped)
    if (this.bita) return this.bita.invoke(args)
    return { ok: false, errorCode: 'DEPENDENCY_MISSING', errorMessage: 'bita not found' }
  }
}

export function meetingTarget(meeting: Meeting): BitaTarget {
  return { databasePath: meeting.bitaDatabasePath, docsRoot: meeting.bitaDocsRoot }
}

export async function docsClient(config: Config, target: BitaTarget): Promise<DocsRouter | null> {
  const bita = await BitaClient.create(config, target)
  const inkwell = await findInkwell()
  if (!bita && !inkwell) return null
  return new DocsRouter(bita, inkwell ? new InkwellClient(inkwell) : null)
}

export async function requireBita(config: Config, target: BitaTarget): Promise<BitaClient> {
  const client = await BitaClient.create(config, target)
  if (!client) throw new RecapError('DEPENDENCY_MISSING', 'bita not found. Install it with `npm install -g @kikedealba/bita`', { hint: 'npm install -g @kikedealba/bita' })
  return client
}
