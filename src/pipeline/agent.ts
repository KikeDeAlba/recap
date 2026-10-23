import type { Config } from '../core/config.ts'
import { isRecord, parseJsonSafe } from '../core/json.ts'
import { exec, type ExecResult } from '../core/proc.ts'
import { prefix, trimmed } from '../core/text.ts'
import { requireTool, toolEnvironment } from '../core/tools.ts'
import { RecapError } from '../errors.ts'

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

export interface ClaudeCall {
  prompt: string
  cwd: string
  config: Config
  tools: readonly string[]
  addDirs: readonly string[]
  model: string | null | undefined
  restrictTools?: readonly string[] | null
}

export async function runClaude(call: ClaudeCall): Promise<string> {
  const claude = await requireTool('claude', call.config)
  const args = ['-p', '--output-format', 'json', ...claudeOptions(call.tools, call.addDirs, call.model, call.restrictTools)]
  const result = await exec(claude, args, { input: call.prompt, env: toolEnvironment(claude, call.config), cwd: call.cwd })
  if (result.status !== 0) throw new RecapError('CLAUDE_FAILED', trimmed(result.stderr.length === 0 ? result.stdout : result.stderr))
  return result.stdout
}

export function runSummaryClaude(prompt: string, dir: string, config: Config): Promise<string> {
  return runClaude({ prompt, cwd: dir, config, tools: ['Read'], addDirs: [dir], model: config.summaryModel })
}

export async function streamClaude(
  prompt: string,
  cwd: string,
  config: Config,
  args: readonly string[],
  onLine: (line: string) => void,
  onSpawn?: (pid: number) => void,
): Promise<ExecResult> {
  const claude = await requireTool('claude', config)
  let buffer = ''
  const result = await exec(claude, args, {
    input: prompt,
    env: toolEnvironment(claude, config),
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

export function resultText(output: string): string {
  const parsed = parseJsonSafe(output)
  if (!isRecord(parsed)) throw new RecapError('CLAUDE_OUTPUT', `Unexpected output from claude: ${prefix(output, 300)}`)
  const result = typeof parsed['result'] === 'string' ? parsed['result'] : undefined
  if (parsed['is_error'] === true || result === undefined || trimmed(result).length === 0) {
    throw new RecapError('CLAUDE_FAILED', result ?? 'claude returned an empty answer')
  }
  return result
}
