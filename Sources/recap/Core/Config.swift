import Foundation

struct Config: Codable {
    var root: String?
    var language: String?
    var whisperModel: String?
    var summaryModel: String?
    var vocabulary: [String]?
    var tools: [String: String]?
    var live: LiveConfig?

    static func load() throws -> Config {
        let url = Paths.configFile
        guard FileManager.default.fileExists(atPath: url.path) else { return Config() }
        do {
            return try JSONDecoder().decode(Config.self, from: Data(contentsOf: url))
        } catch {
            throw RecapError("CONFIG_INVALID", "Cannot read \(url.path): \(error.localizedDescription)")
        }
    }

    var rootURL: URL {
        if let override = ProcessInfo.processInfo.environment["RECAP_ROOT"], !override.isEmpty {
            return Paths.expandTilde(override)
        }
        return Paths.expandTilde(root ?? "~/Recap")
    }

    var transcriptionLanguage: String { language ?? "es" }

    var whisperModelURL: URL {
        whisperModel.map(Paths.expandTilde) ?? Paths.modelsDir.appending(path: Models.whisper.fileName)
    }

    var liveSettings: LiveSettings { LiveSettings(live) }

    var vadModelURL: URL {
        Paths.modelsDir.appending(path: Models.vad.fileName)
    }

    func save() throws {
        let url = Paths.configFile
        try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes]
        try encoder.encode(self).write(to: url, options: .atomic)
    }
}

struct Models {
    let fileName: String
    let url: URL

    static let whisper = Models(
        fileName: "ggml-large-v3-turbo.bin",
        url: URL(string: "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3-turbo.bin")!
    )

    static let vad = Models(
        fileName: "ggml-silero-v5.1.2.bin",
        url: URL(string: "https://huggingface.co/ggml-org/whisper-vad/resolve/main/ggml-silero-v5.1.2.bin")!
    )
}
