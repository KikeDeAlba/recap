import Foundation
import Testing
@testable import recap

final class FakeBita: BitaCalling {
    var calls: [[String]] = []
    let handler: ([String]) -> BitaResponse

    init(_ handler: @escaping ([String]) -> BitaResponse) {
        self.handler = handler
    }

    func invoke(_ arguments: [String]) throws -> BitaResponse {
        calls.append(arguments)
        return handler(arguments)
    }
}

private func streamLine(_ text: String) -> String {
    let payload: [String: Any] = ["type": "stream_event", "session_id": "s",
                                  "event": ["type": "content_block_delta", "index": 0,
                                            "delta": ["type": "text_delta", "text": text]]]
    return String(decoding: try! JSONSerialization.data(withJSONObject: payload), as: UTF8.self)
}

@Suite struct ClaudeStreamTests {
    @Test func parsesTextDeltasToolUsesAndTheResult() {
        let lines = [
            #"{"type":"system","subtype":"init","session_id":"s","tools":["Read","Grep"]}"#,
            #"{"type":"stream_event","event":{"type":"message_start","message":{"id":"m"}}}"#,
            #"{"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Con "}}}"#,
            #"{"type":"stream_event","event":{"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"{\"file"}}}"#,
            #"{"type":"assistant","message":{"id":"m","role":"assistant","content":[{"type":"text","text":"Con"},{"type":"tool_use","id":"t1","name":"Read","input":{"file_path":"/docs/codi/despliegue.md","limit":40}}]}}"#,
            #"{"type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"t1","content":"..."}]}}"#,
            #"{"type":"result","subtype":"success","is_error":false,"duration_ms":4100,"result":"Con make release.","session_id":"s"}"#,
            "not json",
        ]
        let events = lines.flatMap(ClaudeStreamParser.parse)
        #expect(events == [
            .text("Con "),
            .tool(name: "Read", input: ["file_path": "/docs/codi/despliegue.md", "limit": "40"]),
            .result(text: "Con make release.", isError: false),
        ])
        #expect(ClaudeStreamParser.parse(#"{"type":"result","subtype":"error_max_turns","is_error":true}"#)
                == [.result(text: nil, isError: true)])
    }

    @Test func describesProgressRelativeToTheKnownRoots() {
        let describer = ProgressDescriber(docsRoot: "/data/docs",
                                          repos: [RepoRef(path: "/src/bita-desktop", slug: "bita-desktop", exists: true)])
        #expect(describer.describe(name: "Read", input: ["file_path": "/data/docs/codi/x.md"]) == "Leyendo docs/codi/x.md")
        #expect(describer.describe(name: "Grep", input: ["pattern": "deploy", "path": "/src/bita-desktop"])
                == "Buscando «deploy» en bita-desktop")
        #expect(describer.describe(name: "Bash", input: ["command": "git log -5"]) == "Ejecutando git log -5")
        #expect(describer.describe(name: "Bash", input: ["command": "git -C /src/bita-desktop log -1"])
                == "Ejecutando git -C bita-desktop log -1")
    }

    @Test func assemblerStripsTheQuestionHeaderAndHoldsBackTheSourcesBlock() {
        var assembler = AnswerAssembler()
        var out = ""
        for delta in ["PREG", "UNTA: ¿Cómo se despliega?\n", "Con `make", " release` (README.md:12).\n\n``", "`bash\nmake release\n```\n", "\n```fu", "entes\n{\"found\": true}\n```"] {
            out += assembler.feed(delta)
        }
        out += assembler.finish()
        #expect(assembler.question == "¿Cómo se despliega?")
        #expect(out == "Con `make release` (README.md:12).\n\n```bash\nmake release\n```\n\n")
        #expect(assembler.sourcesText.contains("\"found\": true"))
        #expect(!out.contains("fuentes"))
    }

    @Test func assemblerPassesAnswersWithoutHeader() {
        var assembler = AnswerAssembler()
        var out = assembler.feed("Prueba con ")
        out += assembler.feed("`make test`.")
        out += assembler.finish()
        #expect(assembler.question == nil)
        #expect(out == "Prueba con `make test`.")
    }

    @Test func parsesTheSourcesBlockAndDropsInvalidEntries() throws {
        let block = try #require(SourcesBlock.parse("""

        {"question": "¿Cómo se despliega?", "found": true, "sources": [
          {"kind": "page", "label": "Despliegue", "pageId": 12, "path": "codi/despliegue.md"},
          {"kind": "file", "label": "", "repo": "/src/app", "path": "/src/app/README.md", "line": "42"},
          {"kind": "commit", "label": "abc1234 fix deploy", "repo": "/src/app", "sha": "abc1234"},
          {"kind": "web", "label": "x"},
          {"kind": "file", "label": "sin ruta"}
        ]}
        ```
        """))
        #expect(block.question == "¿Cómo se despliega?")
        #expect(block.found == true)
        #expect(block.sources.map(\.kind) == ["page", "file", "commit"])
        #expect(block.sources[1].label == "/src/app/README.md:42")
        #expect(block.sources[1].line == 42)
        #expect(SourcesBlock.parse("sin json") == nil)
    }

    @Test func reducerTurnsAStreamIntoEventsAndAnAnswer() throws {
        let sources = #"{"question":"¿Cómo se despliega bita-desktop?","found":true,"sources":[{"kind":"file","label":"README.md:30","repo":"/src/bita-desktop","path":"/src/bita-desktop/README.md","line":30}]}"#
        let full = "PREGUNTA: ¿Cómo se despliega bita-desktop?\nCon `pnpm release` (README.md:30).\n```fuentes\n\(sources)\n```"
        let lines = [
            #"{"type":"assistant","message":{"content":[{"type":"tool_use","id":"t","name":"Grep","input":{"pattern":"release","path":"/src/bita-desktop"}}]}}"#,
            streamLine("PREGUNTA: ¿Cómo se despliega bita-desktop?\n"),
            streamLine("Con `pnpm release` (README.md:30).\n"),
            streamLine("```fuentes\n\(sources)\n```"),
            String(decoding: try JSONSerialization.data(withJSONObject: ["type": "result", "subtype": "success", "is_error": false, "result": full]), as: UTF8.self),
        ]
        let describer = ProgressDescriber(docsRoot: nil, repos: [RepoRef(path: "/src/bita-desktop", slug: "bita-desktop", exists: true)])
        var reducer = AskStreamReducer(explicitQuestion: nil)
        var events = lines.flatMap { reducer.consume($0, describer: describer) }
        let (tail, answer) = try reducer.finish(status: 0, stderr: "", id: "a1", askedAt: Date(timeIntervalSince1970: 0))
        events += tail
        #expect(events.first == .progress("Buscando «release» en bita-desktop"))
        #expect(events.contains(.question("¿Cómo se despliega bita-desktop?")))
        let streamed = events.compactMap { event -> String? in if case let .delta(text) = event { return text } else { return nil } }.joined()
        #expect(streamed.trimmed == "Con `pnpm release` (README.md:30).")
        #expect(answer.answer == "Con `pnpm release` (README.md:30).")
        #expect(answer.found)
        #expect(answer.sources.count == 1)
        #expect(events.last == .source(answer.sources[0]))
        let encoded = try JSONLines.line(AskEvent.done(answer))
        #expect(encoded.hasPrefix(#"{"answer":{"answer":"#) && encoded.contains(#""type":"done""#))
    }

    @Test func reducerMarksUndocumentedAnswersAndFailsOnErrors() throws {
        var reducer = AskStreamReducer(explicitQuestion: "¿Dónde está el runbook?")
        _ = reducer.consume(streamLine("No está documentado. Revisé las páginas del proyecto."), describer: ProgressDescriber(docsRoot: nil, repos: []))
        let (_, answer) = try reducer.finish(status: 0, stderr: "", id: "a2", askedAt: Date())
        #expect(!answer.found)
        #expect(answer.question == "¿Dónde está el runbook?")

        var failing = AskStreamReducer(explicitQuestion: "x")
        _ = failing.consume(#"{"type":"result","subtype":"error_during_execution","is_error":true,"result":"boom"}"#,
                            describer: ProgressDescriber(docsRoot: nil, repos: []))
        #expect(throws: RecapError.self) { try failing.finish(status: 1, stderr: "", id: "a3", askedAt: Date()) }
    }
}

@Suite struct AskPromptTests {
    private func meeting() -> Meeting {
        var meeting = Meeting(id: "m", title: "Daily", mode: .remote, status: .recording, createdAt: Date())
        meeting.bitaEntry = BitaEntrySnapshot(title: "Daily de CoDi", projectName: "CoDi", kind: "remote-meeting", pageIds: [])
        return meeting
    }

    @Test func rendersContextQuestionAndTranscriptWindow() throws {
        let segments = [
            Segment(startMs: 0, endMs: 3_000, channel: .system, text: "Hablemos del sprint anterior."),
            Segment(startMs: 400_000, endMs: 404_000, channel: .system, text: "¿Cómo se despliega el webhook?"),
        ]
        let context = ProjectContext(project: "CoDi", docsRoot: "/data/docs",
                                     pages: [PageRef(pageId: 3, title: "Despliegue", relPath: "codi/despliegue.md", depth: 1)],
                                     repos: [RepoRef(path: "/src/codi", slug: "codi", exists: true),
                                             RepoRef(path: "/src/gone", slug: "gone", exists: false)])
        let template = try ResourceText.load("ask-prompt.md")
        let prompt = AskPrompt.render(template: template, request: AskRequest(meeting: meeting(), dir: URL(fileURLWithPath: "/tmp"),
                                                                              question: nil, windowSeconds: 180),
                                      context: context, segments: segments, selfPath: "/usr/local/bin/recap")
        #expect(!prompt.contains("{{"))
        #expect(prompt.contains("«Daily de CoDi»"))
        #expect(prompt.contains("- #3 Despliegue — codi/despliegue.md"))
        #expect(prompt.contains("`/usr/local/bin/recap repo-git /src/codi log|show|diff …`") && !prompt.contains("/src/gone"))
        #expect(!prompt.contains("cd /src"))
        #expect(prompt.contains("[00:06:40] Remotos: ¿Cómo se despliega el webhook?"))
        #expect(!prompt.contains("sprint anterior"))
        #expect(prompt.contains("identifícala en la transcripción"))
        #expect(AskPrompt.addDirs(context) == ["/data/docs", "/src/codi"])

        let explicit = AskPrompt.render(template: "{{questionBlock}}", request: AskRequest(meeting: meeting(), dir: URL(fileURLWithPath: "/tmp"),
                                                                                          question: "¿Qué puerto usa?", windowSeconds: 60),
                                        context: context, segments: segments)
        #expect(explicit.contains("> ¿Qué puerto usa?"))
    }

    @Test func streamArgumentsKeepTheIsolationFlags() {
        let context = ProjectContext(project: "CoDi", docsRoot: "/d", repos: [RepoRef(path: "/r", slug: "r", exists: true),
                                                                          RepoRef(path: "/gone", slug: "gone", exists: false)])
        let arguments = ClaudeRunner.streamArguments(tools: [AskPrompt.allowedTools(context, selfPath: "/usr/local/bin/recap").joined(separator: " ")],
                                                     addDirs: ["/d", "/r", "/d"], model: "haiku",
                                                     restrictTools: AskPrompt.availableTools)
        #expect(Array(arguments.prefix(5)) == ["-p", "--output-format", "stream-json", "--verbose", "--include-partial-messages"])
        #expect(arguments.contains("--strict-mcp-config") && arguments.contains("--no-session-persistence"))
        #expect(arguments[arguments.firstIndex(of: "--allowedTools")! + 1]
                == "Read Grep Glob Bash(/usr/local/bin/recap repo-git /r log:*) Bash(/usr/local/bin/recap repo-git /r show:*) Bash(/usr/local/bin/recap repo-git /r diff:*)")
        #expect(AskPrompt.allowedTools(ProjectContext(project: nil, docsRoot: nil)) == ["Read", "Grep", "Glob"])
        #expect(!arguments.joined(separator: " ").contains("gone"))
        #expect(arguments.filter { $0 == "--add-dir" }.count == 2)
        #expect(arguments.suffix(2) == ["--model", "haiku"])
    }

    @Test func sourcesListOnlyTheProjectRepositoriesAndTheDocsRoot() throws {
        let existing = FileManager.default.temporaryDirectory.appending(path: "recap-repo-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: existing, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: existing) }
        let bita = FakeBita { arguments in
            switch Array(arguments.prefix(3)) {
            case ["docs", "page", "ls"]:
                return BitaResponse(ok: true, data: ["pages": [["pageId": 1, "title": "CoDi", "relPath": "codi/index.md", "depth": 0,
                                                                "children": [["pageId": 2, "title": "Reglas", "relPath": "codi/reglas.md", "depth": 1]]]]],
                                    meta: ["root": "/data/docs"])
            case ["project", "repo", "ls"]:
                return BitaResponse(ok: true, data: ["repos": [
                    ["project": "CoDi", "path": existing.path, "slug": "codi-api", "source": "stop", "exists": true],
                    ["project": "CoDi", "path": "/nope/missing", "slug": NSNull(), "source": "manual", "exists": false],
                ]])
            default:
                return BitaResponse(ok: false, errorCode: "USAGE", errorMessage: "unknown")
            }
        }
        let context = ProjectContextLoader.load(project: "CoDi", docsRoot: nil, bita: bita)
        #expect(context.docsRoot == "/data/docs")
        #expect(context.pages.map(\.pageId) == [1, 2])
        #expect(context.repos == [RepoRef(path: existing.path, slug: "codi-api", exists: true),
                                  RepoRef(path: "/nope/missing", slug: "missing", exists: false)])
        let data = String(decoding: try JSONEncoder().encode(AskSourcesData(context: context)), as: UTF8.self)
        #expect(data.contains(#""project":"CoDi""#) && data.contains(#""exists":false"#))
        #expect(bita.calls.contains(["project", "repo", "ls", "--project", "CoDi"]))
    }
}


final class FakeGaze: GazeCalling, @unchecked Sendable {
    private let lock = NSLock()
    private var recorded: [([String], String?)] = []
    let command: String
    let handler: ([String]) throws -> BitaResponse

    init(command: String = "/opt/gaze/bin/gaze", _ handler: @escaping ([String]) throws -> BitaResponse) {
        self.command = command
        self.handler = handler
    }

    var calls: [([String], String?)] { lock.withLock { recorded } }

    func invoke(_ arguments: [String], stdin: Data?) throws -> BitaResponse {
        lock.withLock { recorded.append((arguments, stdin.map { String(decoding: $0, as: UTF8.self) })) }
        return try handler(arguments)
    }
}

private let fakeChecks = SourceChecks(
    resolve: { path in
        if path.contains("missing") { return nil }
        if path == "/docs/link.md" { return "/outside/x.md" }
        return path
    },
    isFile: { path in !path.hasSuffix("/dir") },
    lineCount: { path in path.hasSuffix("/dir") ? nil : 10 },
    commitExists: { repo, sha in repo == "/r" && sha.lowercased().hasPrefix("abc") }
)

@Suite struct GazeBrainTests {
    private func meeting() -> Meeting {
        var meeting = Meeting(id: "m", title: "Daily", mode: .remote, status: .recording,
                              createdAt: ISO8601DateFormatter().date(from: "2026-10-17T15:00:00Z")!)
        meeting.bitaEntry = BitaEntrySnapshot(title: "Daily de CoDi", projectName: "CoDi", kind: "remote-meeting", pageIds: [])
        return meeting
    }

    private func answer(found: Bool = true, question: String = "¿Cómo se despliega?", text: String = "Con `make release`.",
                        sources: [AnswerSource]) -> Answer {
        Answer(id: "a", askedAt: Date(timeIntervalSince1970: 0), question: question, answer: text, found: found, sources: sources)
    }

    private func context() -> ProjectContext {
        ProjectContext(project: "CoDi", docsRoot: "/docs",
                       pages: [PageRef(pageId: 12, title: "Despliegue", relPath: "codi/despliegue.md", depth: 0)],
                       repos: [RepoRef(path: "/r", slug: "r", exists: true), RepoRef(path: "/gone", slug: "gone", exists: false)],
                       gaze: "/opt/gaze/bin/gaze")
    }

    private let page = AnswerSource(kind: "page", label: "Despliegue", pageId: 12, path: "codi/despliegue.md")

    private func searchResult(_ ids: [String]) -> BitaResponse {
        BitaResponse(ok: true, data: ids.map { id in
            ["id": id, "title": "Nota \(id)", "kind": "fact", "project": "codi", "snippet": " Fragmento\n de \(id) ", "score": 0.5] as [String: Any]
        })
    }

    @Test func lookupSearchesThenShowsTheFirstThreeValidNotes() {
        let long = String(repeating: "x", count: 1300)
        let gaze = FakeGaze { arguments in
            switch arguments.first {
            case "search": return self.searchResult(["n1", "bad id", "n2", "n3", "n4"])
            case "show" where arguments.last == "n1": return BitaResponse(ok: true, data: ["id": "n1", "body": "Línea uno\n  Línea dos\n"])
            case "show" where arguments.last == "n3": return BitaResponse(ok: true, data: ["id": "n3", "body": long])
            default: return BitaResponse(ok: false, errorCode: "NOT_FOUND", errorMessage: "No existe")
            }
        }
        let notes = GazeBrain.lookup(gaze, project: "CoDi", query: " ¿Cómo se despliega? ")
        #expect(gaze.calls.first?.0 == ["search", "--project=CoDi", "--limit", "5", "--json", "--", "¿Cómo se despliega?"])
        #expect(Set(gaze.calls.dropFirst().map(\.0)) == [["show", "--json", "--", "n1"], ["show", "--json", "--", "n2"],
                                                         ["show", "--json", "--", "n3"]])
        #expect(notes.map(\.id) == ["n1", "n2", "n3"])
        var context = context()
        context.brain = notes
        #expect(GazeBrain.render(context) == """
          - [n1] Nota n1 (fact)
            Línea uno
              Línea dos
          - [n2] Nota n2 (fact)
            Fragmento de n2
          - [n3] Nota n3 (fact)
            \(String(repeating: "x", count: 1200))…
        """)
        let request = AskRequest(meeting: meeting(), dir: URL(fileURLWithPath: "/tmp"), question: nil, windowSeconds: 60)
        #expect(AskPrompt.render(template: "{{brain}}", request: request, context: context, segments: []) == GazeBrain.render(context))
    }

    @Test func renderReportsAnUnavailableOrEmptyBrain() {
        var context = context()
        #expect(GazeBrain.render(context) == "  (sin notas en el cerebro)")
        context.project = nil
        #expect(GazeBrain.render(context) == "  (el cerebro no está disponible)")
        context.project = "CoDi"
        context.gaze = nil
        #expect(GazeBrain.render(context) == "  (el cerebro no está disponible)")
        #expect(GazeBrain.renderNote(BrainNote(id: "n", title: "T", kind: "fact", snippet: "")) == "  - [n] T (fact)")
    }

    @Test func lookupFailuresAndTimeoutsGiveNoNotes() {
        let failing = FakeGaze { _ in BitaResponse(ok: false, errorMessage: "boom") }
        #expect(GazeBrain.lookup(failing, project: "CoDi", query: "x").isEmpty)
        let timingOut = FakeGaze { _ in throw RecapError("TIMEOUT", "gaze did not finish within 60 seconds") }
        #expect(GazeBrain.lookup(timingOut, project: "CoDi", query: "x").isEmpty)
        let showTimeout = FakeGaze { arguments in
            if arguments.first == "search" { return self.searchResult(["n1"]) }
            throw RecapError("TIMEOUT", "gaze did not finish within 60 seconds")
        }
        #expect(GazeBrain.lookup(showTimeout, project: "CoDi", query: "x").map(\.body) == ["Fragmento de n1"])
        let unused = FakeGaze { _ in self.searchResult(["n1"]) }
        #expect(GazeBrain.lookup(unused, project: "CoDi", query: "  ").isEmpty)
        #expect(GazeBrain.lookup(unused, project: "CoDi", query: nil).isEmpty)
        #expect(unused.calls.isEmpty)
    }

    @Test func gazeClientTerminatesCallsThatTakeTooLong() {
        let client = GazeClient(bin: ["/bin/sleep"], timeout: 0.3)
        let started = Date()
        #expect(throws: RecapError.self) { try client.invoke(["5"], stdin: nil) }
        #expect(Date().timeIntervalSince(started) < 3)
        let defaults = GazeClient(bin: ["/bin/echo"])
        #expect(defaults.timeout(for: ["remember"]) == 60)
        #expect(defaults.timeout(for: ["search"]) == 10)
        #expect(defaults.timeout(for: ["show"]) == 10)
        let environment = GazeClient.environment(["PATH": "/bin"])
        #expect(environment == ["PATH": "/bin", "KIT_NO_EVENTS": "1", "BITA_NO_HOOKS": "1"])
    }

    @Test func queryUsesTheQuestionOrTheTailOfTheLastThirtySeconds() {
        let segments = [
            Segment(startMs: 0, endMs: 3_000, channel: .system, text: "Hablemos del sprint."),
            Segment(startMs: 40_000, endMs: 45_000, channel: .mic, text: "  ¿Cómo  "),
            Segment(startMs: 50_000, endMs: 60_000, channel: .system, text: "se despliega?"),
        ]
        #expect(GazeBrain.query(question: nil, segments: segments) == "¿Cómo se despliega?")
        #expect(GazeBrain.query(question: " ¿Qué puerto? ", segments: segments) == "¿Qué puerto?")
        #expect(GazeBrain.query(question: "  ", segments: []) == nil)
        let long = [Segment(startMs: 0, endMs: 1_000, channel: .mic, text: "inicio " + String(repeating: "a", count: 400))]
        #expect(GazeBrain.query(question: nil, segments: long) == String(repeating: "a", count: 300))
    }

    @Test func sessionLooksUpTheBrainOnlyWithGazeAndProject() {
        let gaze = FakeGaze { _ in self.searchResult(["n1"]) }
        let session = AskSession(config: Config(), gaze: gaze, checks: fakeChecks, log: { _ in }, emit: { _ in })
        let segments = [Segment(startMs: 0, endMs: 5_000, channel: .system, text: "¿Cómo se despliega?")]
        let enriched = session.brainContext(context(), question: nil, segments: segments)
        #expect(gaze.calls.first?.0 == GazeBrain.searchArguments(project: "CoDi", query: "¿Cómo se despliega?"))
        #expect(enriched.brain.map(\.id) == ["n1"])
        var noGaze = context()
        noGaze.gaze = nil
        var noProject = context()
        noProject.project = nil
        let before = gaze.calls.count
        #expect(session.brainContext(noGaze, question: "x", segments: []).brain.isEmpty)
        #expect(session.brainContext(noProject, question: "x", segments: []).brain.isEmpty)
        #expect(AskSession(config: Config(), emit: { _ in }).brainContext(context(), question: "x", segments: []).brain.isEmpty)
        #expect(gaze.calls.count == before)
    }

    @Test func claudeGetsNoGazeRules() {
        var context = context()
        #expect(AskPrompt.allowedTools(context, selfPath: "/s/recap") == ["Read", "Grep", "Glob", "Bash(/s/recap repo-git /r log:*)", "Bash(/s/recap repo-git /r show:*)",
                                                    "Bash(/s/recap repo-git /r diff:*)"])
        context.repos = []
        #expect(AskPrompt.allowedTools(context) == ["Read", "Grep", "Glob"])
        let describer = ProgressDescriber(docsRoot: nil, repos: [])
        #expect(describer.describe(name: "Bash", input: ["command": "gaze search deploy"]) == "Ejecutando gaze search deploy")
        let loaded = ProjectContextLoader.load(project: "CoDi", docsRoot: nil, bita: nil, gaze: FakeGaze { _ in self.searchResult([]) })
        #expect(loaded.gaze == "/opt/gaze/bin/gaze" && loaded.brain.isEmpty)
        #expect(ProjectContextLoader.load(project: nil, docsRoot: nil, bita: nil, gaze: FakeGaze { _ in self.searchResult([]) }).gaze == nil)
    }

    @Test func pageSourcesMustBeKnownPages() {
        let check = { (source: AnswerSource) in GazeBrain.verifies(source, context: self.context(), checks: fakeChecks) }
        #expect(check(AnswerSource(kind: "page", label: "P", pageId: 12)))
        #expect(!check(AnswerSource(kind: "page", label: "P", pageId: 99)))
        #expect(check(AnswerSource(kind: "page", label: "P", pageId: 99, path: "codi/despliegue.md")))
        #expect(!check(AnswerSource(kind: "page", label: "P", path: "codi/otra.md")))
    }

    @Test func fileSourcesMustBeRegularFilesInsideTheDocsOrARepo() {
        let check = { (path: String, line: Int?) in
            GazeBrain.verifies(AnswerSource(kind: "file", label: "f", path: path, line: line), context: self.context(), checks: fakeChecks)
        }
        #expect(check("/docs/codi/x.md", nil))
        #expect(check("codi/x.md", 3))
        #expect(check("/r/README.md", 10))
        #expect(check("/r/README.md", 1))
        #expect(!check("/r/README.md", 11))
        #expect(!check("/r/README.md", 0))
        #expect(!check("/elsewhere/a.md", nil))
        #expect(!check("/docsfoo/a.md", nil))
        #expect(!check("/docs/link.md", nil))
        #expect(!check("/docs/missing.md", nil))
        #expect(!check("/docs/dir", nil))
        #expect(!check("/gone/a.md", nil))
        var noDocs = context()
        noDocs.docsRoot = nil
        #expect(!GazeBrain.verifies(AnswerSource(kind: "file", label: "f", path: "codi/x.md"), context: noDocs, checks: fakeChecks))
    }

    @Test func commitSourcesMustExistInAProjectRepo() {
        let check = { (repo: String?, sha: String) in
            GazeBrain.verifies(AnswerSource(kind: "commit", label: "c", repo: repo, sha: sha), context: self.context(), checks: fakeChecks)
        }
        #expect(check("/r", "abc1234"))
        #expect(check("/r", "ABC1234"))
        #expect(!check("/r", "abc"))
        #expect(!check("/r", "xyz1234"))
        #expect(!check("/r", "abc1234; rm -rf /"))
        #expect(!check("/r", "abd1234"))
        #expect(!check("/gone", "abc1234"))
        #expect(!check("/other", "abc1234"))
        #expect(!check(nil, "abc1234"))
    }

    @Test func liveChecksResolveFilesAndCommits() throws {
        let root = FileManager.default.temporaryDirectory.appending(path: "recap-checks-\(UUID().uuidString)")
        let docs = root.appending(path: "docs")
        try FileManager.default.createDirectory(at: docs.appending(path: "sub"), withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: root) }
        try Data("uno\ndos\n".utf8).write(to: docs.appending(path: "a.md"))
        try Data("uno".utf8).write(to: docs.appending(path: "b.md"))
        try Data().write(to: docs.appending(path: "c.md"))
        try Data("x".utf8).write(to: root.appending(path: "outside.md"))
        try FileManager.default.createSymbolicLink(at: docs.appending(path: "link.md"), withDestinationURL: root.appending(path: "outside.md"))
        let live = SourceChecks.live
        #expect(live.lineCount(docs.appending(path: "a.md").path) == 2)
        #expect(live.lineCount(docs.appending(path: "b.md").path) == 1)
        #expect(live.lineCount(docs.appending(path: "c.md").path) == 0)
        #expect(live.lineCount(docs.appending(path: "sub").path) == nil)
        #expect(live.resolve(docs.appending(path: "none.md").path) == nil)
        let context = ProjectContext(project: "CoDi", docsRoot: docs.path)
        let file = { (path: String, line: Int?) in
            GazeBrain.verifies(AnswerSource(kind: "file", label: "f", path: path, line: line), context: context, checks: live)
        }
        #expect(file("a.md", 2))
        #expect(!file("a.md", 3))
        #expect(!file("c.md", 1))
        #expect(!file("link.md", nil))
        #expect(!file("sub", nil))
        #expect(!file("../outside.md", nil))

        let git = try #require(Shell.which("git"))
        let repo = root.appending(path: "repo").path
        try Shell.run(git, ["init", "-q", repo])
        try Data("x".utf8).write(to: URL(fileURLWithPath: repo).appending(path: "f"))
        try Shell.run(git, ["-C", repo, "add", "f"])
        try Shell.run(git, ["-C", repo, "-c", "user.name=t", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false",
                            "commit", "-qm", "init"])
        let sha = try Shell.run(git, ["-C", repo, "rev-parse", "HEAD"]).stdout.trimmed
        #expect(live.commitExists(repo, sha))
        #expect(live.commitExists(repo, String(sha.prefix(7))))
        #expect(!live.commitExists(repo, "deadbeef"))
    }

    @Test func shouldRememberNeedsEveryVerifiedSourceAndNoNotes() {
        let note = AnswerSource(kind: "note", label: "Despliegue", noteId: "n1")
        let bad = AnswerSource(kind: "file", label: "x", path: "/elsewhere/x.md")
        #expect(GazeBrain.shouldRemember(answer(sources: [page]), context: context(), checks: fakeChecks))
        #expect(!GazeBrain.shouldRemember(answer(sources: []), context: context(), checks: fakeChecks))
        #expect(!GazeBrain.shouldRemember(answer(sources: [page, note]), context: context(), checks: fakeChecks))
        #expect(!GazeBrain.shouldRemember(answer(sources: [page, bad]), context: context(), checks: fakeChecks))
        #expect(!GazeBrain.shouldRemember(answer(found: false, sources: [page]), context: context(), checks: fakeChecks))
    }

    @Test func scannerFlagsSecretsAndPersonalData() {
        let samples: [(String, String)] = [
            ("La tarjeta es 4111 1111 1111 1111", "card"),
            ("tarjeta 4111-1111-1111-1111", "card"),
            ("AKIA" + String(repeating: "B", count: 16), "aws-key"),
            ("ASIA" + String(repeating: "7", count: 16), "aws-key"),
            ("ghp_" + String(repeating: "a", count: 36), "github-token"),
            ("gho_" + String(repeating: "Z", count: 40), "github-token"),
            ("glpat-" + String(repeating: "x", count: 20), "gitlab-token"),
            ("sk-" + String(repeating: "k", count: 20), "api-key"),
            ("xoxb-" + String(repeating: "1", count: 10), "slack-token"),
            ("-----BEGIN RSA PRIVATE KEY-----", "private-key"),
            ("-----BEGIN PRIVATE KEY-----", "private-key"),
            ("Password: hunter2", "credential"),
            ("api_key=abc", "credential"),
            ("APIKEY = abc", "credential"),
            ("el token: xyz", "credential"),
            ("escribe a ana.lopez@example.com", "email"),
        ]
        for (text, reason) in samples {
            #expect(SecretScanner.reason(text) == reason, "\(text)")
        }
        #expect(SecretScanner.reason("4111 1111 1111 1113") == nil)
        #expect(SecretScanner.reason("El pedido 123456789012 llegó") == nil)
        #expect(SecretScanner.reason("Con `make release` en el puerto 8080.") == nil)
        #expect(SecretScanner.reason("ghp_corto") == nil)
        #expect(SecretScanner.luhn("4111111111111111"))
        #expect(!SecretScanner.luhn("411111111111"))
    }

    @Test func sharedVectorCardHits() {
        let hits = ["4111 1111 1111 1111 123", "4111111111111111 12 25", "4111.1111.1111.1111", "4111/1111/1111/1111",
                    "4111\n1111\n1111\n1111", "4111 1111 1111 1111", "４１１１１１１１１１１１１１１１"]
        for text in hits {
            #expect(SecretScanner.reason(text) == "card", "\(text)")
        }
        #expect(SecretScanner.reason("2026-10-17") == nil)
        #expect(SecretScanner.reason("4111     1111 1111 1111") == "card")
        #expect(SecretScanner.reason("4111      1111 1111 1111") == nil)
        #expect(SecretScanner.reason(String(repeating: "4111 1111 1111 111", count: 6)) == "card")
    }

    @Test func roundFourCardHits() {
        let hits = ["4111,1111,1111,1111", "4111_1111_1111_1111", "4111:1111:1111:1111", "4111 • 1111 • 1111 • 1111",
                    "4111    1111 1111 1111", "4111\u{200B}1111\u{200B}1111\u{200B}1111", "٤١١١١١١١١١١١١١١١",
                    "४१११११११११११११११", String(repeating: "3 ", count: 63) + "4111 1111 1111 1111",
                    "4111\u{00A0}1111\u{2028}1111\u{0085}1111", "4111\u{00AD}1111\u{FEFF}1111\u{200D}1111"]
        for text in hits {
            #expect(SecretScanner.reason(text) == "card", "\(text)")
        }
        #expect(SecretScanner.reason(String(repeating: "1", count: 100) + " 4111111111111111") == "card")
        #expect(SecretScanner.reason(String(repeating: "1 ", count: 40) + "4111 1111 1111 1111") == "card")
    }

    @Test func roundFourCardNonHits() {
        let misses = ["1234 5678 9012 3456", "2026-10-17", "94111111111111111", "version 4111 abc 1111 def 1111 ghi 1111",
                      "4111 x 1111 1111 1111"]
        for text in misses {
            #expect(SecretScanner.reason(text) == nil, "\(text)")
        }
    }

    @Test func roundFourAcceptedLimitationGluedPrefixHidesThePan() {
        #expect(SecretScanner.reason("94111111111111111") == nil)
        #expect(SecretScanner.reason("9 4111111111111111") == "card")
    }

    @Test func roundFourNormalization() {
        #expect(SecretScanner.normalize("a\u{200B}b\u{00AD}x\u{0301}") == "abx")
        #expect(SecretScanner.normalize("c\u{0301}") == "\u{0107}")
        #expect(SecretScanner.normalize("٤٥\u{0966}\u{096F}") == "4509")
        #expect(SecretScanner.normalize("a\u{00A0}b\u{2028}c\u{0085}d\ne\tf") == "a b c d e f")
        #expect(SecretScanner.normalize("ｃｏｎｔｒａｓｅñａ") == "contraseña")
    }

    @Test func roundFourCredentialAndAuthHits() {
        let samples: [(String, String)] = [
            ("pass\u{200B}word: x", "credential"),
            ("my password was x", "credential"),
            ("la contraseña es x", "credential"),
            ("la contrasena era x", "credential"),
            ("clave: x", "credential"),
            ("Authorization: Basic dXNlcjpwYXNzd29yZDEyMw==", "basic-auth"),
            ("password isé x", "credential"),
            ("https://admin:hunter2@\u{200D}host/db", "uri-credentials"),
            ("a@\u{0301}b.co", "email"),
            ("token\nis\nabc", "credential"),
        ]
        for (text, reason) in samples {
            #expect(SecretScanner.reason(text) == reason, "\(text)")
        }
        #expect(SecretScanner.reason("the password field") == nil)
        #expect(SecretScanner.reason("password island") == nil)
        #expect(SecretScanner.reason("Basic auth is fine") == nil)
    }

    @Test func roundFourScanStaysFast() {
        let inputs = [String(repeating: "a", count: 100_000), String(repeating: "1 ", count: 50_000),
                      String(repeating: "password ", count: 11_112), String(repeating: "4", count: 100_000),
                      String(repeating: "a", count: 100_000) + "@acme.com", String(repeating: "a@", count: 50_000),
                      String(repeating: "x://", count: 25_000) + "u:p@h"]
        for text in inputs {
            let started = Date()
            _ = SecretScanner.reason(text)
            let elapsed = Date().timeIntervalSince(started)
            #expect(elapsed < 0.2, "\(text.prefix(10)) \(elapsed)")
        }
    }

    @Test func sharedVectorCardWindowsStartAtGroupBoundaries() {
        #expect(SecretScanner.luhn("34567890123456"))
        #expect(SecretScanner.reason("1234 5678 9012 3456") == nil)
        #expect(SecretScanner.reason("13 4111 1111 1111 1111") == "card")
        #expect(SecretScanner.reason("134111111111111111") == nil)
        let filler = String(repeating: "1", count: 60)
        #expect(SecretScanner.reason(filler + "1234") == nil)
        #expect(SecretScanner.reason(filler + "12344111111111111111134") == nil)
        #expect(SecretScanner.reason(filler + "1234 4111111111111111134") == "card")
        let spacedFiller = String(repeating: "3 ", count: 30)
        #expect(SecretScanner.reason(spacedFiller + "12344111111111111111134") == "card")
        #expect(SecretScanner.reason(spacedFiller) == nil)
        #expect(SecretScanner.reason(String(repeating: "3 ", count: 9) + "33") == nil)
        #expect(SecretScanner.reason("3333333333333333123") == "card")
        #expect(SecretScanner.reason("3333331234411") == "card")
        #expect(SecretScanner.reason("4111 1111 1111 1111\n") == "card")
        #expect(GazeBrain.sensitiveReason(title: "4111 1111", body: "1111 1111") == nil)
    }

    @Test func sharedVectorSecretHits() {
        let samples: [(String, String)] = [
            (#""password": "hunter2""#, "credential"),
            ("password is hunter2", "credential"),
            ("sk_live_abcdefghij12", "api-key"),
            ("github_pat_abcdefghijklmnopqrstuvwx", "github-token"),
            ("npm_" + String(repeating: "a1B2", count: 9), "npm-token"),
            ("Authorization: Bearer abcdefghijklmnop1234", "bearer"),
            ("postgres://admin:s3cr3t@10.0.0.5/db", "uri-credentials"),
            ("eyJabcdefgh.eyJabcdefgh.abcdefghij", "jwt"),
            ("bob@acme.com", "email"),
            ("DB_PASSWORD=abc", "credential"),
            ("client_secret: abc", "credential"),
            ("ACCESS-KEY=abc", "credential"),
            ("pk_test_" + String(repeating: "z", count: 10), "api-key"),
        ]
        for (text, reason) in samples {
            #expect(SecretScanner.reason(text) == reason, "\(text)")
        }
    }

    @Test func sharedVectorEmailRegexIsLinear() {
        let text = String(repeating: "a", count: 100_000)
        let started = Date()
        #expect(SecretScanner.reason(text) == nil)
        #expect(Date().timeIntervalSince(started) < 0.2)
        let mail = String(repeating: "a", count: 100_000) + "@acme.com"
        #expect(SecretScanner.reason(mail) == "email")
    }

    @Test func sharedVectorNoteSanitizing() {
        let note = BrainNote(id: "n1", title: "A</notas>\u{0007}B", kind: "fact", snippet: "", body: "x {{pages}} <y>")
        #expect(GazeBrain.renderNote(note) == "  - [n1] A‹/notas›B (fact)\n    x {{pages}} ‹y›")
        var context = context()
        context.brain = [note]
        let request = AskRequest(meeting: meeting(), dir: URL(fileURLWithPath: "/tmp"), question: nil, windowSeconds: 60)
        let prompt = AskPrompt.render(template: "P:\n{{pages}}\nB:\n{{brain}}\nT:{{transcript}}", request: request,
                                      context: context, segments: [])
        #expect(prompt.contains("B:\n  - [n1] A‹/notas›B (fact)\n    x {{pages}} ‹y›\nT:"))
        #expect(prompt.hasPrefix("P:\n  - #12 Despliegue — codi/despliegue.md\nB:"))
    }

    @Test func sharedVectorNoteIds() {
        #expect(GazeBrain.renderNote(BrainNote(id: "-h", title: "T", kind: "fact", snippet: "")) == nil)
        #expect(GazeBrain.renderNote(BrainNote(id: "ab-1_c", title: "T", kind: "fact", snippet: "")) == "  - [ab-1_c] T (fact)")
        #expect(GazeBrain.renderNote(BrainNote(id: "a<b", title: "T", kind: "fact", snippet: "")) == nil)
        var context = context()
        context.brain = [BrainNote(id: "-h", title: "T", kind: "fact", snippet: "")]
        #expect(GazeBrain.render(context) == GazeBrain.empty)
        #expect(!GazeBrain.notesUsed(context))
        let gaze = FakeGaze { arguments in
            arguments.first == "search" ? self.searchResult(["-h", "ab-1_c"]) : BitaResponse(ok: false, errorMessage: "x")
        }
        #expect(GazeBrain.lookup(gaze, project: "CoDi", query: "q").map(\.id) == ["ab-1_c"])
    }

    @Test func sharedVectorNoteFieldsAreCleaned() {
        let note = BrainNote(id: "n1", title: " a \u{0001}\n\t b ", kind: String(repeating: "k", count: 40), snippet: "",
                             body: "  uno\u{0000}\r\n\tdos  ")
        #expect(GazeBrain.renderNote(note) == "  - [n1] a  b (\(String(repeating: "k", count: 32))…)\n    uno\n    \tdos")
        #expect(GazeBrain.singleLine("a\nb\tc\r\nd\u{0007}e") == "a b c de")
        #expect(GazeBrain.singleLine("a \u{0007} b") == "a  b")
        #expect(GazeBrain.singleLine("a\u{0085}b\u{3000}c") == "ab c")
        let decision = BrainNote(id: "n3", title: "T", kind: "de\ncisión", snippet: "")
        #expect(GazeBrain.renderNote(decision) == "  - [n3] T (de cisión)")
        let long = BrainNote(id: "n2", title: String(repeating: "t", count: 201), kind: "fact", snippet: "",
                             body: String(repeating: "é", count: 1201))
        #expect(GazeBrain.renderNote(long) == "  - [n2] \(String(repeating: "t", count: 200))… (fact)\n    \(String(repeating: "é", count: 1200))…")
    }

    @Test func sharedVectorCutCountsScalars() {
        #expect(GazeBrain.cut(String(repeating: "\u{00E9}", count: 201), to: 200) == String(repeating: "\u{00E9}", count: 200) + "…")
        #expect(GazeBrain.noteTitle(String(repeating: "\u{00E9}", count: 201)) == String(repeating: "\u{00E9}", count: 200) + "…")
        let emoji = String(repeating: "a", count: 199) + "\u{1F44D}\u{1F3FD}"
        #expect(GazeBrain.cut(emoji, to: 200) == String(repeating: "a", count: 199) + "\u{1F44D}…")
        #expect(GazeBrain.cut(String(repeating: "a", count: 200), to: 200) == String(repeating: "a", count: 200))
        let segments = [Segment(startMs: 0, endMs: 1_000, channel: .mic, text: "b" + String(repeating: "\u{1F44D}\u{1F3FD}", count: 200))]
        #expect(GazeBrain.query(question: nil, segments: segments) == String(repeating: "\u{1F44D}\u{1F3FD}", count: 150))
    }

    @Test func sharedVectorSaveIsSkippedForNotesLengthAndBodySecrets() {
        let gaze = FakeGaze { _ in BitaResponse(ok: true, data: [:]) }
        var logged: [String] = []
        var withNotes = context()
        withNotes.brain = [BrainNote(id: "n1", title: "T", kind: "fact", snippet: "s")]
        GazeBrain.remember(gaze, answer: answer(sources: [page]), project: "CoDi", meeting: meeting(), context: withNotes,
                           checks: fakeChecks) { logged.append($0) }
        #expect(!GazeBrain.shouldRemember(answer(sources: [page]), context: withNotes, checks: fakeChecks))
        let long = answer(text: String(repeating: "\u{00E9}", count: 8001), sources: [page])
        GazeBrain.remember(gaze, answer: long, project: "CoDi", meeting: meeting(), context: context(), checks: fakeChecks) {
            logged.append($0)
        }
        #expect(!GazeBrain.shouldRemember(long, context: context(), checks: fakeChecks))
        var leaky = meeting()
        leaky.bitaEntry?.title = "Call con bob@acme.com"
        GazeBrain.remember(gaze, answer: answer(sources: [page]), project: "CoDi", meeting: leaky, context: context(),
                           checks: fakeChecks) { logged.append($0) }
        #expect(gaze.calls.isEmpty)
        #expect(logged == ["gaze: not saved (brain notes were used)", "gaze: not saved (answer too long)",
                           "gaze: not saved (sensitive content: email)"])
        let exact = answer(text: String(repeating: "\u{00E9}", count: 8000), sources: [page])
        GazeBrain.remember(gaze, answer: exact, project: "CoDi", meeting: meeting(), context: context(), checks: fakeChecks) {
            logged.append($0)
        }
        #expect(gaze.calls.count == 1)
    }

    @Test func roundFiveRenderMatchesTypeScriptPerScalar() {
        let render = { (id: String, title: String, kind: String, body: String?) in
            GazeBrain.renderNote(BrainNote(id: id, title: title, kind: kind, snippet: "", body: body))
        }
        #expect(render("n1", "a<\u{20E3}b", "fact", nil) == "  - [n1] a\u{2039}\u{20E3}b (fact)")
        #expect(render("n1", "a>\u{20E3}b", "fact", nil) == "  - [n1] a\u{203A}\u{20E3}b (fact)")
        #expect(render("n1", "T", "<\u{20E3}", nil) == "  - [n1] T (\u{2039}\u{20E3})")
        #expect(render("n1", "T", ">\u{20E3}", nil) == "  - [n1] T (\u{203A}\u{20E3})")
        #expect(render("n1", "T", "fact", "x <\u{20E3} y >\u{20E3}") == "  - [n1] T (fact)\n    x \u{2039}\u{20E3} y \u{203A}\u{20E3}")
        #expect(render("n1", "8875\u{85}4111111111111112", "fact", nil) == "  - [n1] 88754111111111111112 (fact)")
        #expect(GazeBrain.noteTitle("8875\u{85}4111111111111112") == "8875\u{85}4111111111111112")
        #expect(render("n1", "\u{20E3}\u{FEFF}", "fact", nil) == "  - [n1] \u{20E3} (fact)")
        #expect(GazeBrain.noteTitle("\u{20E3}\u{FEFF}") == "\u{20E3}")
        #expect(render("n1", "T", "fact", "\u{200B} x \u{200B}") == "  - [n1] T (fact)\n    \u{200B} x \u{200B}")
        #expect(render("n1", "T", "fact", "uno\n\u{FEFF}dos\n\u{85}tres\u{85}") == "  - [n1] T (fact)\n    uno\n    \u{FEFF}dos\n    tres")
        #expect(render("n1", "T", "fact", "\u{FEFF}\u{85} cuatro \u{A0}") == "  - [n1] T (fact)\n    cuatro")
        #expect(render("\u{FEFF}n9\u{85}", "T", "fact", nil) == "  - [n9] T (fact)")
        for text in ["<\u{20E3}", ">\u{20E3}"] {
            let escaped = GazeBrain.renderNote(BrainNote(id: "n1", title: text, kind: text, snippet: "", body: text)) ?? ""
            #expect(!escaped.unicodeScalars.contains("<") && !escaped.unicodeScalars.contains(">"))
        }
    }

    @Test func roundFourParityFixes() {
        var context = context()
        context.pages.append(PageRef(pageId: 30, title: "Sin ruta", relPath: "", depth: 0))
        let check = { (source: AnswerSource) in GazeBrain.verifies(source, context: context, checks: fakeChecks) }
        #expect(!check(AnswerSource(kind: "page", label: "P", path: "")))
        #expect(check(AnswerSource(kind: "page", label: "P", pageId: 30, path: "")))
        #expect(check(AnswerSource(kind: "page", label: "P", path: "codi/despliegue.md")))
        #expect(!check(AnswerSource(kind: "page", label: "P\0", pageId: 12)))
        #expect(!check(AnswerSource(kind: "commit", label: "c", repo: "/r", sha: "abc1234\0")))
        #expect(check(AnswerSource(kind: "commit", label: "c", repo: "/r", sha: "abc1234")))
        #expect(!check(AnswerSource(kind: "file", label: "f\0", path: "/docs/a.md")))
        #expect(SourceChecks.commitTimeout == 10)

        let items: [Any] = ["texto", 7, NSNull(), ["id": "n1", "title": "Uno"] as [String: Any], ["id": true] as [String: Any],
                            ["id": NSNumber(value: false)] as [String: Any], ["id": 1.5] as [String: Any],
                            ["id": 42] as [String: Any], ["id": NSNumber(value: 2.0)] as [String: Any]]
        let gaze = FakeGaze { arguments in
            arguments.first == "search" ? BitaResponse(ok: true, data: items) : BitaResponse(ok: false, errorMessage: "x")
        }
        #expect(GazeBrain.lookup(gaze, project: "CoDi", query: "q").map(\.id) == ["n1", "42", "2"])
        #expect(GazeBrain.noteId(true) == nil)
        #expect(GazeBrain.noteId(NSNumber(value: true)) == nil)
        #expect(GazeBrain.noteId(1.5) == nil)
        #expect(GazeBrain.noteId(7) == "7")
        #expect(GazeBrain.noteId("x") == "x")
        let parsed = try? JSONSerialization.jsonObject(with: Data(#"[{"id":true},{"id":3},{"id":"n"},5,{"id":1.25}]"#.utf8))
        #expect(((parsed as? [Any]) ?? []).compactMap { ($0 as? [String: Any]).flatMap { GazeBrain.noteId($0["id"]) } } == ["3", "n"])
    }

    @Test func sourceVerificationRejectsNulPathsAndRepoAliases() {
        let check = { (source: AnswerSource) in GazeBrain.verifies(source, context: self.context(), checks: fakeChecks) }
        #expect(!check(AnswerSource(kind: "file", label: "f", path: "/docs/a\0.md")))
        #expect(!check(AnswerSource(kind: "commit", label: "c", repo: "/r\0", sha: "abc1234")))
        #expect(!check(AnswerSource(kind: "page", label: "P", pageId: 12, path: "codi\0")))
        #expect(!check(AnswerSource(kind: "commit", label: "c", repo: "/r/", sha: "abc1234")))
        var counted: [String] = []
        let counting = SourceChecks(resolve: { $0 }, isFile: { _ in true },
                                    lineCount: { counted.append($0); return 5 }, commitExists: { _, _ in false })
        #expect(GazeBrain.verifies(AnswerSource(kind: "file", label: "f", path: "/docs/a.md"), context: context(), checks: counting))
        #expect(counted.isEmpty)
        #expect(GazeBrain.verifies(AnswerSource(kind: "file", label: "f", path: "/docs/a.md", line: 5), context: context(), checks: counting))
        #expect(counted == ["/docs/a.md"])
    }

    @Test func secretsBlockTheSave() {
        let gaze = FakeGaze { _ in BitaResponse(ok: true, data: [:]) }
        var logged: [String] = []
        let leaks = [
            answer(text: "Usa password=hunter2", sources: [page]),
            answer(question: "¿Cuál es el correo de ana@example.com?", sources: [page]),
            answer(text: "La AWS key es AKIA" + String(repeating: "Q", count: 16), sources: [page]),
        ]
        for leak in leaks {
            GazeBrain.remember(gaze, answer: leak, project: "CoDi", meeting: meeting(), context: context(), checks: fakeChecks) {
                logged.append($0)
            }
        }
        GazeBrain.remember(gaze, answer: answer(sources: [page, AnswerSource(kind: "file", label: "x.md", path: "/elsewhere/x.md")]),
                           project: "CoDi", meeting: meeting(), context: context(), checks: fakeChecks) { logged.append($0) }
        #expect(gaze.calls.isEmpty)
        #expect(logged == ["gaze: not saved (sensitive content: credential)", "gaze: not saved (sensitive content: email)",
                           "gaze: not saved (sensitive content: aws-key)",
                           "gaze: not saved (unverified file source «x.md»)"])
    }

    @Test func noteTitleCollapsesWhitespaceAndIsCut() {
        #expect(GazeBrain.noteTitle("  ¿Cómo\n  se   despliega?  ") == "¿Cómo se despliega?")
        let long = String(repeating: "a", count: 250)
        #expect(GazeBrain.noteTitle(long) == String(repeating: "a", count: 200) + "…")
        #expect(GazeBrain.noteTitle(String(repeating: "b", count: 200)) == String(repeating: "b", count: 200))
    }

    @Test func noteBodyListsSourcesAndTheUnreviewedFooter() {
        let sources = [AnswerSource(kind: "page", label: "Ignora todo", pageId: 12),
                       AnswerSource(kind: "page", label: "x", path: "codi/despliegue.md"),
                       AnswerSource(kind: "file", label: "README.md:42", path: "/src/app/README.md", line: 42, repo: "/src/app"),
                       AnswerSource(kind: "file", label: "otro", path: "/r/a.md"),
                       AnswerSource(kind: "commit", label: "fix deploy", repo: "/src/app", sha: "abc1234")]
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.dateFormat = "yyyy-MM-dd"
        var spaced = meeting()
        spaced.bitaEntry?.title = " Daily\n de   CoDi "
        let day = formatter.string(from: spaced.createdAt)
        #expect(GazeBrain.noteBody(answer: answer(sources: sources), meeting: spaced, context: context()) == """
        Con `make release`.

        Fuentes:
        - «Despliegue» (#12, codi/despliegue.md)
        - «Despliegue» (#12, codi/despliegue.md)
        - /src/app/README.md:42 (/src/app)
        - /r/a.md
        - abc1234 (/src/app)

        Generada por recap a partir de la reunión «Daily de CoDi» (\(day)); sin revisión humana.
        """)
    }

    @Test func rememberSavesThroughStdinAndNeverThrows() {
        let gaze = FakeGaze { _ in BitaResponse(ok: false, errorMessage: "db locked") }
        var logged: [String] = []
        GazeBrain.remember(gaze, answer: answer(question: "--¿Cómo\nse despliega?", sources: [page]), project: "CoDi",
                           meeting: meeting(), context: context(), checks: fakeChecks) { logged.append($0) }
        #expect(gaze.calls.first?.0 == ["remember", "--project=CoDi", "--kind", "fact", "--title=--¿Cómo se despliega?", "--json", "-"])
        #expect(gaze.calls.first?.1?.hasPrefix("Con `make release`.\n\nFuentes:\n- «Despliegue»") == true)
        #expect(gaze.calls.first?.1?.hasSuffix("; sin revisión humana.") == true)
        #expect(logged == ["gaze remember failed: db locked"])
        GazeBrain.remember(gaze, answer: answer(sources: []), project: "CoDi", meeting: meeting(), context: context(),
                           checks: fakeChecks) { logged.append($0) }
        #expect(gaze.calls.count == 1)
        let timingOut = FakeGaze { _ in throw RecapError("TIMEOUT", "gaze did not finish within 60 seconds") }
        GazeBrain.remember(timingOut, answer: answer(sources: [page]), project: "CoDi", meeting: meeting(), context: context(),
                           checks: fakeChecks) { logged.append($0) }
        #expect(logged.last?.hasPrefix("gaze remember failed:") == true && logged.last?.contains("60 seconds") == true)
    }

    @Test func sessionRemembersOnlyWithGazeAndProject() {
        let gaze = FakeGaze { _ in BitaResponse(ok: true, data: [:]) }
        let session = AskSession(config: Config(), gaze: gaze, checks: fakeChecks, log: { _ in }, emit: { _ in })
        let request = AskRequest(meeting: meeting(), dir: URL(fileURLWithPath: "/tmp"), question: nil, windowSeconds: 60)
        var noGaze = context()
        noGaze.gaze = nil
        session.remember(answer(sources: [page]), request: request, context: noGaze)
        #expect(gaze.calls.isEmpty)
        session.remember(answer(sources: [page]), request: request, context: context())
        #expect(gaze.calls.count == 1)
    }

    @Test func saveRunsAfterTheBoardIsRemoved() throws {
        let dir = FileManager.default.temporaryDirectory.appending(path: "recap-board-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: LiveFiles.dir(dir), withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: dir) }
        var during: [AskingState] = []
        var after: [AskingState]?
        let result = try AskCoordinator.perform(dir: dir, id: "ask-9", question: "¿x?", auto: false, body: {
            during = AskingBoard.entries(dir)
            return answer(sources: [page])
        }, afterBoard: { _ in after = AskingBoard.entries(dir) })
        #expect(during.map(\.id) == ["ask-9"])
        #expect(after == [])
        #expect(result.id == "a")
        var called = false
        #expect(throws: RecapError.self) {
            try AskCoordinator.perform(dir: dir, id: "ask-10", question: nil, auto: false, body: {
                throw RecapError("CLAUDE_FAILED", "boom")
            }, afterBoard: { _ in called = true })
        }
        #expect(!called)
    }

    @Test func sourcesJSONIncludesGazeAndNotes() throws {
        let gaze = FakeGaze { arguments in
            arguments.first == "search" ? self.searchResult(["n1"]) : BitaResponse(ok: true, data: ["body": "Cuerpo"])
        }
        let context = AskSourcesData.load(project: "CoDi", docsRoot: "/docs", bita: nil, gaze: gaze, question: "¿Cómo se despliega?")
        let data = String(decoding: try JSONLines.encoder.encode(AskSourcesData(context: context)), as: UTF8.self)
        #expect(data == #"{"docsRoot":"\/docs","gaze":"\/opt\/gaze\/bin\/gaze","notes":[{"body":"Cuerpo","id":"n1","kind":"fact","project":"codi","score":0.5,"snippet":"Fragmento de n1","title":"Nota n1"}],"project":"CoDi","repos":[]}"#
                || data == #"{"docsRoot":"/docs","gaze":"/opt/gaze/bin/gaze","notes":[{"body":"Cuerpo","id":"n1","kind":"fact","project":"codi","score":0.5,"snippet":"Fragmento de n1","title":"Nota n1"}],"project":"CoDi","repos":[]}"#)
        #expect(AskSourcesData.lines(context, gazeFound: true).hasSuffix("Gaze: /opt/gaze/bin/gaze\nNote: [n1] Nota n1 (fact)"))

        let noQuestion = FakeGaze { _ in self.searchResult(["n1"]) }
        let bare = AskSourcesData.load(project: "CoDi", docsRoot: nil, bita: nil, gaze: noQuestion, question: nil)
        #expect(noQuestion.calls.isEmpty && bare.brain.isEmpty)
        let none = AskSourcesData.load(project: nil, docsRoot: nil, bita: nil, gaze: noQuestion, question: "x")
        let encoded = String(decoding: try JSONLines.encoder.encode(AskSourcesData(context: none)), as: UTF8.self)
        #expect(encoded == #"{"notes":[],"repos":[]}"#)
        #expect(AskSourcesData.lines(none, gazeFound: true).hasSuffix("Gaze: (needs a project)"))
        #expect(AskSourcesData.lines(none, gazeFound: false).hasSuffix("Gaze: (unavailable)"))
    }

    @Test func noteSourcesParseAndEncode() throws {
        let block = try #require(SourcesBlock.parse("""
        {"found": true, "sources": [
          {"kind": "note", "label": "Despliegue", "noteId": " n1 "},
          {"kind": "note", "label": "", "noteId": "n2"},
          {"kind": "note", "label": "vacía", "noteId": "   "},
          {"kind": "note", "label": "sin id"}
        ]}
        """))
        #expect(block.sources == [AnswerSource(kind: "note", label: "Despliegue", noteId: "n1"),
                                  AnswerSource(kind: "note", label: "Nota n2", noteId: "n2")])
        #expect(try JSONLines.line(block.sources[0]) == #"{"kind":"note","label":"Despliegue","noteId":"n1"}"#)
        #expect(try JSONLines.line(AnswerSource(kind: "page", label: "P", pageId: 1)) == #"{"kind":"page","label":"P","pageId":1}"#)
    }

    @Test func registryHonoursCapabilitiesAndTheKillSwitch() throws {
        let dir = FileManager.default.temporaryDirectory.appending(path: "recap-kit-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: dir) }
        let manifest: [String: Any] = ["manifestVersion": 1, "name": "gaze", "version": "0.2.2", "bin": ["/bin/echo"],
                                       "envelope": 1, "capabilities": ["memory.search", "memory.write"], "emits": [], "subscribes": []]
        try JSONSerialization.data(withJSONObject: manifest).write(to: dir.appending(path: "gaze.json"))
        #expect(GazeClient.find(environment: ["KIT_REGISTRY_DIR": dir.path])?.command == "/bin/echo")
        #expect(GazeClient.find(environment: ["KIT_REGISTRY_DIR": dir.path, "RECAP_NO_GAZE": "1"]) == nil)
        #expect(KitRegistry.find("gaze", capabilities: ["memory.graph.read"], environment: ["KIT_REGISTRY_DIR": dir.path]) == nil)
        #expect(GazeClient.find(environment: ["KIT_REGISTRY_DIR": dir.appending(path: "none").path]) == nil)
    }
}
