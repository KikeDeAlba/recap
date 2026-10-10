import AppKit
import Foundation

package final class RecordingController {
    private let dir: URL
    private var recorder: Recorder?
    private var signalSources: [DispatchSourceSignal] = []
    private var stopRequested = false
    private var finishing = false
    private var started = false
    private let liveWorker: String?

    package init(dir: URL, liveWorker: String? = nil) {
        self.dir = dir
        self.liveWorker = liveWorker
    }

    package func run() -> Never {
        let app = NSApplication.shared
        app.setActivationPolicy(.accessory)
        installSignalHandlers()
        Task { @MainActor in await self.begin() }
        app.run()
        exit(0)
    }

    @MainActor
    private func begin() async {
        do {
            let meeting = try MeetingFile.update(dir) { $0.recorderPid = getpid() }
            let url = dir.appending(path: meeting.mode.recordingFileName)
            let live = (try? Config.load())?.liveSettings ?? LiveSettings(nil)
            let liveTap = live.enabled ? makeLiveTap(maxChunkSeconds: live.maxChunkSeconds) : nil
            let recorder: Recorder = switch meeting.mode {
            case .remote: RemoteRecorder(url: url, displayID: meeting.display, liveTap: liveTap)
            case .inPerson: InPersonRecorder(url: url, liveTap: liveTap)
            }
            recorder.onFailure = { [weak self] error in
                DispatchQueue.main.async { self?.finish(error: error) }
            }
            self.recorder = recorder
            try await recorder.start()
            started = true
            _ = try MeetingFile.update(dir) {
                $0.status = .recording
                $0.startedAt = Date()
            }
            log("recording \(meeting.mode.rawValue) to \(url.path)")
            if liveTap != nil { startLiveWorker() }
            if stopRequested { finish(error: nil) }
        } catch {
            fail(error)
        }
    }

    private func makeLiveTap(maxChunkSeconds: Int) -> LiveTap? {
        do {
            return try LiveTap(meetingDir: dir, maxChunkSeconds: maxChunkSeconds)
        } catch {
            log("live transcription disabled: \(error)")
            return nil
        }
    }

    private func startLiveWorker() {
        do {
            guard let launch = try LiveWorkerLaunch.resolve(option: liveWorker,
                                                            environment: ProcessInfo.processInfo.environment,
                                                            executable: Paths.executable) else {
                log("live worker disabled")
                return
            }
            let pid = try Shell.spawnDetached(launch.executable, launch.arguments(for: dir), log: LiveFiles.workerLog(dir))
            log("live worker \(pid)")
        } catch {
            log("live worker not started: \((error as? RecapError)?.message ?? String(describing: error))")
        }
    }

    private func installSignalHandlers() {
        for signalNumber in [SIGINT, SIGTERM] {
            signal(signalNumber, SIG_IGN)
            let source = DispatchSource.makeSignalSource(signal: signalNumber, queue: .main)
            source.setEventHandler { [weak self] in self?.finish(error: nil) }
            source.resume()
            signalSources.append(source)
        }
    }

    private func finish(error: Error?) {
        guard started else {
            stopRequested = true
            return
        }
        guard !finishing else { return }
        finishing = true
        let recorder = self.recorder
        Task { @MainActor in
            await recorder?.stop()
            _ = try? MeetingFile.update(self.dir) {
                $0.status = .recorded
                $0.endedAt = Date()
                $0.recorderPid = nil
                if let error { $0.error = String(describing: error) }
            }
            self.log(error.map { "stopped after error: \($0)" } ?? "stopped")
            exit(error == nil ? 0 : 1)
        }
    }

    private func fail(_ error: Error) {
        let message = (error as? RecapError)?.message ?? error.localizedDescription
        _ = try? MeetingFile.update(dir) {
            $0.status = .failed
            $0.recorderPid = nil
            $0.error = message
        }
        log("failed: \(message)")
        exit(1)
    }

    private func log(_ message: String) {
        let line = "\(ISO8601DateFormatter().string(from: Date())) \(message)\n"
        FileHandle.standardError.write(Data(line.utf8))
    }
}

package enum RecorderLauncher {
    package static func launch(dir: URL) throws {
        let log = dir.appending(path: "recorder.log")
        if let app = Paths.appBundle {
            let open = URL(fileURLWithPath: "/usr/bin/open")
            let result = try Shell.run(open, openArguments(app: app, dir: dir, log: log,
                                                           environment: ProcessInfo.processInfo.environment))
            guard result.ok else {
                throw RecapError("LAUNCH_FAILED", "Cannot launch \(app.lastPathComponent): \(result.stderr.trimmingCharacters(in: .whitespacesAndNewlines))")
            }
        } else {
            guard let executable = Paths.executable else {
                throw RecapError("LAUNCH_FAILED", "Cannot locate the recap executable")
            }
            _ = try Shell.spawnDetached(executable, ["record", dir.path], log: log)
        }
    }

    package static func openArguments(app: URL, dir: URL, log: URL, environment: [String: String]) -> [String] {
        let forwarded = environment[LiveWorkerLaunch.environmentKey].map { ["--env", "\(LiveWorkerLaunch.environmentKey)=\($0)"] } ?? []
        return ["-g", "-n", "-a", app.path] + forwarded
            + ["--stdout", log.path, "--stderr", log.path, "--args", "record", dir.path]
    }
}
