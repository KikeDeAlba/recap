import AVFoundation

package final class InPersonRecorder: NSObject, Recorder, AVCaptureAudioDataOutputSampleBufferDelegate {
    package var onFailure: ((Error) -> Void)?

    private let url: URL
    private let queue = DispatchQueue(label: "recap.in-person-recorder")
    private let session = AVCaptureSession()
    private var writer: MediaWriter?
    private let liveTap: LiveTap?

    package init(url: URL, liveTap: LiveTap? = nil) {
        self.url = url
        self.liveTap = liveTap
    }

    package func start() async throws {
        try await Permissions.requestMicrophone()
        guard let device = AVCaptureDevice.default(for: .audio) else {
            throw RecapError("NO_MICROPHONE", "No microphone available")
        }
        let input = try AVCaptureDeviceInput(device: device)
        let output = AVCaptureAudioDataOutput()
        output.setSampleBufferDelegate(self, queue: queue)

        session.beginConfiguration()
        guard session.canAddInput(input), session.canAddOutput(output) else {
            session.commitConfiguration()
            throw RecapError("CAPTURE_SETUP", "Cannot attach \(device.localizedName) to the capture session")
        }
        session.addInput(input)
        session.addOutput(output)
        session.commitConfiguration()

        let writer = try MediaWriter(url: url, fileType: .m4a, tracks: [.audio(channels: 1, bitRate: 64_000)])
        writer.onFailure = { [weak self] error in self?.onFailure?(error) }
        self.writer = writer
        session.startRunning()
        guard session.isRunning else { throw RecapError("CAPTURE_SETUP", "The microphone capture session did not start") }
    }

    package func stop() async {
        session.stopRunning()
        await withCheckedContinuation { continuation in queue.async { continuation.resume() } }
        liveTap?.finish()
        await writer?.finish()
    }

    package func captureOutput(_ output: AVCaptureOutput, didOutput sampleBuffer: CMSampleBuffer, from connection: AVCaptureConnection) {
        writer?.append(sampleBuffer, track: 0)
        liveTap?.append(sampleBuffer, channel: .mic)
    }
}
