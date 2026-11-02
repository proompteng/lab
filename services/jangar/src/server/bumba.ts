import { buildAtlasReconciliationWorkflowId } from '@proompteng/bumba/atlas/reconciliation'
import {
  createTemporalClient,
  loadTemporalConfig,
  type TemporalClient,
  WorkflowIdReusePolicy,
} from '@proompteng/temporal-bun-sdk'
import { Context, Effect, Layer, pipe } from 'effect'

import { resolveBumbaRuntimeConfig } from './runtime-tooling-config'

const DEFAULT_TEMPORAL_HOST = 'temporal-frontend.temporal.svc.cluster.local'
const DEFAULT_TEMPORAL_PORT = 7233
const DEFAULT_TEMPORAL_ADDRESS = `${DEFAULT_TEMPORAL_HOST}:${DEFAULT_TEMPORAL_PORT}`
const DEFAULT_TASK_QUEUE = 'bumba'
const DEFAULT_BUMBA_WORKER_REPO_ROOT = '/workspace/lab'
const AUTO_UPGRADE_VERSIONING_BEHAVIOR = 2 as const

export type StartAtlasReconciliationInput = {
  repository?: string
  ref?: string
  commit?: string | null
  eventDeliveryId?: string
}

export type StartAtlasReconciliationResult = {
  workflowId: string
  runId: string
  taskQueue: string
  repoRoot: string
}

export type BumbaWorkflowsService = {
  startAtlasReconciliation: (
    input: StartAtlasReconciliationInput,
  ) => Effect.Effect<StartAtlasReconciliationResult, Error>
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
  const candidate = normalizeOptionalText(value) ?? resolveBumbaRuntimeConfig(process.env).repositoryHint
  if (!candidate) return undefined
  return normalizeRepositorySlug(candidate)
}

const resolveTaskQueue = () =>
  normalizeOptionalText(resolveBumbaRuntimeConfig(process.env).taskQueue) ?? DEFAULT_TASK_QUEUE

const resolveBumbaWorkerRepoRoot = () =>
  normalizeOptionalText(process.env.BUMBA_WORKER_REPO_ROOT) ?? DEFAULT_BUMBA_WORKER_REPO_ROOT

const resolveAtlasReconciliationStart = (input: StartAtlasReconciliationInput) => {
  const ref = normalizeOptionalText(input.ref) ?? 'main'
  if (ref !== 'main') {
    throw new Error(`Atlas reconciles only main; received ${ref}`)
  }

  const repository = resolveRepositorySlug(input.repository)
  if (!repository) {
    throw new Error('repository is required for Atlas reconciliation')
  }

  const workflowId = buildAtlasReconciliationWorkflowId(repository)
  const taskQueue = resolveTaskQueue()
  const repoRoot = resolveBumbaWorkerRepoRoot()

  return {
    repoRoot,
    taskQueue,
    workflow: {
      workflowId,
      workflowType: 'reconcileAtlasRepository',
      taskQueue,
      workflowIdReusePolicy: WorkflowIdReusePolicy.ALLOW_DUPLICATE,
      versioningBehavior: AUTO_UPGRADE_VERSIONING_BEHAVIOR,
      args: [
        {
          repoRoot,
          repository,
          ref,
          commit: input.commit ?? undefined,
          eventDeliveryId: input.eventDeliveryId ?? undefined,
        },
      ],
    },
  }
}

const normalizeError = (message: string, error: unknown) =>
  new Error(`${message}: ${error instanceof Error ? error.message : String(error)}`)

export const BumbaWorkflowsLive = Layer.scoped(
  BumbaWorkflows,
  Effect.gen(function* () {
    let clientPromise: Promise<TemporalClient> | null = null

    const getClient = () =>
      Effect.tryPromise({
        try: async () => {
          if (!clientPromise) {
            clientPromise = (async () => {
              const config = await loadTemporalConfig({
                defaults: {
                  host: DEFAULT_TEMPORAL_HOST,
                  port: DEFAULT_TEMPORAL_PORT,
                  address: DEFAULT_TEMPORAL_ADDRESS,
                  taskQueue: DEFAULT_TASK_QUEUE,
                },
              })
              return (await createTemporalClient({ config })).client
            })()
          }
          return await clientPromise
        },
        catch: (error) => normalizeError('temporal client unavailable', error),
      })

    yield* Effect.addFinalizer(() => {
      const pendingClient = clientPromise
      if (!pendingClient) return Effect.void
      return Effect.tryPromise({
        try: async () => (await pendingClient).shutdown(),
        catch: () => undefined,
      }).pipe(Effect.catchAll(() => Effect.void))
    })

    return {
      startAtlasReconciliation: (input) =>
        pipe(
          getClient(),
          Effect.flatMap((client) =>
            Effect.tryPromise({
              try: async () => {
                const start = resolveAtlasReconciliationStart(input)
                const result = await client.workflow.start(start.workflow)
                return {
                  workflowId: result.workflowId,
                  runId: result.runId,
                  taskQueue: start.taskQueue,
                  repoRoot: start.repoRoot,
                }
              },
              catch: (error) => normalizeError('start Atlas reconciliation failed', error),
            }),
          ),
        ),
    } satisfies BumbaWorkflowsService
  }),
)

export const __test__ = {
  resolveAtlasReconciliationStart,
  resolveTaskQueue,
}
