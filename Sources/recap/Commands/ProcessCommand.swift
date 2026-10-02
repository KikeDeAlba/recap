import ArgumentParser
import Foundation

extension Stage: ExpressibleByArgument {}

struct ProcessCommand: ParsableCommand {
    static let configuration = CommandConfiguration(
        commandName: "process",
        abstract: "Transcribe a recorded meeting, extract key frames and write its summary."
    )

    @Argument(help: "Meeting id, a unique part of it, or \"last\".")
    var meeting: String = "last"

    @Option(help: "Re-run from this stage on (\(Stage.allCases.map(\.rawValue).joined(separator: ", "))).")
    var from: Stage?

    @Option(help: "Run only this stage.")
    var only: Stage?

    @Flag(help: "Run detached and return immediately; progress goes to process.log.")
    var background = false

    @OptionGroup var output: OutputOptions

    func run() throws {
        try Output.run("process", json: output.json) {
            let config = try Config.load()
            let (found, dir) = try MeetingStore(config: config).resolve(meeting)
            if background {
                try Background.process(meetingId: found.id, dir: dir, extra: stageArguments)
                return (MeetingRecord(meeting: found, dir: dir), "Processing \"\(found.title)\" in the background\n\(dir.appending(path: "process.log").path)")
            }
            let pipeline = Pipeline(dir: dir, config: config) { line in
                if !output.json { FileHandle.standardError.write(Data("\(line)\n".utf8)) }
            }
            let result = try pipeline.run(from: from, only: only)
            let summary = dir.appending(path: "summary.md")
            let text = FileManager.default.fileExists(atPath: summary.path)
                ? "Processed \"\(result.title)\"\n\(summary.path)"
                : "Processed \"\(result.title)\" [\(result.status.rawValue)]\n\(dir.path)"
            return (MeetingRecord(meeting: result, dir: dir), text)
        }
    }

    private var stageArguments: [String] {
        (from.map { ["--from", $0.rawValue] } ?? []) + (only.map { ["--only", $0.rawValue] } ?? [])
    }
}

enum Background {
    static func process(meetingId: String, dir: URL, extra: [String] = []) throws {
        guard let executable = Paths.executable else {
            throw RecapError("LAUNCH_FAILED", "Cannot locate the recap executable")
        }
        _ = try Shell.spawnDetached(executable, ["process", meetingId] + extra, log: dir.appending(path: "process.log"))
    }
}
