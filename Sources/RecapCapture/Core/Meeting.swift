import ArgumentParser
import Foundation

package enum MeetingMode: String, Codable, CaseIterable, ExpressibleByArgument {
    case remote
    case inPerson = "in-person"

    package var recordingFileName: String {
        switch self {
        case .remote: "recording.mov"
        case .inPerson: "recording.m4a"
        }
    }
}

package enum MeetingStatus: String, Codable {
    case starting
    case recording
    case recorded
    case failed
    case processing
    case processed
}

package struct BitaEntrySnapshot: Codable, Equatable {
    package var title: String
    package var projectName: String?
    package var kind: String?
    package var pageIds: [Int]

    package init(title: String, projectName: String? = nil, kind: String? = nil, pageIds: [Int]) {
        self.title = title
        self.projectName = projectName
        self.kind = kind
        self.pageIds = pageIds
    }
}

package struct Wrapup: Codable, Equatable {
    package var title: String?
    package var titleChanged = false
    package var project: String?
    package var projectResolved = false
    package var pageId: Int?
    package var pageCreated = false
    package var backlogKeys: [String: String] = [:]

    package init(title: String? = nil, titleChanged: Bool = false, project: String? = nil, projectResolved: Bool = false,
                 pageId: Int? = nil, pageCreated: Bool = false, backlogKeys: [String: String] = [:]) {
        self.title = title
        self.titleChanged = titleChanged
        self.project = project
        self.projectResolved = projectResolved
        self.pageId = pageId
        self.pageCreated = pageCreated
        self.backlogKeys = backlogKeys
    }
}

package struct VideoCompression: Codable, Equatable {
    package var compressedAt: Date
    package var preset: String
    package var originalBytes: Int64

    package init(compressedAt: Date, preset: String, originalBytes: Int64) {
        self.compressedAt = compressedAt
        self.preset = preset
        self.originalBytes = originalBytes
    }
}

package struct StageState: Codable {
    package var status: String
    package var updatedAt: Date
    package var error: String?

    package init(status: String, updatedAt: Date, error: String? = nil) {
        self.status = status
        self.updatedAt = updatedAt
        self.error = error
    }
}

package struct Meeting: Codable {
    package var schemaVersion = 1
    package var id: String
    package var title: String
    package var mode: MeetingMode
    package var status: MeetingStatus
    package var createdAt: Date
    package var startedAt: Date?
    package var endedAt: Date?
    package var recorderPid: Int32?
    package var display: UInt32?
    package var bitaEntryId: Int?
    package var bitaDatabasePath: String?
    package var bitaDocsRoot: String?
    package var bitaEntry: BitaEntrySnapshot?
    package var wrapup: Wrapup?
    package var error: String?
    package var stages: [String: StageState] = [:]
    package var video: VideoCompression?
    package var videoRemovedAt: Date?

    package init(schemaVersion: Int = 1, id: String, title: String, mode: MeetingMode, status: MeetingStatus,
                 createdAt: Date, startedAt: Date? = nil, endedAt: Date? = nil, recorderPid: Int32? = nil,
                 display: UInt32? = nil, bitaEntryId: Int? = nil, bitaDatabasePath: String? = nil,
                 bitaDocsRoot: String? = nil, bitaEntry: BitaEntrySnapshot? = nil, wrapup: Wrapup? = nil,
                 error: String? = nil, stages: [String: StageState] = [:], video: VideoCompression? = nil,
                 videoRemovedAt: Date? = nil) {
        self.schemaVersion = schemaVersion
        self.id = id
        self.title = title
        self.mode = mode
        self.status = status
        self.createdAt = createdAt
        self.startedAt = startedAt
        self.endedAt = endedAt
        self.recorderPid = recorderPid
        self.display = display
        self.bitaEntryId = bitaEntryId
        self.bitaDatabasePath = bitaDatabasePath
        self.bitaDocsRoot = bitaDocsRoot
        self.bitaEntry = bitaEntry
        self.wrapup = wrapup
        self.error = error
        self.stages = stages
        self.video = video
        self.videoRemovedAt = videoRemovedAt
    }

    package var durationSeconds: Int? {
        guard let startedAt else { return nil }
        return Int((endedAt ?? Date()).timeIntervalSince(startedAt))
    }
}

package enum MeetingFile {
    package static let name = "meeting.json"

    package static let encoder: JSONEncoder = {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes]
        encoder.dateEncodingStrategy = .iso8601
        return encoder
    }()

    package static let decoder: JSONDecoder = {
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601
        return decoder
    }()

    package static func load(_ dir: URL) throws -> Meeting {
        let url = dir.appending(path: name)
        do {
            return try decoder.decode(Meeting.self, from: Data(contentsOf: url))
        } catch {
            throw RecapError("MEETING_UNREADABLE", "Cannot read \(url.path): \(error.localizedDescription)")
        }
    }

    package static func save(_ meeting: Meeting, to dir: URL) throws {
        try encoder.encode(meeting).write(to: dir.appending(path: name), options: .atomic)
    }

    package static func update(_ dir: URL, _ change: (inout Meeting) -> Void) throws -> Meeting {
        var meeting = try load(dir)
        change(&meeting)
        try save(meeting, to: dir)
        return meeting
    }
}
