import { realpathSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { isDirectory } from '../core/fsutil.ts'

export const REPO_GIT_COMMAND = 'repo-git'
export const REPO_GIT_SUBCOMMANDS = ['log', 'show', 'diff'] as const
export const REPO_GIT_TIMEOUT_MS = 30_000
export const REPO_GIT_FIXED_FLAGS = ['--no-ext-diff', '--no-textconv', '--no-color']

export type RepoGitSubcommand = (typeof REPO_GIT_SUBCOMMANDS)[number]

const SAFE_WORD = /^[A-Za-z0-9_./+@-]+$/

const EXACT_OPTIONS = new Set([
  '-i',
  '--regexp-ignore-case',
  '--all-match',
  '--invert-grep',
  '--pickaxe-regex',
  '--no-merges',
  '--merges',
  '--first-parent',
  '--follow',
  '--all',
  '--branches',
  '--tags',
  '--remotes',
  '--oneline',
  '--pretty',
  '--abbrev-commit',
  '--no-abbrev-commit',
  '--decorate',
  '--no-decorate',
  '--graph',
  '--reverse',
  '--name-only',
  '--name-status',
  '--stat',
  '--shortstat',
  '--numstat',
  '--summary',
  '--raw',
  '-p',
  '-u',
  '--patch',
  '--no-patch',
  '-s',
  '-W',
  '--function-context',
  '--word-diff',
  '--color-words',
  '--ignore-all-space',
  '-w',
  '--ignore-space-change',
  '-b',
  '-M',
  '--find-renames',
  '-C',
  '--find-copies',
  '--no-renames',
  '--relative',
  '--cached',
  '--staged',
  '--merge-base',
  '--no-color',
  '--color=never',
])

const VALUE_OPTIONS = [
  '--max-count=',
  '--skip=',
  '--since=',
  '--after=',
  '--until=',
  '--before=',
  '--author=',
  '--committer=',
  '--grep=',
  '--format=',
  '--pretty=',
  '--date=',
  '--stat=',
  '--unified=',
  '--word-diff=',
  '--find-renames=',
  '--diff-filter=',
  '--relative=',
]

export type RepoGitValidation = { ok: true; repo: string; sub: RepoGitSubcommand; args: string[] } | { ok: false; reason: string }

function isSubcommand(value: string | undefined): value is RepoGitSubcommand {
  return (REPO_GIT_SUBCOMMANDS as readonly string[]).includes(value ?? '')
}

function escapesRepo(arg: string): boolean {
  return path.isAbsolute(arg) || arg.split(/[\\/]/).includes('..')
}

function optionAllowed(arg: string, sub: RepoGitSubcommand): boolean {
  if (EXACT_OPTIONS.has(arg)) return true
  if (VALUE_OPTIONS.some((prefix) => arg.startsWith(prefix))) return true
  if (/^-\d+$/.test(arg) || /^-n\d+$/.test(arg) || /^-U\d+$/.test(arg)) return true
  if (/^-[SGM]./.test(arg)) return true
  return sub === 'log' && /^-L./.test(arg)
}

export function validateRepoGitArgs(argv: readonly string[], directoryExists: (dir: string) => boolean = isDirectory): RepoGitValidation {
  const [repo, sub, ...rest] = argv
  if (repo === undefined || repo.length === 0) return { ok: false, reason: 'usage: recap repo-git <repo> <log|show|diff> [args...]' }
  if (!path.isAbsolute(repo)) return { ok: false, reason: `repository path must be absolute: ${repo}` }
  if (repo.includes('\0') || !directoryExists(repo)) return { ok: false, reason: `repository not found: ${repo}` }
  if (!isSubcommand(sub)) return { ok: false, reason: `subcommand not allowed: ${sub ?? '(none)'}` }
  const args: string[] = []
  let paths = false
  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index] ?? ''
    if (arg.includes('\0')) return { ok: false, reason: 'argument contains a NUL byte' }
    if (paths || !arg.startsWith('-')) {
      if (escapesRepo(arg)) return { ok: false, reason: `path outside the repository not allowed: ${arg}` }
      args.push(arg)
      continue
    }
    if (arg === '--') {
      paths = true
      args.push(arg)
      continue
    }
    if (arg === '-n') {
      const count = rest[index + 1]
      if (count === undefined || !/^\d+$/.test(count)) return { ok: false, reason: '-n needs a number' }
      args.push(arg, count)
      index += 1
      continue
    }
    if (!optionAllowed(arg, sub)) return { ok: false, reason: `option not allowed: ${arg}` }
    args.push(arg)
  }
  return { ok: true, repo, sub, args }
}

export const REPO_GIT_CONFIG = [
  'core.fsmonitor=false',
  'diff.external=',
  'core.pager=cat',
  'gpg.program=false',
  'gpg.ssh.program=false',
  'gpg.x509.program=false',
  'log.showSignature=false',
]

function configPrefix(repo: string): string[] {
  return ['--no-pager', '-C', repo, ...REPO_GIT_CONFIG.flatMap((setting) => ['-c', setting])]
}

export function repoGitArguments(repo: string, sub: RepoGitSubcommand, args: readonly string[]): string[] {
  return [...configPrefix(repo), sub, ...REPO_GIT_FIXED_FLAGS, ...args]
}

export function workTreeArguments(repo: string): string[] {
  return [...configPrefix(repo), 'rev-parse', '--is-inside-work-tree']
}

export const REPO_GIT_KEPT_ENV = ['PATH', 'HOME', 'USER', 'LOGNAME', 'TMPDIR', 'LANG', 'LC_ALL']
export const REPO_GIT_WINDOWS_ENV = ['SYSTEMROOT', 'COMSPEC', 'PATHEXT', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'TEMP', 'TMP']

function keptKey(key: string, platform: NodeJS.Platform): boolean {
  const name = platform === 'win32' ? key.toUpperCase() : key
  if (REPO_GIT_KEPT_ENV.includes(name) || name.startsWith('LC_')) return true
  return platform === 'win32' && REPO_GIT_WINDOWS_ENV.includes(name)
}

export function repoGitEnv(env: NodeJS.ProcessEnv, platform: NodeJS.Platform = process.platform): NodeJS.ProcessEnv {
  const clean: NodeJS.ProcessEnv = {}
  for (const [key, value] of Object.entries(env)) if (value !== undefined && keptKey(key, platform)) clean[key] = value
  clean['GIT_TERMINAL_PROMPT'] = '0'
  clean['GIT_CONFIG_NOSYSTEM'] = '1'
  return clean
}

export function isSafeWord(value: string): boolean {
  return SAFE_WORD.test(value)
}

function realpathOr(file: string): string {
  try {
    return realpathSync(file)
  } catch {
    return file
  }
}

export function recapEntry(moduleUrl: string = import.meta.url): string {
  const extension = moduleUrl.endsWith('.ts') ? '.ts' : '.js'
  return realpathOr(fileURLToPath(new URL(`../bin/recap${extension}`, moduleUrl)))
}

export function runningCommand(): string[] {
  return [process.execPath, recapEntry()]
}

export function repoGitPrefix(self: readonly string[]): string {
  return [...self, REPO_GIT_COMMAND].join(' ')
}

export function repoGitAllowed(self: readonly string[], repo: string): boolean {
  return self.length > 0 && self.every(isSafeWord) && isSafeWord(repo)
}

export function repoGitRules(self: readonly string[], repos: readonly string[]): string[] {
  return repos.filter((repo) => repoGitAllowed(self, repo)).flatMap((repo) => REPO_GIT_SUBCOMMANDS.map((sub) => `Bash(${repoGitPrefix(self)} ${repo} ${sub}:*)`))
}
