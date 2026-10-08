import Foundation

struct LiveMerger {
    static let systemMemoryMs = 60_000
    static let repeatWindowMs = 30_000

    let hasSystem: Bool
    let holdSeconds: TimeInterval

    private(set) var systemCoveredMs = 0
    private var recentSystem: [Segment] = []
    private var pendingMic: [(segment: Segment, addedAt: Date)] = []
    private var lastText: [Channel: Segment] = [:]

    init(hasSystem: Bool, holdSeconds: TimeInterval) {
        self.hasSystem = hasSystem
        self.holdSeconds = holdSeconds
    }

    var pendingCount: Int { pendingMic.count }

    mutating func add(_ segments: [Segment], channel: Channel, coveredUntilMs: Int, now: Date) -> [Segment] {
        var fresh: [Segment] = []
        for segment in segments where !isRepeat(segment) { fresh.append(segment) }
        switch channel {
        case .system:
            recentSystem += fresh
            systemCoveredMs = max(systemCoveredMs, coveredUntilMs)
            let horizon = systemCoveredMs - Self.systemMemoryMs
            recentSystem.removeAll { $0.endMs < horizon }
            return Self.ordered(fresh + release(now: now, force: false))
        case .mic:
            guard hasSystem else { return Self.ordered(fresh) }
            pendingMic += fresh.map { ($0, now) }
            return Self.ordered(release(now: now, force: false))
        }
    }

    mutating func advance(_ channel: Channel, toMs: Int, now: Date) -> [Segment] {
        if channel == .system { systemCoveredMs = max(systemCoveredMs, toMs) }
        return Self.ordered(release(now: now, force: false))
    }

    mutating func release(now: Date, force: Bool) -> [Segment] {
        var ready: [Segment] = []
        var waiting: [(segment: Segment, addedAt: Date)] = []
        for item in pendingMic {
            let covered = item.segment.endMs + TranscriptMerger.echoWindowMs <= systemCoveredMs
            let expired = now.timeIntervalSince(item.addedAt) >= holdSeconds
            if force || covered || expired {
                if !recentSystem.contains(where: { TranscriptMerger.isEcho(item.segment, of: $0) }) {
                    ready.append(item.segment)
                }
            } else {
                waiting.append(item)
            }
        }
        pendingMic = waiting
        return Self.ordered(ready)
    }

    private mutating func isRepeat(_ segment: Segment) -> Bool {
        defer { lastText[segment.channel] = segment }
        guard let previous = lastText[segment.channel] else { return false }
        return segment.startMs - previous.endMs <= Self.repeatWindowMs
            && !TextSimilarity.tokens(segment.text).isEmpty
            && TextSimilarity.tokens(previous.text) == TextSimilarity.tokens(segment.text)
    }

    static func ordered(_ segments: [Segment]) -> [Segment] {
        segments.sorted { $0.startMs == $1.startMs ? $0.channel == .system && $1.channel == .mic : $0.startMs < $1.startMs }
    }
}

enum LiveTranscript {
    static func load(_ meetingDir: URL) -> [Segment] {
        let live = JSONLines.read(Segment.self, from: LiveFiles.transcript(meetingDir))
        if !live.isEmpty { return LiveMerger.ordered(live) }
        guard let data = try? Data(contentsOf: meetingDir.appending(path: "transcript.json")),
              let final = try? JSONDecoder().decode([Segment].self, from: data) else { return [] }
        return LiveMerger.ordered(final)
    }

    static func window(_ segments: [Segment], seconds: Int) -> [Segment] {
        guard let latest = segments.map(\.endMs).max() else { return [] }
        let from = latest - max(1, seconds) * 1000
        return segments.filter { $0.endMs >= from }
    }

    static func render(_ segments: [Segment], labelled: Bool) -> String {
        let paragraphs = TranscriptRenderer.paragraphs(segments)
        guard !paragraphs.isEmpty else { return "_Todavía no hay transcripción._" }
        return paragraphs.map { paragraph in
            let speaker = labelled ? " \(paragraph.channel.speakerLabel):" : ""
            return "[\(TranscriptRenderer.timestamp(paragraph.startMs))]\(speaker) \(paragraph.text)"
        }.joined(separator: "\n")
    }
}
