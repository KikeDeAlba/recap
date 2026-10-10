import ArgumentParser
import Foundation
import Testing
@testable import RecapCapture

private struct TestRoot: ParsableCommand {
    static let configuration = CommandConfiguration(
        commandName: CaptureTool.name,
        version: CaptureTool.version,
        subcommands: CaptureTool.subcommands
    )
}

private func temporaryDirectory() throws -> URL {
    let dir = FileManager.default.temporaryDirectory.appending(path: "recap-capture-tests-\(UUID().uuidString)")
    try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    return dir
}

private func jsonObject(_ text: String) throws -> [String: Any] {
    try #require(JSONSerialization.jsonObject(with: Data(text.utf8)) as? [String: Any])
}

@Suite struct MeetingFileContractTests {
    @Test func decodesTheMeetingJSONALauncherWrites() throws {
        let dir = try temporaryDirectory()
        defer { try? FileManager.default.removeItem(at: dir) }
        let written = """
        {"schemaVersion": 1, "id": "2026-10-10-1200-sync", "title": "Sync", "mode": "in-person",
         "status": "starting", "createdAt": "2026-10-10T12:00:00Z", "display": 2, "stages": {}}
        """
        try Data(written.utf8).write(to: dir.appending(path: MeetingFile.name))
        let meeting = try MeetingFile.load(dir)
        #expect(meeting.mode == .inPerson)
        #expect(meeting.status == .starting)
        #expect(meeting.display == 2)
        #expect(meeting.recorderPid == nil)
        #expect(meeting.startedAt == nil)
    }

    @Test func writesStatusPidAndStartedAtWithTheSameEncoding() throws {
        let dir = try temporaryDirectory()
        defer { try? FileManager.default.removeItem(at: dir) }
        let createdAt = Date(timeIntervalSince1970: 1_760_097_600)
        try MeetingFile.save(Meeting(id: "m", title: "Sync", mode: .remote, status: .starting, createdAt: createdAt), to: dir)
        _ = try MeetingFile.update(dir) {
            $0.recorderPid = 4242
            $0.status = .recording
            $0.startedAt = createdAt.addingTimeInterval(3)
        }
        let text = try String(contentsOf: dir.appending(path: MeetingFile.name), encoding: .utf8)
        let object = try jsonObject(text)
        #expect(object["status"] as? String == "recording")
        #expect(object["recorderPid"] as? Int == 4242)
        #expect(object["startedAt"] as? String == "2025-10-10T12:00:03Z")
        #expect(object["createdAt"] as? String == "2025-10-10T12:00:00Z")
        #expect(object["mode"] as? String == "remote")
        #expect(object["schemaVersion"] as? Int == 1)
        #expect(object["endedAt"] == nil)
        #expect(text.contains("\n"))
    }

    @Test func stoppingClearsThePidAndRecordsTheEnd() throws {
        let dir = try temporaryDirectory()
        defer { try? FileManager.default.removeItem(at: dir) }
        try MeetingFile.save(Meeting(id: "m", title: "Sync", mode: .inPerson, status: .recording, createdAt: Date(),
                                     startedAt: Date(), recorderPid: 99), to: dir)
        _ = try MeetingFile.update(dir) {
            $0.status = .recorded
            $0.endedAt = Date()
            $0.recorderPid = nil
        }
        let object = try jsonObject(try String(contentsOf: dir.appending(path: MeetingFile.name), encoding: .utf8))
        #expect(object["status"] as? String == "recorded")
        #expect(object["recorderPid"] == nil)
        #expect(object["endedAt"] is String)
    }

    @Test func updatesKeepKeysTheRecorderDoesNotKnow() throws {
        let dir = try temporaryDirectory()
        defer { try? FileManager.default.removeItem(at: dir) }
        let written = """
        {"schemaVersion": 1, "id": "m", "title": "Sync", "mode": "remote", "status": "starting",
         "createdAt": "2026-10-10T12:00:00Z", "stages": {}, "source": "den", "attendees": ["ana", "luis"]}
        """
        try Data(written.utf8).write(to: dir.appending(path: MeetingFile.name))
        _ = try MeetingFile.update(dir) {
            $0.status = .recording
            $0.recorderPid = 7
        }
        let object = try jsonObject(try String(contentsOf: dir.appending(path: MeetingFile.name), encoding: .utf8))
        #expect(object["source"] as? String == "den")
        #expect(object["attendees"] as? [String] == ["ana", "luis"])
        #expect(object["status"] as? String == "recording")
        #expect(object["recorderPid"] as? Int == 7)
        _ = try MeetingFile.update(dir) { $0.recorderPid = nil }
        let cleared = try jsonObject(try String(contentsOf: dir.appending(path: MeetingFile.name), encoding: .utf8))
        #expect(cleared["recorderPid"] == nil)
        #expect(cleared["source"] as? String == "den")
        #expect(try MeetingFile.load(dir).status == .recording)
    }

    @Test func recordingFileDependsOnTheMode() {
        #expect(MeetingMode.remote.recordingFileName == "recording.mov")
        #expect(MeetingMode.inPerson.recordingFileName == "recording.m4a")
        #expect(MeetingMode(rawValue: "in-person") == .inPerson)
    }

    @Test func unreadableMeetingFailsWithACode() throws {
        let dir = try temporaryDirectory()
        defer { try? FileManager.default.removeItem(at: dir) }
        #expect(throws: RecapError.self) { try MeetingFile.load(dir) }
    }
}

@Suite struct ChunkIndexContractTests {
    @Test func liveFilesLiveUnderTheMeeting() {
        let dir = URL(fileURLWithPath: "/tmp/meeting")
        #expect(LiveFiles.chunks(dir).path == "/tmp/meeting/live/chunks")
        #expect(LiveFiles.chunkIndex(dir).path == "/tmp/meeting/live/chunks/index.jsonl")
        #expect(LiveFiles.workerLog(dir).path == "/tmp/meeting/live/worker.log")
    }

    @Test func chunkFilesAreNamedByChannelAndSequence() {
        #expect(LiveFiles.chunkFileName(channel: .mic, seq: 1) == "mic-00001.wav")
        #expect(LiveFiles.chunkFileName(channel: .system, seq: 123) == "system-00123.wav")
    }

    @Test func indexLinesAreCompactSortedAndOmitSilentFiles() throws {
        let speech = ChunkIndexEntry(file: "mic-00001.wav", channel: .mic, seq: 1, startMs: 0, endMs: 9_870)
        let silence = ChunkIndexEntry(file: nil, channel: .system, seq: 2, startMs: 9_870, endMs: 12_000)
        #expect(try JSONLines.line(speech) == #"{"channel":"mic","endMs":9870,"file":"mic-00001.wav","seq":1,"startMs":0}"#)
        #expect(try JSONLines.line(silence) == #"{"channel":"system","endMs":12000,"seq":2,"startMs":9870}"#)
    }

    @Test func indexAppendsOneLinePerChunkAndReadsBack() throws {
        let dir = try temporaryDirectory()
        defer { try? FileManager.default.removeItem(at: dir) }
        let index = LiveFiles.chunkIndex(dir)
        let entries = [
            ChunkIndexEntry(file: "mic-00001.wav", channel: .mic, seq: 1, startMs: 0, endMs: 5_000),
            ChunkIndexEntry(file: nil, channel: .mic, seq: 2, startMs: 5_000, endMs: 8_000),
        ]
        try JSONLines.append([entries[0]], to: index)
        try JSONLines.append([entries[1]], to: index)
        let text = try String(contentsOf: index, encoding: .utf8)
        #expect(text.split(separator: "\n").count == 2)
        #expect(text.hasSuffix("\n"))
        #expect(JSONLines.read(ChunkIndexEntry.self, from: index) == entries)
    }

    @Test func chunksAreSixteenKilohertzMonoPCM() throws {
        let dir = try temporaryDirectory()
        defer { try? FileManager.default.removeItem(at: dir) }
        let url = dir.appending(path: LiveFiles.chunkFileName(channel: .mic, seq: 1))
        try WavFile.writeAtomically([0, 0.5, -0.5, 1], sampleRate: LiveChunker.sampleRate, to: url)
        let data = try Data(contentsOf: url)
        func uint32(_ offset: Int) -> UInt32 { data[offset..<offset + 4].reversed().reduce(0) { $0 << 8 | UInt32($1) } }
        func uint16(_ offset: Int) -> UInt16 { data[offset..<offset + 2].reversed().reduce(0) { $0 << 8 | UInt16($1) } }
        #expect(String(decoding: data[0..<4], as: UTF8.self) == "RIFF")
        #expect(String(decoding: data[8..<12], as: UTF8.self) == "WAVE")
        #expect(uint16(20) == 1)
        #expect(uint16(22) == 1)
        #expect(uint32(24) == 16_000)
        #expect(uint16(34) == 16)
        #expect(uint32(40) == 8)
        #expect(data.count == 44 + 8)
        #expect(!FileManager.default.fileExists(atPath: dir.appending(path: ".mic-00001.wav.tmp").path))
    }

    @Test func liveSettingsDefaultToEnabledTenSecondChunks() {
        let defaults = LiveSettings(nil)
        #expect(defaults.enabled)
        #expect(defaults.maxChunkSeconds == 10)
        #expect(LiveSettings(LiveConfig(enabled: false, maxChunkSeconds: 500)).maxChunkSeconds == 60)
        #expect(!LiveSettings(LiveConfig(enabled: false)).enabled)
    }
}

@Suite struct CaptureArgumentTests {
    @Test func recordTakesTheMeetingDirectoryAndAnOptionalWorker() throws {
        let plain = try CaptureRecordCommand.parse(["/tmp/meeting"])
        #expect(plain.meetingDir == "/tmp/meeting")
        #expect(plain.liveWorker == nil)
        let custom = try CaptureRecordCommand.parse(["/tmp/meeting", "--live-worker", #"["node","recap.ts","live-worker"]"#])
        #expect(custom.liveWorker == #"["node","recap.ts","live-worker"]"#)
        #expect(throws: (any Error).self) { try CaptureRecordCommand.parse([]) }
    }

    @Test func permissionsFlags() throws {
        let check = try CapturePermissionsCommand.parse([])
        #expect(!check.request)
        #expect(!check.output.json)
        let ask = try CapturePermissionsCommand.parse(["--request", "--json"])
        #expect(ask.request)
        #expect(ask.output.json)
    }

    @Test func rootRoutesEachSubcommand() throws {
        #expect(try TestRoot.parseAsRoot(["record", "/tmp/m"]) is CaptureRecordCommand)
        #expect(try TestRoot.parseAsRoot(["permissions", "--json"]) is CapturePermissionsCommand)
        #expect(try TestRoot.parseAsRoot(["capabilities", "--json"]) is CaptureCapabilitiesCommand)
    }

    @Test func unknownCommandsWithJSONPrintAUsageEnvelope() throws {
        let arguments = ["bogus", "--json"]
        var failure: Error?
        do { _ = try TestRoot.parseAsRoot(arguments) } catch { failure = error }
        let error = try #require(failure)
        let line = try #require(CaptureCLI.usageEnvelope(TestRoot.self, arguments: arguments, error: error))
        #expect(!line.contains("\n"))
        let object = try jsonObject(line)
        #expect(object["ok"] as? Bool == false)
        #expect(object["command"] as? String == "bogus")
        let body = try #require(object["error"] as? [String: Any])
        #expect(body["code"] as? String == "USAGE")
        #expect((body["message"] as? String)?.contains("bogus") == true)
        #expect(CaptureCLI.usageEnvelope(TestRoot.self, arguments: ["bogus"], error: error) == nil)
        #expect(CaptureCLI.usageEnvelope(TestRoot.self, arguments: ["bogus", "--", "--json"], error: error) == nil)
    }
}

@Suite struct CapabilitiesEnvelopeTests {
    @Test func capabilitiesFollowTheKitEnvelopeOnOneLine() throws {
        let line = try #require(Output.render(Output.success("capabilities", CaptureCapabilities()), compact: true))
        #expect(!line.contains("\n"))
        let object = try jsonObject(line)
        #expect(object["schemaVersion"] as? Int == 1)
        #expect(object["ok"] as? Bool == true)
        #expect(object["command"] as? String == "capabilities")
        #expect(object["generatedAt"] is String)
        let data = try #require(object["data"] as? [String: Any])
        #expect(data["name"] as? String == "recap-capture")
        #expect(data["version"] as? String == CaptureTool.version)
        #expect(data["envelope"] as? Int == 1)
        #expect(data["capabilities"] as? [String] == ["capture.remote", "capture.in-person", "capture.live-chunks"])
        #expect(data["emits"] as? [String] == [])
    }

    @Test func permissionsReportBothStatuses() throws {
        let report = CapturePermissions(microphone: "granted", screen: "denied")
        let line = try #require(Output.render(Output.success("permissions", report), compact: true))
        let data = try #require(try jsonObject(line)["data"] as? [String: String])
        #expect(data == ["microphone": "granted", "screen": "denied"])
        #expect(report.text == "microphone: granted\nscreen: denied")
    }

    @Test func failuresCarryCodeAndMessage() throws {
        let line = try #require(Output.render(Output.failureEnvelope("record", RecapError("NO_DISPLAY", "No display")), compact: true))
        let object = try jsonObject(line)
        #expect(object["ok"] as? Bool == false)
        #expect(object["data"] == nil)
        #expect((object["error"] as? [String: String]) == ["code": "NO_DISPLAY", "message": "No display"])
    }
}

@Suite struct LiveWorkerLaunchTests {
    private func executable(named name: String, in dir: URL) throws -> URL {
        let url = dir.appending(path: name)
        try Data("#!/bin/sh\n".utf8).write(to: url)
        try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: url.path)
        return url
    }

    @Test func defaultsToTheSiblingRecap() throws {
        let dir = try temporaryDirectory()
        defer { try? FileManager.default.removeItem(at: dir) }
        let recap = try executable(named: "recap", in: dir)
        let launch = try #require(try LiveWorkerLaunch.resolve(option: nil, environment: [:], executable: dir.appending(path: "recap-capture")))
        #expect(launch.executable.path == recap.path)
        #expect(launch.arguments(for: URL(fileURLWithPath: "/tmp/m")) == ["live-worker", "/tmp/m"])
    }

    @Test func otherExecutablesSpawnThemselves() throws {
        let recap = URL(fileURLWithPath: "/Applications/Recap.app/Contents/MacOS/recap")
        let launch = try #require(try LiveWorkerLaunch.resolve(option: nil, environment: [:], executable: recap))
        #expect(launch == LiveWorkerLaunch(executable: recap, arguments: ["live-worker"]))
    }

    @Test func theLauncherForwardsTheWorkerSettingThroughOpen() {
        let app = URL(fileURLWithPath: "/Applications/Recap.app")
        let dir = URL(fileURLWithPath: "/tmp/m")
        let log = dir.appending(path: "recorder.log")
        let plain = RecorderLauncher.openArguments(app: app, dir: dir, log: log, environment: [:])
        #expect(plain == ["-g", "-n", "-a", app.path, "--stdout", log.path, "--stderr", log.path, "--args", "record", dir.path])
        let forwarded = RecorderLauncher.openArguments(app: app, dir: dir, log: log,
                                                       environment: [LiveWorkerLaunch.environmentKey: "none"])
        #expect(forwarded.prefix(6) == ["-g", "-n", "-a", app.path, "--env", "RECAP_LIVE_WORKER=none"])
        #expect(forwarded.suffix(3) == ["--args", "record", dir.path])
    }

    @Test func missingSiblingIsReported() throws {
        let dir = try temporaryDirectory()
        defer { try? FileManager.default.removeItem(at: dir) }
        #expect(throws: RecapError.self) {
            try LiveWorkerLaunch.resolve(option: nil, environment: [:], executable: dir.appending(path: "recap-capture"))
        }
    }

    @Test func optionWinsOverTheEnvironment() throws {
        let dir = try temporaryDirectory()
        defer { try? FileManager.default.removeItem(at: dir) }
        let fromOption = try executable(named: "worker-a", in: dir)
        let fromEnvironment = try executable(named: "worker-b", in: dir)
        let environment = [LiveWorkerLaunch.environmentKey: fromEnvironment.path]
        let chosen = try #require(try LiveWorkerLaunch.resolve(option: fromOption.path, environment: environment, executable: nil))
        #expect(chosen.executable.path == fromOption.path)
        #expect(chosen.arguments == ["live-worker"])
        let fallback = try #require(try LiveWorkerLaunch.resolve(option: nil, environment: environment, executable: nil))
        #expect(fallback.executable.path == fromEnvironment.path)
    }

    @Test func jsonArrayIsTheFullCommand() throws {
        let dir = try temporaryDirectory()
        defer { try? FileManager.default.removeItem(at: dir) }
        let node = try executable(named: "node", in: dir)
        let raw = "[\"\(node.path)\", \"/opt/recap/src/bin/recap.ts\", \"live-worker\"]"
        let launch = try #require(try LiveWorkerLaunch.resolve(option: raw, environment: [:], executable: nil))
        #expect(launch.executable.path == node.path)
        #expect(launch.arguments(for: URL(fileURLWithPath: "/tmp/m")) == ["/opt/recap/src/bin/recap.ts", "live-worker", "/tmp/m"])
    }

    @Test func noneDisablesTheWorker() throws {
        #expect(try LiveWorkerLaunch.resolve(option: "none", environment: [:], executable: nil) == nil)
        #expect(try LiveWorkerLaunch.resolve(option: nil, environment: [LiveWorkerLaunch.environmentKey: "off"], executable: nil) == nil)
    }

    @Test func invalidCommandsAreRejected() {
        #expect(throws: RecapError.self) { try LiveWorkerLaunch.resolve(option: "[1, 2]", environment: [:], executable: nil) }
        #expect(throws: RecapError.self) { try LiveWorkerLaunch.resolve(option: "[]", environment: [:], executable: nil) }
        #expect(throws: RecapError.self) {
            try LiveWorkerLaunch.resolve(option: "/nonexistent/recap", environment: [:], executable: nil)
        }
    }
}
