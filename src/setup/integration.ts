import { readdirSync } from 'node:fs'
import path from 'node:path'
import { agents } from '@kikedealba/kit'
import type { PlatformContext } from '@kikedealba/kit/platform'
import { defineManifest, isInstalled, readManifest, registerTool, type ToolManifest } from '@kikedealba/kit/registry'
import { bitaCommand } from '../bita/client.ts'
import type { Config } from '../core/config.ts'
import { readText } from '../core/fsutil.ts'
import { isRecord } from '../core/json.ts'
import { home } from '../core/paths.ts'
import { stableCommand } from '../core/self.ts'
import { HOOK_EVENTS, MEETING_KINDS } from '../bita/hook.ts'
import { PACKAGE_ROOT, VERSION } from '../version.ts'

export const INSTALL_HINT = 'npm install -g @kikedealba/recap && recap setup'

export const BASE_CAPABILITIES = ['meeting.process', 'meeting.import', 'meeting.minutes', 'meeting.ask', 'meeting.live', 'meeting.media']

export function capabilities(captureAvailable: boolean): string[] {
  return captureAvailable ? ['meeting.record', ...BASE_CAPABILITIES] : [...BASE_CAPABILITIES]
}

function subscription(bin: readonly string[]): ToolManifest['subscribes'][number] {
  return {
    tool: 'bita',
    events: [...HOOK_EVENTS],
    filter: { kind: Object.keys(MEETING_KINDS).sort() },
    command: [...bin, 'bita-hook'],
  }
}

export async function bitaSubscription(ctx?: PlatformContext): Promise<ToolManifest['subscribes'][number]> {
  return subscription(await stableCommand(ctx))
}

export async function manifest(captureAvailable: boolean, subscribe = captureAvailable, ctx?: PlatformContext): Promise<ToolManifest> {
  const bin = await stableCommand(ctx)
  return defineManifest({
    name: 'recap',
    version: VERSION,
    description: 'Meeting recorder: local transcription, minutes, live answers',
    bin,
    capabilities: capabilities(captureAvailable),
    subscribes: subscribe ? [subscription(bin)] : [],
    homepage: 'https://github.com/KikeDeAlba/recap',
    install: INSTALL_HINT,
  })
}

export async function register(captureAvailable: boolean, subscribe = captureAvailable): Promise<string> {
  return registerTool(await manifest(captureAvailable, subscribe))
}

export async function bitaLinked(config: Config): Promise<boolean> {
  const own = await readManifest('recap').catch(() => null)
  if (!own || !isInstalled(own) || !own.subscribes.some((subscription) => subscription.tool === 'bita')) return false
  return (await bitaCommand(config)) !== null
}

export function commandSources(): agents.CommandSource[] {
  const dir = path.join(PACKAGE_ROOT, 'commands')
  let names: string[] = []
  try {
    names = readdirSync(dir).filter((name) => name.endsWith('.md')).sort()
  } catch {
    return []
  }
  return names.map((name) => ({ name: name.slice(0, -3), file: path.join(dir, name) }))
}

export function integration(): agents.AgentIntegration {
  return {
    tool: 'recap',
    version: VERSION,
    description: 'Record meetings and turn them into minutes with recap',
    skills: [{ name: 'recap', dir: path.join(PACKAGE_ROOT, 'skills', 'recap') }],
    commands: commandSources(),
    claude: {
      permissions: {
        allow: ['Bash(recap status:*)', 'Bash(recap list:*)', 'Bash(recap show:*)', 'Bash(recap wait:*)', 'Bash(recap prompt:*)', 'Bash(recap --version)'],
      },
    },
  }
}

export function claudePluginInstalled(): boolean {
  const claudeHome = process.env['CLAUDE_CONFIG_DIR'] ?? path.join(home(), '.claude')
  const text = readText(path.join(claudeHome, 'plugins', 'installed_plugins.json'))
  if (text === null) return false
  try {
    const value = JSON.parse(text) as unknown
    const plugins = isRecord(value) && isRecord(value['plugins']) ? value['plugins'] : isRecord(value) ? value : {}
    return Object.keys(plugins).some((key) => key.startsWith('recap@'))
  } catch {
    return text.includes('"recap@')
  }
}

export function parseAgents(raw: string | undefined): agents.AgentName[] | 'detected' | 'all' | 'none' {
  if (raw === undefined || raw === 'detected') return 'detected'
  if (raw === 'all' || raw === 'none') return raw
  const wanted = raw.split(',').map((item) => item.trim()).filter((item) => item.length > 0)
  const invalid = wanted.filter((item) => !(agents.AGENTS as readonly string[]).includes(item))
  if (invalid.length > 0) throw new Error(`Unknown agent ${invalid.join(', ')}; use ${agents.AGENTS.join(', ')}, detected, all or none`)
  return wanted as agents.AgentName[]
}

export async function installAgents(choice: agents.AgentName[] | 'detected' | 'all' | 'none', exec?: (command: string, args: readonly string[]) => Promise<void>): Promise<agents.Step[]> {
  if (choice === 'none') return []
  let list: agents.AgentName[] = choice === 'detected' ? await agents.detectAgents() : choice === 'all' ? [...agents.AGENTS] : choice
  const steps: agents.Step[] = []
  if (list.includes('claude') && claudePluginInstalled()) {
    list = list.filter((agent) => agent !== 'claude')
    steps.push({ agent: 'claude', item: 'integration', state: 'present', detail: 'the recap plugin for Claude Code is installed; it already carries the skill and commands' })
  }
  if (list.length === 0) return steps
  return [...steps, ...(await agents.installIntegration(integration(), { agents: list, ...(exec ? { exec } : {}) }))]
}
