import { hasVideo } from '../media/media.ts'
import type { Meeting, StageState } from '../core/meeting.ts'

export const STAGES = ['audio', 'transcribe', 'frames', 'summarize', 'proposals', 'wrapup'] as const
export type Stage = (typeof STAGES)[number]

export function isStage(value: string): value is Stage {
  return (STAGES as readonly string[]).includes(value)
}

export function stageApplies(stage: Stage, meeting: Meeting): boolean {
  if (stage === 'frames') return meeting.mode === 'remote'
  if (stage === 'wrapup' || stage === 'proposals') return meeting.bitaEntryId !== undefined
  return true
}

export function stageSkipped(stage: Stage, meeting: Meeting, dir: string): boolean {
  return stage === 'frames' && !hasVideo(dir, meeting.mode)
}

export function stageIsOptional(stage: Stage): boolean {
  return stage === 'proposals'
}

export function stageComplete(state: StageState | undefined): boolean {
  return state?.status === 'done' || state?.status === 'skipped'
}

export function stageSatisfied(stage: Stage, state: StageState | undefined): boolean {
  return stageComplete(state) || (stageIsOptional(stage) && state?.status === 'failed')
}

export function allStagesSatisfied(meeting: Meeting): boolean {
  return STAGES.filter((stage) => stageApplies(stage, meeting)).every((stage) => stageSatisfied(stage, meeting.stages[stage]))
}
