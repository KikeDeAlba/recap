import ArgumentParser
import RecapCapture

struct RecapCaptureCommand: ParsableCommand {
    static let configuration = CommandConfiguration(
        commandName: CaptureTool.name,
        abstract: "Capture meetings on macOS: screen, system audio and microphone, plus live audio chunks.",
        version: CaptureTool.version,
        subcommands: CaptureTool.subcommands
    )
}

@main
enum RecapCaptureMain {
    static func main() {
        CaptureCLI.main(RecapCaptureCommand.self, arguments: Array(CommandLine.arguments.dropFirst()))
    }
}
