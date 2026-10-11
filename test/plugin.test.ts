import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'
import { agents } from '@kikedealba/kit'
import { parseEnvelope } from '@kikedealba/kit/envelope'
import { platformContext } from '@kikedealba/kit/platform'
import { MeetingWatcher, describeSettled, watchDisabled } from '../src/cli/commands/watch.ts'
import { saveMeeting, type Meeting } from '../src/core/meeting.ts'
import { CLAUDE_PLUGIN, installAgents, integration, userSkillSources } from '../src/setup/integration.ts'
import { PACKAGE_ROOT } from '../src/version.ts'
import { meeting, sandboxEnv, tempDir } from './helpers.ts'

const USER_SKILLS = ['recap-ask', 'recap-list', 'recap-proposals', 'recap-start', 'recap-status', 'recap-stop', 'recap-summarize']

function readJson(file: string): unknown {
  return JSON.parse(readFileSync(path.join(PACKAGE_ROOT, file), 'utf8')) as unknown
}

test('every skill has valid frontmatter and the user skills are hidden from the model', () => {
  const skillsDir = path.join(PACKAGE_ROOT, 'skills')
  const names = readdirSync(skillsDir).sort()
  assert.deepEqual(names, ['recap', ...USER_SKILLS])
  for (const name of names) {
    const text = readFileSync(path.join(skillsDir, name, 'SKILL.md'), 'utf8')
    const { attributes, body } = agents.parseFrontmatter(text)
    assert.equal(attributes['name'], name)
    assert.ok((attributes['description'] ?? '').length > 10, `${name} needs a description`)
    assert.ok(body.trim().length > 0, `${name} needs a body`)
    if (name === 'recap') {
      assert.equal(attributes['disable-model-invocation'], undefined)
      assert.ok(text.split('\n').length < 200, 'the main skill stays under 200 lines')
      for (const link of body.matchAll(/\]\(([^)]+\.md)\)/g)) assert.ok(existsSync(path.join(skillsDir, name, link[1] ?? '')), `missing ${link[1]}`)
    } else {
      assert.equal(attributes['disable-model-invocation'], 'true', `${name} must only run when the user types it`)
    }
    assert.doesNotMatch(text, /bita docs|bita backlog|Rovo/)
  }
  assert.ok(!existsSync(path.join(PACKAGE_ROOT, 'commands')))
  assert.deepEqual(userSkillSources().map((skill) => skill.name), USER_SKILLS)
  assert.deepEqual(integration().userSkills?.map((skill) => skill.name), USER_SKILLS)
  assert.equal(integration().commands, undefined)
})

test('the plugin manifests carry the package version and a valid monitor', () => {
  const { version } = readJson('package.json') as { version: string }
  assert.equal((readJson('.claude-plugin/plugin.json') as { version: string }).version, version)
  const market = readJson('.claude-plugin/marketplace.json') as { name: string; plugins: { name: string; version: string; source: string }[] }
  assert.equal(market.name, CLAUDE_PLUGIN.marketplaceName)
  assert.deepEqual(market.plugins.map((plugin) => [plugin.name, plugin.version, plugin.source]), [[CLAUDE_PLUGIN.plugin, version, './']])
  const swift = readFileSync(path.join(PACKAGE_ROOT, 'Sources', 'RecapCapture', 'Commands', 'CaptureCommands.swift'), 'utf8')
  assert.ok(swift.includes(`static let version = "${version}"`))
  const monitors = readJson('monitors/monitors.json') as Record<string, unknown>[]
  assert.equal(monitors.length, 1)
  for (const monitor of monitors) {
    assert.deepEqual(Object.keys(monitor).sort(), ['command', 'description', 'name'])
    assert.match(String(monitor['command']), /recap watch/)
    assert.doesNotMatch(String(monitor['command']), /user_config/)
  }
})

test('installing for Claude Code adds or updates the plugin and removes the legacy files', { skip: process.platform === 'win32' && 'needs symlinks' }, async (t) => {
  const dir = tempDir(t)
  const env = sandboxEnv(dir)
  const ctx = platformContext({ env, home: dir })
  const claudeHome = path.join(dir, '.claude')
  mkdirSync(path.join(claudeHome, 'commands'), { recursive: true })
  const legacy = path.join(claudeHome, 'commands', 'recap-start.md')
  symlinkSync(path.join(PACKAGE_ROOT, 'skills', 'recap-start', 'SKILL.md'), legacy)
  const settings = path.join(claudeHome, 'settings.json')
  writeFileSync(settings, JSON.stringify({ permissions: { allow: ['Bash(recap status:*)'] } }))
  const calls: string[][] = []
  const exec = async (command: string, args: readonly string[]): Promise<string> => {
    calls.push([command, ...args])
    const joined = args.join(' ')
    if (joined === 'plugin marketplace list --json') return '[]'
    if (joined === 'plugin list --json') return JSON.stringify([{ id: 'recap@recap', scope: 'user' }])
    return ''
  }
  const steps = await installAgents(['claude'], { ctx, homes: { claude: claudeHome }, exec, locate: async (command) => (command === 'claude' ? '/fake/claude' : null) })
  const issued = calls.map((call) => call.slice(1).join(' '))
  assert.ok(issued.includes('plugin marketplace add KikeDeAlba/recap'), issued.join('\n'))
  assert.ok(issued.includes('plugin marketplace update recap'), issued.join('\n'))
  assert.ok(issued.includes('plugin update recap@recap --scope user'), issued.join('\n'))
  assert.ok(calls.every((call) => call[0] === '/fake/claude'))
  assert.ok(!steps.some((step) => step.state === 'failed'), JSON.stringify(steps))
  assert.ok(steps.some((step) => step.item === 'command recap-start' && step.state === 'removed'))
  assert.throws(() => lstatSync(legacy))
  assert.deepEqual(JSON.parse(readFileSync(settings, 'utf8')), { permissions: { allow: ['Bash(recap status:*)'] } })
})

test('installing for Claude Code without claude on PATH reports the manual steps', { skip: process.platform === 'win32' && 'needs symlinks' }, async (t) => {
  const dir = tempDir(t)
  const ctx = platformContext({ env: sandboxEnv(dir), home: dir })
  const claudeHome = path.join(dir, '.claude')
  mkdirSync(path.join(claudeHome, 'commands'), { recursive: true })
  const legacy = path.join(claudeHome, 'commands', 'recap-start.md')
  symlinkSync(path.join(PACKAGE_ROOT, 'skills', 'recap-start', 'SKILL.md'), legacy)
  const steps = await installAgents(['claude'], { ctx, homes: { claude: claudeHome }, exec: async () => '', locate: async () => null })
  assert.ok(lstatSync(legacy).isSymbolicLink(), 'legacy files stay until the plugin is in place')
  const plugin = steps.find((step) => step.item === 'plugin recap@recap')
  assert.equal(plugin?.state, 'unavailable')
  assert.match(plugin?.detail ?? '', /claude plugin install recap@recap/)
})

test('setup drives a fake claude through the plugin commands', { skip: process.platform === 'win32' && 'needs a POSIX shell' }, async (t) => {
  const dir = tempDir(t)
  const fakes = path.join(dir, 'fakebin')
  mkdirSync(fakes)
  const log = path.join(dir, 'claude.log')
  writeFileSync(
    path.join(fakes, 'claude'),
    `#!/bin/sh\nprintf '%s\\n' "$*" >> '${log}'\ncase "$*" in\n  "plugin marketplace list --json") echo '[]' ;;\n  "plugin list --json") echo '[]' ;;\nesac\n`,
  )
  chmodSync(path.join(fakes, 'claude'), 0o755)
  const env = sandboxEnv(dir, { PATH: `${fakes}${path.delimiter}${path.dirname(process.execPath)}` })
  const bin = path.join(PACKAGE_ROOT, 'src', 'bin', 'recap.ts')
  const stdout = await new Promise<string>((resolve) => {
    execFile(process.execPath, [bin, 'setup', '--skip-models', '--skip-permissions', '--skip-app', '--skip-bita', '--agents', 'claude', '--json'], { env }, (_error, out) => resolve(String(out)))
  })
  const envelope = parseEnvelope(stdout)
  assert.equal(envelope?.ok, true, stdout)
  const lines = readFileSync(log, 'utf8').trim().split('\n')
  assert.ok(lines.includes('plugin marketplace add KikeDeAlba/recap'), lines.join('\n'))
  assert.ok(lines.includes('plugin marketplace update recap'), lines.join('\n'))
  assert.ok(lines.includes('plugin install recap@recap --scope user'), lines.join('\n'))
  const checks = envelope?.data as { name: string; ok: boolean; detail: string }[]
  assert.ok(checks.some((check) => check.name === 'agent:claude' && check.ok && check.detail.includes('recap@recap')))
  assert.ok(!existsSync(path.join(dir, '.claude', 'skills', 'recap')))
})

function writeMeeting(root: string, overrides: Partial<Meeting>, bump = 0): string {
  const value = meeting(overrides)
  const dir = path.join(root, value.id)
  mkdirSync(dir, { recursive: true })
  saveMeeting(value, dir)
  const when = new Date(Date.now() + bump * 1000)
  utimesSync(path.join(dir, 'meeting.json'), when, when)
  return dir
}

test('the watcher reports each meeting once, when it finishes processing', (t) => {
  const root = tempDir(t)
  writeMeeting(root, { id: 'old', title: 'Old', status: 'processed' })
  writeMeeting(root, { id: 'live', title: 'Daily', status: 'recording' })
  const watcher = new MeetingWatcher(root)
  assert.deepEqual(watcher.tick(), [])
  assert.deepEqual(watcher.tick(), [])
  writeMeeting(root, { id: 'live', title: 'Daily', status: 'processing' }, 1)
  assert.deepEqual(watcher.tick(), [])
  const dir = writeMeeting(root, { id: 'live', title: 'Daily', status: 'processed', wrapup: { projectResolved: false, pageId: 7, backlogKeys: {} } as unknown as Meeting['wrapup'] }, 2)
  const events = watcher.tick()
  assert.equal(events.length, 1)
  assert.equal(events[0]?.id, 'live')
  assert.equal(events[0]?.failed, false)
  assert.equal(events[0]?.message, `recap: meeting "Daily" finished processing (live); minutes at ${path.join(dir, 'summary.md')}; inkwell page #7; project unresolved (FYI: act on it only if this session is handling that meeting)`)
  assert.deepEqual(watcher.tick(), [])
  writeMeeting(root, { id: 'live', title: 'Daily', status: 'processed' }, 3)
  assert.deepEqual(watcher.tick(), [])
  writeMeeting(root, { id: 'new', title: 'Import', status: 'recorded', stages: { transcribe: { status: 'failed', error: 'whisper\ncrashed', updatedAt: '2026-10-10T00:00:00Z' } } })
  const failed = watcher.tick()
  assert.equal(failed.length, 1)
  assert.equal(failed[0]?.failed, true)
  assert.equal(failed[0]?.message, 'recap: meeting "Import" failed at transcribe: whisper crashed (new); run `recap process new` to resume (FYI: act on it only if this session is handling that meeting)')
  writeMeeting(root, { id: 'opt', title: 'Opt', status: 'processing' })
  assert.deepEqual(watcher.tick(), [])
  writeMeeting(root, { id: 'opt', title: 'Opt', status: 'processed', stages: { proposals: { status: 'failed', error: 'x', updatedAt: '2026-10-10T00:00:00Z' } } }, 1)
  assert.equal(watcher.tick()[0]?.failed, false)
})

test('the watcher survives a missing root and can be turned off', (t) => {
  const watcher = new MeetingWatcher(path.join(tempDir(t), 'nope'))
  assert.deepEqual(watcher.tick(), [])
  assert.equal(watchDisabled({ RECAP_MONITOR: 'off' }), true)
  assert.equal(watchDisabled({ RECAP_MONITOR: '0' }), true)
  assert.equal(watchDisabled({}), false)
  assert.equal(describeSettled(meeting({ status: 'failed', error: 'no audio' }), '/x').message, 'recap: meeting "Daily" failed: no audio (m); run `recap process m` to resume (FYI: act on it only if this session is handling that meeting)')
})
