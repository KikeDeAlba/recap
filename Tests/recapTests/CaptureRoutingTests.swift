import Foundation
import Testing
@testable import recap
@testable import RecapCapture

@Suite struct CaptureRoutingTests {
    @Test func recapAndRecapCaptureShareTheVersion() {
        #expect(Recap.version == CaptureTool.version)
    }

    @Test func captureArgumentsRouteToRecapCapture() throws {
        let record = try #require(try Recap.parseAsRoot(["capture", "record", "/tmp/meeting"]) as? CaptureRecordCommand)
        #expect(record.meetingDir == "/tmp/meeting")
        #expect(try Recap.parseAsRoot(["capture", "permissions", "--request", "--json"]) is CapturePermissionsCommand)
        #expect(try Recap.parseAsRoot(["capture", "capabilities", "--json"]) is CaptureCapabilitiesCommand)
    }

    @Test func theLegacyRecordCommandStillParses() throws {
        let record = try #require(try Recap.parseAsRoot(["record", "/tmp/meeting"]) as? RecordCommand)
        #expect(record.dir == "/tmp/meeting")
        #expect(record.liveWorker == nil)
    }
}
