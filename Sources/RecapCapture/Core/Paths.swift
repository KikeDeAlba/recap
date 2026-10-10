import Foundation

package enum Paths {
    package static var home: URL { FileManager.default.homeDirectoryForCurrentUser }

    package static var configFile: URL {
        env("RECAP_CONFIG_PATH").map(URL.init(fileURLWithPath:))
            ?? home.appending(path: ".config/recap/config.json")
    }

    package static var stateDir: URL {
        env("RECAP_STATE_DIR").map(URL.init(fileURLWithPath:))
            ?? xdg("XDG_STATE_HOME", fallback: ".local/state").appending(path: "recap")
    }

    package static var dataDir: URL {
        env("RECAP_DATA_DIR").map(URL.init(fileURLWithPath:))
            ?? xdg("XDG_DATA_HOME", fallback: ".local/share").appending(path: "recap")
    }

    package static var activeFile: URL { stateDir.appending(path: "active.json") }
    package static var modelsDir: URL { dataDir.appending(path: "models") }

    package static var executable: URL? {
        Bundle.main.executableURL?.resolvingSymlinksInPath()
    }

    package static var appBundle: URL? {
        guard let executable else { return nil }
        let app = executable.deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
        return app.pathExtension == "app" ? app : nil
    }

    package static func expandTilde(_ path: String) -> URL {
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
