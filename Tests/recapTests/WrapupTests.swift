import Foundation
import Testing
@testable import recap

@Suite struct WrapupParserTests {
    @Test func readsJsonWrappedInTextAndDropsForbiddenSections() throws {
        let answer = """
        Aquí está:
        {"title":"  Reunión presencial: recompra con cupón  ","project":"Dportenis","pageTitle":"",
         "pageMarkdown":"## Contexto\\nCupón post-entrega.\\n\\n## Pendientes\\n- Algo\\n\\n## Arquitectura\\nLambda y DynamoDB.",
         "backlog":[{"kind":"pending","title":"Confirmar la cola","body":"Responsable: Ana"},
                    {"kind":"todo","title":"Inválido","body":null},
                    {"kind":"finding","title":"  ","body":null}]}
        Listo.
        """
        let plan = try WrapupParser.parse(answer)
        #expect(plan.title == "Reunión presencial: recompra con cupón")
        #expect(plan.pageTitle == plan.title)
        #expect(plan.project == "Dportenis")
        #expect(!plan.pageMarkdown.contains("Pendientes"))
        #expect(plan.pageMarkdown.contains("## Arquitectura"))
        #expect(plan.backlog == [WrapupPlan.Item(kind: "pending", title: "Confirmar la cola", body: "Responsable: Ana")])
    }

    @Test func rejectsAnswersWithoutJsonOrWithEmptyFields() {
        #expect(throws: RecapError.self) { try WrapupParser.parse("no json here") }
        #expect(throws: RecapError.self) {
            try WrapupParser.parse(###"{"title":"","project":null,"pageTitle":"x","pageMarkdown":"## A\nb","backlog":[]}"###)
        }
        #expect(throws: RecapError.self) { try WrapupParser.parse(#"{"title":"x"}"#) }
    }

    @Test func demotesHeadingsOutsideCodeFences() {
        let demoted = WrapupParser.demoteHeadings("## Flujo\n```mermaid\n## not a heading\n```\n### Paso")
        #expect(demoted == "### Flujo\n```mermaid\n## not a heading\n```\n#### Paso")
    }
}

@Suite struct WrapupRulesTests {
    @Test func recognizesGenericMeetingTitles() {
        for title in ["", "Reunión presencial", "reunion", "Junta", "Meet", "In-person meeting", "Remote meeting", "Reunión remota"] {
            #expect(WrapupRules.isGenericTitle(title), "\(title)")
        }
        for title in ["Reunión presencial: recompra con cupón", "Daily SSO", "Planeación sprint 42"] {
            #expect(!WrapupRules.isGenericTitle(title), "\(title)")
        }
    }

    @Test func choosesAProjectOnlyWhenTheEntryHasNoneAndTheNameExists() {
        let available = ["Dportenis", "SSO", "Pharma STI"]
        #expect(WrapupRules.chooseProject(current: "SSO", proposed: "Dportenis", available: available) == (nil, true))
        #expect(WrapupRules.chooseProject(current: nil, proposed: "dportenis", available: available) == ("Dportenis", true))
        #expect(WrapupRules.chooseProject(current: nil, proposed: "Viva Aerobus", available: available) == (nil, false))
        #expect(WrapupRules.chooseProject(current: nil, proposed: nil, available: available) == (nil, false))
    }
}

@Suite struct WaitTests {
    private func meeting(_ status: MeetingStatus, failed: Bool = false) -> Meeting {
        var meeting = Meeting(id: "m", title: "Daily", mode: .inPerson, status: status, createdAt: Date())
        if failed { meeting.stages["wrapup"] = StageState(status: "failed", updatedAt: Date(), error: "boom") }
        return meeting
    }

    @Test func settlesOnProcessedOrAFailedStage() {
        #expect(WaitCommand.isSettled(meeting(.processed)))
        #expect(WaitCommand.isSettled(meeting(.recorded, failed: true)))
        #expect(!WaitCommand.isSettled(meeting(.recorded)))
        #expect(!WaitCommand.isSettled(meeting(.recording)))
        #expect(!WaitCommand.isSettled(meeting(.processing)))
    }
}

@Suite struct BitaSnapshotTests {
    @Test func theHookEventCarriesProjectAndPages() throws {
        let json = #"{"event":"stop","entry":{"id":9,"description":"Reunión presencial","kind":"in-person-meeting","running":false,"projectName":null},"pageIds":[151],"databasePath":"/d/bita.db","docsRoot":"/d/docs"}"#
        let event = try JSONDecoder().decode(BitaHookEvent.self, from: Data(json.utf8))
        #expect(event.snapshot == BitaEntrySnapshot(title: "Reunión presencial", projectName: nil, kind: "in-person-meeting", pageIds: [151]))
    }
}
