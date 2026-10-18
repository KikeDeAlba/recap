import { spawn } from 'node:child_process'
import { REPO_GIT_TIMEOUT_MS, repoGitArguments, repoGitEnv, validateRepoGitArgs } from '../../live/repo-git.ts'

export type GitRunner = (args: string[], env: NodeJS.ProcessEnv) => Promise<number>

export const spawnGit: GitRunner = (args, env) =>
  new Promise((resolve) => {
    const child = spawn('git', args, { env, stdio: ['ignore', 'inherit', 'inherit'], timeout: REPO_GIT_TIMEOUT_MS, windowsHide: true })
    child.on('error', (error) => {
      process.stderr.write(`recap repo-git: ${error.message}\n`)
      resolve(1)
    })
    child.on('close', (code, signal) => resolve(code ?? (signal ? 124 : 1)))
  })

export async function repoGitCommand(argv: string[], runner: GitRunner = spawnGit, stderr: (text: string) => void = (text) => process.stderr.write(text)): Promise<number> {
  const result = validateRepoGitArgs(argv)
  if (!result.ok) {
    stderr(`recap repo-git: ${result.reason}\n`)
    return 2
  }
  return runner(repoGitArguments(result.repo, result.sub, result.args), repoGitEnv(process.env))
}
