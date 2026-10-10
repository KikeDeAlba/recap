export function trimmed(text: string): string {
  return text.replace(/^[\s\u0085]+|[\s\u0085]+$/gu, '')
}

export function fold(text: string): string {
  return trimmed(text.normalize('NFD').replace(/\p{Mn}/gu, '').toLowerCase().normalize('NFC'))
}

export function tokens(text: string): Set<string> {
  return new Set(
    fold(text)
      .split(/[^\p{L}\p{M}\p{N}]+/u)
      .filter((token) => [...token].length > 1),
  )
}

export function jaccard(a: string, b: string): number {
  return jaccardSets(tokens(a), tokens(b))
}

export function jaccardSets(left: Set<string>, right: Set<string>): number {
  if (left.size === 0 || right.size === 0) return 0
  let shared = 0
  for (const token of left) if (right.has(token)) shared += 1
  return shared / (left.size + right.size - shared)
}

export function setsEqual(left: Set<string>, right: Set<string>): boolean {
  if (left.size !== right.size) return false
  for (const token of left) if (!right.has(token)) return false
  return true
}

export function suffix(text: string, length: number): string {
  const chars = [...text]
  return chars.length <= length ? text : chars.slice(chars.length - length).join('')
}

export function prefix(text: string, length: number): string {
  const chars = [...text]
  return chars.length <= length ? text : chars.slice(0, length).join('')
}

export function replaceAll(text: string, search: string, replacement: string): string {
  return text.split(search).join(replacement)
}

export function padEnd(text: string, length: number): string {
  const chars = [...text]
  return chars.length >= length ? chars.slice(0, length).join('') : text + ' '.repeat(length - chars.length)
}

export function slug(text: string): string {
  const folded = text.normalize('NFD').replace(/\p{Mn}/gu, '').toLowerCase()
  let out = ''
  let pendingDash = false
  for (const char of folded) {
    if (/^[a-z0-9]$/.test(char)) {
      if (pendingDash && out.length > 0) out += '-'
      out += char
      pendingDash = false
    } else {
      pendingDash = true
    }
  }
  const cut = out.slice(0, 48).replace(/^-+|-+$/g, '')
  return cut.length === 0 ? 'meeting' : cut
}

export function formatDuration(seconds: number | undefined | null): string {
  if (seconds === undefined || seconds === null) return '-'
  const h = Math.trunc(seconds / 3600)
  const m = Math.trunc((seconds % 3600) / 60)
  const s = seconds % 60
  const two = (value: number) => String(value).padStart(2, '0')
  return h > 0 ? `${h}h${two(m)}m` : `${m}m${two(s)}s`
}

export function formatBytes(bytes: number): string {
  if (bytes === 0) return 'Zero KB'
  if (Math.abs(bytes) < 1000) return `${bytes} bytes`
  const units = ['KB', 'MB', 'GB', 'TB', 'PB']
  let value = bytes / 1000
  let unit = 0
  while (Math.abs(value) >= 1000 && unit < units.length - 1) {
    value /= 1000
    unit += 1
  }
  const decimals = unit === 0 ? 0 : unit === 1 ? 1 : 2
  const text = value.toFixed(decimals).replace(/\.0+$/, '').replace(/(\.\d*?)0+$/, '$1')
  return `${text} ${units[unit]}`
}
