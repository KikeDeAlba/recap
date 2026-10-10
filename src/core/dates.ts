const MONTHS = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre']

const two = (value: number) => String(value).padStart(2, '0')

export function isoDate(date: Date): string {
  return date.toISOString().replace(/\.\d{3}Z$/, 'Z')
}

export function isoNow(): string {
  return isoDate(new Date())
}

export function parseDate(value: string | undefined | null): Date | null {
  if (!value) return null
  const ms = Date.parse(value)
  return Number.isNaN(ms) ? null : new Date(ms)
}

export function esHeaderDate(date: Date): string {
  return `${date.getDate()} de ${MONTHS[date.getMonth()]} de ${date.getFullYear()}, ${two(date.getHours())}:${two(date.getMinutes())}`
}

export function dayString(date: Date): string {
  return `${date.getFullYear()}-${two(date.getMonth() + 1)}-${two(date.getDate())}`
}

export function idStamp(date: Date): string {
  return `${dayString(date)}-${two(date.getHours())}${two(date.getMinutes())}`
}

export function minuteStamp(date: Date): string {
  return `${dayString(date)} ${two(date.getHours())}:${two(date.getMinutes())}`
}

export function clock(ms: number): string {
  const total = Math.max(0, Math.trunc(ms / 1000))
  return `${two(Math.trunc(total / 3600))}:${two(Math.trunc((total % 3600) / 60))}:${two(total % 60)}`
}
