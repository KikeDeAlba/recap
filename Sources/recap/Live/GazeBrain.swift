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

    static let commitTimeout: TimeInterval = 10

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
                                              timeout: commitTimeout) else { return false }
            return result.ok
        }
    )
}

enum SecretScanner {
    static let cardChunkLength = 64
    static let cardChunkStride = 32
    static let cardWindow = 13...19
    static let cardGap = 1...5

    private static func compile(_ pattern: String, _ options: NSRegularExpression.Options = []) -> NSRegularExpression {
        try! NSRegularExpression(pattern: pattern, options: options)
    }

    static let email = compile(#"[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9.-]{1,255}\.[A-Za-z]{2,24}"#)

    static let atWindows: [String: (before: Int, after: Int)] = ["uri-credentials": (420, 1), "email": (64, 282)]

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
        ("basic-auth", compile(#"basic\s+[A-Za-z0-9+/]{16,}={0,2}"#, [.caseInsensitive])),
        ("uri-credentials", compile(#"[a-z][a-z0-9+.-]{0,20}://[^\s/:@]{1,64}:[^\s/@]{1,128}@"#, [.caseInsensitive])),
        ("credential", compile(
            #"(password|passwd|pwd|secret|token|api[_-]?key|client[_-]?secret|access[_-]?key|clave|contraseña|contrasena)"#
                + #"["']?\s*(:|=|(?<![A-Za-z0-9_])(is|es|was|era)(?![A-Za-z0-9_]))\s*\S+"#,
            [.caseInsensitive])),
        ("email", email),
    ]

    static func normalize(_ text: String) -> String {
        var output = String.UnicodeScalarView()
        for scalar in text.precomposedStringWithCompatibilityMapping.unicodeScalars {
            let properties = scalar.properties
            switch properties.generalCategory {
            case .format, .nonspacingMark:
                continue
            case .decimalNumber:
                if let value = properties.numericValue, value >= 0, value <= 9,
                   let digit = Unicode.Scalar(0x30 + UInt32(value)) {
                    output.append(digit)
                } else {
                    output.append(scalar)
                }
            default:
                output.append(properties.isWhitespace ? " " : scalar)
            }
        }
        return String(output)
    }

    static func reason(_ text: String) -> String? {
        let normalized = normalize(text)
        if containsCard(normalized) { return "card" }
        let length = normalized.utf16.count
        let ats = normalized.utf16.enumerated().compactMap { $0.element == 0x40 ? $0.offset : nil }
        return patterns.first { entry in
            ranges(for: entry.name, ats: ats, length: length).contains { range in
                entry.regex.firstMatch(in: normalized, range: range) != nil
            }
        }?.name
    }

    static func ranges(for name: String, ats: [Int], length: Int) -> [NSRange] {
        guard let window = atWindows[name] else { return [NSRange(location: 0, length: length)] }
        var merged: [NSRange] = []
        for at in ats {
            let lower = max(0, at - window.before)
            let upper = min(length, at + 1 + window.after)
            if let last = merged.last, lower <= NSMaxRange(last) {
                merged[merged.count - 1] = NSRange(location: last.location, length: upper - last.location)
            } else {
                merged.append(NSRange(location: lower, length: upper - lower))
            }
        }
        return merged
    }

    static func isDigit(_ scalar: Unicode.Scalar) -> Bool {
        scalar.value >= 0x30 && scalar.value <= 0x39
    }

    static func breaksSequence(_ scalar: Unicode.Scalar) -> Bool {
        switch scalar.properties.generalCategory {
        case .uppercaseLetter, .lowercaseLetter, .titlecaseLetter, .modifierLetter, .otherLetter, .decimalNumber: true
        default: false
        }
    }

    static func containsCard(_ normalized: String) -> Bool {
        var digits: [Int] = []
        var starts: [Int] = []
        var gap = 0
        var gapBroken = false
        for scalar in normalized.unicodeScalars {
            if isDigit(scalar) {
                if digits.isEmpty {
                    starts.append(0)
                } else if gap > 0 {
                    if gapBroken || !cardGap.contains(gap) {
                        if sequenceHasCard(digits, starts: starts) { return true }
                        digits.removeAll(keepingCapacity: true)
                        starts.removeAll(keepingCapacity: true)
                    }
                    starts.append(digits.count)
                }
                gap = 0
                gapBroken = false
                digits.append(Int(scalar.value - 0x30))
            } else if !digits.isEmpty && !gapBroken {
                gap += 1
                if gap > cardGap.upperBound || breaksSequence(scalar) { gapBroken = true }
            }
        }
        return sequenceHasCard(digits, starts: starts)
    }

    static func sequenceHasCard(_ digits: [Int], starts: [Int]) -> Bool {
        guard digits.count >= cardWindow.lowerBound else { return false }
        let size = digits.count + 1
        var plain = [Int](repeating: 0, count: size * 2)
        var doubled = [Int](repeating: 0, count: size * 2)
        for (index, digit) in digits.enumerated() {
            let twice = digit * 2
            let own = (index % 2) * size
            let other = size - own
            plain[own + index + 1] = plain[own + index] + digit
            plain[other + index + 1] = plain[other + index]
            doubled[own + index + 1] = doubled[own + index] + (twice > 9 ? twice - 9 : twice)
            doubled[other + index + 1] = doubled[other + index]
        }
        let passes = { (start: Int, end: Int) -> Bool in
            let kept = ((end - 1) % 2) * size
            let flipped = size - kept
            let sum = plain[kept + end] - plain[kept + start] + doubled[flipped + end] - doubled[flipped + start]
            return sum % 10 == 0
        }
        var first = 0
        var chunk = 0
        while chunk < digits.count {
            let chunkEnd = min(chunk + cardChunkLength, digits.count)
            while first < starts.count && starts[first] < chunk { first += 1 }
            var index = first
            while index < starts.count && starts[index] < chunk + cardChunkStride {
                let start = starts[index]
                for length in cardWindow where start + length <= chunkEnd {
                    if passes(start, start + length) { return true }
                }
                index += 1
            }
            chunk += cardChunkStride
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
        var sum = 0
        var doubles = false
        for value in values.reversed() {
            let term = doubles ? value * 2 : value
            sum += term > 9 ? term - 9 : term
            doubles.toggle()
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
        if let question = question.map(trim), !question.isEmpty { return question }
        let text = trim(LiveTranscript.window(segments, seconds: queryWindowSeconds).map { trim($0.text) }.filter { !$0.isEmpty }
            .joined(separator: " "))
        let tail = trim(String(String.UnicodeScalarView(text.unicodeScalars.suffix(queryLength))))
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
        guard let query = query.map(trim), !query.isEmpty,
              let response = try? gaze.invoke(searchArguments(project: project, query: query), stdin: nil),
              response.ok, let items = response.data as? [Any] else { return [] }
        let notes = Array(items.compactMap { ($0 as? [String: Any]).flatMap(note) }.filter { validId($0.id) }.prefix(shownNotes))
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
        guard let id = noteId(item["id"]).map(trim), !id.isEmpty else { return nil }
        return BrainNote(id: id, title: trim(item["title"] as? String ?? ""), kind: item["kind"] as? String ?? "",
                         project: item["project"] as? String, snippet: collapse(item["snippet"] as? String ?? ""),
                         score: (item["score"] as? NSNumber)?.doubleValue)
    }

    static func noteId(_ value: Any?) -> String? {
        if let text = value as? String { return text }
        guard let number = value as? NSNumber, CFGetTypeID(number) != CFBooleanGetTypeID() else { return nil }
        if CFNumberIsFloatType(number) {
            let double = number.doubleValue
            guard double.isFinite, double.rounded() == double, abs(double) < 9.2e18 else { return nil }
            return String(Int64(double))
        }
        return number.stringValue
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
        let body = cut(trim(multiLine(note.body ?? note.snippet)), to: bodyLength)
        guard !body.isEmpty else { return header }
        let lines = body.unicodeScalars.split(separator: "\n", omittingEmptySubsequences: false)
            .map { "    " + String(String.UnicodeScalarView($0)) }
        return ([header] + lines).joined(separator: "\n")
    }

    static func escapeAngles(_ text: String) -> String {
        String(String.UnicodeScalarView(text.unicodeScalars.map { scalar -> Unicode.Scalar in
            switch scalar {
            case "<": "\u{2039}"
            case ">": "\u{203A}"
            default: scalar
            }
        }))
    }

    static func singleLine(_ text: String) -> String {
        trim(scalars(collapseWhitespace(escapeAngles(text))) { !isControl($0) })
    }

    static let whitespace: Set<UInt32> = Set([0x09, 0x0A, 0x0B, 0x0C, 0x0D, 0x20, 0xA0, 0x1680, 0x2028, 0x2029, 0x202F, 0x205F,
                                              0x3000, 0xFEFF] + Array(0x2000...0x200A))

    static func isWhitespace(_ scalar: Unicode.Scalar) -> Bool {
        whitespace.contains(scalar.value)
    }

    static func isControl(_ scalar: Unicode.Scalar) -> Bool {
        scalar.properties.generalCategory == .control
    }

    static func isTrimmed(_ scalar: Unicode.Scalar) -> Bool {
        isWhitespace(scalar) || scalar.value == 0x85
    }

    static func trim(_ text: String) -> String {
        let view = text.unicodeScalars
        guard let first = view.firstIndex(where: { !isTrimmed($0) }),
              let last = view.lastIndex(where: { !isTrimmed($0) }) else { return "" }
        return String(String.UnicodeScalarView(view[first...last]))
    }

    static func collapseWhitespace(_ text: String) -> String {
        var output = String.UnicodeScalarView()
        var inRun = false
        for scalar in text.unicodeScalars {
            if isWhitespace(scalar) {
                if !inRun { output.append(" ") }
                inRun = true
            } else {
                output.append(scalar)
                inRun = false
            }
        }
        return String(output)
    }

    static func multiLine(_ text: String) -> String {
        scalars(escapeAngles(text)) { $0 == "\n" || $0 == "\t" || !isControl($0) }
    }

    static func scalars(_ text: String, where keep: (Unicode.Scalar) -> Bool) -> String {
        String(String.UnicodeScalarView(text.unicodeScalars.filter(keep)))
    }

    static func collapse(_ text: String) -> String {
        trim(collapseWhitespace(text))
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
            ?? source.path.flatMap { path in path.isEmpty ? nil : context.pages.first { !$0.relPath.isEmpty && $0.relPath == path } }
    }

    static func hasNul(_ source: AnswerSource) -> Bool {
        [source.path, source.repo, source.label, source.sha].contains { $0?.unicodeScalars.contains("\0") == true }
    }

    static func verifies(_ source: AnswerSource, context: ProjectContext, checks: SourceChecks) -> Bool {
        guard !hasNul(source) else { return false }
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
        return "\(trim(answer.answer))\n\nFuentes:\n\(sources)\n\n"
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
