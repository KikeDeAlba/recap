import AVFoundation
import CoreMedia
import ScreenCaptureKit

package final class RemoteRecorder: NSObject, Recorder, SCStreamOutput, SCStreamDelegate {
    package static let videoWidth = 1280
    package static let micTrack = 1
    package static let systemTrack = 2

    package var onFailure: ((Error) -> Void)?

    private let url: URL
    private let displayID: CGDirectDisplayID?
    private let queue = DispatchQueue(label: "recap.remote-recorder")
    private var stream: SCStream?
    private var writer: MediaWriter?
    private let liveTap: LiveTap?

    package init(url: URL, displayID: CGDirectDisplayID?, liveTap: LiveTap? = nil) {
        self.url = url
        self.displayID = displayID
        self.liveTap = liveTap
    }

    package func start() async throws {
        try Permissions.requestScreen()
        try await Permissions.requestMicrophone()
        let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: true)
        let display = displayID.flatMap { id in content.displays.first { $0.displayID == id } }
            ?? content.displays.first { $0.displayID == CGMainDisplayID() }
            ?? content.displays.first
        guard let display else { throw RecapError("NO_DISPLAY", "No display available to record") }

        let width = Self.videoWidth
        let height = Int((Double(display.height) / Double(display.width) * Double(width)).rounded()) & ~1

        let configuration = SCStreamConfiguration()
        configuration.width = width
        configuration.height = height
        configuration.minimumFrameInterval = CMTime(value: 1, timescale: 2)
        configuration.queueDepth = 6
        configuration.showsCursor = true
        configuration.capturesAudio = true
        configuration.sampleRate = 48_000
        configuration.channelCount = 2
        configuration.excludesCurrentProcessAudio = true
        configuration.captureMicrophone = true

        let writer = try MediaWriter(url: url, fileType: .mov, tracks: [
            .video(width: width, height: height),
            .audio(channels: 1, bitRate: 64_000),
            .audio(channels: 2, bitRate: 96_000),
        ])
        writer.onFailure = { [weak self] error in self?.onFailure?(error) }
        self.writer = writer

        let filter = SCContentFilter(display: display, excludingWindows: [])
        let stream = SCStream(filter: filter, configuration: configuration, delegate: self)
        try stream.addStreamOutput(self, type: .screen, sampleHandlerQueue: queue)
        try stream.addStreamOutput(self, type: .audio, sampleHandlerQueue: queue)
        try stream.addStreamOutput(self, type: .microphone, sampleHandlerQueue: queue)
        try await stream.startCapture()
        self.stream = stream
    }

    package func stop() async {
        if let stream { try? await stream.stopCapture() }
        stream = nil
        await withCheckedContinuation { continuation in queue.async { continuation.resume() } }
        liveTap?.finish()
        await writer?.finish()
    }

    package func stream(_ stream: SCStream, didOutputSampleBuffer sampleBuffer: CMSampleBuffer, of type: SCStreamOutputType) {
        guard let writer else { return }
        switch type {
        case .screen:
            if Self.isCompleteFrame(sampleBuffer) {
                liveTap?.mark(sampleBuffer.presentationTimeStamp)
                writer.append(sampleBuffer, track: 0)
            }
        case .microphone:
            writer.append(sampleBuffer, track: Self.micTrack)
            liveTap?.append(sampleBuffer, channel: .mic)
        case .audio:
            writer.append(sampleBuffer, track: Self.systemTrack)
            liveTap?.append(sampleBuffer, channel: .system)
        @unknown default:
            break
        }
    }

    package func stream(_ stream: SCStream, didStopWithError error: Error) {
        onFailure?(error)
    }

    private static func isCompleteFrame(_ sampleBuffer: CMSampleBuffer) -> Bool {
        guard let attachments = CMSampleBufferGetSampleAttachmentsArray(sampleBuffer, createIfNecessary: false)
                as? [[SCStreamFrameInfo: Any]],
              let rawStatus = attachments.first?[.status] as? Int,
              let status = SCFrameStatus(rawValue: rawStatus) else { return false }
        return status == .complete
    }
}
