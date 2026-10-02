import ArgumentParser
import Foundation

struct PromptCommand: ParsableCommand {
    static let configuration = CommandConfiguration(
        commandName: "prompt",
        abstract: "Print the summary prompt of a meeting, with its transcript and key frames."
    )

    @Argument(help: "Meeting id, a unique part of it, or \"last\".")
    var meeting: String = "last"

    func run() throws {
        try Output.run("prompt", json: false) {
            let (found, dir) = try MeetingStore(config: try Config.load()).resolve(meeting)
            return ("", "Directorio de la reunión: \(dir.path)\n\n" + (try SummaryPrompt.render(meeting: found, dir: dir)))
        }
    }
}

struct SaveSummaryCommand: ParsableCommand {
    static let configuration = CommandConfiguration(
        commandName: "save-summary",
        abstract: "Store a summary written elsewhere (for example inside a Claude Code session) as the meeting minutes."
    )

    @Argument(help: "Meeting id, a unique part of it, or \"last\".")
    var meeting: String

    @Argument(help: "Markdown file with the summary, starting at \"## Resumen\". Use - for stdin.")
    var file: String

    @OptionGroup var output: OutputOptions

    func run() throws {
        try Output.run("save-summary", json: output.json) {
            let (found, dir) = try MeetingStore(config: try Config.load()).resolve(meeting)
            let body: String
            if file == "-" {
                body = String(decoding: FileHandle.standardInput.readDataToEndOfFile(), as: UTF8.self)
            } else {
                body = try String(contentsOf: URL(fileURLWithPath: file), encoding: .utf8)
            }
            try SummaryPrompt.save(body, meeting: found, dir: dir)
            let updated = try MeetingFile.update(dir) {
                $0.stages[Stage.summarize.rawValue] = StageState(status: "done", updatedAt: Date())
                let stages = $0.stages
                let complete = Stage.allCases.filter { $0.applies(to: found.mode) }
                    .allSatisfy { stages[$0.rawValue]?.status == "done" }
                if complete { $0.status = .processed }
            }
            return (MeetingRecord(meeting: updated, dir: dir), dir.appending(path: "summary.md").path)
        }
    }
}
