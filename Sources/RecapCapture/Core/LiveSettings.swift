import Foundation

package struct LiveConfig: Codable, Equatable {
    package var enabled: Bool?
    package var openWindow: Bool?
    package var proposals: Bool?
    package var maxChunkSeconds: Int?
    package var assistModel: String?
    package var autoAsk: Bool?
    package var autoAskModel: String?
    package var autoAskMinSeconds: Int?
    package var autoAskConcurrency: Int?

    package init(enabled: Bool? = nil, openWindow: Bool? = nil, proposals: Bool? = nil, maxChunkSeconds: Int? = nil,
                 assistModel: String? = nil, autoAsk: Bool? = nil, autoAskModel: String? = nil,
                 autoAskMinSeconds: Int? = nil, autoAskConcurrency: Int? = nil) {
        self.enabled = enabled
        self.openWindow = openWindow
        self.proposals = proposals
        self.maxChunkSeconds = maxChunkSeconds
        self.assistModel = assistModel
        self.autoAsk = autoAsk
        self.autoAskModel = autoAskModel
        self.autoAskMinSeconds = autoAskMinSeconds
        self.autoAskConcurrency = autoAskConcurrency
    }
}

package struct LiveSettings: Equatable {
    package static let chunkSecondsRange = 5...60
    package static let autoAskSecondsRange = 3...120
    package static let autoAskConcurrencyRange = 1...6
    package static let defaultMaxChunkSeconds = 10
    package static let defaultAutoAskMinSeconds = 5
    package static let defaultAutoAskConcurrency = 3
    package static let defaultAutoAskModel = "haiku"

    package var enabled: Bool
    package var openWindow: Bool
    package var proposals: Bool
    package var maxChunkSeconds: Int
    package var assistModel: String?
    package var autoAsk: Bool
    package var autoAskModel: String
    package var autoAskMinSeconds: Int
    package var autoAskConcurrency: Int

    package init(_ config: LiveConfig?) {
        enabled = config?.enabled ?? true
        openWindow = config?.openWindow ?? true
        proposals = config?.proposals ?? true
        let seconds = config?.maxChunkSeconds ?? Self.defaultMaxChunkSeconds
        maxChunkSeconds = min(max(seconds, Self.chunkSecondsRange.lowerBound), Self.chunkSecondsRange.upperBound)
        assistModel = config?.assistModel.flatMap { $0.trimmed.isEmpty ? nil : $0.trimmed }
        autoAsk = config?.autoAsk ?? true
        autoAskModel = config?.autoAskModel.flatMap { $0.trimmed.isEmpty ? nil : $0.trimmed } ?? Self.defaultAutoAskModel
        let autoSeconds = config?.autoAskMinSeconds ?? Self.defaultAutoAskMinSeconds
        autoAskMinSeconds = min(max(autoSeconds, Self.autoAskSecondsRange.lowerBound), Self.autoAskSecondsRange.upperBound)
        let concurrency = config?.autoAskConcurrency ?? Self.defaultAutoAskConcurrency
        autoAskConcurrency = min(max(concurrency, Self.autoAskConcurrencyRange.lowerBound), Self.autoAskConcurrencyRange.upperBound)
    }
}
