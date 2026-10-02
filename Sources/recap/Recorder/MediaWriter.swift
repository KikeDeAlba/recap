import AVFoundation
import CoreMedia

final class MediaWriter {
    enum Track {
        case video(width: Int, height: Int)
        case audio(channels: Int, bitRate: Int)
    }

    var onFailure: ((Error) -> Void)?

    private let writer: AVAssetWriter
    private let inputs: [AVAssetWriterInput]
    private var sessionStart: CMTime?
    private var lastEnd: CMTime = .invalid
    private var failed = false

    init(url: URL, fileType: AVFileType, tracks: [Track]) throws {
        try? FileManager.default.removeItem(at: url)
        writer = try AVAssetWriter(outputURL: url, fileType: fileType)
        writer.movieFragmentInterval = CMTime(seconds: 5, preferredTimescale: 600)
        inputs = tracks.map(MediaWriter.makeInput)
        for input in inputs {
            guard writer.canAdd(input) else {
                throw RecapError("WRITER_SETUP", "Cannot add a \(input.mediaType.rawValue) track to \(url.lastPathComponent)")
            }
            writer.add(input)
        }
        guard writer.startWriting() else {
            throw RecapError("WRITER_SETUP", writer.error?.localizedDescription ?? "Cannot start writing \(url.lastPathComponent)")
        }
    }

    var hasSamples: Bool { sessionStart != nil }

    func append(_ sampleBuffer: CMSampleBuffer, track index: Int) {
        guard !failed, sampleBuffer.isValid, sampleBuffer.numSamples > 0 else { return }
        let pts = sampleBuffer.presentationTimeStamp
        guard pts.isValid else { return }
        if sessionStart == nil {
            writer.startSession(atSourceTime: pts)
            sessionStart = pts
        }
        guard let sessionStart, pts >= sessionStart else { return }
        let input = inputs[index]
        guard input.isReadyForMoreMediaData else { return }
        if input.append(sampleBuffer) {
            let duration = sampleBuffer.duration
            let end = duration.isValid ? pts + duration : pts
            if !lastEnd.isValid || end > lastEnd { lastEnd = end }
        } else if writer.status == .failed {
            failed = true
            onFailure?(writer.error ?? RecapError("WRITER_FAILED", "The media writer stopped"))
        }
    }

    func finish() async {
        guard writer.status == .writing else { return }
        guard sessionStart != nil else {
            writer.cancelWriting()
            return
        }
        inputs.forEach { $0.markAsFinished() }
        if lastEnd.isValid { writer.endSession(atSourceTime: lastEnd) }
        await writer.finishWriting()
    }

    private static func makeInput(_ track: Track) -> AVAssetWriterInput {
        let input: AVAssetWriterInput
        switch track {
        case let .video(width, height):
            input = AVAssetWriterInput(mediaType: .video, outputSettings: [
                AVVideoCodecKey: AVVideoCodecType.h264,
                AVVideoWidthKey: width,
                AVVideoHeightKey: height,
                AVVideoCompressionPropertiesKey: [
                    AVVideoAverageBitRateKey: 600_000,
                    AVVideoExpectedSourceFrameRateKey: 2,
                    AVVideoMaxKeyFrameIntervalKey: 10,
                ],
            ])
        case let .audio(channels, bitRate):
            input = AVAssetWriterInput(mediaType: .audio, outputSettings: [
                AVFormatIDKey: kAudioFormatMPEG4AAC,
                AVSampleRateKey: 48_000,
                AVNumberOfChannelsKey: channels,
                AVEncoderBitRateKey: bitRate,
            ])
        }
        input.expectsMediaDataInRealTime = true
        return input
    }
}
