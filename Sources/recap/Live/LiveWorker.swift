import ArgumentParser
import Foundation

struct LiveWorkerState: Codable {
    var processed: Int
}

final class LiveWorker {
    static let threads = 4
    static let promptCharacters = 220

    private let dir: URL
    private let config: Config
    private let log: (String) -> Void
    private let pollInterval: TimeInterval
    private let detectorFactory: ((URL, Meeting) -> QuestionDetector?)?
    private var previousText: [Channel: String] = [:]

    init(dir: URL, config: Config, pollInterval: TimeInterval = 1,
         detectorFactory: ((URL, Meeting) -> QuestionDetector?)? = nil, log: @escaping (String) -> Void) {
        self.dir = dir
        self.config = config
        self.pollInterval = pollInterval
        self.detectorFactory = detectorFactory
        self.log = log
    }

    func run() throws {
        try FileManager.default.createDirectory(at: LiveFiles.dir(dir), withIntermediateDirectories: true)
        let lock = try ProcessLock(url: LiveFiles.workerLock(dir))
        defer { lock.release() }
        let meeting = try MeetingFile.load(dir)
        let whisper = try Tool.whisper.require(config)
        let model = config.whisperModelURL
        guard FileManager.default.fileExists(atPath: model.path) else {
            throw RecapError("MODEL_MISSING", "Whisper model not found at \(model.path). Run `recap setup`.")
        }
        let settings = config.liveSettings
        var merger = LiveMerger(hasSystem: meeting.mode == .remote, holdSeconds: TimeInterval(settings.maxChunkSeconds + 10))
        var state = (try? JSONDecoder().decode(LiveWorkerState.self, from: Data(contentsOf: LiveFiles.workerState(dir))))
            ?? LiveWorkerState(processed: 0)
        log("live worker started at chunk \(state.processed)")
        let detector = makeDetector(meeting)
        if detector != nil { log("question detector on (model \(settings.autoAskModel), every \(settings.autoAskMinSeconds) s at most)") }
        defer { detector?.stop() }
        var finalPass = false
        while true {
            detector?.tick()
            let entries = JSONLines.read(ChunkIndexEntry.self, from: LiveFiles.chunkIndex(dir))
            if entries.count > state.processed {
                for entry in entries[state.processed...] {
                    let segments = transcribe(entry, whisper: whisper, model: model)
                    let ready = entry.file == nil
                        ? merger.advance(entry.channel, toMs: entry.endMs, now: Date())
                        : merger.add(segments, channel: entry.channel, coveredUntilMs: entry.endMs, now: Date())
                    try JSONLines.append(ready, to: LiveFiles.transcript(dir))
                    if !ready.isEmpty { detector?.transcriptGrew() }
                    state.processed += 1
                    try JSONEncoder().encode(state).write(to: LiveFiles.workerState(dir), options: .atomic)
                }
                finalPass = false
                continue
            }
            let released = merger.release(now: Date(), force: false)
            try JSONLines.append(released, to: LiveFiles.transcript(dir))
            if !released.isEmpty { detector?.transcriptGrew() }
            if !isRecording() {
                if finalPass { break }
                finalPass = true
                continue
            }
            Thread.sleep(forTimeInterval: pollInterval)
        }
        try JSONLines.append(merger.release(now: Date(), force: true), to: LiveFiles.transcript(dir))
        log("live worker finished after \(state.processed) chunks")
    }

    private func makeDetector(_ meeting: Meeting) -> QuestionDetector? {
        guard let make = detectorFactory else { return nil }
        return make(dir, meeting)
    }

    private func isRecording() -> Bool {
        guard let stored = try? MeetingFile.load(dir) else { return false }
        let meeting = MeetingFile.reconcile(stored, dir: dir)
        return meeting.status == .recording || meeting.status == .starting
    }

    private func transcribe(_ entry: ChunkIndexEntry, whisper: URL, model: URL) -> [Segment] {
        guard let file = entry.file else { return [] }
        let wav = LiveFiles.chunks(dir).appending(path: file)
        guard FileManager.default.fileExists(atPath: wav.path) else { return [] }
        let base = wav.deletingPathExtension()
        let arguments = Self.whisperArguments(config: config, model: model, outputBase: base, wav: wav,
                                              previous: previousText[entry.channel])
        do {
            let result = try Shell.run(whisper, arguments)
            guard result.ok else {
                log("whisper failed on \(file): \(result.stderr.trimmed.suffix(300))")
                return []
            }
            let json = base.appendingPathExtension("json")
            defer { try? FileManager.default.removeItem(at: json) }
            let segments = try WhisperOutput.parse(Data(contentsOf: json), channel: entry.channel)
                .map { segment -> Segment in
                    var shifted = segment
                    shifted.startMs += entry.startMs
                    shifted.endMs = min(segment.endMs + entry.startMs, max(entry.endMs, segment.startMs + entry.startMs))
                    return shifted
                }
            if !segments.isEmpty {
                let joined = ((previousText[entry.channel] ?? "") + " " + segments.map(\.text).joined(separator: " ")).trimmed
                previousText[entry.channel] = String(joined.suffix(Self.promptCharacters))
            }
            return segments
        } catch {
            log("whisper failed on \(file): \(error)")
            return []
        }
    }

    static func whisperArguments(config: Config, model: URL, outputBase: URL, wav: URL, previous: String?) -> [String] {
        var arguments = ["-m", model.path, "-l", config.transcriptionLanguage, "-t", "\(threads)",
                         "-oj", "-of", outputBase.path, "-np", "-sns"]
        var prompt: [String] = []
        if let vocabulary = config.vocabulary, !vocabulary.isEmpty {
            prompt.append("Glosario: \(vocabulary.joined(separator: ", ")).")
        }
        if let previous, !previous.trimmed.isEmpty { prompt.append(previous.trimmed) }
        if !prompt.isEmpty { arguments += ["--prompt", prompt.joined(separator: " ")] }
        if FileManager.default.fileExists(atPath: config.vadModelURL.path) {
            arguments += ["--vad", "-vm", config.vadModelURL.path]
        }
        arguments.append(wav.path)
        return arguments
    }
}

struct LiveWorkerCommand: ParsableCommand {
    static let configuration = CommandConfiguration(
        commandName: "live-worker",
        abstract: "Transcribe the live chunks of a recording as they arrive (started by the recorder).",
        shouldDisplay: false
    )

    @Argument(help: "Meeting directory or id.")
    var meeting: String

    func run() throws {
        let config = try Config.load()
        let dir: URL
        var isDirectory: ObjCBool = false
        if FileManager.default.fileExists(atPath: meeting, isDirectory: &isDirectory), isDirectory.boolValue {
            dir = URL(fileURLWithPath: meeting)
        } else {
            dir = try MeetingStore(config: config).resolve(meeting).1
        }
        let log: (String) -> Void = { message in
            FileHandle.standardError.write(Data("\(ISO8601DateFormatter().string(from: Date())) \(message)\n".utf8))
        }
        let worker = LiveWorker(dir: dir, config: config, detectorFactory: { dir, meeting in
            LiveQuestionDetector.make(dir: dir, meeting: meeting, config: config, log: log)
        }, log: log)
        do {
            try worker.run()
        } catch {
            let message = (error as? RecapError)?.description ?? String(describing: error)
            FileHandle.standardError.write(Data("\(ISO8601DateFormatter().string(from: Date())) live worker failed: \(message)\n".utf8))
            throw ExitCode(1)
        }
    }
}
