import Foundation

struct Segment: Codable {
    var kind: String
    var samples: Int
    var amp: Int
    var period: Int?
    var seed: UInt32?
}

struct Feed: Codable {
    var segments: [Segment]
    var startMs: Int
    var block: Int
}

struct Options: Codable {
    var minSeconds: Double?
    var maxSeconds: Double?
    var silenceSeconds: Double?
}

struct Expected: Codable {
    var seq: Int
    var startMs: Int
    var endMs: Int
    var count: Int
    var hasSpeech: Bool
}

struct Case: Codable {
    var name: String
    var options: Options
    var feeds: [Feed]
    var flush: Bool
    var expected: [Expected]?
}

struct Fixture: Codable {
    var cases: [Case]
}

func render(_ segment: Segment) -> [Float] {
    var state = segment.seed ?? 1
    let period = max(2, segment.period ?? 2)
    return (0..<segment.samples).map { index in
        let value: Int
        switch segment.kind {
        case "triangle":
            let phase = index % period
            value = segment.amp * (2 * abs(2 * phase - period) - period) / period
        case "square":
            value = (index / (period / 2)) % 2 == 0 ? segment.amp : -segment.amp
        case "alternate":
            value = index % 2 == 0 ? segment.amp : -segment.amp
        case "noise":
            state = state &* 1_664_525 &+ 1_013_904_223
            value = Int(state >> 16) % (2 * segment.amp + 1) - segment.amp
        default:
            value = 0
        }
        return Float(value) / 32_768
    }
}

@main
struct ChunkerFixtures {
    static func main() throws {
        let url = URL(fileURLWithPath: CommandLine.arguments[1])
        var fixture = try JSONDecoder().decode(Fixture.self, from: Data(contentsOf: url))
        for index in fixture.cases.indices {
            let item = fixture.cases[index]
            let chunker = LiveChunker(minSeconds: item.options.minSeconds ?? 3, maxSeconds: item.options.maxSeconds ?? 10,
                                      silenceSeconds: item.options.silenceSeconds ?? 0.6)
            var chunks: [LiveChunk] = []
            for feed in item.feeds {
                let samples = feed.segments.flatMap(render)
                var offset = 0
                while offset < samples.count {
                    let end = min(samples.count, offset + feed.block)
                    chunks += chunker.append(Array(samples[offset..<end]), atMs: feed.startMs + LiveChunker.ms(offset))
                    offset = end
                }
            }
            if item.flush { chunks += chunker.flush() }
            fixture.cases[index].expected = chunks.map {
                Expected(seq: $0.seq, startMs: $0.startMs, endMs: $0.endMs, count: $0.samples.count, hasSpeech: $0.hasSpeech)
            }
        }
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
        try (encoder.encode(fixture) + Data("\n".utf8)).write(to: url)
    }
}
