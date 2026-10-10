import { isRecord, parseJsonSafe } from '../core/json.ts'
import type { BitaClient } from '../bita/client.ts'

export function legacyHookIndexes(data: unknown): number[] {
  if (!Array.isArray(data)) return []
  const indexes: number[] = []
  data.forEach((hook, index) => {
    if (!isRecord(hook) || !Array.isArray(hook['command'])) return
    const command = hook['command'].filter((part): part is string => typeof part === 'string')
    if (command[command.length - 1] === 'bita-hook' && command.some((part) => /recap/i.test(part))) indexes.push(index + 1)
  })
  return indexes
}

export async function removeLegacyHook(bita: BitaClient): Promise<number> {
  const listed = await bita.run(['hooks', '--json']).catch(() => null)
  if (!listed || listed.status !== 0) return 0
  const envelope = parseJsonSafe(listed.stdout.trim().split('\n').pop() ?? '')
  const indexes = legacyHookIndexes(isRecord(envelope) ? envelope['data'] : undefined)
  let removed = 0
  for (const index of indexes.sort((a, b) => b - a)) {
    const result = await bita.run(['hooks', 'rm', String(index), '--json']).catch(() => null)
    if (result?.status === 0) removed += 1
  }
  return removed
}
