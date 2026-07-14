#!/usr/bin/env bun

import process from 'node:process'

import {
  createTemporalClient,
  loadTemporalConfig,
  type TemporalClient,
  temporalCallOptions,
} from '@proompteng/temporal-bun-sdk'
import {
  extractCurrentDeploymentBuildId,
  normalizeWorkerDeploymentBuildId,
  RoutingConfigUpdateState,
} from '@proompteng/temporal-bun-sdk/worker'

import { ensureCli, fatal } from '../shared/cli'

type CliOptions = {
  address?: string
  namespace?: string
  taskQueue?: string
  deploymentName?: string
  buildId?: string
  migrateStaleRunning?: boolean
  migrateUnversionedRunning?: boolean
  reason?: string
  dryRun?: boolean
}

type ResolvedOptions = {
  address: string
  namespace: string
  taskQueue: string
  deploymentName: string
  buildId?: string
  migrateStaleRunning: boolean
  migrateUnversionedRunning: boolean
  reason: string
  dryRun: boolean
}

type CommandResult = {
  stdout: string
  stderr: string
  exitCode: number
}

type SyncResult = {
  changed: boolean
  previousBuildId?: string
  targetBuildId: string
  deploymentBuildIds: string[]
}

const defaultAddress = 'temporal-frontend.temporal.svc.cluster.local:7233'
const defaultNamespace = 'default'
const defaultTaskQueue = 'jangar'
const defaultReason = 'post-deploy temporal routing sync'
const defaultBatchRetryDelayMs = 5_000
const defaultBatchRetryAttempts = 5
const defaultTemporalRetryDelayMs = 2_000
const defaultTemporalRetryAttempts = 5
const defaultTemporalRetryMaxDelayMs = 10_000
const defaultRoutingPropagationTimeoutMs = 120_000
const defaultRoutingPropagationPollMs = 1_000
const defaultRoutingRpcTimeoutMs = 5_000

const transientTemporalErrorPatterns = [
  /context deadline exceeded/,
  /deadline exceeded/,
  /\bunavailable\b/,
  /connection refused/,
  /connection reset by peer/,
  /connection reset/,
  /broken pipe/,
  /transport is closing/,
  /server temporarily unavailable/,
  /i\/o timeout/,
  /\beof\b/,
]

const normalizeTemporalErrorMessage = (message: string): string => message.trim().toLowerCase().replace(/\s+/g, ' ')

const isTransientTemporalConnectivityError = (message: string): boolean => {
  const normalized = normalizeTemporalErrorMessage(message)
  return transientTemporalErrorPatterns.some((pattern) => pattern.test(normalized))
}

const getTemporalRetryDelayMs = (attempt: number): number => {
  const backoff = defaultTemporalRetryDelayMs * 2 ** Math.max(attempt - 1, 0)
  return Math.min(backoff, defaultTemporalRetryMaxDelayMs)
}

const parseArgs = (argv: string[]): CliOptions => {
  const options: CliOptions = {}

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--help' || arg === '-h') {
      console.log(`Usage: bun run packages/scripts/src/jangar/sync-temporal-routing.ts [options]

Options:
  --address <host:port>                 Temporal gRPC address
  --namespace <name>                    Temporal namespace (default: default)
  --task-queue <name>                   Task queue to inspect (default: jangar)
  --deployment-name <name>              Temporal worker deployment name (default: <task-queue>-deployment)
  --build-id <id>                       Explicit build to select; otherwise verify the worker-selected current build
  --migrate-stale-running               Move stale pinned running workflows to auto_upgrade after routing update
  --migrate-unversioned-running         Move unversioned running workflows to auto_upgrade
  --reason <text>                       Reason recorded in workflow update-options
  --dry-run                             Print intended actions without mutating Temporal`)
      process.exit(0)
    }

    if (arg === '--migrate-stale-running') {
      options.migrateStaleRunning = true
      continue
    }
    if (arg === '--migrate-unversioned-running') {
      options.migrateUnversionedRunning = true
      continue
    }
    if (arg === '--dry-run') {
      options.dryRun = true
      continue
    }

    if (!arg.startsWith('--')) {
      throw new Error(`Unknown argument: ${arg}`)
    }

    const [flag, inlineValue] = arg.includes('=') ? arg.split(/=(.*)/s, 2) : [arg, undefined]
    const value = inlineValue ?? argv[i + 1]
    if (inlineValue === undefined) {
      i += 1
    }
    if (!value) {
      throw new Error(`Missing value for ${flag}`)
    }

    switch (flag) {
      case '--address':
        options.address = value
        break
      case '--namespace':
        options.namespace = value
        break
      case '--task-queue':
        options.taskQueue = value
        break
      case '--deployment-name':
        options.deploymentName = value
        break
      case '--build-id':
        options.buildId = value
        break
      case '--reason':
        options.reason = value
        break
      default:
        throw new Error(`Unknown option: ${flag}`)
    }
  }

  return options
}

const resolveOptions = (options: CliOptions): ResolvedOptions => {
  const taskQueue = options.taskQueue?.trim() || process.env.TEMPORAL_TASK_QUEUE?.trim() || defaultTaskQueue
  const deploymentName =
    options.deploymentName?.trim() || process.env.TEMPORAL_WORKER_DEPLOYMENT_NAME?.trim() || `${taskQueue}-deployment`

  return {
    address: options.address?.trim() || process.env.TEMPORAL_ADDRESS?.trim() || defaultAddress,
    namespace: options.namespace?.trim() || process.env.TEMPORAL_NAMESPACE?.trim() || defaultNamespace,
    taskQueue,
    deploymentName,
    buildId: options.buildId?.trim() || process.env.TEMPORAL_WORKER_BUILD_ID?.trim() || undefined,
    migrateStaleRunning: options.migrateStaleRunning ?? false,
    migrateUnversionedRunning: options.migrateUnversionedRunning ?? false,
    reason: options.reason?.trim() || defaultReason,
    dryRun: options.dryRun ?? false,
  }
}

const runTemporal = async (
  options: Pick<ResolvedOptions, 'address' | 'namespace'>,
  args: string[],
  allowFailure = false,
): Promise<CommandResult> => {
  let lastError: Error | undefined

  for (let attempt = 1; attempt <= defaultTemporalRetryAttempts; attempt += 1) {
    const subprocess = Bun.spawn(
      ['temporal', '--address', options.address, '--namespace', options.namespace, ...args],
      {
        stdout: 'pipe',
        stderr: 'pipe',
      },
    )

    const [stdout, stderr, exitCode] = await Promise.all([
      subprocess.stdout ? new Response(subprocess.stdout).text() : Promise.resolve(''),
      subprocess.stderr ? new Response(subprocess.stderr).text() : Promise.resolve(''),
      subprocess.exited,
    ])

    if (exitCode === 0) {
      return { stdout, stderr, exitCode }
    }

    const failureMessage = `Command failed (${exitCode}): temporal ${args.join(' ')}\n${stderr || stdout}`.trim()
    lastError = new Error(failureMessage)

    if (allowFailure || attempt === defaultTemporalRetryAttempts) {
      break
    }

    const transientErrorSource = stderr || stdout || failureMessage
    if (!isTransientTemporalConnectivityError(transientErrorSource)) {
      break
    }

    const delayMs = getTemporalRetryDelayMs(attempt)
    console.log(
      `Temporal CLI transient failure (attempt ${attempt}/${defaultTemporalRetryAttempts}); retrying in ${delayMs}ms`,
    )
    await Bun.sleep(delayMs)
  }

  if (lastError) {
    throw lastError
  }

  throw new Error(`Command failed: temporal ${args.join(' ')}`)
}

const parseJson = <T>(json: string, label: string): T => {
  try {
    return JSON.parse(json) as T
  } catch (error) {
    throw new Error(`Unable to parse ${label}: ${error instanceof Error ? error.message : String(error)}`)
  }
}

const countWorkflows = async (
  options: Pick<ResolvedOptions, 'address' | 'namespace'>,
  query: string,
): Promise<number> => {
  const response = await runTemporal(options, ['workflow', 'count', '--query', query, '-o', 'json'])
  const payload = parseJson<{ count?: string | number }>(response.stdout, 'workflow count output')
  const raw = payload.count
  if (raw === undefined || raw === null || raw === '') {
    return 0
  }
  const parsed = typeof raw === 'number' ? raw : Number.parseInt(raw ?? '', 10)
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`Invalid workflow count response for query '${query}': ${response.stdout.trim()}`)
  }
  return parsed
}

const updateRunningWorkflowsToAutoUpgrade = async (
  options: ResolvedOptions,
  query: string,
  reason: string,
): Promise<number> => {
  const count = await countWorkflows(options, query)
  if (count === 0) {
    return 0
  }

  if (options.dryRun) {
    console.log(`[dry-run] Would update ${count} workflow(s): ${query}`)
    return count
  }

  for (let attempt = 1; attempt <= defaultBatchRetryAttempts; attempt += 1) {
    try {
      await runTemporal(options, [
        'workflow',
        'update-options',
        '--query',
        query,
        '--versioning-override-behavior',
        'auto_upgrade',
        '--reason',
        reason,
        '--yes',
      ])
      return count
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      const isBatchLimitError = message.includes('Max concurrent batch operations is reached')
      if (!isBatchLimitError || attempt === defaultBatchRetryAttempts) {
        throw error
      }
      console.log(
        `Batch slot unavailable (attempt ${attempt}/${defaultBatchRetryAttempts}); retrying in ${defaultBatchRetryDelayMs}ms`,
      )
      await Bun.sleep(defaultBatchRetryDelayMs)
    }
  }

  return count
}

type WorkerDeploymentResponse = Awaited<ReturnType<TemporalClient['deployments']['describeWorkerDeployment']>>

const extractDeploymentBuildIds = (deployment: WorkerDeploymentResponse, deploymentName: string): string[] =>
  (deployment.workerDeploymentInfo?.versionSummaries ?? [])
    .map((entry) => {
      const buildId = entry.deploymentVersion?.buildId?.trim()
      if (buildId) return buildId
      return normalizeWorkerDeploymentBuildId(deploymentName, entry.version)
    })
    .filter((value): value is string => Boolean(value))

const routingPropagationComplete = (
  deployment: WorkerDeploymentResponse,
  deploymentName: string,
  buildId: string,
): boolean =>
  extractCurrentDeploymentBuildId(deployment, deploymentName) === buildId &&
  deployment.workerDeploymentInfo?.routingConfigUpdateState === RoutingConfigUpdateState.COMPLETED

const waitForRoutingPropagation = async (
  client: TemporalClient,
  deploymentName: string,
  buildId: string,
  options: { timeoutMs?: number; pollMs?: number; now?: () => number } = {},
): Promise<void> => {
  const timeoutMs = options.timeoutMs ?? defaultRoutingPropagationTimeoutMs
  const pollMs = options.pollMs ?? defaultRoutingPropagationPollMs
  const now = options.now ?? Date.now
  const deadline = now() + timeoutMs

  while (now() < deadline) {
    const deployment = await client.deployments.describeWorkerDeployment(
      { deploymentName },
      temporalCallOptions({ timeoutMs: defaultRoutingRpcTimeoutMs }),
    )
    if (routingPropagationComplete(deployment, deploymentName, buildId)) {
      return
    }
    await Bun.sleep(Math.min(pollMs, Math.max(deadline - now(), 0)))
  }

  throw new Error(
    `Timed out after ${timeoutMs}ms waiting for Temporal routing propagation: ${deploymentName} -> ${buildId}`,
  )
}

const syncCurrentVersion = async (options: ResolvedOptions, client: TemporalClient): Promise<SyncResult> => {
  const deployment = await client.deployments.describeWorkerDeployment(
    { deploymentName: options.deploymentName },
    temporalCallOptions({ timeoutMs: defaultRoutingRpcTimeoutMs }),
  )
  const currentBuildId = extractCurrentDeploymentBuildId(deployment, options.deploymentName)
  const targetBuildId = options.buildId ?? currentBuildId
  const deploymentBuildIds = extractDeploymentBuildIds(deployment, options.deploymentName)
  if (!targetBuildId) {
    throw new Error(
      `Temporal worker deployment '${options.deploymentName}' has no current build; wait for a healthy worker or pass --build-id explicitly.`,
    )
  }

  if (
    currentBuildId === targetBuildId &&
    routingPropagationComplete(deployment, options.deploymentName, targetBuildId)
  ) {
    console.log(`Temporal routing already aligned: ${options.deploymentName} -> ${targetBuildId}`)
    return { changed: false, previousBuildId: currentBuildId, targetBuildId, deploymentBuildIds }
  }

  if (options.dryRun) {
    if (currentBuildId !== targetBuildId) {
      console.log(
        `[dry-run] Would set current version: ${options.deploymentName} ${currentBuildId ?? '<none>'} -> ${targetBuildId}`,
      )
      return { changed: true, previousBuildId: currentBuildId, targetBuildId, deploymentBuildIds }
    }
  }

  if (currentBuildId !== targetBuildId) {
    await client.deployments.setWorkerDeploymentCurrentVersion(
      {
        deploymentName: options.deploymentName,
        buildId: targetBuildId,
        allowNoPollers: false,
        ignoreMissingTaskQueues: false,
        identity: `sync-temporal-routing/${process.pid}`,
      },
      temporalCallOptions({ timeoutMs: defaultRoutingRpcTimeoutMs }),
    )
    console.log(`Updated current version: ${options.deploymentName} ${currentBuildId ?? '<none>'} -> ${targetBuildId}`)
  }

  await waitForRoutingPropagation(client, options.deploymentName, targetBuildId)
  console.log(`Temporal routing propagation completed: ${options.deploymentName} -> ${targetBuildId}`)

  return {
    changed: currentBuildId !== targetBuildId,
    previousBuildId: currentBuildId,
    targetBuildId,
    deploymentBuildIds,
  }
}

export const main = async (cliOptions?: CliOptions) => {
  const options = resolveOptions(cliOptions ?? parseArgs(process.argv.slice(2)))
  if (options.migrateStaleRunning || options.migrateUnversionedRunning) {
    ensureCli('temporal')
  }
  const loadedConfig = await loadTemporalConfig()
  const { client } = await createTemporalClient({
    config: {
      ...loadedConfig,
      address: options.address,
      namespace: options.namespace,
      taskQueue: options.taskQueue,
    },
  })

  try {
    const sync = await syncCurrentVersion(options, client)

    let migratedStale = 0
    let migratedUnversioned = 0

    if (options.migrateStaleRunning) {
      const staleBuildIds = [...new Set(sync.deploymentBuildIds)].filter((buildId) => buildId !== sync.targetBuildId)
      for (const buildId of staleBuildIds) {
        const query = `TaskQueue="${options.taskQueue}" and ExecutionStatus="Running" and TemporalWorkerDeploymentVersion="${options.deploymentName}:${buildId}"`
        migratedStale += await updateRunningWorkflowsToAutoUpgrade(options, query, options.reason)
      }
      if (migratedStale > 0) {
        console.log(
          `${options.dryRun ? 'Would update' : 'Updated'} ${migratedStale} stale pinned workflow(s) to auto_upgrade`,
        )
      }
    }

    if (options.migrateUnversionedRunning) {
      const query = `TaskQueue="${options.taskQueue}" and ExecutionStatus="Running" and TemporalWorkerDeploymentVersion is null`
      migratedUnversioned = await updateRunningWorkflowsToAutoUpgrade(options, query, options.reason)
      if (migratedUnversioned > 0) {
        console.log(
          `${options.dryRun ? 'Would update' : 'Updated'} ${migratedUnversioned} unversioned workflow(s) to auto_upgrade`,
        )
      }
    }

    console.log(
      JSON.stringify(
        {
          deploymentName: options.deploymentName,
          taskQueue: options.taskQueue,
          previousBuildId: sync.previousBuildId,
          targetBuildId: sync.targetBuildId,
          changed: sync.changed,
          migratedStale,
          migratedUnversioned,
          dryRun: options.dryRun,
        },
        null,
        2,
      ),
    )
  } finally {
    await client.shutdown()
  }
}

if (import.meta.main) {
  main().catch((error) => fatal('Failed to sync Temporal worker deployment routing', error))
}

export const __private = {
  parseArgs,
  getTemporalRetryDelayMs,
  isTransientTemporalConnectivityError,
  runTemporal,
  extractCurrentDeploymentBuildId,
  extractDeploymentBuildIds,
  routingPropagationComplete,
  waitForRoutingPropagation,
  syncCurrentVersion,
  resolveOptions,
}
