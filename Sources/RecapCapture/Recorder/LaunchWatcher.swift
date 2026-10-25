import AppKit
import Foundation

package enum LaunchVerdict: Equatable {
    case ignore
    case refresh
    case retry
}

package protocol LaunchedApplication {
    var bundleIdentifier: String? { get }
    var processIdentifier: pid_t { get }
    var executableURL: URL? { get }
}

extension NSRunningApplication: LaunchedApplication {}

package final class LaunchWatcher {
    private let center: NotificationCenter
    private let retryDelay: UInt64
    private let ownPid: Int32
    private let refresh: @MainActor () async -> Void
    private let lock = NSLock()
    private var observer: NSObjectProtocol?

    package init(center: NotificationCenter = NSWorkspace.shared.notificationCenter, retryDelay: UInt64,
                 ownPid: Int32 = getpid(), refresh: @escaping @MainActor () async -> Void) {
        self.center = center
        self.retryDelay = retryDelay
        self.ownPid = ownPid
        self.refresh = refresh
    }

    deinit {
        stop()
    }

    package static func verdict(bundleId: String?, pid: Int32, executable: String?, ownPid: Int32 = getpid()) -> LaunchVerdict {
        let bundle = bundleId ?? ""
        if SourceCatalog.isExcludedApplication(bundleId: bundle, pid: pid, ownPid: ownPid, executable: executable) {
            return .refresh
        }
        return bundle.isEmpty && executable == nil ? .retry : .ignore
    }

    package static func verdict(_ app: LaunchedApplication, ownPid: Int32 = getpid()) -> LaunchVerdict {
        verdict(bundleId: app.bundleIdentifier, pid: app.processIdentifier, executable: app.executableURL?.path, ownPid: ownPid)
    }

    package func start() {
        let added = center.addObserver(forName: NSWorkspace.didLaunchApplicationNotification, object: nil, queue: nil) {
            [weak self] notification in
            guard let self,
                  let app = notification.userInfo?[NSWorkspace.applicationUserInfoKey] as? LaunchedApplication else { return }
            self.handle(Self.verdict(app, ownPid: self.ownPid))
        }
        let previous = lock.withLock { () -> NSObjectProtocol? in
            defer { observer = added }
            return observer
        }
        if let previous { center.removeObserver(previous) }
    }

    package func stop() {
        let current = lock.withLock { () -> NSObjectProtocol? in
            defer { observer = nil }
            return observer
        }
        if let current { center.removeObserver(current) }
    }

    package func handle(_ verdict: LaunchVerdict) {
        guard verdict != .ignore else { return }
        let refresh = self.refresh
        let delay = retryDelay
        Task { @MainActor in
            if verdict == .refresh { await refresh() }
            try? await Task.sleep(nanoseconds: delay)
            await refresh()
        }
    }
}
