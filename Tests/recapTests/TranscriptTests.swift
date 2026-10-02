import Foundation
import Testing
@testable import recap

@Suite struct TranscriptTests {
    private func segment(_ start: Int, _ end: Int, _ channel: Channel, _ text: String) -> Segment {
        Segment(startMs: start, endMs: end, channel: channel, text: text)
    }

    @Test func parsesWhisperJsonAndDropsHallucinations() throws {
        let json = """
        {"transcription":[
          {"timestamps":{"from":"00:00:00,000","to":"00:00:02,000"},"offsets":{"from":0,"to":2000},"text":" Buenos días a todos."},
          {"timestamps":{"from":"00:00:02,000","to":"00:00:04,000"},"offsets":{"from":2000,"to":4000},"text":" Subtítulos realizados por la comunidad de Amara.org"},
          {"timestamps":{"from":"00:00:04,000","to":"00:00:05,000"},"offsets":{"from":4000,"to":5000},"text":"   "}
        ]}
        """
        let segments = try WhisperOutput.parse(Data(json.utf8), channel: .system)
        #expect(segments == [segment(0, 2000, .system, "Buenos días a todos.")])
    }

    @Test func dropsMicrophoneEchoOfSystemAudio() {
        let system = [segment(10_000, 14_000, .system, "Acordamos entregar el reporte el viernes")]
        let mic = [
            segment(10_300, 14_200, .mic, "acordamos entregar el reporte el viernes"),
            segment(15_000, 17_000, .mic, "Perfecto, yo me encargo del reporte"),
        ]
        let merged = TranscriptMerger.merge(mic: mic, system: system)
        #expect(merged.map(\.channel) == [.system, .mic])
        #expect(merged.last?.text == "Perfecto, yo me encargo del reporte")
    }

    @Test func keepsSimilarTextFarApartInTime() {
        let system = [segment(10_000, 12_000, .system, "Sí, de acuerdo con eso")]
        let mic = [segment(60_000, 62_000, .mic, "Sí, de acuerdo con eso")]
        #expect(TranscriptMerger.merge(mic: mic, system: system).count == 2)
    }

    @Test func groupsConsecutiveSegmentsOfTheSameChannel() {
        let paragraphs = TranscriptRenderer.paragraphs([
            segment(0, 2_000, .mic, "Hola."),
            segment(2_500, 4_000, .mic, "Empezamos."),
            segment(4_500, 6_000, .system, "Adelante."),
            segment(20_000, 21_000, .system, "Otra cosa."),
        ])
        #expect(paragraphs.count == 3)
        #expect(paragraphs[0].text == "Hola. Empezamos.")
        #expect(paragraphs[2].startMs == 20_000)
    }

    @Test func splitsLongMonologuesEveryThirtySeconds() {
        let segments = (0..<10).map { segment($0 * 5_000, $0 * 5_000 + 4_500, .system, "Frase \($0).") }
        let paragraphs = TranscriptRenderer.paragraphs(segments)
        #expect(paragraphs.map(\.startMs) == [0, 30_000])
    }

    @Test func formatsTimestamps() {
        #expect(TranscriptRenderer.timestamp(3_723_456) == "01:02:03")
    }
}

@Suite struct PipelineHelperTests {
    @Test func parsesShowinfoTimes() {
        let log = """
        [Parsed_showinfo_1 @ 0x1] n:   0 pts:      0 pts_time:0       duration:1
        [Parsed_showinfo_1 @ 0x1] n:   1 pts:  45000 pts_time:22.5    duration:1
        [Parsed_showinfo_1 @ 0x1] color_range:unknown
        """
        #expect(Pipeline.showinfoTimes(log) == [0, 22.5])
    }

    @Test func capsFramesEvenly() {
        #expect(Pipeline.evenlySpaced(count: 5, limit: 40) == [0, 1, 2, 3, 4])
        let picked = Pipeline.evenlySpaced(count: 100, limit: 40)
        #expect(picked.count == 40)
        #expect(picked.first == 0)
        #expect(picked.last == 99)
    }

    @Test func extractsSummaryFromClaudeOutput() throws {
        let output = #"{"type":"result","is_error":false,"result":"Aquí va:\n\n## Resumen\nTodo bien."}"#
        #expect(try SummaryPrompt.extractResult(output) == "## Resumen\nTodo bien.")
    }

    @Test func rejectsClaudeErrors() {
        let output = #"{"type":"result","is_error":true,"result":"Credit balance is too low"}"#
        #expect(throws: RecapError.self) { try SummaryPrompt.extractResult(output) }
    }
}
