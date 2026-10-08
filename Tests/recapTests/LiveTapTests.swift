import AVFoundation
import CoreMedia
import Foundation
import Testing
@testable import recap

@Suite struct LiveTapTests {
    private func sampleBuffer(seconds: Double, amplitude: Float, at start: Double) throws -> CMSampleBuffer {
        let format = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: 48_000, channels: 2, interleaved: false)!
        let frames = AVAudioFrameCount(seconds * 48_000)
        let pcm = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: frames)!
        pcm.frameLength = frames
        for channel in 0..<2 {
            for index in 0..<Int(frames) {
                pcm.floatChannelData![channel][index] = amplitude * sinf(2 * .pi * 220 * Float(index) / 48_000)
            }
        }
        var description: CMAudioFormatDescription?
        CMAudioFormatDescriptionCreate(allocator: kCFAllocatorDefault, asbd: format.streamDescription, layoutSize: 0, layout: nil,
                                       magicCookieSize: 0, magicCookie: nil, extensions: nil, formatDescriptionOut: &description)
        var timing = CMSampleTimingInfo(duration: CMTime(value: 1, timescale: 48_000),
                                        presentationTimeStamp: CMTime(seconds: start, preferredTimescale: 48_000),
                                        decodeTimeStamp: .invalid)
        var buffer: CMSampleBuffer?
        CMSampleBufferCreate(allocator: kCFAllocatorDefault, dataBuffer: nil, dataReady: false, makeDataReadyCallback: nil,
                             refcon: nil, formatDescription: description, sampleCount: CMItemCount(frames),
                             sampleTimingEntryCount: 1, sampleTimingArray: &timing, sampleSizeEntryCount: 0,
                             sampleSizeArray: nil, sampleBufferOut: &buffer)
        let sample = try #require(buffer)
        let status = CMSampleBufferSetDataBufferFromAudioBufferList(sample, blockBufferAllocator: kCFAllocatorDefault,
                                                                    blockBufferMemoryAllocator: kCFAllocatorDefault, flags: 0,
                                                                    bufferList: pcm.audioBufferList)
        #expect(status == noErr)
        return sample
    }

    @Test func convertsStereoCaptureIntoSixteenKilohertzChunks() throws {
        let dir = FileManager.default.temporaryDirectory.appending(path: "recap-tap-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: dir) }
        let tap = try LiveTap(meetingDir: dir, maxChunkSeconds: 20)
        var time = 100.0
        for _ in 0..<60 {
            tap.append(try sampleBuffer(seconds: 0.1, amplitude: 0.3, at: time), channel: .system)
            time += 0.1
        }
        for _ in 0..<10 {
            tap.append(try sampleBuffer(seconds: 0.1, amplitude: 0, at: time), channel: .system)
            time += 0.1
        }
        tap.finish()
        let entries = JSONLines.read(ChunkIndexEntry.self, from: LiveFiles.chunkIndex(dir))
        #expect(entries.first?.startMs == 0)
        let speech = try #require(entries.first { $0.file != nil })
        #expect(speech.file == "system-00001.wav")
        #expect((6_400...7_100).contains(speech.endMs))
        let wav = try Data(contentsOf: LiveFiles.chunks(dir).appending(path: speech.file!))
        let samples = (wav.count - 44) / 2
        #expect(abs(samples - (speech.endMs - speech.startMs) * 16) <= 16)
        #expect(entries.last?.endMs ?? 0 >= 6_900)
    }
}
