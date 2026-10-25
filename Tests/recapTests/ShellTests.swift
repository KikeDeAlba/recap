import Foundation
import RecapCapture
import Testing

@Suite struct ShellTests {
    private let sh = URL(fileURLWithPath: "/bin/sh")

    @Test func returnsOutputAndStatus() throws {
        let result = try Shell.run(sh, ["-c", "echo out; echo err >&2; exit 3"])
        #expect(result.stdout == "out\n" && result.stderr == "err\n" && result.status == 3)
        let echoed = try Shell.run(URL(fileURLWithPath: "/bin/cat"), [], stdin: Data("hola\n".utf8), timeout: 5)
        #expect(echoed.ok && echoed.stdout == "hola\n")
    }

    @Test func passesLargeStdinThrough() throws {
        let input = Data(repeating: 0x61, count: 1_000_000)
        let result = try Shell.run(URL(fileURLWithPath: "/usr/bin/wc"), ["-c"], stdin: input, timeout: 10)
        #expect(result.stdout.trimmed == "1000000")
    }

    @Test func timesOutASleepingChild() {
        let started = Date()
        #expect(throws: RecapError.self) { try Shell.run(URL(fileURLWithPath: "/bin/sleep"), ["30"], timeout: 0.3) }
        #expect(Date().timeIntervalSince(started) < 10)
    }

    @Test func killsAChildThatIgnoresTerm() {
        let started = Date()
        let timeout: TimeInterval = 1.5
        #expect(throws: RecapError.self) {
            try Shell.run(sh, ["-c", "trap '' TERM; sleep 30; echo done"], timeout: timeout)
        }
        let elapsed = Date().timeIntervalSince(started)
        #expect(elapsed >= timeout + Shell.killGrace && elapsed < timeout + Shell.killGrace + 3)
    }

    @Test func doesNotBlockOnAChildThatNeverReadsStdin() {
        let started = Date()
        #expect(throws: RecapError.self) {
            try Shell.run(URL(fileURLWithPath: "/bin/sleep"), ["30"], stdin: Data(repeating: 0x62, count: 512 * 1024), timeout: 0.3)
        }
        #expect(Date().timeIntervalSince(started) < 10)
    }

    @Test func survivesAChildThatExitsWithoutReadingStdin() throws {
        let result = try Shell.run(URL(fileURLWithPath: "/usr/bin/true"), [], stdin: Data(repeating: 0x63, count: 512 * 1024),
                                   timeout: 5)
        #expect(result.ok)
    }

    @Test func doesNotHangOnPipesHeldByAGrandchild() throws {
        let started = Date()
        let timeout: TimeInterval = 2
        let result = try Shell.run(sh, ["-c", "sleep 30 & echo started"], timeout: timeout)
        #expect(result.stdout == "started\n" && result.ok)
        #expect(Date().timeIntervalSince(started) < timeout + Shell.killGrace + 2)
    }
}
