import Foundation

enum ConfigValue: Encodable, Equatable {
    case bool(Bool)
    case int(Int)
    case string(String)
    case null

    func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        switch self {
        case let .bool(value): try container.encode(value)
        case let .int(value): try container.encode(value)
        case let .string(value): try container.encode(value)
        case .null: try container.encodeNil()
        }
    }

    var text: String {
        switch self {
        case let .bool(value): value ? "true" : "false"
        case let .int(value): String(value)
        case let .string(value): value
        case .null: "null"
        }
    }
}

enum ConfigKey: String, CaseIterable {
    case liveEnabled = "live.enabled"
    case liveOpenWindow = "live.openWindow"
    case liveProposals = "live.proposals"
    case liveAssistModel = "live.assistModel"
    case liveMaxChunkSeconds = "live.maxChunkSeconds"
    case liveAutoAsk = "live.autoAsk"
    case liveAutoAskModel = "live.autoAskModel"
    case liveAutoAskMinSeconds = "live.autoAskMinSeconds"
    case liveAutoAskConcurrency = "live.autoAskConcurrency"

    static func parse(_ raw: String) throws -> ConfigKey {
        guard let key = ConfigKey(rawValue: raw) ?? allCases.first(where: { $0.rawValue.lowercased() == raw.lowercased() }) else {
            throw RecapError("CONFIG_KEY_UNKNOWN", "Unknown key \"\(raw)\"; use one of \(allCases.map(\.rawValue).joined(separator: ", "))")
        }
        return key
    }

    func value(in config: Config) -> ConfigValue {
        let settings = config.liveSettings
        switch self {
        case .liveEnabled: return .bool(settings.enabled)
        case .liveOpenWindow: return .bool(settings.openWindow)
        case .liveProposals: return .bool(settings.proposals)
        case .liveAssistModel: return settings.assistModel.map(ConfigValue.string) ?? .null
        case .liveMaxChunkSeconds: return .int(settings.maxChunkSeconds)
        case .liveAutoAsk: return .bool(settings.autoAsk)
        case .liveAutoAskModel: return .string(settings.autoAskModel)
        case .liveAutoAskMinSeconds: return .int(settings.autoAskMinSeconds)
        case .liveAutoAskConcurrency: return .int(settings.autoAskConcurrency)
        }
    }

    func apply(_ raw: String, to config: inout Config) throws {
        var live = config.live ?? LiveConfig()
        switch self {
        case .liveEnabled: live.enabled = try Self.bool(raw)
        case .liveOpenWindow: live.openWindow = try Self.bool(raw)
        case .liveProposals: live.proposals = try Self.bool(raw)
        case .liveAssistModel:
            let trimmed = raw.trimmed
            live.assistModel = ["", "null", "none", "default"].contains(trimmed.lowercased()) ? nil : trimmed
        case .liveMaxChunkSeconds:
            guard let seconds = Int(raw.trimmed), LiveSettings.chunkSecondsRange.contains(seconds) else {
                throw RecapError("CONFIG_VALUE_INVALID", "\(rawValue) takes whole seconds between \(LiveSettings.chunkSecondsRange.lowerBound) and \(LiveSettings.chunkSecondsRange.upperBound)")
            }
            live.maxChunkSeconds = seconds
        case .liveAutoAsk: live.autoAsk = try Self.bool(raw)
        case .liveAutoAskModel:
            let trimmed = raw.trimmed
            live.autoAskModel = ["", "null", "none", "default"].contains(trimmed.lowercased()) ? nil : trimmed
        case .liveAutoAskMinSeconds:
            guard let seconds = Int(raw.trimmed), LiveSettings.autoAskSecondsRange.contains(seconds) else {
                throw RecapError("CONFIG_VALUE_INVALID", "\(rawValue) takes whole seconds between \(LiveSettings.autoAskSecondsRange.lowerBound) and \(LiveSettings.autoAskSecondsRange.upperBound)")
            }
            live.autoAskMinSeconds = seconds
        case .liveAutoAskConcurrency:
            guard let count = Int(raw.trimmed), LiveSettings.autoAskConcurrencyRange.contains(count) else {
                throw RecapError("CONFIG_VALUE_INVALID", "\(rawValue) takes a whole number between \(LiveSettings.autoAskConcurrencyRange.lowerBound) and \(LiveSettings.autoAskConcurrencyRange.upperBound)")
            }
            live.autoAskConcurrency = count
        }
        config.live = live
    }

    private static func bool(_ raw: String) throws -> Bool {
        switch raw.trimmed.lowercased() {
        case "true", "on", "yes", "1": return true
        case "false", "off", "no", "0": return false
        default: throw RecapError("CONFIG_VALUE_INVALID", "Expected true or false, got \"\(raw)\"")
        }
    }

    static func snapshot(_ config: Config) -> [String: ConfigValue] {
        Dictionary(uniqueKeysWithValues: allCases.map { ($0.rawValue, $0.value(in: config)) })
    }
}
