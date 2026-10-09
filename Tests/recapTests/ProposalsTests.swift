import Foundation
import Testing
@testable import recap

@Suite struct ProposalPlanParserTests {
    @Test func keepsOnlyValidChangesToCandidatePages() throws {
        let answer = """
        Listo:
        {"proposals": [
          {"pageId": 3, "section": "## Despliegue", "markdown": "## Despliegue\\nSe despliega con `make release`.", "title": "Actualizar el comando de despliegue", "rationale": "Se corrigió el comando.", "quotes": [{"startMs": 754000, "channel": "Sala", "text": "ya no es make deploy, es make release"}]},
          {"pageId": 3, "section": "Despliegue", "markdown": "Otra versión.", "title": "Duplicado", "rationale": "", "quotes": [{"startMs": 1, "channel": "mic", "text": "x"}]},
          {"pageId": 99, "section": null, "markdown": "x", "title": "Fuera", "rationale": "", "quotes": [{"startMs": 1, "channel": "mic", "text": "x"}]},
          {"pageId": "4", "section": null, "markdown": "Como se acordó en la reunión, el tope es 10 000.", "title": "Tope", "rationale": "", "quotes": [{"startMs": 1, "channel": "system", "text": "x"}]},
          {"pageId": 4, "section": "Límites", "markdown": "El tope por operación es de 10 000 MXN.", "title": "Subir el tope", "rationale": "", "quotes": []},
          {"pageId": 4, "section": "Límites", "markdown": "El tope por operación es de 10 000 MXN.", "title": "Subir el tope", "rationale": "Nuevo tope.", "quotes": [{"startMs": 90500.0, "channel": "Remotos", "text": "el tope pasó a diez mil"}]}
        ]}
        """
        let (drafts, discarded) = try ProposalPlanParser.parse(answer, candidates: [3, 4])
        #expect(drafts.count == 2)
        #expect(drafts[0].section == "Despliegue")
        #expect(drafts[0].markdown == "Se despliega con `make release`.")
        #expect(drafts[0].quotes == [ProposalQuote(startMs: 754_000, channel: .mic, text: "ya no es make deploy, es make release")])
        #expect(drafts[1].quotes.first?.channel == .system && drafts[1].quotes.first?.startMs == 90_500)
        #expect(discarded.map(\.index) == [1, 2, 3, 4])
        #expect(discarded[2].reason.contains("reveals"))
    }

    @Test func acceptsAnEmptyListAndRejectsGarbage() throws {
        #expect(try ProposalPlanParser.parse(#"{"proposals": []}"#, candidates: [1]).drafts.isEmpty)
        #expect(throws: RecapError.self) { try ProposalPlanParser.parse("nada que proponer", candidates: [1]) }
    }
}

@Suite struct ProposalFlowTests {
    private func meetingDir(transcript: Bool = true) throws -> (Meeting, URL) {
        let dir = FileManager.default.temporaryDirectory.appending(path: "recap-proposals-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        var meeting = Meeting(id: "m", title: "Daily", mode: .remote, status: .processing, createdAt: Date(), bitaEntryId: 42)
        meeting.bitaEntry = BitaEntrySnapshot(title: "Daily de CoDi", projectName: "CoDi", kind: "remote-meeting", pageIds: [50, 7])
        try MeetingFile.save(meeting, to: dir)
        if transcript { try "**[00:12:34] Sala:** ya no es make deploy".write(to: dir.appending(path: "transcript.md"), atomically: true, encoding: .utf8) }
        return (meeting, dir)
    }

    private func bita(applyConflict: Bool = false) -> FakeBita {
        var proposeCount = 0
        return FakeBita { arguments in
            switch Array(arguments.prefix(3)) {
            case ["docs", "page", "ls"]:
                return BitaResponse(ok: true, data: ["pages": [["pageId": 3, "title": "Despliegue", "relPath": "codi/despliegue.md", "depth": 0],
                                                               ["pageId": 50, "title": "Daily", "relPath": "codi/daily.md", "depth": 0]]],
                                    meta: ["root": "/data/docs"])
            case ["project", "repo", "ls"]:
                return BitaResponse(ok: true, data: ["repos": []])
            case ["docs", "page", "show"]:
                return BitaResponse(ok: true, data: ["pageId": 7, "title": "Reglas de negocio", "relPath": "codi/reglas.md", "projectName": "CoDi"])
            case ["docs", "propose", "--branch"]:
                proposeCount += 1
                return BitaResponse(ok: true, data: ["branch": arguments[3], "sha": "sha\(proposeCount)", "pageId": Int(arguments[4]) ?? 0, "base": "main0"])
            case ["docs", "branch", "apply"]:
                if applyConflict {
                    return BitaResponse(ok: false, errorCode: "MERGE_CONFLICT", errorMessage: "conflict in codi/despliegue.md")
                }
                return BitaResponse(ok: true, data: ["branch": arguments[3], "sha": arguments[5], "appliedSha": "main-\(arguments[5])"])
            case ["docs", "branch", "drop"]:
                return BitaResponse(ok: true, data: ["branch": arguments[3], "dropped": true])
            default:
                return BitaResponse(ok: false, errorCode: "USAGE", errorMessage: "unexpected \(arguments)")
            }
        }
    }

    private let answer = """
    {"proposals": [
      {"pageId": 3, "section": "Despliegue", "markdown": "Se despliega con `make release`.", "title": "Actualizar el despliegue", "rationale": "Cambió el comando.", "quotes": [{"startMs": 754000, "channel": "mic", "text": "ya no es make deploy"}]},
      {"pageId": 50, "section": null, "markdown": "x", "title": "Propia", "rationale": "", "quotes": [{"startMs": 1, "channel": "mic", "text": "x"}]},
      {"pageId": 7, "section": "Límites", "markdown": "El tope es de 10 000 MXN.", "title": "Subir el tope", "rationale": "Nuevo tope.", "quotes": [{"startMs": 9000, "channel": "system", "text": "diez mil"}]}
    ]}
    """

    private func generate(_ bita: FakeBita, meeting: Meeting, dir: URL) throws -> (ProposalsFile?, String) {
        var prompt = ""
        let generator = ProposalGenerator(config: Config(), bita: bita, log: { _ in }) { text, dirs in
            prompt = text
            #expect(dirs == ["/data/docs", dir.path])
            return answer
        }
        return (try generator.run(meeting: meeting, dir: dir), prompt)
    }

    @Test func proposesEachChangeOnTheMeetingBranch() throws {
        let (meeting, dir) = try meetingDir()
        defer { try? FileManager.default.removeItem(at: dir) }
        let fake = bita()
        let (generated, prompt) = try generate(fake, meeting: meeting, dir: dir)
        let file = try #require(generated)
        #expect(prompt.contains("#3 «Despliegue» — /data/docs/codi/despliegue.md"))
        #expect(prompt.contains("#7 «Reglas de negocio»"))
        #expect(!prompt.contains("#50"))
        #expect(!prompt.contains("{{"))
        #expect(file.branch == "proposal/meeting-42")
        #expect(file.proposals.map(\.pageId) == [3, 7])
        #expect(file.proposals.map(\.sha) == ["sha1", "sha2"])
        #expect(file.proposals.allSatisfy { $0.status == .pending })
        #expect(file.discarded.count == 1)
        let propose = try #require(fake.calls.first { $0.starts(with: ["docs", "propose"]) })
        #expect(propose == ["docs", "propose", "--branch", "proposal/meeting-42", "3", "--md", ProposalStore.markdownFile(dir, n: 1).path,
                            "--section", "Despliegue", "--reason", "Actualizar el despliegue", "--source", "meeting:42"])
        #expect(try String(contentsOf: ProposalStore.markdownFile(dir, n: 1), encoding: .utf8) == "Se despliega con `make release`.\n")
        #expect(ProposalStore.load(dir)?.proposals.map(\.sha) == file.proposals.map(\.sha))
        let encoded = String(decoding: try JSONEncoder().encode(file.proposals[0]), as: UTF8.self)
        #expect(encoded.contains(#""status":"pending""#) && encoded.contains(#""pageTitle":"Despliegue""#))
    }

    @Test func takesTheProjectFromTheMeetingPageWhenTheEntryHadNone() throws {
        var (meeting, dir) = try meetingDir()
        defer { try? FileManager.default.removeItem(at: dir) }
        meeting.bitaEntry?.projectName = nil
        let fake = bita()
        let (generated, _) = try generate(fake, meeting: meeting, dir: dir)
        #expect(fake.calls.contains(["docs", "page", "ls", "--project", "CoDi"]))
        #expect(try #require(generated).proposals.map(\.pageId) == [3, 7])
    }

    @Test func acceptAppliesAndRejectDropsTheBranchWhenNothingIsPending() throws {
        let (meeting, dir) = try meetingDir()
        defer { try? FileManager.default.removeItem(at: dir) }
        let fake = bita()
        _ = try generate(fake, meeting: meeting, dir: dir)
        let review = ProposalReview(dir: dir, bita: fake)
        let accepted = try review.accept(1)
        #expect(accepted.status == .accepted)
        #expect(accepted.appliedSha == "main-sha1")
        #expect(!fake.calls.contains { $0.starts(with: ["docs", "branch", "drop"]) })
        #expect(throws: RecapError.self) { try review.accept(1) }
        let rejected = try review.reject(2)
        #expect(rejected.status == .rejected)
        #expect(fake.calls.last == ["docs", "branch", "drop", "proposal/meeting-42"])
        #expect(ProposalStore.load(dir)?.branchDropped == true)
        #expect(throws: RecapError.self) { try review.reject(9) }
    }

    @Test func aConflictLeavesTheProposalStaleAndAnEditProposesAgain() throws {
        let (meeting, dir) = try meetingDir()
        defer { try? FileManager.default.removeItem(at: dir) }
        _ = try generate(bita(), meeting: meeting, dir: dir)
        let conflicting = bita(applyConflict: true)
        let stale = try ProposalReview(dir: dir, bita: conflicting).accept(1)
        #expect(stale.status == .stale)

        let edited = dir.appending(path: "edited.md")
        try "Se despliega con `make release-prod`.\n".write(to: edited, atomically: true, encoding: .utf8)
        let fake = bita()
        let accepted = try ProposalReview(dir: dir, bita: fake).accept(1, editedMarkdown: edited)
        #expect(accepted.status == .accepted)
        #expect(accepted.sha == "sha1")
        #expect(fake.calls.first?.starts(with: ["docs", "propose", "--branch", "proposal/meeting-42", "3"]) == true)
        #expect(fake.calls[1] == ["docs", "branch", "apply", "proposal/meeting-42", "--commit", "sha1"])
        #expect(try String(contentsOf: ProposalStore.markdownFile(dir, n: 1), encoding: .utf8).contains("release-prod"))
    }

    @Test func regenerationKeepsReviewedProposals() throws {
        let (meeting, dir) = try meetingDir()
        defer { try? FileManager.default.removeItem(at: dir) }
        let fake = bita()
        _ = try generate(fake, meeting: meeting, dir: dir)
        _ = try ProposalReview(dir: dir, bita: fake).reject(1)
        let generator = ProposalGenerator(config: Config(), bita: fake, log: { _ in }) { _, _ in
            Issue.record("claude must not run again")
            return "{}"
        }
        let again = try #require(try generator.run(meeting: meeting, dir: dir))
        #expect(again.proposals.first?.status == .rejected)
    }

    @Test func theStageIsOptionalAndOnlyForBitaMeetings() {
        var meeting = Meeting(id: "m", title: "x", mode: .inPerson, status: .recorded, createdAt: Date())
        #expect(!Stage.proposals.applies(to: meeting))
        meeting.bitaEntryId = 1
        #expect(Stage.proposals.applies(to: meeting))
        let failed = StageState(status: "failed", updatedAt: Date(), error: "boom")
        #expect(Stage.proposals.isSatisfied(failed))
        #expect(!Stage.wrapup.isSatisfied(failed))
        #expect(Stage.allCases.firstIndex(of: .proposals)! < Stage.allCases.firstIndex(of: .wrapup)!)
        #expect(Stage.allCases.firstIndex(of: .proposals)! > Stage.allCases.firstIndex(of: .transcribe)!)
    }
}
