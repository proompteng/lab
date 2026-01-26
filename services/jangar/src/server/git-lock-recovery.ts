import { readFile, stat, unlink } from 'node:fs/promises'
import { join, resolve } from 'node:path'

export type GitResult = { exitCode: number; stdout: string; stderr: string }

const parsePositiveInt = (value: string | undefined, fallback: number) => {
  const parsed = Number.parseInt(value ?? '', 10)
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback
  return parsed
}

export const LOCK_STALE_MS = parsePositiveInt(process.env.JANGAR_GIT_LOCK_STALE_MS, 2 * 60 * 1000)
export const PR_LOCK_STALE_MS = parsePositiveInt(process.env.JANGAR_GIT_PR_LOCK_STALE_MS, LOCK_STALE_MS)
export const LOCK_RETRY_ATTEMPTS = parsePositiveInt(process.env.JANGAR_GIT_LOCK_RETRY_ATTEMPTS, 3)
export const LOCK_RETRY_DELAY_MS = parsePositiveInt(process.env.JANGAR_GIT_LOCK_RETRY_DELAY_MS, 750)

const sleep = (ms: number) => new Promise((resolvePromise) => setTimeout(resolvePromise, ms))

const resolveGitDirFromWorktree = async (worktreePath: string | null | undefined) => {
  if (!worktreePath) return null
  const gitPath = join(worktreePath, '.git')
  const stats = await stat(gitPath).catch(() => null)
  if (!stats) return null
  if (stats.isDirectory()) return gitPath
  const contents = await readFile(gitPath, 'utf8').catch(() => null)
  if (!contents) return null
  const match = contents.match(/^gitdir:\s*(.+)\s*$/m)
  if (!match) return null
  return resolve(worktreePath, match[1] ?? '')
}

export const resolveIndexLockPaths = async (
  repoRoot: string,
  worktreeName: string | null | undefined,
  worktreePath: string | null | undefined,
) => {
  const paths = new Set<string>()
  paths.add(join(repoRoot, '.git', 'index.lock'))
  if (worktreeName) {
    paths.add(join(repoRoot, '.git', 'worktrees', worktreeName, 'index.lock'))
  }
  const gitDir = await resolveGitDirFromWorktree(worktreePath ?? null)
  if (gitDir) {
    paths.add(join(gitDir, 'index.lock'))
  }
  return Array.from(paths)
}

export const cleanupIndexLocks = async (paths: string[], label: string, staleMs: number) => {
  let removed = false
  let blockedByFreshLock = false
  const now = Date.now()

  for (const lockPath of paths) {
    const lockStat = await stat(lockPath).catch(() => null)
    if (!lockStat) continue
    const ageMs = now - lockStat.mtimeMs
    if (ageMs < staleMs) {
      blockedByFreshLock = true
      continue
    }
    await unlink(lockPath).catch((error) => {
      console.warn('[git-lock] failed to remove stale index.lock', {
        label,
        lockPath,
        error: String(error),
      })
    })
    removed = true
    console.warn('[git-lock] removed stale index.lock', { label, lockPath, ageMs })
  }

  return { removed, blockedByFreshLock }
}

export const shouldRetryForIndexLock = (result: GitResult) => {
  const output = `${result.stderr}\n${result.stdout}`
  return (
    output.includes('index.lock') ||
    output.includes('Could not write new index file') ||
    output.includes('another git process seems to be running') ||
    output.includes('Unable to create') ||
    output.includes('could not write index')
  )
}

export const runGitWithLockRecovery = async (
  runGit: (args: string[], cwd: string) => Promise<GitResult>,
  args: string[],
  cwd: string,
  options: {
    repoRoot: string
    worktreeName?: string | null
    worktreePath?: string | null
    label?: string
    attempts?: number
    staleMs?: number
    delayMs?: number
  },
) => {
  const attempts = options.attempts ?? LOCK_RETRY_ATTEMPTS
  const staleMs = options.staleMs ?? LOCK_STALE_MS
  const delayMs = options.delayMs ?? LOCK_RETRY_DELAY_MS
  let lastResult: GitResult | null = null
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const result = await runGit(args, cwd)
    if (result.exitCode === 0) return result
    lastResult = result
    if (!shouldRetryForIndexLock(result)) break

    const lockPaths = await resolveIndexLockPaths(options.repoRoot, options.worktreeName, options.worktreePath)
    const cleanup = await cleanupIndexLocks(lockPaths, options.label ?? args.join(' '), staleMs)
    if (!cleanup.removed && cleanup.blockedByFreshLock) {
      await sleep(delayMs)
      continue
    }
    if (cleanup.removed) {
      continue
    }
    break
  }
  return lastResult ?? { exitCode: 1, stdout: '', stderr: 'git command failed' }
}
