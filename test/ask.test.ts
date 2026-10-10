import assert from 'node:assert/strict'
import { mkdirSync } from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'
import { AVAILABLE_TOOLS, allowedTools, askAddDirs, renderAskPrompt, type AskRequest } from '../src/live/ask.ts'
import { emptyContext, loadProjectContext } from '../src/live/context.ts'
import { jsonLine } from '../src/live/files.ts'
import { AnswerAssembler, AskStreamReducer, ProgressDescriber, encodeAskEvent, parseSourcesBlock, parseStreamLine, type AskEvent } from '../src/live/stream.ts'
import { streamArguments } from '../src/pipeline/claude.ts'
import { loadResource } from '../src/pipeline/resources.ts'
import { RecapError } from '../src/errors.ts'
import { FakeBita, meeting, tempDir } from './helpers.ts'

const streamLine = (text: string) => JSON.stringify({ type: 'stream_event', session_id: 's', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } } })

test('parses text deltas, tool uses and the result', () => {
  const lines = [
    '{"type":"system","subtype":"init","session_id":"s","tools":["Read","Grep"]}',
    '{"type":"stream_event","event":{"type":"message_start","message":{"id":"m"}}}',
    '{"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Con "}}}',
    '{"type":"stream_event","event":{"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"{\\"file"}}}',
    '{"type":"assistant","message":{"id":"m","role":"assistant","content":[{"type":"text","text":"Con"},{"type":"tool_use","id":"t1","name":"Read","input":{"file_path":"/docs/codi/despliegue.md","limit":40}}]}}',
    '{"type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"t1","content":"..."}]}}',
    '{"type":"result","subtype":"success","is_error":false,"duration_ms":4100,"result":"Con make release.","session_id":"s"}',
    'not json',
  ]
  assert.deepEqual(lines.flatMap(parseStreamLine), [
    { type: 'text', text: 'Con ' },
    { type: 'tool', name: 'Read', input: { file_path: '/docs/codi/despliegue.md', limit: '40' } },
    { type: 'result', text: 'Con make release.', isError: false },
  ])
  assert.deepEqual(parseStreamLine('{"type":"result","subtype":"error_max_turns","is_error":true}'), [{ type: 'result', text: null, isError: true }])
})

test('describes progress relative to the known roots', () => {
  const describer = new ProgressDescriber('/data/docs', [{ path: '/src/bita-desktop', slug: 'bita-desktop', exists: true }])
  assert.equal(describer.describe('Read', { file_path: '/data/docs/codi/x.md' }), 'Leyendo docs/codi/x.md')
  assert.equal(describer.describe('Grep', { pattern: 'deploy', path: '/src/bita-desktop' }), 'Buscando «deploy» en bita-desktop')
  assert.equal(describer.describe('Bash', { command: 'git log -5' }), 'Ejecutando git log -5')
  assert.equal(describer.describe('Bash', { command: 'git -C /src/bita-desktop log -1' }), 'Ejecutando git -C bita-desktop log -1')
})

test('the assembler strips the question header and holds back the sources block', () => {
  const assembler = new AnswerAssembler()
  let out = ''
  for (const delta of ['PREG', 'UNTA: ¿Cómo se despliega?\n', 'Con `make', ' release` (README.md:12).\n\n``', '`bash\nmake release\n```\n', '\n```fu', 'entes\n{"found": true}\n```']) out += assembler.feed(delta)
  out += assembler.finish()
  assert.equal(assembler.question, '¿Cómo se despliega?')
  assert.equal(out, 'Con `make release` (README.md:12).\n\n```bash\nmake release\n```\n\n')
  assert.ok(assembler.sourcesText.includes('"found": true'))
  const plain = new AnswerAssembler()
  let text = plain.feed('Prueba con ')
  text += plain.feed('`make test`.')
  text += plain.finish()
  assert.equal(plain.question, null)
  assert.equal(text, 'Prueba con `make test`.')
})

test('parses the sources block and drops invalid entries', () => {
  const block = parseSourcesBlock(`
{"question": "¿Cómo se despliega?", "found": true, "sources": [
  {"kind": "page", "label": "Despliegue", "pageId": 12, "path": "codi/despliegue.md"},
  {"kind": "file", "label": "", "repo": "/src/app", "path": "/src/app/README.md", "line": "42"},
  {"kind": "commit", "label": "abc1234 fix deploy", "repo": "/src/app", "sha": "abc1234"},
  {"kind": "web", "label": "x"},
  {"kind": "file", "label": "sin ruta"}
]}
\`\`\``)
  assert.ok(block)
  assert.equal(block.question, '¿Cómo se despliega?')
  assert.equal(block.found, true)
  assert.deepEqual(
    block.sources.map((source) => source.kind),
    ['page', 'file', 'commit'],
  )
  assert.equal(block.sources[1]?.label, '/src/app/README.md:42')
  assert.equal(block.sources[1]?.line, 42)
  assert.equal(parseSourcesBlock('sin json'), null)
})

test('the reducer turns a stream into events and an answer', () => {
  const sources = '{"question":"¿Cómo se despliega bita-desktop?","found":true,"sources":[{"kind":"file","label":"README.md:30","repo":"/src/bita-desktop","path":"/src/bita-desktop/README.md","line":30}]}'
  const full = `PREGUNTA: ¿Cómo se despliega bita-desktop?\nCon \`pnpm release\` (README.md:30).\n\`\`\`fuentes\n${sources}\n\`\`\``
  const lines = [
    '{"type":"assistant","message":{"content":[{"type":"tool_use","id":"t","name":"Grep","input":{"pattern":"release","path":"/src/bita-desktop"}}]}}',
    streamLine('PREGUNTA: ¿Cómo se despliega bita-desktop?\n'),
    streamLine('Con `pnpm release` (README.md:30).\n'),
    streamLine(`\`\`\`fuentes\n${sources}\n\`\`\``),
    JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: full }),
  ]
  const describer = new ProgressDescriber(null, [{ path: '/src/bita-desktop', slug: 'bita-desktop', exists: true }])
  const reducer = new AskStreamReducer(null)
  const events: AskEvent[] = lines.flatMap((line) => reducer.consume(line, describer))
  const { events: tail, answer } = reducer.finish(0, '', 'a1', '1970-01-01T00:00:00Z')
  events.push(...tail)
  assert.deepEqual(events[0], { type: 'progress', text: 'Buscando «release» en bita-desktop' })
  assert.ok(events.some((event) => event.type === 'question' && event.text === '¿Cómo se despliega bita-desktop?'))
  const streamed = events.flatMap((event) => (event.type === 'delta' ? [event.text] : [])).join('')
  assert.equal(streamed.trim(), 'Con `pnpm release` (README.md:30).')
  assert.equal(answer.answer, 'Con `pnpm release` (README.md:30).')
  assert.ok(answer.found)
  assert.equal(answer.sources.length, 1)
  assert.deepEqual(events.at(-1), { type: 'source', source: answer.sources[0] })
  const encoded = jsonLine(encodeAskEvent({ type: 'done', answer }))
  assert.ok(encoded.startsWith('{"answer":{"answer":'))
  assert.ok(encoded.includes('"type":"done"'))
})

test('the reducer marks undocumented answers and fails on errors', () => {
  const reducer = new AskStreamReducer('¿Dónde está el runbook?')
  reducer.consume(streamLine('No está documentado. Revisé las páginas del proyecto.'), new ProgressDescriber(null, []))
  const { answer } = reducer.finish(0, '', 'a2', '2026-01-01T00:00:00Z')
  assert.equal(answer.found, false)
  assert.equal(answer.question, '¿Dónde está el runbook?')
  const failing = new AskStreamReducer('x')
  failing.consume('{"type":"result","subtype":"error_during_execution","is_error":true,"result":"boom"}', new ProgressDescriber(null, []))
  assert.throws(() => failing.finish(1, '', 'a3', '2026-01-01T00:00:00Z'), RecapError)
})

test('renders context, question and transcript window', () => {
  const value = meeting({ bitaEntry: { title: 'Daily de CoDi', projectName: 'CoDi', kind: 'remote-meeting', pageIds: [] } })
  const segments = [
    { startMs: 0, endMs: 3_000, channel: 'system' as const, text: 'Hablemos del sprint anterior.' },
    { startMs: 400_000, endMs: 404_000, channel: 'system' as const, text: '¿Cómo se despliega el webhook?' },
  ]
  const context = emptyContext({
    project: 'CoDi',
    docsRoot: '/data/docs',
    pages: [{ pageId: 3, title: 'Despliegue', relPath: 'codi/despliegue.md', depth: 1 }],
    repos: [
      { path: '/src/codi', slug: 'codi', exists: true },
      { path: '/src/gone', slug: 'gone', exists: false },
    ],
  })
  const request: AskRequest = { meeting: value, dir: '/tmp', question: null, windowSeconds: 180, now: '2026-10-10T10:00:00Z', auto: false }
  const prompt = renderAskPrompt(loadResource('ask-prompt.md'), request, context, segments)
  assert.ok(!prompt.includes('{{'))
  assert.ok(prompt.includes('«Daily de CoDi»'))
  assert.ok(prompt.includes('- #3 Despliegue — codi/despliegue.md'))
  assert.ok(prompt.includes('`git -C /src/codi log|show|diff …`') && !prompt.includes('/src/gone'))
  assert.ok(prompt.includes('[00:06:40] Remotos: ¿Cómo se despliega el webhook?'))
  assert.ok(!prompt.includes('sprint anterior'))
  assert.ok(prompt.includes('identifícala en la transcripción'))
  assert.deepEqual(askAddDirs(context), ['/data/docs', '/src/codi'])
  const explicit = renderAskPrompt('{{questionBlock}}', { ...request, question: '¿Qué puerto usa?', windowSeconds: 60 }, context, segments)
  assert.ok(explicit.includes('> ¿Qué puerto usa?'))
})

test('stream arguments keep the isolation flags', () => {
  const context = emptyContext({ project: 'CoDi', docsRoot: '/d', repos: [{ path: '/r', slug: 'r', exists: true }, { path: '/gone', slug: 'gone', exists: false }] })
  const args = streamArguments([allowedTools(context).join(' ')], ['/d', '/r', '/d'], 'haiku', AVAILABLE_TOOLS)
  assert.deepEqual(args.slice(0, 5), ['-p', '--output-format', 'stream-json', '--verbose', '--include-partial-messages'])
  assert.ok(args.includes('--strict-mcp-config') && args.includes('--no-session-persistence') && args.includes('--setting-sources'))
  assert.equal(args[args.indexOf('--allowedTools') + 1], 'Read Grep Glob Bash(git -C /r log:*) Bash(git -C /r show:*) Bash(git -C /r diff:*)')
  assert.deepEqual(allowedTools(emptyContext()), ['Read', 'Grep', 'Glob'])
  assert.ok(!args.join(' ').includes('gone'))
  assert.equal(args.filter((arg) => arg === '--add-dir').length, 2)
  assert.deepEqual(args.slice(-2), ['--model', 'haiku'])
})

test('sources list only the project repositories and the docs root', async (t) => {
  const existing = path.join(tempDir(t), 'repo')
  mkdirSync(existing)
  const bita = new FakeBita((args) => {
    const head = args.slice(0, 3).join(' ')
    if (head === 'docs page ls') {
      return {
        ok: true,
        data: { pages: [{ pageId: 1, title: 'CoDi', relPath: 'codi/index.md', depth: 0, children: [{ pageId: 2, title: 'Reglas', relPath: 'codi/reglas.md', depth: 1 }] }] },
        meta: { root: '/data/docs' },
      }
    }
    if (head === 'project repo ls') {
      return {
        ok: true,
        data: {
          repos: [
            { project: 'CoDi', path: existing, slug: 'codi-api', source: 'stop', exists: true },
            { project: 'CoDi', path: '/nope/missing', slug: null, source: 'manual', exists: false },
          ],
        },
      }
    }
    return { ok: false, errorCode: 'USAGE', errorMessage: 'unknown' }
  })
  const context = await loadProjectContext('CoDi', null, bita)
  assert.equal(context.docsRoot, '/data/docs')
  assert.deepEqual(
    context.pages.map((page) => page.pageId),
    [1, 2],
  )
  assert.deepEqual(context.repos, [
    { path: existing, slug: 'codi-api', exists: true },
    { path: '/nope/missing', slug: 'missing', exists: false },
  ])
  assert.ok(bita.calls.some((call) => call.join(' ') === 'project repo ls --project CoDi'))
})
