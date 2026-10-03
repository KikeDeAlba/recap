import Foundation

struct WrapupPlan: Codable, Equatable {
    struct Item: Codable, Equatable {
        let kind: String
        let title: String
        let body: String?
    }

    let title: String
    let project: String?
    let pageTitle: String
    let pageMarkdown: String
    let backlog: [Item]
}

enum WrapupParser {
    static let forbiddenSections = ["pendiente", "proximos pasos", "hallazgo", "preguntas abiertas", "lo que falta"]

    static func parse(_ text: String) throws -> WrapupPlan {
        guard let start = text.firstIndex(of: "{"), let end = text.lastIndex(of: "}"), start < end,
              let data = String(text[start...end]).data(using: .utf8) else {
            throw RecapError("WRAPUP_OUTPUT", "The wrap-up answer has no JSON object: \(text.prefix(200))")
        }
        let raw: WrapupPlan
        do {
            raw = try JSONDecoder().decode(WrapupPlan.self, from: data)
        } catch {
            throw RecapError("WRAPUP_OUTPUT", "The wrap-up JSON is incomplete: \(error.localizedDescription)")
        }
        let title = String(raw.title.trimmed.prefix(120))
        let pageTitle = raw.pageTitle.trimmed.isEmpty ? title : raw.pageTitle.trimmed
        let page = stripForbiddenSections(raw.pageMarkdown).trimmed
        guard !title.isEmpty, !page.isEmpty else {
            throw RecapError("WRAPUP_OUTPUT", "The wrap-up answer has an empty title or page")
        }
        let project = raw.project?.trimmed
        let backlog = raw.backlog
            .filter { ["pending", "finding"].contains($0.kind) && !$0.title.trimmed.isEmpty }
            .map { WrapupPlan.Item(kind: $0.kind, title: String($0.title.trimmed.prefix(200)), body: $0.body?.trimmed) }
        return WrapupPlan(title: title, project: project?.isEmpty == true ? nil : project,
                          pageTitle: pageTitle, pageMarkdown: page, backlog: backlog)
    }

    static func stripForbiddenSections(_ markdown: String) -> String {
        var kept: [String] = []
        var skipping = false
        var inFence = false
        for line in markdown.components(separatedBy: "\n") {
            if line.hasPrefix("```") { inFence.toggle() }
            if !inFence && line.hasPrefix("## ") {
                let heading = TextSimilarity.fold(String(line.dropFirst(3)))
                skipping = forbiddenSections.contains { heading.hasPrefix($0) }
            }
            if !skipping { kept.append(line) }
        }
        return kept.joined(separator: "\n")
    }

    static func demoteHeadings(_ markdown: String) -> String {
        var inFence = false
        return markdown.components(separatedBy: "\n").map { line in
            if line.hasPrefix("```") { inFence.toggle() }
            return !inFence && line.hasPrefix("#") ? "#" + line : line
        }.joined(separator: "\n")
    }
}

enum WrapupRules {
    static let genericTitles: Set<String> = [
        "", "reunion", "reunion presencial", "reunion remota", "junta", "junta presencial", "junta remota",
        "meet", "meeting", "llamada", "videollamada", "remote meeting", "in-person meeting",
        "in person meeting", "reunion en sala", "sesion",
    ]

    static func isGenericTitle(_ title: String) -> Bool {
        let folded = TextSimilarity.fold(title)
            .components(separatedBy: CharacterSet.alphanumerics.inverted.subtracting(CharacterSet(charactersIn: "-")))
            .filter { !$0.isEmpty }
            .joined(separator: " ")
        return genericTitles.contains(folded)
    }

    static func chooseProject(current: String?, proposed: String?, available: [String]) -> (apply: String?, resolved: Bool) {
        if let current, !current.trimmed.isEmpty { return (nil, true) }
        guard let proposed else { return (nil, false) }
        let wanted = TextSimilarity.fold(proposed)
        guard let match = available.first(where: { TextSimilarity.fold($0) == wanted }) else { return (nil, false) }
        return (match, true)
    }
}

struct BitaClient {
    let executable: URL
    let config: Config
    let target: BitaTarget

    init(config: Config, target: BitaTarget) throws {
        executable = try Tool.bita.require(config)
        self.config = config
        self.target = target
    }

    @discardableResult
    func call(_ arguments: [String]) throws -> Any? {
        var full = arguments + ["--json"]
        if let database = target.databasePath { full += ["--db-path", database] }
        if let docs = target.docsRoot { full += ["--docs-dir", docs] }
        var environment = Tool.environment(for: executable, config: config)
        environment["BITA_NO_HOOKS"] = "1"
        let result = try Shell.run(executable, full, environment: environment, cwd: URL(fileURLWithPath: "/"))
        let envelope = (try? JSONSerialization.jsonObject(with: Data(result.stdout.utf8))) as? [String: Any]
        guard result.ok, envelope?["ok"] as? Bool == true else {
            let error = (envelope?["error"] as? [String: Any])?["message"] as? String
            throw RecapError("BITA_FAILED", "bita \(arguments.prefix(3).joined(separator: " ")) failed: \(error ?? (result.stdout + result.stderr).trimmed.suffix(300).description)")
        }
        return envelope?["data"]
    }
}

struct MeetingWrapup {
    let config: Config

    func run(meeting: Meeting, dir: URL) throws {
        guard let entryId = meeting.bitaEntryId else { return }
        let bita = try BitaClient(config: config,
                                  target: BitaTarget(databasePath: meeting.bitaDatabasePath, docsRoot: meeting.bitaDocsRoot))
        let snapshot = meeting.bitaEntry ?? BitaEntrySnapshot(title: meeting.title, projectName: nil, kind: nil, pageIds: [])
        var wrapup = meeting.wrapup ?? Wrapup()

        let projects = ((try bita.call(["projects"])) as? [[String: Any]] ?? [])
            .filter { $0["active"] as? Bool != false }
            .compactMap { $0["name"] as? String }
        let existingPageId = wrapup.pageId ?? snapshot.pageIds.first
        let existingPage = try existingPageId.map { try pageText(bita: bita, pageId: $0) } ?? nil

        let plan = try planFor(meeting: meeting, dir: dir, snapshot: snapshot, projects: projects, existingPage: existingPage)
        try JSONEncoder().encode(plan).write(to: dir.appending(path: "wrapup.json"), options: .atomic)

        if WrapupRules.isGenericTitle(snapshot.title) {
            try bita.call(["amend", String(entryId), "--title", plan.title])
            wrapup.title = plan.title
            wrapup.titleChanged = true
        } else {
            wrapup.title = snapshot.title
        }

        let choice = WrapupRules.chooseProject(current: snapshot.projectName, proposed: plan.project, available: projects)
        if let project = choice.apply {
            try bita.call(["amend", String(entryId), "--project", project])
        }
        wrapup.project = choice.apply ?? snapshot.projectName
        wrapup.projectResolved = choice.resolved

        let pageFile = dir.appending(path: "bita-page.md")
        if let pageId = existingPageId {
            try WrapupParser.demoteHeadings(plan.pageMarkdown).write(to: pageFile, atomically: true, encoding: .utf8)
            try bita.call(["docs", "page", "write", String(pageId), "--md", pageFile.path,
                           "--section", "Reunión \(Self.day(meeting))"])
            wrapup.pageId = pageId
        } else {
            try plan.pageMarkdown.write(to: pageFile, atomically: true, encoding: .utf8)
            var arguments = ["docs", "page", "new", plan.pageTitle, "--from-entry", String(entryId)]
            if let project = wrapup.project { arguments += ["--project", project] }
            let created = try bita.call(arguments) as? [String: Any]
            guard let page = created?["page"] as? [String: Any], let pageId = page["pageId"] as? Int else {
                throw RecapError("BITA_FAILED", "bita docs page new did not return the page id")
            }
            try bita.call(["docs", "page", "write", String(pageId), "--md", pageFile.path])
            wrapup.pageId = pageId
            wrapup.pageCreated = true
        }
        _ = try MeetingFile.update(dir) { $0.wrapup = wrapup }

        for item in plan.backlog where wrapup.backlogKeys[item.title] == nil {
            var arguments = ["backlog", "add", "--kind", item.kind, "--title", item.title, "--page", String(wrapup.pageId ?? 0)]
            if let body = item.body, !body.isEmpty {
                let bodyFile = dir.appending(path: "bita-backlog-item.md")
                try body.write(to: bodyFile, atomically: true, encoding: .utf8)
                arguments += ["--md", bodyFile.path]
            }
            let added = try bita.call(arguments) as? [String: Any]
            wrapup.backlogKeys[item.title] = added?["key"] as? String ?? "?"
            _ = try MeetingFile.update(dir) { $0.wrapup = wrapup }
        }

        try BitaBridge(config: config).saveMinutes(meeting: meeting, dir: dir)
        _ = try MeetingFile.update(dir) { $0.wrapup = wrapup }
    }

    private func pageText(bita: BitaClient, pageId: Int) throws -> String? {
        let page = try bita.call(["docs", "page", "show", String(pageId)]) as? [String: Any]
        guard let path = (page?["doc"] as? [String: Any])?["path"] as? String else { return nil }
        return try? String(contentsOf: URL(fileURLWithPath: path), encoding: .utf8)
    }

    private func planFor(meeting: Meeting, dir: URL, snapshot: BitaEntrySnapshot, projects: [String],
                         existingPage: String?) throws -> WrapupPlan {
        let summary = (try? String(contentsOf: dir.appending(path: "summary.md"), encoding: .utf8)) ?? ""
        let transcript = (try? String(contentsOf: dir.appending(path: "transcript.md"), encoding: .utf8)) ?? ""
        let pageNote = existingPage.map {
            "- Esta reunión ya tiene página. `pageMarkdown` se agregará como una sección nueva de esa página; no repitas lo que ya dice:\n<pagina_actual>\n\($0.prefix(20_000))\n</pagina_actual>"
        } ?? ""
        let prompt = try ResourceText.load("wrapup-prompt.md")
            .replacingOccurrences(of: "{{currentTitle}}", with: snapshot.title)
            .replacingOccurrences(of: "{{currentProject}}", with: snapshot.projectName ?? "ninguno")
            .replacingOccurrences(of: "{{date}}", with: Self.day(meeting))
            .replacingOccurrences(of: "{{duration}}", with: Duration.format(meeting.durationSeconds))
            .replacingOccurrences(of: "{{mode}}", with: meeting.mode == .remote ? "remota" : "presencial")
            .replacingOccurrences(of: "{{projects}}", with: projects.map { "  - \($0)" }.joined(separator: "\n"))
            .replacingOccurrences(of: "{{existingPage}}", with: pageNote)
            .replacingOccurrences(of: "{{summary}}", with: summary)
            .replacingOccurrences(of: "{{transcript}}", with: transcript)
        let output = try ClaudeRunner.run(prompt: prompt, dir: dir, config: config)
        return try WrapupParser.parse(try ClaudeRunner.resultText(output))
    }

    static func day(_ meeting: Meeting) -> String {
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.dateFormat = "yyyy-MM-dd"
        return formatter.string(from: meeting.startedAt ?? meeting.createdAt)
    }
}
