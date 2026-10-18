import assert from 'node:assert/strict'
import { execFile, execFileSync } from 'node:child_process'
import { existsSync, realpathSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'
import { repoGitCommand, type GitRunner } from '../src/cli/commands/repo-git.ts'
import { allowedTools, renderAskPrompt, type AskRequest } from '../src/live/ask.ts'
import { emptyContext } from '../src/live/context.ts'
import { REPO_GIT_STRIPPED_ENV, recapEntry, repoGitArguments, repoGitEnv, repoGitRules, runningCommand, validateRepoGitArgs } from '../src/live/repo-git.ts'
import { PACKAGE_ROOT } from '../src/version.ts'
import { meeting, tempDir } from './helpers.ts'

const BIN = path.join(PACKAGE_ROOT, 'src', 'bin', 'recap.ts')
const SELF = ['/usr/local/bin/recap']
const anyDir = () => true

const ALLOWED = [
  ['log', '--oneline', '-5'],
  ['log', '-n', '3', '--stat', '--', 'src/a.ts'],
  ['show', 'HEAD~1', '--stat'],
  ['show', 'abc123:README.md'],
  ['diff', 'HEAD~2', 'HEAD', '--', 'README.md'],
  ['log', '--since=2026-01-01', '--author=ana', '--grep=deploy', '-i'],
  ['log', '-L10,20:README.md'],
  ['log', '--format=%h %s', '-n5', '--date=short', '-Sfoo', '-Gbar', 'HEAD~3..HEAD'],
  ['diff', '-U5', '-M50%', '--word-diff=color', '--diff-filter=AM', '--color=never', '--stat=80'],
]

const REJECTED: [string[], string][] = [
  [['/r', 'diff', '--output=/tmp/x'], 'option not allowed: --output=/tmp/x'],
  [['/r', 'log', '--output', '/tmp/x'], 'option not allowed: --output'],
  [['/r', 'diff', '--no-index', '/etc/hosts', '/dev/null'], 'option not allowed: --no-index'],
  [['/r', 'diff', '--ext-diff'], 'option not allowed: --ext-diff'],
  [['/r', 'show', '--textconv', 'HEAD'], 'option not allowed: --textconv'],
  [['/r', 'log', '-O/etc/passwd'], 'option not allowed: -O/etc/passwd'],
  [['/r', 'log', '--exec=x'], 'option not allowed: --exec=x'],
  [['/r', 'diff', '--', 'a\0b'], 'argument contains a NUL byte'],
  [['/r', 'grep', 'x'], 'subcommand not allowed: grep'],
  [['repo', 'log'], 'repository path must be absolute: repo'],
  [['/r', 'log', '-c'], 'option not allowed: -c'],
  [['/r', 'log', '--git-dir=/x'], 'option not allowed: --git-dir=/x'],
  [['/r', 'log', '--work-tree=/x'], 'option not allowed: --work-tree=/x'],
  [['/r', 'log', '--outp=/tmp/x'], 'option not allowed: --outp=/tmp/x'],
  [['/r', 'show', '-L1,2:a'], 'option not allowed: -L1,2:a'],
  [['/r', 'log', '-n', 'x'], '-n needs a number'],
  [['/r', 'log', '-n'], '-n needs a number'],
  [['/r', 'diff', '/etc/hosts', '/dev/null'], 'path outside the repository not allowed: /etc/hosts'],
  [['/r', 'diff', '--', '../../etc/hosts', 'a'], 'path outside the repository not allowed: ../../etc/hosts'],
  [['/r'], 'subcommand not allowed: (none)'],
]

function recordingRunner(): { runner: GitRunner; calls: string[][] } {
  const calls: string[][] = []
  return { calls, runner: async (args) => (calls.push(args), 0) }
}

test('accepts the shared allowed vectors', () => {
  for (const args of ALLOWED) {
    const result = validateRepoGitArgs(['/r', ...args], anyDir)
    assert.ok(result.ok, `${args.join(' ')} should be allowed`)
    assert.deepEqual(result.ok && [result.sub, ...result.args], args)
  }
})

test('rejects the shared rejected vectors with a reason', () => {
  for (const [argv, reason] of REJECTED) assert.deepEqual(validateRepoGitArgs(argv, anyDir), { ok: false, reason }, argv.join(' '))
  assert.deepEqual(validateRepoGitArgs(['/definitely/not/here', 'log']), { ok: false, reason: 'repository not found: /definitely/not/here' })
})

test('never spawns git for rejected arguments and exits 2', async (t) => {
  const repo = tempDir(t)
  const vectors = [...REJECTED.map(([argv]) => (argv[0] === '/r' ? [repo, ...argv.slice(1)] : argv)), [path.join(repo, 'missing'), 'log']]
  for (const argv of vectors) {
    const { runner, calls } = recordingRunner()
    let error = ''
    assert.equal(await repoGitCommand(argv, runner, (text) => (error += text)), 2, argv.join(' '))
    assert.equal(calls.length, 0)
    assert.ok(error.startsWith('recap repo-git: '))
  }
})

test('runs git with the fixed safe prefix and a neutralised environment', async (t) => {
  const repo = tempDir(t)
  const { runner, calls } = recordingRunner()
  assert.equal(await repoGitCommand([repo, 'log', '--oneline', '-1'], runner), 0)
  assert.deepEqual(calls, [repoGitArguments(repo, 'log', ['--oneline', '-1'])])
  assert.deepEqual(calls[0], ['--no-pager', '-C', repo, '-c', 'core.fsmonitor=false', '-c', 'diff.external=', '-c', 'core.pager=cat', 'log', '--no-ext-diff', '--no-textconv', '--no-color', '--oneline', '-1'])
  const hostile = Object.fromEntries([...REPO_GIT_STRIPPED_ENV, 'GIT_CONFIG_KEY_0', 'GIT_CONFIG_VALUE_0', 'GIT_CONFIG_KEY_12', 'GIT_CONFIG_VALUE_12'].map((key) => [key, 'evil']))
  assert.equal(REPO_GIT_STRIPPED_ENV.length, 11)
  const env = repoGitEnv({ PATH: '/bin', HOME: '/h', GIT_AUTHOR_NAME: 'ana', GIT_TERMINAL_PROMPT: '1', ...hostile })
  assert.deepEqual(env, { PATH: '/bin', HOME: '/h', GIT_AUTHOR_NAME: 'ana', GIT_TERMINAL_PROMPT: '0' })
})

test('a hostile git environment cannot redirect the real run', async (t) => {
  const dir = realpathSync(tempDir(t))
  const repo = path.join(dir, 'repo')
  execFileSync('git', ['init', '-q', repo])
  writeFileSync(path.join(repo, 'a'), 'a\n')
  execFileSync('git', ['-C', repo, 'add', 'a'])
  execFileSync('git', ['-C', repo, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'real commit'])
  const marker = path.join(dir, 'pwned')
  const env = { ...process.env, GIT_DIR: path.join(dir, 'nowhere'), GIT_WORK_TREE: dir, GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'core.pager', GIT_CONFIG_VALUE_0: `touch ${marker}`, GIT_PAGER: `touch ${marker}`, GIT_EXTERNAL_DIFF: `touch ${marker}` }
  const result = await runCli(['repo-git', repo, 'log', '--oneline', '-1'], env)
  assert.equal(result.code, 0, result.stderr)
  assert.match(result.stdout, /real commit/)
  assert.ok(!existsSync(marker))
})

test('builds one allowlist rule per repo and subcommand, failing closed on unsafe characters', () => {
  assert.deepEqual(repoGitRules(SELF, ['/r']), ['Bash(/usr/local/bin/recap repo-git /r log:*)', 'Bash(/usr/local/bin/recap repo-git /r show:*)', 'Bash(/usr/local/bin/recap repo-git /r diff:*)'])
  assert.deepEqual(repoGitRules(SELF, ['/has space']), [])
  assert.deepEqual(repoGitRules(['/opt/my node/bin/node', '/x/recap.js'], ['/r']), [])
  assert.deepEqual(repoGitRules(SELF, ['/r;rm', '/r$(x)', '/r`x`', '/r*']), [])
  assert.deepEqual(repoGitRules([], ['/r']), [])
  assert.equal(repoGitRules(['/usr/bin/node', '/opt/recap/dist/bin/recap.js'], ['/src/a_b-c@1.0+x'])[0], 'Bash(/usr/bin/node /opt/recap/dist/bin/recap.js repo-git /src/a_b-c@1.0+x log:*)')
  const context = emptyContext({ repos: [{ path: '/has space', slug: 'x', exists: true }, { path: '/r', slug: 'r', exists: true }] })
  assert.deepEqual(allowedTools(context, SELF), ['Read', 'Grep', 'Glob', ...repoGitRules(SELF, ['/r'])])
})

test('the prompt tells Claude to use the wrapper', () => {
  const request: AskRequest = { meeting: meeting(), dir: '/tmp', question: '¿Qué cambió?', windowSeconds: 60, now: '2026-10-10T10:00:00Z', auto: false }
  const context = emptyContext({ repos: [{ path: '/src/codi', slug: 'codi', exists: true }, { path: '/src/con espacio', slug: 'esp', exists: true }] })
  const text = renderAskPrompt('{{git}}|{{repos}}', request, context, [], [], SELF)
  assert.equal(text, '/usr/local/bin/recap repo-git|  - codi: /src/codi (historial: `/usr/local/bin/recap repo-git /src/codi log|show|diff …`)\n  - esp: /src/con espacio (sin historial de git; solo Read, Grep y Glob)')
})

test('resolves itself to node plus the real entry script', () => {
  const [node, entry] = runningCommand()
  assert.equal(node, process.execPath)
  assert.equal(entry, realpathSync(BIN))
  assert.equal(recapEntry('file:///opt/recap/dist/live/repo-git.js'), '/opt/recap/dist/bin/recap.js')
})

function runCli(args: string[], env: NodeJS.ProcessEnv = process.env): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(process.execPath, [BIN, ...args], { env }, (error, stdout, stderr) => {
      const code = error && typeof error.code === 'number' ? error.code : 0
      resolve({ code, stdout, stderr })
    })
  })
}

test('runs against a real repository and blocks writes', async (t) => {
  const dir = realpathSync(tempDir(t))
  const repo = path.join(dir, 'repo')
  execFileSync('git', ['init', '-q', repo])
  writeFileSync(path.join(repo, 'README.md'), 'hola\n')
  execFileSync('git', ['-C', repo, 'add', 'README.md'])
  execFileSync('git', ['-C', repo, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'first commit'])
  writeFileSync(path.join(repo, 'README.md'), 'hola\nmundo\n')
  execFileSync('git', ['-C', repo, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qam', 'second commit'])
  const log = await runCli(['repo-git', repo, 'log', '--oneline', '-1'])
  assert.equal(log.code, 0, log.stderr)
  assert.match(log.stdout, /^[0-9a-f]+ second commit\n$/)
  const show = await runCli(['repo-git', repo, 'show', 'HEAD~1', '--stat'])
  assert.equal(show.code, 0, show.stderr)
  assert.ok(show.stdout.includes('first commit'))
  const diff = await runCli(['repo-git', repo, 'diff', 'HEAD~1', 'HEAD', '--', 'README.md'])
  assert.equal(diff.code, 0, diff.stderr)
  assert.ok(diff.stdout.includes('+mundo'))
  const target = path.join(dir, 'x')
  const blocked = await runCli(['repo-git', repo, 'diff', `--output=${target}`])
  assert.equal(blocked.code, 2)
  assert.equal(blocked.stderr, `recap repo-git: option not allowed: --output=${target}\n`)
  assert.ok(!existsSync(target))
  const failing = await runCli(['repo-git', repo, 'show', 'nope-not-a-rev'])
  assert.equal(failing.code, 128)
})
