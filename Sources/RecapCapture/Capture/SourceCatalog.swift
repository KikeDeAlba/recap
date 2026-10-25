import AppKit
import CoreGraphics
import Foundation
import ImageIO
import ScreenCaptureKit
import UniformTypeIdentifiers

package struct DisplaySource: Codable, Equatable {
    package var id: UInt32
    package var name: String
    package var width: Int
    package var height: Int
    package var main: Bool
    package var thumbnail: String?

    package init(id: UInt32, name: String, width: Int, height: Int, main: Bool, thumbnail: String? = nil) {
        self.id = id
        self.name = name
        self.width = width
        self.height = height
        self.main = main
        self.thumbnail = thumbnail
    }
}

package struct WindowSource: Codable, Equatable {
    package var id: UInt32
    package var app: String
    package var bundleId: String
    package var title: String
    package var pid: Int32
    package var width: Int
    package var height: Int
    package var thumbnail: String?

    package init(id: UInt32, app: String, bundleId: String, title: String, pid: Int32, width: Int, height: Int,
                 thumbnail: String? = nil) {
        self.id = id
        self.app = app
        self.bundleId = bundleId
        self.title = title
        self.pid = pid
        self.width = width
        self.height = height
        self.thumbnail = thumbnail
    }
}

package struct CaptureSources: Codable, Equatable {
    package var displays: [DisplaySource]
    package var windows: [WindowSource]

    package init(displays: [DisplaySource], windows: [WindowSource]) {
        self.displays = displays
        self.windows = windows
    }

    package var text: String {
        let displayLines = displays.map { "display \($0.id)\($0.main ? " (main)" : ""): \($0.name) \($0.width)x\($0.height)" }
        let windowLines = windows.map { "window \($0.id): \($0.app) — \($0.title)" }
        return (displayLines + windowLines).joined(separator: "\n")
    }
}

package struct WindowCandidate: Equatable {
    package var id: UInt32
    package var app: String
    package var bundleId: String
    package var title: String
    package var pid: Int32
    package var width: Int
    package var height: Int
    package var layer: Int
    package var onScreen: Bool

    package init(id: UInt32, app: String, bundleId: String, title: String, pid: Int32, width: Int, height: Int,
                 layer: Int = 0, onScreen: Bool = true) {
        self.id = id
        self.app = app
        self.bundleId = bundleId
        self.title = title
        self.pid = pid
        self.width = width
        self.height = height
        self.layer = layer
        self.onScreen = onScreen
    }

    package var source: WindowSource {
        WindowSource(id: id, app: app, bundleId: bundleId, title: title, pid: pid, width: width, height: height)
    }
}

package enum SourceCatalog {
    package static let excludedBundlePrefixes = ["com.kikedealba.den", "com.kikedealba.recap"]
    package static let thumbnailWidth = 320
    package static let thumbnailHeight = 240
    package static let maxThumbnailBytes = 128 * 1024
    package static let maxThumbnails = 48
    package static let thumbnailConcurrency = 6
    package static let minimumWindowWidth = 120
    package static let minimumWindowHeight = 80
    package static let jpegQuality = 0.7

    package static func isExcluded(bundleId: String) -> Bool {
        excludedBundlePrefixes.contains { bundleId == $0 || bundleId.hasPrefix($0 + ".") }
    }

    package static func isExcludedApplication(bundleId: String, pid: Int32, ownPid: Int32 = getpid()) -> Bool {
        pid == ownPid || isExcluded(bundleId: bundleId)
    }

    package static func isRecordable(_ window: WindowCandidate, ownPid: Int32 = getpid()) -> Bool {
        window.layer == 0 && !window.bundleId.isEmpty
            && !isExcludedApplication(bundleId: window.bundleId, pid: window.pid, ownPid: ownPid)
    }

    package static func selectWindows(_ candidates: [WindowCandidate], ownPid: Int32 = getpid()) -> [WindowCandidate] {
        candidates.filter { window in
            isRecordable(window, ownPid: ownPid) && window.onScreen
                && window.width >= minimumWindowWidth && window.height >= minimumWindowHeight
                && !window.title.trimmed.isEmpty
        }
    }

    package static func thumbnailSize(width: Int, height: Int, maxWidth: Int = thumbnailWidth,
                                      maxHeight: Int = thumbnailHeight) -> (width: Int, height: Int) {
        guard width > 0, height > 0 else { return (maxWidth, min(maxHeight, maxWidth * 9 / 16)) }
        let scale = min(1, Double(maxWidth) / Double(width), Double(maxHeight) / Double(height))
        return (max(2, Int((Double(width) * scale).rounded())), max(2, Int((Double(height) * scale).rounded())))
    }

    package static func jpegDataURL(_ image: CGImage, quality: Double = jpegQuality, maxBytes: Int = maxThumbnailBytes) -> String? {
        let data = NSMutableData()
        guard let destination = CGImageDestinationCreateWithData(data, UTType.jpeg.identifier as CFString, 1, nil) else { return nil }
        CGImageDestinationAddImage(destination, image, [kCGImageDestinationLossyCompressionQuality: quality] as CFDictionary)
        guard CGImageDestinationFinalize(destination), data.length <= maxBytes else { return nil }
        return "data:image/jpeg;base64," + (data as Data).base64EncodedString()
    }

    package static let permissionDenied = RecapError(
        "SCREEN_PERMISSION_DENIED",
        "Recap has no screen recording access. Enable it in System Settings > Privacy & Security > Screen & System Audio Recording, then try again."
    )

    package static func requireScreenAccess() throws {
        if CGPreflightScreenCaptureAccess() { return }
        CGRequestScreenCaptureAccess()
        throw permissionDenied
    }

    package static func shareableContent() async throws -> SCShareableContent {
        try requireScreenAccess()
        do {
            return try await SCShareableContent.excludingDesktopWindows(true, onScreenWindowsOnly: true)
        } catch {
            if (error as NSError).domain == SCStreamErrorDomain,
               (error as NSError).code == SCStreamError.Code.userDeclined.rawValue {
                throw permissionDenied
            }
            throw RecapError("CAPTURE_FAILED", "Cannot list the screens and windows: \(error.localizedDescription)")
        }
    }

    package static func candidate(_ window: SCWindow) -> WindowCandidate? {
        guard let owner = window.owningApplication else { return nil }
        return WindowCandidate(id: window.windowID, app: owner.applicationName, bundleId: owner.bundleIdentifier,
                               title: window.title ?? "", pid: owner.processID,
                               width: Int(window.frame.width.rounded()), height: Int(window.frame.height.rounded()),
                               layer: window.windowLayer, onScreen: window.isOnScreen)
    }

    @MainActor
    package static func displayName(_ id: CGDirectDisplayID) -> String {
        let key = NSDeviceDescriptionKey("NSScreenNumber")
        let screen = NSScreen.screens.first { ($0.deviceDescription[key] as? NSNumber)?.uint32Value == id }
        return screen?.localizedName ?? "Display \(id)"
    }

    package static func excludedApplications(_ content: SCShareableContent) -> [SCRunningApplication] {
        content.applications.filter { isExcludedApplication(bundleId: $0.bundleIdentifier, pid: $0.processID) }
    }

    package static func excludedPids(_ content: SCShareableContent) -> Set<Int32> {
        Set(excludedApplications(content).map(\.processID))
    }

    package static func recordableWindow(_ id: UInt32, content: SCShareableContent) throws -> SCWindow {
        guard let window = content.windows.first(where: { $0.windowID == id }) else {
            throw RecapError("WINDOW_GONE", "Window \(id) is closed or no longer on screen")
        }
        guard let candidate = candidate(window), isRecordable(candidate) else {
            throw RecapError("CAPTURE_UNSUPPORTED", "Window \(id) belongs to Den or Recap or is not a regular app window, so it is not recorded")
        }
        return window
    }

    package static func displayFilter(_ display: SCDisplay, content: SCShareableContent) -> SCContentFilter {
        SCContentFilter(display: display, excludingApplications: excludedApplications(content), exceptingWindows: [])
    }

    private struct ThumbnailJob {
        var display: Int?
        var window: Int?
        var filter: SCContentFilter
        var width: Int
        var height: Int
    }

    @MainActor
    package static func list(thumbnails: Bool) async throws -> CaptureSources {
        let content = try await shareableContent()
        let mainID = CGMainDisplayID()
        var displays = content.displays.map { display in
            DisplaySource(id: display.displayID, name: displayName(display.displayID),
                          width: display.width, height: display.height, main: display.displayID == mainID)
        }
        let candidates = selectWindows(content.windows.compactMap(candidate))
        var windows = candidates.map(\.source)
        if thumbnails {
            let byDisplay = Dictionary(content.displays.map { ($0.displayID, $0) }, uniquingKeysWith: { first, _ in first })
            let byWindow = Dictionary(content.windows.map { ($0.windowID, $0) }, uniquingKeysWith: { first, _ in first })
            var jobs: [ThumbnailJob] = []
            for (index, source) in displays.enumerated() {
                guard let display = byDisplay[source.id] else { continue }
                jobs.append(ThumbnailJob(display: index, window: nil, filter: displayFilter(display, content: content),
                                         width: source.width, height: source.height))
            }
            for (index, source) in windows.enumerated() {
                guard let window = byWindow[source.id] else { continue }
                jobs.append(ThumbnailJob(display: nil, window: index, filter: SCContentFilter(desktopIndependentWindow: window),
                                         width: source.width, height: source.height))
            }
            let chosen = Array(jobs.prefix(maxThumbnails))
            let images = await concurrently(chosen.count, limit: thumbnailConcurrency) { position in
                await thumbnail(chosen[position].filter, width: chosen[position].width, height: chosen[position].height)
            }
            for (position, image) in images {
                let job = jobs[position]
                if let index = job.display { displays[index].thumbnail = image }
                if let index = job.window { windows[index].thumbnail = image }
            }
        }
        displays.sort { $0.main && !$1.main }
        return CaptureSources(displays: displays, windows: windows)
    }

    package static func concurrently<T>(_ count: Int, limit: Int, _ body: @escaping (Int) async -> T?) async -> [Int: T] {
        await withTaskGroup(of: (Int, T?).self) { group in
            var next = 0
            let width = max(1, limit)
            while next < min(width, count) {
                let position = next
                group.addTask { (position, await body(position)) }
                next += 1
            }
            var found: [Int: T] = [:]
            while let (position, value) = await group.next() {
                if let value { found[position] = value }
                if next < count {
                    let following = next
                    group.addTask { (following, await body(following)) }
                    next += 1
                }
            }
            return found
        }
    }

    private static func thumbnail(_ filter: SCContentFilter, width: Int, height: Int) async -> String? {
        let size = thumbnailSize(width: width, height: height)
        let configuration = SCStreamConfiguration()
        configuration.width = size.width
        configuration.height = size.height
        configuration.showsCursor = false
        guard let image = try? await SCScreenshotManager.captureImage(contentFilter: filter, configuration: configuration) else {
            return nil
        }
        return jpegDataURL(image)
    }
}
