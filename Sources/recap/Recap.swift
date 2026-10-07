import ArgumentParser

@main
struct Recap: ParsableCommand {
    static let version = "0.4.0"

    static let configuration = CommandConfiguration(
        commandName: "recap",
        abstract: "Record meetings, transcribe them locally and summarize them with Claude Code.",
        version: version,
        subcommands: [
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
        ]
    )
}
