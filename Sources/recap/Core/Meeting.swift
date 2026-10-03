import ArgumentParser
import Foundation

enum MeetingMode: String, Codable, CaseIterable, ExpressibleByArgument {
    case remote
    case inPerson = "in-person"

    var recordingFileName: String {
        switch self {
        case .remote: "recording.mov"
        case .inPerson: "recording.m4a"
        }
    }
}

enum MeetingStatus: String, Codable {
    case starting
    case recording
    case recorded
    case failed
    case processing
    case processed
}

struct BitaEntrySnapshot: Codable, Equatable {
    var title: String
    var projectName: String?
    var kind: String?
    var pageIds: [Int]
}

struct Wrapup: Codable, Equatable {
    var title: String?
    var titleChanged = false
    var project: String?
    var projectResolved = false
    var pageId: Int?
    var pageCreated = false
    var backlogKeys: [String: String] = [:]
}

struct StageState: Codable {
    var status: String
    var updatedAt: Date
    var error: String?
}

struct Meeting: Codable {
    var schemaVersion = 1
    var id: String
    var title: String
    var mode: MeetingMode
    var status: MeetingStatus
    var createdAt: Date
    var startedAt: Date?
    var endedAt: Date?
    var recorderPid: Int32?
    var display: UInt32?
    var bitaEntryId: Int?
    var bitaDatabasePath: String?
    var bitaDocsRoot: String?
    var bitaEntry: BitaEntrySnapshot?
    var wrapup: Wrapup?
    var error: String?
    var stages: [String: StageState] = [:]

    var durationSeconds: Int? {
        guard let startedAt else { return nil }
        return Int((endedAt ?? Date()).timeIntervalSince(startedAt))
    }
}

struct MeetingRecord: Encodable {
    let meeting: Meeting
    let dir: URL

    enum CodingKeys: String, CodingKey {
        case id, title, mode, status, createdAt, startedAt, endedAt, durationSeconds
        case bitaEntryId, bitaEntry, wrapup, error, stages, dir, recording, summary, transcript
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(meeting.id, forKey: .id)
        try container.encode(meeting.title, forKey: .title)
        try container.encode(meeting.mode, forKey: .mode)
        try container.encode(meeting.status, forKey: .status)
        try container.encode(meeting.createdAt, forKey: .createdAt)
        try container.encodeIfPresent(meeting.startedAt, forKey: .startedAt)
        try container.encodeIfPresent(meeting.endedAt, forKey: .endedAt)
        try container.encodeIfPresent(meeting.durationSeconds, forKey: .durationSeconds)
        try container.encodeIfPresent(meeting.bitaEntryId, forKey: .bitaEntryId)
        try container.encodeIfPresent(meeting.bitaEntry, forKey: .bitaEntry)
        try container.encodeIfPresent(meeting.wrapup, forKey: .wrapup)
        try container.encodeIfPresent(meeting.error, forKey: .error)
        try container.encode(meeting.stages, forKey: .stages)
        try container.encode(dir.path, forKey: .dir)
        try container.encodeIfPresent(existing(meeting.mode.recordingFileName), forKey: .recording)
        try container.encodeIfPresent(existing("transcript.md"), forKey: .transcript)
        try container.encodeIfPresent(existing("summary.md"), forKey: .summary)
    }

    private func existing(_ name: String) -> String? {
        let url = dir.appending(path: name)
        return FileManager.default.fileExists(atPath: url.path) ? url.path : nil
    }
}

enum MeetingFile {
    static let name = "meeting.json"

    static let encoder: JSONEncoder = {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes]
        encoder.dateEncodingStrategy = .iso8601
        return encoder
    }()

    static let decoder: JSONDecoder = {
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601
        return decoder
    }()

    static func load(_ dir: URL) throws -> Meeting {
        let url = dir.appending(path: name)
        do {
            return try decoder.decode(Meeting.self, from: Data(contentsOf: url))
        } catch {
            throw RecapError("MEETING_UNREADABLE", "Cannot read \(url.path): \(error.localizedDescription)")
        }
    }

    static func save(_ meeting: Meeting, to dir: URL) throws {
        try encoder.encode(meeting).write(to: dir.appending(path: name), options: .atomic)
    }

    static func update(_ dir: URL, _ change: (inout Meeting) -> Void) throws -> Meeting {
        var meeting = try load(dir)
        change(&meeting)
        try save(meeting, to: dir)
        return meeting
    }

    static func reconcile(_ meeting: Meeting, dir: URL) -> Meeting {
        guard meeting.status == .recording || meeting.status == .starting else { return meeting }
        if let pid = meeting.recorderPid, ProcessCheck.isAlive(pid) { return meeting }
        if meeting.recorderPid == nil, meeting.status == .starting,
           Date().timeIntervalSince(meeting.createdAt) < 300 { return meeting }
        let recording = dir.appending(path: meeting.mode.recordingFileName)
        let attributes = try? FileManager.default.attributesOfItem(atPath: recording.path)
        let hasRecording = ((attributes?[.size] as? Int) ?? 0) > 0
        return (try? update(dir) {
            $0.status = hasRecording && $0.startedAt != nil ? .recorded : .failed
            $0.endedAt = (attributes?[.modificationDate] as? Date) ?? Date()
            $0.recorderPid = nil
            $0.error = "The recorder exited without closing the file cleanly"
        }) ?? meeting
    }
}

struct MeetingStore {
    let root: URL

    init(config: Config) {
        root = config.rootURL
    }

    func create(title: String, mode: MeetingMode, display: UInt32?, bitaEntryId: Int?,
                bita: BitaTarget? = nil, now: Date = Date()) throws -> (Meeting, URL) {
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.dateFormat = "yyyy-MM-dd-HHmm"
        let base = "\(formatter.string(from: now))-\(Slug.make(title))"
        var id = base
        var suffix = 2
        while FileManager.default.fileExists(atPath: root.appending(path: id).path) {
            id = "\(base)-\(suffix)"
            suffix += 1
        }
        let dir = root.appending(path: id)
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        let meeting = Meeting(id: id, title: title, mode: mode, status: .starting, createdAt: now,
                              display: display, bitaEntryId: bitaEntryId,
                              bitaDatabasePath: bita?.databasePath, bitaDocsRoot: bita?.docsRoot)
        try MeetingFile.save(meeting, to: dir)
        return (meeting, dir)
    }

    func all() -> [(Meeting, URL)] {
        let entries = (try? FileManager.default.contentsOfDirectory(at: root, includingPropertiesForKeys: nil)) ?? []
        return entries
            .compactMap { dir in (try? MeetingFile.load(dir)).map { (MeetingFile.reconcile($0, dir: dir), dir) } }
            .sorted { $0.0.createdAt > $1.0.createdAt }
    }

    func resolve(_ reference: String?) throws -> (Meeting, URL) {
        let meetings = all()
        guard let reference, reference != "last" else {
            guard let latest = meetings.first else { throw RecapError("NO_MEETINGS", "No meetings in \(root.path)") }
            return latest
        }
        if let exact = meetings.first(where: { $0.0.id == reference }) { return exact }
        let matches = meetings.filter { $0.0.id.hasPrefix(reference) || $0.0.id.contains(reference) }
        switch matches.count {
        case 1: return matches[0]
        case 0: throw RecapError("MEETING_NOT_FOUND", "No meeting matches \"\(reference)\"")
        default: throw RecapError("MEETING_AMBIGUOUS", "\"\(reference)\" matches \(matches.count) meetings")
        }
    }

    func find(bitaEntryId: Int) -> (Meeting, URL)? {
        all().first { $0.0.bitaEntryId == bitaEntryId }
    }
}

enum Slug {
    static func make(_ text: String) -> String {
        let folded = text.folding(options: [.diacriticInsensitive, .caseInsensitive], locale: Locale(identifier: "en_US_POSIX"))
        var slug = ""
        var pendingDash = false
        for scalar in folded.unicodeScalars {
            if CharacterSet.alphanumerics.contains(scalar) && scalar.isASCII {
                if pendingDash && !slug.isEmpty { slug.append("-") }
                slug.unicodeScalars.append(scalar)
                pendingDash = false
            } else {
                pendingDash = true
            }
        }
        let trimmed = String(slug.prefix(48)).trimmingCharacters(in: CharacterSet(charactersIn: "-"))
        return trimmed.isEmpty ? "meeting" : trimmed
    }
}

enum Duration {
    static func format(_ seconds: Int?) -> String {
        guard let seconds else { return "-" }
        let h = seconds / 3600
        let m = (seconds % 3600) / 60
        let s = seconds % 60
        return h > 0 ? String(format: "%dh%02dm", h, m) : String(format: "%dm%02ds", m, s)
    }
}
