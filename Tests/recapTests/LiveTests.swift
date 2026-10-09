import Foundation
import Testing
@testable import recap

private func tone(seconds: Double, amplitude: Float, frequency: Float = 220) -> [Float] {
    let count = Int(seconds * Double(LiveChunker.sampleRate))
    return (0..<count).map { amplitude * sinf(2 * .pi * frequency * Float($0) / Float(LiveChunker.sampleRate)) }
}

private func silence(seconds: Double, noise: Float = 0) -> [Float] {
    let count = Int(seconds * Double(LiveChunker.sampleRate))
    return (0..<count).map { index in noise * (index % 2 == 0 ? 1 : -1) }
}

private func feed(_ chunker: LiveChunker, _ samples: [Float], startMs: Int = 0, block: Int = 160) -> [LiveChunk] {
    var chunks: [LiveChunk] = []
    var offset = 0
    while offset < samples.count {
        let end = min(samples.count, offset + block)
        chunks += chunker.append(Array(samples[offset..<end]), atMs: startMs + LiveChunker.ms(offset))
        offset = end
    }
    return chunks
}

@Suite struct LiveChunkerTests {
    @Test func cutsAtSilenceOnceTheChunkIsLongEnough() {
        let chunker = LiveChunker(minSeconds: 5, maxSeconds: 20)
        let audio = tone(seconds: 6, amplitude: 0.3) + silence(seconds: 1, noise: 0.001)
            + tone(seconds: 4, amplitude: 0.3) + silence(seconds: 1, noise: 0.001)
        let chunks = feed(chunker, audio) + chunker.flush()
        let speech = chunks.filter(\.hasSpeech)
        #expect(speech.count == 2)
        #expect(chunks.first?.startMs == 0)
        #expect((6_500...7_000).contains(chunks[0].endMs))
        #expect((11_500...12_000).contains(chunks[1].endMs))
        for (previous, next) in zip(chunks, chunks.dropFirst()) {
            #expect(previous.endMs == next.startMs)
        }
        #expect(chunks.last?.endMs == 12_000)
        #expect(chunks.allSatisfy { $0.samples.count == ($0.endMs - $0.startMs) * 16 })
    }

    @Test func doesNotCutShortPausesBeforeTheMinimum() {
        let chunker = LiveChunker(minSeconds: 5, maxSeconds: 20)
        let audio = tone(seconds: 2, amplitude: 0.3) + silence(seconds: 1) + tone(seconds: 2, amplitude: 0.3)
        #expect(feed(chunker, audio).isEmpty)
        let flushed = chunker.flush()
        #expect(flushed.count == 1)
        #expect(flushed[0].endMs == 5_000)
        #expect(flushed[0].hasSpeech)
    }

    @Test func cutsLongSpeechAtTheQuietestPointBeforeTheMaximum() {
        let chunker = LiveChunker(minSeconds: 5, maxSeconds: 20)
        let audio = tone(seconds: 15, amplitude: 0.3) + tone(seconds: 0.3, amplitude: 0.02)
            + tone(seconds: 15, amplitude: 0.3)
        let chunks = feed(chunker, audio)
        #expect(!chunks.isEmpty)
        #expect((15_000...15_330).contains(chunks[0].endMs))
        #expect(chunks.allSatisfy { $0.endMs - $0.startMs <= 20_000 })
    }

    @Test func neverExceedsTheMaximumWithUniformAudio() {
        let chunker = LiveChunker(minSeconds: 5, maxSeconds: 8)
        let chunks = feed(chunker, tone(seconds: 30, amplitude: 0.3))
        #expect(chunks.count >= 3)
        #expect(chunks.allSatisfy { $0.endMs - $0.startMs <= 8_000 && $0.hasSpeech })
    }

    @Test func marksSilentChunksSoTheyAreNotTranscribed() {
        let chunker = LiveChunker(minSeconds: 5, maxSeconds: 20)
        let chunks = feed(chunker, silence(seconds: 12)) + chunker.flush()
        #expect(!chunks.isEmpty)
        #expect(chunks.allSatisfy { !$0.hasSpeech })
        #expect(chunks.last?.endMs == 12_000)
    }

    @Test func startsANewChunkAfterAGapInTheStream() {
        let chunker = LiveChunker(minSeconds: 5, maxSeconds: 20)
        var chunks = feed(chunker, tone(seconds: 2, amplitude: 0.3))
        chunks += feed(chunker, tone(seconds: 1, amplitude: 0.3), startMs: 10_000)
        chunks += chunker.flush()
        #expect(chunks.count == 2)
        #expect(chunks[0].startMs == 0 && chunks[0].endMs == 2_000)
        #expect(chunks[1].startMs == 10_000 && chunks[1].endMs == 11_000)
        #expect(chunks.map(\.seq) == [1, 2])
    }
}

@Suite struct LiveFilesTests {
    private func temporaryDir() throws -> URL {
        let dir = FileManager.default.temporaryDirectory.appending(path: "recap-live-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        return dir
    }

    @Test func encodesSixteenBitMonoWav() {
        let data = WavFile.encode([0, 1, -1, 0.5], sampleRate: 16_000)
        #expect(data.count == 44 + 8)
        #expect(String(decoding: data.prefix(4), as: UTF8.self) == "RIFF")
        #expect(String(decoding: data[8..<12], as: UTF8.self) == "WAVE")
        let rate = data[24..<28].withUnsafeBytes { $0.loadUnaligned(as: UInt32.self) }
        #expect(UInt32(littleEndian: rate) == 16_000)
        let second = data[46..<48].withUnsafeBytes { $0.loadUnaligned(as: Int16.self) }
        #expect(Int16(littleEndian: second) == Int16.max)
    }

    @Test func appendsAndReadsJsonLinesSkippingBrokenOnes() throws {
        let dir = try temporaryDir()
        defer { try? FileManager.default.removeItem(at: dir) }
        let url = LiveFiles.transcript(dir)
        try JSONLines.append([Segment(startMs: 0, endMs: 1_000, channel: .mic, text: "hola")], to: url)
        let handle = try FileHandle(forWritingTo: url)
        handle.seekToEndOfFile()
        handle.write(Data("{not json\n".utf8))
        try handle.close()
        try JSONLines.append([Segment(startMs: 2_000, endMs: 3_000, channel: .system, text: "qué tal")], to: url)
        let lines = try String(contentsOf: url, encoding: .utf8).split(separator: "\n")
        #expect(lines.first == #"{"channel":"mic","endMs":1000,"startMs":0,"text":"hola"}"#)
        let read = JSONLines.read(Segment.self, from: url)
        #expect(read.map(\.text) == ["hola", "qué tal"])
    }

    @Test func pruneRemovesTheLiveChunksButKeepsTheTranscript() throws {
        let dir = try temporaryDir()
        defer { try? FileManager.default.removeItem(at: dir) }
        try FileManager.default.createDirectory(at: LiveFiles.chunks(dir), withIntermediateDirectories: true)
        try Data([1, 2, 3]).write(to: LiveFiles.chunks(dir).appending(path: "mic-00001.wav"))
        try JSONLines.append([Segment(startMs: 0, endMs: 1, channel: .mic, text: "x")], to: LiveFiles.transcript(dir))
        #expect(MeetingStorage.measure(dir, mode: .remote).intermediateBytes == 3)
        MediaOperations.removeIntermediates(dir)
        #expect(!FileManager.default.fileExists(atPath: LiveFiles.chunks(dir).path))
        #expect(FileManager.default.fileExists(atPath: LiveFiles.transcript(dir).path))
    }
}

@Suite struct LiveMergerTests {
    private func segment(_ start: Int, _ end: Int, _ channel: Channel, _ text: String) -> Segment {
        Segment(startMs: start, endMs: end, channel: channel, text: text)
    }

    @Test func holdsTheMicrophoneUntilTheCallAudioCoversItAndDropsEcho() {
        var merger = LiveMerger(hasSystem: true, holdSeconds: 30)
        let now = Date()
        let echo = segment(10_300, 14_200, .mic, "acordamos entregar el reporte el viernes")
        let own = segment(15_000, 17_000, .mic, "Perfecto, yo me encargo del reporte")
        #expect(merger.add([echo, own], channel: .mic, coveredUntilMs: 17_000, now: now).isEmpty)
        let system = segment(10_000, 14_000, .system, "Acordamos entregar el reporte el viernes")
        let released = merger.add([system], channel: .system, coveredUntilMs: 20_000, now: now)
        #expect(released == [system, own])
        #expect(merger.pendingCount == 0)
    }

    @Test func releasesTheMicrophoneWhenTheCallIsSilent() {
        var merger = LiveMerger(hasSystem: true, holdSeconds: 30)
        let now = Date()
        let own = segment(1_000, 3_000, .mic, "Buenos días")
        #expect(merger.add([own], channel: .mic, coveredUntilMs: 3_000, now: now).isEmpty)
        #expect(merger.advance(.system, toMs: 4_000, now: now).isEmpty)
        #expect(merger.advance(.system, toMs: 6_000, now: now) == [own])
    }

    @Test func releasesHeldSegmentsAfterTheHoldTime() {
        var merger = LiveMerger(hasSystem: true, holdSeconds: 30)
        let now = Date()
        let own = segment(1_000, 3_000, .mic, "Buenos días")
        _ = merger.add([own], channel: .mic, coveredUntilMs: 3_000, now: now)
        #expect(merger.release(now: now.addingTimeInterval(10), force: false).isEmpty)
        #expect(merger.release(now: now.addingTimeInterval(31), force: false) == [own])
    }

    @Test func passesInPersonSegmentsStraightThroughAndDropsRepeats() {
        var merger = LiveMerger(hasSystem: false, holdSeconds: 30)
        let first = segment(0, 2_000, .mic, "Hola a todos.")
        let repeated = segment(5_000, 7_000, .mic, "hola a todos")
        #expect(merger.add([first, repeated], channel: .mic, coveredUntilMs: 7_000, now: Date()) == [first])
    }

    @Test func windowKeepsTheLastSecondsAndRendersSpeakers() {
        let segments = [
            segment(0, 5_000, .system, "Arrancamos con el estado del sprint."),
            segment(200_000, 204_000, .system, "¿Cómo se despliega el servicio?"),
            segment(205_000, 207_000, .mic, "Déjame revisar."),
        ]
        let window = LiveTranscript.window(segments, seconds: 60)
        #expect(window.map(\.startMs) == [200_000, 205_000])
        let text = LiveTranscript.render(window, labelled: true)
        #expect(text == "[00:03:20] Remotos: ¿Cómo se despliega el servicio?\n[00:03:25] Sala: Déjame revisar.")
        #expect(LiveTranscript.render([], labelled: true).contains("Todavía no hay"))
    }

    @Test func whisperArgumentsCarryThePreviousTextAndGlossary() {
        var config = Config()
        config.vocabulary = ["CoDi"]
        let arguments = LiveWorker.whisperArguments(config: config, model: URL(fileURLWithPath: "/m.bin"),
                                                    outputBase: URL(fileURLWithPath: "/c/mic-00001"),
                                                    wav: URL(fileURLWithPath: "/c/mic-00001.wav"), previous: "el webhook de BBVA")
        #expect(arguments.contains("-t") && arguments[arguments.firstIndex(of: "-t")! + 1] == "4")
        #expect(arguments[arguments.firstIndex(of: "--prompt")! + 1] == "Glosario: CoDi. el webhook de BBVA")
        #expect(arguments.last == "/c/mic-00001.wav")
    }
}

@Suite struct LiveConfigTests {
    @Test func defaultsAreOnAndOldConfigsStillDecode() throws {
        let config = try JSONDecoder().decode(Config.self, from: Data(#"{"language":"es"}"#.utf8))
        #expect(config.liveSettings == LiveSettings(nil))
        #expect(config.liveSettings.enabled && config.liveSettings.openWindow && config.liveSettings.proposals)
        #expect(config.liveSettings.maxChunkSeconds == 20)
        #expect(config.liveSettings.assistModel == nil)
        #expect(config.liveSettings.autoAsk && config.liveSettings.autoAskModel == "haiku")
        #expect(config.liveSettings.autoAskMinSeconds == 20)
        #expect(LiveSettings(LiveConfig(autoAskMinSeconds: 1)).autoAskMinSeconds == 10)
        #expect(LiveSettings(LiveConfig(autoAskMinSeconds: 900)).autoAskMinSeconds == 120)
    }

    @Test func setsAndReadsTheAutoAskKeys() throws {
        var config = Config()
        try ConfigKey.parse("live.autoAsk").apply("off", to: &config)
        try ConfigKey.parse("live.autoAskModel").apply("sonnet", to: &config)
        try ConfigKey.parse("live.autoAskMinSeconds").apply("45", to: &config)
        #expect(ConfigKey.liveAutoAsk.value(in: config) == .bool(false))
        #expect(ConfigKey.liveAutoAskModel.value(in: config) == .string("sonnet"))
        #expect(ConfigKey.liveAutoAskMinSeconds.value(in: config) == .int(45))
        try ConfigKey.liveAutoAskModel.apply("default", to: &config)
        #expect(ConfigKey.liveAutoAskModel.value(in: config) == .string("haiku"))
        #expect(throws: RecapError.self) { try ConfigKey.liveAutoAskMinSeconds.apply("5", to: &config) }
        #expect(throws: RecapError.self) { try ConfigKey.liveAutoAskMinSeconds.apply("121", to: &config) }
        let snapshot = ConfigKey.snapshot(config)
        #expect(snapshot["live.autoAsk"] == .bool(false) && snapshot["live.autoAskMinSeconds"] == .int(45))
    }

    @Test func setsAndReadsEachKey() throws {
        var config = Config()
        try ConfigKey.parse("live.enabled").apply("off", to: &config)
        try ConfigKey.parse("live.maxChunkSeconds").apply("12", to: &config)
        try ConfigKey.parse("live.assistModel").apply("haiku", to: &config)
        #expect(ConfigKey.liveEnabled.value(in: config) == .bool(false))
        #expect(ConfigKey.liveMaxChunkSeconds.value(in: config) == .int(12))
        #expect(ConfigKey.liveAssistModel.value(in: config) == .string("haiku"))
        try ConfigKey.liveAssistModel.apply("null", to: &config)
        #expect(ConfigKey.liveAssistModel.value(in: config) == .null)
        #expect(throws: RecapError.self) { try ConfigKey.liveMaxChunkSeconds.apply("2", to: &config) }
        #expect(throws: RecapError.self) { try ConfigKey.liveEnabled.apply("maybe", to: &config) }
        #expect(throws: RecapError.self) { try ConfigKey.parse("live.nope") }
        let encoded = String(decoding: try JSONEncoder().encode(ConfigKey.snapshot(config)), as: UTF8.self)
        #expect(encoded.contains(#""live.assistModel":null"#))
    }
}
