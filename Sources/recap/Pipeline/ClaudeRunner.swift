import Foundation

enum ClaudeRunner {
    static func run(prompt: String, dir: URL, config: Config) throws -> String {
        let claude = try Tool.claude.require(config)
        var arguments = ["-p", "--output-format", "json", "--setting-sources", "project",
                         "--strict-mcp-config", "--no-session-persistence", "--disable-slash-commands",
                         "--allowedTools", "Read", "--add-dir", dir.path]
        if let model = config.summaryModel { arguments += ["--model", model] }
        let result = try Shell.run(claude, arguments, stdin: Data(prompt.utf8),
                                   environment: Tool.environment(for: claude, config: config), cwd: dir)
        guard result.ok else {
            throw RecapError("CLAUDE_FAILED", (result.stderr.isEmpty ? result.stdout : result.stderr).trimmed)
        }
        return result.stdout
    }

    static func resultText(_ output: String) throws -> String {
        struct Result: Decodable {
            let result: String?
            let is_error: Bool?
        }
        guard let data = output.data(using: .utf8),
              let parsed = try? JSONDecoder().decode(Result.self, from: data) else {
            throw RecapError("CLAUDE_OUTPUT", "Unexpected output from claude: \(output.prefix(300))")
        }
        guard parsed.is_error != true, let result = parsed.result, !result.trimmed.isEmpty else {
            throw RecapError("CLAUDE_FAILED", parsed.result ?? "claude returned an empty answer")
        }
        return result
    }
}

enum ResourceText {
    static func load(_ name: String) throws -> String {
        let candidates = [
            Paths.configFile.deletingLastPathComponent().appending(path: name),
            Paths.appBundle?.appending(path: "Contents/Resources/\(name)"),
            URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
                .deletingLastPathComponent().deletingLastPathComponent().appending(path: "Resources/\(name)"),
        ].compactMap { $0 }
        for candidate in candidates {
            if let text = try? String(contentsOf: candidate, encoding: .utf8) { return text }
        }
        throw RecapError("PROMPT_MISSING", "\(name) not found; reinstall recap")
    }
}
