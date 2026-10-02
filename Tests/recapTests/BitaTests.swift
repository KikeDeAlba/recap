import Foundation
import Testing
@testable import recap

@Suite struct BitaHookPlannerTests {
    private func event(_ name: String, id: Int = 7, kind: String?, previous: String? = nil, running: Bool = true) throws -> BitaHookEvent {
        var entry: [String: Any] = ["id": id, "description": "Daily", "running": running]
        if let kind { entry["kind"] = kind }
        var payload: [String: Any] = ["event": name, "entry": entry, "databasePath": "/data/bita.db", "docsRoot": "/data/docs"]
        if let previous { payload["previousKind"] = previous }
        return try JSONDecoder().decode(BitaHookEvent.self, from: JSONSerialization.data(withJSONObject: payload))
    }

    @Test func startsInTheModeOfTheKind() throws {
        #expect(BitaHookPlanner.plan(try event("start", kind: "remote-meeting"), activeEntryId: nil) == .start(.remote))
        #expect(BitaHookPlanner.plan(try event("start", kind: "in-person-meeting"), activeEntryId: nil) == .start(.inPerson))
    }

    @Test func ignoresStartsThatAreNotMeetingsOrCollide() throws {
        #expect(BitaHookPlanner.plan(try event("start", kind: "pairing"), activeEntryId: nil) == .ignore("entry #7 is not a meeting"))
        #expect(BitaHookPlanner.plan(try event("start", kind: "remote-meeting"), activeEntryId: 3)
                == .ignore("another meeting is already being recorded"))
    }

    @Test func stopsOnlyTheRecordingOfThatEntry() throws {
        #expect(BitaHookPlanner.plan(try event("stop", kind: "remote-meeting"), activeEntryId: 7) == .stopAndProcess)
        #expect(BitaHookPlanner.plan(try event("stop", kind: "remote-meeting"), activeEntryId: 3) == .processIfRecorded)
    }

    @Test func discardsOnCancel() throws {
        #expect(BitaHookPlanner.plan(try event("cancel", kind: "in-person-meeting"), activeEntryId: 7) == .discard)
    }

    @Test func amendStartsOrStopsWhenTheKindCrossesTheMeetingLine() throws {
        #expect(BitaHookPlanner.plan(try event("amend", kind: "remote-meeting", previous: nil), activeEntryId: nil) == .start(.remote))
        #expect(BitaHookPlanner.plan(try event("amend", kind: "remote-meeting", previous: nil, running: false), activeEntryId: nil)
                == .ignore("entry #7 already stopped"))
        #expect(BitaHookPlanner.plan(try event("amend", kind: nil, previous: "remote-meeting"), activeEntryId: 7) == .stopWithoutProcessing)
        #expect(BitaHookPlanner.plan(try event("amend", kind: "in-person-meeting", previous: "remote-meeting"), activeEntryId: 7)
                == .ignore("kind change does not affect the recording"))
    }

    @Test func carriesTheBitaDatabaseAndDocs() throws {
        let parsed = try event("start", kind: "remote-meeting")
        #expect(parsed.target == BitaTarget(databasePath: "/data/bita.db", docsRoot: "/data/docs"))
    }
}

@Suite struct BitaNoteTests {
    @Test func demotesHeadingsSoTheyStayInsideOneSection() {
        let meeting = Meeting(id: "x", title: "Daily", mode: .remote, status: .processed, createdAt: Date(),
                              startedAt: Date(timeIntervalSince1970: 0), endedAt: Date(timeIntervalSince1970: 1_800))
        let summary = """
        # Daily

        2 de octubre · 30m · reunión remota

        ## Resumen
        Todo bien.

        ```
        ## not a heading
        ```

        ## Pendientes
        | # | Pendiente |
        """
        let body = BitaBridge.noteBody(summary: summary, meeting: meeting, dir: URL(fileURLWithPath: "/tmp/m"))
        #expect(body.hasPrefix("Minuta de la reunión remota (30m00s)"))
        #expect(body.contains("\n### Resumen\n"))
        #expect(body.contains("\n### Pendientes\n"))
        #expect(body.contains("\n## not a heading\n"))
        #expect(!body.contains("# Daily"))
        #expect(body.contains("`/tmp/m` (`summary.md`, `transcript.md`, `frames/`)"))
    }
}
