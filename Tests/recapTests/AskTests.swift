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
                                      context: context, segments: segments)
        #expect(!prompt.contains("{{"))
        #expect(prompt.contains("«Daily de CoDi»"))
        #expect(prompt.contains("- #3 Despliegue — codi/despliegue.md"))
        #expect(prompt.contains("`git -C /src/codi log|show|diff …`") && !prompt.contains("/src/gone"))
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
        let arguments = ClaudeRunner.streamArguments(tools: [AskPrompt.allowedTools(context).joined(separator: " ")],
                                                     addDirs: ["/d", "/r", "/d"], model: "haiku",
                                                     restrictTools: AskPrompt.availableTools)
        #expect(Array(arguments.prefix(5)) == ["-p", "--output-format", "stream-json", "--verbose", "--include-partial-messages"])
        #expect(arguments.contains("--strict-mcp-config") && arguments.contains("--no-session-persistence"))
        #expect(arguments[arguments.firstIndex(of: "--allowedTools")! + 1]
                == "Read Grep Glob Bash(git -C /r log:*) Bash(git -C /r show:*) Bash(git -C /r diff:*)")
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
        let data = String(decoding: try JSONEncoder().encode(AskSourcesData(project: context.project, docsRoot: context.docsRoot, repos: context.repos)), as: UTF8.self)
        #expect(data.contains(#""project":"CoDi""#) && data.contains(#""exists":false"#))
        #expect(bita.calls.contains(["project", "repo", "ls", "--project", "CoDi"]))
    }
}

final class FakeGaze: GazeCalling {
    var calls: [([String], String?)] = []
    let command: String
    let handler: ([String]) -> BitaResponse

    init(command: String = "/opt/gaze/bin/gaze", _ handler: @escaping ([String]) -> BitaResponse) {
        self.command = command
        self.handler = handler
    }

    func invoke(_ arguments: [String], stdin: Data?) throws -> BitaResponse {
        calls.append((arguments, stdin.map { String(decoding: $0, as: UTF8.self) }))
        return handler(arguments)
    }
}

@Suite struct GazeBrainTests {
    private func meeting() -> Meeting {
        var meeting = Meeting(id: "m", title: "Daily", mode: .remote, status: .recording,
                              createdAt: ISO8601DateFormatter().date(from: "2026-10-17T15:00:00Z")!)
        meeting.bitaEntry = BitaEntrySnapshot(title: "Daily de CoDi", projectName: "CoDi", kind: "remote-meeting", pageIds: [])
        return meeting
    }

    private func answer(found: Bool, sources: [AnswerSource]) -> Answer {
        Answer(id: "a", askedAt: Date(timeIntervalSince1970: 0), question: "¿Cómo se despliega?",
               answer: "Con `make release`.", found: found, sources: sources)
    }

    @Test func promptListsTheBrainNotesAndTheGazeBinary() throws {
        let gaze = FakeGaze { _ in
            BitaResponse(ok: true, data: [["id": "n1", "title": "Despliegue", "kind": "fact", "project": "CoDi",
                                           "snippet": " Se despliega\n con make release ", "score": 0.9]])
        }
        let context = ProjectContextLoader.load(project: "CoDi", docsRoot: "/d", bita: nil, gaze: gaze, question: "¿Cómo se despliega?")
        #expect(gaze.calls.map(\.0) == [["search", "¿Cómo se despliega?", "--project", "CoDi", "--limit", "5", "--json"]])
        let request = AskRequest(meeting: meeting(), dir: URL(fileURLWithPath: "/tmp"), question: "¿Cómo se despliega?", windowSeconds: 60)
        let prompt = AskPrompt.render(template: "{{brain}}|{{gaze}}", request: request, context: context, segments: [])
        #expect(prompt == "  - [n1] Despliegue (fact) — Se despliega con make release|/opt/gaze/bin/gaze")
        let full = AskPrompt.render(template: try ResourceText.load("ask-prompt.md"), request: request, context: context, segments: [])
        #expect(!full.contains("{{"))

        var empty = context
        empty.brain = []
        #expect(AskPrompt.render(template: "{{brain}}", request: request, context: empty, segments: []) == "  (sin notas en el cerebro)")
        let none = ProjectContextLoader.load(project: nil, docsRoot: nil, bita: nil, gaze: gaze, question: "x")
        #expect(AskPrompt.render(template: "{{brain}}|{{gaze}}", request: request, context: none, segments: [])
                == "  (el cerebro no está disponible)|")
        #expect(gaze.calls.count == 1)
        let failing = FakeGaze { _ in BitaResponse(ok: false, errorMessage: "boom") }
        #expect(ProjectContextLoader.load(project: "CoDi", docsRoot: nil, bita: nil, gaze: failing, question: "x").brain.isEmpty)
        let withoutQuestion = FakeGaze { _ in BitaResponse(ok: true, data: []) }
        _ = ProjectContextLoader.load(project: "CoDi", docsRoot: nil, bita: nil, gaze: withoutQuestion, question: nil)
        #expect(withoutQuestion.calls.isEmpty)
    }

    @Test func allowedToolsAddGazeOnlyWithGazeAndProject() {
        var context = ProjectContext(project: "CoDi", docsRoot: nil)
        #expect(AskPrompt.allowedTools(context) == ["Read", "Grep", "Glob"])
        context.gaze = "/opt/gaze/bin/gaze"
        #expect(AskPrompt.allowedTools(context)
                == ["Read", "Grep", "Glob", "Bash(/opt/gaze/bin/gaze search:*)", "Bash(/opt/gaze/bin/gaze show:*)"])
        context.repos = [RepoRef(path: "/r", slug: "r", exists: true)]
        #expect(Array(AskPrompt.allowedTools(context)[3...5])
                == ["Bash(/opt/gaze/bin/gaze search:*)", "Bash(/opt/gaze/bin/gaze show:*)", "Bash(git -C /r log:*)"])
        context.repos = []
        context.project = nil
        #expect(AskPrompt.allowedTools(context) == ["Read", "Grep", "Glob"])
        let describer = ProgressDescriber(docsRoot: nil, repos: [], gaze: "/opt/gaze/bin/gaze")
        #expect(describer.describe(name: "Bash", input: ["command": "/opt/gaze/bin/gaze search deploy --project CoDi"])
                == "Consultando el cerebro…")
        #expect(describer.describe(name: "Bash", input: ["command": "/opt/gaze/bin/gaze show n1"]) == "Consultando el cerebro…")
    }

    @Test func noteSourcesParseAndEncode() throws {
        let block = try #require(SourcesBlock.parse("""
        {"found": true, "sources": [
          {"kind": "note", "label": "Despliegue", "noteId": "n1"},
          {"kind": "note", "label": "", "noteId": "n2"},
          {"kind": "note", "label": "sin id"}
        ]}
        """))
        #expect(block.sources == [AnswerSource(kind: "note", label: "Despliegue", noteId: "n1"),
                                  AnswerSource(kind: "note", label: "Nota n2", noteId: "n2")])
        #expect(try JSONLines.line(block.sources[0]) == #"{"kind":"note","label":"Despliegue","noteId":"n1"}"#)
        #expect(try JSONLines.line(AnswerSource(kind: "page", label: "P", pageId: 1)) == #"{"kind":"page","label":"P","pageId":1}"#)
    }

    @Test func shouldRememberOnlyFoundAnswersBackedByDocsOrCode() {
        let page = AnswerSource(kind: "page", label: "Despliegue", pageId: 12, path: "codi/despliegue.md")
        let note = AnswerSource(kind: "note", label: "Despliegue", noteId: "n1")
        #expect(GazeBrain.shouldRemember(answer(found: true, sources: [page])))
        #expect(!GazeBrain.shouldRemember(answer(found: true, sources: [])))
        #expect(!GazeBrain.shouldRemember(answer(found: true, sources: [page, note])))
        #expect(!GazeBrain.shouldRemember(answer(found: false, sources: [page])))
    }

    @Test func noteBodyListsSourcesAndTheMeeting() {
        let sources = [AnswerSource(kind: "page", label: "Despliegue", pageId: 12, path: "codi/despliegue.md"),
                       AnswerSource(kind: "file", label: "README.md:42", path: "/src/app/README.md", line: 42, repo: "/src/app"),
                       AnswerSource(kind: "commit", label: "fix deploy", repo: "/src/app", sha: "abc1234")]
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.dateFormat = "yyyy-MM-dd"
        let day = formatter.string(from: meeting().createdAt)
        #expect(GazeBrain.noteBody(answer: answer(found: true, sources: sources), meeting: meeting()) == """
        Con `make release`.

        Fuentes:
        - «Despliegue» (#12, codi/despliegue.md)
        - /src/app/README.md:42 (/src/app)
        - abc1234 fix deploy (/src/app)

        Reunión: «Daily de CoDi» (\(day))
        """)
    }

    @Test func rememberSavesThroughStdinAndNeverThrows() {
        let gaze = FakeGaze { _ in BitaResponse(ok: false, errorMessage: "db locked") }
        var logged: [String] = []
        let page = AnswerSource(kind: "page", label: "Despliegue", pageId: 12, path: "codi/despliegue.md")
        GazeBrain.remember(gaze, answer: answer(found: true, sources: [page]), project: "CoDi", meeting: meeting()) { logged.append($0) }
        #expect(gaze.calls.first?.0 == ["remember", "-", "--project", "CoDi", "--kind", "fact", "--title", "¿Cómo se despliega?", "--json"])
        #expect(gaze.calls.first?.1?.hasPrefix("Con `make release`.\n\nFuentes:\n- «Despliegue»") == true)
        #expect(logged == ["gaze remember failed: db locked"])
        GazeBrain.remember(gaze, answer: answer(found: true, sources: []), project: "CoDi", meeting: meeting()) { logged.append($0) }
        #expect(gaze.calls.count == 1)
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
