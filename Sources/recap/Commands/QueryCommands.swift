import ArgumentParser
import Foundation

struct StatusData: Encodable {
    let recording: Bool
    let active: MeetingRecord?
    let elapsedSeconds: Int?
    let latest: MeetingRecord?
}

struct StatusCommand: ParsableCommand {
    static let configuration = CommandConfiguration(
        commandName: "status",
        abstract: "Show the active recording and the latest meeting."
    )

    @OptionGroup var output: OutputOptions

    func run() throws {
        try Output.run("status", json: output.json) {
            let store = MeetingStore(config: try Config.load())
            if let (active, meeting) = ActiveRecording.current() {
                let elapsed = meeting.durationSeconds
                let data = StatusData(recording: true, active: MeetingRecord(meeting: meeting, dir: active.dirURL),
                                      elapsedSeconds: elapsed, latest: nil)
                return (data, "Recording \(meeting.mode.rawValue) meeting \"\(meeting.title)\" for \(Duration.format(elapsed))\n\(active.dir)")
            }
            let latest = store.all().first.map { MeetingRecord(meeting: $0.0, dir: $0.1) }
            var text = "Not recording"
            if let latest {
                text += "\nLatest: \(latest.meeting.id) [\(latest.meeting.status.rawValue)] \"\(latest.meeting.title)\""
            }
            return (StatusData(recording: false, active: nil, elapsedSeconds: nil, latest: latest), text)
        }
    }
}

struct ListCommand: ParsableCommand {
    static let configuration = CommandConfiguration(
        commandName: "list",
        abstract: "List recorded meetings, newest first."
    )

    @Option(help: "Maximum number of meetings to show; 0 shows them all.")
    var limit: Int = 20

    @OptionGroup var output: OutputOptions

    func run() throws {
        try Output.run("list", json: output.json) {
            let store = MeetingStore(config: try Config.load())
            let records = store.all().prefix(limit > 0 ? limit : Int.max).map { MeetingRecord(meeting: $0.0, dir: $0.1) }
            let lines = records.map { record in
                let m = record.meeting
                let mode = m.mode.rawValue.padding(toLength: 9, withPad: " ", startingAt: 0)
                let status = m.status.rawValue.padding(toLength: 10, withPad: " ", startingAt: 0)
                let duration = Duration.format(m.durationSeconds).padding(toLength: 8, withPad: " ", startingAt: 0)
                return "\(m.id)  \(mode) \(status) \(duration) \(m.title)"
            }
            return (Array(records), lines.isEmpty ? "No meetings in \(store.root.path)" : lines.joined(separator: "\n"))
        }
    }
}

struct ShowCommand: ParsableCommand {
    static let configuration = CommandConfiguration(
        commandName: "show",
        abstract: "Show a meeting's summary, or its details when there is no summary yet."
    )

    @Argument(help: "Meeting id, a unique part of it, or \"last\".")
    var meeting: String = "last"

    @Option(name: .customLong("bita-entry"), help: "Show the meeting linked to this bita entry.")
    var bitaEntry: Int?

    @Flag(help: "Print only the meeting directory.")
    var path = false

    @OptionGroup var output: OutputOptions

    func run() throws {
        try Output.run("show", json: output.json) {
            let store = MeetingStore(config: try Config.load())
            let (meeting, dir): (Meeting, URL)
            if let bitaEntry {
                guard let found = store.find(bitaEntryId: bitaEntry) else {
                    throw RecapError("MEETING_NOT_FOUND", "No meeting is linked to bita entry \(bitaEntry)")
                }
                (meeting, dir) = found
            } else {
                (meeting, dir) = try store.resolve(self.meeting)
            }
            let record = MeetingRecord(meeting: meeting, dir: dir, detailed: true)
            if path { return (record, dir.path) }
            if let summary = try? String(contentsOf: dir.appending(path: "summary.md"), encoding: .utf8) {
                return (record, summary)
            }
            var text = "\(meeting.title)\n\(meeting.id)  \(meeting.mode.rawValue)  \(meeting.status.rawValue)  \(Duration.format(meeting.durationSeconds))\n\(dir.path)"
            if let error = meeting.error { text += "\nError: \(error)" }
            return (record, text)
        }
    }
}
