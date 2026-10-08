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
        #expect(prompt.contains("/src/codi") && !prompt.contains("/src/gone"))
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
        let arguments = ClaudeRunner.streamArguments(tools: [AskPrompt.allowedTools.joined(separator: " ")],
                                                     addDirs: ["/d", "/r", "/d"], model: "haiku",
                                                     restrictTools: AskPrompt.availableTools)
        #expect(Array(arguments.prefix(5)) == ["-p", "--output-format", "stream-json", "--verbose", "--include-partial-messages"])
        #expect(arguments.contains("--strict-mcp-config") && arguments.contains("--no-session-persistence"))
        #expect(arguments[arguments.firstIndex(of: "--allowedTools")! + 1]
                == "Read Grep Glob Bash(git log:*) Bash(git show:*) Bash(git diff:*)")
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
