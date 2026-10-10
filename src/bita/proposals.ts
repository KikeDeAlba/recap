import { mkdirSync, rmSync } from 'node:fs'
import path from 'node:path'
import type { Config } from '../core/config.ts'
import { isoNow } from '../core/dates.ts'
import { readText, writeAtomic } from '../core/fsutil.ts'
import { extractBetween, isRecord, swiftPretty } from '../core/json.ts'
import { withDirectoryLockAsync } from '../core/lock.ts'
import { home } from '../core/paths.ts'
import type { Meeting } from '../core/meeting.ts'
import { fold, prefix, replaceAll, trimmed } from '../core/text.ts'
import { RecapError, errorMessage } from '../errors.ts'
import { loadProjectContext, meetingProject, type PageRef, type ProjectContext } from '../live/context.ts'
import { resultText, runClaude } from '../pipeline/claude.ts'
import { loadResource } from '../pipeline/resources.ts'
import type { Channel } from '../pipeline/transcript.ts'
import { callBita, type BitaCalling } from './client.ts'
import { meetingDay } from './wrapup.ts'

export interface ProposalQuote {
  startMs: number
  channel: Channel
  text: string
}

export type ProposalStatus = 'pending' | 'accepted' | 'rejected' | 'stale'

export interface Proposal {
  n: number
  pageId: number
  pageTitle: string
  section: string | null
  title: string
  rationale: string
  quotes: ProposalQuote[]
  branch: string
  sha: string
  status: ProposalStatus
  appliedSha?: string | undefined
  file: string
  updatedAt?: string | undefined
}

export interface DiscardedProposal {
  index: number
  pageId?: number | undefined
  reason: string
}

export interface ProposalsFile {
  entryId: number
  branch: string
  generatedAt: string
  branchDropped: boolean
  proposals: Proposal[]
  discarded: DiscardedProposal[]
}

export interface ProposalDraft {
  pageId: number
  section: string | null
  markdown: string
  title: string
  rationale: string
  quotes: ProposalQuote[]
}

export const REVEALING_PHRASES = [
  'se acordo',
  'acordamos',
  'decidimos',
  'se decidio',
  'por decision de',
  'en la reunion',
  'en la junta',
  'segun lo hablado',
  'como se comento',
  'como se menciono',
  'quedamos en',
  'se platico',
  'la grabacion',
  'la transcripcion',
]

export function revealing(markdown: string): string | null {
  const folded = fold(markdown)
  return REVEALING_PHRASES.find((phrase) => folded.includes(phrase)) ?? null
}

export function cleanHeading(heading: string): string {
  return trimmed(trimmed(heading).replace(/^#+/, ''))
}

export function stripLeadingHeading(markdown: string, section: string | null): string {
  if (section === null) return markdown
  const lines = markdown.split('\n')
  const first = lines[0]
  if (first === undefined || !first.startsWith('#') || fold(cleanHeading(first)) !== fold(section)) return markdown
  return trimmed(lines.slice(1).join('\n'))
}

function intOf(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isInteger(value)) return value
  if (typeof value === 'string' && /^[+-]?\d+$/.test(value)) return Number(value)
  return undefined
}

function quoteOf(item: unknown): ProposalQuote | null {
  if (!isRecord(item) || typeof item['text'] !== 'string') return null
  const text = trimmed(item['text'])
  if (text.length === 0) return null
  const raw = item['startMs']
  const startMs = typeof raw === 'number' && Number.isFinite(raw) ? Math.trunc(raw) : 0
  const channel = fold(typeof item['channel'] === 'string' ? item['channel'] : 'mic')
  return { startMs: Math.max(0, startMs), channel: ['system', 'remotos', 'remoto'].includes(channel) ? 'system' : 'mic', text }
}

export function parseProposalPlan(text: string, candidates: ReadonlySet<number>): { drafts: ProposalDraft[]; discarded: DiscardedProposal[] } {
  const object = extractBetween(text, '{', '}')
  if (!isRecord(object) || !Array.isArray(object['proposals'])) {
    throw new RecapError('PROPOSALS_OUTPUT', `The proposals answer has no {"proposals": [...]} object: ${prefix(text, 200)}`)
  }
  const drafts: ProposalDraft[] = []
  const discarded: DiscardedProposal[] = []
  const seen = new Set<string>()
  object['proposals'].forEach((raw, index) => {
    if (!isRecord(raw)) {
      discarded.push({ index, reason: 'not an object' })
      return
    }
    const pageId = intOf(raw['pageId'])
    const discard = (reason: string) => discarded.push({ index, pageId, reason })
    if (pageId === undefined) return discard('missing pageId')
    if (!candidates.has(pageId)) return discard(`page ${pageId} is not a candidate`)
    const rawSection = typeof raw['section'] === 'string' ? cleanHeading(raw['section']) : ''
    const section = rawSection.length > 0 ? rawSection : null
    const markdown = trimmed(typeof raw['markdown'] === 'string' ? raw['markdown'] : '')
    const title = prefix(trimmed(typeof raw['title'] === 'string' ? raw['title'] : ''), 160)
    const rationale = trimmed(typeof raw['rationale'] === 'string' ? raw['rationale'] : '')
    if (markdown.length === 0) return discard('empty markdown')
    if (title.length === 0) return discard('empty title')
    const phrase = revealing(markdown)
    if (phrase) return discard(`the markdown reveals the conversation (${phrase})`)
    const quotes = (Array.isArray(raw['quotes']) ? raw['quotes'] : []).map(quoteOf).filter((quote): quote is ProposalQuote => quote !== null)
    if (quotes.length === 0) return discard('no quotes from the transcript')
    const key = `${pageId}|${fold(section ?? '')}`
    if (seen.has(key)) return discard('duplicate change to the same section')
    seen.add(key)
    drafts.push({ pageId, section, markdown: stripLeadingHeading(markdown, section), title, rationale, quotes: quotes.slice(0, 3) })
    return undefined
  })
  return { drafts, discarded }
}

export const proposalStore = {
  file: (dir: string) => path.join(dir, 'proposals.json'),
  markdownDir: (dir: string) => path.join(dir, 'proposals'),
  markdownFile: (dir: string, n: number) => path.join(dir, 'proposals', `${n}.md`),
  branch: (entryId: number) => `proposal/meeting-${entryId}`,
}

function decodeProposal(value: unknown): Proposal | null {
  if (!isRecord(value)) return null
  const { n, pageId, pageTitle, title, rationale, branch, sha, status, file } = value
  if (typeof n !== 'number' || typeof pageId !== 'number' || typeof pageTitle !== 'string' || typeof title !== 'string') return null
  if (typeof rationale !== 'string' || typeof branch !== 'string' || typeof sha !== 'string' || typeof file !== 'string') return null
  if (status !== 'pending' && status !== 'accepted' && status !== 'rejected' && status !== 'stale') return null
  const quotes = Array.isArray(value['quotes']) ? value['quotes'].map(quoteOf).filter((quote): quote is ProposalQuote => quote !== null) : []
  return {
    n,
    pageId,
    pageTitle,
    section: typeof value['section'] === 'string' ? value['section'] : null,
    title,
    rationale,
    quotes,
    branch,
    sha,
    status,
    appliedSha: typeof value['appliedSha'] === 'string' ? value['appliedSha'] : undefined,
    file,
    updatedAt: typeof value['updatedAt'] === 'string' ? value['updatedAt'] : undefined,
  }
}

export function loadProposals(dir: string): ProposalsFile | null {
  const text = readText(proposalStore.file(dir))
  if (text === null) return null
  try {
    const value = JSON.parse(text) as unknown
    if (!isRecord(value) || typeof value['entryId'] !== 'number' || typeof value['branch'] !== 'string' || typeof value['generatedAt'] !== 'string') return null
    if (!Array.isArray(value['proposals'])) return null
    const proposals = value['proposals'].map(decodeProposal)
    if (proposals.some((proposal) => proposal === null)) return null
    const discarded = Array.isArray(value['discarded'])
      ? value['discarded'].filter(isRecord).map((item) => ({ index: Number(item['index']), pageId: typeof item['pageId'] === 'number' ? item['pageId'] : undefined, reason: String(item['reason'] ?? '') }))
      : []
    return {
      entryId: value['entryId'],
      branch: value['branch'],
      generatedAt: value['generatedAt'],
      branchDropped: value['branchDropped'] === true,
      proposals: proposals as Proposal[],
      discarded,
    }
  } catch {
    return null
  }
}

function encodeProposal(proposal: Proposal): Record<string, unknown> {
  return {
    n: proposal.n,
    pageId: proposal.pageId,
    pageTitle: proposal.pageTitle,
    section: proposal.section,
    title: proposal.title,
    rationale: proposal.rationale,
    quotes: proposal.quotes.map((quote) => ({ startMs: quote.startMs, channel: quote.channel, text: quote.text })),
    branch: proposal.branch,
    sha: proposal.sha,
    status: proposal.status,
    appliedSha: proposal.appliedSha,
    file: proposal.file,
    updatedAt: proposal.updatedAt,
  }
}

export function proposalJson(proposal: Proposal): Record<string, unknown> {
  return encodeProposal(proposal)
}

export function saveProposals(file: ProposalsFile, dir: string): void {
  writeAtomic(
    proposalStore.file(dir),
    swiftPretty({
      entryId: file.entryId,
      branch: file.branch,
      generatedAt: file.generatedAt,
      branchDropped: file.branchDropped,
      proposals: file.proposals.map(encodeProposal),
      discarded: file.discarded.map((item) => ({ index: item.index, pageId: item.pageId, reason: item.reason })),
    }),
  )
}

export async function propose(bita: BitaCalling, branch: string, pageId: number, section: string | null, file: string, reason: string, entryId: number): Promise<string> {
  const args = ['docs', 'propose', '--branch', branch, String(pageId), '--md', file]
  if (section !== null) args.push('--section', section)
  args.push('--reason', reason, '--source', `meeting:${entryId}`)
  const data = await callBita(bita, args)
  const sha = isRecord(data) && typeof data['sha'] === 'string' ? data['sha'] : ''
  if (sha.length === 0) throw new RecapError('BITA_FAILED', 'bita docs propose did not return the commit sha')
  return sha
}

export function ownPageId(meeting: Meeting): number | undefined {
  return meeting.wrapup?.pageId ?? meeting.bitaEntry?.pageIds[0]
}

export type ClaudeAsk = (prompt: string, addDirs: string[]) => Promise<string>

export class ProposalGenerator {
  readonly config: Config
  readonly bita: BitaCalling
  readonly log: (line: string) => void
  readonly claude: ClaudeAsk

  constructor(config: Config, bita: BitaCalling, log: (line: string) => void, claude?: ClaudeAsk) {
    this.config = config
    this.bita = bita
    this.log = log
    this.claude =
      claude ??
      (async (prompt, dirs) =>
        resultText(await runClaude({ prompt, cwd: dirs[dirs.length - 1] ?? home(), config, tools: ['Read Grep Glob'], addDirs: dirs, model: config.summaryModel })))
  }

  async candidates(meeting: Meeting, context: ProjectContext): Promise<PageRef[]> {
    const own = ownPageId(meeting)
    const pages = [...context.pages]
    const known = new Set(pages.map((page) => page.pageId))
    for (const pageId of meeting.bitaEntry?.pageIds ?? []) {
      if (known.has(pageId) || pageId === own) continue
      const response = await this.bita.invoke(['docs', 'page', 'show', String(pageId), '--no-markdown']).catch(() => null)
      if (!response?.ok || !isRecord(response.data) || typeof response.data['title'] !== 'string') continue
      pages.push({ pageId, title: response.data['title'], relPath: typeof response.data['relPath'] === 'string' ? response.data['relPath'] : '', depth: 0 })
      known.add(pageId)
    }
    return pages.filter((page) => page.pageId !== own)
  }

  async run(meeting: Meeting, dir: string): Promise<ProposalsFile | null> {
    const entryId = meeting.bitaEntryId
    if (entryId === undefined) return null
    const branch = proposalStore.branch(entryId)
    const existing = loadProposals(dir)
    if (existing) {
      if (existing.proposals.some((proposal) => proposal.status !== 'pending')) {
        this.log(`proposals: already reviewed, keeping ${existing.proposals.length}`)
        return existing
      }
      if (existing.proposals.length > 0) await this.bita.invoke(['docs', 'branch', 'drop', branch]).catch(() => null)
    }
    const context = await loadProjectContext(await meetingProject(meeting, this.bita), meeting.bitaDocsRoot, this.bita)
    const pages = await this.candidates(meeting, context)
    const file: ProposalsFile = { entryId, branch, generatedAt: isoNow(), branchDropped: false, proposals: [], discarded: [] }
    if (pages.length === 0 || context.docsRoot === null) {
      this.log('proposals: no candidate pages')
      saveProposals(file, dir)
      return file
    }
    const transcript = readText(path.join(dir, 'transcript.md'))
    if (transcript === null) throw new RecapError('NO_TRANSCRIPT', `"${meeting.title}" has no transcript yet`)
    const prompt = this.render(meeting, context.docsRoot, pages, transcript)
    const answer = await this.claude(prompt, [context.docsRoot, dir])
    const parsed = parseProposalPlan(answer, new Set(pages.map((page) => page.pageId)))
    file.discarded = parsed.discarded
    for (const item of parsed.discarded) this.log(`proposals: discarded #${item.index}: ${item.reason}`)
    rmSync(proposalStore.markdownDir(dir), { recursive: true, force: true })
    if (parsed.drafts.length > 0) mkdirSync(proposalStore.markdownDir(dir), { recursive: true })
    const titles = new Map<number, string>()
    for (const page of pages) if (!titles.has(page.pageId)) titles.set(page.pageId, page.title)
    const failures: string[] = []
    for (const draft of parsed.drafts) {
      const n = file.proposals.length + 1
      const markdownFile = proposalStore.markdownFile(dir, n)
      writeAtomic(markdownFile, `${draft.markdown}\n`)
      try {
        const sha = await propose(this.bita, branch, draft.pageId, draft.section, markdownFile, draft.title, entryId)
        file.proposals.push({
          n,
          pageId: draft.pageId,
          pageTitle: titles.get(draft.pageId) ?? `#${draft.pageId}`,
          section: draft.section,
          title: draft.title,
          rationale: draft.rationale,
          quotes: draft.quotes,
          branch,
          sha,
          status: 'pending',
          file: markdownFile,
          updatedAt: isoNow(),
        })
      } catch (error) {
        rmSync(markdownFile, { force: true })
        const message = errorMessage(error)
        failures.push(message)
        this.log(`proposals: page #${draft.pageId} failed: ${message}`)
      }
    }
    saveProposals(file, dir)
    this.log(`proposals: ${file.proposals.length} on ${branch}`)
    if (file.proposals.length === 0 && failures[0]) throw new RecapError('PROPOSALS_FAILED', failures[0])
    return file
  }

  render(meeting: Meeting, docsRoot: string, pages: readonly PageRef[], transcript: string): string {
    const list = pages.map((page) => `  - #${page.pageId} «${page.title}» — ${path.join(docsRoot, page.relPath)}`).join('\n')
    const speakers =
      meeting.mode === 'remote'
        ? 'Hablantes: «Sala» es el micrófono local; «Remotos» es el audio de la llamada.'
        : 'Hablantes: un solo micrófono en la sala, sin separación por persona.'
    let text = loadResource('proposals-prompt.md')
    text = replaceAll(text, '{{title}}', meeting.bitaEntry?.title ?? meeting.title)
    text = replaceAll(text, '{{date}}', meetingDay(meeting))
    text = replaceAll(text, '{{mode}}', meeting.mode === 'remote' ? 'remota' : 'presencial')
    text = replaceAll(text, '{{speakers}}', speakers)
    text = replaceAll(text, '{{docsRoot}}', docsRoot)
    text = replaceAll(text, '{{pages}}', list)
    text = replaceAll(text, '{{transcript}}', transcript)
    return text
  }
}

export class ProposalReview {
  readonly dir: string
  readonly bita: BitaCalling

  constructor(dir: string, bita: BitaCalling) {
    this.dir = dir
    this.bita = bita
  }

  list(): Proposal[] {
    return loadProposals(this.dir)?.proposals ?? []
  }

  proposal(n: number): Proposal {
    const file = loadProposals(this.dir)
    if (!file) throw new RecapError('NO_PROPOSALS', 'The meeting has no proposals')
    const found = file.proposals.find((item) => item.n === n)
    if (!found) throw new RecapError('PROPOSAL_NOT_FOUND', `There is no proposal ${n}`)
    return found
  }

  async diff(proposal: Proposal): Promise<unknown> {
    const response = await this.bita.invoke(['docs', 'branch', 'diff', proposal.branch, '--commit', proposal.sha]).catch(() => null)
    return response?.ok ? response.data : null
  }

  private load(): ProposalsFile {
    const file = loadProposals(this.dir)
    if (!file) throw new RecapError('NO_PROPOSALS', 'The meeting has no proposals')
    return file
  }

  private find(n: number, file: ProposalsFile): Proposal {
    const found = file.proposals.find((item) => item.n === n)
    if (!found) throw new RecapError('PROPOSAL_NOT_FOUND', `There is no proposal ${n}`)
    return { ...found }
  }

  private async store(proposal: Proposal, file: ProposalsFile): Promise<void> {
    const index = file.proposals.findIndex((item) => item.n === proposal.n)
    if (index !== -1) file.proposals[index] = proposal
    if (!file.branchDropped && !file.proposals.some((item) => item.status === 'pending')) {
      const response = await this.bita.invoke(['docs', 'branch', 'drop', file.branch]).catch(() => null)
      file.branchDropped = response?.ok === true
    }
    saveProposals(file, this.dir)
  }

  accept(n: number, editedMarkdown?: string): Promise<Proposal> {
    return withDirectoryLockAsync(path.join(this.dir, '.proposals.lockdir'), async () => {
      const file = this.load()
      const proposal = this.find(n, file)
      if (proposal.status !== 'pending' && proposal.status !== 'stale') throw new RecapError('PROPOSAL_CLOSED', `Proposal ${n} is already ${proposal.status}`)
      const target = proposal.file
      if (editedMarkdown !== undefined) {
        const text = readText(editedMarkdown)
        if (text === null) throw new RecapError('FILE_UNREADABLE', `Cannot read ${editedMarkdown}`)
        if (trimmed(text).length === 0) throw new RecapError('EMPTY_MARKDOWN', `${editedMarkdown} is empty`)
        mkdirSync(path.dirname(target), { recursive: true })
        if (path.resolve(editedMarkdown) !== path.resolve(target)) writeAtomic(target, text)
      }
      if (editedMarkdown !== undefined || file.branchDropped) {
        proposal.sha = await propose(this.bita, proposal.branch, proposal.pageId, proposal.section, target, proposal.title, file.entryId)
        file.branchDropped = false
      }
      const response = await this.bita.invoke(['docs', 'branch', 'apply', proposal.branch, '--commit', proposal.sha])
      if (response.ok) {
        proposal.status = 'accepted'
        const data = isRecord(response.data) ? response.data : {}
        proposal.appliedSha = typeof data['appliedSha'] === 'string' ? data['appliedSha'] : typeof data['sha'] === 'string' ? data['sha'] : undefined
      } else if (response.errorCode === 'MERGE_CONFLICT') {
        proposal.status = 'stale'
      } else {
        throw new RecapError('BITA_FAILED', `bita docs branch apply failed: ${response.errorMessage ?? 'no reason given'}`)
      }
      proposal.updatedAt = isoNow()
      await this.store(proposal, file)
      return proposal
    })
  }

  reject(n: number): Promise<Proposal> {
    return withDirectoryLockAsync(path.join(this.dir, '.proposals.lockdir'), async () => {
      const file = this.load()
      const proposal = this.find(n, file)
      if (proposal.status !== 'pending' && proposal.status !== 'stale') throw new RecapError('PROPOSAL_CLOSED', `Proposal ${n} is already ${proposal.status}`)
      proposal.status = 'rejected'
      proposal.updatedAt = isoNow()
      await this.store(proposal, file)
      return proposal
    })
  }
}
