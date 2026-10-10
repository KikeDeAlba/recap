export interface EncodeOptions {
  pretty?: boolean
  sorted?: boolean
  escapeSlashes?: boolean
}

function encodeString(value: string, options: EncodeOptions): string {
  const text = JSON.stringify(value)
  return options.escapeSlashes ? text.replace(/\//g, '\\/') : text
}

function encodeValue(value: unknown, options: EncodeOptions, indent: string): string {
  if (value === null || value === undefined) return 'null'
  if (typeof value === 'string') return encodeString(value, options)
  if (typeof value === 'number') return Number.isFinite(value) ? JSON.stringify(value) : 'null'
  if (typeof value === 'boolean') return value ? 'true' : 'false'
  const inner = `${indent}  `
  if (Array.isArray(value)) {
    if (value.length === 0) return options.pretty ? `[\n\n${indent}]` : '[]'
    const items = value.map((item) => encodeValue(item, options, inner))
    return options.pretty ? `[\n${items.map((item) => `${inner}${item}`).join(',\n')}\n${indent}]` : `[${items.join(',')}]`
  }
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>
    let keys = Object.keys(record).filter((key) => record[key] !== undefined)
    if (options.sorted) keys = keys.sort((left, right) => (left < right ? -1 : left > right ? 1 : 0))
    if (keys.length === 0) return options.pretty ? `{\n\n${indent}}` : '{}'
    const separator = options.pretty ? ' : ' : ':'
    const entries = keys.map((key) => `${encodeString(key, options)}${separator}${encodeValue(record[key], options, inner)}`)
    return options.pretty ? `{\n${entries.map((entry) => `${inner}${entry}`).join(',\n')}\n${indent}}` : `{${entries.join(',')}}`
  }
  return 'null'
}

export function encodeJson(value: unknown, options: EncodeOptions = {}): string {
  return encodeValue(value, options, '')
}

export const swiftPretty = (value: unknown): string => encodeJson(value, { pretty: true, sorted: true })
export const swiftLine = (value: unknown): string => encodeJson(value, { sorted: true })
export const swiftDefault = (value: unknown): string => encodeJson(value, { escapeSlashes: true })

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

export function asInt(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) ? value : undefined
}

export function asIntLoose(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isInteger(value)) return value
  if (typeof value === 'string' && /^-?\d+$/.test(value.trim())) return Number(value.trim())
  return undefined
}

export function parseJsonSafe(text: string): unknown {
  try {
    return JSON.parse(text) as unknown
  } catch {
    return undefined
  }
}

export function extractBetween(text: string, open: string, close: string): unknown {
  const start = text.indexOf(open)
  const end = text.lastIndexOf(close)
  if (start === -1 || end === -1 || start >= end) return undefined
  return parseJsonSafe(text.slice(start, end + 1))
}
