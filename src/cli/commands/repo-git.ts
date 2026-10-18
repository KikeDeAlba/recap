import { spawn } from 'node:child_process'
import { constants } from 'node:os'
import { REPO_GIT_TIMEOUT_MS, repoGitArguments, repoGitEnv, validateRepoGitArgs, workTreeArguments } from '../../live/repo-git.ts'

export const WORK_TREE_TIMEOUT_MS = 10_000
export const GIT_NOT_FOUND = 127
export const GIT_TIMED_OUT = 124

export type GitRunner = (args: string[], env: NodeJS.ProcessEnv) => Promise<number>
export type GitProbe = (args: string[], env: NodeJS.ProcessEnv) => Promise<{ code: number; stdout: string }>

const notFound = (error: NodeJS.ErrnoException) => error.code === 'ENOENT'

export function exitCodeOf(code: number | null, signal: NodeJS.Signals | null, timedOut: boolean): number {
  if (timedOut) return GIT_TIMED_OUT
  if (code !== null) return code
  const number = signal ? constants.signals[signal] : undefined
  return number === undefined ? 1 : 128 + number
}

function runGit(args: string[], env: NodeJS.ProcessEnv, timeoutMs: number, capture: boolean): Promise<{ code: number; stdout: string; error?: NodeJS.ErrnoException }> {
  return new Promise((resolve) => {
    const child = spawn('git', args, { env, stdio: ['ignore', capture ? 'pipe' : 'inherit', capture ? 'ignore' : 'inherit'], windowsHide: true })
    let stdout = ''
    let timedOut = false
    let settled = false
    const finish = (result: { code: number; stdout: string; error?: NodeJS.ErrnoException }) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(result)
    }
    const timer = setTimeout(() => {
      timedOut = true
      child.kill('SIGKILL')
    }, timeoutMs)
    child.stdout?.on('data', (chunk: Buffer) => (stdout += chunk.toString('utf8')))
    child.on('error', (error) => finish({ code: notFound(error) ? GIT_NOT_FOUND : 1, stdout, error }))
    child.on('close', (code, signal) => finish({ code: exitCodeOf(code, signal, timedOut), stdout }))
  })
}

export const probeGit: GitProbe = async (args, env) => {
  const { code, stdout } = await runGit(args, env, WORK_TREE_TIMEOUT_MS, true)
  return { code, stdout }
}

export const spawnGit: GitRunner = async (args, env) => {
  const { code, error } = await runGit(args, env, REPO_GIT_TIMEOUT_MS, false)
  if (error) process.stderr.write(notFound(error) ? 'recap repo-git: git not found\n' : `recap repo-git: ${error.message}\n`)
  return code
}

export async function repoGitCommand(argv: string[], runner: GitRunner = spawnGit, stderr: (text: string) => void = (text) => process.stderr.write(text), probe: GitProbe = probeGit): Promise<number> {
  const result = validateRepoGitArgs(argv)
  if (!result.ok) {
    stderr(`recap repo-git: ${result.reason}\n`)
    return 2
  }
  const env = repoGitEnv(process.env)
  const workTree = await probe(workTreeArguments(result.repo), env)
  if (workTree.code === GIT_NOT_FOUND) {
    stderr('recap repo-git: git not found\n')
    return GIT_NOT_FOUND
  }
  if (workTree.code !== 0 || workTree.stdout.trim() !== 'true') {
    stderr(`recap repo-git: not a git repository: ${result.repo}\n`)
    return 2
  }
  return runner(repoGitArguments(result.repo, result.sub, result.args), env)
}
