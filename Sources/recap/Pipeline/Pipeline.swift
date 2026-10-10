import Darwin
import Foundation

enum Stage: String, CaseIterable {
    case audio
    case transcribe
    case frames
    case summarize
    case proposals
    case wrapup

    func applies(to meeting: Meeting) -> Bool {
        switch self {
        case .frames: meeting.mode == .remote
        case .wrapup, .proposals: meeting.bitaEntryId != nil
        default: true
        }
    }

    func skipped(meeting: Meeting, dir: URL) -> Bool {
        self == .frames && !MeetingMedia.hasVideo(dir: dir, mode: meeting.mode)
    }

    var isOptional: Bool { self == .proposals }

    static func isComplete(_ state: StageState?) -> Bool {
        state?.status == "done" || state?.status == "skipped"
    }

    func isSatisfied(_ state: StageState?) -> Bool {
        Stage.isComplete(state) || (isOptional && state?.status == "failed")
    }
}

struct FrameInfo: Codable {
    let file: String
    let timeSeconds: Double
}

final class Pipeline {
    static let maxFrames = 40

    private let dir: URL
    private let config: Config
    private let log: (String) -> Void

    init(dir: URL, config: Config, log: @escaping (String) -> Void) {
        self.dir = dir
        self.config = config
        self.log = log
    }

    func run(from start: Stage?, only: Stage?) throws -> Meeting {
        var meeting = try MeetingFile.load(dir)
        guard meeting.status != .recording && meeting.status != .starting else {
            throw RecapError("STILL_RECORDING", "\"\(meeting.title)\" is still being recorded")
        }
        guard FileManager.default.fileExists(atPath: recording(meeting).path) else {
            throw RecapError("NO_RECORDING", "\"\(meeting.title)\" has no recording")
        }
        let lock = try ProcessLock(url: file("process.lock"))
        defer { lock.release() }

        meeting = try MeetingFile.update(dir) { $0.status = .processing }
        var forced = false
        for stage in Stage.allCases where stage.applies(to: meeting) {
            if let only, stage != only { continue }
            if stage == start { forced = true }
            if stage == .proposals && !config.liveSettings.proposals {
                meeting = try MeetingFile.update(dir) {
                    $0.stages[stage.rawValue] = StageState(status: "skipped", updatedAt: Date())
                }
                log("\(stage.rawValue): skipped, live.proposals is off")
                continue
            }
            if stage.skipped(meeting: meeting, dir: dir) {
                if Stage.isComplete(meeting.stages[stage.rawValue]) {
                    log("\(stage.rawValue): already done")
                    continue
                }
                meeting = try MeetingFile.update(dir) {
                    $0.stages[stage.rawValue] = StageState(status: "skipped", updatedAt: Date())
                }
                log("\(stage.rawValue): skipped, the recording has no video")
                continue
            }
            let done = meeting.stages[stage.rawValue]?.status == "done"
            if done && !forced && only == nil {
                log("\(stage.rawValue): already done")
                continue
            }
            log("\(stage.rawValue): running")
            let began = Date()
            do {
                try execute(stage, meeting: meeting)
                meeting = try MeetingFile.update(dir) {
                    $0.stages[stage.rawValue] = StageState(status: "done", updatedAt: Date())
                }
                log("\(stage.rawValue): done in \(Int(Date().timeIntervalSince(began)))s")
            } catch {
                let message = (error as? RecapError)?.message ?? String(describing: error)
                if stage.isOptional {
                    meeting = try MeetingFile.update(dir) {
                        $0.stages[stage.rawValue] = StageState(status: "failed", updatedAt: Date(), error: message)
                    }
                    log("\(stage.rawValue): failed, continuing: \(message)")
                    continue
                }
                meeting = try MeetingFile.update(dir) {
                    $0.stages[stage.rawValue] = StageState(status: "failed", updatedAt: Date(), error: message)
                    $0.status = .recorded
                }
                log("\(stage.rawValue): failed: \(message)")
                throw RecapError("STAGE_FAILED", "\(stage.rawValue) failed: \(message)")
            }
        }
        let allDone = Stage.allCases.filter { $0.applies(to: meeting) }
            .allSatisfy { $0.isSatisfied(meeting.stages[$0.rawValue]) }
        return try MeetingFile.update(dir) { $0.status = allDone ? .processed : .recorded }
    }

    private func execute(_ stage: Stage, meeting: Meeting) throws {
        switch stage {
        case .audio: try extractAudio(meeting)
        case .transcribe: try transcribe(meeting)
        case .frames: try extractFrames(meeting)
        case .summarize: try summarize(meeting)
        case .proposals: try proposals(meeting)
        case .wrapup: try MeetingWrapup(config: config).run(meeting: meeting, dir: dir)
        }
    }

    private func file(_ name: String) -> URL { dir.appending(path: name) }

    private func recording(_ meeting: Meeting) -> URL {
        MeetingMedia.recordingURL(dir: dir, mode: meeting.mode)
    }

    private func channels(_ meeting: Meeting) -> [(Channel, Int)] {
        meeting.mode == .remote ? [(.mic, 0), (.system, 1)] : [(.mic, 0)]
    }

    private func extractAudio(_ meeting: Meeting) throws {
        let ffmpeg = try Tool.ffmpeg.require(config)
        for (channel, index) in channels(meeting) {
            let result = try Shell.run(ffmpeg, ["-hide_banner", "-loglevel", "error", "-y",
                                                "-i", recording(meeting).path,
                                                "-map", "0:a:\(index)", "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le",
                                                file("\(channel.rawValue).wav").path])
            guard result.ok else { throw RecapError("FFMPEG_FAILED", result.stderr.trimmed) }
        }
    }

    private func transcribe(_ meeting: Meeting) throws {
        let whisper = try Tool.whisper.require(config)
        let model = config.whisperModelURL
        guard FileManager.default.fileExists(atPath: model.path) else {
            throw RecapError("MODEL_MISSING", "Whisper model not found at \(model.path). Run `recap setup`.")
        }
        if channels(meeting).contains(where: { !FileManager.default.fileExists(atPath: file("\($0.0.rawValue).wav").path) }) {
            try extractAudio(meeting)
        }
        var byChannel: [Channel: [Segment]] = [:]
        for (channel, _) in channels(meeting) {
            let base = file("transcript-\(channel.rawValue)")
            var arguments = ["-m", model.path, "-l", config.transcriptionLanguage, "-t", "\(Self.threads)",
                             "-oj", "-of", base.path, "-np", "-sns"]
            if let vocabulary = config.vocabulary, !vocabulary.isEmpty {
                arguments += ["--prompt", "Glosario: \(vocabulary.joined(separator: ", "))."]
            }
            if FileManager.default.fileExists(atPath: config.vadModelURL.path) {
                arguments += ["--vad", "-vm", config.vadModelURL.path]
            }
            arguments.append(file("\(channel.rawValue).wav").path)
            let result = try Shell.run(whisper, arguments)
            guard result.ok else { throw RecapError("WHISPER_FAILED", result.stderr.trimmed) }
            let json = base.appendingPathExtension("json")
            byChannel[channel] = try WhisperOutput.parse(Data(contentsOf: json), channel: channel)
        }
        let segments = TranscriptMerger.merge(mic: byChannel[.mic] ?? [], system: byChannel[.system] ?? [])
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .withoutEscapingSlashes]
        try encoder.encode(segments).write(to: file("transcript.json"), options: .atomic)
        try TranscriptRenderer.markdown(meeting: meeting, segments: segments)
            .write(to: file("transcript.md"), atomically: true, encoding: .utf8)
    }

    private func extractFrames(_ meeting: Meeting) throws {
        let ffmpeg = try Tool.ffmpeg.require(config)
        let framesDir = file("frames")
        try? FileManager.default.removeItem(at: framesDir)
        try FileManager.default.createDirectory(at: framesDir, withIntermediateDirectories: true)
        let select = "select='isnan(prev_selected_t)+gt(scene\\,0.15)*gte(t-prev_selected_t\\,20)+gte(t-prev_selected_t\\,300)',showinfo"
        let result = try Shell.run(ffmpeg, ["-hide_banner", "-y", "-i", recording(meeting).path,
                                            "-map", "0:v:0", "-vf", select, "-fps_mode", "vfr", "-q:v", "4",
                                            framesDir.appending(path: "raw-%04d.jpg").path])
        guard result.ok else { throw RecapError("FFMPEG_FAILED", result.stderr.trimmed.suffix(500).description) }
        let times = Self.showinfoTimes(result.stderr)
        let raw = ((try? FileManager.default.contentsOfDirectory(atPath: framesDir.path)) ?? [])
            .filter { $0.hasPrefix("raw-") }.sorted()
        let keep = Set(Self.evenlySpaced(count: raw.count, limit: Self.maxFrames))
        var frames: [FrameInfo] = []
        for (index, name) in raw.enumerated() {
            let source = framesDir.appending(path: name)
            guard keep.contains(index), index < times.count else {
                try? FileManager.default.removeItem(at: source)
                continue
            }
            let target = "\(TranscriptRenderer.timestamp(Int(times[index] * 1000)).replacingOccurrences(of: ":", with: "-")).jpg"
            try? FileManager.default.removeItem(at: framesDir.appending(path: target))
            try FileManager.default.moveItem(at: source, to: framesDir.appending(path: target))
            frames.append(FrameInfo(file: "frames/\(target)", timeSeconds: times[index]))
        }
        try JSONEncoder().encode(frames).write(to: file("frames.json"), options: .atomic)
    }

    private func proposals(_ meeting: Meeting) throws {
        let bita = try BitaClient(config: config,
                                  target: BitaTarget(databasePath: meeting.bitaDatabasePath, docsRoot: meeting.bitaDocsRoot))
        _ = try ProposalGenerator(config: config, bita: bita, log: log).run(meeting: meeting, dir: dir)
    }

    private func summarize(_ meeting: Meeting) throws {
        let prompt = try SummaryPrompt.render(meeting: meeting, dir: dir)
        let output = try ClaudeRunner.run(prompt: prompt, dir: dir, config: config)
        try SummaryPrompt.save(try SummaryPrompt.extractResult(output), meeting: meeting, dir: dir)
    }

    static var threads: Int {
        max(2, min(8, ProcessInfo.processInfo.activeProcessorCount - 2))
    }

    static func showinfoTimes(_ log: String) -> [Double] {
        log.split(separator: "\n").compactMap { line -> Double? in
            guard line.contains("Parsed_showinfo"), let range = line.range(of: "pts_time:") else { return nil }
            let value = line[range.upperBound...].prefix { !$0.isWhitespace }
            return Double(value)
        }
    }

    static func evenlySpaced(count: Int, limit: Int) -> [Int] {
        guard count > limit, limit > 1 else { return Array(0..<count) }
        return (0..<limit).map { Int((Double($0) * Double(count - 1) / Double(limit - 1)).rounded()) }
    }
}

enum SummaryPrompt {
    static func template() throws -> String {
        try ResourceText.load("summary-prompt.md")
    }

    static func render(meeting: Meeting, dir: URL) throws -> String {
        guard let transcript = try? String(contentsOf: dir.appending(path: "transcript.md"), encoding: .utf8) else {
            throw RecapError("NO_TRANSCRIPT", "\"\(meeting.title)\" has no transcript yet; run `recap process \(meeting.id)`")
        }
        let frames = (try? JSONDecoder().decode([FrameInfo].self, from: Data(contentsOf: dir.appending(path: "frames.json")))) ?? []
        return try render(meeting: meeting, transcript: transcript, frames: frames)
    }

    static func save(_ body: String, meeting: Meeting, dir: URL) throws {
        var content = body.trimmed
        if let start = content.range(of: "## Resumen") { content = String(content[start.lowerBound...]) }
        guard !content.isEmpty else { throw RecapError("EMPTY_SUMMARY", "The summary is empty") }
        let document = "# \(meeting.title)\n\n\(TranscriptRenderer.header(meeting))\n\n\(content)\n"
        try document.write(to: dir.appending(path: "summary.md"), atomically: true, encoding: .utf8)
    }

    static func render(meeting: Meeting, transcript: String, frames: [FrameInfo]) throws -> String {
        let mode = meeting.mode == .remote ? "remota (videollamada)" : "presencial"
        let speakers = meeting.mode == .remote
            ? "- Hablantes: «Sala» es el micrófono local (quien graba y quien esté en su sala); «Remotos» es el audio de la llamada. No hay separación por persona; identifica a cada quien por contexto cuando se presenten o se nombren."
            : "- Hablantes: un solo micrófono en la sala, sin separación por persona; identifica a cada quien por contexto cuando se presenten o se nombren."
        var framesText = ""
        if !frames.isEmpty {
            let list = frames.map { "  - \($0.file) [\(TranscriptRenderer.timestamp(Int($0.timeSeconds * 1000)))]" }
            framesText = "- Capturas de pantalla (en el directorio actual; ábrelas con Read cuando el tema lo amerite, en especial diapositivas, documentos o demos):\n"
                + list.joined(separator: "\n")
        }
        return try template()
            .replacingOccurrences(of: "{{title}}", with: meeting.title)
            .replacingOccurrences(of: "{{date}}", with: TranscriptRenderer.header(meeting).components(separatedBy: " · ").first ?? "")
            .replacingOccurrences(of: "{{duration}}", with: Duration.format(meeting.durationSeconds))
            .replacingOccurrences(of: "{{mode}}", with: mode)
            .replacingOccurrences(of: "{{speakers}}", with: speakers)
            .replacingOccurrences(of: "{{frames}}", with: framesText)
            .replacingOccurrences(of: "{{transcript}}", with: transcript)
    }

    static func extractResult(_ output: String) throws -> String {
        let result = try ClaudeRunner.resultText(output)
        guard let start = result.range(of: "## Resumen") else { return result }
        return String(result[start.lowerBound...])
    }
}

final class ProcessLock {
    private let url: URL

    init(url: URL) throws {
        self.url = url
        if let text = try? String(contentsOf: url, encoding: .utf8), let pid = Int32(text.trimmed),
           pid != getpid(), ProcessCheck.isAlive(pid) {
            throw RecapError("ALREADY_PROCESSING", "The meeting is already being processed (pid \(pid))")
        }
        try "\(getpid())".write(to: url, atomically: true, encoding: .utf8)
    }

    func release() {
        try? FileManager.default.removeItem(at: url)
    }
}
