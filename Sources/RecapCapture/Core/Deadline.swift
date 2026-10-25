import Foundation

package final class AbandonedWork {
    package let limit: Int
    private let lock = NSLock()
    private var running = 0

    package init(limit: Int) {
        self.limit = max(1, limit)
    }

    package var count: Int { lock.withLock { running } }

    package var isSaturated: Bool { count >= limit }

    fileprivate func abandon() {
        lock.withLock { running += 1 }
    }

    fileprivate func finish() {
        lock.withLock { running = max(0, running - 1) }
    }
}

package final class CaptureSlots {
    package let limit: Int
    private let lock = NSLock()
    private var used = 0

    package init(limit: Int) {
        self.limit = max(1, limit)
    }

    package var inUse: Int { lock.withLock { used } }

    package func tryAcquire() -> Bool {
        lock.withLock {
            guard used < limit else { return false }
            used += 1
            return true
        }
    }

    package func acquire(waiting nanoseconds: UInt64, pause: UInt64 = 20_000_000) async -> Bool {
        let deadline = DispatchTime.now().uptimeNanoseconds &+ nanoseconds
        while true {
            if tryAcquire() { return true }
            guard !Task.isCancelled, DispatchTime.now().uptimeNanoseconds < deadline else { return false }
            try? await Task.sleep(nanoseconds: pause)
        }
    }

    package func release() {
        lock.withLock { used = max(0, used - 1) }
    }
}

package enum Deadline {
    private final class Outcome<T> {
        private let lock = NSLock()
        private let abandoned: AbandonedWork?
        private var continuation: CheckedContinuation<T, Error>?
        private var result: Result<T, Error>?
        private var settled = false

        init(abandoned: AbandonedWork?) {
            self.abandoned = abandoned
        }

        func attach(_ continuation: CheckedContinuation<T, Error>) {
            let ready = lock.withLock { () -> Result<T, Error>? in
                if let result { return result }
                self.continuation = continuation
                return nil
            }
            if let ready { continuation.resume(with: ready) }
        }

        @discardableResult
        func settle(_ outcome: Result<T, Error>, abandoning: Bool) -> Bool {
            let (won, waiting) = lock.withLock { () -> (Bool, CheckedContinuation<T, Error>?) in
                guard !settled else {
                    if !abandoning { abandoned?.finish() }
                    return (false, nil)
                }
                settled = true
                if abandoning { abandoned?.abandon() }
                let waiting = continuation
                continuation = nil
                if waiting == nil { result = outcome }
                return (true, waiting)
            }
            waiting?.resume(with: outcome)
            return won
        }
    }

    package static func run<T>(within nanoseconds: UInt64, onTimeout timeout: @autoclosure @escaping () -> Error,
                               abandoned: AbandonedWork? = nil,
                               _ operation: @escaping () async throws -> T) async throws -> T {
        guard !Task.isCancelled else { throw CancellationError() }
        let outcome = Outcome<T>(abandoned: abandoned)
        let work = Task {
            let result: Result<T, Error>
            do {
                result = .success(try await operation())
            } catch {
                result = .failure(error)
            }
            outcome.settle(result, abandoning: false)
        }
        let timer = Task {
            try? await Task.sleep(nanoseconds: nanoseconds)
            guard !Task.isCancelled, outcome.settle(.failure(timeout()), abandoning: true) else { return }
            work.cancel()
        }
        defer { timer.cancel() }
        return try await withTaskCancellationHandler {
            try await withCheckedThrowingContinuation { continuation in
                outcome.attach(continuation)
            }
        } onCancel: {
            if outcome.settle(.failure(CancellationError()), abandoning: true) { work.cancel() }
        }
    }
}
