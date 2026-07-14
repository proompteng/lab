import { createTemporalClient, type TemporalClient, temporalCallOptions } from '../client'
import type { TemporalConfig } from '../config'
import { RoutingConfigUpdateState } from '../proto/temporal/api/enums/v1/task_queue_pb'

const DEFAULT_ALIGNMENT_TIMEOUT_MS = 120_000
const DEFAULT_POLL_INTERVAL_MS = 1_000
const DEFAULT_RPC_TIMEOUT_MS = 5_000

type DeploymentClient = Pick<
  TemporalClient['deployments'],
  'describeWorkerDeployment' | 'setWorkerDeploymentCurrentVersion'
>

export type WorkerRoutingAlignmentOptions = {
  deployments?: DeploymentClient
  now?: () => number
  sleep?: (milliseconds: number) => Promise<void>
  timeoutMs?: number
  pollIntervalMs?: number
  rpcTimeoutMs?: number
  identity?: string
}

export type WorkerRoutingAlignment = {
  deploymentName: string
  previousBuildId: string | null
  buildId: string
  changed: boolean
}

const normalizeOptionalText = (value: unknown) => {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : undefined
}

const parsePositiveInt = (value: string | undefined, fallback: number) => {
  const parsed = Number.parseInt(value ?? '', 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}

export const resolveWorkerDeploymentName = (temporalConfig: TemporalConfig) => {
  const taskQueue = normalizeOptionalText(temporalConfig.taskQueue)
  if (!taskQueue) {
    throw new Error('Temporal task queue is required for worker deployment routing')
  }

  return (
    normalizeOptionalText(process.env.TEMPORAL_WORKER_DEPLOYMENT_NAME) ??
    normalizeOptionalText(temporalConfig.workerDeploymentName) ??
    `${taskQueue}-deployment`
  )
}

export const extractCurrentDeploymentBuildId = (
  response: Awaited<ReturnType<DeploymentClient['describeWorkerDeployment']>>,
) =>
  normalizeOptionalText(response.workerDeploymentInfo?.routingConfig?.currentDeploymentVersion?.buildId) ??
  normalizeOptionalText(response.workerDeploymentInfo?.routingConfig?.currentVersion)

export const isRoutingUpdateComplete = (response: Awaited<ReturnType<DeploymentClient['describeWorkerDeployment']>>) =>
  response.workerDeploymentInfo?.routingConfigUpdateState === RoutingConfigUpdateState.COMPLETED

export const isTransientRoutingAlignmentError = (error: unknown) => {
  const message = error instanceof Error ? error.message : String(error)
  const normalized = message.toLowerCase()
  return [
    'deadline exceeded',
    'failed precondition',
    'missing task queue',
    'missing task queues',
    'no pollers',
    'not found',
    'unavailable',
  ].some((pattern) => normalized.includes(pattern))
}

const defaultSleep = (milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds))

export const alignWorkerDeploymentRouting = async (
  temporalConfig: TemporalConfig,
  options: WorkerRoutingAlignmentOptions = {},
): Promise<WorkerRoutingAlignment> => {
  const buildId = normalizeOptionalText(temporalConfig.workerBuildId)
  if (!buildId) {
    throw new Error('Temporal worker build ID is required for worker deployment routing')
  }

  const deploymentName = resolveWorkerDeploymentName(temporalConfig)
  const timeoutMs =
    options.timeoutMs ??
    parsePositiveInt(process.env.TEMPORAL_ROUTING_ALIGNMENT_TIMEOUT_MS, DEFAULT_ALIGNMENT_TIMEOUT_MS)
  const pollIntervalMs =
    options.pollIntervalMs ?? parsePositiveInt(process.env.TEMPORAL_ROUTING_ALIGNMENT_POLL_MS, DEFAULT_POLL_INTERVAL_MS)
  const rpcTimeoutMs =
    options.rpcTimeoutMs ??
    parsePositiveInt(process.env.TEMPORAL_ROUTING_ALIGNMENT_RPC_TIMEOUT_MS, DEFAULT_RPC_TIMEOUT_MS)
  const identity = options.identity ?? `worker-routing/${process.pid}`
  const now = options.now ?? Date.now
  const sleep = options.sleep ?? defaultSleep
  const deadline = now() + timeoutMs

  const temporal = options.deployments ? null : await createTemporalClient({ config: temporalConfig })
  const deployments = options.deployments ?? temporal?.client.deployments
  if (!deployments) {
    throw new Error('Temporal deployment client is unavailable')
  }

  let previousBuildId: string | null = null
  let previousResolved = false
  let changed = false
  let lastError: unknown

  try {
    while (now() < deadline) {
      try {
        const deployment = await deployments.describeWorkerDeployment(
          { deploymentName },
          temporalCallOptions({ timeoutMs: rpcTimeoutMs }),
        )
        const currentBuildId = extractCurrentDeploymentBuildId(deployment) ?? null
        if (!previousResolved) {
          previousBuildId = currentBuildId
          previousResolved = true
        }

        if (currentBuildId === buildId && isRoutingUpdateComplete(deployment)) {
          console.info('[temporal][worker-routing] worker deployment routing aligned', {
            deploymentName,
            previousBuildId,
            buildId,
            changed,
          })
          return { deploymentName, previousBuildId, buildId, changed }
        }

        if (currentBuildId !== buildId) {
          await deployments.setWorkerDeploymentCurrentVersion(
            {
              deploymentName,
              buildId,
              allowNoPollers: false,
              ignoreMissingTaskQueues: false,
              identity,
            },
            temporalCallOptions({ timeoutMs: rpcTimeoutMs }),
          )
          changed = true
        }
        lastError = undefined
      } catch (error) {
        if (!isTransientRoutingAlignmentError(error)) {
          throw error
        }
        lastError = error
      }

      await sleep(Math.min(pollIntervalMs, Math.max(deadline - now(), 0)))
    }
  } finally {
    await temporal?.client.shutdown().catch(() => undefined)
  }

  const detail = lastError instanceof Error ? `: ${lastError.message}` : ''
  throw new Error(
    `Timed out after ${timeoutMs}ms aligning Temporal worker deployment '${deploymentName}' to '${buildId}'${detail}`,
  )
}
