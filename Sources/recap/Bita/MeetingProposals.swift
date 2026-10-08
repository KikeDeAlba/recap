import Darwin
import Foundation

struct ProposalQuote: Codable, Equatable {
    var startMs: Int
    var channel: Channel
    var text: String
}

enum ProposalStatus: String, Codable {
    case pending
    case accepted
    case rejected
    case stale
}

struct Proposal: Codable, Equatable {
    var n: Int
    var pageId: Int
    var pageTitle: String
    var section: String?
    var title: String
    var rationale: String
    var quotes: [ProposalQuote]
    var branch: String
    var sha: String
    var status: ProposalStatus
    var appliedSha: String?
    var file: String
    var updatedAt: Date?

    private enum CodingKeys: String, CodingKey {
        case n, pageId, pageTitle, section, title, rationale, quotes, branch, sha, status, appliedSha, file, updatedAt
    }

    init(n: Int, pageId: Int, pageTitle: String, section: String?, title: String, rationale: String,
         quotes: [ProposalQuote], branch: String, sha: String, status: ProposalStatus = .pending,
         appliedSha: String? = nil, file: String, updatedAt: Date? = nil) {
        self.n = n
        self.pageId = pageId
        self.pageTitle = pageTitle
        self.section = section
        self.title = title
        self.rationale = rationale
        self.quotes = quotes
        self.branch = branch
        self.sha = sha
        self.status = status
        self.appliedSha = appliedSha
        self.file = file
        self.updatedAt = updatedAt
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(n, forKey: .n)
        try container.encode(pageId, forKey: .pageId)
        try container.encode(pageTitle, forKey: .pageTitle)
        if let section { try container.encode(section, forKey: .section) } else { try container.encodeNil(forKey: .section) }
        try container.encode(title, forKey: .title)
        try container.encode(rationale, forKey: .rationale)
        try container.encode(quotes, forKey: .quotes)
        try container.encode(branch, forKey: .branch)
        try container.encode(sha, forKey: .sha)
        try container.encode(status, forKey: .status)
        try container.encodeIfPresent(appliedSha, forKey: .appliedSha)
        try container.encode(file, forKey: .file)
        try container.encodeIfPresent(updatedAt, forKey: .updatedAt)
    }
}

struct DiscardedProposal: Codable, Equatable {
    var index: Int
    var pageId: Int?
    var reason: String
}

struct ProposalsFile: Codable, Equatable {
    var entryId: Int
    var branch: String
    var generatedAt: Date
    var branchDropped = false
    var proposals: [Proposal]
    var discarded: [DiscardedProposal] = []
}

struct ProposalDraft: Equatable {
    var pageId: Int
    var section: String?
    var markdown: String
    var title: String
    var rationale: String
    var quotes: [ProposalQuote]
}

enum ProposalPlanParser {
    static let revealingPhrases = [
        "se acordo", "acordamos", "decidimos", "se decidio", "por decision de", "en la reunion", "en la junta",
        "segun lo hablado", "como se comento", "como se menciono", "quedamos en", "se platico", "la grabacion",
        "la transcripcion",
    ]

    static func parse(_ text: String, candidates: Set<Int>) throws -> (drafts: [ProposalDraft], discarded: [DiscardedProposal]) {
        guard let start = text.firstIndex(of: "{"), let end = text.lastIndex(of: "}"), start < end,
              let object = (try? JSONSerialization.jsonObject(with: Data(String(text[start...end]).utf8))) as? [String: Any],
              let items = object["proposals"] as? [Any] else {
            throw RecapError("PROPOSALS_OUTPUT", "The proposals answer has no {\"proposals\": [...]} object: \(text.prefix(200))")
        }
        var drafts: [ProposalDraft] = []
        var discarded: [DiscardedProposal] = []
        var seen = Set<String>()
        for (index, raw) in items.enumerated() {
            guard let item = raw as? [String: Any] else {
                discarded.append(DiscardedProposal(index: index, pageId: nil, reason: "not an object"))
                continue
            }
            let pageId = (item["pageId"] as? Int) ?? (item["pageId"] as? String).flatMap { Int($0) }
            func discard(_ reason: String) { discarded.append(DiscardedProposal(index: index, pageId: pageId, reason: reason)) }
            guard let pageId else { discard("missing pageId"); continue }
            guard candidates.contains(pageId) else { discard("page \(pageId) is not a candidate"); continue }
            let section = (item["section"] as? String).map(cleanHeading).flatMap { $0.isEmpty ? nil : $0 }
            let markdown = ((item["markdown"] as? String) ?? "").trimmed
            let title = String(((item["title"] as? String) ?? "").trimmed.prefix(160))
            let rationale = ((item["rationale"] as? String) ?? "").trimmed
            guard !markdown.isEmpty else { discard("empty markdown"); continue }
            guard !title.isEmpty else { discard("empty title"); continue }
            if let phrase = revealing(markdown) { discard("the markdown reveals the conversation (\(phrase))"); continue }
            let quotes = (item["quotes"] as? [[String: Any]] ?? []).compactMap(quote)
            guard !quotes.isEmpty else { discard("no quotes from the transcript"); continue }
            let key = "\(pageId)|\(TextSimilarity.fold(section ?? ""))"
            guard seen.insert(key).inserted else { discard("duplicate change to the same section"); continue }
            drafts.append(ProposalDraft(pageId: pageId, section: section, markdown: stripLeadingHeading(markdown, section: section),
                                        title: title, rationale: rationale, quotes: Array(quotes.prefix(3))))
        }
        return (drafts, discarded)
    }

    static func revealing(_ markdown: String) -> String? {
        let folded = TextSimilarity.fold(markdown)
        return revealingPhrases.first { folded.contains($0) }
    }

    static func cleanHeading(_ heading: String) -> String {
        String(heading.trimmed.drop { $0 == "#" }).trimmed
    }

    static func stripLeadingHeading(_ markdown: String, section: String?) -> String {
        guard let section else { return markdown }
        let lines = markdown.components(separatedBy: "\n")
        guard let first = lines.first, first.hasPrefix("#"),
              TextSimilarity.fold(cleanHeading(first)) == TextSimilarity.fold(section) else { return markdown }
        return lines.dropFirst().joined(separator: "\n").trimmed
    }

    private static func quote(_ item: [String: Any]) -> ProposalQuote? {
        guard let text = (item["text"] as? String)?.trimmed, !text.isEmpty else { return nil }
        let startMs = (item["startMs"] as? Int) ?? (item["startMs"] as? Double).map { Int($0) } ?? 0
        let rawChannel = TextSimilarity.fold((item["channel"] as? String) ?? "mic")
        let channel: Channel = ["system", "remotos", "remoto"].contains(rawChannel) ? .system : .mic
        return ProposalQuote(startMs: max(0, startMs), channel: channel, text: text)
    }
}

enum ProposalStore {
    static func url(_ dir: URL) -> URL { dir.appending(path: "proposals.json") }
    static func markdownDir(_ dir: URL) -> URL { dir.appending(path: "proposals") }
    static func markdownFile(_ dir: URL, n: Int) -> URL { markdownDir(dir).appending(path: "\(n).md") }

    static func branch(entryId: Int) -> String { "proposal/meeting-\(entryId)" }

    static func load(_ dir: URL) -> ProposalsFile? {
        guard let data = try? Data(contentsOf: url(dir)) else { return nil }
        return try? MeetingFile.decoder.decode(ProposalsFile.self, from: data)
    }

    static func save(_ file: ProposalsFile, _ dir: URL) throws {
        try MeetingFile.encoder.encode(file).write(to: url(dir), options: .atomic)
    }

    static func withLock<T>(_ dir: URL, _ body: () throws -> T) throws -> T {
        let path = dir.appending(path: ".proposals.lock").path
        let descriptor = open(path, O_RDWR | O_CREAT, 0o644)
        guard descriptor >= 0 else { return try body() }
        defer { close(descriptor) }
        flock(descriptor, LOCK_EX)
        defer { flock(descriptor, LOCK_UN) }
        return try body()
    }
}

struct ProposalGenerator {
    let config: Config
    let bita: BitaCalling
    let claude: (_ prompt: String, _ addDirs: [String]) throws -> String
    let log: (String) -> Void

    init(config: Config, bita: BitaCalling, log: @escaping (String) -> Void,
         claude: ((String, [String]) throws -> String)? = nil) {
        self.config = config
        self.bita = bita
        self.log = log
        self.claude = claude ?? { prompt, dirs in
            let output = try ClaudeRunner.run(prompt: prompt, cwd: dirs.last.map { URL(fileURLWithPath: $0) } ?? Paths.home,
                                              config: config, tools: ["Read Grep Glob"], addDirs: dirs,
                                              model: config.summaryModel)
            return try ClaudeRunner.resultText(output)
        }
    }

    static func ownPageId(_ meeting: Meeting) -> Int? {
        meeting.wrapup?.pageId ?? meeting.bitaEntry?.pageIds.first
    }

    func candidates(meeting: Meeting, context: ProjectContext) -> [PageRef] {
        let own = Self.ownPageId(meeting)
        var pages = context.pages
        var known = Set(pages.map(\.pageId))
        for pageId in meeting.bitaEntry?.pageIds ?? [] where !known.contains(pageId) && pageId != own {
            guard let response = try? bita.invoke(["docs", "page", "show", String(pageId), "--no-markdown"]), response.ok,
                  let data = response.data as? [String: Any], let title = data["title"] as? String else { continue }
            pages.append(PageRef(pageId: pageId, title: title, relPath: data["relPath"] as? String ?? "", depth: 0))
            known.insert(pageId)
        }
        return pages.filter { $0.pageId != own }
    }

    func run(meeting: Meeting, dir: URL) throws -> ProposalsFile? {
        guard let entryId = meeting.bitaEntryId else { return nil }
        let branch = ProposalStore.branch(entryId: entryId)
        if let existing = ProposalStore.load(dir) {
            if existing.proposals.contains(where: { $0.status != .pending }) {
                log("proposals: already reviewed, keeping \(existing.proposals.count)")
                return existing
            }
            if !existing.proposals.isEmpty { _ = try? bita.invoke(["docs", "branch", "drop", branch]) }
        }
        let context = ProjectContextLoader.load(project: MeetingContext.project(meeting), docsRoot: meeting.bitaDocsRoot, bita: bita)
        let pages = candidates(meeting: meeting, context: context)
        var file = ProposalsFile(entryId: entryId, branch: branch, generatedAt: Date(), proposals: [])
        guard !pages.isEmpty, let docsRoot = context.docsRoot else {
            log("proposals: no candidate pages")
            try ProposalStore.save(file, dir)
            return file
        }
        guard let transcript = try? String(contentsOf: dir.appending(path: "transcript.md"), encoding: .utf8) else {
            throw RecapError("NO_TRANSCRIPT", "\"\(meeting.title)\" has no transcript yet")
        }
        let prompt = try render(meeting: meeting, docsRoot: docsRoot, pages: pages, context: context, transcript: transcript)
        let answer = try claude(prompt, [docsRoot, dir.path])
        let parsed = try ProposalPlanParser.parse(answer, candidates: Set(pages.map(\.pageId)))
        file.discarded = parsed.discarded
        for discarded in parsed.discarded { log("proposals: discarded #\(discarded.index): \(discarded.reason)") }
        try? FileManager.default.removeItem(at: ProposalStore.markdownDir(dir))
        if !parsed.drafts.isEmpty {
            try FileManager.default.createDirectory(at: ProposalStore.markdownDir(dir), withIntermediateDirectories: true)
        }
        let titles = Dictionary(pages.map { ($0.pageId, $0.title) }, uniquingKeysWith: { first, _ in first })
        var failures: [String] = []
        for draft in parsed.drafts {
            let n = file.proposals.count + 1
            let markdownFile = ProposalStore.markdownFile(dir, n: n)
            try draft.markdown.appending("\n").write(to: markdownFile, atomically: true, encoding: .utf8)
            do {
                let sha = try ProposalReview.propose(bita: bita, branch: branch, pageId: draft.pageId, section: draft.section,
                                                     file: markdownFile, reason: draft.title, entryId: entryId)
                file.proposals.append(Proposal(n: n, pageId: draft.pageId, pageTitle: titles[draft.pageId] ?? "#\(draft.pageId)",
                                               section: draft.section, title: draft.title, rationale: draft.rationale,
                                               quotes: draft.quotes, branch: branch, sha: sha, file: markdownFile.path,
                                               updatedAt: Date()))
            } catch {
                try? FileManager.default.removeItem(at: markdownFile)
                let message = (error as? RecapError)?.message ?? String(describing: error)
                failures.append(message)
                log("proposals: page #\(draft.pageId) failed: \(message)")
            }
        }
        try ProposalStore.save(file, dir)
        log("proposals: \(file.proposals.count) on \(branch)")
        if file.proposals.isEmpty, let first = failures.first {
            throw RecapError("PROPOSALS_FAILED", first)
        }
        return file
    }

    private func render(meeting: Meeting, docsRoot: String, pages: [PageRef], context: ProjectContext, transcript: String) throws -> String {
        let list = pages.map { page in
            "  - #\(page.pageId) «\(page.title)» — \(URL(fileURLWithPath: docsRoot).appending(path: page.relPath).path)"
        }.joined(separator: "\n")
        let speakers = meeting.mode == .remote
            ? "Hablantes: «Sala» es el micrófono local; «Remotos» es el audio de la llamada."
            : "Hablantes: un solo micrófono en la sala, sin separación por persona."
        return try ResourceText.load("proposals-prompt.md")
            .replacingOccurrences(of: "{{title}}", with: meeting.bitaEntry?.title ?? meeting.title)
            .replacingOccurrences(of: "{{date}}", with: MeetingWrapup.day(meeting))
            .replacingOccurrences(of: "{{mode}}", with: meeting.mode == .remote ? "remota" : "presencial")
            .replacingOccurrences(of: "{{speakers}}", with: speakers)
            .replacingOccurrences(of: "{{docsRoot}}", with: docsRoot)
            .replacingOccurrences(of: "{{pages}}", with: list)
            .replacingOccurrences(of: "{{transcript}}", with: transcript)
    }
}

struct ProposalReview {
    let dir: URL
    let bita: BitaCalling

    static func propose(bita: BitaCalling, branch: String, pageId: Int, section: String?, file: URL,
                        reason: String, entryId: Int) throws -> String {
        var arguments = ["docs", "propose", "--branch", branch, String(pageId), "--md", file.path]
        if let section { arguments += ["--section", section] }
        arguments += ["--reason", reason, "--source", "meeting:\(entryId)"]
        let data = try bita.call(arguments) as? [String: Any]
        guard let sha = data?["sha"] as? String, !sha.isEmpty else {
            throw RecapError("BITA_FAILED", "bita docs propose did not return the commit sha")
        }
        return sha
    }

    func list() throws -> [Proposal] {
        ProposalStore.load(dir)?.proposals ?? []
    }

    func proposal(_ n: Int) throws -> Proposal {
        guard let file = ProposalStore.load(dir) else {
            throw RecapError("NO_PROPOSALS", "The meeting has no proposals")
        }
        guard let found = file.proposals.first(where: { $0.n == n }) else {
            throw RecapError("PROPOSAL_NOT_FOUND", "There is no proposal \(n)")
        }
        return found
    }

    func diff(_ proposal: Proposal) -> Any? {
        guard let response = try? bita.invoke(["docs", "branch", "diff", proposal.branch, "--commit", proposal.sha]),
              response.ok else { return nil }
        return response.data
    }

    func accept(_ n: Int, editedMarkdown: URL? = nil) throws -> Proposal {
        try ProposalStore.withLock(dir) {
            var file = try load()
            var proposal = try find(n, in: file)
            guard proposal.status == .pending || proposal.status == .stale else {
                throw RecapError("PROPOSAL_CLOSED", "Proposal \(n) is already \(proposal.status.rawValue)")
            }
            let target = URL(fileURLWithPath: proposal.file)
            if let editedMarkdown {
                let text = try String(contentsOf: editedMarkdown, encoding: .utf8)
                guard !text.trimmed.isEmpty else { throw RecapError("EMPTY_MARKDOWN", "\(editedMarkdown.path) is empty") }
                try FileManager.default.createDirectory(at: target.deletingLastPathComponent(), withIntermediateDirectories: true)
                if editedMarkdown.standardizedFileURL.path != target.standardizedFileURL.path {
                    try text.write(to: target, atomically: true, encoding: .utf8)
                }
            }
            if editedMarkdown != nil || file.branchDropped {
                proposal.sha = try Self.propose(bita: bita, branch: proposal.branch, pageId: proposal.pageId,
                                                section: proposal.section, file: target, reason: proposal.title,
                                                entryId: file.entryId)
                file.branchDropped = false
            }
            let response = try bita.invoke(["docs", "branch", "apply", proposal.branch, "--commit", proposal.sha])
            if response.ok {
                proposal.status = .accepted
                proposal.appliedSha = ((response.data as? [String: Any])?["appliedSha"] as? String)
                    ?? ((response.data as? [String: Any])?["sha"] as? String)
            } else if response.errorCode == "MERGE_CONFLICT" {
                proposal.status = .stale
            } else {
                throw RecapError("BITA_FAILED", "bita docs branch apply failed: \(response.errorMessage ?? "no reason given")")
            }
            proposal.updatedAt = Date()
            try store(proposal, in: &file)
            return proposal
        }
    }

    func reject(_ n: Int) throws -> Proposal {
        try ProposalStore.withLock(dir) {
            var file = try load()
            var proposal = try find(n, in: file)
            guard proposal.status == .pending || proposal.status == .stale else {
                throw RecapError("PROPOSAL_CLOSED", "Proposal \(n) is already \(proposal.status.rawValue)")
            }
            proposal.status = .rejected
            proposal.updatedAt = Date()
            try store(proposal, in: &file)
            return proposal
        }
    }

    private func load() throws -> ProposalsFile {
        guard let file = ProposalStore.load(dir) else { throw RecapError("NO_PROPOSALS", "The meeting has no proposals") }
        return file
    }

    private func find(_ n: Int, in file: ProposalsFile) throws -> Proposal {
        guard let found = file.proposals.first(where: { $0.n == n }) else {
            throw RecapError("PROPOSAL_NOT_FOUND", "There is no proposal \(n)")
        }
        return found
    }

    private func store(_ proposal: Proposal, in file: inout ProposalsFile) throws {
        if let index = file.proposals.firstIndex(where: { $0.n == proposal.n }) { file.proposals[index] = proposal }
        if !file.branchDropped, !file.proposals.contains(where: { $0.status == .pending }) {
            let response = try? bita.invoke(["docs", "branch", "drop", file.branch])
            file.branchDropped = response?.ok == true
        }
        try ProposalStore.save(file, dir)
    }
}
