import { randomUUID } from 'node:crypto'
import { mkdir, rm, stat } from 'node:fs/promises'
import { relative, resolve, sep } from 'node:path'
import { createTemporalClient, type TemporalClient } from '@proompteng/temporal-bun-sdk/client'
import { loadTemporalConfig } from '@proompteng/temporal-bun-sdk/config'
import { VersioningBehavior } from '@proompteng/temporal-bun-sdk/worker'
import { Context, Effect, Layer, pipe } from 'effect'
import * as TSemaphore from 'effect/TSemaphore'

const DEFAULT_TEMPORAL_HOST = 'temporal-frontend.temporal.svc.cluster.local'
const DEFAULT_TEMPORAL_PORT = 7233
const DEFAULT_TEMPORAL_ADDRESS = `${DEFAULT_TEMPORAL_HOST}:${DEFAULT_TEMPORAL_PORT}`
const DEFAULT_TASK_QUEUE = 'bumba'
const WORKTREE_DIR_NAME = '.worktrees'
const BUMBA_WORKTREE_NAME = 'bumba'

export type StartEnrichFileInput = {
  filePath: string
  commit?: string | null
  ref?: string
  context?: string
  repository?: string
  workflowId?: string
  eventDeliveryId?: string
  force?: boolean
  validationMode?: 'full' | 'fast'
}

export type StartEnrichFileResult = {
  workflowId: string
  runId: string
  taskQueue: string
  repoRoot: string
  filePath: string
}

export type StartEnrichRepositoryInput = {
  repository?: string
  ref?: string
  commit?: string | null
  context?: string
  pathPrefix?: string | null
  maxFiles?: number | null
  workflowId?: string
  eventDeliveryId?: string
}

export type StartEnrichRepositoryResult = {
  workflowId: string
  runId: string
  taskQueue: string
  repoRoot: string
}

export type BumbaWorkflowsService = {
  startEnrichFile: (input: StartEnrichFileInput) => Effect.Effect<StartEnrichFileResult, Error>
  startEnrichRepository: (input: StartEnrichRepositoryInput) => Effect.Effect<StartEnrichRepositoryResult, Error>
}

export class BumbaWorkflows extends Context.Tag('BumbaWorkflows')<BumbaWorkflows, BumbaWorkflowsService>() {}

const normalizeOptionalText = (value: unknown) => {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : undefined
}

const normalizeRepositorySlug = (value: string) =>
  value
    .trim()
    .replace(/\.git$/, '')
    .replace(/^git@github\.com:/, '')
    .replace(/^ssh:\/\/git@github\.com\//, '')
    .replace(/^https?:\/\/(www\.)?github\.com\//, '')
    .replace(/^github\.com\//, '')

const resolveRepositorySlug = (value?: string) => {
  const candidate =
    normalizeOptionalText(value) ??
    normalizeOptionalText(process.env.CODEX_REPO_SLUG) ??
    normalizeOptionalText(process.env.REPOSITORY) ??
    normalizeOptionalText(process.env.CODEX_REPO_URL)
  if (!candidate) return undefined
  return normalizeRepositorySlug(candidate)
}

const resolveBaseRepoRoot = () =>
  normalizeOptionalText(process.env.BUMBA_WORKSPACE_ROOT) ??
  normalizeOptionalText(process.env.CODEX_CWD) ??
  normalizeOptionalText(process.env.VSCODE_DEFAULT_FOLDER) ??
  process.cwd()

const resolveWorktreePath = (baseRepoRoot: string) => resolve(baseRepoRoot, WORKTREE_DIR_NAME, BUMBA_WORKTREE_NAME)

const resolveWorktreeFilePath = (worktreePath: string, filePath: string) => {
  const fullPath = resolve(worktreePath, filePath)
  const relativePath = relative(worktreePath, fullPath)
  if (relativePath.startsWith('..') || relativePath.includes(`..${sep}`)) {
    throw new Error(`File path escapes worktree: ${filePath}`)
  }
  return fullPath
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

const extractLockPath = (message: string) => {
  const match = message.match(/Unable to create '([^']+\\.lock)'/i)
  return match?.[1]
}

const runGitCommandOrThrow = async (args: string[], cwd: string) => {
  const result = await runGitCommand(args, cwd)
  if (result.exitCode === 0) return result.stdout

  const lockPath = extractLockPath(result.stderr)
  if (lockPath) {
    await rm(lockPath, { force: true })
    const retry = await runGitCommand(args, cwd)
    if (retry.exitCode === 0) return retry.stdout
    const retryDetail = [retry.stderr, retry.stdout].filter(Boolean).join(' | ')
    throw new Error(retryDetail.length > 0 ? retryDetail : 'git command failed')
  }

  const detail = [result.stderr, result.stdout].filter(Boolean).join(' | ')
  throw new Error(detail.length > 0 ? detail : 'git command failed')
}

const ensureBumbaWorktree = async (baseRepoRoot: string) => {
  const worktreePath = resolveWorktreePath(baseRepoRoot)
  const worktreeRoot = resolve(baseRepoRoot, WORKTREE_DIR_NAME)

  await mkdir(worktreeRoot, { recursive: true })

  const existing = await stat(worktreePath).catch(() => null)
  if (existing) {
    if (!existing.isDirectory()) {
      throw new Error(`Worktree path exists but is not a directory: ${worktreePath}`)
    }
    return worktreePath
  }

  try {
    await runGitCommandOrThrow(
      ['git', '-C', baseRepoRoot, 'worktree', 'add', '--detach', worktreePath, 'HEAD'],
      baseRepoRoot,
    )
  } catch (error) {
    const after = await stat(worktreePath).catch(() => null)
    if (after?.isDirectory()) return worktreePath
    throw error
  }

  return worktreePath
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

const getHeadCommit = async (repoRoot: string) =>
  runGitCommandOrThrow(['git', '-C', repoRoot, 'rev-parse', 'HEAD'], repoRoot)

const resolveRepoRootForCommit = async (filePath: string, commit?: string | null) => {
  const baseRepoRoot = resolveBaseRepoRoot()
  const normalizedCommit = normalizeOptionalText(commit)
  const worktreePath = await ensureBumbaWorktree(baseRepoRoot)

  const ensureCommit = async (targetCommit: string) => {
    try {
      await resetWorktree(worktreePath, targetCommit)
    } catch {
      await fetchRepo(baseRepoRoot)
      await resetWorktree(worktreePath, targetCommit)
    }
  }

  const fullPath = resolveWorktreeFilePath(worktreePath, filePath)

  if (!normalizedCommit) {
    const existing = await stat(fullPath).catch(() => null)
    if (existing) return worktreePath

    const headCommit = await getHeadCommit(baseRepoRoot)
    await ensureCommit(headCommit)

    const refreshed = await stat(fullPath).catch(() => null)
    if (!refreshed) {
      throw new Error(`File not found in worktree after refresh: ${filePath}`)
    }

    return worktreePath
  }

  if (!(await commitExists(baseRepoRoot, normalizedCommit))) {
    await fetchRepo(baseRepoRoot)
    if (!(await commitExists(baseRepoRoot, normalizedCommit))) {
      throw new Error(`Commit not found after fetch: ${normalizedCommit}`)
    }
  }

  await ensureCommit(normalizedCommit)

  const exists = await stat(fullPath).catch(() => null)
  if (exists) return worktreePath

  await fetchRepo(baseRepoRoot)
  await ensureCommit(normalizedCommit)

  const refreshed = await stat(fullPath).catch(() => null)
  if (!refreshed) {
    throw new Error(`File not found in worktree after refresh: ${filePath}`)
  }

  return worktreePath
}

const resolveRepoRootFast = async (filePath: string) => {
  const baseRepoRoot = resolveBaseRepoRoot()
  const worktreePath = await ensureBumbaWorktree(baseRepoRoot)
  resolveWorktreeFilePath(worktreePath, filePath)
  return worktreePath
}

const resolveRepoRootForStart = async (input: StartEnrichFileInput) => {
  if (input.validationMode === 'fast') {
    return resolveRepoRootFast(input.filePath)
  }
  return resolveRepoRootForCommit(input.filePath, input.commit)
}

const resolveRepoRootForRepository = async (commit?: string | null) => {
  const baseRepoRoot = resolveBaseRepoRoot()
  const normalizedCommit = normalizeOptionalText(commit)
  const worktreePath = await ensureBumbaWorktree(baseRepoRoot)

  if (!normalizedCommit) {
    return worktreePath
  }

  if (!(await commitExists(baseRepoRoot, normalizedCommit))) {
    await fetchRepo(baseRepoRoot)
    if (!(await commitExists(baseRepoRoot, normalizedCommit))) {
      throw new Error(`Commit not found after fetch: ${normalizedCommit}`)
    }
  }

  try {
    await resetWorktree(worktreePath, normalizedCommit)
  } catch {
    await fetchRepo(baseRepoRoot)
    await resetWorktree(worktreePath, normalizedCommit)
  }

  return worktreePath
}

const buildWorkflowId = (filePath: string, commit?: string | null) => {
  const normalizedFile = filePath.replace(/[^a-zA-Z0-9_.-]+/g, '-')
  const normalizedCommit = normalizeOptionalText(commit)
  const base = normalizedCommit ? `${normalizedCommit}-${normalizedFile}` : normalizedFile
  return `bumba-${base}-${randomUUID()}`
}

const buildRepositoryWorkflowId = (repository?: string, ref?: string, commit?: string | null) => {
  const normalizedRepository = normalizeOptionalText(repository)?.replace(/[^a-zA-Z0-9_.-]+/g, '-') ?? 'repository'
  const normalizedRef = normalizeOptionalText(ref)?.replace(/[^a-zA-Z0-9_.-]+/g, '-') ?? 'ref'
  const normalizedCommit = normalizeOptionalText(commit)
  const base = normalizedCommit
    ? `${normalizedCommit}-${normalizedRepository}`
    : `${normalizedRepository}-${normalizedRef}`
  return `bumba-repo-${base}-${randomUUID()}`
}

const resolveTaskQueue = () =>
  normalizeOptionalText(process.env.JANGAR_BUMBA_TASK_QUEUE) ??
  normalizeOptionalText(process.env.TEMPORAL_TASK_QUEUE) ??
  DEFAULT_TASK_QUEUE

const normalizeError = (message: string, error: unknown) =>
  new Error(`${message}: ${error instanceof Error ? error.message : String(error)}`)

export const BumbaWorkflowsLive = Layer.scoped(
  BumbaWorkflows,
  Effect.gen(function* () {
    let clientPromise: Promise<TemporalClient> | null = null
    const gitSemaphore = TSemaphore.unsafeMake(1)

    const createClient = async () => {
      const config = await loadTemporalConfig({
        defaults: {
          host: DEFAULT_TEMPORAL_HOST,
          port: DEFAULT_TEMPORAL_PORT,
          address: DEFAULT_TEMPORAL_ADDRESS,
          taskQueue: DEFAULT_TASK_QUEUE,
        },
      })
      const { client } = await createTemporalClient({ config })
      return client
    }

    const getClient = () =>
      Effect.tryPromise({
        try: () => {
          if (!clientPromise) {
            clientPromise = createClient()
          }
          return clientPromise
        },
        catch: (error) => normalizeError('temporal client unavailable', error),
      })

    yield* Effect.addFinalizer(() => {
      const pendingClient = clientPromise
      if (!pendingClient) return Effect.void
      return Effect.tryPromise({
        try: async () => {
          const client = await pendingClient
          await client.shutdown()
        },
        catch: () => undefined,
      }).pipe(Effect.catchAll(() => Effect.void))
    })

    const service: BumbaWorkflowsService = {
      startEnrichFile: (input) =>
        pipe(
          getClient(),
          Effect.flatMap((client) =>
            pipe(
              TSemaphore.withPermits(
                gitSemaphore,
                1,
              )(
                Effect.tryPromise({
                  try: () => resolveRepoRootForStart(input),
                  catch: (error) => normalizeError('start bumba workflow failed', error),
                }),
              ),
              Effect.flatMap((repoRoot) =>
                Effect.tryPromise({
                  try: async () => {
                    const workflowId = input.workflowId ?? buildWorkflowId(input.filePath, input.commit)
                    const repository = resolveRepositorySlug(input.repository)
                    const taskQueue = resolveTaskQueue()

                    const startResult = await client.workflow.start({
                      workflowId,
                      workflowType: 'enrichFile',
                      taskQueue,
                      versioningBehavior: VersioningBehavior.AUTO_UPGRADE,
                      args: [
                        {
                          repoRoot,
                          filePath: input.filePath,
                          context: input.context ?? '',
                          repository,
                          ref: input.ref,
                          commit: input.commit ?? undefined,
                          eventDeliveryId: input.eventDeliveryId,
                          force: input.force ?? false,
                        },
                      ],
                    })

                    return {
                      workflowId: startResult.workflowId,
                      runId: startResult.runId,
                      taskQueue,
                      repoRoot,
                      filePath: input.filePath,
                    }
                  },
                  catch: (error) => normalizeError('start bumba workflow failed', error),
                }),
              ),
            ),
          ),
        ),
      startEnrichRepository: (input) =>
        pipe(
          getClient(),
          Effect.flatMap((client) =>
            pipe(
              TSemaphore.withPermits(
                gitSemaphore,
                1,
              )(
                Effect.tryPromise({
                  try: () => resolveRepoRootForRepository(input.commit),
                  catch: (error) => normalizeError('start bumba workflow failed', error),
                }),
              ),
              Effect.flatMap((repoRoot) =>
                Effect.tryPromise({
                  try: async () => {
                    const workflowId =
                      input.workflowId ?? buildRepositoryWorkflowId(input.repository, input.ref, input.commit)
                    const repository = resolveRepositorySlug(input.repository)
                    const taskQueue = resolveTaskQueue()

                    const startResult = await client.workflow.start({
                      workflowId,
                      workflowType: 'enrichRepository',
                      taskQueue,
                      versioningBehavior: VersioningBehavior.AUTO_UPGRADE,
                      args: [
                        {
                          repoRoot,
                          repository,
                          ref: input.ref,
                          commit: input.commit ?? undefined,
                          context: input.context ?? '',
                          eventDeliveryId: input.eventDeliveryId ?? undefined,
                          pathPrefix: input.pathPrefix ?? undefined,
                          maxFiles: input.maxFiles ?? undefined,
                        },
                      ],
                    })

                    return {
                      workflowId: startResult.workflowId,
                      runId: startResult.runId,
                      taskQueue,
                      repoRoot,
                    }
                  },
                  catch: (error) => normalizeError('start bumba workflow failed', error),
                }),
              ),
            ),
          ),
        ),
    }

    return service
  }),
)

export const __test__ = {
  resolveRepoRootForCommit,
  resolveTaskQueue,
}
