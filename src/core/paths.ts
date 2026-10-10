import { homedir } from 'node:os'
import path from 'node:path'
import { dataHome, platformContext, stateHome } from '@kikedealba/kit/platform'

function env(key: string): string | undefined {
  const value = process.env[key]
  return value && value.length > 0 ? value : undefined
}

export function home(): string {
  return env('HOME') ?? homedir()
}

export function isWindows(): boolean {
  return process.platform === 'win32'
}

export function expandTilde(value: string): string {
  if (value === '~') return home()
  if (value.startsWith('~/') || value.startsWith('~\\')) return path.join(home(), value.slice(2))
  return path.resolve(value)
}

function context() {
  return platformContext({ home: home() })
}

export function configFile(): string {
  const override = env('RECAP_CONFIG_PATH')
  if (override) return path.resolve(override)
  if (isWindows()) return path.join(env('APPDATA') ?? path.join(home(), 'AppData', 'Roaming'), 'recap', 'config.json')
  return path.join(home(), '.config', 'recap', 'config.json')
}

export function configDir(): string {
  return path.dirname(configFile())
}

export function stateDir(): string {
  const override = env('RECAP_STATE_DIR')
  if (override) return path.resolve(override)
  return path.join(stateHome(context()), 'recap')
}

export function dataDir(): string {
  const override = env('RECAP_DATA_DIR')
  if (override) return path.resolve(override)
  return path.join(dataHome(context()), 'recap')
}

export function activeFile(): string {
  return path.join(stateDir(), 'active.json')
}

export function modelsDir(): string {
  return path.join(dataDir(), 'models')
}

export function eventsLog(): string {
  return path.join(stateDir(), 'events.log')
}
