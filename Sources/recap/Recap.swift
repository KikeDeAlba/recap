import ArgumentParser
import Foundation

@main
struct Recap: ParsableCommand {
    static let version = CaptureTool.version

    static let configuration = CommandConfiguration(
        commandName: "recap",
        abstract: "Record meetings, transcribe them locally and summarize them with Claude Code.",
        version: version,
        subcommands: [
            // TODO(recap): drop the Swift pipeline subcommands (process, prompt, save-summary, ask, proposals, live-worker, bita-hook, wait, setup) and their Pipeline, Bita and Live sources; the TypeScript CLI owns the pipeline and this binary keeps capture only.
            StartCommand.self,
            StopCommand.self,
            DiscardCommand.self,
            StatusCommand.self,
            ListCommand.self,
            ShowCommand.self,
            ProcessCommand.self,
            CompressVideoCommand.self,
            StripVideoCommand.self,
            PruneCommand.self,
            DeleteCommand.self,
            PromptCommand.self,
            SaveSummaryCommand.self,
            BitaHookCommand.self,
            WaitCommand.self,
            SetupCommand.self,
            RecordCommand.self,
            PermissionsCommand.self,
            AskCommand.self,
            ProposalsCommand.self,
            ConfigCommand.self,
            LiveWorkerCommand.self,
            CaptureCommand.self,
        ]
    )

    static func main() {
        let arguments = Array(CommandLine.arguments.dropFirst())
        if arguments.first == RepoGit.commandName {
            Darwin.exit(RepoGit.run(Array(arguments.dropFirst())))
        }
        guard arguments.first == CaptureCommand.configuration.commandName else {
            main(nil)
            return
        }
        CaptureCLI.main(Recap.self, arguments: arguments)
    }
}
