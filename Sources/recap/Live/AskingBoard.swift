import Darwin
import Foundation

enum AskPhase: String, Codable, Equatable {
    case queued
    case running
}

struct AskingState: Codable, Equatable {
    var id: String?
    var question: String?
    var startedAt: Date
    var auto: Bool
    var questionMs: Int?
    var channel: Channel?
    var state: AskPhase?
    var pid: Int32?

    private enum CodingKeys: String, CodingKey {
        case id, question, startedAt, auto, questionMs, channel, state, pid
    }

    init(id: String? = nil, question: String?, startedAt: Date, auto: Bool, questionMs: Int? = nil, channel: Channel? = nil,
         state: AskPhase? = nil, pid: Int32? = nil) {
        self.id = id
        self.question = question
        self.startedAt = startedAt
        self.auto = auto
        self.questionMs = questionMs
        self.channel = channel
        self.state = state
        self.pid = pid
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        id = try container.decodeIfPresent(String.self, forKey: .id)
        question = try container.decodeIfPresent(String.self, forKey: .question)
        startedAt = try container.decode(Date.self, forKey: .startedAt)
        auto = try container.decodeIfPresent(Bool.self, forKey: .auto) ?? false
        questionMs = try container.decodeIfPresent(Int.self, forKey: .questionMs)
        channel = try? container.decodeIfPresent(Channel.self, forKey: .channel)
        state = try? container.decodeIfPresent(AskPhase.self, forKey: .state)
        pid = try? container.decodeIfPresent(Int32.self, forKey: .pid)
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encodeIfPresent(id, forKey: .id)
        try container.encode(question, forKey: .question)
        try container.encode(startedAt, forKey: .startedAt)
        try container.encode(auto, forKey: .auto)
        try container.encodeIfPresent(questionMs, forKey: .questionMs)
        try container.encodeIfPresent(channel, forKey: .channel)
        try container.encodeIfPresent(state, forKey: .state)
        try container.encodeIfPresent(pid, forKey: .pid)
    }

    var isRunning: Bool { state != .queued }

    static func read(_ meetingDir: URL) -> AskingState? {
        guard let data = try? Data(contentsOf: LiveFiles.asking(meetingDir)) else { return nil }
        return try? JSONLines.decoder.decode(AskingState.self, from: data)
    }
}

enum AskID {
    static func make() -> String {
        UUID().uuidString.lowercased()
    }

    static func isValid(_ id: String) -> Bool {
        !id.isEmpty && id.count <= 64 && !id.hasPrefix("-")
            && id.unicodeScalars.allSatisfy { ("a"..."z").contains($0) || ("0"..."9").contains($0) || $0 == "-" }
    }
}

enum AskingBoard {
    static let lockName = ".lock"

    static func file(_ meetingDir: URL, id: String) -> URL {
        LiveFiles.askingDir(meetingDir).appending(path: "\(id).json")
    }

    static func write(_ meetingDir: URL, _ state: AskingState) throws {
        guard let id = state.id, AskID.isValid(id) else {
            throw RecapError("ASK_ID_INVALID", "Invalid ask id \(state.id ?? "(none)")")
        }
        try locked(meetingDir) {
            try JSONLines.encoder.encode(state).write(to: file(meetingDir, id: id), options: .atomic)
            refreshLegacy(meetingDir)
        }
    }

    static func remove(_ meetingDir: URL, id: String) {
        guard AskID.isValid(id) else { return }
        try? locked(meetingDir) {
            try? FileManager.default.removeItem(at: file(meetingDir, id: id))
            refreshLegacy(meetingDir)
        }
    }

    static func entries(_ meetingDir: URL) -> [AskingState] {
        stored(meetingDir).filter(\.alive).map(\.state)
    }

    static func prune(_ meetingDir: URL) {
        guard FileManager.default.fileExists(atPath: LiveFiles.askingDir(meetingDir).path) else { return }
        try? locked(meetingDir) {
            for entry in stored(meetingDir) where !entry.alive {
                try? FileManager.default.removeItem(at: entry.url)
            }
            refreshLegacy(meetingDir)
        }
    }

    static func latestRunning(_ entries: [AskingState]) -> AskingState? {
        entries.filter(\.isRunning).enumerated().max { left, right in
            left.element.startedAt == right.element.startedAt ? left.offset < right.offset : left.element.startedAt < right.element.startedAt
        }?.element
    }

    private static func refreshLegacy(_ meetingDir: URL) {
        let legacy = LiveFiles.asking(meetingDir)
        guard let latest = latestRunning(entries(meetingDir)), let data = try? JSONLines.encoder.encode(latest) else {
            try? FileManager.default.removeItem(at: legacy)
            return
        }
        try? data.write(to: legacy, options: .atomic)
    }

    private static func stored(_ meetingDir: URL) -> [(url: URL, state: AskingState, alive: Bool)] {
        let folder = LiveFiles.askingDir(meetingDir)
        let names = ((try? FileManager.default.contentsOfDirectory(atPath: folder.path)) ?? [])
            .filter { $0.hasSuffix(".json") && !$0.hasPrefix(".") }
        let found: [(url: URL, modified: Date, state: AskingState, alive: Bool)] = names.compactMap { name in
            let url = folder.appending(path: name)
            guard let data = try? Data(contentsOf: url),
                  let state = try? JSONLines.decoder.decode(AskingState.self, from: data) else { return nil }
            let attributes = try? FileManager.default.attributesOfItem(atPath: url.path)
            let modified = attributes?[.modificationDate] as? Date ?? .distantPast
            return (url, modified, state, state.pid.map(ProcessCheck.isAlive) ?? true)
        }
        return found.sorted { $0.modified == $1.modified ? $0.url.path < $1.url.path : $0.modified < $1.modified }
            .map { ($0.url, $0.state, $0.alive) }
    }

    static func locked<T>(_ meetingDir: URL, _ body: () throws -> T) throws -> T {
        let folder = LiveFiles.askingDir(meetingDir)
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        let descriptor = open(folder.appending(path: lockName).path, O_RDWR | O_CREAT, 0o644)
        guard descriptor >= 0 else {
            throw RecapError("WRITE_FAILED", "Cannot open the asking lock in \(folder.path): \(String(cString: strerror(errno)))")
        }
        defer { close(descriptor) }
        flock(descriptor, LOCK_EX)
        defer { flock(descriptor, LOCK_UN) }
        return try body()
    }
}

enum ProcessTree {
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
    static func perform(dir: URL, id: String = AskID.make(), question: String?, auto: Bool, now: Date = Date(),
                        questionMs: Int? = nil, channel: Channel? = nil, pid: Int32 = getpid(),
                        body: () throws -> Answer) throws -> Answer {
        let state = AskingState(id: id, question: question?.trimmed.isEmpty == false ? question?.trimmed : nil,
                                startedAt: now, auto: auto, questionMs: questionMs, channel: channel, state: .running, pid: pid)
        try AskingBoard.write(dir, state)
        defer { AskingBoard.remove(dir, id: id) }
        return try body()
    }
}

final class AskSignalCleanup {
    private static var sources: [DispatchSourceSignal] = []

    static func install(dir: URL, id: String) {
        for value in [SIGTERM, SIGINT, SIGHUP] {
            Darwin.signal(value, SIG_IGN)
            let source = DispatchSource.makeSignalSource(signal: value, queue: .global())
            source.setEventHandler {
                for child in ProcessTree.descendants(of: getpid()) { kill(child, SIGKILL) }
                AskingBoard.remove(dir, id: id)
                exit(128 + value)
            }
            source.resume()
            sources.append(source)
        }
    }
}
