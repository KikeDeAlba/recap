import Foundation

enum Channel: String, Codable {
    case mic
    case system

    var speakerLabel: String {
        switch self {
        case .mic: "Sala"
        case .system: "Remotos"
        }
    }
}

struct Segment: Codable, Equatable {
    var startMs: Int
    var endMs: Int
    var channel: Channel
    var text: String
}

enum WhisperOutput {
    private struct File: Decodable {
        struct Item: Decodable {
            struct Offsets: Decodable {
                let from: Int
                let to: Int
            }
            let offsets: Offsets
            let text: String
        }
        let transcription: [Item]
    }

    static func parse(_ data: Data, channel: Channel) throws -> [Segment] {
        let file = try JSONDecoder().decode(File.self, from: data)
        return file.transcription.compactMap { item in
            let text = item.text.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !text.isEmpty, !Hallucinations.matches(text) else { return nil }
            return Segment(startMs: item.offsets.from, endMs: item.offsets.to, channel: channel, text: text)
        }
    }
}

enum Hallucinations {
    static let patterns = [
        "amara.org",
        "subtitulos realizados por",
        "subtitulos por la comunidad",
        "gracias por ver el video",
        "suscribete al canal",
        "thanks for watching",
        "[musica]",
        "(musica)",
        "[blank_audio]",
    ]

    static func matches(_ text: String) -> Bool {
        let normalized = TextSimilarity.fold(text)
        if normalized.isEmpty { return true }
        return patterns.contains { normalized.contains($0) }
    }
}

enum TextSimilarity {
    static func fold(_ text: String) -> String {
        text.folding(options: [.diacriticInsensitive, .caseInsensitive], locale: Locale(identifier: "es"))
            .trimmingCharacters(in: .whitespacesAndNewlines)
    }

    static func tokens(_ text: String) -> Set<String> {
        Set(fold(text).components(separatedBy: CharacterSet.alphanumerics.inverted).filter { $0.count > 1 })
    }

    static func jaccard(_ a: String, _ b: String) -> Double {
        let left = tokens(a)
        let right = tokens(b)
        guard !left.isEmpty, !right.isEmpty else { return 0 }
        return Double(left.intersection(right).count) / Double(left.union(right).count)
    }
}

enum TranscriptMerger {
    static let echoWindowMs = 2_500
    static let echoSimilarity = 0.5

    static func merge(mic: [Segment], system: [Segment]) -> [Segment] {
        let filteredMic = mic.filter { segment in
            !system.contains { isEcho(segment, of: $0) }
        }
        return (filteredMic + system).sorted {
            $0.startMs == $1.startMs ? $0.channel == .system && $1.channel == .mic : $0.startMs < $1.startMs
        }
    }

    static func isEcho(_ micSegment: Segment, of systemSegment: Segment) -> Bool {
        let overlaps = micSegment.startMs <= systemSegment.endMs + echoWindowMs
            && systemSegment.startMs <= micSegment.endMs + echoWindowMs
        return overlaps && TextSimilarity.jaccard(micSegment.text, systemSegment.text) >= echoSimilarity
    }
}

struct Paragraph: Equatable {
    var startMs: Int
    var channel: Channel
    var text: String
}

enum TranscriptRenderer {
    static let paragraphGapMs = 4_000
    static let paragraphSpanMs = 30_000

    static func paragraphs(_ segments: [Segment]) -> [Paragraph] {
        var result: [Paragraph] = []
        var lastEnd = Int.min
        for segment in segments {
            if var last = result.last, last.channel == segment.channel, segment.startMs - lastEnd <= paragraphGapMs,
               segment.startMs - last.startMs < paragraphSpanMs {
                last.text += " " + segment.text
                result[result.count - 1] = last
            } else {
                result.append(Paragraph(startMs: segment.startMs, channel: segment.channel, text: segment.text))
            }
            lastEnd = max(lastEnd, segment.endMs)
        }
        return result
    }

    static func markdown(meeting: Meeting, segments: [Segment]) -> String {
        var lines = ["# Transcripción: \(meeting.title)", ""]
        lines.append(header(meeting))
        lines.append("")
        if meeting.mode == .remote {
            lines.append("> **Sala**: micrófono local (quien graba y quien esté en la misma sala). **Remotos**: audio de la llamada.")
            lines.append("")
        }
        let paragraphs = paragraphs(segments)
        if paragraphs.isEmpty {
            lines.append("_No se detectó voz en la grabación._")
        }
        for paragraph in paragraphs {
            let speaker = meeting.mode == .remote ? " \(paragraph.channel.speakerLabel):" : ""
            lines.append("**[\(timestamp(paragraph.startMs))]\(speaker)** \(paragraph.text)")
            lines.append("")
        }
        return lines.joined(separator: "\n")
    }

    static func header(_ meeting: Meeting) -> String {
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "es_MX")
        formatter.dateFormat = "d 'de' MMMM 'de' yyyy, HH:mm"
        let date = formatter.string(from: meeting.startedAt ?? meeting.createdAt)
        let mode = meeting.mode == .remote ? "remota" : "presencial"
        return "\(date) · \(Duration.format(meeting.durationSeconds)) · reunión \(mode)"
    }

    static func timestamp(_ ms: Int) -> String {
        let total = max(0, ms / 1000)
        return String(format: "%02d:%02d:%02d", total / 3600, (total % 3600) / 60, total % 60)
    }
}
