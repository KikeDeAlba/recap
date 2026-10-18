import Darwin
import Foundation

package struct ShellResult {
    package let status: Int32
    package let stdout: String
    package let stderr: String

    package init(status: Int32, stdout: String, stderr: String) {
        self.status = status
        self.stdout = stdout
        self.stderr = stderr
    }

    package var ok: Bool { status == 0 }
}

private final class RunState: @unchecked Sendable {
    private let lock = NSLock()
    private var timedOutFlag = false
    private var abandonedFlag = false

    var timedOut: Bool { lock.withLock { timedOutFlag } }
    var abandoned: Bool { lock.withLock { abandonedFlag } }

    func markTimedOut() { lock.withLock { timedOutFlag = true } }
    func abandon() { lock.withLock { abandonedFlag = true } }
}

package enum Shell {
    package static let searchPaths = ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin", "/usr/sbin", "/sbin"]

    package static func which(_ name: String) -> URL? {
        if name.contains("/") {
            return FileManager.default.isExecutableFile(atPath: name) ? URL(fileURLWithPath: name) : nil
        }
        let pathEntries = (ProcessInfo.processInfo.environment["PATH"] ?? "").split(separator: ":").map(String.init)
        let extra = [Paths.home.appending(path: ".local/bin").path]
        for dir in pathEntries + searchPaths + extra {
            let candidate = URL(fileURLWithPath: dir).appending(path: name)
            if FileManager.default.isExecutableFile(atPath: candidate.path) { return candidate }
        }
        return nil
    }

    package static func require(_ name: String, hint: String) throws -> URL {
        guard let url = which(name) else { throw RecapError("DEPENDENCY_MISSING", "\(name) not found. \(hint)") }
        return url
    }

    package static let killGrace: TimeInterval = 2
    static let drainGrace: TimeInterval = 0.5
    static let pollInterval: Int32 = 100

    @discardableResult
    package static func run(_ executable: URL, _ arguments: [String], stdin: Data? = nil,
                    environment: [String: String]? = nil, cwd: URL? = nil, timeout: TimeInterval? = nil) throws -> ShellResult {
        let process = Process()
        process.executableURL = executable
        process.arguments = arguments
        if let environment { process.environment = environment }
        if let cwd { process.currentDirectoryURL = cwd }
        let out = Pipe()
        let err = Pipe()
        process.standardOutput = out
        process.standardError = err
        let input = stdin == nil ? nil : Pipe()
        process.standardInput = input ?? FileHandle.nullDevice
        try process.run()
        let started = DispatchTime.now()
        let state = RunState()
        if let timeout {
            DispatchQueue.global().asyncAfter(deadline: started + timeout) {
                guard process.isRunning else { return }
                state.markTimedOut()
                process.terminate()
                DispatchQueue.global().asyncAfter(deadline: .now() + killGrace) {
                    guard process.isRunning else { return }
                    kill(process.processIdentifier, SIGKILL)
                }
            }
        }
        if let input, let stdin {
            let handle = input.fileHandleForWriting
            DispatchQueue.global().async {
                feed(stdin, to: handle, state: state)
                try? handle.close()
            }
        }
        var outData = Data()
        var errData = Data()
        let group = DispatchGroup()
        group.enter()
        DispatchQueue.global().async {
            outData = drain(out.fileHandleForReading, state: state)
            group.leave()
        }
        group.enter()
        DispatchQueue.global().async {
            errData = drain(err.fileHandleForReading, state: state)
            group.leave()
        }
        process.waitUntilExit()
        let limit: DispatchTime = state.timedOut
            ? .now() + drainGrace
            : timeout.map { started + $0 + killGrace } ?? .distantFuture
        if group.wait(timeout: limit) == .timedOut {
            state.abandon()
            group.wait()
        }
        state.abandon()
        if state.timedOut {
            throw RecapError("TIMEOUT", "\(executable.lastPathComponent) did not finish within \(Int(timeout ?? 0)) seconds")
        }
        return ShellResult(status: process.terminationStatus,
                           stdout: String(decoding: outData, as: UTF8.self),
                           stderr: String(decoding: errData, as: UTF8.self))
    }

    private static func nonBlocking(_ fd: Int32) {
        _ = fcntl(fd, F_SETFL, fcntl(fd, F_GETFL) | O_NONBLOCK)
    }

    private static func ready(_ fd: Int32, _ events: Int32) -> Bool {
        var descriptor = pollfd(fd: fd, events: Int16(events), revents: 0)
        return poll(&descriptor, 1, pollInterval) > 0
    }

    private static func feed(_ data: Data, to handle: FileHandle, state: RunState) {
        let fd = handle.fileDescriptor
        _ = fcntl(fd, F_SETNOSIGPIPE, 1)
        nonBlocking(fd)
        data.withUnsafeBytes { (buffer: UnsafeRawBufferPointer) in
            guard let base = buffer.baseAddress else { return }
            var offset = 0
            while offset < buffer.count, !state.abandoned {
                guard ready(fd, POLLOUT) else { continue }
                let written = Darwin.write(fd, base + offset, buffer.count - offset)
                if written > 0 {
                    offset += written
                } else if written < 0, errno != EAGAIN, errno != EINTR {
                    return
                }
            }
        }
    }

    private static func drain(_ handle: FileHandle, state: RunState) -> Data {
        let fd = handle.fileDescriptor
        nonBlocking(fd)
        var data = Data()
        var buffer = [UInt8](repeating: 0, count: 65_536)
        while !state.abandoned {
            guard ready(fd, POLLIN) else { continue }
            let count = Darwin.read(fd, &buffer, buffer.count)
            if count > 0 {
                data.append(buffer, count: count)
            } else if count == 0 || (errno != EAGAIN && errno != EINTR) {
                break
            }
        }
        try? handle.close()
        return data
    }

    package static func spawnDetached(_ executable: URL, _ arguments: [String], log: URL) throws -> pid_t {
        FileManager.default.createFile(atPath: log.path, contents: nil)
        var fileActions: posix_spawn_file_actions_t?
        posix_spawn_file_actions_init(&fileActions)
        defer { posix_spawn_file_actions_destroy(&fileActions) }
        posix_spawn_file_actions_addopen(&fileActions, 0, "/dev/null", O_RDONLY, 0)
        posix_spawn_file_actions_addopen(&fileActions, 1, log.path, O_WRONLY | O_APPEND | O_CREAT, 0o644)
        posix_spawn_file_actions_addopen(&fileActions, 2, log.path, O_WRONLY | O_APPEND | O_CREAT, 0o644)
        var attributes: posix_spawnattr_t?
        posix_spawnattr_init(&attributes)
        defer { posix_spawnattr_destroy(&attributes) }
        posix_spawnattr_setflags(&attributes, Int16(POSIX_SPAWN_SETSID))
        let argv = ([executable.path] + arguments).map { strdup($0) } + [nil]
        defer { argv.forEach { free($0) } }
        var pid: pid_t = 0
        let status = posix_spawn(&pid, executable.path, &fileActions, &attributes, argv, environ)
        guard status == 0 else {
            throw RecapError("SPAWN_FAILED", "Cannot start \(executable.lastPathComponent): \(String(cString: strerror(status)))")
        }
        return pid
    }
}
