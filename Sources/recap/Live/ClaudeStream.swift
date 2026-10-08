import Foundation

enum ClaudeStreamEvent: Equatable {
    case text(String)
    case tool(name: String, input: [String: String])
    case result(text: String?, isError: Bool)
}

enum ClaudeStreamParser {
    static func parse(_ line: String) -> [ClaudeStreamEvent] {
        guard let object = (try? JSONSerialization.jsonObject(with: Data(line.utf8))) as? [String: Any],
              let type = object["type"] as? String else { return [] }
        switch type {
        case "stream_event":
            guard let event = object["event"] as? [String: Any], event["type"] as? String == "content_block_delta",
                  let delta = event["delta"] as? [String: Any], delta["type"] as? String == "text_delta",
                  let text = delta["text"] as? String, !text.isEmpty else { return [] }
            return [.text(text)]
        case "assistant":
            let content = (object["message"] as? [String: Any])?["content"] as? [[String: Any]] ?? []
            return content.compactMap { block in
                guard block["type"] as? String == "tool_use", let name = block["name"] as? String else { return nil }
                let input = (block["input"] as? [String: Any] ?? [:]).compactMapValues { value -> String? in
                    if let string = value as? String { return string }
                    if let number = value as? NSNumber { return number.stringValue }
                    return nil
                }
                return .tool(name: name, input: input)
            }
        case "result":
            let isError = object["is_error"] as? Bool ?? (object["subtype"] as? String != "success")
            return [.result(text: object["result"] as? String, isError: isError)]
        default:
            return []
        }
    }
}

struct ProgressDescriber {
    var roots: [(prefix: String, label: String)]

    init(docsRoot: String?, repos: [RepoRef]) {
        var roots: [(String, String)] = repos.map { ($0.path, $0.slug) }
        if let docsRoot { roots.append((docsRoot, "docs")) }
        self.roots = roots.sorted { $0.0.count > $1.0.count }
    }

    func describe(name: String, input: [String: String]) -> String {
        switch name {
        case "Read":
            return "Leyendo \(short(input["file_path"] ?? input["path"] ?? ""))"
        case "Grep":
            let scope = input["path"].map { " en \(short($0))" } ?? ""
            return "Buscando «\(input["pattern"] ?? "")»\(scope)"
        case "Glob":
            let scope = input["path"].map { " en \(short($0))" } ?? ""
            return "Listando \(input["pattern"] ?? "")\(scope)"
        case "Bash":
            return input["command"].map { "Ejecutando \($0)" } ?? "Ejecutando un comando"
        default:
            return name
        }
    }

    func short(_ path: String) -> String {
        for root in roots where path == root.prefix || path.hasPrefix(root.prefix + "/") {
            let rest = path.dropFirst(root.prefix.count)
            return root.label + rest
        }
        let home = Paths.home.path
        if path.hasPrefix(home + "/") { return "~" + path.dropFirst(home.count) }
        return path
    }
}

struct AnswerAssembler {
    static let sourcesMarker = "```fuentes"
    static let questionPrefix = "PREGUNTA:"

    private(set) var question: String?
    private(set) var emitted = ""
    private(set) var sourcesText = ""
    private var pending = ""
    private var headerDone = false
    private var inSources = false

    mutating func feed(_ delta: String) -> String {
        if inSources {
            sourcesText += delta
            return ""
        }
        pending += delta
        if !headerDone {
            guard resolveHeader() else { return "" }
        }
        return drain(final: false)
    }

    mutating func finish() -> String {
        if !headerDone {
            headerDone = true
            if let parsed = Self.headerQuestion(pending) {
                question = parsed
                pending = ""
            }
        }
        return drain(final: true)
    }

    private mutating func resolveHeader() -> Bool {
        let stripped = pending.drop { $0.isWhitespace }
        if stripped.isEmpty { return false }
        let prefix = Self.questionPrefix
        let head = String(stripped.prefix(prefix.count)).uppercased()
        if prefix.hasPrefix(head) && head.count < prefix.count { return false }
        guard head == prefix else {
            headerDone = true
            return true
        }
        guard let newline = stripped.firstIndex(of: "\n") else { return false }
        question = Self.headerQuestion(String(stripped[..<newline]))
        pending = String(stripped[stripped.index(after: newline)...]).replacingOccurrences(of: "^\\s*\\n", with: "", options: .regularExpression)
        headerDone = true
        return true
    }

    private static func headerQuestion(_ text: String) -> String? {
        let trimmed = text.trimmed
        guard trimmed.uppercased().hasPrefix(questionPrefix) else { return nil }
        let question = String(trimmed.dropFirst(questionPrefix.count)).trimmed
        return question.isEmpty ? nil : question
    }

    private mutating func drain(final: Bool) -> String {
        if let range = pending.range(of: Self.sourcesMarker) {
            let before = String(pending[..<range.lowerBound])
            sourcesText += String(pending[range.upperBound...])
            pending = ""
            inSources = true
            emitted += before
            return before
        }
        var out = pending
        if !final {
            let hold = Self.markerPrefixLength(pending)
            out = String(pending.dropLast(hold))
            pending = String(pending.suffix(hold))
        } else {
            pending = ""
        }
        emitted += out
        return out
    }

    static func markerPrefixLength(_ text: String) -> Int {
        let marker = sourcesMarker
        for length in stride(from: min(marker.count - 1, text.count), through: 1, by: -1)
        where text.hasSuffix(String(marker.prefix(length))) {
            return length
        }
        return 0
    }

    var answer: String { emitted.trimmed }
}

struct AnswerSource: Codable, Equatable {
    var kind: String
    var label: String
    var pageId: Int?
    var path: String?
    var line: Int?
    var repo: String?
    var sha: String?
}

struct Answer: Codable, Equatable {
    var id: String
    var askedAt: Date
    var question: String
    var answer: String
    var found: Bool
    var sources: [AnswerSource]
}

struct SourcesBlock: Equatable {
    var question: String?
    var found: Bool?
    var sources: [AnswerSource]

    static let kinds: Set<String> = ["page", "file", "commit"]

    static func parse(_ text: String) -> SourcesBlock? {
        var body = text
        if let close = body.range(of: "```") { body = String(body[..<close.lowerBound]) }
        guard let start = body.firstIndex(of: "{"), let end = body.lastIndex(of: "}"), start < end,
              let object = (try? JSONSerialization.jsonObject(with: Data(String(body[start...end]).utf8))) as? [String: Any] else {
            return nil
        }
        let items = object["sources"] as? [[String: Any]] ?? []
        let sources = items.compactMap(source)
        let question = (object["question"] as? String)?.trimmed
        return SourcesBlock(question: question?.isEmpty == true ? nil : question,
                            found: object["found"] as? Bool, sources: sources)
    }

    private static func source(_ item: [String: Any]) -> AnswerSource? {
        guard let kind = (item["kind"] as? String)?.lowercased(), kinds.contains(kind) else { return nil }
        let pageId = (item["pageId"] as? Int) ?? (item["pageId"] as? String).flatMap { Int($0) }
        let line = (item["line"] as? Int) ?? (item["line"] as? String).flatMap { Int($0) }
        let path = (item["path"] as? String).flatMap { $0.trimmed.isEmpty ? nil : $0.trimmed }
        let repo = (item["repo"] as? String).flatMap { $0.trimmed.isEmpty ? nil : $0.trimmed }
        let sha = (item["sha"] as? String).flatMap { $0.trimmed.isEmpty ? nil : $0.trimmed }
        switch kind {
        case "page" where pageId == nil && path == nil: return nil
        case "file" where path == nil: return nil
        case "commit" where sha == nil: return nil
        default: break
        }
        var label = (item["label"] as? String)?.trimmed ?? ""
        if label.isEmpty {
            switch kind {
            case "page": label = pageId.map { "Página #\($0)" } ?? path ?? ""
            case "file": label = [path ?? "", line.map(String.init) ?? ""].filter { !$0.isEmpty }.joined(separator: ":")
            default: label = String((sha ?? "").prefix(10))
            }
        }
        return AnswerSource(kind: kind, label: label, pageId: pageId, path: path, line: line, repo: repo, sha: sha)
    }
}

enum AnswerBuilder {
    static let notDocumented = "no esta documentado"

    static func build(id: String, askedAt: Date, explicitQuestion: String?, assembler: AnswerAssembler) -> Answer {
        let block = SourcesBlock.parse(assembler.sourcesText)
        let text = assembler.answer
        let sources = block?.sources ?? []
        let missing = TextSimilarity.fold(text).contains(notDocumented)
        let found = !missing && (block?.found ?? !sources.isEmpty)
        let question = explicitQuestion ?? assembler.question ?? block?.question ?? ""
        return Answer(id: id, askedAt: askedAt, question: question, answer: text, found: found, sources: sources)
    }
}
