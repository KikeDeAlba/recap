import { loadConfig } from '../../core/config.ts'
import { isoNow } from '../../core/dates.ts'
import { isDirectory } from '../../core/fsutil.ts'
import { MeetingStore } from '../../core/meeting.ts'
import { describeError } from '../../errors.ts'
import { LiveWorker, makeLiveDetector } from '../../live/worker.ts'

export async function liveWorkerCommand(argv: string[]): Promise<number> {
  const log = (message: string) => process.stderr.write(`${isoNow()} ${message}\n`)
  try {
    const reference = argv.find((arg) => !arg.startsWith('--'))
    if (!reference) throw new Error('Usage: recap live-worker <meeting dir or id>')
    const config = loadConfig()
    const dir = isDirectory(reference) ? reference : new MeetingStore(config).resolve(reference).dir
    const worker = new LiveWorker(dir, config, log, { detectorFactory: (meetingDir, meeting) => makeLiveDetector(meetingDir, meeting, config, log) })
    await worker.run()
    return 0
  } catch (error) {
    log(`live worker failed: ${describeError(error)}`)
    return 1
  }
}
