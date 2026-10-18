import Foundation
import Testing
@testable import recap

@Suite struct RepoGitTests {
    private let prefix = ["--no-pager", "-C", "/r", "-c", "core.fsmonitor=false", "-c", "diff.external=", "-c", "core.pager=cat",
                          "-c", "gpg.program=false", "-c", "gpg.ssh.program=false", "-c", "gpg.x509.program=false",
                          "-c", "log.showSignature=false"]
    private let anyWorkTree: RepoGit.WorkTreeCheck = { _, _, _ in true }

    private func validate(_ arguments: [String]) throws(RepoGitRejection) -> [String] {
        try RepoGit.validate(arguments, directoryExists: { $0 == "/r" })
    }

    private func rejection(_ arguments: [String]) -> String? {
        do {
            _ = try validate(arguments)
            return nil
        } catch {
            return error.reason
        }
    }

    @Test func acceptsTheSharedAllowedVectors() throws {
        let vectors: [[String]] = [
            ["log", "--oneline", "-5"],
            ["log", "-n", "3", "--stat", "--", "src/a.ts"],
            ["show", "HEAD~1", "--stat"],
            ["show", "abc123:README.md"],
            ["diff", "HEAD~2", "HEAD", "--", "README.md"],
            ["log", "--since=2026-01-01", "--author=ana", "--grep=deploy", "-i"],
            ["log", "-L10,20:README.md"],
        ]
        for vector in vectors {
            let sub = vector[0]
            let arguments = try validate(["/r"] + vector)
            #expect(arguments == prefix + [sub, "--no-ext-diff", "--no-textconv", "--no-color"] + vector.dropFirst())
        }
    }

    @Test func rejectsTheSharedRejectedVectors() {
        let vectors: [([String], String)] = [
            (["/r", "diff", "--output=/tmp/x"], "option not allowed: --output=/tmp/x"),
            (["/r", "log", "--output", "/tmp/x"], "option not allowed: --output"),
            (["/r", "diff", "--no-index", "/etc/hosts", "/dev/null"], "option not allowed: --no-index"),
            (["/r", "diff", "--ext-diff"], "option not allowed: --ext-diff"),
            (["/r", "show", "--textconv", "HEAD"], "option not allowed: --textconv"),
            (["/r", "log", "-O/etc/passwd"], "option not allowed: -O/etc/passwd"),
            (["/r", "log", "--exec=x"], "option not allowed: --exec=x"),
            (["/r", "diff", "--", "a\0b"], "argument contains a NUL byte"),
            (["/r", "grep", "x"], "subcommand not allowed: grep"),
            (["repo", "log"], "repository path must be absolute: repo"),
            (["/missing", "log"], "repository not found: /missing"),
        ]
        for (vector, reason) in vectors {
            #expect(rejection(vector) == reason)
        }
    }

    @Test func rejectsOtherDangerousOptions() {
        for option in ["-c", "--git-dir=/x", "--work-tree=/x", "--outp=/tmp/x", "--color=always", "-n", "-nx", "-U",
                       "-Ux", "-S", "-L1,2:a", "--format", "-", "-pO/x", "--exec-path=/x"] {
            let sub = option == "-L1,2:a" ? "diff" : "log"
            #expect(rejection(["/r", sub, option]) != nil, "\(option)")
        }
        #expect(rejection(["/r", "log", "-n", "--output=/x"]) == "-n needs a number")
        #expect(rejection(["/r", "diff", "--", "/etc/hosts"]) == "path outside the repository not allowed: /etc/hosts")
        #expect(rejection(["/r", "show", "../x"]) == "path outside the repository not allowed: ../x")
        #expect(rejection(["/r", "log", "--", "a/../../b"]) != nil)
        #expect(rejection(["/r", "log", "HEAD~3..HEAD", "--", "src/a..b"]) == nil)
        #expect(rejection(["/r", "diff", "/etc/hosts", "/dev/null"]) == "path outside the repository not allowed: /etc/hosts")
        #expect(rejection(["/r", "log", ".."]) == "path outside the repository not allowed: ..")
        #expect(rejection(["/r", "diff", "a...b", "HEAD~1..HEAD"]) == nil)
        #expect(rejection(["/r", "show", "-L1,2:a"]) == "option not allowed: -L1,2:a")
        #expect(rejection(["/r", "diff", "-L1,2:a"]) == "option not allowed: -L1,2:a")
        #expect(rejection(["/r", "log", "-L1,2:a"]) == nil)
        #expect(rejection(["/r", "log", "-n"]) == "-n needs a number")
        for bare in ["-S", "-G", "-L"] {
            #expect(rejection(["/r", "log", bare]) == "option not allowed: \(bare)")
        }
        #expect(rejection(["/r", "diff", "-M"]) == nil)
        #expect(rejection(["/r", "log"]) == nil)
        #expect(rejection([]) != nil)
        #expect(rejection(["/r"]) == "subcommand not allowed: (none)")
        #expect(rejection(["/r", "log", "--format=%H %s", "-n7", "-U3", "-M50%", "-Sfoo", "-Gbar", "--color=never",
                           "--", "--output=/x"]) == nil)
    }

    @Test func neverSpawnsGitForRejectedArguments() throws {
        let repo = FileManager.default.temporaryDirectory.path
        var spawned = 0
        var errors = ""
        let runner: RepoGit.Runner = { _, _, _ in
            spawned += 1
            return 0
        }
        for vector in [["diff", "--output=/tmp/x"], ["log", "--output", "/tmp/x"], ["diff", "--no-index", "/a", "/b"],
                       ["diff", "--ext-diff"], ["show", "--textconv", "HEAD"], ["log", "-O/etc/passwd"],
                       ["log", "--exec=x"], ["diff", "--", "a\0b"], ["grep", "x"]] {
            #expect(RepoGit.run([repo] + vector, runner: runner, stderr: { errors += $0 }) == 2)
        }
        #expect(RepoGit.run(["repo", "log"], runner: runner, stderr: { errors += $0 }) == 2)
        #expect(RepoGit.run(["/nonexistent/repo", "log"], runner: runner, stderr: { errors += $0 }) == 2)
        #expect(spawned == 0)
        #expect(errors.split(separator: "\n").allSatisfy { $0.hasPrefix("recap repo-git: ") })
        #expect(errors.contains("recap repo-git: option not allowed: --output=/tmp/x\n"))

        var received: (URL, [String], [String: String])?
        var checked: [String]?
        let status = RepoGit.run([repo, "log", "-1"], runner: { git, arguments, environment in
            received = (git, arguments, environment)
            return 7
        }, git: { URL(fileURLWithPath: "/usr/bin/git") }, isWorkTree: { _, arguments, _ in
            checked = arguments
            return true
        })
        #expect(status == 7)
        let base = ["--no-pager", "-C", repo, "-c", "core.fsmonitor=false", "-c", "diff.external=", "-c", "core.pager=cat",
                    "-c", "gpg.program=false", "-c", "gpg.ssh.program=false", "-c", "gpg.x509.program=false",
                    "-c", "log.showSignature=false"]
        #expect(received?.1 == base + ["log", "--no-ext-diff", "--no-textconv", "--no-color", "-1"])
        #expect(checked == base + ["rev-parse", "--is-inside-work-tree"])
        #expect(received?.2["GIT_TERMINAL_PROMPT"] == "0")
        #expect(received?.2["GIT_CONFIG_NOSYSTEM"] == "1")
    }

    @Test func keepsOnlyTheAllowlistedEnvironment() {
        var base = ["PATH": "/bin", "HOME": "/h", "USER": "u", "LOGNAME": "u", "TMPDIR": "/t", "LANG": "es_MX.UTF-8",
                    "LC_ALL": "C", "LC_CTYPE": "UTF-8", "LC_MESSAGES": "es", "GIT_AUTHOR_NAME": "Ana",
                    "GIT_CONFIG_KEY_0": "core.pager", "GIT_CONFIG_VALUE_0": "sh", "GIT_TERMINAL_PROMPT": "1",
                    "GIT_CONFIG_PARAMETERS": "'core.pager'='sh'", "GIT_TRACE": "/tmp/t", "GIT_TRACE2_EVENT": "/tmp/e",
                    "GIT_COMMON_DIR": "/x", "GIT_ATTR_SOURCE": "x", "GIT_NAMESPACE": "x", "SHELL": "/bin/zsh",
                    "DYLD_INSERT_LIBRARIES": "/x.dylib", "PAGER": "sh", "SYSTEMROOT": "C:\\Windows", "lc_all": "x"]
        for name in ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_OBJECT_DIRECTORY", "GIT_ALTERNATE_OBJECT_DIRECTORIES",
                     "GIT_CONFIG", "GIT_CONFIG_GLOBAL", "GIT_CONFIG_SYSTEM", "GIT_CONFIG_COUNT", "GIT_EXTERNAL_DIFF", "GIT_PAGER"] {
            base[name] = "/x"
        }
        #expect(RepoGit.environment(base) == ["PATH": "/bin", "HOME": "/h", "USER": "u", "LOGNAME": "u", "TMPDIR": "/t",
                                              "LANG": "es_MX.UTF-8", "LC_ALL": "C", "LC_CTYPE": "UTF-8", "LC_MESSAGES": "es",
                                              "GIT_TERMINAL_PROMPT": "0", "GIT_CONFIG_NOSYSTEM": "1"])
        #expect(RepoGit.environment([:]) == ["GIT_TERMINAL_PROMPT": "0", "GIT_CONFIG_NOSYSTEM": "1"])
    }

    @Test func validatesOnUnicodeScalars() {
        #expect(rejection(["/r", "log", "-\u{301}x"]) == "option not allowed: -\u{301}x")
        #expect(rejection(["/r", "log", "/\u{301}etc"]) == "path outside the repository not allowed: /\u{301}etc")
        #expect(rejection(["/r", "log", "--", "/\u{301}etc"]) == "path outside the repository not allowed: /\u{301}etc")
        #expect(rejection(["/r", "log", "-\u{301}-output=/x"]) == "option not allowed: -\u{301}-output=/x")
        #expect(rejection(["/r", "log", "--\u{301}output=/x"]) == "option not allowed: --\u{301}output=/x")
        #expect(rejection(["/r", "log", "--stat\u{301}"]) == "option not allowed: --stat\u{301}")
        #expect(rejection(["/r", "log", "-n", "3\u{301}"]) == "-n needs a number")
        #expect(rejection(["/r", "log", "-3\u{301}"]) == "option not allowed: -3\u{301}")
        #expect(rejection(["/r", "log", "a/..\u{301}/b"]) == nil)
        #expect(rejection(["/r", "log", "--", "a\u{301}/../../b"]) != nil)
        #expect(rejection(["/r", "log", "--author=Jos\u{e9}", "--grep=caf\u{301}e"]) == nil)
        #expect(rejection(["/r\u{301}", "log"]) == "repository not found: /r\u{301}")
        #expect(RepoGit.allowRules(repo: "/r\u{301}", selfPath: "/s/recap").isEmpty)
        #expect(rejection(["/r", "log", "-S\n"]) == "option not allowed: -S\n")
        #expect(rejection(["/r", "log", "-G\r"]) == "option not allowed: -G\r")
        for terminator in ["\n", "\r", "\u{2028}", "\u{2029}"] {
            for flag in ["-S", "-G", "-M", "-L"] {
                #expect(rejection(["/r", "log", flag + terminator + "x"]) == "option not allowed: \(flag)\(terminator)x")
            }
        }
        #expect(rejection(["/r", "log", "-Sa\nb", "-Gx\u{2028}", "-M\t50%", "-L\u{301}1,2:a"]) == nil)
    }

    @Test func exitCodesForMissingGitTimeoutsAndSignals() throws {
        let repo = FileManager.default.temporaryDirectory.path
        var errors = ""
        #expect(RepoGit.run([repo, "log"], runner: { _, _, _ in 0 }, git: { nil }, isWorkTree: anyWorkTree,
                            stderr: { errors += $0 }) == 127)
        #expect(errors == "recap repo-git: git not found\n")

        errors = ""
        #expect(RepoGit.run([repo, "log"], runner: { _, _, _ in throw RecapError("TIMEOUT", "git did not finish within 30 seconds") },
                            git: { URL(fileURLWithPath: "/usr/bin/git") }, isWorkTree: anyWorkTree, stderr: { errors += $0 }) == 124)
        #expect(errors == "recap repo-git: git did not finish within 30 seconds\n")

        errors = ""
        let gone = URL(fileURLWithPath: "/nonexistent/bin/git-\(UUID().uuidString)")
        #expect(RepoGit.run([repo, "log"], git: { gone }, stderr: { errors += $0 }) == 127)
        #expect(RepoGit.run([repo, "log"], runner: RepoGit.process(), git: { gone }, isWorkTree: anyWorkTree,
                            stderr: { errors += $0 }) == 127)
        #expect(errors == "recap repo-git: git not found\nrecap repo-git: git not found\n")

        errors = ""
        var spawned = 0
        #expect(RepoGit.run([repo, "log"], runner: { _, _, _ in
            spawned += 1
            return 0
        }, git: { URL(fileURLWithPath: "/usr/bin/git") }, isWorkTree: { _, _, _ in
            throw RecapError("TIMEOUT", "git did not finish within 10 seconds")
        }, stderr: { errors += $0 }) == 2)
        #expect(spawned == 0)
        #expect(errors == "recap repo-git: not a git repository: \(repo)\n")

        let root = FileManager.default.temporaryDirectory.appending(path: "repo-git-exit-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: root) }
        let script = root.appending(path: "fake-git")
        try "#!/bin/sh\nkill -TERM $$\n".write(to: script, atomically: true, encoding: .utf8)
        try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: script.path)
        #expect(RepoGit.run([repo, "log"], runner: RepoGit.process(), git: { script }, isWorkTree: anyWorkTree) == 128 + SIGTERM)

        let sleeper = root.appending(path: "slow-git")
        try "#!/bin/sh\nexec sleep 5\n".write(to: sleeper, atomically: true, encoding: .utf8)
        try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: sleeper.path)
        errors = ""
        #expect(RepoGit.run([repo, "log"], runner: RepoGit.process(timeout: 0.2), git: { sleeper }, isWorkTree: anyWorkTree,
                            stderr: { errors += $0 }) == 124)
        #expect(errors == "recap repo-git: git did not finish within 0 seconds\n")
    }

    @Test func allowRulesFailClosedOnUnsafeCharacters() {
        #expect(RepoGit.allowRules(repo: "/r", selfPath: "/usr/local/bin/recap") == [
            "Bash(/usr/local/bin/recap repo-git /r log:*)",
            "Bash(/usr/local/bin/recap repo-git /r show:*)",
            "Bash(/usr/local/bin/recap repo-git /r diff:*)",
        ])
        #expect(RepoGit.allowRules(repo: "/has space", selfPath: "/usr/local/bin/recap").isEmpty)
        #expect(RepoGit.allowRules(repo: "/r", selfPath: "/Users/a b/recap").isEmpty)
        #expect(RepoGit.allowRules(repo: "/r", selfPath: nil).isEmpty)
        for unsafe in ["/r;x", "/r$(x)", "/r`x`", "/r*", "/r:x", "/r'", "/r\"", "/r\n", "/ré"] {
            #expect(RepoGit.allowRules(repo: unsafe, selfPath: "/s/recap").isEmpty, "\(unsafe)")
        }
        #expect(RepoGit.allowRules(repo: "/src/a_b-c+d@e.f", selfPath: "/s/recap").count == 3)
        let context = ProjectContext(project: "CoDi", docsRoot: nil, repos: [RepoRef(path: "/r", slug: "r", exists: true),
                                                                          RepoRef(path: "/has space", slug: "s", exists: true)])
        #expect(AskPrompt.allowedTools(context, selfPath: "/s/recap") == ["Read", "Grep", "Glob",
                                                                         "Bash(/s/recap repo-git /r log:*)",
                                                                         "Bash(/s/recap repo-git /r show:*)",
                                                                         "Bash(/s/recap repo-git /r diff:*)"])
        #expect(AskPrompt.allowedTools(context, selfPath: "/a b/recap") == ["Read", "Grep", "Glob"])
    }

    @Test func promptUsesTheWrapper() {
        let meeting = Meeting(id: "m", title: "Daily", mode: .remote, status: .recording, createdAt: Date())
        let request = AskRequest(meeting: meeting, dir: URL(fileURLWithPath: "/tmp"), question: "x", windowSeconds: 60)
        let context = ProjectContext(project: "CoDi", docsRoot: nil, repos: [RepoRef(path: "/src/codi", slug: "codi", exists: true)])
        let prompt = AskPrompt.render(template: "G:{{git}}\nR:\n{{repos}}", request: request, context: context, segments: [],
                                      selfPath: "/s/recap")
        #expect(prompt == "G:/s/recap repo-git\nR:\n  - codi: /src/codi (historial: `/s/recap repo-git /src/codi log|show|diff …`)")
        let unsafe = ProjectContext(project: "CoDi", docsRoot: nil, repos: [RepoRef(path: "/src/my repo", slug: "mine", exists: true)])
        #expect(AskPrompt.render(template: "{{repos}}", request: request, context: unsafe, segments: [], selfPath: "/s/recap")
                == "  - mine: /src/my repo (sin historial de git; solo Read, Grep y Glob)")
        #expect(AskPrompt.render(template: "{{repos}}", request: request, context: context, segments: [], selfPath: "/a b/recap")
                == "  - codi: /src/codi (sin historial de git; solo Read, Grep y Glob)")
        #expect(AskPrompt.allowedTools(unsafe, selfPath: "/s/recap") == ["Read", "Grep", "Glob"])
    }

    @Test func describesWrapperCallsLikeGit() {
        let describer = ProgressDescriber(docsRoot: nil, repos: [RepoRef(path: "/src/codi", slug: "codi", exists: true)])
        #expect(describer.describe(name: "Bash", input: ["command": "/s/recap repo-git /src/codi log -1"])
                == "Ejecutando git -C codi log -1")
        #expect(describer.describe(name: "Bash", input: ["command": "/usr/bin/node /x/recap.js repo-git /src/codi diff HEAD"])
                == "Ejecutando git -C codi diff HEAD")
    }

    @Test func runsRealGitAndBlocksOutputFiles() throws {
        let root = FileManager.default.temporaryDirectory.appending(path: "repo-git-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: root) }
        let git = try #require(Shell.which("git"))
        let base = ["-C", root.path, "-c", "user.name=T", "-c", "user.email=t@t", "-c", "commit.gpgsign=false"]
        #expect(try Shell.run(git, ["init", "-q", root.path], timeout: 30).ok)
        try "hola\n".write(to: root.appending(path: "README.md"), atomically: true, encoding: .utf8)
        #expect(try Shell.run(git, base + ["add", "README.md"], timeout: 30).ok)
        #expect(try Shell.run(git, base + ["commit", "-q", "-m", "first commit"], timeout: 30).ok)

        let outFile = root.appending(path: "stdout.txt")
        let errFile = root.appending(path: "stderr.txt")
        FileManager.default.createFile(atPath: outFile.path, contents: nil)
        FileManager.default.createFile(atPath: errFile.path, contents: nil)
        let out = try FileHandle(forWritingTo: outFile)
        let err = try FileHandle(forWritingTo: errFile)
        let runner = RepoGit.process(stdout: out, stderr: err)
        #expect(RepoGit.run([root.path, "log", "--oneline", "-1"], runner: runner) == 0)
        #expect(RepoGit.run([root.path, "show", "--stat", "HEAD"], runner: runner) == 0)
        #expect(RepoGit.run([root.path, "diff", "HEAD"], runner: runner) == 0)
        try out.close()
        try err.close()
        #expect(try String(contentsOf: outFile, encoding: .utf8).contains("first commit"))

        let target = root.appending(path: "x")
        var errors = ""
        #expect(RepoGit.run([root.path, "diff", "--output=\(target.path)"], runner: runner, stderr: { errors += $0 }) == 2)
        #expect(!FileManager.default.fileExists(atPath: target.path))
        #expect(errors == "recap repo-git: option not allowed: --output=\(target.path)\n")
    }

    @Test func refusesDirectoriesThatAreNotARepository() throws {
        let root = FileManager.default.temporaryDirectory.appending(path: "repo-git-plain-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: root) }
        var spawned = 0
        var errors = ""
        let status = RepoGit.run([root.path, "log"], runner: { _, _, _ in
            spawned += 1
            return 0
        }, stderr: { errors += $0 })
        #expect(status == 2)
        #expect(spawned == 0)
        #expect(errors == "recap repo-git: not a git repository: \(root.path)\n")
    }

    @Test func parentGitVariablesAndSigningProgramsNeverRun() throws {
        let root = FileManager.default.temporaryDirectory.appending(path: "repo-git-env-\(UUID().uuidString)")
        let home = root.appending(path: "home")
        let repo = root.appending(path: "repo")
        try FileManager.default.createDirectory(at: home, withIntermediateDirectories: true)
        try FileManager.default.createDirectory(at: repo, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: root) }
        let git = try #require(Shell.which("git"))
        let base = ["-C", repo.path, "-c", "user.name=T", "-c", "user.email=t@t", "-c", "commit.gpgsign=false"]
        let quiet = RepoGit.process(stdout: .nullDevice, stderr: .nullDevice)
        let environment = ProcessInfo.processInfo.environment
        #expect(try quiet(git, ["init", "-q", repo.path], environment) == 0)
        try "hola\n".write(to: repo.appending(path: "README.md"), atomically: true, encoding: .utf8)
        #expect(try quiet(git, base + ["add", "README.md"], environment) == 0)
        #expect(try quiet(git, base + ["commit", "-q", "-m", "first commit"], environment) == 0)

        let pagerMarker = root.appending(path: "X")
        let traceMarker = root.appending(path: "t")
        let gpgMarker = root.appending(path: "gpg-ran")
        let gpg = root.appending(path: "fake-gpg")
        try "#!/bin/sh\ntouch '\(gpgMarker.path)'\n".write(to: gpg, atomically: true, encoding: .utf8)
        try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: gpg.path)
        try "[gpg]\n\tprogram = \(gpg.path)\n[log]\n\tshowSignature = true\n"
            .write(to: home.appending(path: ".gitconfig"), atomically: true, encoding: .utf8)
        let parent = ["PATH": ProcessInfo.processInfo.environment["PATH"] ?? "/usr/bin:/bin", "HOME": home.path,
                      "GIT_CONFIG_PARAMETERS": "'core.pager'='touch \(pagerMarker.path)'", "GIT_TRACE": traceMarker.path]

        let outFile = root.appending(path: "stdout.txt")
        FileManager.default.createFile(atPath: outFile.path, contents: nil)
        let out = try FileHandle(forWritingTo: outFile)
        let runner = RepoGit.process(stdout: out, stderr: out)
        #expect(RepoGit.run([repo.path, "log", "-1"], runner: runner, environment: parent) == 0)
        #expect(RepoGit.run([repo.path, "log", "--format=%G?", "-1"], runner: runner, environment: parent) == 0)
        #expect(RepoGit.run([repo.path, "show", "HEAD"], runner: runner, environment: parent) == 0)
        try out.close()
        #expect(!FileManager.default.fileExists(atPath: pagerMarker.path))
        #expect(!FileManager.default.fileExists(atPath: traceMarker.path))
        #expect(!FileManager.default.fileExists(atPath: gpgMarker.path))
        #expect(try String(contentsOf: outFile, encoding: .utf8).contains("N\n"))
    }
}
