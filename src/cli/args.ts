import { usageError } from '../errors.ts'

export interface Spec {
  booleans?: readonly string[]
  values?: readonly string[]
  maxPositionals?: number
}

export class Args {
  readonly positionals: string[]
  readonly flags: Map<string, string>
  readonly booleans: Set<string>

  constructor(positionals: string[], flags: Map<string, string>, booleans: Set<string>) {
    this.positionals = positionals
    this.flags = flags
    this.booleans = booleans
  }

  has(name: string): boolean {
    return this.booleans.has(name)
  }

  value(name: string): string | undefined {
    return this.flags.get(name)
  }

  int(name: string): number | undefined {
    const raw = this.flags.get(name)
    if (raw === undefined) return undefined
    if (!/^[+-]?\d+$/.test(raw.trim())) throw usageError(`--${name} expects a whole number, got "${raw}"`)
    return Number(raw.trim())
  }

  number(name: string): number | undefined {
    const raw = this.flags.get(name)
    if (raw === undefined) return undefined
    const value = Number(raw)
    if (raw.trim().length === 0 || !Number.isFinite(value)) throw usageError(`--${name} expects a number, got "${raw}"`)
    return value
  }

  get json(): boolean {
    return this.booleans.has('json')
  }
}

const GLOBAL_BOOLEANS = ['json', 'help']

export function parseArgs(argv: readonly string[], spec: Spec): Args {
  const booleanNames = new Set([...GLOBAL_BOOLEANS, ...(spec.booleans ?? [])])
  const valueNames = new Set(spec.values ?? [])
  const positionals: string[] = []
  const flags = new Map<string, string>()
  const booleans = new Set<string>()
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index] ?? ''
    if (arg === '--') {
      positionals.push(...argv.slice(index + 1))
      break
    }
    if (arg === '-h') {
      booleans.add('help')
      continue
    }
    if (arg.startsWith('--') && arg.length > 2) {
      const body = arg.slice(2)
      const eq = body.indexOf('=')
      const name = eq === -1 ? body : body.slice(0, eq)
      if (booleanNames.has(name)) {
        if (eq !== -1) throw usageError(`--${name} does not take a value`)
        booleans.add(name)
        continue
      }
      if (!valueNames.has(name)) throw usageError(`Unknown option --${name}`)
      if (eq !== -1) {
        flags.set(name, body.slice(eq + 1))
        continue
      }
      const next = argv[index + 1]
      if (next === undefined) throw usageError(`--${name} needs a value`)
      flags.set(name, next)
      index += 1
      continue
    }
    positionals.push(arg)
  }
  if (spec.maxPositionals !== undefined && positionals.length > spec.maxPositionals) throw usageError(`Unexpected argument "${positionals[spec.maxPositionals]}"`)
  return new Args(positionals, flags, booleans)
}
