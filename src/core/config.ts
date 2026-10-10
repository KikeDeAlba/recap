import path from 'node:path'
import { RecapError, errorMessage } from '../errors.ts'
import { readText, writeAtomic, exists } from './fsutil.ts'
import { isRecord, swiftPretty } from './json.ts'
import { liveSettings, type LiveConfig, type LiveSettings } from './live-settings.ts'
import { configFile, expandTilde, modelsDir } from './paths.ts'

export interface Config {
  root?: string | undefined
  language?: string | undefined
  whisperModel?: string | undefined
  summaryModel?: string | undefined
  vocabulary?: string[] | undefined
  tools?: Record<string, string> | undefined
  live?: LiveConfig | undefined
  [key: string]: unknown
}

export const MODELS = {
  whisper: {
    fileName: 'ggml-large-v3-turbo.bin',
    url: 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3-turbo.bin',
  },
  vad: {
    fileName: 'ggml-silero-v5.1.2.bin',
    url: 'https://huggingface.co/ggml-org/whisper-vad/resolve/main/ggml-silero-v5.1.2.bin',
  },
} as const

function checkString(config: Record<string, unknown>, key: string): void {
  if (config[key] !== undefined && config[key] !== null && typeof config[key] !== 'string') throw new Error(`${key} must be a string`)
}

export function parseConfig(text: string): Config {
  const value = JSON.parse(text) as unknown
  if (!isRecord(value)) throw new Error('the configuration must be a JSON object')
  for (const key of ['root', 'language', 'whisperModel', 'summaryModel']) checkString(value, key)
  if (value['vocabulary'] !== undefined && value['vocabulary'] !== null) {
    if (!Array.isArray(value['vocabulary']) || !value['vocabulary'].every((item) => typeof item === 'string')) throw new Error('vocabulary must be a list of strings')
  }
  if (value['tools'] !== undefined && value['tools'] !== null) {
    if (!isRecord(value['tools']) || !Object.values(value['tools']).every((item) => typeof item === 'string')) throw new Error('tools must map names to paths')
  }
  if (value['live'] !== undefined && value['live'] !== null && !isRecord(value['live'])) throw new Error('live must be an object')
  const cleaned: Config = {}
  for (const [key, item] of Object.entries(value)) if (item !== null) cleaned[key] = item
  return cleaned
}

export function loadConfig(): Config {
  const file = configFile()
  if (!exists(file)) return {}
  const text = readText(file)
  if (text === null) throw new RecapError('CONFIG_INVALID', `Cannot read ${file}`)
  try {
    return parseConfig(text)
  } catch (error) {
    throw new RecapError('CONFIG_INVALID', `Cannot read ${file}: ${errorMessage(error)}`)
  }
}

export function saveConfig(config: Config): void {
  writeAtomic(configFile(), swiftPretty(config))
}

export function rootDir(config: Config): string {
  const override = process.env['RECAP_ROOT']
  if (override) return expandTilde(override)
  return expandTilde(config.root ?? '~/Recap')
}

export function transcriptionLanguage(config: Config): string {
  return config.language ?? 'es'
}

export function whisperModelPath(config: Config): string {
  return config.whisperModel ? expandTilde(config.whisperModel) : path.join(modelsDir(), MODELS.whisper.fileName)
}

export function vadModelPath(): string {
  return path.join(modelsDir(), MODELS.vad.fileName)
}

export function settingsOf(config: Config): LiveSettings {
  return liveSettings(config.live)
}
