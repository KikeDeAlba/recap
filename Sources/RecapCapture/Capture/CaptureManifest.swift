import Foundation

package enum CaptureTargetKind: String, Codable, Equatable {
    case display
    case window
}

package struct CaptureTargetRef: Codable, Equatable {
    package var kind: CaptureTargetKind
    package var id: UInt32

    package init(kind: CaptureTargetKind, id: UInt32) {
        self.kind = kind
        self.id = id
    }
}

package struct CaptureVideo: Codable, Equatable {
    package var kind: CaptureTargetKind
    package var id: UInt32
    package var title: String
    package var app: String?
    package var since: Date

    package init(kind: CaptureTargetKind, id: UInt32, title: String, app: String?, since: Date) {
        self.kind = kind
        self.id = id
        self.title = title
        self.app = app
        self.since = since
    }

    package var ref: CaptureTargetRef { CaptureTargetRef(kind: kind, id: id) }

    package func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(kind, forKey: .kind)
        try container.encode(id, forKey: .id)
        try container.encode(title, forKey: .title)
        try container.encode(app, forKey: .app)
        try container.encode(since, forKey: .since)
    }
}

package struct CaptureStatus: Codable, Equatable {
    package var mic: Bool
    package var systemAudio: Bool
    package var video: CaptureVideo?
    package var error: String?

    package init(mic: Bool, video: CaptureVideo?, error: String? = nil) {
        self.mic = mic
        self.systemAudio = video != nil
        self.video = video
        self.error = mic && video == nil ? error : nil
    }

    package func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(mic, forKey: .mic)
        try container.encode(systemAudio, forKey: .systemAudio)
        try container.encode(video, forKey: .video)
        try container.encodeIfPresent(error, forKey: .error)
    }
}

package struct CaptureSegmentTarget: Codable, Equatable {
    package var kind: CaptureTargetKind
    package var id: UInt32
    package var title: String
    package var app: String?
    package var atMs: Int

    package init(_ video: CaptureVideo, atMs: Int) {
        kind = video.kind
        id = video.id
        title = video.title
        app = video.app
        self.atMs = atMs
    }
}

package struct CaptureSegment: Codable, Equatable {
    package var file: String
    package var startMs: Int
    package var endMs: Int?
    package var targets: [CaptureSegmentTarget]

    package init(file: String, startMs: Int, endMs: Int? = nil, targets: [CaptureSegmentTarget]) {
        self.file = file
        self.startMs = startMs
        self.endMs = endMs
        self.targets = targets
    }
}

package struct CaptureManifest: Codable, Equatable {
    package static let fileName = "capture.json"
    package static let micFileName = "mic.m4a"

    package var version = 1
    package var mic = CaptureManifest.micFileName
    package var startedAt: Date
    package var endedAt: Date?
    package var video: CaptureVideo?
    package var segments: [CaptureSegment] = []
    package var error: String?

    package init(startedAt: Date) {
        self.startedAt = startedAt
    }

    package var nextSegmentFile: String { "screen-\(segments.count + 1).mov" }

    package var openSegment: CaptureSegment? {
        guard let last = segments.last, last.endMs == nil else { return nil }
        return last
    }

    @discardableResult
    package mutating func beginSegment(_ video: CaptureVideo, atMs: Int) -> String {
        endSegment(atMs: atMs)
        let file = nextSegmentFile
        segments.append(CaptureSegment(file: file, startMs: atMs, targets: [CaptureSegmentTarget(video, atMs: atMs)]))
        self.video = video
        error = nil
        return file
    }

    package mutating func switchTarget(_ video: CaptureVideo, atMs: Int) {
        guard let index = segments.indices.last, segments[index].endMs == nil else { return }
        segments[index].targets.append(CaptureSegmentTarget(video, atMs: max(atMs, segments[index].startMs)))
        self.video = video
        error = nil
    }

    package mutating func markSegmentStart(_ file: String, atMs: Int) {
        guard let index = segments.lastIndex(where: { $0.file == file }) else { return }
        let start = segments[index].startMs
        segments[index].startMs = max(0, atMs)
        if segments[index].targets.first?.atMs == start { segments[index].targets[0].atMs = max(0, atMs) }
    }

    package mutating func endSegment(atMs: Int, error: String? = nil) {
        if let index = segments.indices.last, segments[index].endMs == nil {
            segments[index].endMs = max(atMs, segments[index].startMs)
        }
        video = nil
        self.error = error
    }

    package mutating func dropSegment(_ file: String) {
        segments.removeAll { $0.file == file }
        video = nil
    }
}

package final class CaptureManifestStore {
    private let url: URL
    private let lock = NSLock()
    private var manifest: CaptureManifest

    package init(dir: URL, startedAt: Date = Date()) {
        url = dir.appending(path: CaptureManifest.fileName)
        manifest = CaptureManifest(startedAt: startedAt)
    }

    package var current: CaptureManifest { lock.withLock { manifest } }

    @discardableResult
    package func update<T>(_ change: (inout CaptureManifest) -> T) -> T {
        lock.withLock {
            let result = change(&manifest)
            write(manifest)
            return result
        }
    }

    private func write(_ manifest: CaptureManifest) {
        guard let data = try? MeetingFile.encoder.encode(manifest) else { return }
        try? data.write(to: url, options: .atomic)
    }

    package static func load(_ dir: URL) -> CaptureManifest? {
        guard let data = try? Data(contentsOf: dir.appending(path: CaptureManifest.fileName)) else { return nil }
        return try? MeetingFile.decoder.decode(CaptureManifest.self, from: data)
    }
}
