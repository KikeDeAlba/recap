import path from 'node:path'
import type { Config } from '../core/config.ts'
import { dayString, parseDate } from '../core/dates.ts'
import { readText, writeAtomic } from '../core/fsutil.ts'
import { extractBetween, isRecord, swiftDefault } from '../core/json.ts'
import { durationSeconds, emptyWrapup, updateMeeting, type BitaEntrySnapshot, type Meeting } from '../core/meeting.ts'
import { fold, formatDuration, prefix, replaceAll, trimmed } from '../core/text.ts'
import { RecapError } from '../errors.ts'
import { resultText, runSummaryClaude } from '../pipeline/claude.ts'
import { loadResource } from '../pipeline/resources.ts'
import { INKWELL_CAPABILITIES, INKWELL_HINT, StageSkipped, callBita, callInkwell, lookupInkwell, meetingTarget, requireBita, type ToolCalling } from './client.ts'
import { entryPages } from '../live/context.ts'

export interface WrapupItem {
  kind: string
  title: string
  body?: string | undefined
}

export interface WrapupPlan {
  title: string
  project?: string | undefined
  pageTitle: string
  pageMarkdown: string
  backlog: WrapupItem[]
}

export const FORBIDDEN_SECTIONS = ['pendiente', 'proximos pasos', 'hallazgo', 'preguntas abiertas', 'lo que falta']

export function stripForbiddenSections(markdown: string): string {
  const kept: string[] = []
  let skipping = false
  let inFence = false
  for (const line of markdown.split('\n')) {
    if (line.startsWith('```')) inFence = !inFence
    if (!inFence && line.startsWith('## ')) {
      const heading = fold(line.slice(3))
      skipping = FORBIDDEN_SECTIONS.some((section) => heading.startsWith(section))
    }
    if (!skipping) kept.push(line)
  }
  return kept.join('\n')
}

export function demoteHeadings(markdown: string): string {
  let inFence = false
  return markdown
    .split('\n')
    .map((line) => {
      if (line.startsWith('```')) inFence = !inFence
      return !inFence && line.startsWith('#') ? `#${line}` : line
    })
    .join('\n')
}

export function parseWrapup(text: string): WrapupPlan {
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start === -1 || end === -1 || start >= end) throw new RecapError('WRAPUP_OUTPUT', `The wrap-up answer has no JSON object: ${prefix(text, 200)}`)
  const raw = extractBetween(text, '{', '}')
  const incomplete = (reason: string) => new RecapError('WRAPUP_OUTPUT', `The wrap-up JSON is incomplete: ${reason}`)
  if (!isRecord(raw)) throw incomplete('the JSON object cannot be parsed')
  if (typeof raw['title'] !== 'string') throw incomplete('title is missing')
  if (typeof raw['pageTitle'] !== 'string') throw incomplete('pageTitle is missing')
  if (typeof raw['pageMarkdown'] !== 'string') throw incomplete('pageMarkdown is missing')
  if (!Array.isArray(raw['backlog'])) throw incomplete('backlog is missing')
  if (raw['project'] !== undefined && raw['project'] !== null && typeof raw['project'] !== 'string') throw incomplete('project must be a string')
  const items: WrapupItem[] = []
  for (const item of raw['backlog']) {
    if (!isRecord(item) || typeof item['kind'] !== 'string' || typeof item['title'] !== 'string') throw incomplete('a backlog item is invalid')
    if (item['body'] !== undefined && item['body'] !== null && typeof item['body'] !== 'string') throw incomplete('a backlog body is invalid')
    items.push({ kind: item['kind'], title: item['title'], body: typeof item['body'] === 'string' ? item['body'] : undefined })
  }
  const title = prefix(trimmed(raw['title']), 120)
  const pageTitle = trimmed(raw['pageTitle']).length === 0 ? title : trimmed(raw['pageTitle'])
  const page = trimmed(stripForbiddenSections(raw['pageMarkdown']))
  if (title.length === 0 || page.length === 0) throw new RecapError('WRAPUP_OUTPUT', 'The wrap-up answer has an empty title or page')
  const project = typeof raw['project'] === 'string' ? trimmed(raw['project']) : undefined
  const backlog = items
    .filter((item) => ['pending', 'finding'].includes(item.kind) && trimmed(item.title).length > 0)
    .map((item) => ({ kind: item.kind, title: prefix(trimmed(item.title), 200), body: item.body === undefined ? undefined : trimmed(item.body) }))
  return { title, project: project && project.length > 0 ? project : undefined, pageTitle, pageMarkdown: page, backlog }
}

export const GENERIC_TITLES = new Set([
  '',
  'reunion',
  'reunion presencial',
  'reunion remota',
  'junta',
  'junta presencial',
  'junta remota',
  'meet',
  'meeting',
  'llamada',
  'videollamada',
  'remote meeting',
  'in-person meeting',
  'in person meeting',
  'reunion en sala',
  'sesion',
])

export function isGenericTitle(title: string): boolean {
  const folded = fold(title)
    .split(/[^\p{L}\p{M}\p{N}-]+/u)
    .filter((part) => part.length > 0)
    .join(' ')
  return GENERIC_TITLES.has(folded)
}

export function chooseProject(current: string | null | undefined, proposed: string | null | undefined, available: readonly string[]): { apply: string | null; resolved: boolean } {
  if (current && trimmed(current).length > 0) return { apply: null, resolved: true }
  if (!proposed) return { apply: null, resolved: false }
  const wanted = fold(proposed)
  const match = available.find((name) => fold(name) === wanted)
  return match ? { apply: match, resolved: true } : { apply: null, resolved: false }
}

export const NOTE_SECTION = 'Reunión'

export function noteBody(summary: string, meeting: Meeting, dir: string): string {
  let body = summary
  const start = body.indexOf('## Resumen')
  if (start !== -1) body = body.slice(start)
  const mode = meeting.mode === 'remote' ? 'remota' : 'presencial'
  const lines = [`Minuta de la reunión ${mode} (${formatDuration(durationSeconds(meeting))}), generada por recap a partir de la grabación.`, '']
  let inFence = false
  for (const line of body.split('\n')) {
    if (line.startsWith('```')) inFence = !inFence
    lines.push(!inFence && line.startsWith('#') ? `#${line}` : line)
  }
  while (lines.length > 0 && trimmed(lines[lines.length - 1] ?? '').length === 0) lines.pop()
  lines.push('', `Archivos de la reunión: \`${dir}\` (\`summary.md\`, \`transcript.md\`${meeting.mode === 'remote' ? ', `frames/`' : ''}).`)
  return `${lines.join('\n')}\n`
}

export interface MinutesResult {
  saved: boolean
  reason?: string | undefined
}

export async function saveMinutes(meeting: Meeting, dir: string, notes?: ToolCalling | null, log?: (line: string) => void): Promise<MinutesResult> {
  const entryId = meeting.bitaEntryId
  if (entryId === undefined) return { saved: false, reason: 'the meeting has no bita entry' }
  const summary = readText(path.join(dir, 'summary.md'))
  if (summary === null) throw new RecapError('NO_SUMMARY', `"${meeting.title}" has no summary to save in the entry note`)
  const note = path.join(dir, 'entry-note.md')
  writeAtomic(note, noteBody(summary, meeting, dir))
  let client = notes
  let reason = 'no inkwell with docs.entry-notes was given'
  if (client === undefined) {
    const found = await lookupInkwell(INKWELL_CAPABILITIES.notes)
    client = found.client
    if (found.reason !== undefined) reason = found.reason
  }
  if (!client) {
    log?.(`minutes: not saved in the note of entry #${entryId}, ${reason}; they stay in ${dir} (${INKWELL_HINT})`)
    return { saved: false, reason }
  }
  await callInkwell(client, ['note', 'save', String(entryId), '--section', NOTE_SECTION, '--md', note])
  log?.(`minutes: saved in the note of entry #${entryId}`)
  return { saved: true }
}

export function meetingDay(meeting: Meeting): string {
  return dayString(parseDate(meeting.startedAt) ?? parseDate(meeting.createdAt) ?? new Date())
}

export function encodeWrapupPlan(plan: WrapupPlan): string {
  return swiftDefault({
    title: plan.title,
    project: plan.project,
    pageTitle: plan.pageTitle,
    pageMarkdown: plan.pageMarkdown,
    backlog: plan.backlog.map((item) => ({ kind: item.kind, title: item.title, body: item.body })),
  })
}

async function pageText(docs: ToolCalling, pageId: number): Promise<string | null> {
  const page = await callInkwell(docs, ['page', 'show', String(pageId)])
  const doc = isRecord(page) && isRecord(page['doc']) ? page['doc'] : undefined
  const file = typeof doc?.['path'] === 'string' ? doc['path'] : undefined
  return file ? readText(file) : null
}

export interface WrapupDependencies {
  bita: ToolCalling
  docs: ToolCalling
  notes?: ToolCalling | null | undefined
  claude: (prompt: string) => Promise<string>
  log?: ((line: string) => void) | undefined
}

export async function planWrapup(
  meeting: Meeting,
  dir: string,
  snapshot: BitaEntrySnapshot,
  projects: readonly string[],
  existingPage: string | null,
  claude: (prompt: string) => Promise<string>,
): Promise<WrapupPlan> {
  const summary = readText(path.join(dir, 'summary.md')) ?? ''
  const transcript = readText(path.join(dir, 'transcript.md')) ?? ''
  const pageNote =
    existingPage === null
      ? ''
      : `- Esta reunión ya tiene página. \`pageMarkdown\` se agregará como una sección nueva de esa página; no repitas lo que ya dice:\n<pagina_actual>\n${prefix(existingPage, 20_000)}\n</pagina_actual>`
  let prompt = loadResource('wrapup-prompt.md')
  prompt = replaceAll(prompt, '{{currentTitle}}', snapshot.title)
  prompt = replaceAll(prompt, '{{currentProject}}', snapshot.projectName ?? 'ninguno')
  prompt = replaceAll(prompt, '{{date}}', meetingDay(meeting))
  prompt = replaceAll(prompt, '{{duration}}', formatDuration(durationSeconds(meeting)))
  prompt = replaceAll(prompt, '{{mode}}', meeting.mode === 'remote' ? 'remota' : 'presencial')
  prompt = replaceAll(prompt, '{{projects}}', projects.map((name) => `  - ${name}`).join('\n'))
  prompt = replaceAll(prompt, '{{existingPage}}', pageNote)
  prompt = replaceAll(prompt, '{{summary}}', summary)
  prompt = replaceAll(prompt, '{{transcript}}', transcript)
  return parseWrapup(await claude(prompt))
}

export async function runWrapup(meeting: Meeting, dir: string, config: Config, dependencies?: Partial<WrapupDependencies>): Promise<void> {
  const entryId = meeting.bitaEntryId
  if (entryId === undefined) return
  let docs = dependencies?.docs
  if (!docs) {
    const found = await lookupInkwell(INKWELL_CAPABILITIES.wrapup)
    if (!found.client) {
      await saveMinutes(meeting, dir, undefined, dependencies?.log).catch((error: unknown) => dependencies?.log?.(`minutes: ${String(error)}`))
      throw new StageSkipped(found.reason, INKWELL_HINT)
    }
    docs = found.client
  }
  const bita = dependencies?.bita ?? (await requireBita(config, meetingTarget(meeting)))
  const claude = dependencies?.claude ?? (async (prompt: string) => resultText(await runSummaryClaude(prompt, dir, config)))
  const snapshot = meeting.bitaEntry ?? { title: meeting.title, pageIds: [] }
  const wrapup = { ...emptyWrapup(), ...(meeting.wrapup ?? {}) }

  const listed = await callBita(bita, ['projects'])
  const projects = (Array.isArray(listed) ? listed : [])
    .filter(isRecord)
    .filter((project) => project['active'] !== false)
    .flatMap((project) => (typeof project['name'] === 'string' ? [project['name']] : []))
  const existingPageId = wrapup.pageId ?? (await entryPages(docs, entryId, true))[0]?.pageId
  const existingPage = existingPageId === undefined ? null : await pageText(docs, existingPageId)

  const plan = await planWrapup(meeting, dir, snapshot, projects, existingPage, claude)
  writeAtomic(path.join(dir, 'wrapup.json'), encodeWrapupPlan(plan))

  if (isGenericTitle(snapshot.title)) {
    await callBita(bita, ['amend', String(entryId), '--title', plan.title])
    wrapup.title = plan.title
    wrapup.titleChanged = true
  } else {
    wrapup.title = snapshot.title
  }

  const choice = chooseProject(snapshot.projectName, plan.project, projects)
  if (choice.apply) await callBita(bita, ['amend', String(entryId), '--project', choice.apply])
  wrapup.project = choice.apply ?? snapshot.projectName
  wrapup.projectResolved = choice.resolved

  const pageFile = path.join(dir, 'wrapup-page.md')
  if (existingPageId !== undefined) {
    writeAtomic(pageFile, demoteHeadings(plan.pageMarkdown))
    await callInkwell(docs, ['page', 'write', String(existingPageId), '--md', pageFile, '--section', `Reunión ${meetingDay(meeting)}`])
    wrapup.pageId = existingPageId
  } else {
    writeAtomic(pageFile, plan.pageMarkdown)
    const args = ['page', 'new', plan.pageTitle, '--from-entry', String(entryId)]
    if (wrapup.project) args.push('--project', wrapup.project)
    const created = await callInkwell(docs, args)
    const page = isRecord(created) && isRecord(created['page']) ? created['page'] : undefined
    const pageId = typeof page?.['pageId'] === 'number' ? page['pageId'] : undefined
    if (pageId === undefined) throw new RecapError('INKWELL_FAILED', 'inkwell page new did not return the page id')
    await callInkwell(docs, ['page', 'write', String(pageId), '--md', pageFile])
    wrapup.pageId = pageId
    wrapup.pageCreated = true
  }
  updateMeeting(dir, (current) => {
    current.wrapup = { ...wrapup, backlogKeys: { ...wrapup.backlogKeys } }
  })

  for (const item of plan.backlog) {
    if (wrapup.backlogKeys[item.title] !== undefined) continue
    const args = ['backlog', 'add', '--kind', item.kind, '--title', item.title, '--page', String(wrapup.pageId ?? 0)]
    if (item.body) {
      const bodyFile = path.join(dir, 'wrapup-backlog-item.md')
      writeAtomic(bodyFile, item.body)
      args.push('--md', bodyFile)
    }
    const added = await callInkwell(docs, args)
    wrapup.backlogKeys[item.title] = isRecord(added) && typeof added['key'] === 'string' ? added['key'] : '?'
    updateMeeting(dir, (current) => {
      current.wrapup = { ...wrapup, backlogKeys: { ...wrapup.backlogKeys } }
    })
  }

  await saveMinutes(meeting, dir, dependencies?.notes, dependencies?.log)
  updateMeeting(dir, (current) => {
    current.wrapup = { ...wrapup, backlogKeys: { ...wrapup.backlogKeys } }
  })
}
