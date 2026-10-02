import ArgumentParser
import Darwin
import Foundation

struct StartCommand: ParsableCommand {
    static let configuration = CommandConfiguration(
        commandName: "start",
        abstract: "Start recording a meeting in the background."
    )

    @Flag(exclusivity: .exclusive, help: "Remote meeting (screen, system audio and microphone) or in-person meeting (microphone only).")
    var mode: ModeFlag?

    @Argument(help: "Meeting title.")
    var title: [String] = []

    @Option(help: "ID of the display to record (remote mode only).")
    var display: UInt32?

    @Option(name: .customLong("bita-entry"), help: "bita entry this meeting belongs to.")
    var bitaEntry: Int?

    @Option(help: "Seconds to wait for the recorder to confirm it started.")
    var timeout: Double = 60

    @OptionGroup var output: OutputOptions

    func run() throws {
        try Output.run("start", json: output.json) {
            guard let mode else {
                throw RecapError("MODE_REQUIRED", "Choose --remote or --in-person")
            }
            let record = try Recording.start(title: title.joined(separator: " "), mode: mode.meetingMode,
                                             display: display, bitaEntryId: bitaEntry, timeout: timeout)
            return (record, "Recording \(record.meeting.mode.rawValue) meeting \"\(record.meeting.title)\"\n\(record.dir.path)")
        }
    }
}

enum ModeFlag: String, EnumerableFlag {
    case remote
    case inPerson

    static func name(for value: ModeFlag) -> NameSpecification {
        switch value {
        case .remote: .customLong("remote")
        case .inPerson: .customLong("in-person")
        }
    }

    var meetingMode: MeetingMode {
        switch self {
        case .remote: .remote
        case .inPerson: .inPerson
        }
    }
}

struct StopCommand: ParsableCommand {
    static let configuration = CommandConfiguration(
        commandName: "stop",
        abstract: "Stop the active recording."
    )

    @Option(help: "Seconds to wait for the recorder to close the file.")
    var timeout: Double = 60

    @OptionGroup var output: OutputOptions

    func run() throws {
        try Output.run("stop", json: output.json) {
            let record = try Recording.stop(timeout: timeout)
            let duration = Duration.format(record.meeting.durationSeconds)
            return (record, "Stopped \"\(record.meeting.title)\" after \(duration)\n\(record.dir.path)")
        }
    }
}

struct DiscardCommand: ParsableCommand {
    static let configuration = CommandConfiguration(
        commandName: "discard",
        abstract: "Stop the active recording, or remove a meeting, and delete its files."
    )

    @Argument(help: "Meeting to delete. Defaults to the active recording.")
    var meeting: String?

    @Option(name: .customLong("bita-entry"), help: "Delete the meeting linked to this bita entry.")
    var bitaEntry: Int?

    @OptionGroup var output: OutputOptions

    func run() throws {
        try Output.run("discard", json: output.json) {
            let record = try Recording.discard(reference: meeting, bitaEntryId: bitaEntry)
            return (record, "Discarded \"\(record.meeting.title)\"")
        }
    }
}

enum Recording {
    static func start(title: String, mode: MeetingMode, display: UInt32?, bitaEntryId: Int?, timeout: Double) throws -> MeetingRecord {
        if let (_, meeting) = ActiveRecording.current() {
            throw RecapError("ALREADY_RECORDING", "\"\(meeting.title)\" is already being recorded. Stop it first.")
        }
        let config = try Config.load()
        let store = MeetingStore(config: config)
        let resolvedTitle = title.isEmpty ? defaultTitle(mode) : title
        let (meeting, dir) = try store.create(title: resolvedTitle, mode: mode, display: display, bitaEntryId: bitaEntryId)
        try RecorderLauncher.launch(dir: dir)

        var current = meeting
        let settled = ProcessCheck.waitUntil(timeout: timeout) {
            current = (try? MeetingFile.load(dir)) ?? current
            return current.status != .starting
        }
        if current.status == .failed {
            throw RecapError("RECORDER_FAILED", current.error ?? "The recorder failed to start. See \(dir.appending(path: "recorder.log").path)")
        }
        guard settled, current.status == .recording else {
            if let pid = current.recorderPid { kill(pid, SIGKILL) }
            _ = try? MeetingFile.update(dir) {
                $0.status = .failed
                $0.error = "The recorder did not confirm within \(Int(timeout))s"
            }
            throw RecapError("RECORDER_TIMEOUT", "The recorder did not start within \(Int(timeout))s. Check the permissions with `recap setup`.")
        }
        try ActiveRecording(meetingId: current.id, dir: dir.path, mode: mode, startedAt: current.startedAt ?? Date()).save()
        return MeetingRecord(meeting: current, dir: dir)
    }

    static func stop(timeout: Double) throws -> MeetingRecord {
        guard let (active, meeting) = ActiveRecording.current() else {
            throw RecapError("NOT_RECORDING", "There is no active recording")
        }
        let dir = active.dirURL
        let final = try stopRecorder(meeting: meeting, dir: dir, timeout: timeout)
        ActiveRecording.clear()
        return MeetingRecord(meeting: final, dir: dir)
    }

    static func discard(reference: String?, bitaEntryId: Int?) throws -> MeetingRecord {
        let config = try Config.load()
        let store = MeetingStore(config: config)
        let target: (Meeting, URL)
        if let bitaEntryId {
            guard let found = store.find(bitaEntryId: bitaEntryId) else {
                throw RecapError("MEETING_NOT_FOUND", "No meeting is linked to bita entry \(bitaEntryId)")
            }
            target = found
        } else if let reference {
            target = try store.resolve(reference)
        } else if let (active, meeting) = ActiveRecording.current() {
            target = (meeting, active.dirURL)
        } else {
            throw RecapError("NOT_RECORDING", "There is no active recording. Pass the meeting to delete.")
        }
        let (meeting, dir) = target
        if let pid = meeting.recorderPid, ProcessCheck.isAlive(pid) {
            _ = try? stopRecorder(meeting: meeting, dir: dir, timeout: 15)
        }
        if ActiveRecording.load()?.meetingId == meeting.id { ActiveRecording.clear() }
        try FileManager.default.removeItem(at: dir)
        return MeetingRecord(meeting: meeting, dir: dir)
    }

    private static func stopRecorder(meeting: Meeting, dir: URL, timeout: Double) throws -> Meeting {
        guard let pid = meeting.recorderPid else {
            throw RecapError("RECORDER_UNKNOWN", "The recorder process for \"\(meeting.title)\" is unknown")
        }
        kill(pid, SIGINT)
        var current = meeting
        let stopped = ProcessCheck.waitUntil(timeout: timeout) {
            current = (try? MeetingFile.load(dir)) ?? current
            return current.status == .recorded || current.status == .failed || !ProcessCheck.isAlive(pid)
        }
        if !stopped {
            kill(pid, SIGKILL)
        }
        if current.status == .recording || current.status == .starting {
            current = try MeetingFile.update(dir) {
                $0.status = FileManager.default.fileExists(atPath: dir.appending(path: $0.mode.recordingFileName).path) ? .recorded : .failed
                $0.endedAt = Date()
                $0.recorderPid = nil
                $0.error = "The recorder exited without closing the file cleanly"
            }
        }
        return current
    }

    private static func defaultTitle(_ mode: MeetingMode) -> String {
        switch mode {
        case .remote: "Remote meeting"
        case .inPerson: "In-person meeting"
        }
    }
}

struct RecordCommand: ParsableCommand {
    static let configuration = CommandConfiguration(
        commandName: "record",
        abstract: "Run the recorder in the foreground (used internally by start).",
        shouldDisplay: false
    )

    @Argument(help: "Meeting directory.")
    var dir: String

    func run() throws {
        RecordingController(dir: URL(fileURLWithPath: dir)).run()
    }
}
