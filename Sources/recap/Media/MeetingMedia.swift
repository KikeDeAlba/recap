import ArgumentParser
import Foundation

enum MeetingMedia {
    static let videoFileName = "recording.mov"
    static let audioFileName = "recording.m4a"
    static let intermediateFileNames = ["mic.wav", "system.wav", "transcript-mic.json", "transcript-system.json"]
    static let framesDirectoryName = "frames"

    static func recordingURL(dir: URL, mode: MeetingMode) -> URL {
        let primary = dir.appending(path: mode.recordingFileName)
        guard mode == .remote, !exists(primary) else { return primary }
        let audio = dir.appending(path: audioFileName)
        return exists(audio) ? audio : primary
    }

    static func hasVideo(dir: URL, mode: MeetingMode) -> Bool {
        let url = recordingURL(dir: dir, mode: mode)
        return url.lastPathComponent == videoFileName && exists(url)
    }

    static func exists(_ url: URL) -> Bool {
        FileManager.default.fileExists(atPath: url.path)
    }

    static func size(_ url: URL) -> Int64 {
        var url = url
        url.removeAllCachedResourceValues()
        let values = try? url.resourceValues(forKeys: [.isDirectoryKey, .isSymbolicLinkKey, .fileSizeKey])
        if values?.isSymbolicLink == true { return 0 }
        guard values?.isDirectory == true else { return Int64(values?.fileSize ?? 0) }
        let children = (try? FileManager.default.contentsOfDirectory(
            at: url, includingPropertiesForKeys: [.isDirectoryKey, .isSymbolicLinkKey, .fileSizeKey])) ?? []
        return children.reduce(0) { $0 + size($1) }
    }
}

struct MeetingStorage: Codable, Equatable {
    var recordingBytes: Int64 = 0
    var intermediateBytes: Int64 = 0
    var framesBytes: Int64 = 0
    var otherBytes: Int64 = 0
    var totalBytes: Int64 = 0

    static func measure(_ dir: URL, mode: MeetingMode) -> MeetingStorage {
        var storage = MeetingStorage()
        let recording = MeetingMedia.recordingURL(dir: dir, mode: mode).lastPathComponent
        let entries = (try? FileManager.default.contentsOfDirectory(
            at: dir, includingPropertiesForKeys: [.isDirectoryKey, .isSymbolicLinkKey, .fileSizeKey])) ?? []
        for entry in entries {
            let bytes = MeetingMedia.size(entry)
            let name = entry.lastPathComponent
            storage.totalBytes += bytes
            if name == recording {
                storage.recordingBytes += bytes
            } else if MeetingMedia.intermediateFileNames.contains(name) {
                storage.intermediateBytes += bytes
            } else if name == MeetingMedia.framesDirectoryName {
                storage.framesBytes += bytes
            } else {
                storage.otherBytes += bytes
            }
        }
        return storage
    }
}

enum VideoPreset: String, CaseIterable, Codable, ExpressibleByArgument {
    case light
    case medium
    case max

    var width: Int {
        switch self {
        case .light: 1280
        case .medium: 960
        case .max: 720
        }
    }

    var frameRate: String {
        switch self {
        case .light: "2"
        case .medium: "1"
        case .max: "0.5"
        }
    }

    var durationTolerance: Double {
        1 + 1 / (Double(frameRate) ?? 1)
    }

    var videoBitrate: String {
        switch self {
        case .light: "250k"
        case .medium: "140k"
        case .max: "70k"
        }
    }

    var ffmpegVideoArguments: [String] {
        ["-c:v", "hevc_videotoolbox", "-tag:v", "hvc1",
         "-vf", "fps=\(frameRate),scale='min(\(width),iw)':-2",
         "-b:v", videoBitrate]
    }
}
