import { spawnSync } from 'node:child_process'
import { mkdtemp, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { refreshWorktreeSnapshot } from '~/server/github-worktree-snapshot'

vi.mock('~/server/github-review-store', () => {
  const replacePrFiles = vi.fn(async () => {})
  const upsertPrWorktree = vi.fn(async () => {})
  const close = vi.fn(async () => {})
  return {
    createGithubReviewStore: () => ({ replacePrFiles, upsertPrWorktree, close }),
  }
})

type GitRun = (args: string[], cwd: string) => string

const runGit: GitRun = (args, cwd) => {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' })
  if (result.status !== 0) {
    const detail = [result.stderr, result.stdout].filter(Boolean).join(' | ')
    throw new Error(`git ${args.join(' ')} failed: ${detail}`)
  }
  return result.stdout.trim()
}

const commitAll = (cwd: string, message: string) => {
  runGit(['add', '.'], cwd)
  runGit(['commit', '-m', message], cwd)
  return runGit(['rev-parse', 'HEAD'], cwd)
}

describe('github worktree snapshot', () => {
  let repoRoot: string | null = null
  const previousEnv: Partial<Record<'CODEX_CWD', string | undefined>> = {}

  beforeEach(async () => {
    previousEnv.CODEX_CWD = process.env.CODEX_CWD
    repoRoot = await mkdtemp(join(tmpdir(), 'jangar-github-worktree-'))

    runGit(['init'], repoRoot)
    runGit(['config', 'user.email', 'jangar@example.com'], repoRoot)
    runGit(['config', 'user.name', 'Jangar Test'], repoRoot)
    runGit(['config', 'commit.gpgsign', 'false'], repoRoot)

    process.env.CODEX_CWD = repoRoot

    await writeFile(join(repoRoot, 'README.md'), 'hello')
    commitAll(repoRoot, 'init')
  })

  afterEach(async () => {
    if (repoRoot) {
      await rm(repoRoot, { recursive: true, force: true })
      repoRoot = null
    }

    if (previousEnv.CODEX_CWD === undefined) {
      delete process.env.CODEX_CWD
    } else {
      process.env.CODEX_CWD = previousEnv.CODEX_CWD
    }
  })

  it('recovers from stale index.lock during worktree checkout', async () => {
    if (!repoRoot) throw new Error('repoRoot missing')

    const worktreeName = 'pr-acme-lab-2311'
    const worktreePath = join(repoRoot, '.worktrees', worktreeName)

    runGit(['worktree', 'add', '--detach', worktreePath, 'HEAD'], repoRoot)

    const lockPath = join(repoRoot, '.git', 'worktrees', worktreeName, 'index.lock')
    await writeFile(lockPath, 'lock')

    const stale = new Date(Date.now() - 5 * 60 * 1000)
    await utimes(lockPath, stale, stale)

    await expect(
      refreshWorktreeSnapshot({
        repository: 'acme/lab',
        prNumber: 2311,
        headRef: 'HEAD',
        baseRef: 'HEAD',
      }),
    ).resolves.toMatchObject({
      worktreeName,
      worktreePath,
    })
  })
})
