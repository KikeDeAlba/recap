import AVFoundation
import CoreMedia

final class LiveTap {
    private final class ChannelState {
        let chunker: LiveChunker
        var converter: AVAudioConverter?
        var inputFormat: AVAudioFormat?

        init(chunker: LiveChunker) {
            self.chunker = chunker
        }
    }

    private let meetingDir: URL
    private let chunksDir: URL
    private let indexURL: URL
    private let queue = DispatchQueue(label: "recap.live-tap", qos: .utility)
    private let originLock = NSLock()
    private var origin: CMTime?
    private var channels: [Channel: ChannelState] = [:]
    private let maxChunkSeconds: Int
    private var reportedError = false
    private let outputFormat = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: Double(LiveChunker.sampleRate),
                                             channels: 1, interleaved: false)!

    init(meetingDir: URL, maxChunkSeconds: Int) throws {
        self.meetingDir = meetingDir
        self.maxChunkSeconds = maxChunkSeconds
        chunksDir = LiveFiles.chunks(meetingDir)
        indexURL = LiveFiles.chunkIndex(meetingDir)
        try FileManager.default.createDirectory(at: chunksDir, withIntermediateDirectories: true)
    }

    func mark(_ pts: CMTime) {
        guard pts.isValid else { return }
        originLock.lock()
        if origin == nil { origin = pts }
        originLock.unlock()
    }

    func append(_ sampleBuffer: CMSampleBuffer, channel: Channel) {
        guard sampleBuffer.isValid, sampleBuffer.numSamples > 0 else { return }
        let pts = sampleBuffer.presentationTimeStamp
        guard pts.isValid else { return }
        mark(pts)
        originLock.lock()
        let start = origin ?? pts
        originLock.unlock()
        let offsetMs = max(0, Int(((pts - start).seconds * 1000).rounded()))
        queue.async { [weak self] in
            self?.process(sampleBuffer, channel: channel, atMs: offsetMs)
        }
    }

    func finish() {
        queue.sync {
            for (channel, state) in channels {
                store(state.chunker.flush(), channel: channel)
            }
        }
    }

    private func state(for channel: Channel) -> ChannelState {
        if let existing = channels[channel] { return existing }
        let created = ChannelState(chunker: LiveChunker(maxSeconds: Double(maxChunkSeconds)))
        channels[channel] = created
        return created
    }

    private func process(_ sampleBuffer: CMSampleBuffer, channel: Channel, atMs: Int) {
        let state = state(for: channel)
        guard let samples = convert(sampleBuffer, state: state), !samples.isEmpty else { return }
        store(state.chunker.append(samples, atMs: atMs), channel: channel)
    }

    private func convert(_ sampleBuffer: CMSampleBuffer, state: ChannelState) -> [Float]? {
        guard let description = sampleBuffer.formatDescription,
              var streamDescription = description.audioStreamBasicDescription,
              let format = AVAudioFormat(streamDescription: &streamDescription) else { return nil }
        let frames = AVAudioFrameCount(sampleBuffer.numSamples)
        guard let input = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: frames) else { return nil }
        input.frameLength = frames
        let status = CMSampleBufferCopyPCMDataIntoAudioBufferList(sampleBuffer, at: 0, frameCount: Int32(frames),
                                                                  into: input.mutableAudioBufferList)
        guard status == noErr else { return nil }
        if state.converter == nil || state.inputFormat != format {
            state.converter = AVAudioConverter(from: format, to: outputFormat)
            state.converter?.downmix = true
            state.inputFormat = format
        }
        guard let converter = state.converter else { return nil }
        let capacity = AVAudioFrameCount(Double(frames) * outputFormat.sampleRate / format.sampleRate) + 64
        guard let output = AVAudioPCMBuffer(pcmFormat: outputFormat, frameCapacity: capacity) else { return nil }
        var supplied = false
        var error: NSError?
        let result = converter.convert(to: output, error: &error) { _, inputStatus in
            if supplied {
                inputStatus.pointee = .noDataNow
                return nil
            }
            supplied = true
            inputStatus.pointee = .haveData
            return input
        }
        guard result != .error, let channelData = output.floatChannelData else { return nil }
        return Array(UnsafeBufferPointer(start: channelData[0], count: Int(output.frameLength)))
    }

    private func store(_ chunks: [LiveChunk], channel: Channel) {
        for chunk in chunks {
            do {
                var entry = ChunkIndexEntry(file: nil, channel: channel, seq: chunk.seq, startMs: chunk.startMs, endMs: chunk.endMs)
                if chunk.hasSpeech {
                    let name = String(format: "%@-%05d.wav", channel.rawValue, chunk.seq)
                    try WavFile.writeAtomically(chunk.samples, sampleRate: LiveChunker.sampleRate,
                                                to: chunksDir.appending(path: name))
                    entry.file = name
                }
                try JSONLines.append([entry], to: indexURL)
            } catch {
                guard !reportedError else { continue }
                reportedError = true
                FileHandle.standardError.write(Data("\(ISO8601DateFormatter().string(from: Date())) live tap: \(error)\n".utf8))
            }
        }
    }
}
