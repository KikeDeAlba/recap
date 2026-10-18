import Darwin
import Foundation

struct RepoGitRejection: Error, Equatable {
    let reason: String
}

enum RepoGit {
    typealias Runner = (_ git: URL, _ arguments: [String], _ environment: [String: String]) throws -> Int32
    typealias WorkTreeCheck = (_ git: URL, _ arguments: [String], _ environment: [String: String]) throws -> Bool

    static let commandName = "repo-git"
    static let subcommands = ["log", "show", "diff"]
    static let timeout: TimeInterval = 30
    static let checkTimeout: TimeInterval = 10
    static let timeoutStatus: Int32 = 124
    static let rejectedStatus: Int32 = 2
    static let missingStatus: Int32 = 127
    static let signalBase: Int32 = 128
    static let fixedFlags = ["--no-ext-diff", "--no-textconv", "--no-color"]
    static let configFlags = [
        "-c", "core.fsmonitor=false", "-c", "diff.external=", "-c", "core.pager=cat", "-c", "gpg.program=false",
        "-c", "gpg.ssh.program=false", "-c", "gpg.x509.program=false", "-c", "log.showSignature=false",
    ]

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

    static let safeScalars = Set("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_./+@-".unicodeScalars)

    static let keptVariables: Set<String> = ["PATH", "HOME", "USER", "LOGNAME", "TMPDIR", "LANG", "LC_ALL"]

    static var selfPath: String? { Paths.executable?.path }

    static func isSafe(_ text: String) -> Bool {
        !text.unicodeScalars.isEmpty && text.unicodeScalars.allSatisfy { safeScalars.contains($0) }
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

    static func gitPrefix(repo: String) -> [String] {
        ["--no-pager", "-C", repo] + configFlags
    }

    static func workTreeArguments(repo: String) -> [String] {
        gitPrefix(repo: repo) + ["rev-parse", "--is-inside-work-tree"]
    }

    static func validate(_ arguments: [String],
                         directoryExists: (String) -> Bool = RepoGit.directoryExists) throws(RepoGitRejection) -> [String] {
        guard let repo = arguments.first, !repo.unicodeScalars.isEmpty else {
            throw RepoGitRejection(reason: "usage: recap repo-git <repo> <log|show|diff> [args...]")
        }
        guard starts(repo, with: "/") else { throw RepoGitRejection(reason: "repository path must be absolute: \(repo)") }
        guard !hasNul(repo), directoryExists(repo) else { throw RepoGitRejection(reason: "repository not found: \(repo)") }
        let sub = arguments.count > 1 ? arguments[1] : "(none)"
        guard isASCII(sub), subcommands.contains(sub) else { throw RepoGitRejection(reason: "subcommand not allowed: \(sub)") }
        let checked = try validateArguments(Array(arguments.dropFirst(2)), subcommand: sub)
        return gitPrefix(repo: repo) + [sub] + fixedFlags + checked
    }

    static func validateArguments(_ arguments: [String], subcommand: String) throws(RepoGitRejection) -> [String] {
        var index = 0
        var pathsOnly = false
        while index < arguments.count {
            let argument = arguments[index]
            index += 1
            if hasNul(argument) { throw RepoGitRejection(reason: "argument contains a NUL byte") }
            if pathsOnly || !starts(argument, with: "-") {
                if escapesRepo(argument) {
                    throw RepoGitRejection(reason: "path outside the repository not allowed: \(argument)")
                }
                continue
            }
            if same(argument, "--") {
                pathsOnly = true
                continue
            }
            if same(argument, "-n") {
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
        let view = option.unicodeScalars
        if isASCII(option), exactOptions.contains(option) { return true }
        if starts(option, with: "--"), let equals = view.firstIndex(of: "=") {
            let name = String(view[..<equals])
            if isASCII(name), valueOptions.contains(name) { return true }
        }
        if isDigits(String(view.dropFirst())) { return true }
        for prefix in ["-n", "-U"] where starts(option, with: prefix) && isDigits(String(view.dropFirst(2))) {
            return true
        }
        var stuck = ["-S", "-G", "-M"]
        if subcommand == "log" { stuck.append("-L") }
        let attached = view.dropFirst(2).first
        return stuck.contains { starts(option, with: $0) }
            && attached.map { !lineTerminators.contains($0) } == true
    }

    static let lineTerminators: Set<Unicode.Scalar> = ["\n", "\r", "\u{2028}", "\u{2029}"]

    static func escapesRepo(_ argument: String) -> Bool {
        let parent = Array("..".unicodeScalars)
        let segments = Array(argument.unicodeScalars).split(omittingEmptySubsequences: false) { $0 == "/" || $0 == "\\" }
        return starts(argument, with: "/") || segments.contains { Array($0) == parent }
    }

    static func starts(_ text: String, with prefix: String) -> Bool {
        text.unicodeScalars.starts(with: prefix.unicodeScalars)
    }

    static func same(_ text: String, _ other: String) -> Bool {
        text.unicodeScalars.elementsEqual(other.unicodeScalars)
    }

    static func isASCII(_ text: String) -> Bool {
        text.unicodeScalars.allSatisfy(\.isASCII)
    }

    static func hasNul(_ text: String) -> Bool {
        text.unicodeScalars.contains("\0")
    }

    static func isDigits(_ text: String) -> Bool {
        !text.unicodeScalars.isEmpty && text.unicodeScalars.allSatisfy { ("0"..."9").contains($0) }
    }

    static func directoryExists(_ path: String) -> Bool {
        var isDirectory: ObjCBool = false
        return FileManager.default.fileExists(atPath: path, isDirectory: &isDirectory) && isDirectory.boolValue
    }

    static func environment(_ base: [String: String]) -> [String: String] {
        var environment = base.filter { key, _ in keptVariables.contains(key) || starts(key, with: "LC_") }
        environment["GIT_TERMINAL_PROMPT"] = "0"
        environment["GIT_CONFIG_NOSYSTEM"] = "1"
        return environment
    }

    static func workTree(timeout: TimeInterval = RepoGit.checkTimeout) -> WorkTreeCheck {
        { git, arguments, environment in
            let pipe = Pipe()
            defer { try? pipe.fileHandleForReading.close() }
            let status = try process(stdout: pipe.fileHandleForWriting, stderr: .nullDevice,
                                     timeout: timeout)(git, arguments, environment)
            try? pipe.fileHandleForWriting.close()
            return status == 0 && pending(pipe.fileHandleForReading).trimmed == "true"
        }
    }

    static func pending(_ handle: FileHandle) -> String {
        let fd = handle.fileDescriptor
        _ = fcntl(fd, F_SETFL, fcntl(fd, F_GETFL) | O_NONBLOCK)
        var data = Data()
        var buffer = [UInt8](repeating: 0, count: 4_096)
        while true {
            let count = Darwin.read(fd, &buffer, buffer.count)
            guard count > 0 else { break }
            data.append(buffer, count: count)
        }
        return String(decoding: data, as: UTF8.self)
    }

    static func run(_ arguments: [String], runner: Runner = RepoGit.process(),
                    git: () -> URL? = { Shell.which("git") },
                    isWorkTree: WorkTreeCheck = RepoGit.workTree(),
                    environment base: [String: String] = ProcessInfo.processInfo.environment,
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
            return missingStatus
        }
        let repo = arguments[0]
        let hardened = environment(base)
        let inside: Bool
        do {
            inside = try isWorkTree(executable, workTreeArguments(repo: repo), hardened)
        } catch {
            inside = false
            if isMissing(error) {
                stderr("recap \(commandName): git not found\n")
                return missingStatus
            }
        }
        guard inside else {
            stderr("recap \(commandName): not a git repository: \(repo)\n")
            return rejectedStatus
        }
        do {
            return try runner(executable, gitArguments, hardened)
        } catch where isMissing(error) {
            stderr("recap \(commandName): git not found\n")
            return missingStatus
        } catch let error as RecapError where error.code == "TIMEOUT" {
            stderr("recap \(commandName): \(error.message)\n")
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
            guard finished.wait(timeout: .now() + timeout) == .timedOut else { return status(of: process) }
            process.terminate()
            if finished.wait(timeout: .now() + Shell.killGrace) == .timedOut {
                kill(process.processIdentifier, SIGKILL)
                finished.wait()
            }
            throw RecapError("TIMEOUT", "git did not finish within \(Int(timeout)) seconds")
        }
    }

    static func isMissing(_ error: Error) -> Bool {
        let error = error as NSError
        return (error.domain == NSPOSIXErrorDomain && error.code == Int(ENOENT))
            || (error.domain == NSCocoaErrorDomain && error.code == NSFileNoSuchFileError)
    }

    static func status(of process: Process) -> Int32 {
        process.terminationReason == .uncaughtSignal ? signalBase + process.terminationStatus : process.terminationStatus
    }
}
