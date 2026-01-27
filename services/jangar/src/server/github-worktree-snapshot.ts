import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, stat } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import {
  LOCK_RETRY_ATTEMPTS,
  LOCK_RETRY_DELAY_MS,
  LOCK_STALE_MS,
  PR_LOCK_STALE_MS,
  runGitWithLockRecovery,
} from '~/server/git-lock-recovery'
import { withWorktreeLock } from '~/server/git-worktree-lock'
import { createGithubReviewStore, type GithubPrFile } from '~/server/github-review-store'

const WORKTREE_DIR_NAME = '.worktrees'

const resolveRepoRoot = () => process.env.CODEX_CWD?.trim() || process.cwd()

const resolveWorktreeRoot = () => join(resolveRepoRoot(), WORKTREE_DIR_NAME)

const slugify = (value: string) =>
  value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')

const buildWorktreeName = (repository: string, prNumber: number) => {
  const [owner, repo] = repository.split('/')
  return `pr-${slugify(owner ?? 'repo')}-${slugify(repo ?? 'unknown')}-${prNumber}`
}

type GitResult = { exitCode: number; stdout: string; stderr: string }

const runGit = async (args: string[], cwd: string): Promise<GitResult> =>
  new Promise((resolvePromise) => {
    const child = spawn('git', args, { cwd })
    let stdout = ''
    let stderr = ''

    child.stdout?.on('data', (chunk) => {
      stdout += chunk.toString()
    })
    child.stderr?.on('data', (chunk) => {
      stderr += chunk.toString()
    })
    child.on('error', (error) => {
      resolvePromise({ exitCode: 1, stdout: '', stderr: error.message })
    })
    child.on('close', (code) => {
      resolvePromise({ exitCode: code ?? 1, stdout, stderr })
    })
  })

const ensureGitAvailable = async (repoRoot: string) => {
  const result = await runGit(['--version'], repoRoot)
  if (result.exitCode !== 0) {
    throw new Error(`git not available: ${result.stderr.trim() || result.stdout.trim()}`)
  }
}

const ensureRepoRoot = async (repoRoot: string) => {
  const stats = await stat(repoRoot).catch(() => null)
  if (!stats?.isDirectory()) {
    throw new Error(`CODEX_CWD does not exist or is not a directory: ${repoRoot}`)
  }
  const gitDir = await stat(join(repoRoot, '.git')).catch(() => null)
  if (!gitDir) {
    throw new Error(`Missing .git directory under ${repoRoot}`)
  }
}

const resolveRef = async (repoRoot: string, ref: string) => {
  const candidates = [ref, `origin/${ref}`].filter((value) => value)
  for (const candidate of candidates) {
    const result = await runGit(['rev-parse', '--verify', candidate], repoRoot)
    if (result.exitCode === 0) return candidate
  }
  throw new Error(`Unable to resolve git ref: ${ref}`)
}

const ensureWorktreePath = async (worktreeRoot: string, worktreeName: string) => {
  await mkdir(worktreeRoot, { recursive: true })
  const worktreePath = join(worktreeRoot, worktreeName)
  const resolvedRoot = resolve(worktreeRoot)
  const resolvedPath = resolve(worktreePath)
  if (!resolvedPath.startsWith(resolvedRoot)) {
    throw new Error(`Invalid worktree path: ${worktreePath}`)
  }

  if (existsSync(worktreePath)) {
    const stats = await stat(worktreePath).catch(() => null)
    if (!stats?.isDirectory()) {
      throw new Error(`Worktree path exists but is not a directory: ${worktreePath}`)
    }
    return { worktreePath, exists: true }
  }

  return { worktreePath, exists: false }
}

const checkoutWorktree = async (
  repoRoot: string,
  worktreeName: string,
  worktreePath: string,
  headRef: string,
  exists: boolean,
) => {
  const lockOptions = {
    repoRoot,
    worktreeName,
    worktreePath,
    label: worktreeName,
    staleMs: worktreeName.startsWith('pr-') ? PR_LOCK_STALE_MS : LOCK_STALE_MS,
    attempts: LOCK_RETRY_ATTEMPTS,
    delayMs: LOCK_RETRY_DELAY_MS,
  }
  if (!exists) {
    const addResult = await runGitWithLockRecovery(
      (args, cwd) => runGit(args, cwd),
      ['worktree', 'add', '--detach', worktreePath, headRef],
      repoRoot,
      lockOptions,
    )
    if (addResult.exitCode !== 0) {
      throw new Error(`git worktree add failed: ${addResult.stderr.trim() || addResult.stdout.trim()}`)
    }
  }

  const checkoutResult = await runGitWithLockRecovery(
    (args, cwd) => runGit(args, cwd),
    ['checkout', '--detach', '--force', headRef],
    worktreePath,
    lockOptions,
  )
  if (checkoutResult.exitCode !== 0) {
    throw new Error(`git checkout failed: ${checkoutResult.stderr.trim() || checkoutResult.stdout.trim()}`)
  }

  const resetResult = await runGitWithLockRecovery(
    (args, cwd) => runGit(args, cwd),
    ['reset', '--hard', headRef],
    worktreePath,
    lockOptions,
  )
  if (resetResult.exitCode !== 0) {
    throw new Error(`git reset failed: ${resetResult.stderr.trim() || resetResult.stdout.trim()}`)
  }
}

const parseDiffStatus = (line: string) => {
  const parts = line
    .split('\t')
    .map((entry) => entry.trim())
    .filter(Boolean)
  if (parts.length < 2) return null
  const statusRaw = parts[0] ?? ''
  const code = statusRaw[0] ?? ''
  if (code === 'R' && parts.length >= 3) {
    return { status: statusRaw, path: parts[2], previous: parts[1] }
  }
  return { status: statusRaw, path: parts[1], previous: null }
}

const mapStatus = (statusRaw: string) => {
  const code = statusRaw[0]?.toUpperCase()
  switch (code) {
    case 'A':
      return 'added'
    case 'M':
      return 'modified'
    case 'D':
      return 'deleted'
    case 'R':
      return 'renamed'
    case 'C':
      return 'copied'
    default:
      return statusRaw.toLowerCase() || null
  }
}

const parseNumstat = (line: string) => {
  const [addRaw, delRaw] = line.split('\t')
  const additions = Number.parseInt(addRaw ?? '', 10)
  const deletions = Number.parseInt(delRaw ?? '', 10)
  return {
    additions: Number.isFinite(additions) ? additions : null,
    deletions: Number.isFinite(deletions) ? deletions : null,
  }
}

export type WorktreeSnapshotResult = {
  repository: string
  prNumber: number
  commitSha: string
  baseSha: string
  worktreeName: string
  worktreePath: string
  fileCount: number
}

export const refreshWorktreeSnapshot = async (input: {
  repository: string
  prNumber: number
  headRef: string
  baseRef: string
}): Promise<WorktreeSnapshotResult> => {
  return withWorktreeLock(async () => {
    const repoRoot = resolveRepoRoot()
    await ensureRepoRoot(repoRoot)
    await ensureGitAvailable(repoRoot)

    const worktreeName = buildWorktreeName(input.repository, input.prNumber)
    const worktreeRoot = resolveWorktreeRoot()
    const { worktreePath, exists } = await ensureWorktreePath(worktreeRoot, worktreeName)

    const fetchResult = await runGit(['fetch', '--all', '--prune'], repoRoot)
    if (fetchResult.exitCode !== 0) {
      throw new Error(`git fetch failed: ${fetchResult.stderr.trim() || fetchResult.stdout.trim()}`)
    }

    const headRef = await resolveRef(repoRoot, input.headRef)
    const baseRef = await resolveRef(repoRoot, input.baseRef)

    await checkoutWorktree(repoRoot, worktreeName, worktreePath, headRef, exists)

    const headShaResult = await runGit(['rev-parse', 'HEAD'], worktreePath)
    if (headShaResult.exitCode !== 0) {
      throw new Error(`git rev-parse HEAD failed: ${headShaResult.stderr.trim() || headShaResult.stdout.trim()}`)
    }
    const headSha = headShaResult.stdout.trim()

    const baseShaResult = await runGit(['rev-parse', baseRef], worktreePath)
    if (baseShaResult.exitCode !== 0) {
      throw new Error(`git rev-parse base failed: ${baseShaResult.stderr.trim() || baseShaResult.stdout.trim()}`)
    }
    const baseSha = baseShaResult.stdout.trim()

    const diffResult = await runGit(['diff', '--name-status', '-M', `${baseSha}..${headSha}`], worktreePath)
    if (diffResult.exitCode !== 0) {
      throw new Error(`git diff --name-status failed: ${diffResult.stderr.trim() || diffResult.stdout.trim()}`)
    }

    const files: GithubPrFile[] = []
    for (const rawLine of diffResult.stdout.split('\n')) {
      const parsed = parseDiffStatus(rawLine)
      if (!parsed?.path) continue

      const numstat = await runGit(['diff', '--numstat', `${baseSha}..${headSha}`, '--', parsed.path], worktreePath)
      const [numstatLine] = numstat.stdout.split('\n')
      const counts = numstatLine ? parseNumstat(numstatLine) : { additions: null, deletions: null }

      const patchResult = await runGit(['diff', '-U3', `${baseSha}..${headSha}`, '--', parsed.path], worktreePath)
      const patch = patchResult.exitCode === 0 ? patchResult.stdout : null
      const changes =
        counts.additions !== null && counts.deletions !== null ? counts.additions + counts.deletions : null

      files.push({
        path: parsed.path,
        status: mapStatus(parsed.status),
        additions: counts.additions,
        deletions: counts.deletions,
        changes,
        patch,
        blobUrl: null,
        rawUrl: null,
        sha: null,
        previousFilename: parsed.previous,
      })
    }

    const store = createGithubReviewStore()
    const receivedAt = new Date().toISOString()
    try {
      await store.replacePrFiles({
        repository: input.repository,
        prNumber: input.prNumber,
        commitSha: headSha,
        receivedAt,
        source: 'worktree',
        files,
      })

      await store.upsertPrWorktree({
        repository: input.repository,
        prNumber: input.prNumber,
        worktreeName,
        worktreePath,
        baseSha,
        headSha,
        lastRefreshedAt: receivedAt,
      })
    } finally {
      await store.close()
    }

    return {
      repository: input.repository,
      prNumber: input.prNumber,
      commitSha: headSha,
      baseSha,
      worktreeName,
      worktreePath,
      fileCount: files.length,
    }
  })
}
