import Foundation

package enum Deadline {
    private final class Outcome<T> {
        private let lock = NSLock()
        private var continuation: CheckedContinuation<T, Error>?
        private var result: Result<T, Error>?
        private var settled = false

        func attach(_ continuation: CheckedContinuation<T, Error>) {
            let ready = lock.withLock { () -> Result<T, Error>? in
                if let result { return result }
                self.continuation = continuation
                return nil
            }
            if let ready { continuation.resume(with: ready) }
        }

        @discardableResult
        func settle(_ outcome: Result<T, Error>) -> Bool {
            let (won, waiting) = lock.withLock { () -> (Bool, CheckedContinuation<T, Error>?) in
                guard !settled else { return (false, nil) }
                settled = true
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
                               _ operation: @escaping () async throws -> T) async throws -> T {
        let outcome = Outcome<T>()
        let work = Task {
            let result: Result<T, Error>
            do {
                result = .success(try await operation())
            } catch {
                result = .failure(error)
            }
            outcome.settle(result)
        }
        let timer = Task {
            try? await Task.sleep(nanoseconds: nanoseconds)
            guard !Task.isCancelled, outcome.settle(.failure(timeout())) else { return }
            work.cancel()
        }
        defer { timer.cancel() }
        return try await withTaskCancellationHandler {
            try await withCheckedThrowingContinuation { continuation in
                outcome.attach(continuation)
            }
        } onCancel: {
            if outcome.settle(.failure(CancellationError())) { work.cancel() }
        }
    }
}
