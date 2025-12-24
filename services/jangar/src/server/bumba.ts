import { randomUUID } from 'node:crypto'
import { mkdir, stat } from 'node:fs/promises'
import { resolve } from 'node:path'
import { createTemporalClient, loadTemporalConfig, type TemporalClient } from '@proompteng/temporal-bun-sdk'
import { Context, Effect, Layer, pipe } from 'effect'

const DEFAULT_TEMPORAL_HOST = 'temporal-frontend.temporal.svc.cluster.local'
const DEFAULT_TEMPORAL_PORT = 7233
const DEFAULT_TEMPORAL_ADDRESS = `${DEFAULT_TEMPORAL_HOST}:${DEFAULT_TEMPORAL_PORT}`
const DEFAULT_TASK_QUEUE = 'bumba'
const WORKTREE_DIR_NAME = '.worktrees'
const BUMBA_WORKTREE_NAME = 'bumba'

export type StartEnrichFileInput = {
  filePath: string
  commit?: string | null
  context?: string
  workflowId?: string
}

export type StartEnrichFileResult = {
  workflowId: string
  runId: string
  taskQueue: string
  repoRoot: string
  filePath: string
}

export type BumbaWorkflowsService = {
  startEnrichFile: (input: StartEnrichFileInput) => Effect.Effect<StartEnrichFileResult, Error>
}

export class BumbaWorkflows extends Context.Tag('BumbaWorkflows')<BumbaWorkflows, BumbaWorkflowsService>() {}

const normalizeOptionalText = (value: unknown) => {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : undefined
}

const resolveBaseRepoRoot = () =>
  normalizeOptionalText(process.env.BUMBA_WORKSPACE_ROOT) ??
  normalizeOptionalText(process.env.CODEX_CWD) ??
  normalizeOptionalText(process.env.VSCODE_DEFAULT_FOLDER) ??
  process.cwd()

const resolveWorktreePath = (baseRepoRoot: string) => resolve(baseRepoRoot, WORKTREE_DIR_NAME, BUMBA_WORKTREE_NAME)

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

const resolveRepoRootForCommit = async (commit?: string | null) => {
  const baseRepoRoot = resolveBaseRepoRoot()
  const normalizedCommit = normalizeOptionalText(commit)
  const worktreePath = await ensureBumbaWorktree(baseRepoRoot)

  if (!normalizedCommit) return worktreePath

  if (!(await commitExists(baseRepoRoot, normalizedCommit))) {
    await fetchRepo(baseRepoRoot)
    if (!(await commitExists(baseRepoRoot, normalizedCommit))) {
      throw new Error(`Commit not found after fetch: ${normalizedCommit}`)
    }
  }

  try {
    await resetWorktree(worktreePath, normalizedCommit)
  } catch (_error) {
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

const resolveTaskQueue = () => normalizeOptionalText(process.env.TEMPORAL_TASK_QUEUE) ?? DEFAULT_TASK_QUEUE

const normalizeError = (message: string, error: unknown) =>
  new Error(`${message}: ${error instanceof Error ? error.message : String(error)}`)

export const BumbaWorkflowsLive = Layer.scoped(
  BumbaWorkflows,
  Effect.gen(function* () {
    let clientPromise: Promise<TemporalClient> | null = null

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
      if (!clientPromise) return Effect.void
      return Effect.tryPromise({
        try: async () => {
          const client = await clientPromise
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
            Effect.tryPromise({
              try: async () => {
                const repoRoot = await resolveRepoRootForCommit(input.commit)
                const workflowId = input.workflowId ?? buildWorkflowId(input.filePath, input.commit)
                const taskQueue = resolveTaskQueue()

                const startResult = await client.workflow.start({
                  workflowId,
                  workflowType: 'enrichFile',
                  taskQueue,
                  args: [
                    {
                      repoRoot,
                      filePath: input.filePath,
                      context: input.context ?? '',
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
    }

    return service
  }),
)
