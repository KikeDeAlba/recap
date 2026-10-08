import Foundation

enum ClaudeRunner {
    static let isolation = ["--setting-sources", "project", "--strict-mcp-config", "--no-session-persistence",
                            "--disable-slash-commands"]

    static func run(prompt: String, dir: URL, config: Config) throws -> String {
        try run(prompt: prompt, cwd: dir, config: config, tools: ["Read"], addDirs: [dir.path], model: config.summaryModel)
    }

    static func run(prompt: String, cwd: URL, config: Config, tools: [String], addDirs: [String], model: String?) throws -> String {
        let claude = try Tool.claude.require(config)
        let arguments = ["-p", "--output-format", "json"] + options(tools: tools, addDirs: addDirs, model: model)
        let result = try Shell.run(claude, arguments, stdin: Data(prompt.utf8),
                                   environment: Tool.environment(for: claude, config: config), cwd: cwd)
        guard result.ok else {
            throw RecapError("CLAUDE_FAILED", (result.stderr.isEmpty ? result.stdout : result.stderr).trimmed)
        }
        return result.stdout
    }

    static func options(tools: [String], addDirs: [String], model: String?, restrictTools: [String]? = nil) -> [String] {
        var arguments = isolation
        if let restrictTools { arguments += ["--tools", restrictTools.joined(separator: ",")] }
        arguments += ["--allowedTools", tools.joined(separator: " ")]
        var seen = Set<String>()
        for dir in addDirs where seen.insert(dir).inserted {
            arguments += ["--add-dir", dir]
        }
        if let model { arguments += ["--model", model] }
        return arguments
    }

    static func streamArguments(tools: [String], addDirs: [String], model: String?, restrictTools: [String]? = nil) -> [String] {
        ["-p", "--output-format", "stream-json", "--verbose", "--include-partial-messages"]
            + options(tools: tools, addDirs: addDirs, model: model, restrictTools: restrictTools)
    }

    static func stream(prompt: String, cwd: URL, config: Config, arguments: [String],
                       onLine: (String) -> Void) throws -> ShellResult {
        let claude = try Tool.claude.require(config)
        let process = Process()
        process.executableURL = claude
        process.arguments = arguments
        process.environment = Tool.environment(for: claude, config: config)
        process.currentDirectoryURL = cwd
        let out = Pipe()
        let err = Pipe()
        let input = Pipe()
        process.standardOutput = out
        process.standardError = err
        process.standardInput = input
        try process.run()
        input.fileHandleForWriting.write(Data(prompt.utf8))
        try? input.fileHandleForWriting.close()
        var errData = Data()
        let group = DispatchGroup()
        group.enter()
        DispatchQueue.global().async {
            errData = err.fileHandleForReading.readDataToEndOfFile()
            group.leave()
        }
        var buffer = Data()
        var all = Data()
        let reader = out.fileHandleForReading
        while true {
            let chunk = reader.availableData
            if chunk.isEmpty { break }
            all.append(chunk)
            buffer.append(chunk)
            while let newline = buffer.firstIndex(of: 0x0A) {
                let line = buffer[buffer.startIndex..<newline]
                buffer.removeSubrange(buffer.startIndex...newline)
                if !line.isEmpty { onLine(String(decoding: line, as: UTF8.self)) }
            }
        }
        if !buffer.isEmpty { onLine(String(decoding: buffer, as: UTF8.self)) }
        process.waitUntilExit()
        group.wait()
        return ShellResult(status: process.terminationStatus,
                           stdout: String(decoding: all, as: UTF8.self),
                           stderr: String(decoding: errData, as: UTF8.self))
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
