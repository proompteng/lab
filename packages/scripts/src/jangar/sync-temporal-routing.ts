#!/usr/bin/env bun

import process from 'node:process'

import { ensureCli, fatal } from '../shared/cli'

type CliOptions = {
  address?: string
  namespace?: string
  taskQueue?: string
  deploymentName?: string
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

type TaskQueueDescribePoller = {
  buildId?: string
  taskQueueType?: string
  identity?: string
}

type TaskQueueDescribeResponse = {
  pollers?: TaskQueueDescribePoller[]
}

type WorkerDeploymentDescribeResponse = {
  routingConfig?: {
    currentVersionBuildID?: string
  }
  versionSummaries?: Array<{
    BuildID?: string
    buildId?: string
  }>
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
  const subprocess = Bun.spawn(['temporal', '--address', options.address, '--namespace', options.namespace, ...args], {
    stdout: 'pipe',
    stderr: 'pipe',
  })

  const [stdout, stderr, exitCode] = await Promise.all([
    subprocess.stdout ? new Response(subprocess.stdout).text() : Promise.resolve(''),
    subprocess.stderr ? new Response(subprocess.stderr).text() : Promise.resolve(''),
    subprocess.exited,
  ])

  if (exitCode !== 0 && !allowFailure) {
    throw new Error(`Command failed (${exitCode}): temporal ${args.join(' ')}\n${stderr || stdout}`.trim())
  }

  return { stdout, stderr, exitCode }
}

const parseJson = <T>(json: string, label: string): T => {
  try {
    return JSON.parse(json) as T
  } catch (error) {
    throw new Error(`Unable to parse ${label}: ${error instanceof Error ? error.message : String(error)}`)
  }
}

const stripDeploymentPrefix = (pollerBuildId: string, deploymentName: string): string | undefined => {
  const prefix = `${deploymentName}:`
  if (!pollerBuildId.startsWith(prefix)) {
    return undefined
  }
  return pollerBuildId.slice(prefix.length)
}

const extractVersionedPollerBuildIds = (
  pollers: TaskQueueDescribePoller[] | undefined,
  deploymentName: string,
): string[] => {
  if (!pollers || pollers.length === 0) {
    return []
  }

  const workflowBuildIds = new Set<string>()
  for (const poller of pollers) {
    if (poller.taskQueueType !== 'workflow') {
      continue
    }
    if (!poller.buildId) {
      continue
    }
    const parsed = stripDeploymentPrefix(poller.buildId, deploymentName)
    if (parsed) {
      workflowBuildIds.add(parsed)
    }
  }

  return [...workflowBuildIds]
}

const selectTargetBuildId = (candidateBuildIds: string[], deploymentName: string): string => {
  if (candidateBuildIds.length === 0) {
    throw new Error(
      `No versioned workflow pollers found for deployment '${deploymentName}'. Ensure worker pods are healthy before syncing routing.`,
    )
  }
  if (candidateBuildIds.length > 1) {
    throw new Error(
      `Multiple workflow poller build IDs detected for deployment '${deploymentName}': ${candidateBuildIds.join(', ')}`,
    )
  }
  return candidateBuildIds[0] as string
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

const syncCurrentVersion = async (options: ResolvedOptions): Promise<SyncResult> => {
  const deploymentResponse = await runTemporal(options, [
    'worker',
    'deployment',
    'describe',
    '--name',
    options.deploymentName,
    '-o',
    'json',
  ])
  const deployment = parseJson<WorkerDeploymentDescribeResponse>(
    deploymentResponse.stdout,
    'worker deployment describe output',
  )
  const currentBuildId = deployment.routingConfig?.currentVersionBuildID

  const queueResponse = await runTemporal(options, [
    'task-queue',
    'describe',
    '--task-queue',
    options.taskQueue,
    '--select-all-active',
    '--select-unversioned',
    '-o',
    'json',
  ])
  const queueDetails = parseJson<TaskQueueDescribeResponse>(queueResponse.stdout, 'task-queue describe output')
  const pollerBuildIds = extractVersionedPollerBuildIds(queueDetails.pollers, options.deploymentName)
  const targetBuildId = selectTargetBuildId(pollerBuildIds, options.deploymentName)

  if (currentBuildId === targetBuildId) {
    console.log(`Temporal routing already aligned: ${options.deploymentName} -> ${targetBuildId}`)
    const deploymentBuildIds = (deployment.versionSummaries ?? [])
      .map((entry) => entry.BuildID ?? entry.buildId)
      .filter((value): value is string => typeof value === 'string' && value.length > 0)
    return { changed: false, previousBuildId: currentBuildId, targetBuildId, deploymentBuildIds }
  }

  if (options.dryRun) {
    console.log(
      `[dry-run] Would set current version: ${options.deploymentName} ${currentBuildId ?? '<none>'} -> ${targetBuildId}`,
    )
    const deploymentBuildIds = (deployment.versionSummaries ?? [])
      .map((entry) => entry.BuildID ?? entry.buildId)
      .filter((value): value is string => typeof value === 'string' && value.length > 0)
    return { changed: true, previousBuildId: currentBuildId, targetBuildId, deploymentBuildIds }
  }

  await runTemporal(options, [
    'worker',
    'deployment',
    'set-current-version',
    '--deployment-name',
    options.deploymentName,
    '--build-id',
    targetBuildId,
    '--yes',
  ])
  console.log(`Updated current version: ${options.deploymentName} ${currentBuildId ?? '<none>'} -> ${targetBuildId}`)

  const deploymentBuildIds = (deployment.versionSummaries ?? [])
    .map((entry) => entry.BuildID ?? entry.buildId)
    .filter((value): value is string => typeof value === 'string' && value.length > 0)
  return { changed: true, previousBuildId: currentBuildId, targetBuildId, deploymentBuildIds }
}

export const main = async (cliOptions?: CliOptions) => {
  ensureCli('temporal')

  const options = resolveOptions(cliOptions ?? parseArgs(process.argv.slice(2)))
  const sync = await syncCurrentVersion(options)

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
}

if (import.meta.main) {
  main().catch((error) => fatal('Failed to sync Temporal worker deployment routing', error))
}

export const __private = {
  parseArgs,
  stripDeploymentPrefix,
  extractVersionedPollerBuildIds,
  selectTargetBuildId,
  resolveOptions,
}
