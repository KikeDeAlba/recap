import Foundation

enum AskEvent: Encodable, Equatable {
    case question(String)
    case progress(String)
    case delta(String)
    case source(AnswerSource)
    case done(Answer)
    case error(code: String, message: String)

    private enum CodingKeys: String, CodingKey {
        case type, text, source, answer, code, message
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        switch self {
        case let .question(text):
            try container.encode("question", forKey: .type)
            try container.encode(text, forKey: .text)
        case let .progress(text):
            try container.encode("progress", forKey: .type)
            try container.encode(text, forKey: .text)
        case let .delta(text):
            try container.encode("delta", forKey: .type)
            try container.encode(text, forKey: .text)
        case let .source(source):
            try container.encode("source", forKey: .type)
            try container.encode(source, forKey: .source)
        case let .done(answer):
            try container.encode("done", forKey: .type)
            try container.encode(answer, forKey: .answer)
        case let .error(code, message):
            try container.encode("error", forKey: .type)
            try container.encode(code, forKey: .code)
            try container.encode(message, forKey: .message)
        }
    }
}

struct AskRequest {
    var meeting: Meeting
    var dir: URL
    var question: String?
    var windowSeconds: Int
    var now = Date()
    var auto = false
}

enum AskPrompt {
    static let readTools = ["Read", "Grep", "Glob"]
    static let gitSubcommands = ["log", "show", "diff"]

    static func allowedTools(_ context: ProjectContext) -> [String] {
        readTools + context.existingRepos.flatMap { repo in
            gitSubcommands.map { "Bash(git -C \(repo.path) \($0):*)" }
        }
    }
    static let availableTools = ["Read", "Grep", "Glob", "Bash"]

    static func render(template: String, request: AskRequest, context: ProjectContext, segments: [Segment]) -> String {
        let window = LiveTranscript.window(segments, seconds: request.windowSeconds)
        let labelled = request.meeting.mode == .remote
        let title = request.meeting.bitaEntry?.title ?? request.meeting.title
        let questionBlock: String
        if let question = request.question?.trimmed, !question.isEmpty {
            questionBlock = "La pregunta que hay que responder es:\n\n> \(question)\n\nUsa la transcripción solo como contexto."
        } else {
            questionBlock = "No te dieron la pregunta: identifícala en la transcripción de abajo. Es la última pregunta dirigida a quien graba (la persona del micrófono «Sala» en reuniones remotas) o la última que quedó sin responder. Si hay varias, responde la más reciente."
        }
        let pages = context.pages.isEmpty
            ? "  (sin páginas registradas para este proyecto)"
            : context.pages.map { "  \(String(repeating: "  ", count: max(0, $0.depth)))- #\($0.pageId) \($0.title) — \($0.relPath)" }
                .joined(separator: "\n")
        let repos = context.existingRepos.isEmpty
            ? "  (sin repositorios registrados)"
            : context.existingRepos.map { "  - \($0.slug): \($0.path) (git: `git -C \($0.path) log|show|diff …`)" }.joined(separator: "\n")
        let speakers = labelled
            ? "«Sala» es el micrófono local (quien graba y quien esté en su sala); «Remotos» es el audio de la llamada."
            : "Un solo micrófono en la sala, sin separación por persona."
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.dateFormat = "yyyy-MM-dd HH:mm"
        return template
            .replacingOccurrences(of: "{{title}}", with: title)
            .replacingOccurrences(of: "{{project}}", with: context.project ?? "sin proyecto")
            .replacingOccurrences(of: "{{now}}", with: formatter.string(from: request.now))
            .replacingOccurrences(of: "{{questionBlock}}", with: questionBlock)
            .replacingOccurrences(of: "{{docsRoot}}", with: context.docsRoot ?? "(desconocida)")
            .replacingOccurrences(of: "{{pages}}", with: pages)
            .replacingOccurrences(of: "{{repos}}", with: repos)
            .replacingOccurrences(of: "{{speakers}}", with: speakers)
            .replacingOccurrences(of: "{{transcript}}", with: LiveTranscript.render(window, labelled: labelled))
    }

    static func addDirs(_ context: ProjectContext) -> [String] {
        (context.docsRoot.map { [$0] } ?? []) + context.existingRepos.map(\.path)
    }
}

final class AskSession {
    private let config: Config
    private let emit: (AskEvent) -> Void

    init(config: Config, emit: @escaping (AskEvent) -> Void) {
        self.config = config
        self.emit = emit
    }

    func run(_ request: AskRequest, context: ProjectContext) throws -> Answer {
        let segments = LiveTranscript.load(request.dir)
        let explicit = request.question?.trimmed.isEmpty == false ? request.question?.trimmed : nil
        guard explicit != nil || !segments.isEmpty else {
            throw RecapError("NO_QUESTION", "The live transcript is empty; pass --question")
        }
        let prompt = AskPrompt.render(template: try ResourceText.load("ask-prompt.md"), request: request,
                                      context: context, segments: segments)
        if let explicit { emit(.question(explicit)) }
        let describer = ProgressDescriber(docsRoot: context.docsRoot, repos: context.existingRepos)
        let arguments = ClaudeRunner.streamArguments(tools: [AskPrompt.allowedTools(context).joined(separator: " ")],
                                                     addDirs: AskPrompt.addDirs(context),
                                                     model: config.liveSettings.assistModel,
                                                     restrictTools: AskPrompt.availableTools)
        var reducer = AskStreamReducer(explicitQuestion: explicit)
        let result = try ClaudeRunner.stream(prompt: prompt, cwd: request.dir, config: config, arguments: arguments) { line in
            for event in reducer.consume(line, describer: describer) { emit(event) }
        }
        let (events, finished) = try reducer.finish(status: result.status, stderr: result.stderr,
                                                    id: UUID().uuidString.lowercased(), askedAt: request.now)
        var answer = finished
        answer.auto = request.auto ? true : nil
        for event in events { emit(event) }
        try JSONLines.append([answer], to: LiveFiles.answers(request.dir))
        emit(.done(answer))
        return answer
    }
}

struct AskStreamReducer {
    let explicitQuestion: String?
    private var assembler = AnswerAssembler()
    private var questionSent: Bool
    private var deltaSent = false
    private var resultText: String?
    private var resultError = false

    init(explicitQuestion: String?) {
        self.explicitQuestion = explicitQuestion
        questionSent = explicitQuestion != nil
    }

    mutating func consume(_ line: String, describer: ProgressDescriber) -> [AskEvent] {
        var events: [AskEvent] = []
        for event in ClaudeStreamParser.parse(line) {
            switch event {
            case let .text(delta):
                let out = assembler.feed(delta)
                events += questionEvent()
                if !out.isEmpty {
                    deltaSent = true
                    events.append(.delta(out))
                }
            case let .tool(name, input):
                events.append(.progress(describer.describe(name: name, input: input)))
            case let .result(text, isError):
                resultText = text
                resultError = isError
            }
        }
        return events
    }

    private mutating func questionEvent() -> [AskEvent] {
        guard !questionSent, let question = assembler.question else { return [] }
        questionSent = true
        return [.question(question)]
    }

    mutating func finish(status: Int32, stderr: String, id: String, askedAt: Date) throws -> ([AskEvent], Answer) {
        var events: [AskEvent] = []
        let tail = assembler.finish()
        events += questionEvent()
        if !tail.isEmpty {
            deltaSent = true
            events.append(.delta(tail))
        }
        if resultError || (status != 0 && resultText == nil) {
            let detail = resultText ?? stderr.trimmed
            throw RecapError("CLAUDE_FAILED", detail.isEmpty ? "claude exited with status \(status)" : String(detail.suffix(500)))
        }
        var canonical = assembler
        if let resultText, !resultText.trimmed.isEmpty {
            var fresh = AnswerAssembler()
            _ = fresh.feed(resultText)
            _ = fresh.finish()
            canonical = fresh
        }
        let answer = AnswerBuilder.build(id: id, askedAt: askedAt, explicitQuestion: explicitQuestion, assembler: canonical)
        guard !answer.answer.isEmpty else {
            throw RecapError("CLAUDE_FAILED", "claude returned an empty answer")
        }
        if !deltaSent { events.append(.delta(answer.answer)) }
        if !questionSent, !answer.question.isEmpty {
            questionSent = true
            events.append(.question(answer.question))
        }
        events += answer.sources.map(AskEvent.source)
        return (events, answer)
    }
}
