import Foundation

package struct LiveWorkerLaunch: Equatable {
    package static let environmentKey = "RECAP_LIVE_WORKER"
    package static let defaultExecutableName = "recap"
    package static let defaultArguments = ["live-worker"]
    package static let disabledValues: Set<String> = ["none", "off", "false", "0"]

    package var executable: URL
    package var arguments: [String]

    package init(executable: URL, arguments: [String]) {
        self.executable = executable
        self.arguments = arguments
    }

    package func arguments(for meetingDir: URL) -> [String] {
        arguments + [meetingDir.path]
    }

    package static func resolve(option: String?, environment: [String: String], executable: URL?) throws -> LiveWorkerLaunch? {
        let configured = [option, environment[environmentKey]]
            .compactMap { $0?.trimmed }
            .first { !$0.isEmpty }
        guard let configured else { return try sibling(of: executable) }
        if disabledValues.contains(configured.lowercased()) { return nil }
        if configured.hasPrefix("[") { return try parseCommand(configured) }
        return LiveWorkerLaunch(executable: try locate(configured), arguments: defaultArguments)
    }

    package static func parseCommand(_ raw: String) throws -> LiveWorkerLaunch {
        guard let command = try? JSONDecoder().decode([String].self, from: Data(raw.utf8)),
              let first = command.first, !first.isEmpty else {
            throw RecapError("LIVE_WORKER_INVALID", "The live worker command must be a JSON array of strings with the executable first, got \(raw)")
        }
        return LiveWorkerLaunch(executable: try locate(first), arguments: Array(command.dropFirst()))
    }

    private static func sibling(of executable: URL?) throws -> LiveWorkerLaunch {
        guard let executable else {
            throw RecapError("LIVE_WORKER_MISSING", "Cannot locate the current executable to find \(defaultExecutableName)")
        }
        let candidate = executable.deletingLastPathComponent().appending(path: defaultExecutableName)
        guard FileManager.default.isExecutableFile(atPath: candidate.path) else {
            throw RecapError("LIVE_WORKER_MISSING", "\(candidate.path) not found; pass --live-worker or set \(environmentKey)")
        }
        return LiveWorkerLaunch(executable: candidate, arguments: defaultArguments)
    }

    private static func locate(_ path: String) throws -> URL {
        let url = path.contains("/") ? Paths.expandTilde(path) : Shell.which(path)
        guard let url, FileManager.default.isExecutableFile(atPath: url.path) else {
            throw RecapError("LIVE_WORKER_MISSING", "Live worker executable \(path) not found")
        }
        return url
    }
}
