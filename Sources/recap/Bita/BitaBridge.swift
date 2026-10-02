import Foundation

struct BitaTarget: Equatable {
    var databasePath: String?
    var docsRoot: String?
}

struct BitaBridge {
    static let section = "Reunión"
    static let kinds: [String: MeetingMode] = [
        "remote-meeting": .remote,
        "in-person-meeting": .inPerson,
    ]

    let config: Config

    func saveMinutes(meeting: Meeting, dir: URL) throws {
        guard let entryId = meeting.bitaEntryId else { return }
        let bita = try Tool.bita.require(config)
        guard let summary = try? String(contentsOf: dir.appending(path: "summary.md"), encoding: .utf8) else {
            throw RecapError("NO_SUMMARY", "\"\(meeting.title)\" has no summary to send to bita")
        }
        let note = dir.appending(path: "bita-note.md")
        try Self.noteBody(summary: summary, meeting: meeting, dir: dir).write(to: note, atomically: true, encoding: .utf8)
        var arguments = ["note", "save", String(entryId), "--note-md", note.path, "--section", Self.section, "--json"]
        if let database = meeting.bitaDatabasePath { arguments += ["--db-path", database] }
        if let docs = meeting.bitaDocsRoot { arguments += ["--docs-dir", docs] }
        var environment = Tool.environment(for: bita, config: config)
        environment["BITA_NO_HOOKS"] = "1"
        let result = try Shell.run(bita, arguments, environment: environment, cwd: URL(fileURLWithPath: "/"))
        guard result.ok else {
            let detail = (result.stdout + result.stderr).trimmed
            throw RecapError("BITA_FAILED", "bita note save \(entryId) failed: \(detail.suffix(400))")
        }
    }

    static func noteBody(summary: String, meeting: Meeting, dir: URL) -> String {
        var body = summary
        if let start = body.range(of: "## Resumen") { body = String(body[start.lowerBound...]) }
        let mode = meeting.mode == .remote ? "remota" : "presencial"
        var lines = ["Minuta de la reunión \(mode) (\(Duration.format(meeting.durationSeconds))), generada por recap a partir de la grabación.", ""]
        var inFence = false
        for line in body.components(separatedBy: "\n") {
            if line.hasPrefix("```") { inFence.toggle() }
            lines.append(!inFence && line.hasPrefix("#") ? "#" + line : line)
        }
        while lines.last?.trimmed.isEmpty == true { lines.removeLast() }
        lines += ["", "Archivos de la reunión: `\(dir.path)` (`summary.md`, `transcript.md`\(meeting.mode == .remote ? ", `frames/`" : ""))."]
        return lines.joined(separator: "\n") + "\n"
    }
}
