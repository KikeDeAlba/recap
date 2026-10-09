import Darwin
import Foundation

struct DetectedQuestion: Equatable {
    var text: String
    var atMs: Int?
}

enum DetectorResponse {
    static func parse(_ text: String) throws -> [DetectedQuestion] {
        guard let value = json(text) else {
            throw RecapError("DETECTOR_OUTPUT", "Unexpected detector output: \(text.trimmed.prefix(200))")
        }
        if let list = value as? [Any] { return try items(list) }
        guard let object = value as? [String: Any] else {
            throw RecapError("DETECTOR_OUTPUT", "Unexpected detector output: \(text.trimmed.prefix(200))")
        }
        if let list = object["questions"] {
            if list is NSNull { return [] }
            guard let items = list as? [Any] else {
                throw RecapError("DETECTOR_OUTPUT", "Unexpected detector questions: \(String(describing: list).prefix(200))")
            }
            return try self.items(items)
        }
        guard object["question"] != nil else {
            throw RecapError("DETECTOR_OUTPUT", "Unexpected detector output: \(text.trimmed.prefix(200))")
        }
        return try item(object).map { [$0] } ?? []
    }

    private static func json(_ text: String) -> Any? {
        let candidates: [(Character, Character)] = [("{", "}"), ("[", "]")]
        let ordered = candidates.sorted {
            (text.firstIndex(of: $0.0) ?? text.endIndex) < (text.firstIndex(of: $1.0) ?? text.endIndex)
        }
        for (open, close) in ordered {
            guard let start = text.firstIndex(of: open), let end = text.lastIndex(of: close), start < end,
                  let value = try? JSONSerialization.jsonObject(with: Data(String(text[start...end]).utf8)) else { continue }
            return value
        }
        return nil
    }

    private static func items(_ list: [Any]) throws -> [DetectedQuestion] {
        try list.compactMap { element in
            if let text = element as? String { return clean(text).map { DetectedQuestion(text: $0, atMs: nil) } }
            guard let object = element as? [String: Any] else {
                throw RecapError("DETECTOR_OUTPUT", "Unexpected detector question: \(String(describing: element).prefix(200))")
            }
            return try item(object)
        }
    }

    private static func item(_ object: [String: Any]) throws -> DetectedQuestion? {
        guard let value = object["question"], !(value is NSNull) else { return nil }
        guard let question = value as? String else {
            throw RecapError("DETECTOR_OUTPUT", "Unexpected detector question: \(String(describing: value).prefix(200))")
        }
        return clean(question).map { DetectedQuestion(text: $0, atMs: QuestionClock.milliseconds(object["at"])) }
    }

    private static func clean(_ question: String) -> String? {
        let trimmed = question.trimmed
        guard !trimmed.isEmpty, trimmed.lowercased() != "null" else { return nil }
        return trimmed
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
    private(set) var pending = true

    init(minSeconds: TimeInterval) {
        self.minSeconds = minSeconds
    }

    mutating func grew() {
        pending = true
    }

    mutating func settle(remaining: Bool) {
        if remaining { pending = true }
    }

    mutating func shouldRun(now: Date) -> Bool {
        guard pending else { return false }
        if let lastRun, now.timeIntervalSince(lastRun) < minSeconds { return false }
        pending = false
        lastRun = now
        return true
    }
}

struct DetectorCursor: Codable, Equatable {
    var detectedThroughMs: Int
    var examinedSegments: Int

    static let start = DetectorCursor(detectedThroughMs: 0, examinedSegments: 0)

    static func load(_ meetingDir: URL) -> DetectorCursor {
        guard let data = try? Data(contentsOf: LiveFiles.detectorState(meetingDir)),
              let cursor = try? JSONDecoder().decode(DetectorCursor.self, from: data) else { return .start }
        return cursor
    }

    func save(_ meetingDir: URL) throws {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys]
        try encoder.encode(self).write(to: LiveFiles.detectorState(meetingDir), options: .atomic)
    }
}

struct DetectorBatch: Equatable {
    static let reviewedSeconds = 60

    var reviewed: [Segment]
    var fresh: [Segment]
    var cursor: DetectorCursor

    init(_ segments: [Segment], cursor: DetectorCursor) {
        let examined = min(max(0, cursor.examinedSegments), segments.count)
        let from = cursor.detectedThroughMs - Self.reviewedSeconds * 1000
        reviewed = LiveMerger.ordered(segments[..<examined].filter { $0.endMs >= from && !$0.text.trimmed.isEmpty })
        fresh = LiveMerger.ordered(segments[examined...].filter { !$0.text.trimmed.isEmpty })
        let through = segments[examined...].map(\.endMs).max() ?? cursor.detectedThroughMs
        self.cursor = DetectorCursor(detectedThroughMs: max(cursor.detectedThroughMs, through), examinedSegments: segments.count)
    }

    var hasNew: Bool { !fresh.isEmpty }
}

enum DetectPrompt {
    static func render(template: String, meeting: Meeting, context: ProjectContext, batch: DetectorBatch, known: [String]) -> String {
        let labelled = meeting.mode == .remote
        let title = meeting.bitaEntry?.title ?? meeting.title
        let pages = context.pages.isEmpty
            ? "  (sin páginas registradas para este proyecto)"
            : context.pages.map { "  \(String(repeating: "  ", count: max(0, $0.depth)))- \($0.title)" }.joined(separator: "\n")
        let speakers = labelled
            ? "Es una reunión remota: «Sala» es el micrófono de quien graba y «Remotos» es el audio de la llamada. Las preguntas que vienen de «Remotos» suelen ir dirigidas a quien graba y pesan más; una pregunta de «Sala» solo cuenta si es claramente una duda técnica abierta."
            : "Es una reunión presencial con un solo micrófono («Sala»), sin separación por persona: juzga solo por el contenido de lo que se dice."
        let knownList = known.isEmpty ? "(ninguna)" : known.map { "- \($0)" }.joined(separator: "\n")
        let reviewed = batch.reviewed.isEmpty ? "(nada)" : LiveTranscript.render(batch.reviewed, labelled: labelled)
        return template
            .replacingOccurrences(of: "{{title}}", with: title)
            .replacingOccurrences(of: "{{project}}", with: context.project ?? "sin proyecto")
            .replacingOccurrences(of: "{{pages}}", with: pages)
            .replacingOccurrences(of: "{{speakers}}", with: speakers)
            .replacingOccurrences(of: "{{known}}", with: knownList)
            .replacingOccurrences(of: "{{reviewed}}", with: reviewed)
            .replacingOccurrences(of: "{{transcript}}", with: LiveTranscript.render(batch.fresh, labelled: labelled))
    }
}

enum DetectionOutcome: Equatable {
    case idle
    case examined(queued: [String], duplicates: [String])
    case failed(String)
}

final class QuestionDetector {
    struct Dependencies {
        var now: () -> Date = Date.init
        var template: () throws -> String = { try ResourceText.load("detect-prompt.md") }
        var context: () -> ProjectContext
        var complete: (String) throws -> String
        var enqueue: (String, QuestionOrigin?) -> Void
        var cancelAsks: () -> Void = {}
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
        let run = !stopped && !busy && pacer.shouldRun(now: dependencies.now())
        if run { busy = true }
        state.unlock()
        guard run else { return false }
        queue.async { [self] in
            let outcome = runCycle()
            let remaining: Bool
            if case .failed = outcome { remaining = true } else { remaining = hasUnexamined() }
            state.lock()
            pacer.settle(remaining: remaining)
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
        if !waitUntilIdle(timeout: timeout) {
            dependencies.log("question detector did not stop within \(Int(timeout)) s")
        }
        dependencies.cancelAsks()
    }

    func hasUnexamined() -> Bool {
        JSONLines.read(Segment.self, from: LiveFiles.transcript(dir)).count > DetectorCursor.load(dir).examinedSegments
    }

    func runCycle() -> DetectionOutcome {
        let outcome = detect()
        switch outcome {
        case .idle: break
        case let .examined(_, duplicates):
            for question in duplicates { dependencies.log("auto ask: skipped duplicate «\(question)»") }
        case let .failed(message): dependencies.log("auto ask: detection failed: \(message)")
        }
        return outcome
    }

    private func detect() -> DetectionOutcome {
        guard !isStopped else { return .idle }
        let segments = JSONLines.read(Segment.self, from: LiveFiles.transcript(dir))
        let batch = DetectorBatch(segments, cursor: DetectorCursor.load(dir))
        guard batch.hasNew else {
            if batch.cursor.examinedSegments != DetectorCursor.load(dir).examinedSegments { try? batch.cursor.save(dir) }
            return .idle
        }
        var known = knownQuestions()
        let found: [DetectedQuestion]
        do {
            let prompt = DetectPrompt.render(template: try dependencies.template(), meeting: meeting,
                                             context: context(), batch: batch, known: known)
            found = try DetectorResponse.parse(try dependencies.complete(prompt))
            try batch.cursor.save(dir)
        } catch {
            return .failed(Self.describe(error))
        }
        var queued: [String] = []
        var duplicates: [String] = []
        for detection in found {
            let question = detection.text
            if QuestionDedupe.isDuplicate(question, of: known) {
                duplicates.append(question)
                continue
            }
            state.lock()
            let halted = stopped
            if !halted { detected.append(question) }
            state.unlock()
            guard !halted else { break }
            known.append(question)
            let origin = detection.atMs.flatMap {
                QuestionOriginResolver.resolve(atMs: $0, segments: batch.reviewed + batch.fresh, question: question)
            }
            dependencies.log("auto ask: detected «\(question)»" + (origin.map { " at \($0.questionMs) ms (\($0.channel.rawValue))" } ?? ""))
            dependencies.enqueue(question, origin)
            queued.append(question)
        }
        return .examined(queued: queued, duplicates: duplicates)
    }

    private var isStopped: Bool {
        state.lock()
        defer { state.unlock() }
        return stopped
    }

    private func knownQuestions() -> [String] {
        let answered = JSONLines.read(Answer.self, from: LiveFiles.answers(dir)).map(\.question)
        let asking = AskingBoard.entries(dir).compactMap(\.question)
        var seen = Set<String>()
        return (answered + asking + detectedQuestions).filter { !$0.trimmed.isEmpty && seen.insert($0).inserted }
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

struct AutoAskJob: Equatable {
    var id: String
    var question: String
    var origin: QuestionOrigin?
    var queuedAt: Date
}

final class AutoAskQueue {
    private let dir: URL
    private let concurrency: Int
    private let pid: Int32
    private let now: () -> Date
    private let run: (AutoAskJob) throws -> Void
    private let cancelRunning: () -> Void
    private let log: (String) -> Void
    private let state = NSLock()
    private let group = DispatchGroup()
    private var waiting: [AutoAskJob] = []
    private var running: [String: AutoAskJob] = [:]
    private var stopped = false

    init(dir: URL, concurrency: Int, pid: Int32 = getpid(), now: @escaping () -> Date = Date.init,
         run: @escaping (AutoAskJob) throws -> Void, cancelRunning: @escaping () -> Void = {},
         log: @escaping (String) -> Void) {
        self.dir = dir
        self.concurrency = max(1, concurrency)
        self.pid = pid
        self.now = now
        self.run = run
        self.cancelRunning = cancelRunning
        self.log = log
    }

    var runningCount: Int {
        state.lock()
        defer { state.unlock() }
        return running.count
    }

    var waitingCount: Int {
        state.lock()
        defer { state.unlock() }
        return waiting.count
    }

    @discardableResult
    func enqueue(_ question: String, origin: QuestionOrigin?) -> AutoAskJob? {
        let job = AutoAskJob(id: AskID.make(), question: question, origin: origin, queuedAt: now())
        state.lock()
        let halted = stopped
        if !halted { group.enter() }
        state.unlock()
        guard !halted else { return nil }
        do {
            try AskingBoard.write(dir, asking(job, phase: .queued))
        } catch {
            log("auto ask: cannot write the queued ask: \(QuestionDetector.describe(error))")
        }
        state.lock()
        waiting.append(job)
        let ahead = waiting.count - 1
        state.unlock()
        log("auto ask: queued «\(question)» as \(job.id)" + (ahead > 0 ? " (\(ahead) waiting ahead)" : ""))
        pump()
        return job
    }

    func waitUntilIdle(timeout: TimeInterval) -> Bool {
        group.wait(timeout: .now() + timeout) == .success
    }

    func cancelAll(timeout: TimeInterval = 10) {
        state.lock()
        stopped = true
        let dropped = waiting
        waiting = []
        state.unlock()
        for job in dropped {
            AskingBoard.remove(dir, id: job.id)
            log("auto ask: dropped «\(job.question)» because the worker stopped")
            group.leave()
        }
        cancelRunning()
        if !waitUntilIdle(timeout: timeout) {
            log("auto asks did not stop within \(Int(timeout)) s")
        }
    }

    private func pump() {
        var starting: [AutoAskJob] = []
        state.lock()
        while !stopped, running.count < concurrency, !waiting.isEmpty {
            let job = waiting.removeFirst()
            running[job.id] = job
            starting.append(job)
        }
        state.unlock()
        for job in starting {
            try? AskingBoard.write(dir, asking(job, phase: .running))
            DispatchQueue.global().async { [self] in execute(job) }
        }
    }

    private func execute(_ job: AutoAskJob) {
        let started = Date()
        log("auto ask: started «\(job.question)» (\(job.id))")
        do {
            try run(job)
            log(String(format: "auto ask: answered «%@» in %.1f s", job.question, Date().timeIntervalSince(started)))
        } catch {
            log("auto ask: failed «\(job.question)»: \(QuestionDetector.describe(error))")
        }
        AskingBoard.remove(dir, id: job.id)
        state.lock()
        running[job.id] = nil
        state.unlock()
        pump()
        group.leave()
    }

    private func asking(_ job: AutoAskJob, phase: AskPhase) -> AskingState {
        AskingState(id: job.id, question: job.question, startedAt: phase == .queued ? job.queuedAt : now(), auto: true,
                    questionMs: job.origin?.questionMs, channel: job.origin?.channel, state: phase, pid: pid)
    }
}

final class AutoAskProcess {
    static let signalStatuses: Set<Int32> = [128 + SIGHUP, 128 + SIGINT, 128 + SIGTERM]

    private let dir: URL
    private let executable: URL
    private let state = NSLock()
    private var processes: [String: Process] = [:]

    init(dir: URL, executable: URL) {
        self.dir = dir
        self.executable = executable
    }

    static func arguments(dir: URL, question: String, origin: QuestionOrigin? = nil, askId: String? = nil) -> [String] {
        var arguments = ["ask", "--dir", dir.path, "--question", question, "--auto", "--json"]
        if let origin {
            arguments += ["--question-ms", String(origin.questionMs), "--channel", origin.channel.rawValue]
        }
        if let askId { arguments += ["--ask-id", askId] }
        return arguments
    }

    func run(_ job: AutoAskJob) throws {
        let child = Process()
        child.executableURL = executable
        child.arguments = Self.arguments(dir: dir, question: job.question, origin: job.origin, askId: job.id)
        child.currentDirectoryURL = dir
        let out = Pipe()
        let err = Pipe()
        child.standardOutput = out
        child.standardError = err
        child.standardInput = FileHandle.nullDevice
        state.lock()
        processes[job.id] = child
        state.unlock()
        defer {
            state.lock()
            processes[job.id] = nil
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
        if child.terminationReason == .uncaughtSignal || Self.signalStatuses.contains(child.terminationStatus) {
            throw RecapError("ASK_INTERRUPTED", "The auto ask was stopped (status \(child.terminationStatus))")
        }
        guard child.terminationStatus == 0 else {
            if let failure = Self.failure(outData) { throw failure }
            let detail = String(decoding: errData, as: UTF8.self).trimmed
            throw RecapError("ASK_FAILED", detail.isEmpty ? "recap ask exited with status \(child.terminationStatus)" : String(detail.suffix(400)))
        }
    }

    func cancel() {
        state.lock()
        let running = Array(processes.values)
        state.unlock()
        for process in running where process.isRunning {
            ProcessTree.signal(process.processIdentifier, SIGTERM)
        }
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
        let asks = AutoAskQueue(dir: dir, concurrency: settings.autoAskConcurrency, run: { try runner.run($0) },
                                cancelRunning: { runner.cancel() }, log: log)
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
            enqueue: { question, origin in asks.enqueue(question, origin: origin) },
            cancelAsks: { asks.cancelAll() },
            log: log
        )
        return QuestionDetector(dir: dir, meeting: meeting, minSeconds: settings.autoAskMinSeconds, dependencies: dependencies)
    }
}
