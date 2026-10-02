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

    @Flag(name: .customLong("skip-models"), help: "Do not download the transcription models.")
    var skipModels = false

    @Flag(name: .customLong("skip-bita"), help: "Do not register the recap hook in bita.")
    var skipBita = false

    @Flag(name: .customLong("install-deps"), help: "Install a missing ffmpeg or whisper-cpp with Homebrew.")
    var installDeps = false

    @OptionGroup var output: OutputOptions

    func run() throws {
        try Output.run("setup", json: output.json) {
            var checks: [Check] = []
            let os = ProcessInfo.processInfo.operatingSystemVersion
            checks.append(Check(name: "macos", ok: os.majorVersion >= 15,
                                detail: "\(os.majorVersion).\(os.minorVersion).\(os.patchVersion)"))
            var config = try Config.load()
            if installDeps {
                try Self.installMissingFormulae(config: config, quiet: output.json)
            }
            var tools = config.tools ?? [:]
            for tool in Tool.allCases {
                let url = tool.locate(config)
                let optional = tool == .bita
                checks.append(Check(name: tool.rawValue, ok: url != nil || optional,
                                    detail: url?.path ?? "\(optional ? "optional, " : "")missing: \(tool.installHint)"))
                if let url, tool.configuredPath(config) == nil { tools[tool.rawValue] = url.path }
            }
            if tools != (config.tools ?? [:]) {
                config.tools = tools
                try config.save()
            }
            let app = Paths.appBundle
            checks.append(Check(name: "app", ok: app != nil,
                                detail: app?.path ?? "not running from Recap.app; install it with `bita setup` or `make install`"))
            checks.append(Check(name: "root", ok: true, detail: config.rootURL.path))
            for (name, model, target) in [("whisper", Models.whisper, config.whisperModelURL),
                                          ("vad", Models.vad, config.vadModelURL)] {
                if !FileManager.default.fileExists(atPath: target.path) && !skipModels {
                    if !output.json { FileHandle.standardError.write(Data("Downloading \(model.fileName)...\n".utf8)) }
                    try Self.download(model.url, to: target)
                }
                let present = FileManager.default.fileExists(atPath: target.path)
                checks.append(Check(name: "model:\(name)", ok: present,
                                    detail: present ? target.path : "missing: run `recap setup` without --skip-models"))
            }

            if !skipBita, let bita = Tool.bita.locate(config) {
                checks.append(Self.registerBitaHook(bita: bita, config: config))
            }

            if let app, !skipPermissions {
                let report = try Self.requestPermissions(app: app)
                checks.append(Check(name: "microphone", ok: report.microphone == "granted", detail: report.microphone))
                checks.append(Check(name: "screen", ok: report.screen == "granted",
                                    detail: report.screen == "granted" ? "granted" : "\(report.screen): enable Recap in System Settings > Privacy & Security > Screen & System Audio Recording (only needed for --remote)"))
            }
            let text = checks.map { "\($0.ok ? "ok " : "!! ") \($0.name.padding(toLength: 14, withPad: " ", startingAt: 0)) \($0.detail)" }
                .joined(separator: "\n")
            return (checks, text)
        }
    }

    static let brewCandidates = ["/opt/homebrew/bin/brew", "/usr/local/bin/brew"]

    static func installMissingFormulae(config: Config, quiet: Bool) throws {
        let formulae = [(Tool.ffmpeg, "ffmpeg"), (Tool.whisper, "whisper-cpp")]
            .filter { tool, _ in tool.locate(config) == nil }
            .map(\.1)
        guard !formulae.isEmpty else { return }
        guard let brew = brewCandidates.first(where: FileManager.default.isExecutableFile(atPath:)) else {
            throw RecapError("BREW_MISSING", "Install Homebrew, or install \(formulae.joined(separator: " and ")) by hand")
        }
        if !quiet { FileHandle.standardError.write(Data("Installing \(formulae.joined(separator: ", ")) with Homebrew...\n".utf8)) }
        var environment = ProcessInfo.processInfo.environment
        environment["HOMEBREW_NO_AUTO_UPDATE"] = "1"
        let result = try Shell.run(URL(fileURLWithPath: brew), ["install"] + formulae, environment: environment)
        guard result.ok else {
            throw RecapError("BREW_FAILED", "brew install \(formulae.joined(separator: " ")) failed: \(result.stderr.trimmed.suffix(400))")
        }
    }

    static func registerBitaHook(bita: URL, config: Config) -> Check {
        guard let recap = Paths.executable else {
            return Check(name: "bita-hook", ok: false, detail: "cannot locate the recap executable")
        }
        let environment = Tool.environment(for: bita, config: config)
        guard let listed = try? Shell.run(bita, ["hooks", "--json"], environment: environment), listed.ok,
              let data = listed.stdout.data(using: .utf8),
              let envelope = try? JSONDecoder().decode(BitaHooksEnvelope.self, from: data) else {
            return Check(name: "bita-hook", ok: false, detail: "this bita has no hooks; update it to 0.12 or later")
        }
        if envelope.data.contains(where: { $0.command.last == "bita-hook" }) {
            return Check(name: "bita-hook", ok: true, detail: "already registered")
        }
        let kinds = BitaBridge.kinds.keys.sorted().joined(separator: ",")
        let added = try? Shell.run(bita, ["hooks", "add", "--on", "start,stop,cancel,amend", "--kind", kinds,
                                          "--", recap.path, "bita-hook"], environment: environment)
        guard let added, added.ok else {
            return Check(name: "bita-hook", ok: false, detail: "bita hooks add failed: \(added?.stderr.trimmed ?? "")")
        }
        return Check(name: "bita-hook", ok: true, detail: "registered for \(kinds)")
    }

    static func download(_ source: URL, to target: URL) throws {
        try FileManager.default.createDirectory(at: target.deletingLastPathComponent(), withIntermediateDirectories: true)
        let partial = target.appendingPathExtension("part")
        let result = try Shell.run(URL(fileURLWithPath: "/usr/bin/curl"), ["-fL", "--retry", "3", "-C", "-", "-o", partial.path, source.absoluteString])
        guard result.ok else { throw RecapError("DOWNLOAD_FAILED", "Cannot download \(source.lastPathComponent): \(result.stderr.trimmed)") }
        try? FileManager.default.removeItem(at: target)
        try FileManager.default.moveItem(at: partial, to: target)
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

struct BitaHooksEnvelope: Decodable {
    struct Hook: Decodable {
        let command: [String]
    }
    let data: [Hook]
}
