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

export interface ToolResponse {
  ok: boolean
  data?: unknown
  meta?: Record<string, unknown> | undefined
  errorCode?: string | undefined
  errorMessage?: string | undefined
}

export interface ToolCalling {
  invoke(args: readonly string[]): Promise<ToolResponse>
}

export function parseResponse(stdout: string, stderr: string, status: number): ToolResponse {
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

export async function callBita(bita: ToolCalling, args: readonly string[]): Promise<unknown> {
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

export class BitaClient implements ToolCalling {
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
    return args
  }

  async run(args: readonly string[]): Promise<{ status: number; stdout: string; stderr: string }> {
    const [executable, ...prefix] = this.command
    if (!executable) throw new RecapError('DEPENDENCY_MISSING', 'bita not found')
    const env = { ...toolEnvironment(executable, this.config), ...QUIET_ENV }
    return exec(executable, [...prefix, ...args], { env, cwd: neutralCwd() })
  }

  async invoke(args: readonly string[]): Promise<ToolResponse> {
    const result = await this.run([...args, '--json', ...this.targetArgs()])
    return parseResponse(result.stdout, result.stderr, result.status)
  }
}

export const INKWELL_HINT = 'npm i -g @kikedealba/inkwell && inkwell setup'

export const INKWELL_CAPABILITIES = {
  pages: ['docs.page.read'],
  wrapup: ['docs.page.read', 'docs.page.write', 'docs.backlog'],
  proposals: ['docs.page.read', 'docs.propose'],
  notes: ['docs.entry-notes'],
} as const

export type InkwellLookup = { client: InkwellClient; reason?: undefined } | { client: null; reason: string }

export async function lookupInkwell(capabilities: readonly string[] = []): Promise<InkwellLookup> {
  if (process.env['RECAP_NO_INKWELL'] === '1') return { client: null, reason: 'inkwell is turned off (RECAP_NO_INKWELL=1)' }
  const tool = await findTool('inkwell').catch(() => null)
  if (!tool) return { client: null, reason: 'inkwell is not installed' }
  const missing = capabilities.filter((capability) => !tool.manifest.capabilities.includes(capability))
  if (missing.length > 0) return { client: null, reason: `inkwell ${tool.manifest.version} lacks ${missing.join(', ')}` }
  return { client: new InkwellClient(tool) }
}

export async function findInkwell(capabilities: readonly string[] = []): Promise<InkwellClient | null> {
  return (await lookupInkwell(capabilities)).client
}

export async function requireInkwell(capabilities: readonly string[], purpose: string): Promise<InkwellClient> {
  const found = await lookupInkwell(capabilities)
  if (found.client) return found.client
  throw new RecapError('DEPENDENCY_MISSING', `${purpose} needs inkwell: ${found.reason}`, { hint: INKWELL_HINT })
}

export class StageSkipped extends RecapError {
  constructor(message: string, hint?: string) {
    super('STAGE_SKIPPED', message, hint === undefined ? {} : { hint })
  }
}

export async function inkwellForStage(capabilities: readonly string[]): Promise<InkwellClient> {
  const found = await lookupInkwell(capabilities)
  if (found.client) return found.client
  throw new StageSkipped(found.reason, INKWELL_HINT)
}

export async function callInkwell(inkwell: ToolCalling, args: readonly string[]): Promise<unknown> {
  const response = await inkwell.invoke(args)
  if (!response.ok) throw new RecapError('INKWELL_FAILED', `inkwell ${args.slice(0, 2).join(' ')} failed: ${response.errorMessage ?? 'no reason given'}`)
  return response.data
}

export class InkwellClient implements ToolCalling {
  readonly tool: FoundTool

  constructor(tool: FoundTool) {
    this.tool = tool
  }

  async invoke(args: readonly string[]): Promise<ToolResponse> {
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

export function meetingTarget(meeting: Meeting): BitaTarget {
  return { databasePath: meeting.bitaDatabasePath, docsRoot: meeting.bitaDocsRoot }
}

export async function requireBita(config: Config, target: BitaTarget): Promise<BitaClient> {
  const client = await BitaClient.create(config, target)
  if (!client) throw new RecapError('DEPENDENCY_MISSING', 'bita not found. Install it with `npm install -g @kikedealba/bita`', { hint: 'npm install -g @kikedealba/bita' })
  return client
}
