import { jaccard, jaccardSets, tokens } from '../core/text.ts'

export const DEDUPE_THRESHOLD = 0.5

export const STOPWORDS = new Set([
  'el', 'la', 'los', 'las', 'lo', 'un', 'una', 'unos', 'unas', 'de', 'del', 'al', 'en', 'por', 'para', 'con',
  'sin', 'se', 'es', 'son', 'como', 'cual', 'cuales', 'donde', 'cuando', 'quien', 'que', 'y', 'o',
  'u', 'le', 'les', 'su', 'sus', 'me', 'mi', 'te', 'tu', 'nos', 'este', 'esta', 'esto', 'ese', 'esa', 'eso',
  'hay', 'ya', 'mas', 'pero', 'si', 'no', 'muy', 'hace', 'hacer', 'puede', 'podemos',
])

export function questionTokens(text: string): Set<string> {
  return new Set([...tokens(text)].filter((token) => !STOPWORDS.has(token)))
}

export function questionSimilarity(a: string, b: string): number {
  const left = questionTokens(a)
  const right = questionTokens(b)
  if (left.size === 0 || right.size === 0) return jaccard(a, b)
  return jaccardSets(left, right)
}

export function isDuplicateQuestion(question: string, known: readonly string[]): boolean {
  return known.some((other) => questionSimilarity(question, other) >= DEDUPE_THRESHOLD)
}
