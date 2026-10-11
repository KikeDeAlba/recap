import AppKit
import ArgumentParser
import Darwin
import Foundation

package enum CaptureTool {
    package static let name = "recap-capture"
    package static let version = "0.11.1"
    package static let envelope = 1
    package static let capabilities = ["capture.remote", "capture.in-person", "capture.live-chunks"]
    package static let subcommands: [ParsableCommand.Type] = [
        CaptureRecordCommand.self,
        CapturePermissionsCommand.self,
        CaptureCapabilitiesCommand.self,
    ]

    package static func run<T: Encodable>(_ command: String, json: Bool, _ body: () throws -> (T, String)) throws {
        try Output.run(command, json: json, program: name, compact: true, body)
    }
}

package struct CaptureCapabilities: Codable, Equatable {
    package var name = CaptureTool.name
    package var version = CaptureTool.version
    package var envelope = CaptureTool.envelope
    package var capabilities = CaptureTool.capabilities
    package var emits: [String] = []

    package init() {}
}

package struct CapturePermissions: Codable, Equatable {
    package var microphone: String
    package var screen: String

    package init(microphone: String, screen: String) {
        self.microphone = microphone
        self.screen = screen
    }

    package static var current: CapturePermissions {
        CapturePermissions(microphone: Permissions.microphoneStatus, screen: Permissions.screenStatus)
    }

    package var text: String {
        "microphone: \(microphone)\nscreen: \(screen)"
    }
}

package struct CaptureRecordCommand: ParsableCommand {
    package static let configuration = CommandConfiguration(
        commandName: "record",
        abstract: "Record the meeting in <meetingDir> until SIGINT or SIGTERM.",
        discussion: """
        Reads meeting.json (mode, display), writes status, recorderPid, startedAt and endedAt back to it, \
        and records to recording.mov (remote) or recording.m4a (in-person). When live.enabled is on, it also \
        writes live/chunks/*.wav and live/chunks/index.jsonl and spawns the live worker as \
        <command…> <meetingDir>.
        """
    )

    @Argument(help: "Meeting directory containing meeting.json.")
    package var meetingDir: String

    @Option(name: .customLong("live-worker"),
            help: ArgumentHelp("Live worker to spawn: an executable (run as <path> live-worker <meetingDir>), a JSON array with the full command, or none.",
                               valueName: "command"))
    package var liveWorker: String?

    package init() {}

    package func run() throws {
        RecordingController(dir: URL(fileURLWithPath: meetingDir), liveWorker: liveWorker).run()
    }
}

package struct CapturePermissionsCommand: ParsableCommand {
    package static let configuration = CommandConfiguration(
        commandName: "permissions",
        abstract: "Report the microphone and screen recording permissions.",
        discussion: "--request asks macOS for them; it only takes effect when running inside Recap.app."
    )

    @Flag(help: "Ask for the permissions that are not granted yet.")
    package var request = false

    @OptionGroup package var output: OutputOptions

    package init() {}

    package func run() throws {
        guard request else {
            try report()
            return
        }
        let app = NSApplication.shared
        app.setActivationPolicy(.accessory)
        let json = output.json
        Task { @MainActor in
            try? await Permissions.requestMicrophone()
            try? Permissions.requestScreen()
            let status: Int32 = (try? CapturePermissionsCommand.report(json: json)) == nil ? 1 : 0
            Darwin.exit(status)
        }
        app.run()
    }

    private func report() throws {
        try Self.report(json: output.json)
    }

    private static func report(json: Bool) throws {
        try CaptureTool.run("permissions", json: json) {
            let permissions = CapturePermissions.current
            return (permissions, permissions.text)
        }
    }
}

package struct CaptureCapabilitiesCommand: ParsableCommand {
    package static let configuration = CommandConfiguration(
        commandName: "capabilities",
        abstract: "Print the name, version and capabilities of recap-capture."
    )

    @OptionGroup package var output: OutputOptions

    package init() {}

    package func run() throws {
        try CaptureTool.run("capabilities", json: output.json) {
            let capabilities = CaptureCapabilities()
            let text = (["\(capabilities.name) \(capabilities.version)"] + capabilities.capabilities).joined(separator: "\n")
            return (capabilities, text)
        }
    }
}

package enum CaptureCLI {
    package static let usageError = "USAGE"

    package static func main(_ root: ParsableCommand.Type, arguments: [String]) -> Never {
        var command: ParsableCommand
        do {
            command = try root.parseAsRoot(arguments)
        } catch {
            if let envelope = usageEnvelope(root, arguments: arguments, error: error) {
                print(envelope)
                Darwin.exit(root.exitCode(for: error).rawValue)
            }
            root.exit(withError: error)
        }
        do {
            try command.run()
            root.exit()
        } catch {
            root.exit(withError: error)
        }
    }

    package static func wantsJSON(_ arguments: [String]) -> Bool {
        arguments.prefix { $0 != "--" }.contains("--json")
    }

    package static func usageEnvelope(_ root: ParsableCommand.Type, arguments: [String], error: Error) -> String? {
        guard wantsJSON(arguments), root.exitCode(for: error) != .success else { return nil }
        let command = arguments.first { !$0.hasPrefix("-") && $0 != "capture" } ?? CaptureTool.name
        let withoutJSON = arguments.filter { $0 != "--json" }
        var reported = error
        do {
            _ = try root.parseAsRoot(withoutJSON)
        } catch {
            reported = error
        }
        let failure = RecapError(usageError, root.message(for: reported).trimmed)
        return Output.render(Output.failureEnvelope(command, failure), compact: true)
    }
}
