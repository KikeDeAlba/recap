import Foundation

struct BrainNote: Encodable, Equatable {
    var id: String
    var title: String
    var kind: String
    var project: String?
    var snippet: String
    var score: Double?
    var body: String? = nil

    private enum CodingKeys: String, CodingKey {
        case id, title, kind, project, snippet, score, body
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(id, forKey: .id)
        try container.encode(title, forKey: .title)
        try container.encode(kind, forKey: .kind)
        try container.encode(project ?? "", forKey: .project)
        try container.encode(snippet, forKey: .snippet)
        try container.encode(score ?? 0, forKey: .score)
        try container.encodeIfPresent(body, forKey: .body)
    }
}

struct KitTool: Equatable {
    var name: String
    var version: String
    var bin: [String]
    var capabilities: [String]
}

enum KitRegistry {
    static func directory(environment: [String: String] = ProcessInfo.processInfo.environment) -> URL {
        if let override = environment["KIT_REGISTRY_DIR"], !override.isEmpty { return URL(fileURLWithPath: override) }
        let configHome = environment["XDG_CONFIG_HOME"].flatMap { $0.isEmpty ? nil : URL(fileURLWithPath: $0) }
            ?? Paths.home.appending(path: ".config")
        return configHome.appending(path: "kikedealba").appending(path: "tools.d")
    }

    static func find(_ name: String, capabilities: [String] = [],
                     environment: [String: String] = ProcessInfo.processInfo.environment) -> KitTool? {
        let file = directory(environment: environment).appending(path: "\(name).json")
        guard let data = try? Data(contentsOf: file),
              let object = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
              object["manifestVersion"] as? Int == 1,
              let bin = object["bin"] as? [String], !bin.isEmpty,
              let available = object["capabilities"] as? [String] else { return nil }
        let installed = bin.allSatisfy { !$0.hasPrefix("/") || FileManager.default.fileExists(atPath: $0) }
        guard installed, capabilities.allSatisfy(available.contains) else { return nil }
        return KitTool(name: object["name"] as? String ?? name, version: object["version"] as? String ?? "",
                       bin: bin, capabilities: available)
    }
}

protocol GazeCalling {
    var command: String { get }
    func invoke(_ arguments: [String], stdin: Data?) throws -> BitaResponse
}

struct GazeClient: GazeCalling {
    static let capabilities = ["memory.search", "memory.write"]
    static let timeout: TimeInterval = 60

    let bin: [String]
    var timeout: TimeInterval = GazeClient.timeout

    var command: String { bin.joined(separator: " ") }

    static func find(environment: [String: String] = ProcessInfo.processInfo.environment) -> GazeClient? {
        guard environment["RECAP_NO_GAZE"] != "1",
              let tool = KitRegistry.find("gaze", capabilities: capabilities, environment: environment) else { return nil }
        return GazeClient(bin: tool.bin)
    }

    func invoke(_ arguments: [String], stdin: Data?) throws -> BitaResponse {
        guard let executable = bin.first else { throw RecapError("DEPENDENCY_MISSING", "gaze not found") }
        var environment = ProcessInfo.processInfo.environment
        environment["KIT_NO_EVENTS"] = "1"
        let result = try Shell.run(URL(fileURLWithPath: executable), Array(bin.dropFirst()) + arguments, stdin: stdin,
                                   environment: environment, cwd: URL(fileURLWithPath: "/"), timeout: timeout)
        return BitaResponse(stdout: result.stdout, stderr: result.stderr, status: result.status)
    }
}

struct SourceChecks {
    var resolve: (String) -> String?
    var lineCount: (String) -> Int?
    var commitExists: (_ repo: String, _ sha: String) -> Bool

    static let live = SourceChecks(
        resolve: { path in
            guard let resolved = realpath(path, nil) else { return nil }
            defer { free(resolved) }
            return String(cString: resolved)
        },
        lineCount: { path in
            guard (try? FileManager.default.attributesOfItem(atPath: path))?[.type] as? FileAttributeType == .typeRegular,
                  let data = FileManager.default.contents(atPath: path) else { return nil }
            let newlines = data.reduce(0) { $1 == 0x0A ? $0 + 1 : $0 }
            return newlines + (data.last.map { $0 == 0x0A ? 0 : 1 } ?? 0)
        },
        commitExists: { repo, sha in
            let git = Shell.which("git") ?? URL(fileURLWithPath: "/usr/bin/git")
            guard let result = try? Shell.run(git, ["-C", repo, "cat-file", "-e", "\(sha)^{commit}"],
                                              timeout: GazeClient.timeout) else { return false }
            return result.ok
        }
    )
}

enum SecretScanner {
    static let patterns: [(reason: String, pattern: String, options: NSRegularExpression.Options)] = [
        ("aws key", "(AKIA|ASIA)[0-9A-Z]{16}", []),
        ("github token", "gh[pousr]_[A-Za-z0-9]{36,}", []),
        ("gitlab token", "glpat-[A-Za-z0-9_-]{20,}", []),
        ("api key", "sk-[A-Za-z0-9_-]{20,}", []),
        ("slack token", "xox[abprs]-[A-Za-z0-9-]{10,}", []),
        ("private key", "-----BEGIN [A-Z ]*PRIVATE KEY-----", []),
        ("credential", #"(password|passwd|pwd|secret|token|api[_-]?key)\s*[:=]\s*\S+"#, [.caseInsensitive]),
        ("email", #"[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}"#, []),
    ]

    static let cardPattern = "(?<![0-9])[0-9](?:[ -]?[0-9]){12,18}(?![0-9])"

    static func reason(_ text: String) -> String? {
        if containsCard(text) { return "card number" }
        let range = NSRange(text.startIndex..., in: text)
        for entry in patterns {
            guard let regex = try? NSRegularExpression(pattern: entry.pattern, options: entry.options) else { continue }
            if regex.firstMatch(in: text, range: range) != nil { return entry.reason }
        }
        return nil
    }

    static func containsCard(_ text: String) -> Bool {
        guard let regex = try? NSRegularExpression(pattern: cardPattern) else { return false }
        return regex.matches(in: text, range: NSRange(text.startIndex..., in: text)).contains { match in
            guard let range = Range(match.range, in: text) else { return false }
            return luhn(String(text[range].filter { $0.isASCII && $0.isNumber }))
        }
    }

    static func luhn(_ digits: String) -> Bool {
        let values = digits.compactMap(\.wholeNumberValue)
        guard (13...19).contains(values.count), values.count == digits.count else { return false }
        let sum = values.reversed().enumerated().reduce(0) { total, item in
            guard item.offset % 2 == 1 else { return total + item.element }
            let doubled = item.element * 2
            return total + (doubled > 9 ? doubled - 9 : doubled)
        }
        return sum % 10 == 0
    }
}

enum GazeBrain {
    static let searchLimit = 5
    static let shownNotes = 3
    static let queryWindowSeconds = 30
    static let queryLength = 300
    static let bodyLength = 1200
    static let titleLength = 200
    static let unavailable = "  (el cerebro no está disponible)"
    static let empty = "  (sin notas en el cerebro)"
    static let idPattern = "^[A-Za-z0-9_-]+$"

    static func query(question: String?, segments: [Segment]) -> String? {
        if let question = question?.trimmed, !question.isEmpty { return question }
        let text = LiveTranscript.window(segments, seconds: queryWindowSeconds).map(\.text.trimmed).filter { !$0.isEmpty }
            .joined(separator: " ")
        let tail = String(text.suffix(queryLength)).trimmed
        return tail.isEmpty ? nil : tail
    }

    static func searchArguments(project: String, query: String) -> [String] {
        ["search", "--project", project, "--limit", String(searchLimit), "--json", "--", query]
    }

    static func lookup(_ gaze: GazeCalling, project: String, query: String?) -> [BrainNote] {
        guard let query = query?.trimmed, !query.isEmpty,
              let response = try? gaze.invoke(searchArguments(project: project, query: query), stdin: nil),
              response.ok, let items = response.data as? [[String: Any]] else { return [] }
        let notes = Array(items.compactMap(note).filter { $0.id.range(of: idPattern, options: .regularExpression) != nil }
            .prefix(shownNotes))
        var bodies = [String?](repeating: nil, count: notes.count)
        let lock = NSLock()
        DispatchQueue.concurrentPerform(iterations: notes.count) { index in
            let body = show(gaze, id: notes[index].id)
            lock.withLock { bodies[index] = body }
        }
        return notes.enumerated().map { index, note in
            var full = note
            full.body = bodies[index] ?? note.snippet
            return full
        }
    }

    static func show(_ gaze: GazeCalling, id: String) -> String? {
        guard let response = try? gaze.invoke(["show", id, "--json"], stdin: nil), response.ok,
              let data = response.data as? [String: Any], let body = data["body"] as? String else { return nil }
        return body
    }

    static func note(_ item: [String: Any]) -> BrainNote? {
        let id = ((item["id"] as? String) ?? (item["id"] as? Int).map(String.init))?.trimmed
        guard let id, !id.isEmpty else { return nil }
        let snippet = (item["snippet"] as? String ?? "").replacingOccurrences(of: "\\s+", with: " ", options: .regularExpression).trimmed
        return BrainNote(id: id, title: (item["title"] as? String ?? "").trimmed, kind: item["kind"] as? String ?? "",
                         project: item["project"] as? String, snippet: snippet,
                         score: (item["score"] as? NSNumber)?.doubleValue)
    }

    static func render(_ context: ProjectContext) -> String {
        guard context.gaze != nil, context.project != nil else { return unavailable }
        guard !context.brain.isEmpty else { return empty }
        return context.brain.map(renderNote).joined(separator: "\n")
    }

    static func renderNote(_ note: BrainNote) -> String {
        let header = "  - [\(note.id)] \(note.title) (\(note.kind))"
        let body = cut((note.body ?? note.snippet).trimmed, to: bodyLength)
        guard !body.isEmpty else { return header }
        return ([header] + body.components(separatedBy: "\n").map { "    \($0)" }).joined(separator: "\n")
    }

    static func cut(_ text: String, to length: Int) -> String {
        text.count > length ? String(text.prefix(length)) + "…" : text
    }

    static func noteTitle(_ question: String) -> String {
        cut(question.replacingOccurrences(of: "\\s+", with: " ", options: .regularExpression).trimmed, to: titleLength)
    }

    static func verifies(_ source: AnswerSource, context: ProjectContext, checks: SourceChecks) -> Bool {
        switch source.kind {
        case "page":
            let byId = source.pageId.map { id in context.pages.contains { $0.pageId == id } } ?? false
            let byPath = source.path.map { path in context.pages.contains { $0.relPath == path } } ?? false
            return byId || byPath
        case "file":
            guard let path = source.path else { return false }
            let absolute = path.hasPrefix("/") ? path : context.docsRoot.map { URL(fileURLWithPath: $0).appending(path: path).path }
            guard let absolute, let resolved = checks.resolve(absolute) else { return false }
            let roots = ([context.docsRoot].compactMap { $0 } + context.existingRepos.map(\.path)).compactMap(checks.resolve)
            guard roots.contains(where: { resolved == $0 || resolved.hasPrefix($0.hasSuffix("/") ? $0 : $0 + "/") }),
                  let count = checks.lineCount(resolved) else { return false }
            return source.line.map { $0 >= 1 && $0 <= count } ?? true
        case "commit":
            guard let sha = source.sha, sha.range(of: "^[0-9a-fA-F]{4,40}$", options: .regularExpression) != nil,
                  let repo = source.repo else { return false }
            let resolvedRepo = checks.resolve(repo)
            guard let match = context.existingRepos.first(where: { candidate in
                candidate.path == repo || (resolvedRepo != nil && checks.resolve(candidate.path) == resolvedRepo)
            }) else { return false }
            return checks.commitExists(match.path, sha)
        default:
            return false
        }
    }

    static func eligible(_ answer: Answer) -> Bool {
        answer.found && !answer.sources.isEmpty && !answer.sources.contains { $0.kind == "note" }
    }

    static func unverifiedSource(_ answer: Answer, context: ProjectContext, checks: SourceChecks) -> AnswerSource? {
        answer.sources.first { !verifies($0, context: context, checks: checks) }
    }

    static func shouldRemember(_ answer: Answer, context: ProjectContext, checks: SourceChecks) -> Bool {
        eligible(answer) && unverifiedSource(answer, context: context, checks: checks) == nil
    }

    static func sensitiveReason(_ answer: Answer, title: String) -> String? {
        [answer.question, title, answer.answer].lazy.compactMap(SecretScanner.reason).first
    }

    static func sourceLine(_ source: AnswerSource) -> String {
        switch source.kind {
        case "page":
            let detail = [source.pageId.map { "#\($0)" }, source.path].compactMap { $0 }.joined(separator: ", ")
            return "«\(source.label)»" + (detail.isEmpty ? "" : " (\(detail))")
        case "file":
            let location = (source.path ?? source.label) + (source.line.map { ":\($0)" } ?? "")
            return location + (source.repo.map { " (\($0))" } ?? "")
        case "commit":
            let head = [source.sha, source.label].compactMap { $0 }.joined(separator: " ")
            return head + (source.repo.map { " (\($0))" } ?? "")
        default:
            return source.label
        }
    }

    static func noteBody(answer: Answer, meeting: Meeting) -> String {
        let sources = answer.sources.map(sourceLine).map { "- \($0)" }.joined(separator: "\n")
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.dateFormat = "yyyy-MM-dd"
        let title = meeting.bitaEntry?.title ?? meeting.title
        return "\(answer.answer.trimmed)\n\nFuentes:\n\(sources)\n\n"
            + "Generada por recap a partir de la reunión «\(title)» (\(formatter.string(from: meeting.createdAt))); sin revisión humana."
    }

    static func rememberArguments(project: String, title: String) -> [String] {
        ["remember", "--project", project, "--kind", "fact", "--title=\(title)", "--json", "-"]
    }

    static func remember(_ gaze: GazeCalling, answer: Answer, project: String, meeting: Meeting, context: ProjectContext,
                         checks: SourceChecks = .live, log: (String) -> Void) {
        let title = noteTitle(answer.question)
        guard eligible(answer), !title.isEmpty else { return }
        if let reason = sensitiveReason(answer, title: title) {
            log("gaze: not saved (\(reason))")
            return
        }
        if let source = unverifiedSource(answer, context: context, checks: checks) {
            log("gaze: not saved (unverified \(source.kind) source «\(source.label)»)")
            return
        }
        do {
            let response = try gaze.invoke(rememberArguments(project: project, title: title),
                                           stdin: Data(noteBody(answer: answer, meeting: meeting).utf8))
            if !response.ok { log("gaze remember failed: \(response.errorMessage ?? "no reason given")") }
        } catch {
            log("gaze remember failed: \(error)")
        }
    }
}
