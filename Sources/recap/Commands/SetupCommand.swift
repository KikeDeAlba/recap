import AppKit
import ArgumentParser
import Foundation

struct Check: Encodable {
    let name: String
    let ok: Bool
    let detail: String
}

struct PermissionReport: Codable {
    let microphone: String
    let screen: String
}

struct SetupCommand: ParsableCommand {
    static let configuration = CommandConfiguration(
        commandName: "setup",
        abstract: "Check dependencies and request the recording permissions."
    )

    @Flag(name: .customLong("skip-permissions"), help: "Do not launch Recap.app to request permissions.")
    var skipPermissions = false

    @OptionGroup var output: OutputOptions

    func run() throws {
        try Output.run("setup", json: output.json) {
            var checks: [Check] = []
            let os = ProcessInfo.processInfo.operatingSystemVersion
            checks.append(Check(name: "macos", ok: os.majorVersion >= 15,
                                detail: "\(os.majorVersion).\(os.minorVersion).\(os.patchVersion)"))
            for (tool, hint) in [("ffmpeg", "brew install ffmpeg"), ("whisper-cli", "brew install whisper-cpp"),
                                 ("claude", "npm install -g @anthropic-ai/claude-code")] {
                let url = Shell.which(tool)
                checks.append(Check(name: tool, ok: url != nil, detail: url?.path ?? "missing: \(hint)"))
            }
            let app = Paths.appBundle
            checks.append(Check(name: "app", ok: app != nil,
                                detail: app?.path ?? "not running from Recap.app; run `make install`"))
            let config = try Config.load()
            checks.append(Check(name: "root", ok: true, detail: config.rootURL.path))

            if let app, !skipPermissions {
                let report = try Self.requestPermissions(app: app)
                checks.append(Check(name: "microphone", ok: report.microphone == "granted", detail: report.microphone))
                checks.append(Check(name: "screen", ok: report.screen == "granted",
                                    detail: report.screen == "granted" ? "granted" : "\(report.screen): enable Recap in System Settings > Privacy & Security > Screen & System Audio Recording (only needed for --remote)"))
            }
            let text = checks.map { "\($0.ok ? "ok " : "!! ") \($0.name.padding(toLength: 12, withPad: " ", startingAt: 0)) \($0.detail)" }
                .joined(separator: "\n")
            return (checks, text)
        }
    }

    static func requestPermissions(app: URL) throws -> PermissionReport {
        let out = FileManager.default.temporaryDirectory.appending(path: "recap-permissions-\(UUID().uuidString).json")
        defer { try? FileManager.default.removeItem(at: out) }
        let result = try Shell.run(URL(fileURLWithPath: "/usr/bin/open"),
                                   ["-W", "-g", "-n", "-a", app.path, "--args", "permissions", "--out", out.path])
        guard result.ok, let data = try? Data(contentsOf: out),
              let report = try? JSONDecoder().decode(PermissionReport.self, from: data) else {
            throw RecapError("PERMISSIONS_UNKNOWN", "Recap.app did not report its permissions. \(result.stderr)")
        }
        return report
    }
}

struct PermissionsCommand: ParsableCommand {
    static let configuration = CommandConfiguration(
        commandName: "permissions",
        abstract: "Request microphone and screen permissions (used internally by setup).",
        shouldDisplay: false
    )

    @Option(help: "File where the permission report is written.")
    var out: String

    func run() throws {
        let app = NSApplication.shared
        app.setActivationPolicy(.accessory)
        let target = URL(fileURLWithPath: out)
        Task { @MainActor in
            try? await Permissions.requestMicrophone()
            try? Permissions.requestScreen()
            let report = PermissionReport(microphone: Permissions.microphoneStatus, screen: Permissions.screenStatus)
            try? JSONEncoder().encode(report).write(to: target, options: .atomic)
            Darwin.exit(0)
        }
        app.run()
    }
}
