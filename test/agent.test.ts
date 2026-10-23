import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'
import { agents } from '@kikedealba/kit'
import { parseConfig, type Config } from '../src/core/config.ts'
import { applyConfigValue, configValue } from '../src/core/live-settings.ts'
import { checkedTools } from '../src/core/tools.ts'
import { RecapError } from '../src/errors.ts'
import { runAsk } from '../src/live/ask.ts'
import { emptyContext } from '../src/live/context.ts'
import type { AskEvent } from '../src/live/stream.ts'
import { ISOLATION, resolveAgent, runAgent, runSummaryAgent, type AgentDependencies, type HeadlessAgent } from '../src/pipeline/agent.ts'
import { extractSummary } from '../src/pipeline/summary.ts'
import { meetingDir } from './helpers.ts'

const FIXTURES = path.join(import.meta.dirname, 'fixtures', 'headless')
const FILES: Record<HeadlessAgent, string> = {
  claude: 'claude.json',
  codex: 'codex.jsonl',
  gemini: 'gemini.json',
  antigravity: 'antigravity.json',
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

test('claude is the default agent and a fallback is announced', async () => {
  const fake = fakeRun('codex')
  const choice = await resolveAgent({}, 'pipeline', fake.dependencies)
  assert.deepEqual(choice, { agent: 'codex', bin: '/fake/bin/codex', preferred: 'claude', fallback: true })
  assert.deepEqual(fake.warnings, ['claude is not installed; using codex instead'])
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
  const empty = fakeRun('antigravity', () => '{"conversation_id":"c","status":"SUCCESS","response":"   "}')
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
      emptyContext(),
      (event) => events.push(event),
      undefined,
      fake.dependencies,
    )
    assert.equal(fake.calls[0]?.access, 'read')
    assert.equal(fake.calls[0]?.model, undefined)
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
