import Foundation
import Testing
@testable import recap

private func temporaryRoot() -> URL {
    FileManager.default.temporaryDirectory.appending(path: "recap-media-\(UUID().uuidString)")
}

private func write(_ bytes: Int, to url: URL) throws {
    try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
    try Data(repeating: 7, count: bytes).write(to: url)
}

@Suite struct RecordingURLTests {
    @Test func prefersTheVideoForRemoteMeetings() throws {
        let dir = temporaryRoot()
        defer { try? FileManager.default.removeItem(at: dir) }
        try write(10, to: dir.appending(path: "recording.mov"))
        try write(10, to: dir.appending(path: "recording.m4a"))
        #expect(MeetingMedia.recordingURL(dir: dir, mode: .remote).lastPathComponent == "recording.mov")
        #expect(MeetingMedia.hasVideo(dir: dir, mode: .remote))
    }

    @Test func fallsBackToTheAudioWhenTheVideoIsGone() throws {
        let dir = temporaryRoot()
        defer { try? FileManager.default.removeItem(at: dir) }
        try write(10, to: dir.appending(path: "recording.m4a"))
        #expect(MeetingMedia.recordingURL(dir: dir, mode: .remote).lastPathComponent == "recording.m4a")
        #expect(!MeetingMedia.hasVideo(dir: dir, mode: .remote))
    }

    @Test func keepsTheVideoNameWhenNothingExists() {
        let dir = temporaryRoot()
        #expect(MeetingMedia.recordingURL(dir: dir, mode: .remote).lastPathComponent == "recording.mov")
        #expect(MeetingMedia.recordingURL(dir: dir, mode: .inPerson).lastPathComponent == "recording.m4a")
        #expect(!MeetingMedia.hasVideo(dir: dir, mode: .remote))
    }

    @Test func inPersonMeetingsNeverHaveVideo() throws {
        let dir = temporaryRoot()
        defer { try? FileManager.default.removeItem(at: dir) }
        try write(10, to: dir.appending(path: "recording.m4a"))
        try write(10, to: dir.appending(path: "recording.mov"))
        #expect(MeetingMedia.recordingURL(dir: dir, mode: .inPerson).lastPathComponent == "recording.m4a")
        #expect(!MeetingMedia.hasVideo(dir: dir, mode: .inPerson))
    }
}

@Suite struct StorageTests {
    @Test func splitsTheMeetingDirectoryByKind() throws {
        let dir = temporaryRoot()
        defer { try? FileManager.default.removeItem(at: dir) }
        try write(1000, to: dir.appending(path: "recording.mov"))
        try write(300, to: dir.appending(path: "mic.wav"))
        try write(200, to: dir.appending(path: "system.wav"))
        try write(40, to: dir.appending(path: "transcript-mic.json"))
        try write(60, to: dir.appending(path: "transcript-system.json"))
        try write(70, to: dir.appending(path: "frames/00-00-01.jpg"))
        try write(30, to: dir.appending(path: "frames/00-05-00.jpg"))
        try write(25, to: dir.appending(path: "summary.md"))
        try write(5, to: dir.appending(path: "transcript.json"))
        let storage = MeetingStorage.measure(dir, mode: .remote)
        #expect(storage == MeetingStorage(recordingBytes: 1000, intermediateBytes: 600, framesBytes: 100,
                                          otherBytes: 30, totalBytes: 1730))
    }

    @Test func countsTheAudioFallbackAsTheRecording() throws {
        let dir = temporaryRoot()
        defer { try? FileManager.default.removeItem(at: dir) }
        try write(400, to: dir.appending(path: "recording.m4a"))
        try write(10, to: dir.appending(path: "meeting.json"))
        let storage = MeetingStorage.measure(dir, mode: .remote)
        #expect(storage.recordingBytes == 400)
        #expect(storage.otherBytes == 10)
        #expect(storage.totalBytes == 410)
    }

    @Test func isEmptyForAMissingDirectory() {
        #expect(MeetingStorage.measure(temporaryRoot(), mode: .remote) == MeetingStorage())
    }
}

@Suite struct MeetingCompatibilityTests {
    @Test func decodesMeetingFilesWithoutMediaFields() throws {
        let json = """
        {"createdAt":"2026-10-02T21:30:00Z","id":"2026-10-02-1530-sync","mode":"remote","schemaVersion":1,
         "stages":{"audio":{"status":"done","updatedAt":"2026-10-02T22:00:00Z"}},"status":"processed","title":"Sync"}
        """
        let meeting = try MeetingFile.decoder.decode(Meeting.self, from: Data(json.utf8))
        #expect(meeting.video == nil)
        #expect(meeting.videoRemovedAt == nil)
        #expect(meeting.stages["audio"]?.status == "done")
    }

    @Test func roundTripsMediaFields() throws {
        let dir = temporaryRoot()
        defer { try? FileManager.default.removeItem(at: dir) }
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        var meeting = Meeting(id: "m", title: "M", mode: .remote, status: .processed, createdAt: Date(timeIntervalSince1970: 1_790_000_000))
        meeting.video = VideoCompression(compressedAt: Date(timeIntervalSince1970: 1_790_000_100), preset: "medium", originalBytes: 123)
        meeting.videoRemovedAt = Date(timeIntervalSince1970: 1_790_000_200)
        try MeetingFile.save(meeting, to: dir)
        let loaded = try MeetingFile.load(dir)
        #expect(loaded.video == meeting.video)
        #expect(loaded.videoRemovedAt == meeting.videoRemovedAt)
    }

    @Test func recordIncludesVideoAndStorage() throws {
        let dir = temporaryRoot()
        defer { try? FileManager.default.removeItem(at: dir) }
        try write(50, to: dir.appending(path: "recording.m4a"))
        var meeting = Meeting(id: "m", title: "M", mode: .remote, status: .processed, createdAt: Date())
        meeting.videoRemovedAt = Date()
        let data = try Output.encoder.encode(MeetingRecord(meeting: meeting, dir: dir))
        let object = try #require(try JSONSerialization.jsonObject(with: data) as? [String: Any])
        #expect(object["hasVideo"] as? Bool == false)
        #expect((object["recording"] as? String)?.hasSuffix("recording.m4a") == true)
        #expect(object["videoRemovedAt"] != nil)
        #expect(object["video"] == nil)
        let storage = try #require(object["storage"] as? [String: Any])
        #expect(storage["recordingBytes"] as? Int == 50)
        #expect(storage["totalBytes"] as? Int == 50)
        #expect(Set(storage.keys) == ["recordingBytes", "intermediateBytes", "framesBytes", "otherBytes", "totalBytes"])
    }
}

@Suite struct FramesStageTests {
    @Test func skipsFramesWhenTheRecordingHasNoVideo() throws {
        let dir = temporaryRoot()
        defer { try? FileManager.default.removeItem(at: dir) }
        try write(10, to: dir.appending(path: "recording.m4a"))
        let meeting = Meeting(id: "m", title: "M", mode: .remote, status: .recorded, createdAt: Date())
        #expect(Stage.frames.skipped(meeting: meeting, dir: dir))
        #expect(!Stage.audio.skipped(meeting: meeting, dir: dir))
        try write(10, to: dir.appending(path: "recording.mov"))
        #expect(!Stage.frames.skipped(meeting: meeting, dir: dir))
    }

    @Test func treatsSkippedAsComplete() {
        #expect(Stage.isComplete(StageState(status: "skipped", updatedAt: Date())))
        #expect(Stage.isComplete(StageState(status: "done", updatedAt: Date())))
        #expect(!Stage.isComplete(StageState(status: "failed", updatedAt: Date())))
        #expect(!Stage.isComplete(nil))
    }
}

@Suite struct VideoPresetTests {
    @Test func toleratesOneFrameIntervalOfDrift() throws {
        #expect(VideoPreset.light.durationTolerance == 1.5)
        #expect(VideoPreset.medium.durationTolerance == 2)
        #expect(VideoPreset.max.durationTolerance == 3)
        let original = MediaInfo(duration: 2390.8, audioTracks: 2, enabledAudioTracks: 2, videoTracks: 1)
        let output = MediaInfo(duration: 2392.0, audioTracks: 2, enabledAudioTracks: 2, videoTracks: 1)
        try MediaProbe.verify(original: original, output: output, expectVideo: true, tolerance: VideoPreset.medium.durationTolerance)
    }

    @Test func presetParameters() {
        #expect(VideoPreset.light.width == 1280)
        #expect(VideoPreset.light.frameRate == "2")
        #expect(VideoPreset.light.videoBitrate == "250k")
        #expect(VideoPreset.medium.width == 960)
        #expect(VideoPreset.medium.frameRate == "1")
        #expect(VideoPreset.medium.videoBitrate == "140k")
        #expect(VideoPreset.max.width == 720)
        #expect(VideoPreset.max.frameRate == "0.5")
        #expect(VideoPreset.max.videoBitrate == "70k")
    }

    @Test func ffmpegArgumentsUseHevc() {
        let arguments = VideoPreset.medium.ffmpegVideoArguments
        #expect(arguments.contains("hevc_videotoolbox"))
        #expect(arguments.contains("hvc1"))
        #expect(arguments.contains("fps=1,scale='min(960,iw)':-2"))
        #expect(arguments.contains("140k"))
    }

    @Test func enablesEveryAudioTrack() {
        let info = MediaInfo(duration: 1, audioTracks: 2, enabledAudioTracks: 1, videoTracks: 1)
        #expect(MediaOperations.enableAudio(info) == ["-disposition:a:0", "default", "-disposition:a:1", "default"])
    }

    @Test func verificationRejectsMismatches() {
        let original = MediaInfo(duration: 60, audioTracks: 2, enabledAudioTracks: 2, videoTracks: 1)
        #expect(throws: Never.self) {
            try MediaProbe.verify(original: original, output: MediaInfo(duration: 60.5, audioTracks: 2, enabledAudioTracks: 2, videoTracks: 0), expectVideo: false)
        }
        #expect(throws: RecapError.self) {
            try MediaProbe.verify(original: original, output: MediaInfo(duration: 58, audioTracks: 2, enabledAudioTracks: 2, videoTracks: 0), expectVideo: false)
        }
        #expect(throws: RecapError.self) {
            try MediaProbe.verify(original: original, output: MediaInfo(duration: 60, audioTracks: 1, enabledAudioTracks: 1, videoTracks: 0), expectVideo: false)
        }
        #expect(throws: RecapError.self) {
            try MediaProbe.verify(original: original, output: MediaInfo(duration: 60, audioTracks: 2, enabledAudioTracks: 1, videoTracks: 0), expectVideo: false)
        }
        #expect(throws: RecapError.self) {
            try MediaProbe.verify(original: original, output: MediaInfo(duration: 60, audioTracks: 2, enabledAudioTracks: 2, videoTracks: 0), expectVideo: true)
        }
    }
}

@Suite(.serialized) struct MediaOperationsTests {
    private static let ffmpeg = Shell.which("ffmpeg")

    private func makeMeeting(mode: MeetingMode = .remote) throws -> (MediaOperations, MeetingStore, Meeting, URL, URL) {
        let root = temporaryRoot()
        var config = Config()
        config.root = root.path
        config.tools = ["ffmpeg": Self.ffmpeg?.path ?? "/opt/homebrew/bin/ffmpeg"]
        let store = MeetingStore(config: config)
        let (_, dir) = try store.create(title: "Media", mode: mode, display: nil, bitaEntryId: 31)
        let meeting = try MeetingFile.update(dir) {
            $0.status = .processed
            $0.startedAt = Date()
            $0.endedAt = Date()
        }
        return (MediaOperations(config: config), store, meeting, dir, root)
    }

    private func synthesize(_ ffmpeg: URL, into dir: URL, seconds: Int = 6) throws {
        let result = try Shell.run(ffmpeg, [
            "-hide_banner", "-loglevel", "error", "-y",
            "-f", "lavfi", "-i", "testsrc=size=1280x720:rate=30:duration=\(seconds)",
            "-f", "lavfi", "-i", "sine=frequency=440:duration=\(seconds)",
            "-f", "lavfi", "-i", "sine=frequency=880:duration=\(seconds)",
            "-map", "0:v", "-map", "1:a", "-map", "2:a",
            "-c:v", "h264_videotoolbox", "-b:v", "4M",
            "-c:a", "aac", "-ac:a:0", "1", "-ac:a:1", "2",
            dir.appending(path: "recording.mov").path,
        ])
        try #require(result.ok, "ffmpeg failed: \(result.stderr)")
    }

    @Test(.enabled(if: Shell.which("ffmpeg") != nil, "ffmpeg is not installed")) func stripsTheVideoAndKeepsBothAudioTracks() throws {
        let ffmpeg = try #require(Self.ffmpeg)
        let (operations, _, meeting, dir, root) = try makeMeeting()
        defer { try? FileManager.default.removeItem(at: root) }
        try synthesize(ffmpeg, into: dir)
        try write(100, to: dir.appending(path: "mic.wav"))
        try write(100, to: dir.appending(path: "transcript-system.json"))
        let original = try MediaProbe.inspect(dir.appending(path: "recording.mov"))
        #expect(original.audioTracks == 2)

        let updated = try operations.stripVideo(meeting: meeting, dir: dir, pruneIntermediates: true)

        #expect(updated.videoRemovedAt != nil)
        #expect(!FileManager.default.fileExists(atPath: dir.appending(path: "recording.mov").path))
        #expect(!FileManager.default.fileExists(atPath: dir.appending(path: "mic.wav").path))
        #expect(!FileManager.default.fileExists(atPath: dir.appending(path: "transcript-system.json").path))
        let audio = try MediaProbe.inspect(dir.appending(path: "recording.m4a"))
        #expect(audio.videoTracks == 0)
        #expect(audio.audioTracks == 2)
        #expect(audio.enabledAudioTracks == 2)
        #expect(abs(audio.duration - original.duration) <= 1)
        #expect(!MeetingMedia.hasVideo(dir: dir, mode: .remote))
        #expect(throws: RecapError.self) { try operations.stripVideo(meeting: updated, dir: dir, pruneIntermediates: false) }
        #expect(!FileManager.default.fileExists(atPath: dir.appending(path: "process.lock").path))
    }

    @Test(.enabled(if: Shell.which("ffmpeg") != nil, "ffmpeg is not installed")) func compressesTheVideo() throws {
        let ffmpeg = try #require(Self.ffmpeg)
        let (operations, _, meeting, dir, root) = try makeMeeting()
        defer { try? FileManager.default.removeItem(at: root) }
        try synthesize(ffmpeg, into: dir, seconds: 10)
        let source = dir.appending(path: "recording.mov")
        let originalBytes = MeetingMedia.size(source)
        let original = try MediaProbe.inspect(source)

        let updated = try operations.compressVideo(meeting: meeting, dir: dir, preset: .max, pruneIntermediates: false)

        #expect(updated.video?.preset == "max")
        #expect(updated.video?.originalBytes == originalBytes)
        #expect(MeetingMedia.size(source) < originalBytes)
        let compressed = try MediaProbe.inspect(source)
        #expect(compressed.videoTracks == 1)
        #expect(compressed.audioTracks == 2)
        #expect(compressed.enabledAudioTracks == 2)
        #expect(abs(compressed.duration - original.duration) <= 1)
        let leftovers = try FileManager.default.contentsOfDirectory(atPath: dir.path).filter { $0.hasPrefix(".recording-") }
        #expect(leftovers.isEmpty)
    }

    @Test(.enabled(if: Shell.which("ffmpeg") != nil, "ffmpeg is not installed")) func refusesWhenTheResultIsNotSmaller() throws {
        let ffmpeg = try #require(Self.ffmpeg)
        let (operations, _, meeting, dir, root) = try makeMeeting()
        defer { try? FileManager.default.removeItem(at: root) }
        let result = try Shell.run(ffmpeg, [
            "-hide_banner", "-loglevel", "error", "-y",
            "-f", "lavfi", "-i", "mandelbrot=size=1280x720:rate=2",
            "-f", "lavfi", "-i", "anullsrc=r=48000:cl=mono", "-f", "lavfi", "-i", "anullsrc=r=48000:cl=stereo",
            "-map", "0:v", "-map", "1:a", "-map", "2:a", "-t", "6",
            "-c:v", "libx264", "-b:v", "8k", "-c:a", "aac", "-b:a", "16k",
            dir.appending(path: "recording.mov").path,
        ])
        try #require(result.ok, "ffmpeg failed: \(result.stderr)")
        let before = try Data(contentsOf: dir.appending(path: "recording.mov"))
        #expect(throws: RecapError.self) {
            try operations.compressVideo(meeting: meeting, dir: dir, preset: .light, pruneIntermediates: false)
        }
        #expect(try Data(contentsOf: dir.appending(path: "recording.mov")) == before)
        #expect(try MeetingFile.load(dir).video == nil)
    }

    @Test func rejectsInPersonAndActiveMeetings() throws {
        let (operations, _, meeting, dir, root) = try makeMeeting(mode: .inPerson)
        defer { try? FileManager.default.removeItem(at: root) }
        do {
            _ = try operations.stripVideo(meeting: meeting, dir: dir, pruneIntermediates: false)
            Issue.record("strip-video accepted an in-person meeting")
        } catch let error as RecapError {
            #expect(error.code == "NOT_REMOTE")
        }
        var active = meeting
        active.mode = .remote
        active.status = .recording
        do {
            _ = try operations.compressVideo(meeting: active, dir: dir, preset: .medium, pruneIntermediates: false)
            Issue.record("compress-video accepted an active meeting")
        } catch let error as RecapError {
            #expect(error.code == "MEETING_ACTIVE")
        }
        active.status = .processed
        do {
            _ = try operations.stripVideo(meeting: active, dir: dir, pruneIntermediates: false)
            Issue.record("strip-video accepted a meeting without video")
        } catch let error as RecapError {
            #expect(error.code == "NO_VIDEO")
        }
    }

    @Test func prunesIntermediatesAndDeletesMeetings() throws {
        let (operations, store, meeting, dir, root) = try makeMeeting()
        defer { try? FileManager.default.removeItem(at: root) }
        for name in MeetingMedia.intermediateFileNames { try write(10, to: dir.appending(path: name)) }
        try write(10, to: dir.appending(path: "transcript.json"))
        _ = try operations.prune(meeting: meeting, dir: dir)
        #expect(MeetingStorage.measure(dir, mode: .remote).intermediateBytes == 0)
        #expect(FileManager.default.fileExists(atPath: dir.appending(path: "transcript.json").path))

        var active = meeting
        active.status = .recording
        #expect(throws: RecapError.self) { try MediaOperations.delete(meeting: active, dir: dir) }

        let size = MeetingMedia.size(dir)
        let deleted = try MediaOperations.delete(meeting: meeting, dir: dir)
        #expect(deleted.id == meeting.id)
        #expect(deleted.freedBytes == size)
        #expect(!FileManager.default.fileExists(atPath: dir.path))
        #expect(store.all().isEmpty)
    }
}
