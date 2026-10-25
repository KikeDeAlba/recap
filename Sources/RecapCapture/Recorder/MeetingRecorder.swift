import AppKit
import AVFoundation
import CoreMedia
import ScreenCaptureKit

package enum CaptureClock {
    package static var hostNow: CMTime { CMClockGetTime(CMClockGetHostTimeClock()) }

    package static func milliseconds(_ time: CMTime, since origin: CMTime) -> Int {
        guard time.isValid, origin.isValid else { return 0 }
        return max(0, Int(((time - origin).seconds * 1000).rounded()))
    }

    package static func canvas(width: Int, height: Int, targetWidth: Int = MeetingRecorder.videoWidth) -> (width: Int, height: Int) {
        guard width > 0, height > 0 else { return (targetWidth, 720) }
        return (targetWidth, Int((Double(height) / Double(width) * Double(targetWidth)).rounded()) & ~1)
    }
}

final class ScreenSegment: NSObject, SCStreamOutput, SCStreamDelegate {
    let file: String
    let kind: CaptureTargetKind
    var onFirstSample: ((CMTime) -> Void)?
    var onStop: ((Error) -> Void)?

    private let queue = DispatchQueue(label: "recap.screen-segment")
    private let writer: MediaWriter
    private let liveTap: LiveTap?
    private let makeStream: ScreenStreamFactory
    private let timeouts: CaptureTimeouts
    private let lock = NSLock()
    private var stopping = false
    private var sealed = false
    private var stream: ScreenStream?

    init(dir: URL, file: String, kind: CaptureTargetKind, width: Int, height: Int, liveTap: LiveTap?,
         makeStream: @escaping ScreenStreamFactory, timeouts: CaptureTimeouts) throws {
        self.file = file
        self.kind = kind
        self.liveTap = liveTap
        self.makeStream = makeStream
        self.timeouts = timeouts
        writer = try MediaWriter(url: dir.appending(path: file), fileType: .mov, tracks: [
            .video(width: width, height: height),
            .audio(channels: 2, bitRate: 96_000),
        ])
        super.init()
        writer.onStart = { [weak self] pts in self?.onFirstSample?(pts) }
        writer.onFailure = { [weak self] error in self?.report(error) }
    }

    var hasSamples: Bool { writer.hasSamples }

    private var isStopping: Bool { lock.withLock { stopping } }

    func start(filter: SCContentFilter, configuration: SCStreamConfiguration) async throws {
        let stream = try makeStream(filter, configuration, self, queue)
        lock.withLock { self.stream = stream }
        let seconds = timeouts.start
        try await Deadline.run(within: CaptureTimeouts.nanoseconds(seconds),
                               onTimeout: CaptureTimeouts.expired("start the screen capture", after: seconds),
                               startsWhenCancelled: false) { [weak self] in
            try await stream.startCapture()
            if self?.isStopping ?? true { try? await stream.stopCapture() }
        }
    }

    func update(filter: SCContentFilter) async throws {
        guard let stream = lock.withLock({ stopping ? nil : self.stream }) else {
            throw RecapError("CAPTURE_FAILED", "The screen capture is not running")
        }
        let seconds = timeouts.update
        try await Deadline.run(within: CaptureTimeouts.nanoseconds(seconds),
                               onTimeout: CaptureTimeouts.expired("switch the screen capture", after: seconds),
                               startsWhenCancelled: false) {
            try await stream.updateContentFilter(filter)
        }
    }

    func stop() async -> CMTime? {
        let stream = lock.withLock { () -> ScreenStream? in
            stopping = true
            defer { self.stream = nil }
            return self.stream
        }
        if let stream {
            let seconds = timeouts.stop
            await Task {
                _ = try? await Deadline.run(within: CaptureTimeouts.nanoseconds(seconds),
                                            onTimeout: CaptureTimeouts.expired("stop the screen capture", after: seconds)) {
                    try await stream.stopCapture()
                }
            }.value
        }
        lock.withLock { sealed = true }
        await withCheckedContinuation { continuation in queue.async { continuation.resume() } }
        await writer.finish()
        return writer.endTime
    }

    func stream(_ stream: SCStream, didOutputSampleBuffer sampleBuffer: CMSampleBuffer, of type: SCStreamOutputType) {
        guard !lock.withLock({ sealed }) else { return }
        switch type {
        case .screen:
            if Self.isCompleteFrame(sampleBuffer) { writer.append(sampleBuffer, track: 0) }
        case .audio:
            writer.append(sampleBuffer, track: 1)
            liveTap?.append(sampleBuffer, channel: .system)
        default:
            break
        }
    }

    func stream(_ stream: SCStream, didStopWithError error: Error) {
        report(error)
    }

    private func report(_ error: Error) {
        guard !isStopping else { return }
        onStop?(error)
    }

    private static func isCompleteFrame(_ sampleBuffer: CMSampleBuffer) -> Bool {
        guard let attachments = CMSampleBufferGetSampleAttachmentsArray(sampleBuffer, createIfNecessary: false)
                as? [[SCStreamFrameInfo: Any]],
              let rawStatus = attachments.first?[.status] as? Int,
              let status = SCFrameStatus(rawValue: rawStatus) else { return false }
        return status == .complete
    }
}

package final class SerialWork {
    private var last: Task<Void, Never>?
    private var closed = false
    private var running: [UUID: () -> Void] = [:]

    package init() {}

    @MainActor
    package func run<T>(_ body: @escaping @MainActor () async throws -> T) async throws -> T {
        guard !closed else { throw ControlServer.notRecording }
        let previous = last
        let key = UUID()
        let work = Task { @MainActor () async throws -> T in
            await previous?.value
            guard !self.closed else { throw ControlServer.notRecording }
            do {
                return try await body()
            } catch {
                if self.closed, Task.isCancelled { throw ControlServer.notRecording }
                throw error
            }
        }
        running[key] = { work.cancel() }
        last = Task { @MainActor in
            _ = try? await work.value
            self.running[key] = nil
        }
        return try await work.value
    }

    @MainActor
    package func runUnlessClosed(_ body: @escaping @MainActor () async -> Void) async {
        _ = try? await run(body)
    }

    @MainActor
    package func close() async {
        closed = true
        for cancel in running.values { cancel() }
        await last?.value
    }
}

package final class MeetingRecorder: NSObject, Recorder, CaptureControlHandler, AVCaptureAudioDataOutputSampleBufferDelegate {
    package static let videoWidth = 1280

    package var onFailure: ((Error) -> Void)?
    package let manifest: CaptureManifestStore

    private let dir: URL
    private let liveTap: LiveTap?
    private let micQueue = DispatchQueue(label: "recap.meeting-mic")
    private let session = AVCaptureSession()
    private var micWriter: MediaWriter?
    private var sessionClock: CMClock?
    private let originLock = NSLock()
    private var origin: CMTime = .invalid
    private var segment: ScreenSegment?
    private var canvas: (width: Int, height: Int)?
    private var micRunning = false
    private var stopped = false
    private let work = SerialWork()
    private var exclusionWatch: Task<Void, Never>?
    private var launchWatcher: LaunchWatcher?
    private var appliedExclusions: Set<Int32> = []
    package static let exclusionInterval: UInt64 = 5_000_000_000
    package static let launchRetryDelay: UInt64 = 300_000_000
    package static let exclusionRetryDelay: UInt64 = 1_000_000_000
    package static let exclusionLogInterval: TimeInterval = 60
    package static let maxAbandonedContent = 2
    package static let contentStuck = RecapError("BUSY", "Recap.app is still waiting for ScreenCaptureKit to list the screens and windows; try again in a moment")

    private let listContent: () async throws -> ScreenContent
    private let makeStream: ScreenStreamFactory
    private let timeouts: CaptureTimeouts
    private let retryDelay: UInt64
    private let log: (String) -> Void
    private let abandonedContent = AbandonedWork(limit: MeetingRecorder.maxAbandonedContent)
    private var exclusionRetry: Task<Void, Never>?
    private var exclusionsFailingSince: Date?
    private var exclusionsLoggedAt: Date?

    private enum ExclusionOutcome {
        case kept
        case refreshed
        case abandoned(String)
    }

    package init(dir: URL, liveTap: LiveTap? = nil, timeouts: CaptureTimeouts = .standard,
                 exclusionRetryDelay: UInt64 = MeetingRecorder.exclusionRetryDelay,
                 content: @escaping () async throws -> ScreenContent = ScreenContent.current,
                 makeStream: @escaping ScreenStreamFactory = ScreenStreams.live,
                 log: @escaping (String) -> Void = MeetingRecorder.standardLog) {
        self.dir = dir
        self.liveTap = liveTap
        self.timeouts = timeouts
        retryDelay = exclusionRetryDelay
        listContent = content
        self.makeStream = makeStream
        self.log = log
        manifest = CaptureManifestStore(dir: dir)
    }

    package static func standardLog(_ message: String) {
        FileHandle.standardError.write(Data("\(ISO8601DateFormatter().string(from: Date())) \(message)\n".utf8))
    }

    package var abandonedListings: Int { abandonedContent.count }

    package static func listingExpired(after seconds: TimeInterval) -> RecapError {
        let expired = CaptureTimeouts.expired("list the screens and windows", after: seconds)
        return RecapError(expired.code, expired.message + ". If macOS is still asking for the Screen & System Audio Recording permission of Recap, answer it and try again")
    }

    private func content() async throws -> ScreenContent {
        guard !abandonedContent.isSaturated else { throw Self.contentStuck }
        let seconds = timeouts.content
        return try await Deadline.run(within: CaptureTimeouts.nanoseconds(seconds),
                                      onTimeout: Self.listingExpired(after: seconds),
                                      abandoned: abandonedContent, startsWhenCancelled: false, listContent)
    }

    @MainActor
    package func start() async throws {
        try await Permissions.requestMicrophone()
        guard let device = AVCaptureDevice.default(for: .audio) else {
            throw RecapError("NO_MICROPHONE", "No microphone available")
        }
        let input = try AVCaptureDeviceInput(device: device)
        let output = AVCaptureAudioDataOutput()
        output.setSampleBufferDelegate(self, queue: micQueue)

        session.beginConfiguration()
        guard session.canAddInput(input), session.canAddOutput(output) else {
            session.commitConfiguration()
            throw RecapError("CAPTURE_SETUP", "Cannot attach \(device.localizedName) to the capture session")
        }
        session.addInput(input)
        session.addOutput(output)
        session.commitConfiguration()

        let writer = try MediaWriter(url: dir.appending(path: CaptureManifest.micFileName), fileType: .m4a,
                                     tracks: [.audio(channels: 1, bitRate: 64_000)])
        writer.onFailure = { [weak self] error in self?.onFailure?(error) }
        micWriter = writer
        manifest.update { _ in }
        sessionClock = session.synchronizationClock
        session.startRunning()
        guard session.isRunning else { throw RecapError("CAPTURE_SETUP", "The microphone capture session did not start") }
        sessionClock = session.synchronizationClock
        micRunning = true
        watchExclusions()
    }

    @MainActor
    package func stop() async {
        stopped = true
        exclusionWatch?.cancel()
        exclusionWatch = nil
        exclusionRetry?.cancel()
        exclusionRetry = nil
        launchWatcher?.stop()
        launchWatcher = nil
        await work.close()
        await endSegment()
        session.stopRunning()
        await withCheckedContinuation { continuation in micQueue.async { continuation.resume() } }
        micRunning = false
        liveTap?.finish()
        await micWriter?.finish()
        manifest.update {
            $0.video = nil
            $0.endedAt = Date()
        }
    }

    package func captureOutput(_ output: AVCaptureOutput, didOutput sampleBuffer: CMSampleBuffer, from connection: AVCaptureConnection) {
        let pts = hostTime(sampleBuffer.presentationTimeStamp)
        originLock.withLock {
            if !origin.isValid, pts.isValid { origin = pts }
        }
        micWriter?.append(sampleBuffer, track: 0)
        liveTap?.append(sampleBuffer, channel: .mic, at: pts)
    }

    private func hostTime(_ time: CMTime) -> CMTime {
        guard time.isValid, let sessionClock else { return time }
        return CMSyncConvertTime(time, from: sessionClock, to: CMClockGetHostTimeClock())
    }

    private func milliseconds(_ time: CMTime) -> Int {
        CaptureClock.milliseconds(time, since: originLock.withLock { origin })
    }

    private var nowMs: Int { milliseconds(CaptureClock.hostNow) }

    @MainActor
    private var status: CaptureStatus {
        CaptureStatus(mic: micRunning && !stopped, video: manifest.current.video)
    }

    @MainActor
    private func exclusive<T>(_ body: @escaping @MainActor () async throws -> T) async throws -> T {
        guard !stopped else { throw ControlServer.notRecording }
        return try await work.run(body)
    }

    @MainActor
    package func setTarget(_ target: CaptureTargetRef) async throws -> CaptureStatus {
        try await exclusive { try await self.applyTarget(target) }
    }

    @MainActor
    private func applyTarget(_ target: CaptureTargetRef) async throws -> CaptureStatus {
        let content = try await self.content()
        let (filter, video) = try content.resolve(target)
        if let segment {
            do {
                try await segment.update(filter: filter)
                if target.kind == .display { appliedExclusions = content.excludedPids() }
                if manifest.current.video?.ref != target { manifest.update { $0.switchTarget(video, atMs: nowMs) } }
                return status
            } catch {
                await endSegment()
                if Task.isCancelled || Self.isTimeout(error) { throw error }
            }
        }
        try await beginSegment(filter: filter, video: video, content: content)
        if target.kind == .display { appliedExclusions = content.excludedPids() }
        return status
    }

    @MainActor
    package func clearTarget() async throws -> CaptureStatus {
        try await exclusive {
            await self.endSegment()
            return self.status
        }
    }

    @MainActor
    package func sources(thumbnails: Bool) async throws -> CaptureSources {
        try await SourceCatalog.list(thumbnails: thumbnails)
    }

    @MainActor
    private func watchExclusions() {
        let watcher = LaunchWatcher(retryDelay: MeetingRecorder.launchRetryDelay) { [weak self] in
            await self?.refreshExclusionsIfNeeded()
        }
        watcher.start()
        launchWatcher = watcher
        exclusionWatch = Task { @MainActor [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(nanoseconds: MeetingRecorder.exclusionInterval)
                guard let self, !Task.isCancelled, !self.stopped else { return }
                await self.refreshExclusionsIfNeeded()
            }
        }
    }

    @MainActor
    package func refreshExclusionsIfNeeded() async {
        guard !stopped, segment != nil, manifest.current.video?.kind == .display else {
            forgetExclusionFailures()
            return
        }
        do {
            let outcome = try await exclusive { try await self.refreshDisplayExclusions() }
            if case let .abandoned(reason) = outcome {
                forgetExclusionFailures()
                log(reason)
                return
            }
            if let since = exclusionsFailingSince {
                log("display exclusions refreshed again after \(Int(Date().timeIntervalSince(since)))s")
            }
            forgetExclusionFailures()
        } catch {
            guard !stopped, segment != nil else {
                forgetExclusionFailures()
                return
            }
            let now = Date()
            let since = exclusionsFailingSince ?? now
            exclusionsFailingSince = since
            if exclusionsLoggedAt.map({ now.timeIntervalSince($0) >= Self.exclusionLogInterval }) ?? true {
                exclusionsLoggedAt = now
                log("display exclusions not refreshed for \(Int(now.timeIntervalSince(since)))s, the capture keeps its last filter: \(Self.describe(error))")
            }
            scheduleExclusionRetry()
        }
    }

    @MainActor
    private func forgetExclusionFailures() {
        exclusionsFailingSince = nil
        exclusionsLoggedAt = nil
    }

    @MainActor
    private func scheduleExclusionRetry() {
        guard exclusionRetry == nil, !stopped else { return }
        let delay = retryDelay
        exclusionRetry = Task { @MainActor [weak self] in
            try? await Task.sleep(nanoseconds: delay)
            guard let self, !Task.isCancelled else { return }
            self.exclusionRetry = nil
            await self.refreshExclusionsIfNeeded()
        }
    }

    @MainActor
    private func refreshDisplayExclusions() async throws -> ExclusionOutcome {
        guard let segment, let video = manifest.current.video, video.kind == .display else { return .kept }
        let content = try await self.content()
        let excluded = content.excludedPids()
        guard excluded != appliedExclusions, let filter = content.displayFilter(video.id) else { return .kept }
        do {
            try await segment.update(filter: filter)
        } catch {
            guard Self.isTimeout(error) else { throw error }
            let reason = "CAPTURE_STOPPED: the screen is no longer recorded because ScreenCaptureKit did not update the display exclusions in time; the microphone keeps recording (\(Self.describe(error)))"
            await segmentStopped(segment, error: error, reason: reason)
            return .abandoned(reason)
        }
        appliedExclusions = excluded
        return .refreshed
    }

    private static func isTimeout(_ error: Error) -> Bool {
        (error as? RecapError)?.code == "CAPTURE_TIMEOUT"
    }

    private static func describe(_ error: Error) -> String {
        (error as? RecapError).map { "\($0.code): \($0.message)" } ?? error.localizedDescription
    }

    private func configuration(width: Int, height: Int) -> SCStreamConfiguration {
        let configuration = SCStreamConfiguration()
        configuration.width = width
        configuration.height = height
        configuration.minimumFrameInterval = CMTime(value: 1, timescale: 2)
        configuration.queueDepth = 6
        configuration.showsCursor = true
        configuration.preservesAspectRatio = true
        configuration.capturesAudio = true
        configuration.sampleRate = 48_000
        configuration.channelCount = 2
        configuration.excludesCurrentProcessAudio = true
        return configuration
    }

    @MainActor
    private func beginSegment(filter: SCContentFilter, video: CaptureVideo, content: ScreenContent) async throws {
        let size = canvas ?? CaptureClock.canvas(width: content.mainSize?.width ?? 16, height: content.mainSize?.height ?? 9)
        canvas = size
        let file = manifest.current.nextSegmentFile
        let created = try ScreenSegment(dir: dir, file: file, kind: video.kind, width: size.width, height: size.height, liveTap: liveTap,
                                        makeStream: makeStream, timeouts: timeouts)
        manifest.update { $0.beginSegment(video, atMs: nowMs) }
        created.onFirstSample = { [weak self] pts in
            guard let self else { return }
            let atMs = self.milliseconds(pts)
            self.manifest.update { $0.markSegmentStart(file, atMs: atMs) }
        }
        created.onStop = Self.stopHandler(work) { [weak self, weak created] error in
            await self?.segmentStopped(created, error: error)
        }
        do {
            try await created.start(filter: filter, configuration: configuration(width: size.width, height: size.height))
        } catch {
            _ = await created.stop()
            manifest.update { $0.dropSegment(file) }
            try? FileManager.default.removeItem(at: dir.appending(path: file))
            throw Self.streamError(error)
        }
        segment = created
        if stopped { await endSegment() }
    }

    package static func stopHandler(_ work: SerialWork, _ handle: @escaping @MainActor (Error) async -> Void) -> (Error) -> Void {
        { error in
            Task { @MainActor in await work.runUnlessClosed { await handle(error) } }
        }
    }

    @MainActor
    private func endSegment() async {
        guard let current = segment else { return }
        segment = nil
        forgetExclusionFailures()
        let end = await current.stop()
        liveTap?.flush(.system)
        let atMs = end.map(milliseconds) ?? nowMs
        manifest.update {
            if current.hasSamples {
                $0.endSegment(atMs: atMs)
            } else {
                $0.dropSegment(current.file)
            }
        }
    }

    @MainActor
    private func segmentStopped(_ stopped: ScreenSegment?, error: Error, reason: String? = nil) async {
        guard let stopped, stopped === segment else { return }
        segment = nil
        forgetExclusionFailures()
        let end = await stopped.stop()
        liveTap?.flush(.system)
        let atMs = end.map(milliseconds) ?? nowMs
        let code = stopped.kind == .window ? "WINDOW_GONE" : "CAPTURE_STOPPED"
        let message = reason ?? "\(code): \(Self.describe(error))"
        manifest.update {
            if stopped.hasSamples {
                $0.endSegment(atMs: atMs, error: message)
            } else {
                $0.dropSegment(stopped.file)
                $0.error = message
            }
        }
    }

    private static func streamError(_ error: Error) -> Error {
        if error is RecapError || error is CancellationError { return error }
        let nsError = error as NSError
        if nsError.domain == SCStreamErrorDomain, nsError.code == SCStreamError.Code.userDeclined.rawValue {
            return SourceCatalog.permissionDenied
        }
        return RecapError("CAPTURE_FAILED", "Cannot start the screen capture: \(error.localizedDescription)")
    }
}
