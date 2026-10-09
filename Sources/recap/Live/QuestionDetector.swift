import Darwin
import Foundation

struct DetectedQuestion: Equatable {
    var text: String
    var atMs: Int?
}

enum DetectorResponse {
    static func parse(_ text: String) throws -> DetectedQuestion? {
        guard let start = text.firstIndex(of: "{"), let end = text.lastIndex(of: "}"), start < end,
              let object = (try? JSONSerialization.jsonObject(with: Data(String(text[start...end]).utf8),
                                                              options: [.fragmentsAllowed])) as? [String: Any],
              let value = object["question"] else {
            throw RecapError("DETECTOR_OUTPUT", "Unexpected detector output: \(text.trimmed.prefix(200))")
        }
        if value is NSNull { return nil }
        guard let question = value as? String else {
            throw RecapError("DETECTOR_OUTPUT", "Unexpected detector question: \(String(describing: value).prefix(200))")
        }
        let trimmed = question.trimmed
        guard !trimmed.isEmpty, trimmed.lowercased() != "null" else { return nil }
        return DetectedQuestion(text: trimmed, atMs: QuestionClock.milliseconds(object["at"]))
    }
}

enum QuestionDedupe {
    static let threshold = 0.5
    static let stopwords: Set<String> = [
        "el", "la", "los", "las", "lo", "un", "una", "unos", "unas", "de", "del", "al", "en", "por", "para", "con",
        "sin", "se", "es", "son", "como", "cual", "cuales", "donde", "cuando", "quien", "que", "y", "o",
        "u", "le", "les", "su", "sus", "me", "mi", "te", "tu", "nos", "este", "esta", "esto", "ese", "esa", "eso",
        "hay", "ya", "mas", "pero", "si", "no", "muy", "hace", "hacer", "puede", "podemos",
    ]

    static func tokens(_ text: String) -> Set<String> {
        TextSimilarity.tokens(text).subtracting(stopwords)
    }

    static func similarity(_ a: String, _ b: String) -> Double {
        let left = tokens(a)
        let right = tokens(b)
        guard !left.isEmpty, !right.isEmpty else { return TextSimilarity.jaccard(a, b) }
        return Double(left.intersection(right).count) / Double(left.union(right).count)
    }

    static func isDuplicate(_ question: String, of known: [String]) -> Bool {
        known.contains { similarity(question, $0) >= threshold }
    }
}

struct DetectionPacer {
    let minSeconds: TimeInterval
    private(set) var lastRun: Date?
    private(set) var pending = false

    init(minSeconds: TimeInterval) {
        self.minSeconds = minSeconds
    }

    mutating func grew() {
        pending = true
    }

    mutating func shouldRun(now: Date, busy: Bool) -> Bool {
        guard pending, !busy else { return false }
        if let lastRun, now.timeIntervalSince(lastRun) < minSeconds { return false }
        pending = false
        lastRun = now
        return true
    }
}

enum DetectPrompt {
    static let windowSeconds = 90

    static func render(template: String, meeting: Meeting, context: ProjectContext, window: [Segment], known: [String]) -> String {
        let labelled = meeting.mode == .remote
        let title = meeting.bitaEntry?.title ?? meeting.title
        let pages = context.pages.isEmpty
            ? "  (sin páginas registradas para este proyecto)"
            : context.pages.map { "  \(String(repeating: "  ", count: max(0, $0.depth)))- \($0.title)" }.joined(separator: "\n")
        let speakers = labelled
            ? "Es una reunión remota: «Sala» es el micrófono de quien graba y «Remotos» es el audio de la llamada. Las preguntas que vienen de «Remotos» suelen ir dirigidas a quien graba y pesan más; una pregunta de «Sala» solo cuenta si es claramente una duda técnica abierta."
            : "Es una reunión presencial con un solo micrófono («Sala»), sin separación por persona: juzga solo por el contenido de lo que se dice."
        let knownList = known.isEmpty ? "(ninguna)" : known.map { "- \($0)" }.joined(separator: "\n")
        return template
            .replacingOccurrences(of: "{{title}}", with: title)
            .replacingOccurrences(of: "{{project}}", with: context.project ?? "sin proyecto")
            .replacingOccurrences(of: "{{pages}}", with: pages)
            .replacingOccurrences(of: "{{speakers}}", with: speakers)
            .replacingOccurrences(of: "{{known}}", with: knownList)
            .replacingOccurrences(of: "{{transcript}}", with: LiveTranscript.render(window, labelled: labelled))
    }
}

enum DetectionOutcome: Equatable {
    case skippedBusy
    case noTranscript
    case none
    case duplicate(String)
    case asked(String)
    case askBusy(String)
    case failed(String)
}

final class QuestionDetector {
    struct Dependencies {
        var now: () -> Date = Date.init
        var template: () throws -> String = { try ResourceText.load("detect-prompt.md") }
        var context: () -> ProjectContext
        var complete: (String) throws -> String
        var ask: (String, QuestionOrigin?) throws -> Void
        var cancelAsk: () -> Void = {}
        var log: (String) -> Void
    }

    private let dir: URL
    private let meeting: Meeting
    private let dependencies: Dependencies
    private let queue = DispatchQueue(label: "recap.question-detector")
    private let state = NSLock()
    private var pacer: DetectionPacer
    private var busy = false
    private var stopped = false
    private var detected: [String] = []
    private var cachedContext: ProjectContext?

    init(dir: URL, meeting: Meeting, minSeconds: Int, dependencies: Dependencies) {
        self.dir = dir
        self.meeting = meeting
        self.dependencies = dependencies
        pacer = DetectionPacer(minSeconds: TimeInterval(minSeconds))
    }

    var detectedQuestions: [String] {
        state.lock()
        defer { state.unlock() }
        return detected
    }

    func transcriptGrew() {
        state.lock()
        pacer.grew()
        state.unlock()
    }

    @discardableResult
    func tick() -> Bool {
        state.lock()
        let run = !stopped && pacer.shouldRun(now: dependencies.now(), busy: busy)
        if run { busy = true }
        state.unlock()
        guard run else { return false }
        queue.async { [self] in
            _ = runCycle()
            state.lock()
            busy = false
            state.unlock()
        }
        return true
    }

    func waitUntilIdle(timeout: TimeInterval) -> Bool {
        let done = DispatchSemaphore(value: 0)
        queue.async { done.signal() }
        return done.wait(timeout: .now() + timeout) == .success
    }

    func stop(timeout: TimeInterval = 20) {
        state.lock()
        stopped = true
        state.unlock()
        dependencies.cancelAsk()
        if !waitUntilIdle(timeout: timeout) {
            dependencies.log("question detector did not stop within \(Int(timeout)) s")
        }
    }

    func runCycle() -> DetectionOutcome {
        let outcome = detect()
        switch outcome {
        case .skippedBusy, .noTranscript, .none: break
        case let .duplicate(question): dependencies.log("auto ask: skipped duplicate «\(question)»")
        case let .asked(question): dependencies.log("auto ask: answered «\(question)»")
        case let .askBusy(question): dependencies.log("auto ask: another answer is in progress, skipped «\(question)»")
        case let .failed(message): dependencies.log("auto ask failed: \(message)")
        }
        return outcome
    }

    private func detect() -> DetectionOutcome {
        guard !isStopped else { return .none }
        guard !AskLock.isHeld(dir) else { return .skippedBusy }
        let segments = LiveTranscript.load(dir)
        let window = LiveTranscript.window(segments, seconds: DetectPrompt.windowSeconds)
        guard !window.isEmpty else { return .noTranscript }
        let known = knownQuestions()
        let detection: DetectedQuestion?
        do {
            let prompt = DetectPrompt.render(template: try dependencies.template(), meeting: meeting,
                                             context: context(), window: window, known: known)
            detection = try DetectorResponse.parse(try dependencies.complete(prompt))
        } catch {
            return .failed(Self.describe(error))
        }
        guard let detection else { return .none }
        let question = detection.text
        if QuestionDedupe.isDuplicate(question, of: known) { return .duplicate(question) }
        state.lock()
        detected.append(question)
        let halted = stopped
        state.unlock()
        guard !halted else { return .none }
        guard !AskLock.isHeld(dir) else { return .askBusy(question) }
        let origin = detection.atMs.flatMap { QuestionOriginResolver.resolve(atMs: $0, segments: window, question: question) }
        dependencies.log("auto ask: detected «\(question)»" + (origin.map { " at \($0.questionMs) ms (\($0.channel.rawValue))" } ?? ""))
        do {
            try dependencies.ask(question, origin)
            return .asked(question)
        } catch let error as RecapError where error.code == "ASK_BUSY" {
            return .askBusy(question)
        } catch {
            return .failed(Self.describe(error))
        }
    }

    private var isStopped: Bool {
        state.lock()
        defer { state.unlock() }
        return stopped
    }

    private func knownQuestions() -> [String] {
        let answered = JSONLines.read(Answer.self, from: LiveFiles.answers(dir)).map(\.question).filter { !$0.trimmed.isEmpty }
        let asking = AskingState.read(dir)?.question.map { [$0] } ?? []
        var seen = Set<String>()
        return (answered + asking + detectedQuestions).filter { seen.insert($0).inserted }
    }

    private func context() -> ProjectContext {
        if let cachedContext { return cachedContext }
        let loaded = dependencies.context()
        cachedContext = loaded
        return loaded
    }

    static func describe(_ error: Error) -> String {
        (error as? RecapError)?.description ?? String(describing: error)
    }
}

final class AutoAskProcess {
    private let dir: URL
    private let executable: URL
    private let state = NSLock()
    private var process: Process?

    init(dir: URL, executable: URL) {
        self.dir = dir
        self.executable = executable
    }

    static func arguments(dir: URL, question: String, origin: QuestionOrigin? = nil) -> [String] {
        var arguments = ["ask", "--dir", dir.path, "--question", question, "--auto", "--json"]
        if let origin {
            arguments += ["--question-ms", String(origin.questionMs), "--channel", origin.channel.rawValue]
        }
        return arguments
    }

    func run(_ question: String, origin: QuestionOrigin? = nil) throws {
        let child = Process()
        child.executableURL = executable
        child.arguments = Self.arguments(dir: dir, question: question, origin: origin)
        child.currentDirectoryURL = dir
        let out = Pipe()
        let err = Pipe()
        child.standardOutput = out
        child.standardError = err
        child.standardInput = FileHandle.nullDevice
        state.lock()
        process = child
        state.unlock()
        defer {
            state.lock()
            process = nil
            state.unlock()
        }
        try child.run()
        var errData = Data()
        let group = DispatchGroup()
        group.enter()
        DispatchQueue.global().async {
            errData = err.fileHandleForReading.readDataToEndOfFile()
            group.leave()
        }
        let outData = out.fileHandleForReading.readDataToEndOfFile()
        child.waitUntilExit()
        group.wait()
        if child.terminationReason == .uncaughtSignal {
            AskCoordinator.clearAbandoned(dir: dir, pid: child.processIdentifier)
            throw RecapError("ASK_INTERRUPTED", "The auto ask was stopped (signal \(child.terminationStatus))")
        }
        guard child.terminationStatus == 0 else {
            if let failure = Self.failure(outData) { throw failure }
            let detail = String(decoding: errData, as: UTF8.self).trimmed
            throw RecapError("ASK_FAILED", detail.isEmpty ? "recap ask exited with status \(child.terminationStatus)" : String(detail.suffix(400)))
        }
    }

    func cancel() {
        state.lock()
        let running = process
        state.unlock()
        guard let running, running.isRunning else { return }
        AskLock.signal(running.processIdentifier, SIGTERM)
    }

    static func failure(_ output: Data) -> RecapError? {
        guard let object = (try? JSONSerialization.jsonObject(with: output)) as? [String: Any],
              let error = object["error"] as? [String: Any], let code = error["code"] as? String else { return nil }
        return RecapError(code, error["message"] as? String ?? code)
    }
}

enum LiveQuestionDetector {
    static func make(dir: URL, meeting: Meeting, config: Config, log: @escaping (String) -> Void) -> QuestionDetector? {
        let settings = config.liveSettings
        guard settings.autoAsk, let executable = Paths.executable else { return nil }
        let runner = AutoAskProcess(dir: dir, executable: executable)
        let dependencies = QuestionDetector.Dependencies(
            context: {
                let bita = MeetingContext.bita(meeting, config: config)
                return ProjectContextLoader.load(project: MeetingContext.project(meeting, bita: bita),
                                                 docsRoot: meeting.bitaDocsRoot, bita: bita)
            },
            complete: { prompt in
                let output = try ClaudeRunner.run(prompt: prompt, cwd: dir, config: config, tools: [], addDirs: [],
                                                  model: settings.autoAskModel, restrictTools: [])
                return try ClaudeRunner.resultText(output)
            },
            ask: { question, origin in try runner.run(question, origin: origin) },
            cancelAsk: { runner.cancel() },
            log: log
        )
        return QuestionDetector(dir: dir, meeting: meeting, minSeconds: settings.autoAskMinSeconds, dependencies: dependencies)
    }
}
