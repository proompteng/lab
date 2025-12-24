#!/usr/bin/env bun

import { existsSync } from 'node:fs'
import { mkdir, stat } from 'node:fs/promises'
import { resolve } from 'node:path'

import { repoRoot as defaultRepoRoot, fatal } from '../shared/cli'

const WORKTREE_DIR_NAME = '.worktrees'
const BUMBA_WORKTREE_NAME = 'bumba'

type Options = {
  repoRoot: string
  commit?: string
}

const usage = () =>
  `
Usage:
  bun run packages/scripts/src/bumba/ensure-worktree.ts [options]

Options:
      --repo-root <path>  Repository root (default: $BUMBA_WORKSPACE_ROOT or repo root)
      --commit <sha>      Checkout/reset worktree to a specific commit
  -h, --help             Show this help message
`.trim()

const readValue = (arg: string, argv: string[], index: number) => {
  const value = argv[index + 1]
  if (!value || value.startsWith('-')) {
    fatal(`${arg} requires a value`)
  }
  return value
}

const parseArgs = (argv: string[]): Options => {
  const options: Options = {
    repoRoot: process.env.BUMBA_WORKSPACE_ROOT?.trim() || defaultRepoRoot,
  }

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (!arg) continue

    if (arg === '--help' || arg === '-h') {
      console.log(usage())
      process.exit(0)
    }

    if (arg === '--repo-root') {
      options.repoRoot = readValue(arg, argv, i)
      i += 1
      continue
    }

    if (arg.startsWith('--repo-root=')) {
      options.repoRoot = arg.slice('--repo-root='.length)
      continue
    }

    if (arg === '--commit') {
      options.commit = readValue(arg, argv, i)
      i += 1
      continue
    }

    if (arg.startsWith('--commit=')) {
      options.commit = arg.slice('--commit='.length)
      continue
    }

    fatal(`Unknown option: ${arg}`)
  }

  return options
}

const runGitCommand = async (args: string[], cwd: string) => {
  const proc = Bun.spawn(args, { cwd, stdout: 'pipe', stderr: 'pipe' })
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  return {
    exitCode,
    stdout: stdout.trim(),
    stderr: stderr.trim(),
  }
}

const runGitCommandOrThrow = async (args: string[], cwd: string) => {
  const result = await runGitCommand(args, cwd)
  if (result.exitCode === 0) return result.stdout
  const detail = [result.stderr, result.stdout].filter(Boolean).join(' | ')
  throw new Error(detail.length > 0 ? detail : 'git command failed')
}

const commitExists = async (repoRoot: string, commit: string) => {
  const result = await runGitCommand(['git', '-C', repoRoot, 'rev-parse', '--verify', `${commit}^{commit}`], repoRoot)
  return result.exitCode === 0
}

const fetchRepo = async (repoRoot: string) => {
  await runGitCommandOrThrow(['git', '-C', repoRoot, 'fetch', '--all', '--tags', '--prune'], repoRoot)
}

const resetWorktree = async (worktreePath: string, commit: string) => {
  await runGitCommandOrThrow(['git', '-C', worktreePath, 'reset', '--hard', commit], worktreePath)
}

const ensureWorktree = async (repoRoot: string) => {
  const resolvedRoot = resolve(repoRoot)
  if (!existsSync(resolvedRoot)) {
    fatal(`Repo root not found: ${resolvedRoot}`)
  }

  const worktreeRoot = resolve(resolvedRoot, WORKTREE_DIR_NAME)
  const worktreePath = resolve(worktreeRoot, BUMBA_WORKTREE_NAME)
  await mkdir(worktreeRoot, { recursive: true })

  const existing = await stat(worktreePath).catch(() => null)
  if (existing) {
    if (!existing.isDirectory()) {
      throw new Error(`Worktree path exists but is not a directory: ${worktreePath}`)
    }
    return worktreePath
  }

  await runGitCommandOrThrow(
    ['git', '-C', resolvedRoot, 'worktree', 'add', '--detach', worktreePath, 'HEAD'],
    resolvedRoot,
  )

  return worktreePath
}

const ensureWorktreeCommit = async (repoRoot: string, worktreePath: string, commit?: string) => {
  if (!commit) return

  if (!(await commitExists(repoRoot, commit))) {
    await fetchRepo(repoRoot)
    if (!(await commitExists(repoRoot, commit))) {
      throw new Error(`Commit not found after fetch: ${commit}`)
    }
  }

  try {
    await resetWorktree(worktreePath, commit)
  } catch (_error) {
    await fetchRepo(repoRoot)
    await resetWorktree(worktreePath, commit)
  }
}

const main = async () => {
  const options = parseArgs(Bun.argv.slice(2))
  const worktreePath = await ensureWorktree(options.repoRoot)
  await ensureWorktreeCommit(options.repoRoot, worktreePath, options.commit)
  console.log(`[bumba] worktree ready at ${worktreePath}`)
}

main().catch((error) => {
  fatal(error instanceof Error ? error.message : String(error))
})
