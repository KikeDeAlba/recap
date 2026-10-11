import { readdirSync } from 'node:fs'
import path from 'node:path'
import { agents } from '@kikedealba/kit'
import type { PlatformContext } from '@kikedealba/kit/platform'
import { defineManifest, isInstalled, readManifest, registerTool, type ToolManifest } from '@kikedealba/kit/registry'
import { bitaCommand } from '../bita/client.ts'
import type { Config } from '../core/config.ts'
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

export const MAIN_SKILL = 'recap'

export const CLAUDE_PLUGIN: agents.ClaudePluginSpec = { marketplace: 'KikeDeAlba/recap', marketplaceName: 'recap', plugin: 'recap' }

export function userSkillSources(): agents.SkillSource[] {
  const dir = path.join(PACKAGE_ROOT, 'skills')
  let names: string[] = []
  try {
    names = readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && entry.name.startsWith(`${MAIN_SKILL}-`))
      .map((entry) => entry.name)
      .sort()
  } catch {
    return []
  }
  return names.map((name) => ({ name, dir: path.join(dir, name) }))
}

export function integration(): agents.AgentIntegration {
  return {
    tool: 'recap',
    version: VERSION,
    description: 'Record meetings and turn them into minutes with recap',
    skills: [{ name: MAIN_SKILL, dir: path.join(PACKAGE_ROOT, 'skills', MAIN_SKILL) }],
    userSkills: userSkillSources(),
    claude: {
      permissions: {
        allow: ['Bash(recap status:*)', 'Bash(recap list:*)', 'Bash(recap show:*)', 'Bash(recap wait:*)', 'Bash(recap prompt:*)', 'Bash(recap --version)'],
      },
    },
  }
}

export function legacyClaudeIntegration(): agents.AgentIntegration {
  const { claude: _permissions, ...base } = integration()
  return { ...base, commands: (base.userSkills ?? []).map((skill) => ({ name: skill.name, file: path.join(skill.dir, 'SKILL.md') })) }
}

export function parseAgents(raw: string | undefined): agents.AgentName[] | 'detected' | 'all' | 'none' {
  if (raw === undefined || raw === 'detected') return 'detected'
  if (raw === 'all' || raw === 'none') return raw
  const wanted = raw.split(',').map((item) => item.trim()).filter((item) => item.length > 0)
  const invalid = wanted.filter((item) => !(agents.AGENTS as readonly string[]).includes(item))
  if (invalid.length > 0) throw new Error(`Unknown agent ${invalid.join(', ')}; use ${agents.AGENTS.join(', ')}, detected, all or none`)
  return wanted as agents.AgentName[]
}

export async function installAgents(choice: agents.AgentName[] | 'detected' | 'all' | 'none', options: agents.InstallOptions = {}): Promise<agents.Step[]> {
  if (choice === 'none') return []
  const list: agents.AgentName[] = choice === 'detected' ? await agents.detectAgents(options.ctx, agents.agentHomes(options.ctx, options.homes), options.locate) : choice === 'all' ? [...agents.AGENTS] : choice
  const steps: agents.Step[] = []
  if (list.includes('claude')) {
    const plugin = await agents.installClaudePlugin(CLAUDE_PLUGIN, options)
    steps.push(...plugin)
    if (plugin.every((step) => step.state === 'installed' || step.state === 'present')) steps.push(...(await agents.removeLegacyClaude(legacyClaudeIntegration(), options)))
  }
  const others = list.filter((agent) => agent !== 'claude')
  if (others.length === 0) return steps
  return [...steps, ...(await agents.installIntegration(integration(), { ...options, agents: others }))]
}
