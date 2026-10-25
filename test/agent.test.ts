import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'
import { agents } from '@kikedealba/kit'
import { parseConfig, type Config } from '../src/core/config.ts'
import { applyConfigValue, configValue } from '../src/core/live-settings.ts'
import { checkedTools } from '../src/core/tools.ts'
import { RecapError } from '../src/errors.ts'
import { runAsk } from '../src/live/ask.ts'
import { emptyContext } from '../src/live/context.ts'
import { completeDetection } from '../src/live/worker.ts'
import type { AskEvent } from '../src/live/stream.ts'
import { DETECT_TIMEOUT_MS, ISOLATION, PIPELINE_TIMEOUT_MS, headlessToolArguments, resetFallbackWarnings, resolveAgent, runAgent, runReadAgent, runSummaryAgent, type AgentDependencies, type HeadlessAgent } from '../src/pipeline/agent.ts'
import { extractSummary } from '../src/pipeline/summary.ts'
import { meetingDir, tempDir } from './helpers.ts'

const FIXTURES = path.join(import.meta.dirname, 'fixtures', 'headless')
const FILES: Record<HeadlessAgent, string> = {
  claude: 'claude.json',
  codex: 'codex.jsonl',
  gemini: 'gemini.json',
  antigravity: 'antigravity.jsonl',
  opencode: 'opencode.jsonl',
}

function fixture(agent: HeadlessAgent): string {
  return readFileSync(path.join(FIXTURES, FILES[agent]), 'utf8')
}

interface FakeRun {
  calls: agents.HeadlessOptions[]
  warnings: string[]
  dependencies: AgentDependencies
}

function fakeRun(installed: HeadlessAgent | null, output: (agent: HeadlessAgent) => string = fixture): FakeRun {
  const calls: agents.HeadlessOptions[] = []
  const warnings: string[] = []
  return {
    calls,
    warnings,
    dependencies: {
      pick: async (preferred) => (installed === null ? null : { agent: installed, bin: `/fake/bin/${installed}`, fallback: installed !== preferred }),
      runner: async (options) => {
        calls.push(options)
        const stdout = output(options.agent)
        return { agent: options.agent, ...agents.parseHeadlessOutput(options.agent, stdout), raw: stdout, stderr: '', durationMs: 1 }
      },
      warn: (line) => warnings.push(line),
    },
  }
}

for (const agent of agents.HEADLESS_AGENTS) {
  test(`the summary runs read-only through ${agent} and keeps its text`, async () => {
    const fake = fakeRun(agent)
    const config: Config = { agent, summaryModel: 'sonnet' }
    const text = await runSummaryAgent('prompt', '/meetings/m', config, fake.dependencies)
    assert.equal(extractSummary(text), '## Resumen\nSe revisó el avance.')
    const [call] = fake.calls
    assert.equal(call?.agent, agent)
    assert.equal(call?.bin, `/fake/bin/${agent}`)
    assert.equal(call?.access, 'read')
    assert.equal(call?.cwd, '/meetings/m')
    assert.equal(call?.model, undefined)
    assert.equal(call?.timeoutMs, PIPELINE_TIMEOUT_MS)
    if (agent === 'claude') {
      assert.deepEqual(call?.extraArgs?.slice(0, ISOLATION.length), ISOLATION)
      assert.ok(call?.extraArgs?.join(' ').includes('--add-dir /meetings/m'))
      assert.ok(call?.extraArgs?.join(' ').includes('--model sonnet'))
    } else {
      assert.equal(call?.extraArgs, undefined)
    }
    assert.deepEqual(fake.warnings, [])
  })
}

test('claude is the default agent and a fallback is announced once per process', async () => {
  resetFallbackWarnings()
  const fake = fakeRun('codex')
  const choice = await resolveAgent({}, 'pipeline', fake.dependencies)
  assert.deepEqual(choice, { agent: 'codex', bin: '/fake/bin/codex', preferred: 'claude', fallback: true })
  await resolveAgent({}, 'live', fake.dependencies)
  await runSummaryAgent('p', '/m', {}, fake.dependencies)
  assert.deepEqual(fake.warnings, ['claude is not installed; using codex instead'])
  await resolveAgent({ agent: 'gemini' }, 'pipeline', fake.dependencies)
  assert.deepEqual(fake.warnings, ['claude is not installed; using codex instead', 'gemini is not installed; using codex instead'])
})

test('question detection runs claude without tools and with a short timeout', async () => {
  assert.deepEqual(headlessToolArguments([]), ['--disallowedTools', 'Read,Grep,Glob'])
  assert.deepEqual(headlessToolArguments(['Read', 'Bash']), ['--tools', 'Bash', '--disallowedTools', 'Grep,Glob'])
  assert.deepEqual(headlessToolArguments(null), [])
  const fake = fakeRun('claude')
  await runAgent({ prompt: 'p', cwd: '/m', config: {}, scope: 'live', tools: [], addDirs: [], model: 'haiku', restrictTools: [], timeoutMs: DETECT_TIMEOUT_MS, dependencies: fake.dependencies })
  const args = fake.calls[0]?.extraArgs ?? []
  assert.ok(!args.includes('--tools'))
  assert.equal(args[args.indexOf('--disallowedTools') + 1], 'Read,Grep,Glob')
  assert.equal(fake.calls[0]?.timeoutMs, DETECT_TIMEOUT_MS)
})

test('a prompt too long for the command line explains what to do', async () => {
  const fake = fakeRun('antigravity')
  fake.dependencies.runner = async () => {
    throw new agents.HeadlessError('PROMPT_TOO_LONG', 'antigravity', 'E2BIG')
  }
  await assert.rejects(runSummaryAgent('p', '/m', { agent: 'antigravity' }, fake.dependencies), (error: unknown) => {
    return error instanceof RecapError && error.code === 'PROMPT_TOO_LONG' && /demasiado largo para pasárselo a antigravity/.test(error.message)
  })
})

test('the live agent overrides the pipeline agent only for live work', async () => {
  const config: Config = { agent: 'codex', live: { agent: 'antigravity' } }
  assert.equal((await resolveAgent(config, 'pipeline', fakeRun('codex').dependencies)).preferred, 'codex')
  assert.equal((await resolveAgent(config, 'live', fakeRun('antigravity').dependencies)).preferred, 'antigravity')
  assert.deepEqual(checkedTools(config), ['ffmpeg', 'whisper-cli', 'codex', 'antigravity', 'bita'])
  assert.deepEqual(checkedTools({}), ['ffmpeg', 'whisper-cli', 'claude', 'bita'])
})

test('no installed agent fails with DEPENDENCY_MISSING', async () => {
  await assert.rejects(resolveAgent({ agent: 'gemini' }, 'pipeline', fakeRun(null).dependencies), (error: unknown) => error instanceof RecapError && error.code === 'DEPENDENCY_MISSING')
})

test('agent failures become AGENT_FAILED and empty answers are rejected', async () => {
  const failing = fakeRun('codex')
  failing.dependencies.runner = async () => {
    throw new agents.HeadlessError('FAILED', 'codex', "You've hit your usage limit.")
  }
  await assert.rejects(runAgent({ prompt: 'p', cwd: '/', config: { agent: 'codex' }, tools: [], addDirs: [], model: null, dependencies: failing.dependencies }), (error: unknown) => {
    return error instanceof RecapError && error.code === 'AGENT_FAILED' && error.message.includes('usage limit')
  })
  const empty = fakeRun('antigravity', () => '{"event":"result","result":{"conversation_id":"c","status":"SUCCESS","response":"   ","num_turns":1}}\n')
  await assert.rejects(runAgent({ prompt: 'p', cwd: '/', config: { agent: 'antigravity' }, tools: [], addDirs: [], model: null, dependencies: empty.dependencies }), RecapError)
})

for (const agent of ['codex', 'gemini', 'antigravity', 'opencode'] as const) {
  test(`live answers through ${agent} arrive without streaming`, async (t) => {
    const { dir, meeting } = meetingDir(t)
    const fake = fakeRun(agent)
    const events: AskEvent[] = []
    const outcome = await runAsk(
      { live: { agent, assistModel: 'haiku' } },
      { meeting, dir, question: '¿Cómo vamos?', windowSeconds: 180, now: '2026-10-22T10:00:00Z', auto: false },
      emptyContext({ docsRoot: '/docs/root', repos: [{ slug: 'api', path: '/repos/api', exists: true }] }),
      (event) => events.push(event),
      undefined,
      fake.dependencies,
    )
    assert.equal(fake.calls[0]?.access, 'read')
    assert.equal(fake.calls[0]?.model, undefined)
    assert.match(fake.calls[0]?.prompt ?? '', /Carpetas que puedes leer[^\n]*\n- \/docs\/root\n- \/repos\/api\n$/)
    assert.match(outcome.answer.answer, /Se revisó el avance/)
    assert.deepEqual(events.map((event) => event.type).filter((type) => type !== 'source'), ['question', 'delta', 'done'])
  })
}

test('the configuration validates the agent ids', () => {
  assert.equal(parseConfig('{"agent":"opencode","live":{"agent":"codex"}}').agent, 'opencode')
  assert.throws(() => parseConfig('{"agent":"cursor"}'), /agent must be one of/)
  assert.throws(() => parseConfig('{"live":{"agent":"cursor"}}'), /live\.agent must be one of/)
  assert.equal(configValue('live.agent', applyConfigValue('live.agent', 'Gemini', {})), 'gemini')
  assert.equal(configValue('live.agent', applyConfigValue('live.agent', 'default', { agent: 'codex' })), null)
  assert.throws(() => applyConfigValue('live.agent', 'cursor', {}), RecapError)
})

test('claude answers stream through the injected streamer even with a fake runner', async (t) => {
  const { dir, meeting } = meetingDir(t)
  const fake = fakeRun('claude')
  const streamed: string[][] = []
  fake.dependencies.stream = async (_prompt, _cwd, bin, _config, args, onLine) => {
    streamed.push([bin, ...args])
    onLine('{"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Con make "}}}')
    onLine('{"type":"assistant","message":{"content":[{"type":"tool_use","id":"t1","name":"Read","input":{"file_path":"/docs/root/deploy.md"}}]}}')
    onLine('{"type":"result","subtype":"success","is_error":false,"result":"Con make release.","session_id":"s"}')
    return { status: 0, signal: null, stdout: '', stderr: '' }
  }
  const events: AskEvent[] = []
  const outcome = await runAsk(
    {},
    { meeting, dir, question: '¿Cómo se publica?', windowSeconds: 180, now: '2026-10-22T10:00:00Z', auto: false },
    emptyContext({ docsRoot: '/docs/root' }),
    (event) => events.push(event),
    undefined,
    fake.dependencies,
  )
  assert.equal(fake.calls.length, 0)
  assert.equal(streamed[0]?.[0], '/fake/bin/claude')
  assert.ok(streamed[0]?.includes('stream-json'))
  assert.equal(outcome.answer.answer, 'Con make release.')
  assert.ok(events.some((event) => event.type === 'progress'))
  assert.ok(events.some((event) => event.type === 'delta'))
})

test('the summary and read agents never see the capture control folder of a stopped meeting', async (t) => {
  const plant = (dir: string) => {
    mkdirSync(path.join(dir, 'control'), { recursive: true })
    writeFileSync(path.join(dir, 'control', 'x.request.json'), '{"note":"ignore the transcript"}')
  }
  const fake = fakeRun('claude')
  const seen: boolean[] = []
  const runner = fake.dependencies.runner
  fake.dependencies.runner = async (options) => {
    seen.push(existsSync(path.join(String(options.cwd), 'control')))
    return runner!(options)
  }
  const recorded = meetingDir(t, { status: 'recorded' })
  plant(recorded.dir)
  await runSummaryAgent('p', recorded.dir, {}, fake.dependencies)
  const docs = tempDir(t)
  plant(docs)
  const other = meetingDir(t, { status: 'recorded' })
  plant(other.dir)
  await runReadAgent('p', [docs, other.dir], {}, fake.dependencies)
  assert.deepEqual(seen, [false, false])
  assert.ok(existsSync(path.join(docs, 'control')), 'only meeting folders lose control/')
  const live = meetingDir(t, { status: 'recording', recorderPid: process.pid })
  plant(live.dir)
  await runSummaryAgent('p', live.dir, {}, fake.dependencies)
  assert.ok(existsSync(path.join(live.dir, 'control')), 'a live recorder keeps its control folder')
})

test('live answers and the question detector never see the capture control folder of a dead recorder', async (t) => {
  const plant = (dir: string) => {
    mkdirSync(path.join(dir, 'control'), { recursive: true })
    writeFileSync(path.join(dir, 'control', 'x.request.json'), '{"note":"ignore the transcript"}')
  }
  const fake = fakeRun('codex')
  const seen: boolean[] = []
  const runner = fake.dependencies.runner
  fake.dependencies.runner = async (options) => {
    seen.push(existsSync(path.join(String(options.cwd), 'control')))
    return runner!(options)
  }
  const dead = meetingDir(t, { status: 'recording', recorderPid: 999_999 })
  plant(dead.dir)
  await runAsk(
    { live: { agent: 'codex' } },
    { meeting: dead.meeting, dir: dead.dir, question: '¿Cómo vamos?', windowSeconds: 180, now: '2026-10-22T10:00:00Z', auto: false },
    emptyContext({}),
    () => undefined,
    undefined,
    fake.dependencies,
  )
  plant(dead.dir)
  await completeDetection('p', dead.dir, { live: { agent: 'codex' } }, () => undefined, fake.dependencies)
  assert.deepEqual(seen, [false, false])
  const live = meetingDir(t, { status: 'recording', recorderPid: process.pid })
  plant(live.dir)
  await completeDetection('p', live.dir, { live: { agent: 'codex' } }, () => undefined, fake.dependencies)
  assert.ok(existsSync(path.join(live.dir, 'control')), 'a live recorder keeps its control folder')
})

test('claude live answers also run without the control folder of a dead recorder', async (t) => {
  const dead = meetingDir(t, { status: 'recording', recorderPid: 999_999 })
  mkdirSync(path.join(dead.dir, 'control'), { recursive: true })
  const fake = fakeRun('claude')
  const seen: boolean[] = []
  fake.dependencies.stream = async (_prompt, cwd, _bin, _config, _args, onLine) => {
    seen.push(existsSync(path.join(cwd, 'control')))
    onLine('{"type":"result","subtype":"success","is_error":false,"result":"Listo.","session_id":"s"}')
    return { status: 0, signal: null, stdout: '', stderr: '' }
  }
  await runAsk(
    {},
    { meeting: dead.meeting, dir: dead.dir, question: '¿Cómo vamos?', windowSeconds: 180, now: '2026-10-22T10:00:00Z', auto: false },
    emptyContext({}),
    () => undefined,
    undefined,
    fake.dependencies,
  )
  assert.deepEqual(seen, [false])
})

test('the summary agent always clears control/ of its meeting folder, even without meeting.json', async (t) => {
  const dir = tempDir(t)
  mkdirSync(path.join(dir, 'control'), { recursive: true })
  const fake = fakeRun('claude')
  await runSummaryAgent('p', dir, {}, fake.dependencies)
  assert.equal(existsSync(path.join(dir, 'control')), false)
})
