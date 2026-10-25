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
    package static let minimumWindowWidth = 120
    package static let minimumWindowHeight = 80
    package static let jpegQuality = 0.7

    package static func isExcluded(bundleId: String) -> Bool {
        excludedBundlePrefixes.contains { bundleId == $0 || bundleId.hasPrefix($0 + ".") }
    }

    package static func selectWindows(_ candidates: [WindowCandidate], ownPid: Int32 = getpid()) -> [WindowCandidate] {
        candidates.filter { window in
            window.layer == 0 && window.onScreen && window.pid != ownPid
                && window.width >= minimumWindowWidth && window.height >= minimumWindowHeight
                && !window.bundleId.isEmpty && !isExcluded(bundleId: window.bundleId)
                && !window.title.trimmed.isEmpty
        }
    }

    package static func thumbnailSize(width: Int, height: Int, maxWidth: Int = thumbnailWidth) -> (width: Int, height: Int) {
        guard width > 0, height > 0 else { return (maxWidth, maxWidth * 9 / 16) }
        let scaledWidth = min(maxWidth, width)
        let scaledHeight = max(2, Int((Double(height) * Double(scaledWidth) / Double(width)).rounded()))
        return (scaledWidth, scaledHeight)
    }

    package static func jpegDataURL(_ image: CGImage, quality: Double = jpegQuality) -> String? {
        let data = NSMutableData()
        guard let destination = CGImageDestinationCreateWithData(data, UTType.jpeg.identifier as CFString, 1, nil) else { return nil }
        CGImageDestinationAddImage(destination, image, [kCGImageDestinationLossyCompressionQuality: quality] as CFDictionary)
        guard CGImageDestinationFinalize(destination) else { return nil }
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
        content.applications.filter { isExcluded(bundleId: $0.bundleIdentifier) || $0.processID == getpid() }
    }

    package static func displayFilter(_ display: SCDisplay, content: SCShareableContent) -> SCContentFilter {
        SCContentFilter(display: display, excludingApplications: excludedApplications(content), exceptingWindows: [])
    }

    @MainActor
    package static func list(thumbnails: Bool) async throws -> CaptureSources {
        let content = try await shareableContent()
        let mainID = CGMainDisplayID()
        var displays: [DisplaySource] = []
        for display in content.displays {
            var source = DisplaySource(id: display.displayID, name: displayName(display.displayID),
                                       width: display.width, height: display.height, main: display.displayID == mainID)
            if thumbnails {
                source.thumbnail = await thumbnail(displayFilter(display, content: content), width: display.width, height: display.height)
            }
            displays.append(source)
        }
        displays.sort { $0.main && !$1.main }
        let byId = Dictionary(content.windows.map { ($0.windowID, $0) }, uniquingKeysWith: { first, _ in first })
        var windows: [WindowSource] = []
        for candidate in selectWindows(content.windows.compactMap(candidate)) {
            var source = candidate.source
            if thumbnails, let window = byId[candidate.id] {
                source.thumbnail = await thumbnail(SCContentFilter(desktopIndependentWindow: window),
                                                   width: candidate.width, height: candidate.height)
            }
            windows.append(source)
        }
        return CaptureSources(displays: displays, windows: windows)
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
