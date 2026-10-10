import path from 'node:path'
import { exists } from './fsutil.ts'
import { durationSeconds, recordingPath, type Meeting } from './meeting.ts'
import { hasVideo, measureStorage } from '../media/media.ts'
import { liveFiles, readLines } from '../live/files.ts'
import { decodeAnswer, encodeAnswer } from '../live/stream.ts'
import { loadProposals, proposalJson } from '../bita/proposals.ts'

function existing(dir: string, name: string): string | undefined {
  const file = path.join(dir, name)
  return exists(file) ? file : undefined
}

export function meetingRecord(meeting: Meeting, dir: string, detailed = false): Record<string, unknown> {
  const recording = recordingPath(dir, meeting.mode)
  const live = liveFiles.transcript(dir)
  const record: Record<string, unknown> = {
    id: meeting.id,
    title: meeting.title,
    mode: meeting.mode,
    status: meeting.status,
    createdAt: meeting.createdAt,
    startedAt: meeting.startedAt,
    endedAt: meeting.endedAt,
    durationSeconds: durationSeconds(meeting),
    bitaEntryId: meeting.bitaEntryId,
    bitaEntry: meeting.bitaEntry,
    wrapup: meeting.wrapup,
    error: meeting.error,
    stages: meeting.stages,
    dir,
    recording: existing(dir, path.basename(recording)),
    hasVideo: hasVideo(dir, meeting.mode),
    storage: measureStorage(dir, meeting.mode),
    video: meeting.video,
    videoRemovedAt: meeting.videoRemovedAt,
    transcript: existing(dir, 'transcript.md'),
    summary: existing(dir, 'summary.md'),
    transcriptSegments: existing(dir, 'transcript.json'),
    frames: existing(dir, 'frames.json'),
    liveTranscript: exists(live) ? live : null,
  }
  if (detailed) {
    record['answers'] = readLines(liveFiles.answers(dir), decodeAnswer).map(encodeAnswer)
    record['proposals'] = (loadProposals(dir)?.proposals ?? []).map(proposalJson)
  }
  return record
}
