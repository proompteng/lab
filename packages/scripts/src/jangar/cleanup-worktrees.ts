#!/usr/bin/env bun

import { existsSync } from 'node:fs'
import { readdir, rm, stat } from 'node:fs/promises'
import { join, resolve, sep } from 'node:path'
import { RedisClient } from 'bun'

import { repoRoot as defaultRepoRoot, fatal } from '../shared/cli'

type Options = {
  repoRoot: string
  dryRun: boolean
  removeCodexWorktrees: boolean
  removeTermWorktrees: boolean
  keep: string[]
  keepPrefix: string[]
}

const WORKTREE_DIR_NAME = '.worktrees'
const DEFAULT_REPO_ROOT =
  process.env.CODEX_CWD?.trim() ||
  process.env.BUMBA_WORKSPACE_ROOT?.trim() ||
  process.env.VSCODE_DEFAULT_FOLDER?.trim() ||
  defaultRepoRoot

const usage = () =>
  `
Usage:
  bun run packages/scripts/src/jangar/cleanup-worktrees.ts [options]

Options:
      --repo-root <path>        Repository root (default: $CODEX_CWD or ${DEFAULT_REPO_ROOT})
      --dry-run                 Print what would be removed
      --remove-codex-worktrees  Also remove Codex/Argo worktrees (codex/, codex-*, github-codex-*)
      --remove-term-worktrees   Also remove Jangar terminal worktrees (term-*)
      --keep <name>             Worktree top-level dir to keep (repeatable)
      --keep-prefix <prefix>    Worktree top-level dir prefix to keep (repeatable)
  -h, --help                    Show this help message

Notes:
  - Operates on <repo-root>/.worktrees/* (top-level entries).
  - Removes registered git worktrees under those paths, then deletes the directory.
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
    repoRoot: DEFAULT_REPO_ROOT,
    dryRun: false,
    removeCodexWorktrees: false,
    removeTermWorktrees: false,
    keep: [],
    keepPrefix: [],
  }

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (!arg) continue

    if (arg === '--help' || arg === '-h') {
      console.log(usage())
      process.exit(0)
    }

    if (arg === '--dry-run') {
      options.dryRun = true
      continue
    }

    if (arg === '--remove-codex-worktrees') {
      options.removeCodexWorktrees = true
      continue
    }

    if (arg === '--remove-term-worktrees') {
      options.removeTermWorktrees = true
      continue
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

    if (arg === '--keep') {
      options.keep.push(readValue(arg, argv, i))
      i += 1
      continue
    }

    if (arg.startsWith('--keep=')) {
      options.keep.push(arg.slice('--keep='.length))
      continue
    }

    if (arg === '--keep-prefix') {
      options.keepPrefix.push(readValue(arg, argv, i))
      i += 1
      continue
    }

    if (arg.startsWith('--keep-prefix=')) {
      options.keepPrefix.push(arg.slice('--keep-prefix='.length))
      continue
    }

    fatal(`Unknown option: ${arg}`)
  }

  return options
}

type GitWorktreeEntry = { path: string }

const readProcessText = async (stream: ReadableStream | null) => {
  if (!stream) return ''
  return new Response(stream).text()
}

const runGit = async (repoRoot: string, args: string[]) => {
  const proc = Bun.spawn(['git', ...args], { cwd: repoRoot, stdout: 'pipe', stderr: 'pipe' })
  const [stdout, stderr, exitCode] = await Promise.all([
    readProcessText(proc.stdout),
    readProcessText(proc.stderr),
    proc.exited,
  ])
  return { exitCode, stdout: stdout.trim(), stderr: stderr.trim() }
}

const listGitWorktrees = async (repoRoot: string): Promise<GitWorktreeEntry[]> => {
  const result = await runGit(repoRoot, ['worktree', 'list', '--porcelain'])
  if (result.exitCode !== 0) {
    const detail = [result.stderr, result.stdout].filter(Boolean).join(' | ')
    throw new Error(detail.length > 0 ? detail : 'git worktree list failed')
  }

  const entries: GitWorktreeEntry[] = []
  let currentPath: string | null = null
  for (const line of result.stdout.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    if (trimmed.startsWith('worktree ')) {
      if (currentPath) {
        entries.push({ path: currentPath })
      }
      currentPath = trimmed.slice('worktree '.length).trim()
    }
  }
  if (currentPath) {
    entries.push({ path: currentPath })
  }
  return entries
}

const tryLoadRedisReservedWorktrees = async (): Promise<Set<string>> => {
  const url = process.env.JANGAR_REDIS_URL?.trim()
  if (!url) return new Set()

  const prefix = (process.env.JANGAR_WORKTREE_KEY_PREFIX ?? 'openwebui:worktree').replace(/:+$/, '')
  const match = `${prefix}:*`
  const reserved = new Set<string>()

  const redis = new RedisClient(url)
  try {
    if (!redis.connected) {
      await redis.connect()
    }

    let cursor = '0'
    for (let loops = 0; loops < 500; loops += 1) {
      const scan = (await redis.scan(cursor, 'MATCH', match, 'COUNT', '200')) as unknown
      const parsed = Array.isArray(scan) ? scan : null
      const nextCursor = parsed?.[0]
      const keys = parsed?.[1]
      if (typeof nextCursor !== 'string' || !Array.isArray(keys)) {
        break
      }

      for (const key of keys) {
        if (typeof key !== 'string' || key.length === 0) continue
        const name = await redis.hget(key, 'name')
        if (typeof name === 'string' && name.trim().length > 0) {
          reserved.add(name.trim())
        }
      }

      cursor = nextCursor
      if (cursor === '0') {
        break
      }
    }
  } catch {
    return reserved
  } finally {
    try {
      if (redis.connected) redis.close()
    } catch {
      // ignore
    }
  }

  return reserved
}

const isUnder = (parent: string, candidate: string) => {
  const resolvedParent = resolve(parent)
  const resolvedCandidate = resolve(candidate)
  return resolvedCandidate === resolvedParent || resolvedCandidate.startsWith(`${resolvedParent}${sep}`)
}

const isReservedTopLevelName = (name: string, reservedExact: Set<string>, reservedPrefixes: string[]) => {
  if (reservedExact.has(name)) return true
  for (const prefix of reservedPrefixes) {
    if (prefix && name.startsWith(prefix)) return true
  }
  return false
}

const main = async () => {
  const options = parseArgs(Bun.argv.slice(2))
  const repoRoot = resolve(options.repoRoot)

  const repoStats = await stat(repoRoot).catch(() => null)
  if (!repoStats?.isDirectory()) {
    fatal(`Repo root not found or not a directory: ${repoRoot}`)
  }
  if (!existsSync(join(repoRoot, '.git'))) {
    fatal(`Repo root is missing .git: ${repoRoot}`)
  }

  const worktreeRoot = join(repoRoot, WORKTREE_DIR_NAME)
  const worktreeStats = await stat(worktreeRoot).catch(() => null)
  if (!worktreeStats?.isDirectory()) {
    console.log(`[cleanup-worktrees] no worktree root at ${worktreeRoot}`)
    return
  }

  const redisReserved = await tryLoadRedisReservedWorktrees()

  const reservedNames = new Set<string>([
    'bumba',
    ...(!options.removeCodexWorktrees ? ['codex'] : []),
    ...redisReserved,
    ...options.keep.map((value) => value.trim()).filter(Boolean),
  ])
  const reservedPrefixes = [
    ...(options.removeCodexWorktrees ? [] : ['codex-', 'github-codex-']),
    ...(options.removeTermWorktrees ? [] : ['term-']),
    'pr-',
    ...options.keepPrefix.map((value) => value.trim()).filter(Boolean),
  ]

  const dirents = await readdir(worktreeRoot, { withFileTypes: true })
  const topLevelDirs = dirents.filter((entry) => entry.isDirectory()).map((entry) => entry.name)

  const toRemove = topLevelDirs.filter((name) => !isReservedTopLevelName(name, reservedNames, reservedPrefixes))
  if (toRemove.length === 0) {
    console.log('[cleanup-worktrees] nothing to remove')
    return
  }

  const gitWorktrees = await listGitWorktrees(repoRoot)

  for (const name of toRemove) {
    const targetPath = resolve(worktreeRoot, name)
    if (!isUnder(worktreeRoot, targetPath)) {
      console.warn('[cleanup-worktrees] skip unsafe path', { name, targetPath })
      continue
    }

    const registered = gitWorktrees
      .map((entry) => resolve(entry.path))
      .filter((path) => isUnder(targetPath, path))
      .sort((a, b) => b.length - a.length)

    if (options.dryRun) {
      console.log(`[cleanup-worktrees] would remove ${name}`)
      for (const path of registered) {
        console.log(`  - git worktree remove -f ${path}`)
      }
      continue
    }

    for (const worktreePath of registered) {
      const result = await runGit(repoRoot, ['worktree', 'remove', '--force', worktreePath])
      if (result.exitCode !== 0) {
        const detail = [result.stderr, result.stdout].filter(Boolean).join(' | ')
        console.warn('[cleanup-worktrees] git worktree remove failed', { worktreePath, detail })
      }
    }

    await rm(targetPath, { recursive: true, force: true })
    console.log(`[cleanup-worktrees] removed ${name}`)
  }

  if (!options.dryRun) {
    await runGit(repoRoot, ['worktree', 'prune']).catch(() => undefined)
  }
}

main().catch((error) => fatal('Failed to cleanup worktrees', error))
