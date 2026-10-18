import Darwin
import Foundation

struct RepoGitRejection: Error, Equatable {
    let reason: String
}

enum RepoGit {
    typealias Runner = (_ git: URL, _ arguments: [String], _ environment: [String: String]) throws -> Int32

    static let commandName = "repo-git"
    static let subcommands = ["log", "show", "diff"]
    static let timeout: TimeInterval = 30
    static let timeoutStatus: Int32 = 124
    static let rejectedStatus: Int32 = 2
    static let fixedFlags = ["--no-ext-diff", "--no-textconv", "--no-color"]

    static let exactOptions: Set<String> = [
        "-n", "-i", "--regexp-ignore-case", "--all-match", "--invert-grep", "--pickaxe-regex", "--no-merges", "--merges",
        "--first-parent", "--follow", "--all", "--branches", "--tags", "--remotes",
        "--oneline", "--pretty", "--abbrev-commit", "--no-abbrev-commit", "--decorate", "--no-decorate", "--graph",
        "--reverse", "--name-only", "--name-status", "--stat", "--shortstat", "--numstat", "--summary", "--raw",
        "-p", "-u", "--patch", "--no-patch", "-s", "-W", "--function-context", "--word-diff", "--color-words",
        "--ignore-all-space", "-w", "--ignore-space-change", "-b", "-M", "--find-renames", "-C", "--find-copies",
        "--no-renames", "--relative", "--cached", "--staged", "--merge-base", "--no-color", "--color=never",
    ]

    static let valueOptions: Set<String> = [
        "--max-count", "--skip", "--since", "--after", "--until", "--before", "--author", "--committer", "--grep",
        "--format", "--pretty", "--date", "--stat", "--unified", "--word-diff", "--find-renames", "--diff-filter",
        "--relative",
    ]

    static let safeCharacters = Set("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_./+@-")

    static let strippedVariables: Set<String> = [
        "GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_OBJECT_DIRECTORY", "GIT_ALTERNATE_OBJECT_DIRECTORIES",
        "GIT_CONFIG", "GIT_CONFIG_GLOBAL", "GIT_CONFIG_SYSTEM", "GIT_CONFIG_COUNT", "GIT_EXTERNAL_DIFF", "GIT_PAGER",
    ]

    static var selfPath: String?{ Paths.executable?.path }

    static func isSafe(_ text: String) -> Bool {
        !text.isEmpty && text.allSatisfy { safeCharacters.contains($0) }
    }

    static func invocation(selfPath: String?) -> String {
        "\(selfPath ?? "recap") \(commandName)"
    }

    static func isAllowed(repo: String, selfPath: String?) -> Bool {
        selfPath.map(isSafe) == true && isSafe(repo)
    }

    static func allowRules(repo: String, selfPath: String?) -> [String] {
        guard let selfPath, isAllowed(repo: repo, selfPath: selfPath) else { return [] }
        return subcommands.map { "Bash(\(selfPath) \(commandName) \(repo) \($0):*)" }
    }

    static func validate(_ arguments: [String],
                         directoryExists: (String) -> Bool = RepoGit.directoryExists) throws(RepoGitRejection) -> [String] {
        guard let repo = arguments.first, !repo.isEmpty else {
            throw RepoGitRejection(reason: "usage: recap repo-git <repo> <log|show|diff> [args...]")
        }
        guard repo.hasPrefix("/") else { throw RepoGitRejection(reason: "repository path must be absolute: \(repo)") }
        guard !repo.contains("\0"), directoryExists(repo) else { throw RepoGitRejection(reason: "repository not found: \(repo)") }
        let sub = arguments.count > 1 ? arguments[1] : "(none)"
        guard subcommands.contains(sub) else { throw RepoGitRejection(reason: "subcommand not allowed: \(sub)") }
        let checked = try validateArguments(Array(arguments.dropFirst(2)), subcommand: sub)
        return ["--no-pager", "-C", repo, "-c", "core.fsmonitor=false", "-c", "diff.external=", "-c", "core.pager=cat", sub]
            + fixedFlags + checked
    }

    static func validateArguments(_ arguments: [String], subcommand: String) throws(RepoGitRejection) -> [String] {
        var index = 0
        var pathsOnly = false
        while index < arguments.count {
            let argument = arguments[index]
            index += 1
            if argument.contains("\0") { throw RepoGitRejection(reason: "argument contains a NUL byte") }
            if pathsOnly || !argument.hasPrefix("-") {
                if escapesRepo(argument) {
                    throw RepoGitRejection(reason: "path outside the repository not allowed: \(argument)")
                }
                continue
            }
            if argument == "--" {
                pathsOnly = true
                continue
            }
            if argument == "-n" {
                guard index < arguments.count, isDigits(arguments[index]) else {
                    throw RepoGitRejection(reason: "-n needs a number")
                }
                index += 1
                continue
            }
            guard isAllowedOption(argument, subcommand: subcommand) else {
                throw RepoGitRejection(reason: "option not allowed: \(argument)")
            }
        }
        return arguments
    }

    static func isAllowedOption(_ option: String, subcommand: String) -> Bool {
        if exactOptions.contains(option) { return true }
        if let equals = option.firstIndex(of: "="), option.hasPrefix("--"),
           valueOptions.contains(String(option[..<equals])) {
            return true
        }
        if isDigits(String(option.dropFirst())) { return true }
        for prefix in ["-n", "-U"] where option.hasPrefix(prefix) && isDigits(String(option.dropFirst(2))) {
            return true
        }
        var stuck = ["-S", "-G", "-M"]
        if subcommand == "log" { stuck.append("-L") }
        return stuck.contains { option.hasPrefix($0) && option.count > 2 }
    }

    static func escapesRepo(_ argument: String) -> Bool {
        argument.hasPrefix("/") || argument.split(omittingEmptySubsequences: false) { $0 == "/" || $0 == "\\" }.contains("..")
    }

    static func isDigits(_ text: String) -> Bool {
        !text.isEmpty && text.allSatisfy { $0.isASCII && $0.isNumber }
    }

    static func directoryExists(_ path: String) -> Bool {
        var isDirectory: ObjCBool = false
        return FileManager.default.fileExists(atPath: path, isDirectory: &isDirectory) && isDirectory.boolValue
    }

    static func environment(_ base: [String: String]) -> [String: String] {
        var environment = base.filter { key, _ in
            !strippedVariables.contains(key) && !key.hasPrefix("GIT_CONFIG_KEY_") && !key.hasPrefix("GIT_CONFIG_VALUE_")
        }
        environment["GIT_TERMINAL_PROMPT"] = "0"
        return environment
    }

    static func run(_ arguments: [String], runner: Runner = RepoGit.process(),
                    git: () -> URL? = { Shell.which("git") },
                    stderr: (String) -> Void = { FileHandle.standardError.write(Data($0.utf8)) }) -> Int32 {
        let gitArguments: [String]
        do {
            gitArguments = try validate(arguments)
        } catch {
            stderr("recap \(commandName): \(error.reason)\n")
            return rejectedStatus
        }
        guard let executable = git() else {
            stderr("recap \(commandName): git not found\n")
            return rejectedStatus
        }
        do {
            return try runner(executable, gitArguments, environment(ProcessInfo.processInfo.environment))
        } catch let error as RecapError where error.code == "TIMEOUT" {
            stderr("recap \(commandName): git did not finish within \(Int(timeout)) seconds\n")
            return timeoutStatus
        } catch {
            stderr("recap \(commandName): \(error)\n")
            return rejectedStatus
        }
    }

    static func process(stdout: FileHandle = .standardOutput, stderr: FileHandle = .standardError,
                        timeout: TimeInterval = RepoGit.timeout) -> Runner {
        { git, arguments, environment in
            let process = Process()
            process.executableURL = git
            process.arguments = arguments
            process.environment = environment
            process.standardInput = FileHandle.nullDevice
            process.standardOutput = stdout
            process.standardError = stderr
            let finished = DispatchSemaphore(value: 0)
            process.terminationHandler = { _ in finished.signal() }
            try process.run()
            guard finished.wait(timeout: .now() + timeout) == .timedOut else { return process.terminationStatus }
            process.terminate()
            if finished.wait(timeout: .now() + Shell.killGrace) == .timedOut {
                kill(process.processIdentifier, SIGKILL)
                finished.wait()
            }
            throw RecapError("TIMEOUT", "git did not finish within \(Int(timeout)) seconds")
        }
    }
}
