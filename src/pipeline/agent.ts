import { agents } from '@kikedealba/kit'
import type { Config } from '../core/config.ts'
import { home } from '../core/paths.ts'
import { exec, type ExecResult } from '../core/proc.ts'
import { suffix, trimmed } from '../core/text.ts'
import { configuredAgent, installHint, liveAgent, locateTool, toolEnvironment } from '../core/tools.ts'
import { RecapError } from '../errors.ts'

export type HeadlessAgent = agents.HeadlessAgent
export type AgentScope = 'pipeline' | 'live'
export type HeadlessRunner = (options: agents.HeadlessOptions) => Promise<agents.HeadlessResult>
export type AgentPicker = (preferred: HeadlessAgent) => Promise<{ agent: HeadlessAgent; bin: string; fallback: boolean } | null>

export interface AgentChoice {
  agent: HeadlessAgent
  bin: string
  preferred: HeadlessAgent
  fallback: boolean
}

export interface AgentDependencies {
  runner?: HeadlessRunner | undefined
  pick?: AgentPicker | undefined
  warn?: ((line: string) => void) | undefined
}

export const ISOLATION = ['--setting-sources', 'project', '--strict-mcp-config', '--no-session-persistence', '--disable-slash-commands']

export function claudeOptions(tools: readonly string[], addDirs: readonly string[], model: string | null | undefined, restrictTools?: readonly string[] | null): string[] {
  const args = [...ISOLATION]
  if (restrictTools) args.push('--tools', restrictTools.join(','))
  const allowed = trimmed(tools.join(' '))
  if (allowed.length > 0) args.push('--allowedTools', allowed)
  const seen = new Set<string>()
  for (const dir of addDirs) {
    if (seen.has(dir)) continue
    seen.add(dir)
    args.push('--add-dir', dir)
  }
  if (model) args.push('--model', model)
  return args
}

export function streamArguments(tools: readonly string[], addDirs: readonly string[], model: string | null | undefined, restrictTools?: readonly string[] | null): string[] {
  return ['-p', '--output-format', 'stream-json', '--verbose', '--include-partial-messages', ...claudeOptions(tools, addDirs, model, restrictTools)]
}

export function preferredAgent(config: Config, scope: AgentScope): HeadlessAgent {
  return scope === 'live' ? liveAgent(config) : configuredAgent(config)
}

export function fallbackWarning(choice: AgentChoice): string {
  return `${choice.preferred} is not installed; using ${choice.agent} instead`
}

function defaultWarn(line: string): void {
  process.stderr.write(`${line}\n`)
}

export async function resolveAgent(config: Config, scope: AgentScope, dependencies: AgentDependencies = {}): Promise<AgentChoice> {
  const preferred = preferredAgent(config, scope)
  const located = dependencies.pick ? null : await locateTool(preferred, config)
  if (located) return { agent: preferred, bin: located, preferred, fallback: false }
  const picked = await (dependencies.pick ?? ((wanted: HeadlessAgent) => agents.pickHeadlessAgent(wanted)))(preferred)
  if (!picked) {
    throw new RecapError('DEPENDENCY_MISSING', `${preferred} not found and no other coding agent is installed. Install it with \`${installHint(preferred)}\``, {
      hint: installHint(preferred),
    })
  }
  const choice = { agent: picked.agent, bin: picked.bin, preferred, fallback: picked.agent !== preferred }
  if (choice.fallback) (dependencies.warn ?? defaultWarn)(fallbackWarning(choice))
  return choice
}

export function agentEnvironment(bin: string, config: Config): NodeJS.ProcessEnv {
  const environment = toolEnvironment(bin, config)
  const picked: NodeJS.ProcessEnv = {}
  for (const key of ['PATH', 'HOME', 'USER', 'LOGNAME']) if (environment[key] !== undefined) picked[key] = environment[key]
  return picked
}

export function agentError(error: unknown, agent: HeadlessAgent): RecapError {
  if (error instanceof RecapError) return error
  if (error instanceof agents.HeadlessError) {
    const code = error.code === 'PARSE' ? 'AGENT_OUTPUT' : error.code === 'UNAVAILABLE' ? 'DEPENDENCY_MISSING' : 'AGENT_FAILED'
    return new RecapError(code, `${agent}: ${suffix(trimmed(error.message), 500)}`)
  }
  return new RecapError('AGENT_FAILED', `${agent}: ${error instanceof Error ? error.message : String(error)}`)
}

export interface AgentCall {
  prompt: string
  cwd: string
  config: Config
  scope?: AgentScope | undefined
  tools: readonly string[]
  addDirs: readonly string[]
  model: string | null | undefined
  restrictTools?: readonly string[] | null
  dependencies?: AgentDependencies | undefined
}

export async function runAgent(call: AgentCall): Promise<string> {
  const choice = await resolveAgent(call.config, call.scope ?? 'pipeline', call.dependencies)
  const claude = choice.agent === 'claude'
  const options: agents.HeadlessOptions = {
    agent: choice.agent,
    bin: choice.bin,
    prompt: call.prompt,
    cwd: call.cwd,
    access: 'read',
    env: agentEnvironment(choice.bin, call.config),
    ...(claude ? { extraArgs: claudeOptions(call.tools, call.addDirs, call.model, call.restrictTools) } : {}),
  }
  const runner = call.dependencies?.runner ?? agents.runHeadless
  let text: string
  try {
    text = (await runner(options)).text
  } catch (error) {
    throw agentError(error, choice.agent)
  }
  if (trimmed(text).length === 0) throw new RecapError('AGENT_FAILED', `${choice.agent} returned an empty answer`)
  return text
}

export function runSummaryAgent(prompt: string, dir: string, config: Config, dependencies?: AgentDependencies): Promise<string> {
  return runAgent({ prompt, cwd: dir, config, tools: ['Read'], addDirs: [dir], model: config.summaryModel, dependencies })
}

export function runReadAgent(prompt: string, dirs: readonly string[], config: Config, dependencies?: AgentDependencies): Promise<string> {
  return runAgent({ prompt, cwd: dirs[dirs.length - 1] ?? home(), config, tools: ['Read Grep Glob'], addDirs: dirs, model: config.summaryModel, dependencies })
}

export async function streamClaude(
  prompt: string,
  cwd: string,
  bin: string,
  config: Config,
  args: readonly string[],
  onLine: (line: string) => void,
  onSpawn?: (pid: number) => void,
): Promise<ExecResult> {
  let buffer = ''
  const result = await exec(bin, args, {
    input: prompt,
    env: { ...toolEnvironment(bin, config), KIT_HEADLESS: '1' },
    cwd,
    detached: process.platform !== 'win32',
    ...(onSpawn ? { onSpawn } : {}),
    onStdout: (chunk) => {
      buffer += chunk
      let newline = buffer.indexOf('\n')
      while (newline !== -1) {
        const line = buffer.slice(0, newline)
        buffer = buffer.slice(newline + 1)
        if (line.length > 0) onLine(line)
        newline = buffer.indexOf('\n')
      }
    },
  })
  if (buffer.length > 0) onLine(buffer)
  return result
}
