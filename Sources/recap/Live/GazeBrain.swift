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
    static let lookupTimeout: TimeInterval = 10
    static let rememberTimeout: TimeInterval = 60

    let bin: [String]
    var timeout: TimeInterval? = nil

    var command: String { bin.joined(separator: " ") }

    static func find(environment: [String: String] = ProcessInfo.processInfo.environment) -> GazeClient? {
        guard environment["RECAP_NO_GAZE"] != "1",
              let tool = KitRegistry.find("gaze", capabilities: capabilities, environment: environment) else { return nil }
        return GazeClient(bin: tool.bin)
    }

    static func environment(_ base: [String: String] = ProcessInfo.processInfo.environment) -> [String: String] {
        var environment = base
        environment["KIT_NO_EVENTS"] = "1"
        environment["BITA_NO_HOOKS"] = "1"
        return environment
    }

    func timeout(for arguments: [String]) -> TimeInterval {
        timeout ?? (arguments.first == "remember" ? Self.rememberTimeout : Self.lookupTimeout)
    }

    func invoke(_ arguments: [String], stdin: Data?) throws -> BitaResponse {
        guard let executable = bin.first else { throw RecapError("DEPENDENCY_MISSING", "gaze not found") }
        let result = try Shell.run(URL(fileURLWithPath: executable), Array(bin.dropFirst()) + arguments, stdin: stdin,
                                   environment: Self.environment(), cwd: URL(fileURLWithPath: "/"),
                                   timeout: timeout(for: arguments))
        return BitaResponse(stdout: result.stdout, stderr: result.stderr, status: result.status)
    }
}

struct SourceChecks {
    var resolve: (String) -> String?
    var isFile: (String) -> Bool
    var lineCount: (String) -> Int?
    var commitExists: (_ repo: String, _ sha: String) -> Bool

    static let live = SourceChecks(
        resolve: { path in
            guard let resolved = realpath(path, nil) else { return nil }
            defer { free(resolved) }
            return String(cString: resolved)
        },
        isFile: { path in
            (try? FileManager.default.attributesOfItem(atPath: path))?[.type] as? FileAttributeType == .typeRegular
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
                                              timeout: GazeClient.rememberTimeout) else { return false }
            return result.ok
        }
    )
}

enum SecretScanner {
    static let cardRunLimit = 64
    static let cardWindow = 13...19

    private static func compile(_ pattern: String, _ options: NSRegularExpression.Options = []) -> NSRegularExpression {
        try! NSRegularExpression(pattern: pattern, options: options)
    }

    static let cardRun = compile(#"[0-9](?:[\s./\- ]{0,3}[0-9]){0,63}"#)

    static let email = compile(#"[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9.-]{1,255}\.[A-Za-z]{2,24}"#)

    static let requiresAt: Set<String> = ["uri-credentials", "email"]

    static let patterns: [(name: String, regex: NSRegularExpression)] = [
        ("aws-key", compile("(AKIA|ASIA)[0-9A-Z]{16}")),
        ("github-token", compile("gh[pousr]_[A-Za-z0-9]{36,}")),
        ("github-token", compile("github_pat_[A-Za-z0-9_]{20,}")),
        ("gitlab-token", compile("glpat-[A-Za-z0-9_-]{20,}")),
        ("api-key", compile("sk-[A-Za-z0-9_-]{20,}")),
        ("api-key", compile("(sk|pk|rk)_(live|test)_[A-Za-z0-9]{10,}")),
        ("slack-token", compile("xox[abprs]-[A-Za-z0-9-]{10,}")),
        ("npm-token", compile("npm_[A-Za-z0-9]{36}")),
        ("private-key", compile("-----BEGIN [A-Z ]*PRIVATE KEY-----")),
        ("jwt", compile(#"eyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}"#)),
        ("bearer", compile(#"bearer\s+[A-Za-z0-9._~+/-]{16,}=*"#, [.caseInsensitive])),
        ("uri-credentials", compile(#"[a-z][a-z0-9+.-]{0,20}://[^\s/:@]{1,64}:[^\s/@]{1,128}@"#, [.caseInsensitive])),
        ("credential", compile(#"(password|passwd|pwd|secret|token|api[_-]?key|client[_-]?secret|access[_-]?key)["']?\s*(:|=|\bis\b)\s*\S+"#,
                               [.caseInsensitive])),
        ("email", email),
    ]

    static func reason(_ text: String) -> String? {
        let normalized = text.precomposedStringWithCompatibilityMapping
        if containsCard(normalized) { return "card" }
        let range = NSRange(normalized.startIndex..., in: normalized)
        let hasAt = normalized.contains("@")
        return patterns.first { entry in
            (hasAt || !requiresAt.contains(entry.name)) && entry.regex.firstMatch(in: normalized, range: range) != nil
        }?.name
    }

    static func containsCard(_ text: String) -> Bool {
        cardRun.matches(in: text, range: NSRange(text.startIndex..., in: text)).contains { match in
            guard let range = Range(match.range, in: text) else { return false }
            var digits: [Int] = []
            var starts: Set<Int> = []
            var afterSeparator = true
            for scalar in text[range].unicodeScalars {
                guard scalar.value >= 0x30 && scalar.value <= 0x39 else {
                    afterSeparator = true
                    continue
                }
                if afterSeparator { starts.insert(digits.count) }
                afterSeparator = false
                digits.append(Int(scalar.value - 0x30))
            }
            return luhnWindow(Array(digits.prefix(cardRunLimit)), starts: starts)
        }
    }

    static func luhnWindow(_ digits: [Int], starts: Set<Int>) -> Bool {
        for start in starts.sorted() {
            for length in cardWindow where start + length <= digits.count {
                if luhn(digits[start..<(start + length)]) { return true }
            }
        }
        return false
    }

    static func luhn(_ digits: String) -> Bool {
        let values = digits.compactMap(\.wholeNumberValue)
        guard values.count == digits.count else { return false }
        return luhn(values[...])
    }

    static func luhn(_ values: ArraySlice<Int>) -> Bool {
        guard cardWindow.contains(values.count) else { return false }
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
    static let kindLength = 32
    static let answerLength = 8000
    static let unavailable = "  (el cerebro no está disponible)"
    static let empty = "  (sin notas en el cerebro)"
    static let idPattern = "^[A-Za-z0-9][A-Za-z0-9_-]*$"

    static func query(question: String?, segments: [Segment]) -> String? {
        if let question = question?.trimmed, !question.isEmpty { return question }
        let text = LiveTranscript.window(segments, seconds: queryWindowSeconds).map(\.text.trimmed).filter { !$0.isEmpty }
            .joined(separator: " ")
        let tail = String(String.UnicodeScalarView(text.unicodeScalars.suffix(queryLength))).trimmed
        return tail.isEmpty ? nil : tail
    }

    static func searchArguments(project: String, query: String) -> [String] {
        ["search", "--project=\(project)", "--limit", String(searchLimit), "--json", "--", query]
    }

    static func showArguments(id: String) -> [String] {
        ["show", "--json", "--", id]
    }

    static func rememberArguments(project: String, title: String) -> [String] {
        ["remember", "--project=\(project)", "--kind", "fact", "--title=\(title)", "--json", "-"]
    }

    static func validId(_ id: String) -> Bool {
        id.range(of: idPattern, options: .regularExpression) != nil
    }

    static func lookup(_ gaze: GazeCalling, project: String, query: String?) -> [BrainNote] {
        guard let query = query?.trimmed, !query.isEmpty,
              let response = try? gaze.invoke(searchArguments(project: project, query: query), stdin: nil),
              response.ok, let items = response.data as? [[String: Any]] else { return [] }
        let notes = Array(items.compactMap(note).filter { validId($0.id) }.prefix(shownNotes))
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
        guard let response = try? gaze.invoke(showArguments(id: id), stdin: nil), response.ok,
              let data = response.data as? [String: Any], let body = data["body"] as? String else { return nil }
        return body
    }

    static func note(_ item: [String: Any]) -> BrainNote? {
        let id = ((item["id"] as? String) ?? (item["id"] as? Int).map(String.init))?.trimmed
        guard let id, !id.isEmpty else { return nil }
        return BrainNote(id: id, title: (item["title"] as? String ?? "").trimmed, kind: item["kind"] as? String ?? "",
                         project: item["project"] as? String, snippet: collapse(item["snippet"] as? String ?? ""),
                         score: (item["score"] as? NSNumber)?.doubleValue)
    }

    static func available(_ context: ProjectContext) -> Bool {
        context.gaze != nil && context.project != nil
    }

    static func renderedNotes(_ context: ProjectContext) -> [String] {
        available(context) ? context.brain.compactMap(renderNote) : []
    }

    static func notesUsed(_ context: ProjectContext) -> Bool {
        !renderedNotes(context).isEmpty
    }

    static func render(_ context: ProjectContext) -> String {
        guard available(context) else { return unavailable }
        let notes = renderedNotes(context)
        return notes.isEmpty ? empty : notes.joined(separator: "\n")
    }

    static func renderNote(_ note: BrainNote) -> String? {
        let id = singleLine(note.id)
        guard validId(id) else { return nil }
        let header = "  - [\(id)] \(cut(singleLine(note.title), to: titleLength)) (\(cut(singleLine(note.kind), to: kindLength)))"
        let body = cut(multiLine(note.body ?? note.snippet).trimmed, to: bodyLength)
        guard !body.isEmpty else { return header }
        return ([header] + body.components(separatedBy: "\n").map { "    \($0)" }).joined(separator: "\n")
    }

    static func escapeAngles(_ text: String) -> String {
        text.replacingOccurrences(of: "<", with: "\u{2039}").replacingOccurrences(of: ">", with: "\u{203A}")
    }

    static func singleLine(_ text: String) -> String {
        let spaced = escapeAngles(text).replacingOccurrences(of: whitespaceRun, with: " ", options: .regularExpression)
        return scalars(spaced) { $0.properties.generalCategory != .control }.trimmingCharacters(in: CharacterSet(charactersIn: " "))
    }

    static let whitespaceRun = "[\\t\\n\\u000B\\f\\r \\u00A0\\u1680\\u2000-\\u200A\\u2028\\u2029\\u202F\\u205F\\u3000\\uFEFF]+"

    static func multiLine(_ text: String) -> String {
        scalars(escapeAngles(text)) { $0 == "\n" || $0 == "\t" || $0.properties.generalCategory != .control }
    }

    static func scalars(_ text: String, where keep: (Unicode.Scalar) -> Bool) -> String {
        String(String.UnicodeScalarView(text.unicodeScalars.filter(keep)))
    }

    static func collapse(_ text: String) -> String {
        text.replacingOccurrences(of: "\\s+", with: " ", options: .regularExpression).trimmed
    }

    static func length(_ text: String) -> Int {
        text.unicodeScalars.count
    }

    static func cut(_ text: String, to limit: Int) -> String {
        guard length(text) > limit else { return text }
        return String(String.UnicodeScalarView(text.unicodeScalars.prefix(limit))) + "…"
    }

    static func noteTitle(_ question: String) -> String {
        cut(collapse(question), to: titleLength)
    }

    static func page(for source: AnswerSource, context: ProjectContext) -> PageRef? {
        source.pageId.flatMap { id in context.pages.first { $0.pageId == id } }
            ?? source.path.flatMap { path in context.pages.first { $0.relPath == path } }
    }

    static func verifies(_ source: AnswerSource, context: ProjectContext, checks: SourceChecks) -> Bool {
        guard ![source.path, source.repo].contains(where: { $0?.contains("\0") == true }) else { return false }
        switch source.kind {
        case "page":
            return page(for: source, context: context) != nil
        case "file":
            guard let path = source.path else { return false }
            let absolute = path.hasPrefix("/") ? path : context.docsRoot.map { URL(fileURLWithPath: $0).appending(path: path).path }
            guard let absolute, let resolved = checks.resolve(absolute) else { return false }
            let roots = ([context.docsRoot].compactMap { $0 } + context.existingRepos.map(\.path)).compactMap(checks.resolve)
            guard roots.contains(where: { resolved == $0 || resolved.hasPrefix($0.hasSuffix("/") ? $0 : $0 + "/") }),
                  checks.isFile(resolved) else { return false }
            guard let line = source.line else { return true }
            guard let count = checks.lineCount(resolved) else { return false }
            return line >= 1 && line <= count
        case "commit":
            guard let sha = source.sha, sha.range(of: "^[0-9a-fA-F]{4,40}$", options: .regularExpression) != nil,
                  let repo = source.repo, context.existingRepos.contains(where: { $0.path == repo }) else { return false }
            return checks.commitExists(repo, sha)
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
        !notesUsed(context) && eligible(answer) && length(answer.answer) <= answerLength
            && unverifiedSource(answer, context: context, checks: checks) == nil
    }

    static func sensitiveReason(title: String, body: String) -> String? {
        [title, body].lazy.compactMap(SecretScanner.reason).first
    }

    static func sourceLine(_ source: AnswerSource, context: ProjectContext) -> String {
        switch source.kind {
        case "page":
            let page = page(for: source, context: context)
            let detail = [(page?.pageId ?? source.pageId).map { "#\($0)" }, page?.relPath ?? source.path]
                .compactMap { $0 }.filter { !$0.isEmpty }.joined(separator: ", ")
            return "«\(page?.title ?? "")»" + (detail.isEmpty ? "" : " (\(detail))")
        case "file":
            let location = (source.path ?? "") + (source.line.map { ":\($0)" } ?? "")
            return location + (source.repo.map { " (\($0))" } ?? "")
        case "commit":
            return (source.sha ?? "") + (source.repo.map { " (\($0))" } ?? "")
        default:
            return ""
        }
    }

    static func noteBody(answer: Answer, meeting: Meeting, context: ProjectContext) -> String {
        let sources = answer.sources.map { "- \(sourceLine($0, context: context))" }.joined(separator: "\n")
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.dateFormat = "yyyy-MM-dd"
        let title = collapse(meeting.bitaEntry?.title ?? meeting.title)
        return "\(answer.answer.trimmed)\n\nFuentes:\n\(sources)\n\n"
            + "Generada por recap a partir de la reunión «\(title)» (\(formatter.string(from: meeting.createdAt))); sin revisión humana."
    }

    static func remember(_ gaze: GazeCalling, answer: Answer, project: String, meeting: Meeting, context: ProjectContext,
                         checks: SourceChecks = .live, log: (String) -> Void) {
        if notesUsed(context) {
            log("gaze: not saved (brain notes were used)")
            return
        }
        let title = noteTitle(answer.question)
        guard eligible(answer), !title.isEmpty else { return }
        if length(answer.answer) > answerLength {
            log("gaze: not saved (answer too long)")
            return
        }
        let body = noteBody(answer: answer, meeting: meeting, context: context)
        if let reason = sensitiveReason(title: title, body: body) {
            log("gaze: not saved (sensitive content: \(reason))")
            return
        }
        if let source = unverifiedSource(answer, context: context, checks: checks) {
            log("gaze: not saved (unverified \(source.kind) source «\(source.label)»)")
            return
        }
        do {
            let response = try gaze.invoke(rememberArguments(project: project, title: title), stdin: Data(body.utf8))
            if !response.ok { log("gaze remember failed: \(response.errorMessage ?? "no reason given")") }
        } catch {
            log("gaze remember failed: \(error)")
        }
    }
}
