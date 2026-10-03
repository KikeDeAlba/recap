import ArgumentParser
import Foundation

struct BitaHookEvent: Decodable {
    struct Entry: Decodable {
        let id: Int
        let description: String
        let kind: String?
        let running: Bool?
        let projectName: String?
    }

    let event: String
    let entry: Entry
    let previousKind: String?
    let databasePath: String?
    let docsRoot: String?
    let pageIds: [Int]?

    var snapshot: BitaEntrySnapshot {
        BitaEntrySnapshot(title: entry.description, projectName: entry.projectName, kind: entry.kind, pageIds: pageIds ?? [])
    }

    var mode: MeetingMode? { entry.kind.flatMap { BitaBridge.kinds[$0] } }
    var previousMode: MeetingMode? { previousKind.flatMap { BitaBridge.kinds[$0] } }
    var target: BitaTarget { BitaTarget(databasePath: databasePath, docsRoot: docsRoot) }
}

enum BitaHookAction: Equatable {
    case start(MeetingMode)
    case stopAndProcess
    case processIfRecorded
    case stopWithoutProcessing
    case discard
    case ignore(String)
}

enum BitaHookPlanner {
    static func plan(_ event: BitaHookEvent, activeEntryId: Int?) -> BitaHookAction {
        let isActive = activeEntryId == event.entry.id
        switch event.event {
        case "start":
            guard let mode = event.mode else { return .ignore("entry #\(event.entry.id) is not a meeting") }
            return activeEntryId == nil ? .start(mode) : .ignore("another meeting is already being recorded")
        case "stop":
            return isActive ? .stopAndProcess : .processIfRecorded
        case "cancel":
            return .discard
        case "amend":
            if let mode = event.mode, event.previousMode == nil {
                guard event.entry.running != false else { return .ignore("entry #\(event.entry.id) already stopped") }
                return activeEntryId == nil ? .start(mode) : .ignore("another meeting is already being recorded")
            }
            if event.mode == nil, event.previousMode != nil, isActive { return .stopWithoutProcessing }
            return .ignore("kind change does not affect the recording")
        default:
            return .ignore("unknown event \(event.event)")
        }
    }
}

struct BitaHookCommand: ParsableCommand {
    static let configuration = CommandConfiguration(
        commandName: "bita-hook",
        abstract: "Handle a bita timer event read from stdin (register it with `bita hooks add`)."
    )

    func run() throws {
        let input = FileHandle.standardInput.readDataToEndOfFile()
        let event: BitaHookEvent
        do {
            event = try JSONDecoder().decode(BitaHookEvent.self, from: input)
        } catch {
            log("ignored: unreadable event (\(error.localizedDescription))")
            throw ExitCode(1)
        }
        let active = ActiveRecording.current()
        let activeEntryId = active?.1.bitaEntryId
        let action = BitaHookPlanner.plan(event, activeEntryId: activeEntryId)
        log("\(event.event) #\(event.entry.id) kind=\(event.entry.kind ?? "-"): \(action)")
        do {
            switch action {
            case let .start(mode):
                let record = try Recording.start(title: event.entry.description, mode: mode, display: nil,
                                                 bitaEntryId: event.entry.id, bita: event.target, timeout: 90)
                _ = try MeetingFile.update(record.dir) { $0.bitaEntry = event.snapshot }
                log("recording \(record.dir.path)")
            case .stopAndProcess:
                let record = try Recording.stop(timeout: 60)
                _ = try MeetingFile.update(record.dir) { $0.bitaEntry = event.snapshot }
                if record.meeting.status == .recorded {
                    try Background.process(meetingId: record.meeting.id, dir: record.dir)
                    log("processing \(record.dir.path)")
                }
            case .processIfRecorded:
                let store = MeetingStore(config: try Config.load())
                guard let (meeting, dir) = store.find(bitaEntryId: event.entry.id) else {
                    log("nothing to do: no meeting for entry #\(event.entry.id)")
                    return
                }
                guard meeting.status == .recorded, meeting.stages.isEmpty else {
                    log("nothing to do: \(meeting.id) is \(meeting.status.rawValue)")
                    return
                }
                _ = try MeetingFile.update(dir) { $0.bitaEntry = event.snapshot }
                try Background.process(meetingId: meeting.id, dir: dir)
                log("processing \(dir.path)")
            case .stopWithoutProcessing:
                let record = try Recording.stop(timeout: 60)
                log("stopped without processing \(record.dir.path)")
            case .discard:
                let record = try Recording.discard(reference: nil, bitaEntryId: event.entry.id)
                log("discarded \(record.dir.path)")
            case let .ignore(reason):
                log("nothing to do: \(reason)")
            }
        } catch let error as RecapError where error.code == "MEETING_NOT_FOUND" {
            log("nothing to do: \(error.message)")
        } catch {
            let message = (error as? RecapError)?.description ?? String(describing: error)
            log("failed: \(message)")
            throw ExitCode(1)
        }
    }

    private func log(_ message: String) {
        print("\(ISO8601DateFormatter().string(from: Date())) recap bita-hook: \(message)")
    }
}
