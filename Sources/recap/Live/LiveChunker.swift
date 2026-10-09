import Foundation

struct LiveChunk: Equatable {
    var seq: Int
    var startMs: Int
    var endMs: Int
    var samples: [Float]
    var hasSpeech: Bool
}

final class LiveChunker {
    static let sampleRate = 16_000
    static let frameSamples = 480

    let minSamples: Int
    let maxSamples: Int
    let silenceFrames: Int
    let minSpeechFrames: Int
    let minThreshold: Float
    let maxNoiseFloor: Float
    let gapToleranceMs: Int

    private var buffer: [Float] = []
    private var energies: [Float] = []
    private var bufferStartMs: Int?
    private var trailingSilent = 0
    private var noiseFloor: Float?
    private var nextSeq = 1

    init(minSeconds: Double = 3, maxSeconds: Double = 10, silenceSeconds: Double = 0.6,
         minThreshold: Float = 0.006, maxNoiseFloor: Float = 0.015, gapToleranceMs: Int = 1_000) {
        let rate = Double(Self.sampleRate)
        let frame = Double(Self.frameSamples)
        minSamples = Int(minSeconds * rate)
        maxSamples = max(Int(maxSeconds * rate), minSamples + Self.frameSamples)
        silenceFrames = max(1, Int((silenceSeconds * rate / frame).rounded()))
        minSpeechFrames = 5
        self.minThreshold = minThreshold
        self.maxNoiseFloor = maxNoiseFloor
        self.gapToleranceMs = gapToleranceMs
    }

    var threshold: Float {
        max(minThreshold, (noiseFloor ?? 0) * 3)
    }

    func append(_ samples: [Float], atMs: Int) -> [LiveChunk] {
        var chunks: [LiveChunk] = []
        if let start = bufferStartMs {
            let expected = start + Self.ms(buffer.count)
            if atMs - expected > gapToleranceMs {
                chunks += cutAll()
                bufferStartMs = atMs
            }
        } else {
            bufferStartMs = atMs
        }
        buffer.append(contentsOf: samples)
        while energies.count * Self.frameSamples + Self.frameSamples <= buffer.count {
            let begin = energies.count * Self.frameSamples
            let rms = Self.rms(buffer[begin..<(begin + Self.frameSamples)])
            energies.append(rms)
            track(rms)
            if let chunk = cutIfReady() { chunks.append(chunk) }
        }
        return chunks
    }

    func flush() -> [LiveChunk] {
        cutAll()
    }

    private func cutAll() -> [LiveChunk] {
        guard !buffer.isEmpty else { return [] }
        let chunk = cut(at: buffer.count)
        bufferStartMs = nil
        return [chunk]
    }

    private func track(_ rms: Float) {
        let floor = noiseFloor ?? minThreshold / 3
        let next = rms < floor ? rms : floor + (rms - floor) * 0.000_5
        noiseFloor = min(maxNoiseFloor, max(0.000_5, next))
        trailingSilent = rms < threshold ? trailingSilent + 1 : 0
    }

    private func cutIfReady() -> LiveChunk? {
        let length = energies.count * Self.frameSamples
        if length >= minSamples && trailingSilent >= silenceFrames {
            return cut(at: length)
        }
        if length >= maxSamples {
            let half = energies.count / 2
            var quietest = energies.count - 1
            for index in half..<energies.count where energies[index] < energies[quietest] {
                quietest = index
            }
            return cut(at: (quietest + 1) * Self.frameSamples)
        }
        return nil
    }

    private func cut(at sampleCount: Int) -> LiveChunk {
        let count = min(sampleCount, buffer.count)
        let frames = min(energies.count, count / Self.frameSamples)
        let start = bufferStartMs ?? 0
        let level = threshold
        let speechFrames = energies[0..<frames].filter { $0 >= minThreshold }.count
        let partialSpeech = frames == 0 && Self.rms(buffer[0..<count]) >= minThreshold
        let chunk = LiveChunk(seq: nextSeq, startMs: start, endMs: start + Self.ms(count),
                              samples: Array(buffer[0..<count]),
                              hasSpeech: speechFrames >= minSpeechFrames || partialSpeech)
        nextSeq += 1
        buffer.removeFirst(count)
        energies.removeFirst(frames)
        bufferStartMs = start + Self.ms(count)
        trailingSilent = 0
        var silent = 0
        for energy in energies.reversed() {
            guard energy < level else { break }
            silent += 1
        }
        trailingSilent = silent
        return chunk
    }

    static func ms(_ samples: Int) -> Int {
        samples * 1000 / sampleRate
    }

    static func rms(_ samples: ArraySlice<Float>) -> Float {
        guard !samples.isEmpty else { return 0 }
        var sum: Float = 0
        for sample in samples { sum += sample * sample }
        return (sum / Float(samples.count)).squareRoot()
    }
}
