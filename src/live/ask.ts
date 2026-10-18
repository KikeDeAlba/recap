import { randomUUID } from 'node:crypto'
import type { Config } from '../core/config.ts'
import { settingsOf } from '../core/config.ts'
import { isoNow, minuteStamp, parseDate } from '../core/dates.ts'
import type { Meeting } from '../core/meeting.ts'
import { replaceAll, trimmed } from '../core/text.ts'
import { RecapError } from '../errors.ts'
import { streamArguments, streamClaude } from '../pipeline/claude.ts'
import { loadResource } from '../pipeline/resources.ts'
import type { Channel, Segment } from '../pipeline/transcript.ts'
import { performAsk, type PerformOptions } from './asking.ts'
import { BRAIN_QUERY_SECONDS, brainAvailable, brainNotesShown, brainQuery, rememberAnswer, renderBrain, searchBrain, type BrainNote, type MeetingStamp } from './brain.ts'
import { existingRepos, type ProjectContext } from './context.ts'
import { appendLines, liveFiles } from './files.ts'
import { loadLiveTranscript, renderLive, transcriptWindow } from './merger.ts'
import { REPO_GIT_SUBCOMMANDS, repoGitAllowed, repoGitPrefix, repoGitRules, runningCommand } from './repo-git.ts'
import { AskStreamReducer, ProgressDescriber, encodeAnswer, type Answer, type AskEvent } from './stream.ts'

export interface AskRequest {
  meeting: Meeting
  dir: string
  question: string | null | undefined
  windowSeconds: number
  now: string
  auto: boolean
  questionMs?: number | undefined
  channel?: Channel | undefined
  askId?: string | undefined
}

export const READ_TOOLS = ['Read', 'Grep', 'Glob']
export const GIT_SUBCOMMANDS: readonly string[] = REPO_GIT_SUBCOMMANDS
export const AVAILABLE_TOOLS = ['Read', 'Grep', 'Glob', 'Bash']

export function gazeBin(context: ProjectContext): string | null {
  return context.project && context.gaze ? context.gaze.bin : null
}

export function allowedTools(context: ProjectContext, self: readonly string[] = runningCommand()): string[] {
  return [...READ_TOOLS, ...repoGitRules(self, existingRepos(context).map((repo) => repo.path))]
}

export function askAddDirs(context: ProjectContext): string[] {
  return [...(context.docsRoot ? [context.docsRoot] : []), ...existingRepos(context).map((repo) => repo.path)]
}

export function renderAskPrompt(template: string, request: AskRequest, context: ProjectContext, segments: readonly Segment[], notes: readonly BrainNote[] = [], self: readonly string[] = runningCommand()): string {
  const window = transcriptWindow(segments, request.windowSeconds)
  const labelled = request.meeting.mode === 'remote'
  const title = request.meeting.bitaEntry?.title ?? request.meeting.title
  const question = request.question ? trimmed(request.question) : ''
  const questionBlock =
    question.length > 0
      ? `La pregunta que hay que responder es:\n\n> ${question}\n\nUsa la transcripción solo como contexto.`
      : 'No te dieron la pregunta: identifícala en la transcripción de abajo. Es la última pregunta dirigida a quien graba (la persona del micrófono «Sala» en reuniones remotas) o la última que quedó sin responder. Si hay varias, responde la más reciente.'
  const pages =
    context.pages.length === 0
      ? '  (sin páginas registradas para este proyecto)'
      : context.pages.map((page) => `  ${'  '.repeat(Math.max(0, page.depth))}- #${page.pageId} ${page.title} — ${page.relPath}`).join('\n')
  const repos = existingRepos(context)
  const git = repoGitPrefix(self)
  const reposText =
    repos.length === 0
      ? '  (sin repositorios registrados)'
      : repos
          .map((repo) =>
            repoGitAllowed(self, repo.path)
              ? `  - ${repo.slug}: ${repo.path} (historial: \`${git} ${repo.path} log|show|diff …\`)`
              : `  - ${repo.slug}: ${repo.path} (sin historial de git; solo Read, Grep y Glob)`,
          )
          .join('\n')
  const speakers = labelled
    ? '«Sala» es el micrófono local (quien graba y quien esté en su sala); «Remotos» es el audio de la llamada.'
    : 'Un solo micrófono en la sala, sin separación por persona.'
  let text = template
  text = replaceAll(text, '{{git}}', git)
  text = replaceAll(text, '{{title}}', title)
  text = replaceAll(text, '{{project}}', context.project ?? 'sin proyecto')
  text = replaceAll(text, '{{now}}', minuteStamp(parseDate(request.now) ?? new Date()))
  text = replaceAll(text, '{{questionBlock}}', questionBlock)
  text = replaceAll(text, '{{docsRoot}}', context.docsRoot ?? '(desconocida)')
  text = replaceAll(text, '{{pages}}', pages)
  text = replaceAll(text, '{{repos}}', reposText)
  text = replaceAll(text, '{{speakers}}', speakers)
  text = replaceAll(text, '{{transcript}}', renderLive(window, labelled))
  text = replaceAll(text, '{{brain}}', renderBrain(brainAvailable(context), notes))
  return text
}

export async function runAsk(
  config: Config,
  request: AskRequest,
  context: ProjectContext,
  emit: (event: AskEvent) => void,
  onSpawn?: (pid: number) => void,
): Promise<AskOutcome> {
  const segments = loadLiveTranscript(request.dir)
  const explicit = request.question && trimmed(request.question).length > 0 ? trimmed(request.question) : null
  if (explicit === null && segments.length === 0) throw new RecapError('NO_QUESTION', 'The live transcript is empty; pass --question')
  const notes = brainAvailable(context) ? await searchBrain(context.gaze, context.project, brainQuery(explicit, transcriptWindow(segments, BRAIN_QUERY_SECONDS))) : []
  const prompt = renderAskPrompt(loadResource('ask-prompt.md'), request, context, segments, notes)
  if (explicit !== null) emit({ type: 'question', text: explicit })
  const describer = new ProgressDescriber(context.docsRoot, existingRepos(context))
  const args = streamArguments([allowedTools(context).join(' ')], askAddDirs(context), settingsOf(config).assistModel, AVAILABLE_TOOLS)
  const reducer = new AskStreamReducer(explicit)
  const result = await streamClaude(
    prompt,
    request.dir,
    config,
    args,
    (line) => {
      for (const event of reducer.consume(line, describer)) emit(event)
    },
    onSpawn,
  )
  const { events, answer } = reducer.finish(result.status, result.stderr, randomUUID().toLowerCase(), request.now, transcriptWindow(segments, request.windowSeconds))
  answer.auto = request.auto ? true : undefined
  if (request.questionMs !== undefined || request.channel !== undefined) {
    answer.questionMs = request.questionMs
    answer.channel = request.channel
  }
  answer.askId = request.askId
  for (const event of events) emit(event)
  answer.answeredAt = isoNow()
  appendLines([encodeAnswer(answer)], liveFiles.answers(request.dir))
  emit({ type: 'done', answer })
  return { answer, context, notesUsed: brainNotesShown(brainAvailable(context), notes) > 0 }
}

export function meetingStamp(meeting: Meeting): MeetingStamp {
  return { title: meeting.bitaEntry?.title ?? meeting.title, createdAt: meeting.createdAt }
}

export interface AskOutcome {
  answer: Answer
  context: ProjectContext
  notesUsed: boolean
}

export type Remember = (context: ProjectContext, answer: Answer, meeting: MeetingStamp, log: (line: string) => void, notesUsed: boolean) => Promise<boolean>

export async function askThenRemember(
  options: PerformOptions,
  meeting: Meeting,
  body: () => Promise<AskOutcome>,
  log: (line: string) => void = () => {},
  remember: Remember = rememberAnswer,
): Promise<Answer> {
  const { answer, context, notesUsed } = await performAsk(options, body)
  await remember(context, answer, meetingStamp(meeting), log, notesUsed).catch(() => false)
  return answer
}
