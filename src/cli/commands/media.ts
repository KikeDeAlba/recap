import { loadConfig } from '../../core/config.ts'
import { MeetingStore, resolveTarget } from '../../core/meeting.ts'
import { meetingRecord } from '../../core/record.ts'
import { formatBytes } from '../../core/text.ts'
import { usageError } from '../../errors.ts'
import { VIDEO_PRESETS, pathSize, type VideoPreset } from '../../media/media.ts'
import { compressVideo, deleteMeeting, pruneMeeting, stripVideo } from '../../media/operations.ts'
import { parseArgs } from '../args.ts'
import { output } from '../output.ts'

export async function stripVideoCommand(argv: string[]): Promise<number> {
  return output('strip-video', argv.includes('--json'), async () => {
    const args = parseArgs(argv, { booleans: ['prune-intermediates'], values: ['bita-entry'], maxPositionals: 1 })
    const config = loadConfig()
    const { meeting, dir } = resolveTarget(new MeetingStore(config), args.positionals[0], args.int('bita-entry'))
    const before = pathSize(dir)
    const updated = await stripVideo(config, meeting, dir, args.has('prune-intermediates'))
    return { data: meetingRecord(updated, dir), text: `Removed the video from "${updated.title}": ${formatBytes(before)} -> ${formatBytes(pathSize(dir))}` }
  })
}

export async function compressVideoCommand(argv: string[]): Promise<number> {
  return output('compress-video', argv.includes('--json'), async () => {
    const args = parseArgs(argv, { booleans: ['prune-intermediates'], values: ['bita-entry', 'preset'], maxPositionals: 1 })
    const preset = args.value('preset')
    if (!preset || !(VIDEO_PRESETS as string[]).includes(preset)) throw usageError(`--preset takes one of ${VIDEO_PRESETS.join(', ')}`)
    const config = loadConfig()
    const { meeting, dir } = resolveTarget(new MeetingStore(config), args.positionals[0], args.int('bita-entry'))
    const before = pathSize(dir)
    const updated = await compressVideo(config, meeting, dir, preset as VideoPreset, args.has('prune-intermediates'))
    return { data: meetingRecord(updated, dir), text: `Compressed the video of "${updated.title}" (${preset}): ${formatBytes(before)} -> ${formatBytes(pathSize(dir))}` }
  })
}

export async function pruneCommand(argv: string[]): Promise<number> {
  return output('prune', argv.includes('--json'), () => {
    const args = parseArgs(argv, { booleans: ['intermediates'], values: ['bita-entry'], maxPositionals: 1 })
    if (!args.has('intermediates')) throw usageError('Choose what to prune: --intermediates')
    const config = loadConfig()
    const { meeting, dir } = resolveTarget(new MeetingStore(config), args.positionals[0], args.int('bita-entry'))
    const before = pathSize(dir)
    const updated = pruneMeeting(meeting, dir)
    return { data: meetingRecord(updated, dir), text: `Pruned "${updated.title}": ${formatBytes(before)} -> ${formatBytes(pathSize(dir))}` }
  })
}

export async function deleteCommand(argv: string[]): Promise<number> {
  return output('delete', argv.includes('--json'), () => {
    const args = parseArgs(argv, { values: ['bita-entry'], maxPositionals: 1 })
    const config = loadConfig()
    const { meeting, dir } = resolveTarget(new MeetingStore(config), args.positionals[0], args.int('bita-entry'))
    const deleted = deleteMeeting(meeting, dir)
    return { data: deleted, text: `Deleted "${meeting.title}", freed ${formatBytes(deleted.freedBytes)}` }
  })
}
