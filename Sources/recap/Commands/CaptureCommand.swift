import ArgumentParser

struct CaptureCommand: ParsableCommand {
    static let configuration = CommandConfiguration(
        commandName: "capture",
        abstract: "Run recap-capture inside Recap.app (used by tools that launch the bundle).",
        shouldDisplay: false,
        subcommands: CaptureTool.subcommands
    )
}
