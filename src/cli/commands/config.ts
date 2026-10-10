import { loadConfig, saveConfig } from '../../core/config.ts'
import { CONFIG_KEYS, applyConfigValue, configSnapshot, configValue, configValueText, parseConfigKey } from '../../core/live-settings.ts'
import { configFile } from '../../core/paths.ts'
import { usageError } from '../../errors.ts'
import { parseArgs } from '../args.ts'
import { output } from '../output.ts'

export async function configCommand(argv: string[]): Promise<number> {
  const [sub, ...rest] = argv
  if (sub === 'get') {
    return output('config get', rest.includes('--json'), () => {
      const args = parseArgs(rest, { maxPositionals: 1 })
      const config = loadConfig()
      const settings = configSnapshot(config.live)
      const raw = args.positionals[0]
      if (raw !== undefined) {
        const key = parseConfigKey(raw)
        const value = configValue(key, config.live)
        return { data: { path: configFile(), key, value, settings }, text: configValueText(value) }
      }
      return { data: { path: configFile(), settings }, text: CONFIG_KEYS.map((key) => `${key} = ${configValueText(settings[key] ?? null)}`).join('\n') }
    })
  }
  if (sub === 'set') {
    return output('config set', rest.includes('--json'), () => {
      const args = parseArgs(rest, { maxPositionals: 2 })
      const [rawKey, raw] = args.positionals
      if (rawKey === undefined || raw === undefined) throw usageError('Usage: recap config set <key> <value>')
      const config = loadConfig()
      const key = parseConfigKey(rawKey)
      config.live = applyConfigValue(key, raw, config.live)
      saveConfig(config)
      const value = configValue(key, config.live)
      return { data: { path: configFile(), key, value, settings: configSnapshot(config.live) }, text: `${key} = ${configValueText(value)}` }
    })
  }
  return output('config', argv.includes('--json'), () => {
    throw usageError('Usage: recap config get [key] | recap config set <key> <value>', `Keys: ${CONFIG_KEYS.join(', ')}`)
  })
}
