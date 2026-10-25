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

    package init(id: String, action: ControlAction, target: CaptureTargetRef? = nil, thumbnails: Bool? = nil) {
        self.id = id
        self.action = action
        self.target = target
        self.thumbnails = thumbnails
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

package final class ControlServer {
    package static let directoryName = "control"
    package static let requestSuffix = ".request.json"
    package static let responseSuffix = ".response.json"
    package static let notRecording = RecapError("NOT_RECORDING", "The recording is stopping")

    private let directory: URL
    private weak var handler: CaptureControlHandler?
    private let interval: TimeInterval
    private let queue = DispatchQueue(label: "recap.capture-control")
    private let lock = NSLock()
    private var timer: DispatchSourceTimer?
    private var busy = false
    private var stopped = false

    package init(meetingDir: URL, handler: CaptureControlHandler, interval: TimeInterval = 0.1) {
        directory = Self.directory(meetingDir)
        self.handler = handler
        self.interval = interval
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
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
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
            await self.poll()
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
        for url in pendingRequests() {
            if lock.withLock({ stopped }) { return }
            await handle(url)
        }
    }

    private func requestId(_ url: URL) -> String {
        String(url.lastPathComponent.dropLast(Self.requestSuffix.count))
    }

    private func handle(_ url: URL) async {
        let fileId = requestId(url)
        let data = try? Data(contentsOf: url)
        try? FileManager.default.removeItem(at: url)
        guard Self.isValidId(fileId) else { return }
        guard let data, let request = try? JSONDecoder().decode(ControlRequest.self, from: data), request.id == fileId else {
            write(.failure(fileId, RecapError("CONTROL_INVALID", "The capture request \(url.lastPathComponent) is not valid")))
            return
        }
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
        try? FileManager.default.removeItem(at: url)
        guard Self.isValidId(id) else { return }
        write(.failure(id, error))
    }

    private func write(_ reply: ControlReply) {
        guard let data = try? Output.compactEncoder.encode(reply) else { return }
        let target = directory.appending(path: reply.id + Self.responseSuffix)
        let temporary = directory.appending(path: ".\(reply.id).response.tmp")
        do {
            try data.write(to: temporary)
            guard rename(temporary.path, target.path) == 0 else {
                throw RecapError("CONTROL_WRITE", String(cString: strerror(errno)))
            }
        } catch {
            try? FileManager.default.removeItem(at: temporary)
        }
    }
}
