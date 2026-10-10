import { RecapError } from '../errors.ts'
import { trimmed } from './text.ts'

export interface LiveConfig {
  enabled?: boolean | undefined
  openWindow?: boolean | undefined
  proposals?: boolean | undefined
  maxChunkSeconds?: number | undefined
  assistModel?: string | undefined
  autoAsk?: boolean | undefined
  autoAskModel?: string | undefined
  autoAskMinSeconds?: number | undefined
  autoAskConcurrency?: number | undefined
  [key: string]: unknown
}

export const RANGES = {
  chunkSeconds: [5, 60],
  autoAskSeconds: [3, 120],
  autoAskConcurrency: [1, 6],
} as const

export const DEFAULTS = {
  maxChunkSeconds: 10,
  autoAskMinSeconds: 5,
  autoAskConcurrency: 3,
  autoAskModel: 'haiku',
} as const

export interface LiveSettings {
  enabled: boolean
  openWindow: boolean
  proposals: boolean
  maxChunkSeconds: number
  assistModel: string | null
  autoAsk: boolean
  autoAskModel: string
  autoAskMinSeconds: number
  autoAskConcurrency: number
}

const clamp = (value: number, [low, high]: readonly [number, number]) => Math.min(Math.max(value, low), high)

function bool(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback
}

function int(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.trunc(value) : fallback
}

function model(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const text = trimmed(value)
  return text.length === 0 ? null : text
}

export function liveSettings(config: LiveConfig | undefined): LiveSettings {
  return {
    enabled: bool(config?.enabled, true),
    openWindow: bool(config?.openWindow, true),
    proposals: bool(config?.proposals, true),
    maxChunkSeconds: clamp(int(config?.maxChunkSeconds, DEFAULTS.maxChunkSeconds), RANGES.chunkSeconds),
    assistModel: model(config?.assistModel),
    autoAsk: bool(config?.autoAsk, true),
    autoAskModel: model(config?.autoAskModel) ?? DEFAULTS.autoAskModel,
    autoAskMinSeconds: clamp(int(config?.autoAskMinSeconds, DEFAULTS.autoAskMinSeconds), RANGES.autoAskSeconds),
    autoAskConcurrency: clamp(int(config?.autoAskConcurrency, DEFAULTS.autoAskConcurrency), RANGES.autoAskConcurrency),
  }
}

export type ConfigValue = boolean | number | string | null

export const CONFIG_KEYS = [
  'live.enabled',
  'live.openWindow',
  'live.proposals',
  'live.assistModel',
  'live.maxChunkSeconds',
  'live.autoAsk',
  'live.autoAskModel',
  'live.autoAskMinSeconds',
  'live.autoAskConcurrency',
] as const

export type ConfigKey = (typeof CONFIG_KEYS)[number]

export function parseConfigKey(raw: string): ConfigKey {
  const found = CONFIG_KEYS.find((key) => key === raw) ?? CONFIG_KEYS.find((key) => key.toLowerCase() === raw.toLowerCase())
  if (!found) throw new RecapError('CONFIG_KEY_UNKNOWN', `Unknown key "${raw}"; use one of ${CONFIG_KEYS.join(', ')}`)
  return found
}

export function configValue(key: ConfigKey, live: LiveConfig | undefined): ConfigValue {
  const settings = liveSettings(live)
  switch (key) {
    case 'live.enabled':
      return settings.enabled
    case 'live.openWindow':
      return settings.openWindow
    case 'live.proposals':
      return settings.proposals
    case 'live.assistModel':
      return settings.assistModel
    case 'live.maxChunkSeconds':
      return settings.maxChunkSeconds
    case 'live.autoAsk':
      return settings.autoAsk
    case 'live.autoAskModel':
      return settings.autoAskModel
    case 'live.autoAskMinSeconds':
      return settings.autoAskMinSeconds
    case 'live.autoAskConcurrency':
      return settings.autoAskConcurrency
  }
}

export function configValueText(value: ConfigValue): string {
  if (value === null) return 'null'
  return String(value)
}

function parseBool(raw: string): boolean {
  const value = trimmed(raw).toLowerCase()
  if (['true', 'on', 'yes', '1'].includes(value)) return true
  if (['false', 'off', 'no', '0'].includes(value)) return false
  throw new RecapError('CONFIG_VALUE_INVALID', `Expected true or false, got "${raw}"`)
}

function parseRange(key: string, raw: string, [low, high]: readonly [number, number], unit: 'seconds' | 'count'): number {
  const text = trimmed(raw)
  const value = /^[+-]?\d+$/.test(text) ? Number(text) : Number.NaN
  if (!Number.isInteger(value) || value < low || value > high) {
    throw new RecapError(
      'CONFIG_VALUE_INVALID',
      unit === 'seconds' ? `${key} takes whole seconds between ${low} and ${high}` : `${key} takes a whole number between ${low} and ${high}`,
    )
  }
  return value
}

function optionalModel(raw: string): string | undefined {
  const text = trimmed(raw)
  return ['', 'null', 'none', 'default'].includes(text.toLowerCase()) ? undefined : text
}

export function applyConfigValue(key: ConfigKey, raw: string, live: LiveConfig | undefined): LiveConfig {
  const next: LiveConfig = { ...(live ?? {}) }
  switch (key) {
    case 'live.enabled':
      next.enabled = parseBool(raw)
      break
    case 'live.openWindow':
      next.openWindow = parseBool(raw)
      break
    case 'live.proposals':
      next.proposals = parseBool(raw)
      break
    case 'live.assistModel':
      next.assistModel = optionalModel(raw)
      break
    case 'live.maxChunkSeconds':
      next.maxChunkSeconds = parseRange(key, raw, RANGES.chunkSeconds, 'seconds')
      break
    case 'live.autoAsk':
      next.autoAsk = parseBool(raw)
      break
    case 'live.autoAskModel':
      next.autoAskModel = optionalModel(raw)
      break
    case 'live.autoAskMinSeconds':
      next.autoAskMinSeconds = parseRange(key, raw, RANGES.autoAskSeconds, 'seconds')
      break
    case 'live.autoAskConcurrency':
      next.autoAskConcurrency = parseRange(key, raw, RANGES.autoAskConcurrency, 'count')
      break
  }
  return next
}

export function configSnapshot(live: LiveConfig | undefined): Record<string, ConfigValue> {
  return Object.fromEntries(CONFIG_KEYS.map((key) => [key, configValue(key, live)]))
}
