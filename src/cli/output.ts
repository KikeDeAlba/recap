import { errorEnvelope, successEnvelope, writeJson } from '@kikedealba/kit/envelope'
import { asRecapError } from '../errors.ts'
import { SCHEMA_VERSION } from '../version.ts'

export interface Result {
  data: unknown
  text: string
}

export async function output(command: string, json: boolean, body: () => Promise<Result> | Result): Promise<number> {
  try {
    const { data, text } = await body()
    if (json) writeJson(successEnvelope(SCHEMA_VERSION, command, data))
    else if (text.length > 0) process.stdout.write(`${text}\n`)
    return 0
  } catch (error) {
    const failure = asRecapError(error)
    if (json) writeJson(errorEnvelope(SCHEMA_VERSION, command, { code: failure.code, message: failure.message, ...(failure.hint ? { hint: failure.hint } : {}) }))
    else process.stderr.write(`recap: ${failure.message} [${failure.code}]${failure.hint ? `\n${failure.hint}` : ''}\n`)
    return failure.exitCode
  }
}

export function stderrLine(text: string): void {
  process.stderr.write(`${text}\n`)
}
