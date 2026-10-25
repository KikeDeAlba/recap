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
    private let lock = NSLock()
    private var stopping = false
    private var stream: SCStream?

    init(dir: URL, file: String, kind: CaptureTargetKind, width: Int, height: Int, liveTap: LiveTap?) throws {
        self.file = file
        self.kind = kind
        self.liveTap = liveTap
        writer = try MediaWriter(url: dir.appending(path: file), fileType: .mov, tracks: [
            .video(width: width, height: height),
            .audio(channels: 2, bitRate: 96_000),
        ])
        super.init()
        writer.onStart = { [weak self] pts in self?.onFirstSample?(pts) }
        writer.onFailure = { [weak self] error in self?.report(error) }
    }

    var hasSamples: Bool { writer.hasSamples }

    func start(filter: SCContentFilter, configuration: SCStreamConfiguration) async throws {
        let stream = SCStream(filter: filter, configuration: configuration, delegate: self)
        try stream.addStreamOutput(self, type: .screen, sampleHandlerQueue: queue)
        try stream.addStreamOutput(self, type: .audio, sampleHandlerQueue: queue)
        try await stream.startCapture()
        lock.withLock { self.stream = stream }
    }

    func update(filter: SCContentFilter) async throws {
        guard let stream = lock.withLock({ self.stream }) else {
            throw RecapError("CAPTURE_FAILED", "The screen capture is not running")
        }
        try await stream.updateContentFilter(filter)
    }

    func stop() async -> CMTime? {
        let stream = lock.withLock { () -> SCStream? in
            stopping = true
            defer { self.stream = nil }
            return self.stream
        }
        if let stream { try? await stream.stopCapture() }
        await withCheckedContinuation { continuation in queue.async { continuation.resume() } }
        await writer.finish()
        return writer.endTime
    }

    func stream(_ stream: SCStream, didOutputSampleBuffer sampleBuffer: CMSampleBuffer, of type: SCStreamOutputType) {
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
        guard !lock.withLock({ stopping }) else { return }
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

    package init(dir: URL, liveTap: LiveTap? = nil) {
        self.dir = dir
        self.liveTap = liveTap
        manifest = CaptureManifestStore(dir: dir)
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
    }

    @MainActor
    package func stop() async {
        stopped = true
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
    package func setTarget(_ target: CaptureTargetRef) async throws -> CaptureStatus {
        guard !stopped else { throw ControlServer.notRecording }
        let content = try await SourceCatalog.shareableContent()
        let (filter, video) = try resolve(target, content: content)
        if segment != nil, manifest.current.video?.ref == target { return status }
        if let segment {
            do {
                try await segment.update(filter: filter)
                manifest.update { $0.switchTarget(video, atMs: nowMs) }
                return status
            } catch {
                await endSegment()
            }
        }
        try await beginSegment(filter: filter, video: video, content: content)
        return status
    }

    @MainActor
    package func clearTarget() async throws -> CaptureStatus {
        guard !stopped else { throw ControlServer.notRecording }
        await endSegment()
        return status
    }

    @MainActor
    package func sources(thumbnails: Bool) async throws -> CaptureSources {
        try await SourceCatalog.list(thumbnails: thumbnails)
    }

    @MainActor
    private func resolve(_ target: CaptureTargetRef, content: SCShareableContent) throws -> (SCContentFilter, CaptureVideo) {
        switch target.kind {
        case .display:
            guard let display = content.displays.first(where: { $0.displayID == target.id }) else {
                throw RecapError("DISPLAY_GONE", "Display \(target.id) is not connected")
            }
            let video = CaptureVideo(kind: .display, id: target.id, title: SourceCatalog.displayName(target.id), app: nil, since: Date())
            return (SourceCatalog.displayFilter(display, content: content), video)
        case .window:
            guard let window = content.windows.first(where: { $0.windowID == target.id }) else {
                throw RecapError("WINDOW_GONE", "Window \(target.id) is closed or no longer on screen")
            }
            let app = window.owningApplication?.applicationName
            let title = window.title.flatMap { $0.trimmed.isEmpty ? nil : $0 } ?? app ?? "Window \(target.id)"
            let video = CaptureVideo(kind: .window, id: target.id, title: title, app: app, since: Date())
            return (SCContentFilter(desktopIndependentWindow: window), video)
        }
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
    private func beginSegment(filter: SCContentFilter, video: CaptureVideo, content: SCShareableContent) async throws {
        let size = canvas ?? {
            let main = content.displays.first { $0.displayID == CGMainDisplayID() } ?? content.displays.first
            return CaptureClock.canvas(width: main?.width ?? 16, height: main?.height ?? 9)
        }()
        canvas = size
        let file = manifest.current.nextSegmentFile
        let created = try ScreenSegment(dir: dir, file: file, kind: video.kind, width: size.width, height: size.height, liveTap: liveTap)
        manifest.update { $0.beginSegment(video, atMs: nowMs) }
        created.onFirstSample = { [weak self] pts in
            guard let self else { return }
            let atMs = self.milliseconds(pts)
            self.manifest.update { $0.markSegmentStart(file, atMs: atMs) }
        }
        created.onStop = { [weak self, weak created] error in
            Task { @MainActor in await self?.segmentStopped(created, error: error) }
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

    @MainActor
    private func endSegment() async {
        guard let current = segment else { return }
        segment = nil
        let end = await current.stop()
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
    private func segmentStopped(_ stopped: ScreenSegment?, error: Error) async {
        guard let stopped, stopped === segment else { return }
        segment = nil
        let end = await stopped.stop()
        let atMs = end.map(milliseconds) ?? nowMs
        let code = stopped.kind == .window ? "WINDOW_GONE" : "CAPTURE_STOPPED"
        manifest.update {
            if stopped.hasSamples {
                $0.endSegment(atMs: atMs, error: "\(code): \(error.localizedDescription)")
            } else {
                $0.dropSegment(stopped.file)
                $0.error = "\(code): \(error.localizedDescription)"
            }
        }
    }

    private static func streamError(_ error: Error) -> Error {
        if error is RecapError { return error }
        let nsError = error as NSError
        if nsError.domain == SCStreamErrorDomain, nsError.code == SCStreamError.Code.userDeclined.rawValue {
            return SourceCatalog.permissionDenied
        }
        return RecapError("CAPTURE_FAILED", "Cannot start the screen capture: \(error.localizedDescription)")
    }
}
