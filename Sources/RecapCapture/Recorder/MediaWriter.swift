import AVFoundation
import CoreMedia

package final class MediaWriter {
    package enum Track {
        case video(width: Int, height: Int)
        case audio(channels: Int, bitRate: Int)
    }

    package var onFailure: ((Error) -> Void)?

    private let writer: AVAssetWriter
    private let inputs: [AVAssetWriterInput]
    private var sessionStart: CMTime?
    private var lastEnd: CMTime = .invalid
    private var failed = false
    private var trackEnds: [Int: CMTime] = [:]

    package init(url: URL, fileType: AVFileType, tracks: [Track]) throws {
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

    package var hasSamples: Bool { sessionStart != nil }

    package func append(_ sampleBuffer: CMSampleBuffer, track index: Int) {
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
        guard let buffer = contiguous(sampleBuffer, track: index, isAudio: input.mediaType == .audio) else { return }
        if input.append(buffer) {
            let start = buffer.presentationTimeStamp
            let duration = buffer.duration
            let end = duration.isValid ? start + duration : start
            trackEnds[index] = end
            if !lastEnd.isValid || end > lastEnd { lastEnd = end }
        } else if writer.status == .failed {
            failed = true
            onFailure?(writer.error ?? RecapError("WRITER_FAILED", "The media writer stopped"))
        }
    }

    private func contiguous(_ sampleBuffer: CMSampleBuffer, track index: Int, isAudio: Bool) -> CMSampleBuffer? {
        let pts = sampleBuffer.presentationTimeStamp
        guard let previousEnd = trackEnds[index], pts < previousEnd else { return sampleBuffer }
        guard isAudio else { return nil }
        let duration = sampleBuffer.duration
        guard duration.isValid, previousEnd - pts < duration else { return nil }
        var timing = CMSampleTimingInfo(duration: CMTime(value: 1, timescale: CMTimeScale(48_000)),
                                        presentationTimeStamp: previousEnd, decodeTimeStamp: .invalid)
        if let rate = sampleBuffer.formatDescription?.audioStreamBasicDescription?.mSampleRate, rate > 0 {
            timing.duration = CMTime(value: 1, timescale: CMTimeScale(rate))
        }
        var retimed: CMSampleBuffer?
        let status = CMSampleBufferCreateCopyWithNewTiming(allocator: kCFAllocatorDefault, sampleBuffer: sampleBuffer,
                                                           sampleTimingEntryCount: 1, sampleTimingArray: &timing,
                                                           sampleBufferOut: &retimed)
        return status == noErr ? retimed : nil
    }

    package func finish() async {
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
