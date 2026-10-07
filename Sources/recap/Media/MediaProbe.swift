import AVFoundation
import Foundation

struct MediaInfo: Equatable {
    let duration: Double
    let audioTracks: Int
    let enabledAudioTracks: Int
    let videoTracks: Int
}

enum MediaProbe {
    private final class ResultBox: @unchecked Sendable {
        var result: Result<MediaInfo, Error>?
    }

    static func inspect(_ url: URL) throws -> MediaInfo {
        let box = ResultBox()
        let semaphore = DispatchSemaphore(value: 0)
        Task.detached {
            do {
                let asset = AVURLAsset(url: url)
                let duration = try await asset.load(.duration)
                let audio = try await asset.loadTracks(withMediaType: .audio)
                let video = try await asset.loadTracks(withMediaType: .video)
                var enabled = 0
                for track in audio where try await track.load(.isEnabled) {
                    enabled += 1
                }
                box.result = .success(MediaInfo(duration: duration.seconds, audioTracks: audio.count,
                                                enabledAudioTracks: enabled, videoTracks: video.count))
            } catch {
                box.result = .failure(error)
            }
            semaphore.signal()
        }
        semaphore.wait()
        switch box.result {
        case .success(let info): return info
        case .failure(let error):
            throw RecapError("MEDIA_UNREADABLE", "Cannot read \(url.lastPathComponent): \(error.localizedDescription)")
        case nil:
            throw RecapError("MEDIA_UNREADABLE", "Cannot read \(url.lastPathComponent)")
        }
    }

    static func verify(original: MediaInfo, output: MediaInfo, expectVideo: Bool, tolerance: Double = 1) throws {
        guard output.duration.isFinite, abs(output.duration - original.duration) <= tolerance else {
            throw RecapError("VERIFY_FAILED", String(format: "The new file lasts %.1fs instead of %.1fs", output.duration, original.duration))
        }
        guard output.audioTracks == original.audioTracks else {
            throw RecapError("VERIFY_FAILED", "The new file has \(output.audioTracks) audio tracks instead of \(original.audioTracks)")
        }
        guard output.enabledAudioTracks == output.audioTracks else {
            throw RecapError("VERIFY_FAILED", "Only \(output.enabledAudioTracks) of \(output.audioTracks) audio tracks are enabled in the new file")
        }
        guard (output.videoTracks > 0) == expectVideo else {
            throw RecapError("VERIFY_FAILED", expectVideo ? "The new file has no video track" : "The new file still has a video track")
        }
    }
}
