import Foundation

struct BrainNote: Equatable {
    var id: String
    var title: String
    var kind: String
    var project: String?
    var snippet: String
    var score: Double?
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

    let bin: [String]

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
                                   environment: environment, cwd: URL(fileURLWithPath: "/"))
        return BitaResponse(stdout: result.stdout, stderr: result.stderr, status: result.status)
    }
}

enum GazeBrain {
    static let searchLimit = 5
    static let unavailable = "  (el cerebro no está disponible)"
    static let empty = "  (sin notas en el cerebro)"
    static let rememberedKinds: Set<String> = ["page", "file", "commit"]

    static func search(_ gaze: GazeCalling, question: String, project: String) -> [BrainNote] {
        guard let response = try? gaze.invoke(["search", question, "--project", project, "--limit", String(searchLimit), "--json"],
                                              stdin: nil),
              response.ok, let items = response.data as? [[String: Any]] else { return [] }
        return items.compactMap(note)
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
        return context.brain.map { "  - [\($0.id)] \($0.title) (\($0.kind)) — \($0.snippet)" }.joined(separator: "\n")
    }

    static func shouldRemember(_ answer: Answer) -> Bool {
        answer.found
            && answer.sources.contains { rememberedKinds.contains($0.kind) }
            && !answer.sources.contains { $0.kind == "note" }
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
        return "\(answer.answer.trimmed)\n\nFuentes:\n\(sources)\n\nReunión: «\(title)» (\(formatter.string(from: meeting.createdAt)))"
    }

    static func remember(_ gaze: GazeCalling, answer: Answer, project: String, meeting: Meeting,
                         log: (String) -> Void) {
        let title = answer.question.trimmed
        guard !title.isEmpty, shouldRemember(answer) else { return }
        let body = noteBody(answer: answer, meeting: meeting)
        do {
            let response = try gaze.invoke(["remember", "-", "--project", project, "--kind", "fact", "--title", title, "--json"],
                                           stdin: Data(body.utf8))
            if !response.ok { log("gaze remember failed: \(response.errorMessage ?? "no reason given")") }
        } catch {
            log("gaze remember failed: \(error)")
        }
    }
}
