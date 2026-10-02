import Darwin
import Foundation

struct ActiveRecording: Codable {
    var meetingId: String
    var dir: String
    var mode: MeetingMode
    var startedAt: Date

    var dirURL: URL { URL(fileURLWithPath: dir) }

    static func load() -> ActiveRecording? {
        guard let data = try? Data(contentsOf: Paths.activeFile) else { return nil }
        return try? MeetingFile.decoder.decode(ActiveRecording.self, from: data)
    }

    func save() throws {
        try FileManager.default.createDirectory(at: Paths.stateDir, withIntermediateDirectories: true)
        try MeetingFile.encoder.encode(self).write(to: Paths.activeFile, options: .atomic)
    }

    static func clear() {
        try? FileManager.default.removeItem(at: Paths.activeFile)
    }

    static func current() -> (ActiveRecording, Meeting)? {
        guard let active = load() else { return nil }
        guard let stored = try? MeetingFile.load(active.dirURL) else {
            clear()
            return nil
        }
        let meeting = MeetingFile.reconcile(stored, dir: active.dirURL)
        guard meeting.status == .recording || meeting.status == .starting else {
            clear()
            return nil
        }
        return (active, meeting)
    }
}

enum ProcessCheck {
    static func isAlive(_ pid: Int32) -> Bool {
        kill(pid, 0) == 0 || errno == EPERM
    }

    static func waitUntil(timeout: TimeInterval, interval: TimeInterval = 0.25, _ condition: () -> Bool) -> Bool {
        let deadline = Date().addingTimeInterval(timeout)
        while Date() < deadline {
            if condition() { return true }
            Thread.sleep(forTimeInterval: interval)
        }
        return condition()
    }
}
