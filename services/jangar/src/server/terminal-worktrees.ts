import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, rm } from 'node:fs/promises'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  LOCK_RETRY_ATTEMPTS,
  LOCK_RETRY_DELAY_MS,
  LOCK_STALE_MS,
  runGitWithLockRecovery,
} from '~/server/git-lock-recovery'
import { withWorktreeLock } from '~/server/git-worktree-lock'
import { type CommandOptions, runTerminalGit } from '~/server/terminal-command-runner'
import { resolveTerminalsConfig } from '~/server/terminals-config'

const terminalsConfig = resolveTerminalsConfig()
const SESSION_PREFIX = 'jangar-terminal-'
const WORKTREE_DIR_NAME = '.worktrees'
const DEFAULT_BASE_REF = terminalsConfig.baseRef
const FALLBACK_BASE_REF = 'main'
const FETCH_TIMEOUT_MS = 30_000
const WORKTREE_TIMEOUT_MS = terminalsConfig.worktreeTimeoutMs
const REUSE_REFRESH_TIMEOUT_MS = 15_000
const DEFER_WORKTREE_CHECKOUT = terminalsConfig.deferWorktreeCheckout
const MAIN_FETCH_ENABLED = terminalsConfig.mainFetchEnabled

export const terminalWorktreeMaxAttempts = 6

const resolveRepoRoot = () => resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')

export const resolveCodexBaseCwd = () => {
  const envCwd = terminalsConfig.codexCwdOverride
  if (envCwd) return envCwd
  return terminalsConfig.isProduction ? '/workspace/lab' : resolveRepoRoot()
}

const resolveWorktreeRoot = () => join(resolveCodexBaseCwd(), WORKTREE_DIR_NAME)

const runGitWithRecovery = async (
  args: string[],
  cwd: string,
  options: CommandOptions & { worktreeName?: string; worktreePath?: string },
) =>
  runGitWithLockRecovery((gitArgs, gitCwd) => runTerminalGit(gitArgs, gitCwd, options), args, cwd, {
    repoRoot: resolveCodexBaseCwd(),
    worktreeName: options.worktreeName ?? null,
    worktreePath: options.worktreePath ?? null,
    label: options.label,
    staleMs: LOCK_STALE_MS,
    attempts: LOCK_RETRY_ATTEMPTS,
    delayMs: LOCK_RETRY_DELAY_MS,
  })

export const buildTerminalWorktreeName = (suffix: string) => `codex-${suffix}`

export const buildTerminalSessionId = (worktreeName: string) => `${SESSION_PREFIX}${worktreeName}`

export const buildTerminalWorktreePath = (worktreeName: string) => join(resolveWorktreeRoot(), worktreeName)

export const queueTerminalWorktreeCheckout = (
  worktreePath: string,
  baseRef: string,
  sessionId?: string,
  worktreeName?: string | null,
) => {
  if (!DEFER_WORKTREE_CHECKOUT) return
  queueMicrotask(() => {
    void withWorktreeLock(async () => {
      const result = await runGitWithRecovery(['checkout', '--detach', '--force', baseRef], worktreePath, {
        timeoutMs: WORKTREE_TIMEOUT_MS,
        label: 'git checkout',
        worktreeName: worktreeName ?? undefined,
        worktreePath,
      })
      if (result.exitCode === 0) return
      console.warn('[terminals] deferred checkout failed', {
        sessionId,
        stderr: result.stderr.trim(),
      })
    })
  })
}

export const isCleanReusableTerminalWorktree = async (worktreePath: string) => {
  const inside = await runTerminalGit(['rev-parse', '--is-inside-work-tree'], worktreePath, {
    timeoutMs: FETCH_TIMEOUT_MS,
    label: 'git worktree probe',
  })
  if (inside.exitCode !== 0) return false

  const statusResult = await runTerminalGit(['status', '--porcelain'], worktreePath, {
    timeoutMs: FETCH_TIMEOUT_MS,
    label: 'git worktree status',
  })
  if (statusResult.exitCode !== 0) return false
  return statusResult.stdout.trim().length === 0
}

export const resolveTerminalBaseRef = async (repoRoot: string) => {
  const [primary, fallback] = await Promise.all([
    runTerminalGit(['rev-parse', '--verify', DEFAULT_BASE_REF], repoRoot, { timeoutMs: FETCH_TIMEOUT_MS }),
    runTerminalGit(['rev-parse', '--verify', FALLBACK_BASE_REF], repoRoot, { timeoutMs: FETCH_TIMEOUT_MS }),
  ])
  if (primary.exitCode === 0) return DEFAULT_BASE_REF
  if (fallback.exitCode === 0) return FALLBACK_BASE_REF

  if (!MAIN_FETCH_ENABLED) {
    throw new Error(`Unable to resolve base ref: ${DEFAULT_BASE_REF}`)
  }

  const fetchResult = await runTerminalGit(['fetch', '--all', '--prune'], repoRoot, {
    timeoutMs: FETCH_TIMEOUT_MS,
    label: 'git fetch',
  })
  if (fetchResult.exitCode !== 0) {
    throw new Error(fetchResult.stderr.trim() || 'Unable to fetch base ref')
  }

  const afterFetch = await runTerminalGit(['rev-parse', '--verify', DEFAULT_BASE_REF], repoRoot, {
    timeoutMs: FETCH_TIMEOUT_MS,
  })
  if (afterFetch.exitCode === 0) return DEFAULT_BASE_REF

  const fallbackAfter = await runTerminalGit(['rev-parse', '--verify', FALLBACK_BASE_REF], repoRoot, {
    timeoutMs: FETCH_TIMEOUT_MS,
  })
  if (fallbackAfter.exitCode === 0) return FALLBACK_BASE_REF

  throw new Error(`Unable to resolve base ref: ${DEFAULT_BASE_REF}`)
}

export const createTerminalWorktreeAtPath = async (
  worktreeName: string,
  worktreePath: string,
  baseRef: string,
  repoRoot: string,
) =>
  withWorktreeLock(async () => {
    const args = ['worktree', 'add', '--detach', '--force']
    if (DEFER_WORKTREE_CHECKOUT) {
      args.push('--no-checkout')
    }
    args.push(worktreePath, baseRef)
    const result = await runGitWithRecovery(args, repoRoot, {
      timeoutMs: WORKTREE_TIMEOUT_MS,
      label: 'git worktree add',
      worktreeName,
      worktreePath,
    })
    if (result.exitCode !== 0) {
      const detail = [result.stdout.trim(), result.stderr.trim()].filter(Boolean).join('\n')
      await runGitWithRecovery(['worktree', 'remove', '--force', worktreePath], repoRoot, {
        timeoutMs: WORKTREE_TIMEOUT_MS,
        label: 'git worktree remove',
        worktreeName,
        worktreePath,
      }).catch(() => {})
      await rm(worktreePath, { recursive: true, force: true }).catch(() => {})
      throw new Error(detail || 'Unable to create worktree')
    }

    await runTerminalGit(['config', 'user.name', 'Jangar Terminal'], worktreePath)
    await runTerminalGit(['config', 'user.email', 'terminal@jangar.local'], worktreePath)

    return { worktreeName, worktreePath }
  })

export const createFreshTerminalWorktree = async () => {
  const repoRoot = resolveCodexBaseCwd()
  const baseRef = await resolveTerminalBaseRef(repoRoot)
  await mkdir(resolveWorktreeRoot(), { recursive: true })

  for (let attempt = 0; attempt < terminalWorktreeMaxAttempts; attempt += 1) {
    const suffix = randomUUID().slice(0, 8)
    const worktreeName = buildTerminalWorktreeName(suffix)
    const worktreePath = buildTerminalWorktreePath(worktreeName)
    if (existsSync(worktreePath)) continue
    try {
      await createTerminalWorktreeAtPath(worktreeName, worktreePath, baseRef, repoRoot)
      return { worktreeName, worktreePath, baseRef }
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      console.warn('[terminals] worktree create failed', { worktreeName, detail })
    }
  }

  throw new Error('Unable to allocate a new terminal worktree.')
}

export const isSafeTerminalWorktreePath = (worktreePath: string, worktreeName: string | null) => {
  if (!worktreeName) return false
  const root = resolveWorktreeRoot()
  const rel = relative(root, worktreePath)
  if (!rel || rel.startsWith('..') || rel.includes('..') || rel.includes(`..${sep}`)) return false
  return rel === worktreeName
}

export const refreshTerminalWorktree = async (
  worktreePath: string,
  baseRef: string,
  worktreeName: string,
  sessionId: string,
) => {
  if (DEFER_WORKTREE_CHECKOUT) return
  const refreshResult = await withWorktreeLock(() =>
    runGitWithRecovery(['checkout', '--detach', '--force', baseRef], worktreePath, {
      timeoutMs: REUSE_REFRESH_TIMEOUT_MS,
      label: 'git checkout',
      worktreeName,
      worktreePath,
    }),
  )
  if (refreshResult.exitCode === 0) return
  console.warn('[terminals] worktree refresh failed', {
    sessionId,
    stderr: refreshResult.stderr.trim(),
  })
}

export const removeTerminalWorktree = async (worktreePath: string, worktreeName: string | null, sessionId: string) => {
  if (!isSafeTerminalWorktreePath(worktreePath, worktreeName)) return
  const repoRoot = resolveCodexBaseCwd()
  const removeResult = await runTerminalGit(['worktree', 'remove', '--force', worktreePath], repoRoot, {
    timeoutMs: WORKTREE_TIMEOUT_MS,
    label: 'git worktree remove',
  })
  if (removeResult.exitCode === 0) return
  console.warn('[terminals] git worktree remove failed', {
    sessionId,
    stderr: removeResult.stderr.trim(),
  })
  await rm(worktreePath, { recursive: true, force: true })
}
