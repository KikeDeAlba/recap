import assert from 'node:assert/strict'
import { execFile, execFileSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'
import { exitCodeOf, repoGitCommand, type GitProbe, type GitRunner } from '../src/cli/commands/repo-git.ts'
import { GIT_USAGE, NO_GIT_HISTORY, allowedTools, renderAskPrompt, type AskRequest } from '../src/live/ask.ts'
import { emptyContext } from '../src/live/context.ts'
import { recapEntry, repoGitArguments, repoGitEnv, repoGitRules, runningCommand, validateRepoGitArgs, workTreeArguments } from '../src/live/repo-git.ts'
import { loadResource } from '../src/pipeline/resources.ts'
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
  [['/r', 'log', '-́x'], 'option not allowed: -́x'],
  [['/r', 'diff', '/́etc'], 'path outside the repository not allowed: /́etc'],
]

const PREFIX = ['-c', 'core.fsmonitor=false', '-c', 'diff.external=', '-c', 'core.pager=cat', '-c', 'gpg.program=false', '-c', 'gpg.ssh.program=false', '-c', 'gpg.x509.program=false', '-c', 'log.showSignature=false']

function recordingRunner(): { runner: GitRunner; calls: string[][] } {
  const calls: string[][] = []
  return { calls, runner: async (args) => (calls.push(args), 0) }
}

function recordingProbe(result: { code: number; stdout: string } = { code: 0, stdout: 'true\n' }): { probe: GitProbe; calls: string[][] } {
  const calls: string[][] = []
  return { calls, probe: async (args) => (calls.push(args), result) }
}

function commitRepo(dir: string): string {
  const repo = path.join(dir, 'repo')
  execFileSync('git', ['init', '-q', repo])
  writeFileSync(path.join(repo, 'a'), 'a\n')
  execFileSync('git', ['-C', repo, 'add', 'a'])
  execFileSync('git', ['-C', repo, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'real commit'])
  return repo
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
  const probe = recordingProbe()
  assert.equal(await repoGitCommand([repo, 'log', '--oneline', '-1'], runner, () => {}, probe.probe), 0)
  assert.deepEqual(probe.calls, [['--no-pager', '-C', repo, ...PREFIX, 'rev-parse', '--is-inside-work-tree']])
  assert.deepEqual(probe.calls[0], workTreeArguments(repo))
  assert.deepEqual(calls, [repoGitArguments(repo, 'log', ['--oneline', '-1'])])
  assert.deepEqual(calls[0], ['--no-pager', '-C', repo, ...PREFIX, 'log', '--no-ext-diff', '--no-textconv', '--no-color', '--oneline', '-1'])
})

test('passes only the allowlisted environment to git', () => {
  const kept = { PATH: '/bin', HOME: '/h', USER: 'u', LOGNAME: 'u', TMPDIR: '/t', LANG: 'es_MX.UTF-8', LC_ALL: 'C', LC_CTYPE: 'UTF-8', LC_MESSAGES: 'C' }
  const names = ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_CONFIG_PARAMETERS', 'GIT_CONFIG_COUNT', 'GIT_CONFIG_KEY_0', 'GIT_TRACE', 'GIT_TRACE2_EVENT', 'GIT_COMMON_DIR', 'GIT_ATTR_SOURCE', 'GIT_NAMESPACE', 'GIT_AUTHOR_NAME', 'GIT_EXEC_PATH', 'NODE_OPTIONS', 'SYSTEMROOT', 'LCX']
  const hostile = Object.fromEntries(names.map((key) => [key, 'evil']))
  assert.deepEqual(repoGitEnv({ ...kept, ...hostile, GIT_TERMINAL_PROMPT: '1', GIT_CONFIG_NOSYSTEM: '0' }, 'darwin'), { ...kept, GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_NOSYSTEM: '1' })
  const windows = { Path: 'C:\\bin', SystemRoot: 'C:\\Windows', COMSPEC: 'cmd', PATHEXT: '.EXE', USERPROFILE: 'u', APPDATA: 'a', LOCALAPPDATA: 'l', TEMP: 't', TMP: 't' }
  assert.deepEqual(repoGitEnv({ ...windows, GIT_TRACE: '1' }, 'win32'), { ...windows, GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_NOSYSTEM: '1' })
})

test('refuses a directory that is not a work tree before running git', async (t) => {
  const repo = tempDir(t)
  const { runner, calls } = recordingRunner()
  let error = ''
  assert.equal(await repoGitCommand([repo, 'log'], runner, (text) => (error += text), recordingProbe({ code: 128, stdout: '' }).probe), 2)
  assert.equal(await repoGitCommand([repo, 'log'], runner, () => {}, recordingProbe({ code: 0, stdout: 'false\n' }).probe), 2)
  assert.equal(calls.length, 0)
  assert.equal(error, `recap repo-git: not a git repository: ${repo}\n`)
  const real = await runCli(['repo-git', repo, 'log', '-1'])
  assert.equal(real.code, 2)
  assert.equal(real.stderr, `recap repo-git: not a git repository: ${repo}\n`)
})

test('reports a missing git with exit 127', async (t) => {
  const repo = tempDir(t)
  let error = ''
  assert.equal(await repoGitCommand([repo, 'log'], recordingRunner().runner, (text) => (error += text), recordingProbe({ code: 127, stdout: '' }).probe), 127)
  assert.equal(error, 'recap repo-git: git not found\n')
  const empty = path.join(repo, 'empty')
  mkdirSync(empty)
  const real = await runCli(['repo-git', repo, 'log'], { ...process.env, PATH: empty })
  assert.equal(real.code, 127)
  assert.equal(real.stderr, 'recap repo-git: git not found\n')
})

test('maps timeouts and foreign signals to shell exit codes', () => {
  assert.equal(exitCodeOf(0, null, false), 0)
  assert.equal(exitCodeOf(128, null, false), 128)
  assert.equal(exitCodeOf(null, 'SIGKILL', true), 124)
  assert.equal(exitCodeOf(null, 'SIGTERM', false), 143)
  assert.equal(exitCodeOf(null, 'SIGKILL', false), 137)
  assert.equal(exitCodeOf(null, 'SIGINT', false), 130)
})

test('ignores git configuration and tracing from the parent environment', async (t) => {
  const dir = realpathSync(tempDir(t))
  const repo = commitRepo(dir)
  const marker = path.join(dir, 'X')
  const trace = path.join(dir, 't')
  const env = { ...process.env, GIT_CONFIG_PARAMETERS: `'core.pager'='touch ${marker}'`, GIT_TRACE: trace }
  const result = await runCli(['repo-git', repo, 'log', '--oneline', '-1'], env)
  assert.equal(result.code, 0, result.stderr)
  assert.match(result.stdout, /real commit/)
  assert.ok(!existsSync(marker))
  assert.ok(!existsSync(trace))
})

test('reads signature status without running a signing program', async (t) => {
  const dir = realpathSync(tempDir(t))
  const repo = commitRepo(dir)
  const marker = path.join(dir, 'gpg-ran')
  const script = path.join(dir, 'fake-gpg')
  writeFileSync(script, `#!/bin/sh\ntouch '${marker}'\nexit 1\n`)
  chmodSync(script, 0o755)
  const tree = execFileSync('git', ['-C', repo, 'rev-parse', 'HEAD^{tree}'], { encoding: 'utf8' }).trim()
  const body = `tree ${tree}\nauthor t <t@t> 1700000000 +0000\ncommitter t <t@t> 1700000000 +0000\ngpgsig -----BEGIN PGP SIGNATURE-----\n \n iQEzBAABCAAdFiEE\n -----END PGP SIGNATURE-----\n\nsigned commit\n`
  const objectFile = path.join(dir, 'commit.txt')
  writeFileSync(objectFile, body)
  const sha = execFileSync('git', ['-C', repo, 'hash-object', '-t', 'commit', '-w', objectFile], { encoding: 'utf8' }).trim()
  execFileSync('git', ['-C', repo, 'update-ref', 'HEAD', sha])
  execFileSync('git', ['-C', repo, 'config', 'gpg.program', script])
  execFileSync('git', ['-C', repo, 'log', '--format=%G?', '-1'], { encoding: 'utf8' })
  assert.ok(existsSync(marker), 'control: plain git runs the configured signing program')
  rmSync(marker)
  const result = await runCli(['repo-git', repo, 'log', '--format=%G?', '-1'])
  assert.equal(result.code, 0, result.stderr)
  assert.match(result.stdout, /^[A-Z]\n$/)
  assert.ok(!existsSync(marker))
})

test('a hostile git environment cannot redirect the real run', async (t) => {
  const dir = realpathSync(tempDir(t))
  const repo = path.join(dir, 'repo')
  execFileSync('git', ['init', '-q', repo])
  writeFileSync(path.join(repo, 'a'), 'a\n')
  execFileSync('git', ['-C', repo, 'add', 'a'])
  execFileSync('git', ['-C', repo, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'real commit'])
  const marker = path.join(dir, 'pwned')
  const env = { ...process.env, GIT_CONFIG_PARAMETERS: `'core.pager'='touch ${marker}'`, GIT_DIR: path.join(dir, 'nowhere'), GIT_WORK_TREE: dir, GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'core.pager', GIT_CONFIG_VALUE_0: `touch ${marker}`, GIT_PAGER: `touch ${marker}`, GIT_EXTERNAL_DIFF: `touch ${marker}` }
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
  assert.equal(renderAskPrompt('{{gitUsage}}', request, context, [], [], SELF), GIT_USAGE.replaceAll('{{git}}', '/usr/local/bin/recap repo-git'))
  assert.ok(GIT_USAGE.includes('un comando por llamada, sin `cd`, sin `&&`, sin tuberías, sin `$( )`, sin comillas invertidas y sin redirecciones (`>`)'))
})

test('the prompt denies git history when no repository got a rule', () => {
  const request: AskRequest = { meeting: meeting(), dir: '/tmp', question: '¿Qué cambió?', windowSeconds: 60, now: '2026-10-10T10:00:00Z', auto: false }
  const cases: [ReturnType<typeof emptyContext>, string[]][] = [
    [emptyContext(), SELF],
    [emptyContext({ repos: [{ path: '/src/con espacio', slug: 'esp', exists: true }] }), SELF],
    [emptyContext({ repos: [{ path: '/src/codi', slug: 'codi', exists: true }] }), ['/opt/my node/node']],
  ]
  for (const [context, self] of cases) {
    const prompt = renderAskPrompt(loadResource('ask-prompt.md'), request, context, [], [], self)
    assert.deepEqual(allowedTools(context, self), ['Read', 'Grep', 'Glob'])
    assert.ok(prompt.includes(`Puedes leerlas con Read, Grep y Glob. ${NO_GIT_HISTORY}`))
    assert.ok(!prompt.includes('{{') && !prompt.includes('<ruta del repo>') && !prompt.includes('repo-git'))
  }
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
