import Darwin
import Foundation

struct AskLockHolder: Codable, Equatable {
    var pid: Int32
    var auto: Bool
    var startedAt: Date
}

struct AskingState: Codable, Equatable {
    var question: String?
    var startedAt: Date
    var auto: Bool
    var questionMs: Int?
    var channel: Channel?

    private enum CodingKeys: String, CodingKey {
        case question, startedAt, auto, questionMs, channel
    }

    init(question: String?, startedAt: Date, auto: Bool, questionMs: Int? = nil, channel: Channel? = nil) {
        self.question = question
        self.startedAt = startedAt
        self.auto = auto
        self.questionMs = questionMs
        self.channel = channel
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        question = try container.decodeIfPresent(String.self, forKey: .question)
        startedAt = try container.decode(Date.self, forKey: .startedAt)
        auto = try container.decodeIfPresent(Bool.self, forKey: .auto) ?? false
        questionMs = try container.decodeIfPresent(Int.self, forKey: .questionMs)
        channel = try? container.decodeIfPresent(Channel.self, forKey: .channel)
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(question, forKey: .question)
        try container.encode(startedAt, forKey: .startedAt)
        try container.encode(auto, forKey: .auto)
        try container.encodeIfPresent(questionMs, forKey: .questionMs)
        try container.encodeIfPresent(channel, forKey: .channel)
    }

    static func read(_ meetingDir: URL) -> AskingState? {
        guard let data = try? Data(contentsOf: LiveFiles.asking(meetingDir)) else { return nil }
        return try? JSONLines.decoder.decode(AskingState.self, from: data)
    }
}

final class AskLock {
    static let unwrittenGraceSeconds: TimeInterval = 5
    static let attempts = 20

    let url: URL
    let holder: AskLockHolder

    private init(url: URL, holder: AskLockHolder) {
        self.url = url
        self.holder = holder
    }

    static func current(_ meetingDir: URL) -> AskLockHolder? {
        guard let data = try? Data(contentsOf: LiveFiles.askLock(meetingDir)) else { return nil }
        return try? JSONLines.decoder.decode(AskLockHolder.self, from: data)
    }

    static func isHeld(_ meetingDir: URL) -> Bool {
        guard let holder = current(meetingDir) else {
            return FileManager.default.fileExists(atPath: LiveFiles.askLock(meetingDir).path) && !isAbandoned(meetingDir)
        }
        return ProcessCheck.isAlive(holder.pid)
    }

    static func acquire(_ meetingDir: URL, auto: Bool, pid: Int32 = getpid(), now: Date = Date(),
                        terminate: (Int32) -> Void = AskLock.terminate) throws -> AskLock? {
        let url = LiveFiles.askLock(meetingDir)
        try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        let holder = AskLockHolder(pid: pid, auto: auto, startedAt: Date(timeIntervalSince1970: now.timeIntervalSince1970.rounded(.down)))
        let payload = try JSONLines.encoder.encode(holder)
        for _ in 0..<attempts {
            let descriptor = open(url.path, O_WRONLY | O_CREAT | O_EXCL, 0o644)
            if descriptor >= 0 {
                let written = payload.withUnsafeBytes { write(descriptor, $0.baseAddress, $0.count) }
                close(descriptor)
                guard written == payload.count else {
                    try? FileManager.default.removeItem(at: url)
                    throw RecapError("WRITE_FAILED", "Cannot write \(url.path)")
                }
                return AskLock(url: url, holder: holder)
            }
            guard errno == EEXIST else {
                throw RecapError("WRITE_FAILED", "Cannot create \(url.path): \(String(cString: strerror(errno)))")
            }
            guard let existing = current(meetingDir) else {
                if isAbandoned(meetingDir) {
                    try? FileManager.default.removeItem(at: url)
                    continue
                }
                if auto { return nil }
                Thread.sleep(forTimeInterval: 0.1)
                continue
            }
            if existing.pid == pid || !ProcessCheck.isAlive(existing.pid) {
                removeIfHeld(by: existing, meetingDir: meetingDir)
                continue
            }
            if auto { return nil }
            terminate(existing.pid)
            removeIfHeld(by: existing, meetingDir: meetingDir)
        }
        if auto { return nil }
        throw RecapError("ASK_BUSY", "Another answer is in progress for this meeting")
    }

    func release() {
        guard isOwned else { return }
        try? FileManager.default.removeItem(at: url)
    }

    var isOwned: Bool {
        AskLock.current(url.deletingLastPathComponent().deletingLastPathComponent())?.pid == holder.pid
    }

    static func removeIfHeld(by holder: AskLockHolder, meetingDir: URL) {
        guard current(meetingDir)?.pid == holder.pid else { return }
        try? FileManager.default.removeItem(at: LiveFiles.askLock(meetingDir))
    }

    static func isAbandoned(_ meetingDir: URL) -> Bool {
        let attributes = try? FileManager.default.attributesOfItem(atPath: LiveFiles.askLock(meetingDir).path)
        guard let modified = attributes?[.modificationDate] as? Date else { return true }
        return Date().timeIntervalSince(modified) > unwrittenGraceSeconds
    }

    static func terminate(_ pid: Int32) {
        signal(pid, SIGTERM)
        if ProcessCheck.waitUntil(timeout: 3, interval: 0.05, { !ProcessCheck.isAlive(pid) }) { return }
        signal(pid, SIGKILL)
        _ = ProcessCheck.waitUntil(timeout: 1, interval: 0.05) { !ProcessCheck.isAlive(pid) }
    }

    static func signal(_ pid: Int32, _ value: Int32) {
        guard pid > 1, pid != getpid() else { return }
        for child in descendants(of: pid) where child != getpid() { kill(child, value) }
        kill(pid, value)
    }

    static func descendants(of pid: Int32) -> [Int32] {
        var buffer = [pid_t](repeating: 0, count: 256)
        let count = buffer.withUnsafeMutableBytes { raw in
            proc_listchildpids(pid, raw.baseAddress, Int32(raw.count))
        }
        guard count > 0 else { return [] }
        let children = buffer.prefix(min(Int(count), buffer.count)).filter { $0 > 1 }
        return children.flatMap { descendants(of: $0) + [$0] }
    }
}

enum AskCoordinator {
    static func perform(dir: URL, question: String?, auto: Bool, now: Date = Date(),
                        questionMs: Int? = nil, channel: Channel? = nil,
                        terminate: (Int32) -> Void = AskLock.terminate,
                        body: () throws -> Answer) throws -> Answer {
        guard let lock = try AskLock.acquire(dir, auto: auto, now: now, terminate: terminate) else {
            throw RecapError("ASK_BUSY", "Another answer is in progress for this meeting")
        }
        let asking = LiveFiles.asking(dir)
        defer {
            if lock.isOwned { try? FileManager.default.removeItem(at: asking) }
            lock.release()
        }
        let state = AskingState(question: question?.trimmed.isEmpty == false ? question?.trimmed : nil,
                                startedAt: now, auto: auto, questionMs: questionMs, channel: channel)
        try JSONLines.encoder.encode(state).write(to: asking, options: .atomic)
        return try body()
    }

    static func clearAbandoned(dir: URL, pid: Int32) {
        guard let holder = AskLock.current(dir), holder.pid == pid else { return }
        try? FileManager.default.removeItem(at: LiveFiles.asking(dir))
        AskLock.removeIfHeld(by: holder, meetingDir: dir)
    }
}
