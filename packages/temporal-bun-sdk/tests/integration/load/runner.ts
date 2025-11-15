import { randomUUID } from 'node:crypto'
import { writeFile } from 'node:fs/promises'
import { Effect } from 'effect'
import { create } from '@bufbuild/protobuf'
import { Code, ConnectError, createClient } from '@connectrpc/connect'
import { createGrpcTransport } from '@connectrpc/connect-node'

import {
  buildTransportOptions,
  createTemporalClient,
  normalizeTemporalAddress,
  type TemporalClient,
} from '../../../src/client'
import { loadTemporalConfig } from '../../../src/config'
import { WorkerRuntime } from '../../../src/worker/runtime'
import type { IntegrationHarness, WorkflowExecutionHandle } from '../harness'
import { readWorkerLoadConfig, type WorkerLoadConfig } from './config'
import { readMetricsFromFile, summarizeLoadMetrics, type WorkerLoadMetricsSummary } from './metrics'
import {
  workerLoadActivities,
  workerLoadWorkflows,
  type WorkerLoadActivityWorkflowInput,
  type WorkerLoadCpuWorkflowInput,
} from './workflows'
import { WorkflowService } from '../../../src/proto/temporal/api/workflowservice/v1/service_pb'
import { ListWorkflowExecutionsRequestSchema } from '../../../src/proto/temporal/api/workflowservice/v1/request_response_pb'

export interface WorkerLoadRunnerOptions {
  readonly harness: IntegrationHarness
  readonly address: string
  readonly namespace: string
  readonly loadConfig?: WorkerLoadConfig
  readonly taskQueuePrefix?: string
}

export interface WorkerLoadRunResult {
  readonly stats: RuntimeStats
  readonly summary: WorkerLoadMetricsSummary
  readonly plans: WorkflowPlan[]
  readonly loadConfig: WorkerLoadConfig
}

export const runWorkerLoad = async (options: WorkerLoadRunnerOptions): Promise<WorkerLoadRunResult> => {
  const loadConfig = options.loadConfig ?? readWorkerLoadConfig()
  const artifactsDir = await Effect.runPromise(options.harness.workerLoadArtifacts.prepare({ clean: true }))
  const taskQueue = buildTaskQueue(options.taskQueuePrefix ?? loadConfig.workflowTaskQueuePrefix)
  const config = await loadTemporalConfig({
    defaults: {
      address: options.address,
      namespace: options.namespace,
      taskQueue,
      workerWorkflowConcurrency: loadConfig.workflowConcurrencyTarget,
      workerActivityConcurrency: loadConfig.activityConcurrencyTarget,
      workerStickyCacheSize: Math.max(loadConfig.workflowConcurrencyTarget * 8, 64),
      stickySchedulingEnabled: true,
    },
  })

  const plans = buildWorkflowPlans(loadConfig)
  const stats = createRuntimeStats(plans.length)
  const runtime = await WorkerRuntime.create({
    config,
    workflows: workerLoadWorkflows,
    activities: workerLoadActivities,
    taskQueue,
    namespace: config.namespace,
    concurrency: {
      workflow: loadConfig.workflowConcurrencyTarget,
      activity: loadConfig.activityConcurrencyTarget,
    },
    stickyScheduling: true,
    schedulerHooks: createSchedulerHooks(stats),
  })

  const runPromise = runtime.run().catch((error) => {
    console.error('[temporal-bun-sdk:load] worker runtime exited with error', error)
    throw error
  })

  let workflowService: WorkflowServiceHandle | undefined

  try {
    const { client: temporalClient, config: resolvedConfig } = await createTemporalClient({ config, taskQueue })
    workflowService = createWorkflowServiceClient(resolvedConfig)
    try {
      const handles = await submitWorkflows(temporalClient, plans, taskQueue, loadConfig)
      const completionBudgetMs =
        loadConfig.workflowDurationBudgetMs + Math.max(loadConfig.metricsFlushTimeoutMs, 5_000)
      await runWithTimeout(
        waitForWorkflowCompletions({
          handles,
          stats,
          workflowService: workflowService.client,
          namespace: resolvedConfig.namespace,
          timeoutMs: loadConfig.workflowDurationBudgetMs,
          taskQueue,
        }),
        completionBudgetMs,
        `Worker load suite exceeded ${completionBudgetMs}ms without completing`,
      )
    } finally {
      await temporalClient.shutdown()
      await workflowService?.close()
    }
  } finally {
    await runtime.shutdown()
    await runPromise
  }

  const durationMs = Math.max(1, (stats.completedAt ?? Date.now()) - stats.startedAt)
  stats.durationMs = durationMs

  const metrics = await readMetricsFromFile(loadConfig.metricsStreamPath)
  const summary = summarizeLoadMetrics(metrics, {
    durationMs,
    completedWorkflows: stats.completed,
  })

  await writeFile(
    loadConfig.metricsReportPath,
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        config: {
          workflowCount: loadConfig.workflowCount,
          workflowConcurrencyTarget: loadConfig.workflowConcurrencyTarget,
          activityConcurrencyTarget: loadConfig.activityConcurrencyTarget,
          stickyHitRatioTarget: loadConfig.stickyHitRatioTarget,
          workflowPollP95TargetMs: loadConfig.workflowPollP95TargetMs,
          activityPollP95TargetMs: loadConfig.activityPollP95TargetMs,
          throughputFloorPerSecond: loadConfig.throughputFloorPerSecond,
        },
        stats,
        metrics: summary,
        artifactsDir,
        metricsPath: loadConfig.metricsStreamPath,
      },
      null,
      2,
    ),
    'utf8',
  )

  return {
    stats,
    summary,
    plans,
    loadConfig,
  }
}

const submitWorkflows = async (
  client: TemporalClient,
  plans: WorkflowPlan[],
  taskQueue: string,
  config: WorkerLoadConfig,
): Promise<WorkflowExecutionHandle[]> => {
  const handles: WorkflowExecutionHandle[] = []
  for (const plan of plans) {
    const result = await client.startWorkflow({
      workflowId: plan.id,
      workflowType: plan.workflowType,
      taskQueue,
      args: [plan.input],
      workflowTaskTimeoutMs: config.workflowDurationBudgetMs,
    })
    handles.push({ workflowId: result.workflowId, runId: result.runId })
  }
  return handles
}

const MIN_HISTORY_POLL_INTERVAL_MS = 250
const MAX_HISTORY_POLL_INTERVAL_MS = 1_000
const MAX_HISTORY_BACKOFF_MS = 5_000

const runWithTimeout = async <T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), timeoutMs)
    promise
      .then((value) => {
        clearTimeout(timer)
        resolve(value)
      })
      .catch((error) => {
        clearTimeout(timer)
        reject(error)
      })
  })

const waitForWorkflowCompletions = async ({
  workflowService,
  handles,
  stats,
  namespace,
  timeoutMs,
  taskQueue,
}: {
  workflowService: ReturnType<typeof createClient<typeof WorkflowService>>
  handles: WorkflowExecutionHandle[]
  stats: RuntimeStats
  namespace: string
  timeoutMs: number
  taskQueue: string
}) => {
  const deadline = Date.now() + timeoutMs
  const pollIntervalMs = Math.min(
    MAX_HISTORY_POLL_INTERVAL_MS,
    Math.max(MIN_HISTORY_POLL_INTERVAL_MS, Math.trunc(timeoutMs / 40)),
  )

  const countRunningExecutions = async (): Promise<number> => {
    let running = 0
    let nextPageToken = new Uint8Array(0)
    do {
      const request = create(ListWorkflowExecutionsRequestSchema, {
        namespace,
        pageSize: 50,
        nextPageToken,
        query: `TaskQueue = '${taskQueue}' AND ExecutionStatus = "Running"`,
      })
      const response = await workflowService.listWorkflowExecutions(request, {})
      running += response.executions.length
      nextPageToken = response.nextPageToken ?? new Uint8Array(0)
    } while (nextPageToken.length > 0)
    return running
  }

  let running = handles.length
  while (running > 0) {
    if (Date.now() > deadline) {
      throw new Error(`Timed out waiting for ${running} workflows to complete`)
    }

    let rateLimited = false
    try {
      running = await countRunningExecutions()
    } catch (error) {
      if (error instanceof ConnectError && error.code === Code.ResourceExhausted) {
        rateLimited = true
      }
      console.warn('[temporal-bun-sdk:load] listWorkflowExecutions failed', { error })
      running = handles.length - stats.completed
    }

    stats.completed = Math.max(stats.submitted - running, stats.completed)

    if (running > 0) {
      const delay = rateLimited ? Math.min(MAX_HISTORY_BACKOFF_MS, pollIntervalMs * 4) : pollIntervalMs
      await sleep(delay)
    }
  }

  stats.completedAt = Date.now()
}

const buildWorkflowPlans = (config: WorkerLoadConfig): WorkflowPlan[] => {
  const total = Math.max(1, config.workflowCount)
  let cpuCount = Math.max(1, Math.floor(total * 0.4))
  let activityCount = total - cpuCount
  if (activityCount <= 0) {
    activityCount = 1
    cpuCount = Math.max(0, total - activityCount)
  }
  const plans: WorkflowPlan[] = []
  for (let index = 0; index < cpuCount; index += 1) {
    plans.push({
      id: `worker-load-cpu-${index}-${randomUUID()}`,
      workflowType: 'workerLoadCpuWorkflow',
      input: {
        rounds: config.cpuRounds,
        computeIterations: config.computeIterations,
        timerDelayMs: config.timerDelayMs,
      },
    })
  }
  for (let index = 0; index < activityCount; index += 1) {
    plans.push({
      id: `worker-load-io-${index}-${randomUUID()}`,
      workflowType: 'workerLoadActivityWorkflow',
      input: {
        bursts: config.activityBurstsPerWorkflow,
        computeIterations: Math.max(10_000, Math.floor(config.computeIterations / 4)),
        activityDelayMs: config.activityDelayMs,
        payloadBytes: config.activityPayloadBytes,
      },
    })
  }
  return plans
}

const createRuntimeStats = (submitted: number): RuntimeStats => ({
  submitted,
  completed: 0,
  active: 0,
  peakConcurrent: 0,
  startedAt: Date.now(),
  completedAt: undefined,
  durationMs: 0,
})

const createSchedulerHooks = (stats: RuntimeStats) => ({
  onWorkflowStart: () =>
    Effect.sync(() => {
      stats.active += 1
      stats.peakConcurrent = Math.max(stats.peakConcurrent, stats.active)
    }),
  onWorkflowComplete: () =>
    Effect.sync(() => {
      stats.active = Math.max(0, stats.active - 1)
    }),
})

const buildTaskQueue = (prefix: string): string => {
  const suffix = `${Date.now()}-${Math.round(Math.random() * 10_000)}`
  return `${prefix}-${suffix}`
}

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms)
  })

type WorkflowServiceHandle = {
  client: ReturnType<typeof createClient<typeof WorkflowService>>
  close: () => Promise<void>
}

const createWorkflowServiceClient = (config: Awaited<ReturnType<typeof loadTemporalConfig>>): WorkflowServiceHandle => {
  const useTls = Boolean(config.tls || config.allowInsecureTls)
  const baseUrl = normalizeTemporalAddress(config.address, useTls)
  const transportOptions = buildTransportOptions(baseUrl, config)
  const transport = createGrpcTransport(transportOptions)
  const client = createClient(WorkflowService, transport)
  const close = async () => {
    if (typeof transport.close === 'function') {
      await transport.close()
    }
  }
  return { client, close }
}

export type WorkflowPlan =
  | {
      readonly id: string
      readonly workflowType: 'workerLoadCpuWorkflow'
      readonly input: WorkerLoadCpuWorkflowInput
    }
  | {
      readonly id: string
      readonly workflowType: 'workerLoadActivityWorkflow'
      readonly input: WorkerLoadActivityWorkflowInput
    }

export interface RuntimeStats {
  submitted: number
  completed: number
  active: number
  peakConcurrent: number
  startedAt: number
  completedAt?: number
  durationMs: number
}
