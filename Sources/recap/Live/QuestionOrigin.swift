import Foundation

struct QuestionOrigin: Equatable {
    var questionMs: Int
    var channel: Channel
}

enum QuestionClock {
    static func milliseconds(_ value: Any?) -> Int? {
        guard let text = (value as? String)?.trimmed, !text.isEmpty else { return nil }
        var body = Substring(text)
        if body.hasPrefix("[") && body.hasSuffix("]") { body = body.dropFirst().dropLast() }
        let parts = body.split(separator: ":", omittingEmptySubsequences: false)
        guard parts.count == 2 || parts.count == 3,
              parts.allSatisfy({ !$0.isEmpty && $0.count <= 2 && $0.allSatisfy(\.isASCII) && $0.allSatisfy(\.isNumber) }) else {
            return nil
        }
        let numbers = parts.compactMap { Int($0) }
        guard numbers.count == parts.count else { return nil }
        let (hours, minutes, seconds) = numbers.count == 3 ? (numbers[0], numbers[1], numbers[2]) : (0, numbers[0], numbers[1])
        guard minutes < 60, seconds < 60 else { return nil }
        return ((hours * 60 + minutes) * 60 + seconds) * 1000
    }
}

enum QuestionOriginResolver {
    static func resolve(atMs: Int, segments: [Segment], question: String? = nil) -> QuestionOrigin? {
        let ordered = LiveMerger.ordered(segments.filter { !$0.text.trimmed.isEmpty })
        guard let anchorIndex = anchor(atMs: atMs, ordered: ordered, question: question) else { return nil }
        let paragraph = paragraph(from: anchorIndex, ordered: ordered)
        let chosen = refine(paragraph, question: question) ?? ordered[anchorIndex]
        return QuestionOrigin(questionMs: chosen.startMs, channel: chosen.channel)
    }

    static func resolve(clock: Any?, segments: [Segment], question: String? = nil) -> QuestionOrigin? {
        guard let atMs = QuestionClock.milliseconds(clock) else { return nil }
        return resolve(atMs: atMs, segments: segments, question: question)
    }

    private static func anchor(atMs: Int, ordered: [Segment], question: String?) -> Int? {
        guard !ordered.isEmpty else { return nil }
        let second = atMs / 1000
        let exact = ordered.indices.filter { ordered[$0].startMs / 1000 == second }
        if !exact.isEmpty {
            return best(exact, ordered: ordered, question: question) ?? exact[0]
        }
        let until = second * 1000 + 999
        if let covering = ordered.indices.last(where: { ordered[$0].startMs <= until && ordered[$0].endMs >= atMs }) {
            return covering
        }
        if let before = ordered.indices.last(where: { ordered[$0].startMs <= until }) {
            return before
        }
        return ordered.indices.min { abs(ordered[$0].startMs - atMs) < abs(ordered[$1].startMs - atMs) }
    }

    private static func paragraph(from index: Int, ordered: [Segment]) -> [Segment] {
        let first = ordered[index]
        var members = [first]
        var lastEnd = first.endMs
        for segment in ordered[(index + 1)...] {
            guard segment.channel == first.channel,
                  segment.startMs - lastEnd <= TranscriptRenderer.paragraphGapMs,
                  segment.startMs - first.startMs < TranscriptRenderer.paragraphSpanMs else { break }
            members.append(segment)
            lastEnd = max(lastEnd, segment.endMs)
        }
        return members
    }

    private static func refine(_ members: [Segment], question: String?) -> Segment? {
        guard members.count > 1, let index = best(Array(members.indices), ordered: members, question: question) else { return nil }
        return members[index]
    }

    private static func best(_ indices: [Int], ordered: [Segment], question: String?) -> Int? {
        guard let question = question?.trimmed, !question.isEmpty else { return nil }
        var winner: (index: Int, score: Double)?
        for index in indices {
            let score = QuestionDedupe.similarity(question, ordered[index].text)
            if score > (winner?.score ?? 0) { winner = (index, score) }
        }
        return winner?.index
    }
}
