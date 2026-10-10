import { constants, accessSync, statSync } from 'node:fs'
import { userInfo } from 'node:os'
import path from 'node:path'
import { childEnvironment, platformContext, which } from '@kikedealba/kit/platform'
import { RecapError } from '../errors.ts'
import type { Config } from './config.ts'
import { configFile, expandTilde, home } from './paths.ts'

export type ToolName = 'ffmpeg' | 'ffprobe' | 'whisper-cli' | 'claude' | 'bita'

export const CHECKED_TOOLS: ToolName[] = ['ffmpeg', 'whisper-cli', 'claude', 'bita']

export function installHint(tool: ToolName, platform: NodeJS.Platform = process.platform): string {
  switch (tool) {
    case 'ffmpeg':
    case 'ffprobe':
      return platform === 'darwin' ? 'brew install ffmpeg' : platform === 'win32' ? 'winget install Gyan.FFmpeg' : 'sudo apt install ffmpeg'
    case 'whisper-cli':
      return platform === 'darwin'
        ? 'brew install whisper-cpp'
        : platform === 'win32'
          ? 'download whisper-bin-x64.zip from https://github.com/ggml-org/whisper.cpp/releases and put whisper-cli.exe on PATH'
          : 'brew install whisper-cpp (Homebrew on Linux) or build whisper.cpp from https://github.com/ggml-org/whisper.cpp'
    case 'claude':
      return 'npm install -g @anthropic-ai/claude-code'
    case 'bita':
      return 'npm install -g @kikedealba/bita'
  }
}

function isExecutable(file: string): boolean {
  try {
    if (!statSync(file).isFile()) return false
    if (process.platform === 'win32') return true
    accessSync(file, constants.X_OK)
    return true
  } catch {
    return false
  }
}

export function configuredPath(tool: ToolName, config: Config): string | undefined {
  return config.tools?.[tool]
}

function toolDirs(config: Config): string[] {
  return Object.values(config.tools ?? {}).map((value) => path.dirname(expandTilde(value)))
}

function ctx() {
  return platformContext({ home: home() })
}

export async function locateTool(tool: ToolName, config: Config): Promise<string | null> {
  const configured = configuredPath(tool, config)
  if (configured) {
    const file = expandTilde(configured)
    if (isExecutable(file)) return file
  }
  if (tool === 'ffprobe') {
    const ffmpeg = config.tools?.['ffmpeg']
    if (ffmpeg) {
      const sibling = path.join(path.dirname(expandTilde(ffmpeg)), process.platform === 'win32' ? 'ffprobe.exe' : 'ffprobe')
      if (isExecutable(sibling)) return sibling
    }
  }
  return which(tool, ctx(), toolDirs(config))
}

export async function requireTool(tool: ToolName, config: Config): Promise<string> {
  const found = await locateTool(tool, config)
  if (!found) {
    throw new RecapError('DEPENDENCY_MISSING', `${tool} not found. Install it with \`${installHint(tool)}\` or set tools.${tool} in ${configFile()}`, {
      hint: installHint(tool),
    })
  }
  return found
}

function currentUser(): string {
  try {
    return userInfo().username
  } catch {
    return ''
  }
}

export function toolEnvironment(executable: string, config: Config, base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const context = platformContext({ env: base, home: home() })
  const environment = childEnvironment(context, [path.dirname(executable), ...toolDirs(config)])
  if (!environment['HOME'] && process.platform !== 'win32') environment['HOME'] = home()
  if (!environment['USER']) environment['USER'] = currentUser()
  if (!environment['LOGNAME']) environment['LOGNAME'] = environment['USER']
  return environment
}
