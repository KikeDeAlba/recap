import { existsSync, mkdirSync, readdirSync, renameSync, rmSync } from 'node:fs'
import { cpus } from 'node:os'
import path from 'node:path'
import type { Config } from '../core/config.ts'
import { settingsOf, transcriptionLanguage, vadModelPath, whisperModelPath } from '../core/config.ts'
import { clock, isoNow } from '../core/dates.ts'
import { readText, writeAtomic } from '../core/fsutil.ts'
import { encodeJson, swiftDefault } from '../core/json.ts'
import { ProcessLock } from '../core/lock.ts'
import { isActiveStatus, loadMeeting, recordingPath, updateMeeting, type Meeting } from '../core/meeting.ts'
import { exec } from '../core/proc.ts'
import { suffix, trimmed } from '../core/text.ts'
import { requireTool } from '../core/tools.ts'
import { RecapError, errorMessage } from '../errors.ts'
import { INKWELL_CAPABILITIES, StageSkipped, inkwellForStage } from '../bita/client.ts'
import { ProposalGenerator } from '../bita/proposals.ts'
import { runWrapup } from '../bita/wrapup.ts'
import { runSummaryClaude } from './claude.ts'
import { STAGES, allStagesSatisfied, stageApplies, stageComplete, stageIsOptional, stageSkipped, type Stage } from './stages.ts'
import { extractSummary, saveSummary, summaryPromptFor, type FrameInfo } from './summary.ts'
import { mergeTranscripts, orderedSegment, parseWhisper, transcriptMarkdown, type Channel, type Segment } from './transcript.ts'

export const MAX_FRAMES = 40

export function whisperThreads(): number {
  return Math.max(2, Math.min(8, cpus().length - 2))
}

export function showinfoTimes(log: string): number[] {
  const times: number[] = []
  for (const line of log.split('\n')) {
    if (!line.includes('Parsed_showinfo')) continue
    const index = line.indexOf('pts_time:')
    if (index === -1) continue
    const value = Number(line.slice(index + 'pts_time:'.length).split(/\s/)[0])
    if (Number.isFinite(value)) times.push(value)
  }
  return times
}

export function evenlySpaced(count: number, limit: number): number[] {
  if (count <= limit || limit <= 1) return Array.from({ length: count }, (_, index) => index)
  return Array.from({ length: limit }, (_, index) => Math.round((index * (count - 1)) / (limit - 1)))
}

export function channelsOf(meeting: Meeting): [Channel, number][] {
  return meeting.mode === 'remote'
    ? [
        ['mic', 0],
        ['system', 1],
      ]
    : [['mic', 0]]
}

export function whisperArguments(config: Config, model: string, outputBase: string, wav: string, threads: number, previous?: string | null): string[] {
  const args = ['-m', model, '-l', transcriptionLanguage(config), '-t', String(threads), '-oj', '-of', outputBase, '-np', '-sns']
  const prompt: string[] = []
  if (config.vocabulary && config.vocabulary.length > 0) prompt.push(`Glosario: ${config.vocabulary.join(', ')}.`)
  if (previous && trimmed(previous).length > 0) prompt.push(trimmed(previous))
  if (prompt.length > 0) args.push('--prompt', prompt.join(' '))
  if (existsSync(vadModelPath())) args.push('--vad', '-vm', vadModelPath())
  args.push(wav)
  return args
}

export class Pipeline {
  readonly dir: string
  readonly config: Config
  readonly log: (line: string) => void

  constructor(dir: string, config: Config, log: (line: string) => void) {
    this.dir = dir
    this.config = config
    this.log = log
  }

  private file(name: string): string {
    return path.join(this.dir, name)
  }

  private recording(meeting: Meeting): string {
    return recordingPath(this.dir, meeting.mode)
  }

  private setStage(stage: Stage, status: string, error?: string, extra?: (meeting: Meeting) => void, details: { reason?: string; hint?: string } = {}): Meeting {
    return updateMeeting(this.dir, (current) => {
      current.stages[stage] = { status, updatedAt: isoNow(), ...(error !== undefined ? { error } : {}), ...details }
      extra?.(current)
    })
  }

  async run(from?: Stage, only?: Stage): Promise<Meeting> {
    let meeting = loadMeeting(this.dir)
    if (isActiveStatus(meeting.status)) throw new RecapError('STILL_RECORDING', `"${meeting.title}" is still being recorded`)
    if (!existsSync(this.recording(meeting))) throw new RecapError('NO_RECORDING', `"${meeting.title}" has no recording`)
    const lock = new ProcessLock(this.file('process.lock'))
    try {
      meeting = updateMeeting(this.dir, (current) => {
        current.status = 'processing'
      })
      let forced = false
      for (const stage of STAGES) {
        if (!stageApplies(stage, meeting)) continue
        if (only !== undefined && stage !== only) continue
        if (stage === from) forced = true
        if (stage === 'proposals' && !settingsOf(this.config).proposals) {
          meeting = this.setStage(stage, 'skipped')
          this.log(`${stage}: skipped, live.proposals is off`)
          continue
        }
        if (stageSkipped(stage, meeting, this.dir)) {
          if (stageComplete(meeting.stages[stage])) {
            this.log(`${stage}: already done`)
            continue
          }
          meeting = this.setStage(stage, 'skipped')
          this.log(`${stage}: skipped, the recording has no video`)
          continue
        }
        const done = meeting.stages[stage]?.status === 'done'
        if (done && !forced && only === undefined) {
          this.log(`${stage}: already done`)
          continue
        }
        this.log(`${stage}: running`)
        const began = Date.now()
        try {
          await this.execute(stage, meeting)
          meeting = this.setStage(stage, 'done')
          this.log(`${stage}: done in ${Math.trunc((Date.now() - began) / 1000)}s`)
        } catch (error) {
          const message = error instanceof RecapError ? error.message : errorMessage(error)
          if (error instanceof StageSkipped) {
            meeting = this.setStage(stage, 'skipped', undefined, undefined, { reason: message, ...(error.hint !== undefined ? { hint: error.hint } : {}) })
            this.log(`${stage}: skipped, ${message}${error.hint !== undefined ? ` (${error.hint})` : ''}`)
            continue
          }
          if (stageIsOptional(stage)) {
            meeting = this.setStage(stage, 'failed', message)
            this.log(`${stage}: failed, continuing: ${message}`)
            continue
          }
          meeting = this.setStage(stage, 'failed', message, (current) => {
            current.status = 'recorded'
          })
          this.log(`${stage}: failed: ${message}`)
          throw new RecapError('STAGE_FAILED', `${stage} failed: ${message}`)
        }
      }
      const complete = allStagesSatisfied(meeting)
      return updateMeeting(this.dir, (current) => {
        current.status = complete ? 'processed' : 'recorded'
      })
    } finally {
      lock.release()
    }
  }

  private async execute(stage: Stage, meeting: Meeting): Promise<void> {
    switch (stage) {
      case 'audio':
        return this.extractAudio(meeting)
      case 'transcribe':
        return this.transcribe(meeting)
      case 'frames':
        return this.extractFrames(meeting)
      case 'summarize':
        return this.summarize(meeting)
      case 'proposals':
        return this.proposals(meeting)
      case 'wrapup':
        return runWrapup(meeting, this.dir, this.config, { log: this.log })
    }
  }

  async extractAudio(meeting: Meeting): Promise<void> {
    const ffmpeg = await requireTool('ffmpeg', this.config)
    for (const [channel, index] of channelsOf(meeting)) {
      const result = await exec(ffmpeg, [
        '-hide_banner',
        '-loglevel',
        'error',
        '-y',
        '-i',
        this.recording(meeting),
        '-map',
        `0:a:${index}`,
        '-ac',
        '1',
        '-ar',
        '16000',
        '-c:a',
        'pcm_s16le',
        this.file(`${channel}.wav`),
      ])
      if (result.status !== 0) throw new RecapError('FFMPEG_FAILED', trimmed(result.stderr))
    }
  }

  async transcribe(meeting: Meeting): Promise<void> {
    const whisper = await requireTool('whisper-cli', this.config)
    const model = whisperModelPath(this.config)
    if (!existsSync(model)) throw new RecapError('MODEL_MISSING', `Whisper model not found at ${model}. Run \`recap setup\`.`)
    if (channelsOf(meeting).some(([channel]) => !existsSync(this.file(`${channel}.wav`)))) await this.extractAudio(meeting)
    const byChannel: Partial<Record<Channel, Segment[]>> = {}
    for (const [channel] of channelsOf(meeting)) {
      const base = this.file(`transcript-${channel}`)
      const result = await exec(whisper, whisperArguments(this.config, model, base, this.file(`${channel}.wav`), whisperThreads()))
      if (result.status !== 0) throw new RecapError('WHISPER_FAILED', trimmed(result.stderr))
      const text = readText(`${base}.json`)
      if (text === null) throw new RecapError('WHISPER_FAILED', `whisper-cli did not write ${base}.json`)
      try {
        byChannel[channel] = parseWhisper(text, channel)
      } catch (error) {
        throw new RecapError('WHISPER_FAILED', `Cannot read ${base}.json: ${errorMessage(error)}`)
      }
    }
    const segments = mergeTranscripts(byChannel.mic ?? [], byChannel.system ?? [])
    writeAtomic(this.file('transcript.json'), encodeJson(segments.map(orderedSegment), { pretty: true }))
    writeAtomic(this.file('transcript.md'), transcriptMarkdown(meeting, segments))
  }

  async extractFrames(meeting: Meeting): Promise<void> {
    const ffmpeg = await requireTool('ffmpeg', this.config)
    const framesDir = this.file('frames')
    rmSync(framesDir, { recursive: true, force: true })
    mkdirSync(framesDir, { recursive: true })
    const select = "select='isnan(prev_selected_t)+gt(scene\\,0.15)*gte(t-prev_selected_t\\,20)+gte(t-prev_selected_t\\,300)',showinfo"
    const result = await exec(ffmpeg, [
      '-hide_banner',
      '-y',
      '-i',
      this.recording(meeting),
      '-map',
      '0:v:0',
      '-vf',
      select,
      '-fps_mode',
      'vfr',
      '-q:v',
      '4',
      path.join(framesDir, 'raw-%04d.jpg'),
    ])
    if (result.status !== 0) throw new RecapError('FFMPEG_FAILED', suffix(trimmed(result.stderr), 500))
    const times = showinfoTimes(result.stderr)
    const raw = readdirSync(framesDir)
      .filter((name) => name.startsWith('raw-'))
      .sort()
    const keep = new Set(evenlySpaced(raw.length, MAX_FRAMES))
    const frames: FrameInfo[] = []
    raw.forEach((name, index) => {
      const source = path.join(framesDir, name)
      const time = times[index]
      if (!keep.has(index) || time === undefined) {
        rmSync(source, { force: true })
        return
      }
      const target = `${clock(Math.trunc(time * 1000)).replace(/:/g, '-')}.jpg`
      rmSync(path.join(framesDir, target), { force: true })
      renameSync(source, path.join(framesDir, target))
      frames.push({ file: `frames/${target}`, timeSeconds: time })
    })
    writeAtomic(this.file('frames.json'), swiftDefault(frames.map((frame) => ({ file: frame.file, timeSeconds: frame.timeSeconds }))))
  }

  async summarize(meeting: Meeting): Promise<void> {
    const prompt = summaryPromptFor(meeting, this.dir)
    const output = await runSummaryClaude(prompt, this.dir, this.config)
    saveSummary(extractSummary(output), meeting, this.dir)
  }

  async proposals(meeting: Meeting): Promise<void> {
    const inkwell = await inkwellForStage(INKWELL_CAPABILITIES.proposals)
    await new ProposalGenerator(this.config, inkwell, this.log).run(meeting, this.dir)
  }
}

