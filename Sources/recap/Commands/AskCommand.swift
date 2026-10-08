import ArgumentParser
import Foundation

struct AskSourcesData: Encodable {
    let project: String?
    let docsRoot: String?
    let repos: [RepoRef]
}

struct AskCommand: ParsableCommand {
    static let configuration = CommandConfiguration(
        commandName: "ask",
        abstract: "Answer the last question of a meeting from the bita pages and the project repositories."
    )

    @Flag(help: "Use the meeting being recorded.")
    var active = false

    @Option(help: "Meeting id, a unique part of it, or \"last\".")
    var meeting: String?

    @Option(name: .customLong("bita-entry"), help: "Use the meeting linked to this bita entry.")
    var bitaEntry: Int?

    @Option(help: "Question to answer; by default the last one asked in the live transcript.")
    var question: String?

    @Option(help: "Seconds of live transcript to give as context.")
    var window: Int = 180

    @Flag(help: "Print what would be consulted, without calling claude.")
    var sources = false

    @Option(help: "With --sources, the bita project to inspect.")
    var project: String?

    @Flag(name: .customLong("json-stream"), help: "Print one JSON event per line while answering.")
    var jsonStream = false

    @OptionGroup var output: OutputOptions

    func validate() throws {
        if sources {
            guard project != nil || active || meeting != nil || bitaEntry != nil else {
                throw ValidationError("--sources needs --project, --active, --meeting or --bita-entry")
            }
            return
        }
        let targets = [active, meeting != nil, bitaEntry != nil].filter { $0 }.count
        guard targets == 1 else { throw ValidationError("Choose one of --active, --meeting or --bita-entry") }
        guard window > 0 else { throw ValidationError("--window must be positive") }
    }

    func run() throws {
        if sources {
            try Output.run("ask", json: output.json) {
                let config = try Config.load()
                let found = (active || meeting != nil || bitaEntry != nil) ? try target(config) : nil
                let bita = found.flatMap { MeetingContext.bita($0.0, config: config) }
                    ?? (try? BitaClient(config: config, target: BitaTarget()))
                let name = project ?? found.flatMap { MeetingContext.project($0.0) }
                let context = ProjectContextLoader.load(project: name, docsRoot: found?.0.bitaDocsRoot, bita: bita)
                let data = AskSourcesData(project: context.project, docsRoot: context.docsRoot, repos: context.repos)
                var lines = ["Project: \(context.project ?? "(none)")", "Docs: \(context.docsRoot ?? "(unknown)")"]
                lines += context.repos.map { "Repo: \($0.slug) \($0.path)\($0.exists ? "" : " (missing)")" }
                return (data, lines.joined(separator: "\n"))
            }
            return
        }
        if jsonStream {
            try runStreaming()
        } else {
            try Output.run("ask", json: output.json) {
                let answer = try answer { event in
                    guard !output.json else { return }
                    switch event {
                    case let .delta(text): Self.write(text)
                    case let .progress(text): FileHandle.standardError.write(Data("· \(text)\n".utf8))
                    default: break
                    }
                }
                var text = output.json ? "" : "\n"
                if !answer.sources.isEmpty {
                    text += "\nFuentes:\n" + answer.sources.map { "- \($0.label)" }.joined(separator: "\n")
                }
                return (answer, text.trimmingCharacters(in: .newlines).isEmpty ? "" : text)
            }
        }
    }

    private func runStreaming() throws {
        do {
            _ = try answer { event in Self.emitLine(event) }
        } catch {
            let failure = (error as? RecapError) ?? RecapError("UNEXPECTED", String(describing: error))
            Self.emitLine(.error(code: failure.code, message: failure.message))
            throw ExitCode(1)
        }
    }

    private func answer(_ emit: @escaping (AskEvent) -> Void) throws -> Answer {
        let config = try Config.load()
        let (found, dir) = try target(config)
        let context = ProjectContextLoader.load(project: MeetingContext.project(found), docsRoot: found.bitaDocsRoot,
                                                bita: MeetingContext.bita(found, config: config))
        let request = AskRequest(meeting: found, dir: dir, question: question, windowSeconds: window)
        return try AskSession(config: config, emit: emit).run(request, context: context)
    }

    private func target(_ config: Config) throws -> (Meeting, URL) {
        if active {
            guard let (recording, meeting) = ActiveRecording.current() else {
                throw RecapError("NOT_RECORDING", "There is no active recording")
            }
            return (meeting, recording.dirURL)
        }
        return try MeetingTarget.resolve(MeetingStore(config: config), reference: meeting, bitaEntryId: bitaEntry)
    }

    static func emitLine(_ event: AskEvent) {
        guard let line = try? JSONLines.line(event) else { return }
        write(line + "\n")
    }

    static func write(_ text: String) {
        FileHandle.standardOutput.write(Data(text.utf8))
    }
}
