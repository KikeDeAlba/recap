import Foundation
import Testing
@testable import recap

private let conversation = [
    Segment(startMs: 1_200, endMs: 4_000, channel: .mic, text: "Buenos días a todos."),
    Segment(startMs: 9_500, endMs: 12_000, channel: .system, text: "Oye, una duda rápida."),
    Segment(startMs: 12_400, endMs: 16_000, channel: .system, text: "¿Cómo se despliega bita-desktop a producción?"),
    Segment(startMs: 30_000, endMs: 33_000, channel: .mic, text: "Déjame revisar."),
    Segment(startMs: 30_200, endMs: 31_000, channel: .system, text: "Claro."),
]

@Suite struct QuestionClockTests {
    @Test func readsClockStrings() {
        #expect(QuestionClock.milliseconds("00:00:09") == 9_000)
        #expect(QuestionClock.milliseconds(" [00:01:05] ") == 65_000)
        #expect(QuestionClock.milliseconds("1:02:03") == 3_723_000)
        #expect(QuestionClock.milliseconds("02:03") == 123_000)
    }

    @Test func rejectsAnythingElse() {
        for value: Any? in [nil, NSNull(), 65, "", "ayer", "00:60:00", "00:00:60", "1:2:3:4", "00:0a:10", "-1:00", "001:00:00"] {
            #expect(QuestionClock.milliseconds(value) == nil)
        }
    }
}

@Suite struct QuestionOriginResolverTests {
    @Test func usesTheSegmentThatStartsAtTheRenderedSecond() {
        #expect(QuestionOriginResolver.resolve(atMs: 1_000, segments: conversation)
                == QuestionOrigin(questionMs: 1_200, channel: .mic))
        #expect(QuestionOriginResolver.resolve(atMs: 30_000, segments: conversation)
                == QuestionOrigin(questionMs: 30_000, channel: .mic))
        #expect(QuestionOriginResolver.resolve(atMs: 30_000, segments: conversation, question: "¿Claro?")
                == QuestionOrigin(questionMs: 30_200, channel: .system))
    }

    @Test func prefersTheParagraphLineThatMatchesTheQuestion() {
        #expect(QuestionOriginResolver.resolve(atMs: 9_000, segments: conversation)
                == QuestionOrigin(questionMs: 9_500, channel: .system))
        #expect(QuestionOriginResolver.resolve(atMs: 9_000, segments: conversation,
                                               question: "¿Cómo se despliega bita-desktop en producción?")
                == QuestionOrigin(questionMs: 12_400, channel: .system))
    }

    @Test func fallsBackToTheCoveringOrPreviousSegment() {
        #expect(QuestionOriginResolver.resolve(atMs: 14_000, segments: conversation)
                == QuestionOrigin(questionMs: 12_400, channel: .system))
        #expect(QuestionOriginResolver.resolve(atMs: 20_000, segments: conversation)
                == QuestionOrigin(questionMs: 12_400, channel: .system))
        #expect(QuestionOriginResolver.resolve(atMs: 0, segments: conversation)
                == QuestionOrigin(questionMs: 1_200, channel: .mic))
        #expect(QuestionOriginResolver.resolve(atMs: 5_000, segments: []) == nil)
    }

    @Test func resolvesClockStrings() {
        #expect(QuestionOriginResolver.resolve(clock: "00:00:12", segments: conversation)
                == QuestionOrigin(questionMs: 12_400, channel: .system))
        #expect(QuestionOriginResolver.resolve(clock: "nunca", segments: conversation) == nil)
    }
}

@Suite struct AnswerOriginTests {
    private func assembler(_ text: String) -> AnswerAssembler {
        var assembler = AnswerAssembler()
        _ = assembler.feed(text)
        _ = assembler.finish()
        return assembler
    }

    @Test func manualAskWithoutQuestionResolvesTheSourcesClock() {
        let text = "PREGUNTA: ¿Cómo se despliega bita-desktop?\nCon `pnpm release`.\n```fuentes\n"
            + #"{"question":"¿Cómo se despliega bita-desktop?","at":"00:00:09","found":true,"sources":[]}"#
            + "\n```"
        let answer = AnswerBuilder.build(id: "a", askedAt: Date(), explicitQuestion: nil, assembler: assembler(text),
                                         segments: conversation)
        #expect(answer.questionMs == 12_400 && answer.channel == .system)
    }

    @Test func typedQuestionsAndMissingClocksStayWithoutOrigin() {
        let text = "Con `pnpm release`.\n```fuentes\n" + #"{"at":"00:00:09","found":true,"sources":[]}"# + "\n```"
        let typed = AnswerBuilder.build(id: "a", askedAt: Date(), explicitQuestion: "¿Cómo se despliega?",
                                        assembler: assembler(text), segments: conversation)
        #expect(typed.questionMs == nil && typed.channel == nil)
        let noClock = "Con `pnpm release`.\n```fuentes\n" + #"{"at":null,"found":true,"sources":[]}"# + "\n```"
        let missing = AnswerBuilder.build(id: "a", askedAt: Date(), explicitQuestion: nil,
                                          assembler: assembler(noClock), segments: conversation)
        #expect(missing.questionMs == nil && missing.channel == nil)
    }

    @Test func detectorPassesTheResolvedOriginToTheAsk() throws {
        let dir = FileManager.default.temporaryDirectory.appending(path: "recap-origin-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: dir) }
        try JSONLines.append(conversation, to: LiveFiles.transcript(dir))
        let meeting = Meeting(id: "m", title: "Daily", mode: .remote, status: .recording, createdAt: Date())
        var received: [(String, QuestionOrigin?)] = []
        let detector = QuestionDetector(dir: dir, meeting: meeting, minSeconds: 20, dependencies: .init(
            template: { "{{transcript}}" }, context: { ProjectContext() },
            complete: { _ in #"{"questions": [{"question": "¿Cómo se despliega bita-desktop a producción?", "at": "00:00:09"}]}"# },
            enqueue: { question, origin in received.append((question, origin)) }, log: { _ in }))
        #expect(detector.runCycle() == .examined(queued: ["¿Cómo se despliega bita-desktop a producción?"], duplicates: []))
        #expect(received.first?.1 == QuestionOrigin(questionMs: 12_400, channel: .system))
    }
}
