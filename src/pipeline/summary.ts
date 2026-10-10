import path from 'node:path'
import { clock } from '../core/dates.ts'
import { readText, writeAtomic } from '../core/fsutil.ts'
import { isRecord, parseJsonSafe } from '../core/json.ts'
import { durationSeconds, type Meeting } from '../core/meeting.ts'
import { formatDuration, replaceAll, trimmed } from '../core/text.ts'
import { RecapError } from '../errors.ts'
import { resultText } from './claude.ts'
import { loadResource } from './resources.ts'
import { meetingHeader } from './transcript.ts'

export interface FrameInfo {
  file: string
  timeSeconds: number
}

export function readFrames(dir: string): FrameInfo[] {
  const value = parseJsonSafe(readText(path.join(dir, 'frames.json')) ?? '')
  if (!Array.isArray(value)) return []
  return value.filter(isRecord).flatMap((item) => (typeof item['file'] === 'string' && typeof item['timeSeconds'] === 'number' ? [{ file: item['file'], timeSeconds: item['timeSeconds'] }] : []))
}

export function renderSummaryPrompt(meeting: Meeting, transcript: string, frames: readonly FrameInfo[], template: string = loadResource('summary-prompt.md')): string {
  const mode = meeting.mode === 'remote' ? 'remota (videollamada)' : 'presencial'
  const speakers =
    meeting.mode === 'remote'
      ? '- Hablantes: «Sala» es el micrófono local (quien graba y quien esté en su sala); «Remotos» es el audio de la llamada. No hay separación por persona; identifica a cada quien por contexto cuando se presenten o se nombren.'
      : '- Hablantes: un solo micrófono en la sala, sin separación por persona; identifica a cada quien por contexto cuando se presenten o se nombren.'
  let framesText = ''
  if (frames.length > 0) {
    const list = frames.map((frame) => `  - ${frame.file} [${clock(Math.trunc(frame.timeSeconds * 1000))}]`)
    framesText = `- Capturas de pantalla (en el directorio actual; ábrelas con Read cuando el tema lo amerite, en especial diapositivas, documentos o demos):\n${list.join('\n')}`
  }
  let text = template
  text = replaceAll(text, '{{title}}', meeting.title)
  text = replaceAll(text, '{{date}}', meetingHeader(meeting).split(' · ')[0] ?? '')
  text = replaceAll(text, '{{duration}}', formatDuration(durationSeconds(meeting)))
  text = replaceAll(text, '{{mode}}', mode)
  text = replaceAll(text, '{{speakers}}', speakers)
  text = replaceAll(text, '{{frames}}', framesText)
  text = replaceAll(text, '{{transcript}}', transcript)
  return text
}

export function summaryPromptFor(meeting: Meeting, dir: string): string {
  const transcript = readText(path.join(dir, 'transcript.md'))
  if (transcript === null) throw new RecapError('NO_TRANSCRIPT', `"${meeting.title}" has no transcript yet; run \`recap process ${meeting.id}\``)
  return renderSummaryPrompt(meeting, transcript, readFrames(dir))
}

export function saveSummary(body: string, meeting: Meeting, dir: string): void {
  let content = trimmed(body)
  const start = content.indexOf('## Resumen')
  if (start !== -1) content = content.slice(start)
  if (content.length === 0) throw new RecapError('EMPTY_SUMMARY', 'The summary is empty')
  writeAtomic(path.join(dir, 'summary.md'), `# ${meeting.title}\n\n${meetingHeader(meeting)}\n\n${content}\n`)
}

export function extractSummary(output: string): string {
  const result = resultText(output)
  const start = result.indexOf('## Resumen')
  return start === -1 ? result : result.slice(start)
}
