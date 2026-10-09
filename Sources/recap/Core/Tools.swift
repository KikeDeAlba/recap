import Foundation

enum Tool: String, CaseIterable {
    case ffmpeg
    case whisper = "whisper-cli"
    case claude
    case bita

    var installHint: String {
        switch self {
        case .ffmpeg: "brew install ffmpeg"
        case .whisper: "brew install whisper-cpp"
        case .claude: "npm install -g @anthropic-ai/claude-code"
        case .bita: "npm install -g @kikedealba/bita"
        }
    }

    func configuredPath(_ config: Config) -> String? {
        config.tools?[rawValue]
    }

    func locate(_ config: Config) -> URL? {
        if let configured = configuredPath(config) {
            let url = Paths.expandTilde(configured)
            if FileManager.default.isExecutableFile(atPath: url.path) { return url }
        }
        return Shell.which(rawValue)
    }

    func require(_ config: Config) throws -> URL {
        guard let url = locate(config) else {
            throw RecapError("DEPENDENCY_MISSING", "\(rawValue) not found. Install it with `\(installHint)` or set tools.\(rawValue) in \(Paths.configFile.path)")
        }
        return url
    }

    static func environment(for executable: URL, config: Config,
                            base: [String: String] = ProcessInfo.processInfo.environment) -> [String: String] {
        var environment = base
        let current = environment["PATH"] ?? ""
        let toolDirs = (config.tools ?? [:]).values.map { Paths.expandTilde($0).deletingLastPathComponent().path }
        let extra = [executable.deletingLastPathComponent().path] + toolDirs + Shell.searchPaths
        environment["PATH"] = (extra + [current]).filter { !$0.isEmpty }.joined(separator: ":")
        if environment["HOME"] == nil { environment["HOME"] = Paths.home.path }
        if environment["USER"]?.isEmpty ?? true { environment["USER"] = NSUserName() }
        if environment["LOGNAME"]?.isEmpty ?? true { environment["LOGNAME"] = environment["USER"] }
        return environment
    }
}
