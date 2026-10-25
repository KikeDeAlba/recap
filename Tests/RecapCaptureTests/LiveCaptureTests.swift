import AVFoundation
import CoreGraphics
import CoreMedia
import Foundation
import ImageIO
import Testing
@testable import RecapCapture

private func temporaryDirectory() throws -> URL {
    let dir = FileManager.default.temporaryDirectory.appending(path: "recap-live-capture-tests-\(UUID().uuidString)")
    try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    return dir
}

private func jsonObject(_ data: Data) throws -> [String: Any] {
    try #require(JSONSerialization.jsonObject(with: data) as? [String: Any])
}

private func encoded<T: Encodable>(_ value: T) throws -> String {
    String(decoding: try Output.compactEncoder.encode(value), as: UTF8.self)
}

private let since = Date(timeIntervalSince1970: 1_792_929_600)

private final class FakeCaptureHandler: CaptureControlHandler {
    var calls: [String] = []
    var failure: RecapError?
    var video: CaptureVideo?
    var sourcesDelay: UInt64 = 0

    func setTarget(_ target: CaptureTargetRef) async throws -> CaptureStatus {
        calls.append("set \(target.kind.rawValue) \(target.id)")
        if let failure { throw failure }
        video = CaptureVideo(kind: target.kind, id: target.id, title: "Zoom Meeting", app: target.kind == .window ? "zoom.us" : nil, since: since)
        return CaptureStatus(mic: true, video: video)
    }

    func clearTarget() async throws -> CaptureStatus {
        calls.append("clear")
        if let failure { throw failure }
        video = nil
        return CaptureStatus(mic: true, video: nil)
    }

    func sources(thumbnails: Bool) async throws -> CaptureSources {
        if sourcesDelay > 0 { try await Task.sleep(nanoseconds: sourcesDelay) }
        calls.append("sources \(thumbnails)")
        if let failure { throw failure }
        return CaptureSources(displays: [DisplaySource(id: 1, name: "Built-in Retina Display", width: 1512, height: 982, main: true)],
                              windows: [])
    }
}

private func issued(_ date: Date = Date()) -> String {
    String(Int(date.timeIntervalSince1970 * 1000))
}

private func writeRequest(_ dir: URL, _ body: String, id: String) throws {
    let control = ControlServer.directory(dir)
    try FileManager.default.createDirectory(at: control, withIntermediateDirectories: true)
    let stamped = body.contains("issuedAt") ? body : "{\"issuedAt\":\(issued())," + body.dropFirst()
    try Data(stamped.utf8).write(to: control.appending(path: id + ControlServer.requestSuffix))
}

private func errorCode(_ dir: URL, id: String) throws -> String? {
    (try response(dir, id: id)["error"] as? [String: Any])?["code"] as? String
}

private func mode(_ path: String) -> mode_t {
    var info = stat()
    lstat(path, &info)
    return info.st_mode & 0o777
}

private func response(_ dir: URL, id: String) throws -> [String: Any] {
    try jsonObject(try Data(contentsOf: ControlServer.responseURL(dir, id: id)))
}

@Suite struct CaptureManifestTests {
    @Test func segmentsFollowTheTargetsOfTheMeeting() {
        var manifest = CaptureManifest(startedAt: since)
        #expect(manifest.nextSegmentFile == "screen-1.mov")
        let display = CaptureVideo(kind: .display, id: 1, title: "Built-in Retina Display", app: nil, since: since)
        let window = CaptureVideo(kind: .window, id: 4242, title: "Zoom Meeting", app: "zoom.us", since: since)
        #expect(manifest.beginSegment(display, atMs: 1_000) == "screen-1.mov")
        manifest.markSegmentStart("screen-1.mov", atMs: 1_250)
        manifest.switchTarget(window, atMs: 5_000)
        #expect(manifest.video == window)
        manifest.endSegment(atMs: 9_000)
        #expect(manifest.video == nil)
        #expect(manifest.openSegment == nil)
        #expect(manifest.beginSegment(window, atMs: 12_000) == "screen-2.mov")
        manifest.endSegment(atMs: 13_000, error: "WINDOW_GONE: closed")
        #expect(manifest.segments == [
            CaptureSegment(file: "screen-1.mov", startMs: 1_250, endMs: 9_000, targets: [
                CaptureSegmentTarget(display, atMs: 1_250),
                CaptureSegmentTarget(window, atMs: 5_000),
            ]),
            CaptureSegment(file: "screen-2.mov", startMs: 12_000, endMs: 13_000, targets: [CaptureSegmentTarget(window, atMs: 12_000)]),
        ])
        #expect(manifest.error == "WINDOW_GONE: closed")
    }

    @Test func aSegmentWithoutSamplesIsDropped() {
        var manifest = CaptureManifest(startedAt: since)
        let window = CaptureVideo(kind: .window, id: 7, title: "Notes", app: "Notes", since: since)
        manifest.beginSegment(window, atMs: 100)
        manifest.dropSegment("screen-1.mov")
        #expect(manifest.segments.isEmpty)
        #expect(manifest.video == nil)
        #expect(manifest.nextSegmentFile == "screen-1.mov")
    }

    @Test func theStoreWritesCaptureJSONNextToTheMeeting() throws {
        let dir = try temporaryDirectory()
        defer { try? FileManager.default.removeItem(at: dir) }
        let store = CaptureManifestStore(dir: dir, startedAt: since)
        store.update { $0.beginSegment(CaptureVideo(kind: .display, id: 2, title: "LG", app: nil, since: since), atMs: 0) }
        let object = try jsonObject(try Data(contentsOf: dir.appending(path: "capture.json")))
        #expect(object["mic"] as? String == "mic.m4a")
        #expect(object["startedAt"] as? String == "2026-10-25T12:00:00Z")
        let video = try #require(object["video"] as? [String: Any])
        #expect(video["app"] is NSNull)
        #expect(video["kind"] as? String == "display")
        let segments = try #require(object["segments"] as? [[String: Any]])
        #expect(segments.first?["file"] as? String == "screen-1.mov")
        #expect(CaptureManifestStore.load(dir) == store.current)
    }

    @Test func statusAlwaysCarriesVideoAndSystemAudio() throws {
        #expect(try encoded(CaptureStatus(mic: true, video: nil)) == #"{"mic":true,"systemAudio":false,"video":null}"#)
        let window = CaptureVideo(kind: .window, id: 9, title: "Meet", app: "Google Chrome", since: since)
        #expect(try encoded(CaptureStatus(mic: true, video: window))
            == #"{"mic":true,"systemAudio":true,"video":{"app":"Google Chrome","id":9,"kind":"window","since":"2026-10-25T12:00:00Z","title":"Meet"}}"#)
    }

    @Test func theCanvasKeepsTheDisplayAspectAtAnEvenHeight() {
        #expect(CaptureClock.canvas(width: 1512, height: 982) == (1280, 830))
        #expect(CaptureClock.canvas(width: 1920, height: 1080) == (1280, 720))
        #expect(CaptureClock.canvas(width: 0, height: 0) == (1280, 720))
    }
}

private actor Steps {
    var items: [String] = []
    func add(_ item: String) { items.append(item) }
}

@Suite struct SerialWorkTests {
    @Test @MainActor func closeWaitsForTheChangeInFlightAndRefusesTheRest() async throws {
        let work = SerialWork()
        let steps = Steps()
        let first = Task { @MainActor in
            try await work.run {
                await steps.add("set begins")
                try await Task.sleep(nanoseconds: 150_000_000)
                await steps.add("set ends")
                return 1
            }
        }
        try await Task.sleep(nanoseconds: 20_000_000)
        let queued = Task { @MainActor in try await work.run { await steps.add("queued"); return 2 } }
        await work.close()
        await steps.add("closed")
        #expect(try await first.value == 1)
        await #expect(throws: RecapError.self) { try await queued.value }
        await #expect(throws: RecapError.self) { try await work.run { 3 } }
        #expect(await steps.items == ["set begins", "set ends", "closed"])
    }

    @Test @MainActor func aStopReportWaitsForTheQueuedSetAndIsSkippedOnceClosed() async throws {
        let work = SerialWork()
        let steps = Steps()
        var segment = "screen-1"
        let set = Task { @MainActor in
            try await work.run {
                try await Task.sleep(nanoseconds: 150_000_000)
                segment = "screen-2"
                await steps.add("set opened \(segment)")
            }
        }
        try await Task.sleep(nanoseconds: 20_000_000)
        let stopped = "screen-1"
        await work.runUnlessClosed {
            await steps.add(stopped == segment ? "closed \(segment)" : "kept \(segment)")
        }
        try await set.value
        await work.close()
        await work.runUnlessClosed { await steps.add("after close") }
        #expect(await steps.items == ["set opened screen-2", "kept screen-2"])
    }
}

@Suite struct ControlServerTests {
    @Test func setRequestsReachTheRecorderAndGetTheStatusBack() async throws {
        let dir = try temporaryDirectory()
        defer { try? FileManager.default.removeItem(at: dir) }
        let handler = FakeCaptureHandler()
        let server = ControlServer(meetingDir: dir, handler: handler)
        try writeRequest(dir, #"{"id":"a1","action":"set","target":{"kind":"window","id":4242}}"#, id: "a1")
        await server.poll()
        #expect(handler.calls == ["set window 4242"])
        let reply = try response(dir, id: "a1")
        #expect(reply["ok"] as? Bool == true)
        #expect(reply["id"] as? String == "a1")
        let data = try #require(reply["data"] as? [String: Any])
        #expect(data["systemAudio"] as? Bool == true)
        #expect((data["video"] as? [String: Any])?["app"] as? String == "zoom.us")
        #expect(!FileManager.default.fileExists(atPath: ControlServer.directory(dir).appending(path: "a1.request.json").path))
    }

    @Test func requestsRunInNameOrder() async throws {
        let dir = try temporaryDirectory()
        defer { try? FileManager.default.removeItem(at: dir) }
        let handler = FakeCaptureHandler()
        let server = ControlServer(meetingDir: dir, handler: handler)
        try writeRequest(dir, #"{"id":"0002-b","action":"clear"}"#, id: "0002-b")
        try writeRequest(dir, #"{"id":"0001-a","action":"set","target":{"kind":"display","id":1}}"#, id: "0001-a")
        try writeRequest(dir, #"{"id":"0003-c","action":"sources","thumbnails":true}"#, id: "0003-c")
        await server.poll()
        #expect(handler.calls.filter { $0 != "sources true" } == ["set display 1", "clear"])
        #expect(handler.calls.contains("sources true"))
        let sources = try #require(try response(dir, id: "0003-c")["data"] as? [String: Any])
        #expect((sources["displays"] as? [[String: Any]])?.first?["name"] as? String == "Built-in Retina Display")
        #expect((sources["windows"] as? [Any])?.isEmpty == true)
    }

    @Test func recorderErrorsComeBackWithTheirCode() async throws {
        let dir = try temporaryDirectory()
        defer { try? FileManager.default.removeItem(at: dir) }
        let handler = FakeCaptureHandler()
        handler.failure = RecapError("WINDOW_GONE", "Window 5 is closed or no longer on screen")
        let server = ControlServer(meetingDir: dir, handler: handler)
        try writeRequest(dir, #"{"id":"w5","action":"set","target":{"kind":"window","id":5}}"#, id: "w5")
        await server.poll()
        let reply = try response(dir, id: "w5")
        #expect(reply["ok"] as? Bool == false)
        let error = try #require(reply["error"] as? [String: Any])
        #expect(error["code"] as? String == "WINDOW_GONE")
        #expect(reply["data"] == nil)
    }

    @Test func invalidRequestsAreAnsweredAndUnsafeNamesIgnored() async throws {
        let dir = try temporaryDirectory()
        defer { try? FileManager.default.removeItem(at: dir) }
        let handler = FakeCaptureHandler()
        let server = ControlServer(meetingDir: dir, handler: handler)
        try writeRequest(dir, #"{"id":"bad","action":"explode"}"#, id: "bad")
        try writeRequest(dir, #"{"id":"other","action":"clear"}"#, id: "mismatch")
        try writeRequest(dir, #"{"id":"x.y","action":"clear"}"#, id: "x.y")
        try writeRequest(dir, #"{"id":"set","action":"set"}"#, id: "set")
        await server.poll()
        #expect(handler.calls.isEmpty)
        #expect((try response(dir, id: "bad")["error"] as? [String: Any])?["code"] as? String == "CONTROL_INVALID")
        #expect((try response(dir, id: "mismatch")["error"] as? [String: Any])?["code"] as? String == "CONTROL_INVALID")
        #expect((try response(dir, id: "set")["error"] as? [String: Any])?["code"] as? String == "CONTROL_INVALID")
        #expect(!FileManager.default.fileExists(atPath: ControlServer.responseURL(dir, id: "x.y").path))
        #expect(server.pendingRequests().isEmpty)
    }

    @Test func theTimerAnswersWhileRecordingAndStopRejectsTheRest() async throws {
        let dir = try temporaryDirectory()
        defer { try? FileManager.default.removeItem(at: dir) }
        let handler = FakeCaptureHandler()
        let server = ControlServer(meetingDir: dir, handler: handler, interval: 0.02)
        try server.start()
        try writeRequest(dir, #"{"id":"live","action":"clear"}"#, id: "live")
        let answered = ControlServer.responseURL(dir, id: "live")
        let deadline = Date().addingTimeInterval(5)
        while !FileManager.default.fileExists(atPath: answered.path), Date() < deadline {
            try await Task.sleep(nanoseconds: 20_000_000)
        }
        #expect(try response(dir, id: "live")["ok"] as? Bool == true)
        server.stop()
        try writeRequest(dir, #"{"id":"late","action":"clear"}"#, id: "late")
        server.stop()
        let late = try response(dir, id: "late")
        #expect(late["ok"] as? Bool == false)
        #expect((late["error"] as? [String: Any])?["code"] as? String == "NOT_RECORDING")
        #expect(handler.calls == ["clear"])
    }

    @Test func setAndClearDoNotWaitForThumbnails() async throws {
        let dir = try temporaryDirectory()
        defer { try? FileManager.default.removeItem(at: dir) }
        let handler = FakeCaptureHandler()
        handler.sourcesDelay = 400_000_000
        let server = ControlServer(meetingDir: dir, handler: handler)
        try writeRequest(dir, #"{"id":"0001-a","action":"sources","thumbnails":true}"#, id: "0001-a")
        try writeRequest(dir, #"{"id":"0002-b","action":"set","target":{"kind":"display","id":1}}"#, id: "0002-b")
        await server.pollCommands()
        #expect(try response(dir, id: "0002-b")["ok"] as? Bool == true)
        #expect(!FileManager.default.fileExists(atPath: ControlServer.responseURL(dir, id: "0001-a").path))
        await server.waitForLookups()
        #expect(try response(dir, id: "0001-a")["ok"] as? Bool == true)
        #expect(handler.calls == ["set display 1", "sources true"])
    }

    @Test func staleOrUndatedRequestsAreRefused() async throws {
        let dir = try temporaryDirectory()
        defer { try? FileManager.default.removeItem(at: dir) }
        let handler = FakeCaptureHandler()
        let server = ControlServer(meetingDir: dir, handler: handler)
        let old = issued(Date().addingTimeInterval(-31))
        let ahead = issued(Date().addingTimeInterval(60))
        try writeRequest(dir, #"{"issuedAt":"# + old + #","id":"old","action":"clear"}"#, id: "old")
        try writeRequest(dir, #"{"issuedAt":"# + ahead + #","id":"ahead","action":"clear"}"#, id: "ahead")
        try writeRequest(dir, #"{"issuedAt":null,"id":"undated","action":"clear"}"#, id: "undated")
        await server.poll()
        #expect(handler.calls.isEmpty)
        #expect(try errorCode(dir, id: "old") == "CONTROL_EXPIRED")
        #expect(try errorCode(dir, id: "ahead") == "CONTROL_EXPIRED")
        #expect(try errorCode(dir, id: "undated") == "CONTROL_EXPIRED")
    }

    @Test func linkedForeignOrLargeRequestsAreNotRead() async throws {
        let dir = try temporaryDirectory()
        defer { try? FileManager.default.removeItem(at: dir) }
        let handler = FakeCaptureHandler()
        let server = ControlServer(meetingDir: dir, handler: handler)
        let control = ControlServer.directory(dir)
        try FileManager.default.createDirectory(at: control, withIntermediateDirectories: true)
        let outside = dir.appending(path: "outside.json")
        try Data(("{\"issuedAt\":\(issued()),\"id\":\"link\",\"action\":\"clear\"}").utf8).write(to: outside)
        try FileManager.default.createSymbolicLink(at: control.appending(path: "link.request.json"), withDestinationURL: outside)
        try writeRequest(dir, #"{"id":"big","action":"clear","pad":""# + String(repeating: "x", count: 4_200) + #""}"#, id: "big")
        try FileManager.default.createDirectory(at: control.appending(path: "dir.request.json"), withIntermediateDirectories: true)
        await server.poll()
        #expect(handler.calls.isEmpty)
        #expect(server.pendingRequests().isEmpty)
        #expect(try errorCode(dir, id: "link") == "CONTROL_INVALID")
        #expect(try errorCode(dir, id: "big") == "CONTROL_INVALID")
        #expect(FileManager.default.fileExists(atPath: outside.path))
    }

    @Test func theControlFolderIsPrivateAndStartsEmpty() async throws {
        let dir = try temporaryDirectory()
        defer { try? FileManager.default.removeItem(at: dir) }
        let elsewhere = dir.appending(path: "elsewhere")
        try FileManager.default.createDirectory(at: elsewhere, withIntermediateDirectories: true)
        try Data("keep".utf8).write(to: elsewhere.appending(path: "keep.txt"))
        try FileManager.default.createSymbolicLink(at: ControlServer.directory(dir), withDestinationURL: elsewhere)
        let handler = FakeCaptureHandler()
        let server = ControlServer(meetingDir: dir, handler: handler, interval: 0.02)
        try server.start()
        defer { server.stop() }
        let control = ControlServer.directory(dir)
        #expect(mode(control.path) == 0o700)
        #expect(FileManager.default.fileExists(atPath: elsewhere.appending(path: "keep.txt").path))
        #expect(try FileManager.default.contentsOfDirectory(atPath: control.path).isEmpty)
        try writeRequest(dir, #"{"id":"p1","action":"clear"}"#, id: "p1")
        let answered = ControlServer.responseURL(dir, id: "p1")
        let deadline = Date().addingTimeInterval(5)
        while !FileManager.default.fileExists(atPath: answered.path), Date() < deadline {
            try await Task.sleep(nanoseconds: 20_000_000)
        }
        #expect(mode(answered.path) == 0o600)
        #expect(try FileManager.default.contentsOfDirectory(atPath: control.path) == ["p1.response.json"])
    }

    @Test func startClearsLeftoversAndPollSweepsOldAnswers() async throws {
        let dir = try temporaryDirectory()
        defer { try? FileManager.default.removeItem(at: dir) }
        let control = ControlServer.directory(dir)
        try FileManager.default.createDirectory(at: control, withIntermediateDirectories: true)
        try Data("{}".utf8).write(to: control.appending(path: "left.request.json"))
        try ControlFiles.prepare(control)
        #expect(try FileManager.default.contentsOfDirectory(atPath: control.path).isEmpty)
        let handler = FakeCaptureHandler()
        let server = ControlServer(meetingDir: dir, handler: handler)
        let stale = control.appending(path: "gone.response.json")
        let fresh = control.appending(path: "kept.response.json")
        try Data("{}".utf8).write(to: stale)
        try Data("{}".utf8).write(to: fresh)
        let old = Date().addingTimeInterval(-ControlServer.responseLifetime - 30)
        try FileManager.default.setAttributes([.modificationDate: old], ofItemAtPath: stale.path)
        await server.poll()
        #expect(try FileManager.default.contentsOfDirectory(atPath: control.path) == ["kept.response.json"])
    }

    @Test func idsAreShortAndSafeForFileNames() {
        #expect(ControlServer.isValidId("7c9e6679-7425-40de-944b-e07fc1f90ae7"))
        #expect(!ControlServer.isValidId(""))
        #expect(!ControlServer.isValidId("../meeting"))
        #expect(!ControlServer.isValidId(String(repeating: "a", count: 65)))
    }
}

@Suite struct SourceCatalogTests {
    private let zoom = WindowCandidate(id: 10, app: "zoom.us", bundleId: "us.zoom.xos", title: "Zoom Meeting", pid: 500, width: 1280, height: 800)

    @Test func windowsOfDenAndRecapAreLeftOut() {
        let den = WindowCandidate(id: 11, app: "Den", bundleId: "com.kikedealba.den", title: "Den", pid: 501, width: 1280, height: 820)
        let recap = WindowCandidate(id: 12, app: "Recap", bundleId: "com.kikedealba.recap", title: "Recap", pid: 502, width: 400, height: 300)
        let denDev = WindowCandidate(id: 13, app: "Den", bundleId: "com.kikedealba.den.dev", title: "Den", pid: 503, width: 900, height: 600)
        let lookalike = WindowCandidate(id: 14, app: "Dentist", bundleId: "com.kikedealba.dentist", title: "Agenda", pid: 504, width: 900, height: 600)
        #expect(SourceCatalog.selectWindows([zoom, den, recap, denDev, lookalike], ownPid: 1).map(\.id) == [10, 14])
    }

    @Test func onlyNormalVisibleTitledWindowsAreListed() {
        let menu = WindowCandidate(id: 20, app: "Control Center", bundleId: "com.apple.controlcenter", title: "Wi-Fi", pid: 600, width: 300, height: 400, layer: 25)
        let hidden = WindowCandidate(id: 21, app: "Notes", bundleId: "com.apple.Notes", title: "Notes", pid: 601, width: 800, height: 600, onScreen: false)
        let tiny = WindowCandidate(id: 22, app: "Chrome", bundleId: "com.google.Chrome", title: "Popup", pid: 602, width: 100, height: 40)
        let untitled = WindowCandidate(id: 23, app: "Slack", bundleId: "com.tinyspeck.slackmacgap", title: "  ", pid: 603, width: 800, height: 600)
        let noBundle = WindowCandidate(id: 24, app: "helper", bundleId: "", title: "helper", pid: 604, width: 800, height: 600)
        let own = WindowCandidate(id: 25, app: "recap-capture", bundleId: "dev.local.capture", title: "Own", pid: 42, width: 800, height: 600)
        #expect(SourceCatalog.selectWindows([menu, hidden, tiny, untitled, noBundle, own, zoom], ownPid: 42).map(\.id) == [10])
    }

    @Test func thumbnailsAreAbout320PixelsWide() {
        #expect(SourceCatalog.thumbnailSize(width: 1512, height: 982) == (320, 208))
        #expect(SourceCatalog.thumbnailSize(width: 200, height: 100) == (200, 100))
        #expect(SourceCatalog.thumbnailSize(width: 0, height: 0) == (320, 180))
        #expect(SourceCatalog.thumbnailSize(width: 400, height: 4_000) == (24, 240))
        #expect(SourceCatalog.thumbnailSize(width: 20_000, height: 10) == (320, 2))
    }

    @Test func setWindowRefusesDenRecapAndNonNormalWindows() {
        let den = WindowCandidate(id: 11, app: "Den", bundleId: "com.kikedealba.den", title: "", pid: 501, width: 50, height: 50)
        let panel = WindowCandidate(id: 12, app: "zoom.us", bundleId: "us.zoom.xos", title: "", pid: 500, width: 50, height: 50, layer: 3)
        let own = WindowCandidate(id: 13, app: "Recap", bundleId: "dev.local", title: "x", pid: 42, width: 800, height: 600)
        let untitled = WindowCandidate(id: 14, app: "zoom.us", bundleId: "us.zoom.xos", title: "", pid: 500, width: 50, height: 50)
        #expect(!SourceCatalog.isRecordable(den, ownPid: 42))
        #expect(!SourceCatalog.isRecordable(panel, ownPid: 42))
        #expect(!SourceCatalog.isRecordable(own, ownPid: 42))
        #expect(SourceCatalog.isRecordable(untitled, ownPid: 42))
        #expect(SourceCatalog.isExcludedApplication(bundleId: "com.kikedealba.den", pid: 7, ownPid: 42))
        #expect(SourceCatalog.isExcludedApplication(bundleId: "us.zoom.xos", pid: 42, ownPid: 42))
        #expect(!SourceCatalog.isExcludedApplication(bundleId: "us.zoom.xos", pid: 7, ownPid: 42))
    }

    @Test func largeThumbnailsAreDropped() throws {
        let context = try #require(CGContext(data: nil, width: 64, height: 64, bitsPerComponent: 8, bytesPerRow: 0,
                                              space: CGColorSpaceCreateDeviceRGB(),
                                              bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue))
        let image = try #require(context.makeImage())
        #expect(SourceCatalog.jpegDataURL(image) != nil)
        #expect(SourceCatalog.jpegDataURL(image, maxBytes: 16) == nil)
    }

    @Test func thumbnailsAreInlineJPEGDataURLs() throws {
        let context = try #require(CGContext(data: nil, width: 320, height: 200, bitsPerComponent: 8, bytesPerRow: 0,
                                              space: CGColorSpaceCreateDeviceRGB(),
                                              bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue))
        context.setFillColor(CGColor(red: 0.8, green: 0.3, blue: 0.1, alpha: 1))
        context.fill(CGRect(x: 0, y: 0, width: 320, height: 200))
        let image = try #require(context.makeImage())
        let url = try #require(SourceCatalog.jpegDataURL(image))
        #expect(url.hasPrefix("data:image/jpeg;base64,"))
        let data = try #require(Data(base64Encoded: String(url.dropFirst("data:image/jpeg;base64,".count))))
        #expect(data.prefix(3) == Data([0xFF, 0xD8, 0xFF]))
        let source = try #require(CGImageSourceCreateWithData(data as CFData, nil))
        let decoded = try #require(CGImageSourceCreateImageAtIndex(source, 0, nil))
        #expect(decoded.width == 320)
        #expect(decoded.height == 200)
    }

    @Test func sourcesJSONOmitsThumbnailsUnlessAsked() throws {
        let plain = CaptureSources(displays: [DisplaySource(id: 1, name: "Built-in Retina Display", width: 1512, height: 982, main: true)],
                                   windows: [zoom.source])
        #expect(try encoded(plain) == #"{"displays":[{"height":982,"id":1,"main":true,"name":"Built-in Retina Display","width":1512}],"#
            + #""windows":[{"app":"zoom.us","bundleId":"us.zoom.xos","height":800,"id":10,"pid":500,"title":"Zoom Meeting","width":1280}]}"#)
        var withThumbnail = plain
        withThumbnail.windows[0].thumbnail = "data:image/jpeg;base64,AAAA"
        #expect(try encoded(withThumbnail).contains(#""thumbnail":"data:image/jpeg;base64,AAAA""#))
        #expect(plain.text == "display 1 (main): Built-in Retina Display 1512x982\nwindow 10: zoom.us — Zoom Meeting")
    }
}

private func toneBuffer(at position: Int64, frames: Int) throws -> CMSampleBuffer {
    var description = AudioStreamBasicDescription(mSampleRate: 48_000, mFormatID: kAudioFormatLinearPCM,
                                                  mFormatFlags: kLinearPCMFormatFlagIsSignedInteger | kLinearPCMFormatFlagIsPacked,
                                                  mBytesPerPacket: 2, mFramesPerPacket: 1, mBytesPerFrame: 2,
                                                  mChannelsPerFrame: 1, mBitsPerChannel: 16, mReserved: 0)
    var format: CMAudioFormatDescription?
    CMAudioFormatDescriptionCreate(allocator: nil, asbd: &description, layoutSize: 0, layout: nil, magicCookieSize: 0,
                                   magicCookie: nil, extensions: nil, formatDescriptionOut: &format)
    let samples = (0..<frames).map { Int16(8_000 * sin(2 * Double.pi * 440 * Double(position + Int64($0)) / 48_000)) }
    var block: CMBlockBuffer?
    CMBlockBufferCreateWithMemoryBlock(allocator: nil, memoryBlock: nil, blockLength: frames * 2, blockAllocator: nil,
                                       customBlockSource: nil, offsetToData: 0, dataLength: frames * 2,
                                       flags: kCMBlockBufferAssureMemoryNowFlag, blockBufferOut: &block)
    let data = try #require(block)
    samples.withUnsafeBytes { _ = CMBlockBufferReplaceDataBytes(with: $0.baseAddress!, blockBuffer: data, offsetIntoDestination: 0, dataLength: frames * 2) }
    var buffer: CMSampleBuffer?
    CMAudioSampleBufferCreateReadyWithPacketDescriptions(allocator: nil, dataBuffer: data, formatDescription: try #require(format),
                                                         sampleCount: frames,
                                                         presentationTimeStamp: CMTime(value: position, timescale: 48_000),
                                                         packetDescriptions: nil, sampleBufferOut: &buffer)
    return try #require(buffer)
}

@Suite struct MicrophoneFileTests {
    @Test func anUnfinishedMicrophoneFileIsReadableUpToItsLastFragment() async throws {
        let dir = try temporaryDirectory()
        defer { try? FileManager.default.removeItem(at: dir) }
        let url = dir.appending(path: CaptureManifest.micFileName)
        let writer = try MediaWriter(url: url, fileType: .m4a, tracks: [.audio(channels: 1, bitRate: 64_000)])
        defer { writer.cancel() }
        let frames = 4_800
        var position: Int64 = 0
        while Double(position) / 48_000 < 12 {
            writer.append(try toneBuffer(at: position, frames: frames), track: 0)
            position += Int64(frames)
            try await Task.sleep(nanoseconds: 20_000_000)
        }
        try await Task.sleep(nanoseconds: 500_000_000)
        let copy = dir.appending(path: "killed.m4a")
        try FileManager.default.copyItem(at: url, to: copy)
        let duration = try await AVURLAsset(url: copy).load(.duration).seconds
        #expect(MediaWriter.fragmentInterval.seconds == 5)
        #expect(duration >= 12 - 2 * MediaWriter.fragmentInterval.seconds)
    }
}
