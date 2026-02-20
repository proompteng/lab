import { spawnSync } from 'node:child_process'
import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { __test__ } from '~/server/bumba'

type BunSpawnOptions = Parameters<typeof Bun.spawn>[1]
type BunSpawnResult = ReturnType<typeof Bun.spawn>

const runGit = (args: string[], cwd: string) => {
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

describe('bumba worktree refresh', () => {
  const previousEnv: Partial<
    Record<'BUMBA_WORKSPACE_ROOT' | 'JANGAR_BUMBA_TASK_QUEUE' | 'TEMPORAL_TASK_QUEUE', string | undefined>
  > = {}
  let hadBun = false
  let repoRoot: string | null = null

  beforeEach(async () => {
    hadBun = 'Bun' in globalThis
    previousEnv.BUMBA_WORKSPACE_ROOT = process.env.BUMBA_WORKSPACE_ROOT
    previousEnv.JANGAR_BUMBA_TASK_QUEUE = process.env.JANGAR_BUMBA_TASK_QUEUE
    previousEnv.TEMPORAL_TASK_QUEUE = process.env.TEMPORAL_TASK_QUEUE
    repoRoot = await mkdtemp(join(tmpdir(), 'bumba-worktree-'))

    runGit(['init'], repoRoot)
    runGit(['config', 'user.email', 'bumba@example.com'], repoRoot)
    runGit(['config', 'user.name', 'Bumba Test'], repoRoot)
    runGit(['config', 'commit.gpgsign', 'false'], repoRoot)

    process.env.BUMBA_WORKSPACE_ROOT = repoRoot

    const spawnStub = ((rawArgs: unknown, options?: BunSpawnOptions) => {
      const baseOptions =
        rawArgs && typeof rawArgs === 'object' && 'cmd' in rawArgs
          ? (rawArgs as BunSpawnOptions & { cmd?: string[] | string })
          : undefined
      const resolvedOptions = { ...baseOptions, ...options }
      const rawCmd = baseOptions?.cmd ?? rawArgs
      const command = Array.isArray(rawCmd) ? rawCmd : typeof rawCmd === 'string' ? [rawCmd] : []
      const result = spawnSync(command[0] ?? '', command.slice(1), {
        cwd: resolvedOptions.cwd,
        env: resolvedOptions.env as NodeJS.ProcessEnv | undefined,
        encoding: null,
      })

      const stdoutData = result.stdout ?? new Uint8Array()
      const stderrData = result.stderr ?? new Uint8Array()
      const stdout = Readable.toWeb(Readable.from([stdoutData])) as unknown as ReadableStream<Uint8Array>
      const stderr = Readable.toWeb(Readable.from([stderrData])) as unknown as ReadableStream<Uint8Array>
      const exited = Promise.resolve(result.status ?? 1)

      return { stdout, stderr, exited } as BunSpawnResult
    }) as typeof Bun.spawn

    if (!hadBun) {
      globalThis.Bun = { ...(globalThis.Bun ?? ({} as typeof Bun)), spawn: spawnStub }
    }
  })

  afterEach(async () => {
    if (repoRoot) {
      await rm(repoRoot, { recursive: true, force: true })
      repoRoot = null
    }

    if (previousEnv.BUMBA_WORKSPACE_ROOT === undefined) {
      delete process.env.BUMBA_WORKSPACE_ROOT
    } else {
      process.env.BUMBA_WORKSPACE_ROOT = previousEnv.BUMBA_WORKSPACE_ROOT
    }
    if (previousEnv.JANGAR_BUMBA_TASK_QUEUE === undefined) {
      delete process.env.JANGAR_BUMBA_TASK_QUEUE
    } else {
      process.env.JANGAR_BUMBA_TASK_QUEUE = previousEnv.JANGAR_BUMBA_TASK_QUEUE
    }
    if (previousEnv.TEMPORAL_TASK_QUEUE === undefined) {
      delete process.env.TEMPORAL_TASK_QUEUE
    } else {
      process.env.TEMPORAL_TASK_QUEUE = previousEnv.TEMPORAL_TASK_QUEUE
    }

    if (!hadBun) {
      delete (globalThis as Record<string, unknown>).Bun
    }
  })

  it('refreshes the worktree to HEAD when the file is missing', async () => {
    if (!repoRoot) throw new Error('repoRoot missing')

    await writeFile(join(repoRoot, 'README.md'), 'hello')
    commitAll(repoRoot, 'init')

    const worktreePath = join(repoRoot, '.worktrees', 'bumba')
    runGit(['worktree', 'add', '--detach', worktreePath, 'HEAD'], repoRoot)

    const filePath = 'services/bumba/src/workflows/index.test.ts'
    await mkdir(join(repoRoot, 'services/bumba/src/workflows'), { recursive: true })
    await writeFile(join(repoRoot, filePath), 'test')
    commitAll(repoRoot, 'add file')

    const resolvedRoot = await __test__.resolveRepoRootForCommit(filePath)

    expect(resolvedRoot).toBe(worktreePath)
    await expect(stat(join(worktreePath, filePath))).resolves.toBeDefined()
  }, 20_000)

  it('throws when the file is still missing after refresh', async () => {
    if (!repoRoot) throw new Error('repoRoot missing')

    await writeFile(join(repoRoot, 'README.md'), 'hello')
    commitAll(repoRoot, 'init')

    const filePath = 'services/bumba/src/workflows/index.test.ts'

    await expect(__test__.resolveRepoRootForCommit(filePath)).rejects.toThrow(
      `File not found in worktree after refresh: ${filePath}`,
    )
  })

  it('refreshes the worktree to the requested commit', async () => {
    if (!repoRoot) throw new Error('repoRoot missing')

    await writeFile(join(repoRoot, 'README.md'), 'hello')
    commitAll(repoRoot, 'init')

    const worktreePath = join(repoRoot, '.worktrees', 'bumba')
    runGit(['worktree', 'add', '--detach', worktreePath, 'HEAD'], repoRoot)

    const filePath = 'services/bumba/src/workflows/index.test.ts'
    await mkdir(join(repoRoot, 'services/bumba/src/workflows'), { recursive: true })
    await writeFile(join(repoRoot, filePath), 'test')
    const commitWithFile = commitAll(repoRoot, 'add file')

    const resolvedRoot = await __test__.resolveRepoRootForCommit(filePath, commitWithFile)

    expect(resolvedRoot).toBe(worktreePath)
    await expect(stat(join(worktreePath, filePath))).resolves.toBeDefined()
  }, 20_000)

  it('prefers JANGAR_BUMBA_TASK_QUEUE over TEMPORAL_TASK_QUEUE', () => {
    process.env.TEMPORAL_TASK_QUEUE = 'legacy-queue'
    process.env.JANGAR_BUMBA_TASK_QUEUE = 'jangar-queue'

    expect(__test__.resolveTaskQueue()).toBe('jangar-queue')
  })

  it('falls back to TEMPORAL_TASK_QUEUE when JANGAR_BUMBA_TASK_QUEUE is missing', () => {
    delete process.env.JANGAR_BUMBA_TASK_QUEUE
    process.env.TEMPORAL_TASK_QUEUE = 'legacy-queue'

    expect(__test__.resolveTaskQueue()).toBe('legacy-queue')
  })
})
