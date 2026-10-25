import Foundation
import ScreenCaptureKit

package struct CaptureTimeouts {
    package var content: TimeInterval
    package var start: TimeInterval
    package var update: TimeInterval
    package var stop: TimeInterval

    package init(content: TimeInterval, start: TimeInterval, update: TimeInterval, stop: TimeInterval) {
        self.content = content
        self.start = start
        self.update = update
        self.stop = stop
    }

    package static let standard = CaptureTimeouts(content: 4, start: 4, update: 4, stop: 2)

    package var longestChange: TimeInterval {
        content + update + stop + start + stop
    }

    package static func nanoseconds(_ seconds: TimeInterval) -> UInt64 {
        UInt64(max(0, seconds) * 1_000_000_000)
    }

    package static func expired(_ action: String, after seconds: TimeInterval) -> RecapError {
        RecapError("CAPTURE_TIMEOUT", "ScreenCaptureKit took more than \(Int(seconds.rounded(.up)))s to \(action); Recap.app gave up on it")
    }
}

package protocol ScreenStream: AnyObject {
    func startCapture() async throws
    func updateContentFilter(_ filter: SCContentFilter) async throws
    func stopCapture() async throws
}

extension SCStream: ScreenStream {}

package typealias ScreenStreamFactory = (SCContentFilter, SCStreamConfiguration, SCStreamOutput & SCStreamDelegate,
                                         DispatchQueue) throws -> ScreenStream

package enum ScreenStreams {
    package static let live: ScreenStreamFactory = { filter, configuration, output, queue in
        let stream = SCStream(filter: filter, configuration: configuration, delegate: output)
        try stream.addStreamOutput(output, type: .screen, sampleHandlerQueue: queue)
        try stream.addStreamOutput(output, type: .audio, sampleHandlerQueue: queue)
        return stream
    }
}

package struct ScreenContent {
    package var mainSize: (width: Int, height: Int)?
    package var excludedPids: () -> Set<Int32>
    package var resolve: @MainActor (CaptureTargetRef) throws -> (SCContentFilter, CaptureVideo)
    package var displayFilter: (UInt32) -> SCContentFilter?

    package init(mainSize: (width: Int, height: Int)?, excludedPids: @escaping () -> Set<Int32>,
                 resolve: @escaping @MainActor (CaptureTargetRef) throws -> (SCContentFilter, CaptureVideo),
                 displayFilter: @escaping (UInt32) -> SCContentFilter?) {
        self.mainSize = mainSize
        self.excludedPids = excludedPids
        self.resolve = resolve
        self.displayFilter = displayFilter
    }

    package static func current() async throws -> ScreenContent {
        ScreenContent(try await SourceCatalog.shareableContent())
    }

    package init(_ content: SCShareableContent) {
        let main = content.displays.first { $0.displayID == CGMainDisplayID() } ?? content.displays.first
        mainSize = main.map { ($0.width, $0.height) }
        excludedPids = { SourceCatalog.excludedPids(content) }
        displayFilter = { id in
            content.displays.first { $0.displayID == id }.map { SourceCatalog.displayFilter($0, content: content) }
        }
        resolve = { target in
            switch target.kind {
            case .display:
                guard let display = content.displays.first(where: { $0.displayID == target.id }) else {
                    throw RecapError("DISPLAY_GONE", "Display \(target.id) is not connected")
                }
                let video = CaptureVideo(kind: .display, id: target.id, title: SourceCatalog.displayName(target.id), app: nil, since: Date())
                return (SourceCatalog.displayFilter(display, content: content), video)
            case .window:
                let window = try SourceCatalog.recordableWindow(target.id, content: content)
                let app = window.owningApplication?.applicationName
                let title = window.title.flatMap { $0.trimmed.isEmpty ? nil : $0 } ?? app ?? "Window \(target.id)"
                let video = CaptureVideo(kind: .window, id: target.id, title: title, app: app, since: Date())
                return (SCContentFilter(desktopIndependentWindow: window), video)
            }
        }
    }
}
