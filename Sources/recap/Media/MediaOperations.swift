import Darwin
import Foundation

struct DeletedMeeting: Encodable {
    let id: String
    let dir: String
    let freedBytes: Int64
}

struct MediaOperations {
    let config: Config

    func stripVideo(meeting: Meeting, dir: URL, pruneIntermediates: Bool) throws -> Meeting {
        try requireVideo(meeting: meeting, dir: dir)
        let lock = try ProcessLock(url: dir.appending(path: "process.lock"))
        defer { lock.release() }
        let source = dir.appending(path: MeetingMedia.videoFileName)
        let target = dir.appending(path: MeetingMedia.audioFileName)
        let temporary = dir.appending(path: ".recording-strip.m4a")
        let original = try MediaProbe.inspect(source)
        try transcode(source: source, temporary: temporary, original: original, expectVideo: false,
                      arguments: ["-map", "0:a", "-c", "copy"] + Self.enableAudio(original) + ["-f", "mp4"])
        try Self.replace(temporary, with: target)
        try FileManager.default.removeItem(at: source)
        if pruneIntermediates { Self.removeIntermediates(dir) }
        return try MeetingFile.update(dir) { $0.videoRemovedAt = Date() }
    }

    func compressVideo(meeting: Meeting, dir: URL, preset: VideoPreset, pruneIntermediates: Bool) throws -> Meeting {
        try requireVideo(meeting: meeting, dir: dir)
        let lock = try ProcessLock(url: dir.appending(path: "process.lock"))
        defer { lock.release() }
        let source = dir.appending(path: MeetingMedia.videoFileName)
        let temporary = dir.appending(path: ".recording-compress.mov")
        let original = try MediaProbe.inspect(source)
        let originalBytes = MeetingMedia.size(source)
        try transcode(source: source, temporary: temporary, original: original, expectVideo: true,
                      tolerance: preset.durationTolerance,
                      arguments: ["-map", "0:v:0", "-map", "0:a"] + preset.ffmpegVideoArguments
                          + ["-c:a", "copy"] + Self.enableAudio(original) + ["-f", "mov"])
        let compressedBytes = MeetingMedia.size(temporary)
        guard compressedBytes < originalBytes else {
            try? FileManager.default.removeItem(at: temporary)
            throw RecapError("NOT_SMALLER", "The \(preset.rawValue) preset produced \(Bytes.format(compressedBytes)), not smaller than \(Bytes.format(originalBytes)); the original was kept")
        }
        try Self.replace(temporary, with: source)
        if pruneIntermediates { Self.removeIntermediates(dir) }
        return try MeetingFile.update(dir) {
            $0.video = VideoCompression(compressedAt: Date(), preset: preset.rawValue,
                                        originalBytes: $0.video?.originalBytes ?? originalBytes)
        }
    }

    func prune(meeting: Meeting, dir: URL) throws -> Meeting {
        try Self.requireIdle(meeting)
        let lock = try ProcessLock(url: dir.appending(path: "process.lock"))
        defer { lock.release() }
        Self.removeIntermediates(dir)
        return try MeetingFile.load(dir)
    }

    static func delete(meeting: Meeting, dir: URL) throws -> DeletedMeeting {
        try requireIdle(meeting)
        let lock = dir.appending(path: "process.lock")
        if let text = try? String(contentsOf: lock, encoding: .utf8), let pid = Int32(text.trimmed),
           pid != getpid(), ProcessCheck.isAlive(pid) {
            throw RecapError("MEETING_ACTIVE", "\"\(meeting.title)\" is being processed (pid \(pid))")
        }
        let freed = MeetingMedia.size(dir)
        try FileManager.default.removeItem(at: dir)
        return DeletedMeeting(id: meeting.id, dir: dir.path, freedBytes: freed)
    }

    static func requireIdle(_ meeting: Meeting) throws {
        if meeting.status == .starting || meeting.status == .recording {
            throw RecapError("MEETING_ACTIVE", "\"\(meeting.title)\" is still being recorded")
        }
    }

    static func removeIntermediates(_ dir: URL) {
        for name in MeetingMedia.intermediateFileNames {
            try? FileManager.default.removeItem(at: dir.appending(path: name))
        }
    }

    static func enableAudio(_ info: MediaInfo) -> [String] {
        (0..<info.audioTracks).flatMap { ["-disposition:a:\($0)", "default"] }
    }

    private func requireVideo(meeting: Meeting, dir: URL) throws {
        guard meeting.mode == .remote else {
            throw RecapError("NOT_REMOTE", "\"\(meeting.title)\" is an in-person meeting and has no video")
        }
        try Self.requireIdle(meeting)
        guard MeetingMedia.hasVideo(dir: dir, mode: meeting.mode) else {
            throw RecapError("NO_VIDEO", "\"\(meeting.title)\" has no \(MeetingMedia.videoFileName)")
        }
    }

    private func transcode(source: URL, temporary: URL, original: MediaInfo, expectVideo: Bool, tolerance: Double = 1, arguments: [String]) throws {
        let ffmpeg = try Tool.ffmpeg.require(config)
        try? FileManager.default.removeItem(at: temporary)
        do {
            let result = try Shell.run(ffmpeg, ["-hide_banner", "-loglevel", "error", "-nostdin", "-y", "-i", source.path]
                                       + arguments + ["-movflags", "+faststart", temporary.path])
            guard result.ok else {
                throw RecapError("FFMPEG_FAILED", String(result.stderr.trimmed.suffix(500)))
            }
            try MediaProbe.verify(original: original, output: try MediaProbe.inspect(temporary), expectVideo: expectVideo, tolerance: tolerance)
        } catch {
            try? FileManager.default.removeItem(at: temporary)
            throw error
        }
    }

    private static func replace(_ temporary: URL, with target: URL) throws {
        guard rename(temporary.path, target.path) == 0 else {
            let reason = String(cString: strerror(errno))
            try? FileManager.default.removeItem(at: temporary)
            throw RecapError("RENAME_FAILED", "Cannot move \(temporary.lastPathComponent) to \(target.lastPathComponent): \(reason)")
        }
    }
}

enum Bytes {
    static func format(_ bytes: Int64) -> String {
        ByteCountFormatter.string(fromByteCount: bytes, countStyle: .file)
    }
}
