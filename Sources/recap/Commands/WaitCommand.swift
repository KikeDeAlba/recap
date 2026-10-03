import ArgumentParser
import Foundation

struct WaitCommand: ParsableCommand {
    static let configuration = CommandConfiguration(
        commandName: "wait",
        abstract: "Wait until a meeting is processed (or a stage fails) and print the result."
    )

    @Argument(help: "Meeting id, a unique part of it, or \"last\".")
    var meeting: String?

    @Option(name: .customLong("bita-entry"), help: "Wait for the meeting linked to this bita entry.")
    var bitaEntry: Int?

    @Option(help: "Seconds to wait before giving up.")
    var timeout: Double = 900

    @OptionGroup var output: OutputOptions

    func run() throws {
        try Output.run("wait", json: output.json) {
            let store = MeetingStore(config: try Config.load())
            var found: (Meeting, URL)?
            let settled = ProcessCheck.waitUntil(timeout: timeout, interval: 2) {
                found = try? locate(store)
                guard let (meeting, _) = found else { return false }
                return Self.isSettled(meeting)
            }
            guard let (meeting, dir) = found else {
                throw RecapError("MEETING_NOT_FOUND", bitaEntry.map { "No meeting is linked to bita entry \($0)" } ?? "No meeting found")
            }
            guard settled else {
                throw RecapError("WAIT_TIMEOUT", "\"\(meeting.title)\" is still \(meeting.status.rawValue) after \(Int(timeout))s")
            }
            return (MeetingRecord(meeting: meeting, dir: dir), Self.describe(meeting, dir: dir))
        }
    }

    private func locate(_ store: MeetingStore) throws -> (Meeting, URL)? {
        if let bitaEntry { return store.find(bitaEntryId: bitaEntry) }
        return try store.resolve(meeting)
    }

    static func failedStage(_ meeting: Meeting) -> (String, StageState)? {
        meeting.stages.first { $0.value.status == "failed" }.map { ($0.key, $0.value) }
    }

    static func isSettled(_ meeting: Meeting) -> Bool {
        switch meeting.status {
        case .processed, .failed: true
        case .recorded: failedStage(meeting) != nil
        case .starting, .recording, .processing: false
        }
    }

    static func describe(_ meeting: Meeting, dir: URL) -> String {
        var lines = ["\(meeting.title) [\(meeting.status.rawValue)] \(Duration.format(meeting.durationSeconds))"]
        if let (stage, state) = failedStage(meeting) {
            lines.append("Failed at \(stage): \(state.error ?? "no reason given")")
        }
        if let wrapup = meeting.wrapup {
            lines.append("Title   : \(wrapup.title ?? meeting.title)")
            lines.append("Project : \(wrapup.project ?? "(none)")\(wrapup.projectResolved ? "" : " — not clear from the meeting")")
            if let pageId = wrapup.pageId { lines.append("Page    : #\(pageId)\(wrapup.pageCreated ? " (new)" : "")") }
            lines.append("Backlog : \(wrapup.backlogKeys.count) items")
        }
        lines.append(dir.appending(path: "summary.md").path)
        return lines.joined(separator: "\n")
    }
}
