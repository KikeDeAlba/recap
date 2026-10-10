export const EXIT = {
  ok: 0,
  failure: 1,
  usage: 2,
} as const

export class RecapError extends Error {
  readonly code: string
  readonly hint: string | undefined
  readonly exitCode: number

  constructor(code: string, message: string, options: { hint?: string; exitCode?: number } = {}) {
    super(message)
    this.name = 'RecapError'
    this.code = code
    this.hint = options.hint
    this.exitCode = options.exitCode ?? EXIT.failure
  }

  get description(): string {
    return `${this.code}: ${this.message}`
  }
}

export function usageError(message: string, hint?: string): RecapError {
  return new RecapError('USAGE', message, { exitCode: EXIT.usage, ...(hint ? { hint } : {}) })
}

export function describeError(error: unknown): string {
  if (error instanceof RecapError) return error.description
  return error instanceof Error ? error.message : String(error)
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function asRecapError(error: unknown): RecapError {
  if (error instanceof RecapError) return error
  return new RecapError('UNEXPECTED', errorMessage(error))
}
