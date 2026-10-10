import Foundation

package struct Config: Codable {
    package var root: String?
    package var language: String?
    package var whisperModel: String?
    package var summaryModel: String?
    package var vocabulary: [String]?
    package var tools: [String: String]?
    package var live: LiveConfig?

    package init(root: String? = nil, language: String? = nil, whisperModel: String? = nil, summaryModel: String? = nil,
                 vocabulary: [String]? = nil, tools: [String: String]? = nil, live: LiveConfig? = nil) {
        self.root = root
        self.language = language
        self.whisperModel = whisperModel
        self.summaryModel = summaryModel
        self.vocabulary = vocabulary
        self.tools = tools
        self.live = live
    }

    package static func load() throws -> Config {
        let url = Paths.configFile
        guard FileManager.default.fileExists(atPath: url.path) else { return Config() }
        do {
            return try JSONDecoder().decode(Config.self, from: Data(contentsOf: url))
        } catch {
            throw RecapError("CONFIG_INVALID", "Cannot read \(url.path): \(error.localizedDescription)")
        }
    }

    package var rootURL: URL {
        if let override = ProcessInfo.processInfo.environment["RECAP_ROOT"], !override.isEmpty {
            return Paths.expandTilde(override)
        }
        return Paths.expandTilde(root ?? "~/Recap")
    }

    package var transcriptionLanguage: String { language ?? "es" }

    package var whisperModelURL: URL {
        whisperModel.map(Paths.expandTilde) ?? Paths.modelsDir.appending(path: Models.whisper.fileName)
    }

    package var liveSettings: LiveSettings { LiveSettings(live) }

    package var vadModelURL: URL {
        Paths.modelsDir.appending(path: Models.vad.fileName)
    }

    package func save() throws {
        let url = Paths.configFile
        try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes]
        try encoder.encode(self).write(to: url, options: .atomic)
    }
}

package struct Models {
    package let fileName: String
    package let url: URL

    package static let whisper = Models(
        fileName: "ggml-large-v3-turbo.bin",
        url: URL(string: "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3-turbo.bin")!
    )

    package static let vad = Models(
        fileName: "ggml-silero-v5.1.2.bin",
        url: URL(string: "https://huggingface.co/ggml-org/whisper-vad/resolve/main/ggml-silero-v5.1.2.bin")!
    )
}
