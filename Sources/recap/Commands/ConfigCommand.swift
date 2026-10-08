import ArgumentParser
import Foundation

struct ConfigData: Encodable {
    let path: String
    let key: String?
    let value: ConfigValue?
    let settings: [String: ConfigValue]
}

struct ConfigCommand: ParsableCommand {
    static let configuration = CommandConfiguration(
        commandName: "config",
        abstract: "Read or change recap settings.",
        subcommands: [ConfigGetCommand.self, ConfigSetCommand.self]
    )
}

struct ConfigGetCommand: ParsableCommand {
    static let configuration = CommandConfiguration(
        commandName: "get",
        abstract: "Print one setting, or every live setting with its effective value."
    )

    @Argument(help: "Setting key (\(ConfigKey.allCases.map(\.rawValue).joined(separator: ", "))).")
    var key: String?

    @OptionGroup var output: OutputOptions

    func run() throws {
        try Output.run("config get", json: output.json) {
            let config = try Config.load()
            let settings = ConfigKey.snapshot(config)
            if let key {
                let parsed = try ConfigKey.parse(key)
                let value = parsed.value(in: config)
                return (ConfigData(path: Paths.configFile.path, key: parsed.rawValue, value: value, settings: settings), value.text)
            }
            let text = ConfigKey.allCases.map { "\($0.rawValue) = \(settings[$0.rawValue]?.text ?? "null")" }.joined(separator: "\n")
            return (ConfigData(path: Paths.configFile.path, key: nil, value: nil, settings: settings), text)
        }
    }
}

struct ConfigSetCommand: ParsableCommand {
    static let configuration = CommandConfiguration(
        commandName: "set",
        abstract: "Change one setting in the configuration file."
    )

    @Argument(help: "Setting key (\(ConfigKey.allCases.map(\.rawValue).joined(separator: ", "))).")
    var key: String

    @Argument(help: "New value; \"null\" clears live.assistModel.")
    var value: String

    @OptionGroup var output: OutputOptions

    func run() throws {
        try Output.run("config set", json: output.json) {
            var config = try Config.load()
            let parsed = try ConfigKey.parse(key)
            try parsed.apply(value, to: &config)
            try config.save()
            let current = parsed.value(in: config)
            return (ConfigData(path: Paths.configFile.path, key: parsed.rawValue, value: current, settings: ConfigKey.snapshot(config)),
                    "\(parsed.rawValue) = \(current.text)")
        }
    }
}
