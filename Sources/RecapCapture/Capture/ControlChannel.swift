import Foundation

package protocol CaptureControlHandler: AnyObject {
    func setTarget(_ target: CaptureTargetRef) async throws -> CaptureStatus
    func clearTarget() async throws -> CaptureStatus
    func sources(thumbnails: Bool) async throws -> CaptureSources
}

package enum ControlAction: String, Codable {
    case set
    case clear
    case sources
}

package struct ControlRequest: Codable, Equatable {
    package var id: String
    package var action: ControlAction
    package var target: CaptureTargetRef?
    package var thumbnails: Bool?
    package var issuedAt: Double?

    package init(id: String, action: ControlAction, target: CaptureTargetRef? = nil, thumbnails: Bool? = nil,
                 issuedAt: Double? = nil) {
        self.id = id
        self.action = action
        self.target = target
        self.thumbnails = thumbnails
        self.issuedAt = issuedAt
    }

    package func isFresh(at now: Date, lifetime: TimeInterval) -> Bool {
        guard let issuedAt, issuedAt.isFinite else { return false }
        let age = now.timeIntervalSince1970 - issuedAt / 1000
        return abs(age) <= lifetime
    }
}

package enum ControlPayload: Encodable {
    case status(CaptureStatus)
    case sources(CaptureSources)

    package func encode(to encoder: Encoder) throws {
        switch self {
        case let .status(status): try status.encode(to: encoder)
        case let .sources(sources): try sources.encode(to: encoder)
        }
    }
}

package struct ControlReply: Encodable {
    package var id: String
    package var ok: Bool
    package var data: ControlPayload?
    package var error: ErrorBody?

    package static func success(_ id: String, _ data: ControlPayload) -> ControlReply {
        ControlReply(id: id, ok: true, data: data, error: nil)
    }

    package static func failure(_ id: String, _ error: Error) -> ControlReply {
        let failure = (error as? RecapError) ?? RecapError("UNEXPECTED", String(describing: error))
        return ControlReply(id: id, ok: false, data: nil, error: ErrorBody(code: failure.code, message: failure.message))
    }
}

package enum ControlFiles {
    package static let maxRequestBytes = 4096

    package static func prepare(_ directory: URL) throws {
        if !isPrivateDirectory(directory) { discard(directory) }
        if mkdir(directory.path, 0o700) != 0, errno != EEXIST {
            throw RecapError("CONTROL_SETUP", "Cannot create \(directory.path): \(String(cString: strerror(errno)))")
        }
        guard isPrivateDirectory(directory), chmod(directory.path, 0o700) == 0 else {
            throw RecapError("CONTROL_SETUP", "\(directory.path) is not a private directory of this user")
        }
        clear(directory)
    }

    package static func isPrivateDirectory(_ directory: URL) -> Bool {
        var info = stat()
        return lstat(directory.path, &info) == 0 && (info.st_mode & S_IFMT) == S_IFDIR && info.st_uid == getuid()
    }

    package static func clear(_ directory: URL, keep: (String, Date) -> Bool = { _, _ in false }) {
        let names = (try? FileManager.default.contentsOfDirectory(atPath: directory.path)) ?? []
        for name in names {
            var info = stat()
            let path = directory.appending(path: name).path
            guard lstat(path, &info) == 0 else { continue }
            let modified = Date(timeIntervalSince1970: TimeInterval(info.st_mtimespec.tv_sec))
            if keep(name, modified) { continue }
            discard(directory.appending(path: name))
        }
    }

    package static func discard(_ url: URL) {
        var info = stat()
        guard lstat(url.path, &info) == 0 else { return }
        if (info.st_mode & S_IFMT) == S_IFDIR {
            try? FileManager.default.removeItem(at: url)
        } else {
            unlink(url.path)
        }
    }

    package static func readRequest(_ url: URL) -> Data? {
        let descriptor = open(url.path, O_RDONLY | O_NOFOLLOW | O_NONBLOCK)
        guard descriptor >= 0 else { return nil }
        defer { close(descriptor) }
        var info = stat()
        guard fstat(descriptor, &info) == 0, (info.st_mode & S_IFMT) == S_IFREG, info.st_uid == getuid(),
              info.st_size <= maxRequestBytes else { return nil }
        var buffer = [UInt8](repeating: 0, count: maxRequestBytes + 1)
        var total = 0
        while total < buffer.count {
            let count = buffer.withUnsafeMutableBytes { read(descriptor, $0.baseAddress! + total, $0.count - total) }
            if count < 0, errno == EINTR { continue }
            guard count > 0 else { break }
            total += count
        }
        guard total <= maxRequestBytes else { return nil }
        return Data(buffer.prefix(total))
    }

    package static func writePrivately(_ data: Data, to target: URL) throws {
        let directory = target.deletingLastPathComponent()
        let temporary = directory.appending(path: ".\(UUID().uuidString).tmp")
        let descriptor = open(temporary.path, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW, 0o600)
        guard descriptor >= 0 else {
            throw RecapError("CONTROL_WRITE", String(cString: strerror(errno)))
        }
        var written = 0
        let ok = data.withUnsafeBytes { bytes -> Bool in
            while written < bytes.count {
                let count = write(descriptor, bytes.baseAddress! + written, bytes.count - written)
                if count < 0, errno == EINTR { continue }
                guard count > 0 else { return false }
                written += count
            }
            return true
        }
        close(descriptor)
        guard ok, rename(temporary.path, target.path) == 0 else {
            let message = String(cString: strerror(errno))
            unlink(temporary.path)
            throw RecapError("CONTROL_WRITE", message)
        }
    }
}

package final class ControlServer {
    package static let directoryName = "control"
    package static let requestSuffix = ".request.json"
    package static let responseSuffix = ".response.json"
    package static let requestLifetime: TimeInterval = 30
    package static let responseLifetime: TimeInterval = 60
    package static let notRecording = RecapError("NOT_RECORDING", "The recording is stopping")
    package static let controlReplaced = RecapError("CONTROL_REPLACED", "The control folder of the recording was replaced; send the request again")
    package static let maxLookups = 2
    package static let maxAbandonedLookups = 4
    package static let lookupTimeout: TimeInterval = 25
    package static let busy = RecapError("BUSY", "Recap.app is already listing the sources for other requests; try again in a moment")
    package static let stuck = RecapError("BUSY", "Recap.app is still waiting for earlier source lookups that did not finish; try again in a moment")

    private let directory: URL
    private weak var handler: CaptureControlHandler?
    private let interval: TimeInterval
    private let lookupTimeout: TimeInterval
    private let lookupLimit: Int
    private let abandoned: AbandonedWork
    private let now: () -> Date
    private let queue = DispatchQueue(label: "recap.capture-control")
    private let lock = NSLock()
    private var timer: DispatchSourceTimer?
    private var busy = false
    private var stopped = false
    private var lookups: [UUID: Task<Void, Never>] = [:]

    package init(meetingDir: URL, handler: CaptureControlHandler, interval: TimeInterval = 0.1,
                 lookupTimeout: TimeInterval = ControlServer.lookupTimeout, maxLookups: Int = ControlServer.maxLookups,
                 maxAbandonedLookups: Int = ControlServer.maxAbandonedLookups, now: @escaping () -> Date = Date.init) {
        directory = Self.directory(meetingDir)
        self.handler = handler
        self.interval = interval
        self.lookupTimeout = lookupTimeout
        lookupLimit = max(1, maxLookups)
        abandoned = AbandonedWork(limit: maxAbandonedLookups)
        self.now = now
    }

    package static func directory(_ meetingDir: URL) -> URL {
        meetingDir.appending(path: directoryName)
    }

    package static func isValidId(_ id: String) -> Bool {
        !id.isEmpty && id.count <= 64 && id.allSatisfy { $0.isASCII && ($0.isLetter || $0.isNumber || $0 == "-") }
    }

    package static func responseURL(_ meetingDir: URL, id: String) -> URL {
        directory(meetingDir).appending(path: id + responseSuffix)
    }

    package func start() throws {
        try ControlFiles.prepare(directory)
        let timer = DispatchSource.makeTimerSource(queue: queue)
        timer.schedule(deadline: .now(), repeating: interval)
        timer.setEventHandler { [weak self] in self?.tick() }
        lock.withLock { self.timer = timer }
        timer.resume()
    }

    package func stop() {
        lock.withLock {
            stopped = true
            timer?.cancel()
            timer = nil
        }
        guard sweep() else { return }
        for url in pendingRequests() {
            reject(url, with: Self.notRecording)
        }
    }

    private func tick() {
        let proceed = lock.withLock { () -> Bool in
            guard !busy, !stopped else { return false }
            busy = true
            return true
        }
        guard proceed else { return }
        Task {
            await self.pollCommands()
            self.lock.withLock { self.busy = false }
        }
    }

    package func pendingRequests() -> [URL] {
        let names = (try? FileManager.default.contentsOfDirectory(atPath: directory.path)) ?? []
        return names
            .filter { !$0.hasPrefix(".") && $0.hasSuffix(Self.requestSuffix) }
            .sorted()
            .map { directory.appending(path: $0) }
    }

    package func poll() async {
        await pollCommands()
        await waitForLookups()
    }

    package var abandonedLookups: Int { abandoned.count }

    package func waitForLookups() async {
        let running = lock.withLock { Array(lookups.values) }
        for task in running { await task.value }
    }

    package func pollCommands() async {
        guard sweep() else { return }
        var commands: [ControlRequest] = []
        for url in pendingRequests() {
            if lock.withLock({ stopped }) { return }
            guard let request = take(url) else { continue }
            if request.action == .sources {
                lookup(request)
            } else {
                commands.append(request)
            }
        }
        for request in commands {
            if lock.withLock({ stopped }) {
                write(.failure(request.id, Self.notRecording))
                continue
            }
            await handle(request)
        }
    }

    private func requestId(_ url: URL) -> String {
        String(url.lastPathComponent.dropLast(Self.requestSuffix.count))
    }

    private func take(_ url: URL) -> ControlRequest? {
        let fileId = requestId(url)
        let data = ControlFiles.readRequest(url)
        ControlFiles.discard(url)
        guard Self.isValidId(fileId) else { return nil }
        guard let data, let request = try? JSONDecoder().decode(ControlRequest.self, from: data), request.id == fileId else {
            write(.failure(fileId, RecapError("CONTROL_INVALID", "The capture request \(url.lastPathComponent) is not valid")))
            return nil
        }
        guard request.isFresh(at: now(), lifetime: Self.requestLifetime) else {
            write(.failure(fileId, RecapError("CONTROL_EXPIRED", "The capture request \(fileId) is older than \(Int(Self.requestLifetime))s")))
            return nil
        }
        return request
    }

    private func lookup(_ request: ControlRequest) {
        let key = UUID()
        let handler = self.handler
        let timeout = lookupTimeout
        let abandoned = self.abandoned
        let thumbnails = request.thumbnails ?? false
        let refusal = lock.withLock { () -> RecapError? in
            guard lookups.count < lookupLimit else { return Self.busy }
            guard !abandoned.isSaturated else { return Self.stuck }
            lookups[key] = Task { [weak self] in
                guard let self else { return }
                if let handler {
                    do {
                        let sources = try await Deadline.run(within: UInt64(timeout * 1_000_000_000),
                                                             onTimeout: Self.lookupExpired(timeout, thumbnails: thumbnails),
                                                             abandoned: abandoned) {
                            try await handler.sources(thumbnails: thumbnails)
                        }
                        self.write(.success(request.id, .sources(sources)))
                    } catch {
                        self.write(.failure(request.id, error))
                    }
                } else {
                    self.write(.failure(request.id, Self.notRecording))
                }
                _ = self.lock.withLock { self.lookups.removeValue(forKey: key) }
            }
            return nil
        }
        if let refusal { write(.failure(request.id, refusal)) }
    }

    package static func lookupExpired(_ timeout: TimeInterval, thumbnails: Bool) -> RecapError {
        let advice = thumbnails ? "try again without thumbnails" : "try again in a moment"
        return RecapError("CAPTURE_TIMEOUT", "Recap.app took more than \(Int(timeout))s to list the sources; \(advice)")
    }

    private func handle(_ request: ControlRequest) async {
        guard let handler else {
            write(.failure(request.id, Self.notRecording))
            return
        }
        do {
            switch request.action {
            case .set:
                guard let target = request.target else {
                    throw RecapError("CONTROL_INVALID", "The set request has no target")
                }
                write(.success(request.id, .status(try await handler.setTarget(target))))
            case .clear:
                write(.success(request.id, .status(try await handler.clearTarget())))
            case .sources:
                write(.success(request.id, .sources(try await handler.sources(thumbnails: request.thumbnails ?? false))))
            }
        } catch {
            write(.failure(request.id, error))
        }
    }

    private func reject(_ url: URL, with error: RecapError) {
        let id = requestId(url)
        ControlFiles.discard(url)
        guard Self.isValidId(id) else { return }
        write(.failure(id, error))
    }

    @discardableResult
    package func sweep() -> Bool {
        guard ControlFiles.isPrivateDirectory(directory) else {
            let waiting = pendingRequests().map(requestId).filter(Self.isValidId)
            guard (try? ControlFiles.prepare(directory)) != nil else { return false }
            for id in waiting { write(.failure(id, Self.controlReplaced)) }
            return false
        }
        let horizon = now().addingTimeInterval(-Self.responseLifetime)
        ControlFiles.clear(directory) { name, modified in
            (name.hasSuffix(Self.requestSuffix) && !name.hasPrefix(".")) || modified >= horizon
        }
        return true
    }

    private func write(_ reply: ControlReply) {
        guard let data = try? Output.compactEncoder.encode(reply) else { return }
        try? ControlFiles.writePrivately(data, to: directory.appending(path: reply.id + Self.responseSuffix))
    }
}
