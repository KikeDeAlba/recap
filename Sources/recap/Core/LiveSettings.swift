import Foundation

struct LiveConfig: Codable, Equatable {
    var enabled: Bool?
    var openWindow: Bool?
    var proposals: Bool?
    var maxChunkSeconds: Int?
    var assistModel: String?
}

struct LiveSettings: Equatable {
    static let chunkSecondsRange = 5...60

    var enabled: Bool
    var openWindow: Bool
    var proposals: Bool
    var maxChunkSeconds: Int
    var assistModel: String?

    init(_ config: LiveConfig?) {
        enabled = config?.enabled ?? true
        openWindow = config?.openWindow ?? true
        proposals = config?.proposals ?? true
        let seconds = config?.maxChunkSeconds ?? 20
        maxChunkSeconds = min(max(seconds, Self.chunkSecondsRange.lowerBound), Self.chunkSecondsRange.upperBound)
        assistModel = config?.assistModel.flatMap { $0.trimmed.isEmpty ? nil : $0.trimmed }
    }
}

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
