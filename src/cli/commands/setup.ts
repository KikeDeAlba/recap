import { existsSync } from 'node:fs'
import { release } from 'node:os'
import { MODELS, loadConfig, rootDir, saveConfig, vadModelPath, whisperModelPath } from '../../core/config.ts'
import { padEnd } from '../../core/text.ts'
import { CHECKED_TOOLS, configuredPath, installHint, locateTool } from '../../core/tools.ts'
import { errorMessage, usageError } from '../../errors.ts'
import { BitaClient } from '../../bita/client.ts'
import { capturePermissions, findCapture, findRecapApp } from '../../capture/capture.ts'
import { download, installMissing, installRecapApp } from '../../setup/deps.ts'
import { installAgents, parseAgents, register } from '../../setup/integration.ts'
import { removeLegacyHook } from '../../setup/legacy.ts'
import { parseArgs } from '../args.ts'
import { output, stderrLine } from '../output.ts'

interface Check {
  name: string
  ok: boolean
  detail: string
}

export async function setupCommand(argv: string[]): Promise<number> {
  const json = argv.includes('--json')
  return output('setup', json, async () => {
    const args = parseArgs(argv, {
      booleans: ['skip-permissions', 'skip-models', 'skip-bita', 'install-deps', 'skip-app', 'skip-agents'],
      values: ['agents'],
      maxPositionals: 0,
    })
    let agentChoice: ReturnType<typeof parseAgents>
    try {
      agentChoice = args.has('skip-agents') ? 'none' : parseAgents(args.value('agents'))
    } catch (error) {
      throw usageError(errorMessage(error))
    }
    const progress = (line: string) => {
      if (!json) stderrLine(line)
    }
    const checks: Check[] = []
    checks.push({ name: 'platform', ok: true, detail: `${process.platform} ${release()} ${process.arch}` })
    const config = loadConfig()
    if (args.has('install-deps')) {
      const report = await installMissing(config, progress)
      for (const item of report.manual) checks.push({ name: 'install', ok: false, detail: item })
    }
    const tools = { ...(config.tools ?? {}) }
    for (const tool of CHECKED_TOOLS) {
      const found = await locateTool(tool, config)
      const optional = tool === 'bita'
      checks.push({ name: tool, ok: found !== null || optional, detail: found ?? `${optional ? 'optional, ' : ''}missing: ${installHint(tool)}` })
      if (found && configuredPath(tool, config) === undefined) tools[tool] = found
    }
    if (JSON.stringify(tools) !== JSON.stringify(config.tools ?? {})) {
      config.tools = tools
      saveConfig(config)
    }

    if (process.platform === 'darwin' && !findRecapApp() && !args.has('skip-app')) {
      try {
        progress('Installing Recap.app (the recorder)...')
        await installRecapApp(progress)
      } catch (error) {
        checks.push({ name: 'app', ok: false, detail: `could not install Recap.app: ${errorMessage(error)}` })
      }
    }
    const capture = await findCapture()
    checks.push({
      name: 'capture',
      ok: capture !== null || process.platform !== 'darwin',
      detail: capture
        ? capture.kind === 'app'
          ? capture.app
          : capture.binary
        : process.platform === 'darwin'
          ? 'Recap.app is missing; run `recap setup` without --skip-app'
          : 'recording is not available on this system; use `recap import <file>`',
    })
    checks.push({ name: 'root', ok: true, detail: rootDir(config) })

    for (const [name, model, target] of [
      ['whisper', MODELS.whisper, whisperModelPath(config)],
      ['vad', MODELS.vad, vadModelPath()],
    ] as const) {
      if (!existsSync(target) && !args.has('skip-models')) {
        try {
          await download(model.url, target, progress)
        } catch (error) {
          checks.push({ name: `download:${name}`, ok: false, detail: errorMessage(error) })
        }
      }
      const present = existsSync(target)
      checks.push({ name: `model:${name}`, ok: present, detail: present ? target : 'missing: run `recap setup` without --skip-models' })
    }

    const bita = args.has('skip-bita') ? null : await BitaClient.create(config, {})
    const subscribe = capture !== null && bita !== null
    try {
      const file = await register(capture !== null, subscribe)
      checks.push({ name: 'registry', ok: true, detail: file })
    } catch (error) {
      checks.push({ name: 'registry', ok: false, detail: errorMessage(error) })
    }
    if (bita) {
      const removed = await removeLegacyHook(bita)
      checks.push({
        name: 'bita-hook',
        ok: subscribe,
        detail: subscribe
          ? `subscribed to bita events through the kit registry${removed > 0 ? `; removed ${removed} old bita hook${removed === 1 ? '' : 's'}` : ''}`
          : 'not subscribed: recording is not available here',
      })
    }

    for (const step of await installAgents(agentChoice)) {
      checks.push({ name: `agent:${step.agent}`, ok: step.state !== 'failed', detail: `${step.item}: ${step.detail}` })
    }

    if (capture) {
      try {
        const report = await capturePermissions(capture, !args.has('skip-permissions'))
        const rerun = args.has('skip-permissions') ? '; run `recap setup` in a terminal to grant it' : ''
        checks.push({ name: 'microphone', ok: report.microphone === 'granted', detail: report.microphone === 'granted' ? 'granted' : `${report.microphone}${rerun}` })
        checks.push({
          name: 'screen',
          ok: report.screen === 'granted',
          detail:
            report.screen === 'granted'
              ? 'granted'
              : `${report.screen}: enable Recap in System Settings > Privacy & Security > Screen & System Audio Recording (only needed for --remote)${rerun}`,
        })
      } catch (error) {
        checks.push({ name: 'permissions', ok: false, detail: errorMessage(error) })
      }
    }
    const text = checks.map((check) => `${check.ok ? 'ok ' : '!! '} ${padEnd(check.name, 14)} ${check.detail}`).join('\n')
    return { data: checks, text }
  })
}

