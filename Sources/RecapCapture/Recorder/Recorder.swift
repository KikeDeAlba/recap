import AVFoundation
import CoreGraphics

package protocol Recorder: AnyObject {
    var onFailure: ((Error) -> Void)? { get set }
    func start() async throws
    func stop() async
}

package enum Permissions {
    package static func requestMicrophone() async throws {
        switch AVCaptureDevice.authorizationStatus(for: .audio) {
        case .authorized:
            return
        case .notDetermined:
            if await AVCaptureDevice.requestAccess(for: .audio) { return }
        default:
            break
        }
        throw RecapError("MICROPHONE_DENIED",
                         "Recap has no microphone access. Enable it in System Settings > Privacy & Security > Microphone.")
    }

    package static func requestScreen() throws {
        if CGPreflightScreenCaptureAccess() { return }
        CGRequestScreenCaptureAccess()
        throw RecapError("SCREEN_DENIED",
                         "Recap has no screen recording access. Enable it in System Settings > Privacy & Security > Screen & System Audio Recording, then try again.")
    }

    package static var microphoneStatus: String {
        switch AVCaptureDevice.authorizationStatus(for: .audio) {
        case .authorized: "granted"
        case .notDetermined: "not-determined"
        case .denied: "denied"
        case .restricted: "restricted"
        @unknown default: "unknown"
        }
    }

    package static var screenStatus: String {
        CGPreflightScreenCaptureAccess() ? "granted" : "denied"
    }
}
