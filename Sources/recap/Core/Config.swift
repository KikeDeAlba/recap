import Foundation

struct Config: Codable {
    var root: String?
    var language: String?
    var whisperModel: String?
    var bitaPath: String?

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
        whisperModel.map(Paths.expandTilde) ?? Paths.modelsDir.appending(path: "ggml-large-v3-turbo.bin")
    }
}
