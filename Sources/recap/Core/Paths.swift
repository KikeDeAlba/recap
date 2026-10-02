import Foundation

enum Paths {
    static var home: URL { FileManager.default.homeDirectoryForCurrentUser }

    static var configFile: URL {
        env("RECAP_CONFIG_PATH").map(URL.init(fileURLWithPath:))
            ?? home.appending(path: ".config/recap/config.json")
    }

    static var stateDir: URL {
        env("RECAP_STATE_DIR").map(URL.init(fileURLWithPath:))
            ?? xdg("XDG_STATE_HOME", fallback: ".local/state").appending(path: "recap")
    }

    static var dataDir: URL {
        env("RECAP_DATA_DIR").map(URL.init(fileURLWithPath:))
            ?? xdg("XDG_DATA_HOME", fallback: ".local/share").appending(path: "recap")
    }

    static var activeFile: URL { stateDir.appending(path: "active.json") }
    static var modelsDir: URL { dataDir.appending(path: "models") }

    static var executable: URL? {
        Bundle.main.executableURL?.resolvingSymlinksInPath()
    }

    static var appBundle: URL? {
        guard let executable else { return nil }
        let app = executable.deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
        return app.pathExtension == "app" ? app : nil
    }

    static func expandTilde(_ path: String) -> URL {
        if path == "~" { return home }
        if path.hasPrefix("~/") { return home.appending(path: String(path.dropFirst(2))) }
        return URL(fileURLWithPath: path)
    }

    private static func env(_ key: String) -> String? {
        guard let value = ProcessInfo.processInfo.environment[key], !value.isEmpty else { return nil }
        return value
    }

    private static func xdg(_ key: String, fallback: String) -> URL {
        env(key).map(URL.init(fileURLWithPath:)) ?? home.appending(path: fallback)
    }
}
