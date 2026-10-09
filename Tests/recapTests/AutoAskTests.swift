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

private func answer(_ question: String, auto: Bool? = nil) -> Answer {
    Answer(id: UUID().uuidString, askedAt: Date(), question: question, answer: "Con make release.", found: true,
           sources: [], auto: auto)
}

private func deadPid() throws -> Int32 {
    let dead = Process()
    dead.executableURL = URL(fileURLWithPath: "/usr/bin/true")
    try dead.run()
    dead.waitUntilExit()
    return dead.processIdentifier
}

private func boardFiles(_ dir: URL) -> [String] {
    ((try? FileManager.default.contentsOfDirectory(atPath: LiveFiles.askingDir(dir).path)) ?? [])
        .filter { $0.hasSuffix(".json") }.sorted()
}

final class ManualClock {
    var now: Date
    init(_ now: Date) { self.now = now }
}

final class Recorder: @unchecked Sendable {
    private let lock = NSLock()
    private var storedPrompts: [String] = []
    private var storedAsked: [String] = []
    private var storedOrigins: [QuestionOrigin?] = []

    var prompts: [String] { lock.withLock { storedPrompts } }
    var asked: [String] { lock.withLock { storedAsked } }
    var origins: [QuestionOrigin?] { lock.withLock { storedOrigins } }

    func prompt(_ text: String) { lock.withLock { storedPrompts.append(text) } }
    func ask(_ question: String, _ origin: QuestionOrigin?) {
        lock.withLock {
            storedAsked.append(question)
            storedOrigins.append(origin)
        }
    }
}

private func detector(_ dir: URL, _ meeting: Meeting, recorder: Recorder, minSeconds: Int = 5, clock: ManualClock? = nil,
                      template: @escaping () throws -> String = { "{{reviewed}}\n---\n{{transcript}}" },
                      reply: @escaping (String) throws -> String) -> QuestionDetector {
    QuestionDetector(dir: dir, meeting: meeting, minSeconds: minSeconds, dependencies: .init(
        now: { clock?.now ?? Date() }, template: template, context: { ProjectContext() },
        complete: { prompt in recorder.prompt(prompt); return try reply(prompt) },
        enqueue: { question, origin in recorder.ask(question, origin) }, log: { _ in }))
}

@Suite struct DetectorResponseTests {
    @Test func parsesEveryQuestionOfTheList() throws {
        let reply = #"{"questions": [{"question": "¿Cómo se despliega bita-desktop?", "at": "00:00:16"}, {"question": " ¿Dónde está el pipeline? ", "at": "00:01:05"}]}"#
        #expect(try DetectorResponse.parse(reply) == [
            DetectedQuestion(text: "¿Cómo se despliega bita-desktop?", atMs: 16_000),
            DetectedQuestion(text: "¿Dónde está el pipeline?", atMs: 65_000),
        ])
        #expect(try DetectorResponse.parse("```json\n{\"questions\": [{\"question\": \"¿q?\"}]}\n```")
                == [DetectedQuestion(text: "¿q?", atMs: nil)])
        #expect(try DetectorResponse.parse(#"[{"question": "¿q?", "at": "[01:02:03]"}]"#) == [DetectedQuestion(text: "¿q?", atMs: 3_723_000)])
    }

    @Test func parsesAnEmptyList() throws {
        #expect(try DetectorResponse.parse(#"{"questions": []}"#).isEmpty)
        #expect(try DetectorResponse.parse(#"{"questions": null}"#).isEmpty)
        #expect(try DetectorResponse.parse(#"Aquí va: {"questions":[]}"#).isEmpty)
        #expect(try DetectorResponse.parse(#"{"questions": [{"question": null}, {"question": ""}, {"question": "null"}]}"#).isEmpty)
    }

    @Test func toleratesTheLegacySingleObject() throws {
        #expect(try DetectorResponse.parse(#"{"question": "¿Dónde está el pipeline?", "at": "00:01:05"}"#)
                == [DetectedQuestion(text: "¿Dónde está el pipeline?", atMs: 65_000)])
        #expect(try DetectorResponse.parse(#"{"question": null, "at": null}"#).isEmpty)
        #expect(try DetectorResponse.parse(#"{"question": ""}"#).isEmpty)
    }

    @Test func toleratesAMissingOrGarbageClock() throws {
        for garbage in [#""ayer""#, #""00:61:00""#, #""1:2:3:4""#, "65", #""""#, #""00:0a:10""#, #""-1:00""#, "null"] {
            #expect(try DetectorResponse.parse(#"{"questions": [{"question": "¿q?", "at": "# + garbage + "}]}")
                    == [DetectedQuestion(text: "¿q?", atMs: nil)])
        }
        #expect(try DetectorResponse.parse(#"{"question": "¿q?", "at": "02:03"}"#).first?.atMs == 123_000)
    }

    @Test func rejectsGarbage() {
        for garbage in ["No hay preguntas.", #"{"answer": "x"}"#, #"{"question": 3}"#, "{not json}",
                        #"{"questions": "¿q?"}"#, #"{"questions": [3]}"#, #"{"questions": [{"question": 3}]}"#] {
            #expect(throws: RecapError.self) { try DetectorResponse.parse(garbage) }
        }
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
    @Test func runsWhilePendingAndAtMostOncePerInterval() {
        var pacer = DetectionPacer(minSeconds: 5)
        let start = Date(timeIntervalSince1970: 1_000)
        var runs: [Bool] = []
        func check(_ offset: TimeInterval) { runs.append(pacer.shouldRun(now: start.addingTimeInterval(offset))) }
        check(0)
        check(1)
        pacer.grew()
        check(4)
        check(5)
        pacer.settle(remaining: false)
        check(20)
        pacer.settle(remaining: true)
        check(24)
        check(25)
        #expect(runs == [true, false, false, true, false, true, false])
    }

    @Test func detectorRerunsWhileSegmentsRemainUnexaminedEvenWithoutGrowth() throws {
        let (dir, meeting) = try temporaryMeeting()
        defer { try? FileManager.default.removeItem(at: dir) }
        try writeTranscript([Segment(startMs: 0, endMs: 2_000, channel: .system, text: "¿Cómo corro las pruebas?")], to: dir)
        let clock = ManualClock(Date(timeIntervalSince1970: 5_000))
        let recorder = Recorder()
        var replies = ["Lo siento", #"{"questions": []}"#, #"{"questions": []}"#]
        let subject = detector(dir, meeting, recorder: recorder, clock: clock) { _ in
            let reply = replies.removeFirst()
            if replies.count == 1 {
                try JSONLines.append([Segment(startMs: 3_000, endMs: 5_000, channel: .system, text: "Y algo más.")],
                                     to: LiveFiles.transcript(dir))
            }
            return reply
        }
        #expect(subject.tick())
        #expect(subject.waitUntilIdle(timeout: 5))
        #expect(DetectorCursor.load(dir) == .start)
        #expect(!subject.tick())
        clock.now = clock.now.addingTimeInterval(5)
        #expect(subject.tick())
        #expect(subject.waitUntilIdle(timeout: 5))
        #expect(DetectorCursor.load(dir).examinedSegments == 1)
        clock.now = clock.now.addingTimeInterval(5)
        #expect(subject.tick())
        #expect(subject.waitUntilIdle(timeout: 5))
        #expect(DetectorCursor.load(dir) == DetectorCursor(detectedThroughMs: 5_000, examinedSegments: 2))
        clock.now = clock.now.addingTimeInterval(60)
        #expect(!subject.tick())
        #expect(recorder.prompts.count == 3)
        subject.stop()
        subject.transcriptGrew()
        #expect(!subject.tick())
    }
}

@Suite struct QuestionDetectorTests {
    @Test func queuesEveryQuestionAndSendsOnlyTheNewPartAsNew() throws {
        let (dir, meeting) = try temporaryMeeting(mode: .inPerson)
        defer { try? FileManager.default.removeItem(at: dir) }
        try writeTranscript([
            Segment(startMs: 0, endMs: 3_000, channel: .mic, text: "Buenos días a todos."),
            Segment(startMs: 16_000, endMs: 19_000, channel: .mic, text: "¿Cómo se despliega bita-desktop?"),
            Segment(startMs: 23_000, endMs: 26_000, channel: .mic, text: "¿Dónde está el pipeline de CoDi?"),
        ], to: dir)
        let recorder = Recorder()
        var reply = #"{"questions": [{"question": "¿Cómo se despliega bita-desktop?", "at": "00:00:16"}, {"question": "¿Dónde está el pipeline de CoDi?", "at": "00:00:23"}]}"#
        let subject = detector(dir, meeting, recorder: recorder) { _ in reply }
        #expect(subject.runCycle() == .examined(queued: ["¿Cómo se despliega bita-desktop?", "¿Dónde está el pipeline de CoDi?"],
                                                duplicates: []))
        #expect(recorder.origins == [QuestionOrigin(questionMs: 16_000, channel: .mic), QuestionOrigin(questionMs: 23_000, channel: .mic)])
        #expect(DetectorCursor.load(dir) == DetectorCursor(detectedThroughMs: 26_000, examinedSegments: 3))
        let first = try #require(recorder.prompts.first)
        #expect(first.hasPrefix("(nada)\n---\n"))
        #expect(first.contains("Buenos días") && first.contains("¿Dónde está el pipeline de CoDi?"))

        try writeTranscript([Segment(startMs: 32_000, endMs: 35_000, channel: .mic, text: "¿Qué variables usa el webhook de BBVA?")], to: dir)
        reply = #"{"questions": []}"#
        #expect(subject.runCycle() == .examined(queued: [], duplicates: []))
        let second = try #require(recorder.prompts.last)
        let parts = second.components(separatedBy: "\n---\n")
        #expect(parts.count == 2)
        #expect(parts[0].contains("¿Dónde está el pipeline de CoDi?") && !parts[0].contains("webhook"))
        #expect(parts[1].contains("webhook") && !parts[1].contains("pipeline"))
        #expect(subject.runCycle() == .idle)
        #expect(recorder.prompts.count == 2)
    }

    @Test func reviewedContextKeepsOnlyTheLastMinuteBeforeTheCursor() {
        let segments = [
            Segment(startMs: 0, endMs: 5_000, channel: .mic, text: "Muy viejo."),
            Segment(startMs: 70_000, endMs: 75_000, channel: .mic, text: "Reciente."),
            Segment(startMs: 76_000, endMs: 79_000, channel: .mic, text: "  "),
            Segment(startMs: 80_000, endMs: 84_000, channel: .mic, text: "Nuevo."),
        ]
        let batch = DetectorBatch(segments, cursor: DetectorCursor(detectedThroughMs: 79_000, examinedSegments: 3))
        #expect(batch.reviewed.map(\.text) == ["Reciente."])
        #expect(batch.fresh.map(\.text) == ["Nuevo."])
        #expect(batch.cursor == DetectorCursor(detectedThroughMs: 84_000, examinedSegments: 4))
        let late = DetectorBatch(segments + [Segment(startMs: 60_000, endMs: 62_000, channel: .mic, text: "Tardío.")],
                                 cursor: batch.cursor)
        #expect(late.fresh.map(\.text) == ["Tardío."])
        #expect(late.cursor == DetectorCursor(detectedThroughMs: 84_000, examinedSegments: 5))
    }

    @Test func cursorAdvancesOnlyAfterASuccessfulCall() throws {
        let (dir, meeting) = try temporaryMeeting()
        defer { try? FileManager.default.removeItem(at: dir) }
        try writeTranscript([Segment(startMs: 0, endMs: 3_000, channel: .system, text: "¿Cómo corro las pruebas?")], to: dir)
        let recorder = Recorder()
        var reply: () throws -> String = { throw RecapError("CLAUDE_FAILED", "boom") }
        let subject = detector(dir, meeting, recorder: recorder) { _ in try reply() }
        #expect(subject.runCycle() == .failed("CLAUDE_FAILED: boom"))
        #expect(DetectorCursor.load(dir) == .start && subject.hasUnexamined())
        reply = { "Lo siento" }
        if case .failed = subject.runCycle() {} else { Issue.record("garbage should fail the cycle") }
        #expect(DetectorCursor.load(dir) == .start)
        reply = { #"{"questions": [{"question": "¿Cómo se corren las pruebas de recap?", "at": "00:00:00"}]}"# }
        #expect(subject.runCycle() == .examined(queued: ["¿Cómo se corren las pruebas de recap?"], duplicates: []))
        #expect(DetectorCursor.load(dir) == DetectorCursor(detectedThroughMs: 3_000, examinedSegments: 1))
        #expect(!subject.hasUnexamined())
        #expect(recorder.prompts.count == 3)
        #expect(recorder.prompts.allSatisfy { $0.contains("¿Cómo corro las pruebas?") })
    }

    @Test func skipsQuestionsAnsweredRunningQueuedOrAlreadyDetected() throws {
        let (dir, meeting) = try temporaryMeeting()
        defer { try? FileManager.default.removeItem(at: dir) }
        try writeTranscript([Segment(startMs: 0, endMs: 3_000, channel: .system, text: "Varias preguntas.")], to: dir)
        try JSONLines.append([answer("¿Qué cambió en el pipeline de CoDi?")], to: LiveFiles.answers(dir))
        try AskingBoard.write(dir, AskingState(id: "running-1", question: "¿Cómo se despliega bita-desktop?", startedAt: Date(),
                                               auto: false, state: .running, pid: getpid()))
        try AskingBoard.write(dir, AskingState(id: "queued-1", question: "¿Dónde vive el webhook de BBVA?", startedAt: Date(),
                                               auto: true, state: .queued, pid: getpid()))
        try AskingBoard.write(dir, AskingState(id: "stale-1", question: "¿Cómo se rota la llave de Datadog?", startedAt: Date(),
                                               auto: true, state: .running, pid: try deadPid()))
        let recorder = Recorder()
        var reply = #"{"questions": [{"question": "¿Qué cambió en el pipeline de CoDi la semana pasada?"}, {"question": "¿Cómo se despliega bita-desktop a producción?"}, {"question": "¿Dónde vive el webhook de BBVA?"}, {"question": "¿Cómo se rota la llave de Datadog?"}, {"question": "¿Cómo se rota la llave de Datadog en prod?"}]}"#
        let subject = detector(dir, meeting, recorder: recorder, template: { try ResourceText.load("detect-prompt.md") }) { _ in reply }
        #expect(subject.runCycle() == .examined(
            queued: ["¿Cómo se rota la llave de Datadog?"],
            duplicates: ["¿Qué cambió en el pipeline de CoDi la semana pasada?", "¿Cómo se despliega bita-desktop a producción?",
                         "¿Dónde vive el webhook de BBVA?", "¿Cómo se rota la llave de Datadog en prod?"]))
        let prompt = try #require(recorder.prompts.first)
        #expect(!prompt.contains("{{"))
        #expect(prompt.contains("- ¿Cómo se despliega bita-desktop?") && prompt.contains("- ¿Dónde vive el webhook de BBVA?"))
        #expect(!prompt.contains("- ¿Cómo se rota la llave de Datadog?"))
        try writeTranscript([Segment(startMs: 4_000, endMs: 6_000, channel: .system, text: "Otra vez.")], to: dir)
        reply = #"{"questions": [{"question": "¿Cómo se rota la llave de Datadog?"}]}"#
        #expect(subject.runCycle() == .examined(queued: [], duplicates: ["¿Cómo se rota la llave de Datadog?"]))
        #expect(recorder.prompts.last?.contains("- ¿Cómo se rota la llave de Datadog?") == true)
        #expect(recorder.asked == ["¿Cómo se rota la llave de Datadog?"])
    }

    @Test func promptsKeepTheRoomAndTheSpeakers() throws {
        let (_, inPerson) = try temporaryMeeting(mode: .inPerson)
        let batch = DetectorBatch([Segment(startMs: 0, endMs: 3_000, channel: .mic, text: "¿Dónde está el Makefile?")], cursor: .start)
        let prompt = DetectPrompt.render(template: try ResourceText.load("detect-prompt.md"), meeting: inPerson,
                                         context: ProjectContext(project: "bita", pages: [PageRef(pageId: 1, title: "Despliegue", relPath: "d.md", depth: 0)]),
                                         batch: batch, known: [])
        #expect(prompt.contains("presencial") && prompt.contains("(ninguna)") && prompt.contains("(nada)"))
        #expect(prompt.contains("Proyecto: bita") && prompt.contains("- Despliegue"))
        #expect(prompt.contains("] ¿Dónde está el Makefile?") && !prompt.contains("Remotos:"))
        #expect(prompt.contains(#"{"questions": []}"#) && !prompt.contains("{{"))
        let (_, remote) = try temporaryMeeting(mode: .remote)
        let labelled = DetectPrompt.render(template: "{{transcript}}", meeting: remote, context: ProjectContext(),
                                           batch: DetectorBatch([Segment(startMs: 0, endMs: 3_000, channel: .system, text: "¿q?")], cursor: .start),
                                           known: [])
        #expect(labelled.contains("Remotos: ¿q?"))
    }
}

@Suite struct AutoAskQueueTests {
    @Test func neverRunsMoreThanTheLimitAndDropsNothingInOrder() throws {
        let (dir, _) = try temporaryMeeting()
        defer { try? FileManager.default.removeItem(at: dir) }
        let lock = NSLock()
        var active = 0
        var peak = 0
        var started: [String] = []
        let queue = AutoAskQueue(dir: dir, concurrency: 2, run: { job in
            lock.withLock {
                active += 1
                peak = max(peak, active)
                started.append(job.question)
            }
            Thread.sleep(forTimeInterval: 0.08)
            lock.withLock { active -= 1 }
        }, log: { _ in })
        let questions = (1...7).map { "¿Pregunta \($0)?" }
        for question in questions { queue.enqueue(question, origin: nil) }
        #expect(queue.runningCount <= 2)
        #expect(queue.waitUntilIdle(timeout: 10))
        #expect(peak == 2)
        #expect(started == questions)
        #expect(boardFiles(dir).isEmpty)
        #expect(!FileManager.default.fileExists(atPath: LiveFiles.asking(dir).path))
    }

    @Test func boardFollowsQueuedRunningFailedAndFinishedAsks() throws {
        let (dir, _) = try temporaryMeeting()
        defer { try? FileManager.default.removeItem(at: dir) }
        let gates = [DispatchSemaphore(value: 0), DispatchSemaphore(value: 0)]
        let entered = DispatchSemaphore(value: 0)
        var logs: [String] = []
        let logLock = NSLock()
        let queue = AutoAskQueue(dir: dir, concurrency: 1, run: { job in
            entered.signal()
            let index = job.question == "¿Primera?" ? 0 : 1
            gates[index].wait()
            if index == 0 { throw RecapError("CLAUDE_FAILED", "boom") }
        }, log: { message in logLock.withLock { logs.append(message) } })
        let origin = QuestionOrigin(questionMs: 16_000, channel: .mic)
        let first = try #require(queue.enqueue("¿Primera?", origin: origin))
        let second = try #require(queue.enqueue("¿Segunda?", origin: nil))
        #expect(entered.wait(timeout: .now() + 5) == .success)
        var entries = AskingBoard.entries(dir)
        #expect(entries.count == 2)
        let running = try #require(entries.first { $0.id == first.id })
        #expect(running.state == .running && running.auto && running.question == "¿Primera?")
        #expect(running.questionMs == 16_000 && running.channel == .mic && running.pid == getpid())
        #expect(entries.first { $0.id == second.id }?.state == .queued)
        #expect(AskingState.read(dir)?.id == first.id)
        let raw = try String(contentsOf: AskingBoard.file(dir, id: second.id), encoding: .utf8)
        #expect(raw.contains(#""state":"queued""#) && raw.contains(#""id":"\#(second.id)""#) && raw.contains(#""auto":true"#))

        gates[0].signal()
        #expect(entered.wait(timeout: .now() + 5) == .success)
        entries = AskingBoard.entries(dir)
        #expect(entries.map(\.id) == [second.id])
        #expect(entries.first?.state == .running)
        #expect(AskingState.read(dir)?.id == second.id)
        gates[1].signal()
        #expect(queue.waitUntilIdle(timeout: 5))
        #expect(boardFiles(dir).isEmpty)
        #expect(!FileManager.default.fileExists(atPath: LiveFiles.asking(dir).path))
        #expect(logLock.withLock { logs.contains { $0.contains("failed «¿Primera?»") && $0.contains("boom") } })
        #expect(!FileManager.default.fileExists(atPath: LiveFiles.answers(dir).path))
    }

    @Test func cancellingDropsQueuedAsksAndStopsRunningOnes() throws {
        let (dir, _) = try temporaryMeeting()
        defer { try? FileManager.default.removeItem(at: dir) }
        let gate = DispatchSemaphore(value: 0)
        let entered = DispatchSemaphore(value: 0)
        var cancelled = false
        let queue = AutoAskQueue(dir: dir, concurrency: 1, run: { _ in
            entered.signal()
            gate.wait()
            throw RecapError("ASK_INTERRUPTED", "stopped")
        }, cancelRunning: {
            cancelled = true
            gate.signal()
        }, log: { _ in })
        queue.enqueue("¿Primera?", origin: nil)
        queue.enqueue("¿Segunda?", origin: nil)
        #expect(entered.wait(timeout: .now() + 5) == .success)
        queue.cancelAll()
        #expect(cancelled)
        #expect(boardFiles(dir).isEmpty)
        #expect(queue.enqueue("¿Tercera?", origin: nil) == nil)
        #expect(queue.waitingCount == 0 && queue.runningCount == 0)
    }
}

@Suite struct AskCoordinatorTests {
    @Test func writesTheBoardAndTheLegacyFileWhileRunningAndClearsThemAfter() throws {
        let (dir, _) = try temporaryMeeting()
        defer { try? FileManager.default.removeItem(at: dir) }
        let startedAt = Date(timeIntervalSince1970: 1_790_000_000)
        var seen: AskingState?
        var raw = ""
        var legacy = ""
        let result = try AskCoordinator.perform(dir: dir, id: "ask-1", question: " ¿Cómo se despliega? ", auto: true,
                                                now: startedAt, pid: getpid()) {
            seen = AskingState.read(dir)
            raw = (try? String(contentsOf: AskingBoard.file(dir, id: "ask-1"), encoding: .utf8)) ?? ""
            legacy = (try? String(contentsOf: LiveFiles.asking(dir), encoding: .utf8)) ?? ""
            return answer("¿Cómo se despliega?", auto: true)
        }
        #expect(seen == AskingState(id: "ask-1", question: "¿Cómo se despliega?", startedAt: startedAt, auto: true,
                                    state: .running, pid: getpid()))
        #expect(raw == #"{"auto":true,"id":"ask-1","pid":\#(getpid()),"question":"¿Cómo se despliega?","startedAt":"2026-09-21T14:13:20Z","state":"running"}"#)
        #expect(legacy == raw)
        #expect(result.auto == true)
        #expect(boardFiles(dir).isEmpty)
        #expect(!FileManager.default.fileExists(atPath: LiveFiles.asking(dir).path))
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
        #expect(raw.contains(#""auto":false"#) && raw.contains(#""question":null"#) && raw.contains(#""state":"running""#))
        #expect(boardFiles(dir).isEmpty)
        #expect(!FileManager.default.fileExists(atPath: LiveFiles.asking(dir).path))
    }

    @Test func manualAsksRunSideBySideAndTheLegacyFileFollowsTheLatest() throws {
        let (dir, _) = try temporaryMeeting()
        defer { try? FileManager.default.removeItem(at: dir) }
        let first = Date(timeIntervalSince1970: 1_790_000_000)
        var during: [String?] = []
        var after: String?
        _ = try AskCoordinator.perform(dir: dir, id: "outer", question: "¿a?", auto: false, now: first) {
            during.append(AskingState.read(dir)?.id)
            _ = try AskCoordinator.perform(dir: dir, id: "inner", question: "¿b?", auto: false, now: first.addingTimeInterval(2)) {
                during.append(AskingState.read(dir)?.id)
                during.append(String(AskingBoard.entries(dir).count))
                return answer("¿b?")
            }
            after = AskingState.read(dir)?.id
            return answer("¿a?")
        }
        #expect(during == ["outer", "inner", "2"])
        #expect(after == "outer")
        #expect(boardFiles(dir).isEmpty)
    }

    @Test func legacyFileIgnoresQueuedAndDeadAsks() throws {
        let (dir, _) = try temporaryMeeting()
        defer { try? FileManager.default.removeItem(at: dir) }
        let now = Date(timeIntervalSince1970: 1_790_000_000)
        try AskingBoard.write(dir, AskingState(id: "queued", question: "¿q?", startedAt: now.addingTimeInterval(9), auto: true,
                                               state: .queued, pid: getpid()))
        #expect(AskingState.read(dir) == nil)
        try AskingBoard.write(dir, AskingState(id: "dead", question: "¿d?", startedAt: now.addingTimeInterval(5), auto: true,
                                               state: .running, pid: try deadPid()))
        #expect(AskingState.read(dir) == nil)
        try AskingBoard.write(dir, AskingState(id: "live", question: "¿l?", startedAt: now, auto: true, state: .running, pid: getpid()))
        #expect(AskingState.read(dir)?.id == "live")
        #expect(boardFiles(dir) == ["dead.json", "live.json", "queued.json"])
        AskingBoard.prune(dir)
        #expect(boardFiles(dir) == ["live.json", "queued.json"])
        AskingBoard.remove(dir, id: "live")
        #expect(AskingState.read(dir) == nil)
        #expect(throws: RecapError.self) {
            try AskingBoard.write(dir, AskingState(id: "../escape", question: nil, startedAt: now, auto: false))
        }
    }

    @Test func legacyAskingFilesStillDecode() throws {
        let legacy = #"{"auto":false,"question":null,"startedAt":"2026-09-21T14:13:20Z"}"#
        let old = try JSONLines.decoder.decode(AskingState.self, from: Data(legacy.utf8))
        #expect(old.id == nil && old.state == nil && old.questionMs == nil && old.channel == nil && old.isRunning)
        let state = AskingState(id: "a", question: "¿q?", startedAt: Date(timeIntervalSince1970: 1_790_000_000), auto: true,
                                questionMs: 65_400, channel: .mic, state: .queued, pid: 7)
        let raw = String(decoding: try JSONLines.encoder.encode(state), as: UTF8.self)
        #expect(raw == #"{"auto":true,"channel":"mic","id":"a","pid":7,"question":"¿q?","questionMs":65400,"startedAt":"2026-09-21T14:13:20Z","state":"queued"}"#)
        #expect(try JSONLines.decoder.decode(AskingState.self, from: Data(raw.utf8)) == state)
    }

    @Test func askIdsAreSafeFileNames() {
        #expect(AskID.isValid(AskID.make()))
        for bad in ["", "../x", "A", "a/b", "-x", String(repeating: "a", count: 65), "a b"] {
            #expect(!AskID.isValid(bad))
        }
    }

    @Test func answersCarryTheAskIdAndStayBackwardCompatible() throws {
        var tagged = answer("¿a?", auto: true)
        tagged.askedAt = Date(timeIntervalSince1970: 1_790_000_000)
        tagged.askId = "ask-1"
        let line = try JSONLines.line(tagged)
        #expect(line.contains(#""askId":"ask-1""#))
        #expect(JSONLines.parse(Answer.self, line).first == tagged)
        let manual = try JSONLines.line(answer("¿a?"))
        #expect(!manual.contains("auto") && !manual.contains("askId"))
        let legacy = #"{"id":"1","askedAt":"2026-10-08T10:00:00Z","question":"q","answer":"a","found":true,"sources":[]}"#
        let old = try #require(JSONLines.parse(Answer.self, legacy).first)
        #expect(old.auto == nil && old.askId == nil)
    }

    @Test func argumentsCarryTheOriginAndTheAskId() {
        #expect(AutoAskProcess.arguments(dir: URL(fileURLWithPath: "/m"), question: "¿q?")
                == ["ask", "--dir", "/m", "--question", "¿q?", "--auto", "--json"])
        let origin = QuestionOrigin(questionMs: 65_400, channel: .system)
        #expect(AutoAskProcess.arguments(dir: URL(fileURLWithPath: "/m"), question: "¿q?", origin: origin, askId: "abc")
                == ["ask", "--dir", "/m", "--question", "¿q?", "--auto", "--json", "--question-ms", "65400", "--channel", "system",
                    "--ask-id", "abc"])
    }

    @Test func askCommandParsesTheHiddenFlags() throws {
        let command = try AskCommand.parse(["--dir", "/m", "--question", "¿q?", "--auto", "--question-ms", "65400", "--channel", "mic",
                                            "--ask-id", "0f1e-ab"])
        #expect(command.questionMs == 65_400 && command.channel == .mic && command.askId == "0f1e-ab")
        #expect(throws: (any Error).self) { try AskCommand.parse(["--dir", "/m", "--channel", "zoom"]) }
        #expect(throws: (any Error).self) { try AskCommand.parse(["--dir", "/m", "--question-ms", "-5"]) }
        #expect(throws: (any Error).self) { try AskCommand.parse(["--dir", "/m", "--ask-id", "../x"]) }
    }

    @Test func answersCarryTheirOriginOnlyWhenKnown() throws {
        var full = answer("¿a?", auto: true)
        full.askedAt = Date(timeIntervalSince1970: 1_790_000_000)
        full.answeredAt = Date(timeIntervalSince1970: 1_790_000_012)
        full.questionMs = 65_400
        full.channel = .system
        let line = try JSONLines.line(full)
        #expect(line.contains(#""answeredAt":"2026-09-21T14:13:32Z""#))
        #expect(line.contains(#""questionMs":65400"#) && line.contains(#""channel":"system""#))
        #expect(JSONLines.parse(Answer.self, line).first == full)
        let bare = try JSONLines.line(answer("¿a?"))
        #expect(!bare.contains("answeredAt") && !bare.contains("questionMs") && !bare.contains("channel"))
    }
}

@Suite struct ProcessTreeTests {
    @Test func terminateAlsoStopsTheChildren() throws {
        let shell = Process()
        shell.executableURL = URL(fileURLWithPath: "/bin/sh")
        shell.arguments = ["-c", "sleep 30; true"]
        try shell.run()
        defer { if shell.isRunning { shell.terminate() } }
        #expect(ProcessCheck.waitUntil(timeout: 5, interval: 0.05) { !ProcessTree.descendants(of: shell.processIdentifier).isEmpty })
        let children = ProcessTree.descendants(of: shell.processIdentifier)
        ProcessTree.terminate(shell.processIdentifier)
        shell.waitUntilExit()
        #expect(ProcessCheck.waitUntil(timeout: 3, interval: 0.05) { children.allSatisfy { !ProcessCheck.isAlive($0) } })
    }
}
