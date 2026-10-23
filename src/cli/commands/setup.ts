import { existsSync } from 'node:fs'
import { release } from 'node:os'
import { MODELS, loadConfig, rootDir, saveConfig, vadModelPath, whisperModelPath } from '../../core/config.ts'
import { padEnd } from '../../core/text.ts'
import { CHECKED_TOOLS, configuredPath, installHint, locateTool } from '../../core/tools.ts'
import { errorMessage, usageError } from '../../errors.ts'
import { BitaClient } from '../../bita/client.ts'
import { platformContext } from '@kikedealba/kit/platform'
import { findCapture, findRecapApp } from '../../capture/capture.ts'
import { selectRecorder } from '../../capture/recorder.ts'
import { loopbackPath } from '../../capture/sources.ts'
import { home } from '../../core/paths.ts'
import { installLoopback } from '../../setup/loopback.ts'
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
    const ctx = platformContext({ home: home() })
    const recorder = selectRecorder(ctx, config)
    if (recorder.kind === 'windows' && !existsSync(loopbackPath(ctx)) && !args.has('skip-app')) {
      try {
        progress('Installing recap-loopback (the Windows audio capture helper)...')
        await installLoopback(ctx, progress)
      } catch (error) {
        checks.push({ name: 'loopback', ok: false, detail: `could not install recap-loopback: ${errorMessage(error)}` })
      }
    }
    const readiness = await recorder.check()
    const capture = readiness.ok
    const launcher = recorder.kind === 'mac-app' ? await findCapture() : null
    checks.push({
      name: 'capture',
      ok: capture || recorder.kind !== 'mac-app',
      detail: launcher
        ? launcher.kind === 'app'
          ? launcher.app
          : launcher.binary
        : capture
          ? recorder.kind === 'windows'
            ? `ffmpeg and ${loopbackPath(ctx)}`
            : 'ffmpeg with PulseAudio input and pactl'
          : recorder.kind === 'mac-app'
            ? 'Recap.app is missing; run `recap setup` without --skip-app'
            : `optional, recording is off until you install ${readiness.missing.join(', ')}: ${readiness.hint ?? 'run `recap setup`'}; \`recap import <file>\` works without it`,
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
    const subscribe = capture && bita !== null
    try {
      const file = await register(capture, subscribe)
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

    if (capture && recorder.kind === 'mac-app') {
      try {
        const report = await recorder.permissions(!args.has('skip-permissions'))
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

