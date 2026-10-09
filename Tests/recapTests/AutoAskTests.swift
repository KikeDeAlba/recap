import Foundation
import Testing
@testable import recap

private func temporaryMeeting(mode: MeetingMode = .remote) throws -> (URL, Meeting) {
    let dir = FileManager.default.temporaryDirectory.appending(path: "recap-auto-\(UUID().uuidString)")
    try FileManager.default.createDirectory(at: LiveFiles.dir(dir), withIntermediateDirectories: true)
    let meeting = Meeting(id: "m", title: "Daily", mode: mode, status: .recording, createdAt: Date())
    return (dir, meeting)
}

private func writeTranscript(_ segments: [Segment], to dir: URL) throws {
    try JSONLines.append(segments, to: LiveFiles.transcript(dir))
}

private func sleeper() throws -> Process {
    let process = Process()
    process.executableURL = URL(fileURLWithPath: "/bin/sleep")
    process.arguments = ["30"]
    try process.run()
    return process
}

private func answer(_ question: String, auto: Bool? = nil) -> Answer {
    Answer(id: UUID().uuidString, askedAt: Date(), question: question, answer: "Con make release.", found: true,
           sources: [], auto: auto)
}

final class ManualClock {
    var now: Date
    init(_ now: Date) { self.now = now }
}

final class Recorder {
    var prompts: [String] = []
    var asked: [String] = []
}

@Suite struct DetectorResponseTests {
    @Test func parsesAQuestion() throws {
        #expect(try DetectorResponse.parse(#"{"question": "¿Cómo se despliega bita-desktop?"}"#) == "¿Cómo se despliega bita-desktop?")
        #expect(try DetectorResponse.parse("```json\n{\"question\": \" ¿Dónde está el pipeline? \"}\n```") == "¿Dónde está el pipeline?")
    }

    @Test func parsesNoQuestion() throws {
        #expect(try DetectorResponse.parse(#"{"question": null}"#) == nil)
        #expect(try DetectorResponse.parse(#"{"question": ""}"#) == nil)
        #expect(try DetectorResponse.parse(#"Aquí va: {"question":null}"#) == nil)
    }

    @Test func rejectsGarbage() {
        #expect(throws: RecapError.self) { try DetectorResponse.parse("No hay preguntas.") }
        #expect(throws: RecapError.self) { try DetectorResponse.parse(#"{"answer": "x"}"#) }
        #expect(throws: RecapError.self) { try DetectorResponse.parse(#"{"question": 3}"#) }
        #expect(throws: RecapError.self) { try DetectorResponse.parse("{not json}") }
    }
}

@Suite struct QuestionDedupeTests {
    @Test func flagsRephrasingsWithFoldedAccents() {
        #expect(QuestionDedupe.isDuplicate("¿Cómo se despliega bita-desktop?", of: ["como se DESPLIEGA bita desktop"]))
        #expect(QuestionDedupe.isDuplicate("¿Cómo se despliega bita-desktop a producción?", of: ["¿Cómo se despliega bita-desktop?"]))
    }

    @Test func keepsDifferentQuestions() {
        #expect(!QuestionDedupe.isDuplicate("¿Cómo se ejecuta el recomendador?", of: ["¿Cómo se ejecuta el webhook de BBVA?"]))
        #expect(!QuestionDedupe.isDuplicate("¿Dónde está el pipeline de CoDi?", of: []))
    }
}

@Suite struct DetectionPacerTests {
    @Test func runsOnlyAfterGrowthAndAtMostOncePerInterval() {
        var pacer = DetectionPacer(minSeconds: 20)
        let start = Date(timeIntervalSince1970: 1_000)
        var runs: [Bool] = []
        func check(_ offset: TimeInterval, busy: Bool = false) {
            runs.append(pacer.shouldRun(now: start.addingTimeInterval(offset), busy: busy))
        }
        check(0)
        pacer.grew()
        check(0, busy: true)
        check(0)
        check(1)
        pacer.grew()
        check(19)
        check(20)
        check(60)
        #expect(runs == [false, false, true, false, false, true, false])
    }

    @Test func detectorTicksFollowTheInjectedClock() throws {
        let (dir, meeting) = try temporaryMeeting()
        defer { try? FileManager.default.removeItem(at: dir) }
        try writeTranscript([Segment(startMs: 0, endMs: 2_000, channel: .system, text: "Hola a todos.")], to: dir)
        let clock = ManualClock(Date(timeIntervalSince1970: 5_000))
        let recorder = Recorder()
        let detector = QuestionDetector(dir: dir, meeting: meeting, minSeconds: 20, dependencies: .init(
            now: { clock.now }, template: { "{{transcript}}" }, context: { ProjectContext() },
            complete: { prompt in recorder.prompts.append(prompt); return #"{"question": null}"# },
            ask: { recorder.asked.append($0) }, log: { _ in }))
        #expect(!detector.tick())
        detector.transcriptGrew()
        #expect(detector.tick())
        #expect(detector.waitUntilIdle(timeout: 5))
        detector.transcriptGrew()
        clock.now = clock.now.addingTimeInterval(10)
        #expect(!detector.tick())
        clock.now = clock.now.addingTimeInterval(10)
        #expect(detector.tick())
        #expect(detector.waitUntilIdle(timeout: 5))
        #expect(recorder.prompts.count == 2)
        #expect(recorder.asked.isEmpty)
        detector.stop()
        detector.transcriptGrew()
        clock.now = clock.now.addingTimeInterval(60)
        #expect(!detector.tick())
    }
}

@Suite struct QuestionDetectorTests {
    @Test func asksOnceAndSkipsDuplicatesAndKnownAnswers() throws {
        let (dir, meeting) = try temporaryMeeting()
        defer { try? FileManager.default.removeItem(at: dir) }
        try writeTranscript([
            Segment(startMs: 0, endMs: 3_000, channel: .mic, text: "Buenos días."),
            Segment(startMs: 3_000, endMs: 6_000, channel: .system, text: "¿Cómo se despliega bita-desktop?"),
        ], to: dir)
        let recorder = Recorder()
        var reply = #"{"question": "¿Cómo se despliega bita-desktop?"}"#
        let detector = QuestionDetector(dir: dir, meeting: meeting, minSeconds: 20, dependencies: .init(
            template: { try ResourceText.load("detect-prompt.md") },
            context: { ProjectContext(project: "bita", pages: [PageRef(pageId: 1, title: "Despliegue", relPath: "d.md", depth: 0)]) },
            complete: { prompt in recorder.prompts.append(prompt); return reply },
            ask: { recorder.asked.append($0) }, log: { _ in }))
        #expect(detector.runCycle() == .asked("¿Cómo se despliega bita-desktop?"))
        #expect(detector.runCycle() == .duplicate("¿Cómo se despliega bita-desktop?"))
        let prompt = try #require(recorder.prompts.first)
        #expect(!prompt.contains("{{"))
        #expect(prompt.contains("Proyecto: bita") && prompt.contains("- Despliegue"))
        #expect(prompt.contains("Remotos: ¿Cómo se despliega bita-desktop?") && prompt.contains("Sala: Buenos días."))
        #expect(recorder.prompts[1].contains("- ¿Cómo se despliega bita-desktop?"))

        try JSONLines.append([answer("¿Qué cambió en el pipeline de CoDi?")], to: LiveFiles.answers(dir))
        reply = #"{"question": "¿Qué cambió en el pipeline de CoDi la semana pasada?"}"#
        #expect(detector.runCycle() == .duplicate("¿Qué cambió en el pipeline de CoDi la semana pasada?"))
        reply = #"{"question": null}"#
        #expect(detector.runCycle() == DetectionOutcome.none)
        reply = "Lo siento"
        if case .failed = detector.runCycle() {} else { Issue.record("garbage should fail the cycle") }
        #expect(recorder.asked == ["¿Cómo se despliega bita-desktop?"])
    }

    @Test func inPersonPromptHasOnlyTheRoom() throws {
        let (dir, meeting) = try temporaryMeeting(mode: .inPerson)
        defer { try? FileManager.default.removeItem(at: dir) }
        let window = [Segment(startMs: 0, endMs: 3_000, channel: .mic, text: "¿Dónde está el Makefile?")]
        let prompt = DetectPrompt.render(template: try ResourceText.load("detect-prompt.md"), meeting: meeting,
                                         context: ProjectContext(), window: window, known: [])
        #expect(prompt.contains("presencial") && prompt.contains("(ninguna)"))
        #expect(prompt.contains("] ¿Dónde está el Makefile?") && !prompt.contains("Remotos:"))
    }

    @Test func skipsWhileAnotherAskHoldsTheLockAndSurvivesFailures() throws {
        let (dir, meeting) = try temporaryMeeting()
        defer { try? FileManager.default.removeItem(at: dir) }
        try writeTranscript([Segment(startMs: 0, endMs: 3_000, channel: .system, text: "¿Cómo corro las pruebas?")], to: dir)
        let holder = try sleeper()
        defer { holder.terminate() }
        let lock = try #require(try AskLock.acquire(dir, auto: false, pid: holder.processIdentifier))
        let recorder = Recorder()
        var logs: [String] = []
        let detector = QuestionDetector(dir: dir, meeting: meeting, minSeconds: 20, dependencies: .init(
            template: { "{{transcript}}" }, context: { ProjectContext() },
            complete: { prompt in recorder.prompts.append(prompt); return #"{"question": "¿Cómo se corren las pruebas de recap?"}"# },
            ask: { _ in throw RecapError("ASK_FAILED", "boom") }, log: { logs.append($0) }))
        #expect(detector.runCycle() == .skippedBusy)
        #expect(recorder.prompts.isEmpty)
        lock.release()
        #expect(detector.runCycle() == .failed("ASK_FAILED: boom"))
        #expect(logs.contains { $0.contains("auto ask failed") })
    }
}

@Suite struct AskLockTests {
    @Test func autoSkipsWhenHeldAndTakesStaleLocks() throws {
        let (dir, _) = try temporaryMeeting()
        defer { try? FileManager.default.removeItem(at: dir) }
        let holder = try sleeper()
        defer { holder.terminate() }
        let manual = try #require(try AskLock.acquire(dir, auto: false, pid: holder.processIdentifier))
        #expect(AskLock.isHeld(dir))
        #expect(try AskLock.acquire(dir, auto: true) == nil)
        manual.release()
        #expect(!AskLock.isHeld(dir))

        let dead = Process()
        dead.executableURL = URL(fileURLWithPath: "/usr/bin/true")
        try dead.run()
        dead.waitUntilExit()
        _ = try #require(try AskLock.acquire(dir, auto: false, pid: dead.processIdentifier))
        let auto = try #require(try AskLock.acquire(dir, auto: true))
        #expect(AskLock.current(dir)?.auto == true)
        auto.release()
        #expect(!FileManager.default.fileExists(atPath: LiveFiles.askLock(dir).path))
    }

    @Test func manualPreemptsARunningAutoAsk() throws {
        let (dir, _) = try temporaryMeeting()
        defer { try? FileManager.default.removeItem(at: dir) }
        let autoProcess = try sleeper()
        defer { if autoProcess.isRunning { autoProcess.terminate() } }
        _ = try #require(try AskLock.acquire(dir, auto: true, pid: autoProcess.processIdentifier))
        var terminated: [Int32] = []
        let manual = try #require(try AskLock.acquire(dir, auto: false) { pid in
            terminated.append(pid)
            AskLock.terminate(pid)
        })
        #expect(terminated == [autoProcess.processIdentifier])
        autoProcess.waitUntilExit()
        #expect(autoProcess.terminationReason == .uncaughtSignal)
        #expect(AskLock.current(dir) == manual.holder)
        #expect(manual.holder.auto == false && manual.holder.pid == getpid())
        manual.release()
    }

    @Test func terminateAlsoStopsTheChildrenOfTheHolder() throws {
        let shell = Process()
        shell.executableURL = URL(fileURLWithPath: "/bin/sh")
        shell.arguments = ["-c", "sleep 30; true"]
        try shell.run()
        defer { if shell.isRunning { shell.terminate() } }
        #expect(ProcessCheck.waitUntil(timeout: 5, interval: 0.05) { !AskLock.descendants(of: shell.processIdentifier).isEmpty })
        let children = AskLock.descendants(of: shell.processIdentifier)
        AskLock.terminate(shell.processIdentifier)
        shell.waitUntilExit()
        #expect(ProcessCheck.waitUntil(timeout: 3, interval: 0.05) { children.allSatisfy { !ProcessCheck.isAlive($0) } })
    }

    @Test func releaseLeavesALockTakenOverByAnotherProcess() throws {
        let (dir, _) = try temporaryMeeting()
        defer { try? FileManager.default.removeItem(at: dir) }
        let mine = try #require(try AskLock.acquire(dir, auto: true))
        let other = try sleeper()
        defer { other.terminate() }
        let replacement = AskLockHolder(pid: other.processIdentifier, auto: false, startedAt: Date())
        try JSONLines.encoder.encode(replacement).write(to: LiveFiles.askLock(dir))
        mine.release()
        #expect(AskLock.current(dir)?.pid == replacement.pid)
    }
}

@Suite struct AskCoordinatorTests {
    @Test func writesAskingWhileRunningAndClearsItAfter() throws {
        let (dir, _) = try temporaryMeeting()
        defer { try? FileManager.default.removeItem(at: dir) }
        let startedAt = Date(timeIntervalSince1970: 1_790_000_000)
        var seen: AskingState?
        var raw = ""
        let result = try AskCoordinator.perform(dir: dir, question: " ¿Cómo se despliega? ", auto: true, now: startedAt) {
            seen = AskingState.read(dir)
            raw = (try? String(contentsOf: LiveFiles.asking(dir), encoding: .utf8)) ?? ""
            #expect(AskLock.current(dir)?.auto == true)
            return answer("¿Cómo se despliega?", auto: true)
        }
        #expect(seen == AskingState(question: "¿Cómo se despliega?", startedAt: startedAt, auto: true))
        #expect(raw == #"{"auto":true,"question":"¿Cómo se despliega?","startedAt":"2026-09-21T14:13:20Z"}"#)
        #expect(result.auto == true)
        #expect(!FileManager.default.fileExists(atPath: LiveFiles.asking(dir).path))
        #expect(!FileManager.default.fileExists(atPath: LiveFiles.askLock(dir).path))
    }

    @Test func manualWithoutQuestionWritesNullAndCleansUpOnFailure() throws {
        let (dir, _) = try temporaryMeeting()
        defer { try? FileManager.default.removeItem(at: dir) }
        var raw = ""
        #expect(throws: RecapError.self) {
            _ = try AskCoordinator.perform(dir: dir, question: nil, auto: false) {
                raw = (try? String(contentsOf: LiveFiles.asking(dir), encoding: .utf8)) ?? ""
                throw RecapError("CLAUDE_FAILED", "boom")
            }
        }
        #expect(raw.contains(#""auto":false"#) && raw.contains(#""question":null"#))
        #expect(!FileManager.default.fileExists(atPath: LiveFiles.asking(dir).path))
        #expect(!FileManager.default.fileExists(atPath: LiveFiles.askLock(dir).path))
    }

    @Test func autoFailsFastWhenBusy() throws {
        let (dir, _) = try temporaryMeeting()
        defer { try? FileManager.default.removeItem(at: dir) }
        let holder = try sleeper()
        defer { holder.terminate() }
        _ = try #require(try AskLock.acquire(dir, auto: false, pid: holder.processIdentifier))
        var ran = false
        #expect(throws: RecapError.self) {
            _ = try AskCoordinator.perform(dir: dir, question: "¿x?", auto: true) {
                ran = true
                return answer("¿x?")
            }
        }
        #expect(!ran)
        #expect(!FileManager.default.fileExists(atPath: LiveFiles.asking(dir).path))
    }

    @Test func answersStayBackwardCompatible() throws {
        let manual = try JSONLines.line(answer("¿a?"))
        #expect(!manual.contains("auto"))
        let auto = try JSONLines.line(answer("¿a?", auto: true))
        #expect(auto.contains(#""auto":true"#))
        let legacy = #"{"id":"1","askedAt":"2026-10-08T10:00:00Z","question":"q","answer":"a","found":true,"sources":[]}"#
        #expect(JSONLines.parse(Answer.self, legacy).first?.auto == nil)
        #expect(AutoAskProcess.arguments(dir: URL(fileURLWithPath: "/m"), question: "¿q?")
                == ["ask", "--dir", "/m", "--question", "¿q?", "--auto", "--json"])
    }
}
