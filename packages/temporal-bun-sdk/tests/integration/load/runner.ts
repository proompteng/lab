import { randomUUID } from 'node:crypto'
import { writeFile } from 'node:fs/promises'
import { Effect } from 'effect'
import { create } from '@bufbuild/protobuf'

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
import { WorkflowExecutionStatus } from '../../../src/proto/temporal/api/enums/v1/workflow_pb'
import { WorkflowService } from '../../../src/proto/temporal/api/workflowservice/v1/service_pb'
import { DescribeWorkflowExecutionRequestSchema } from '../../../src/proto/temporal/api/workflowservice/v1/request_response_pb'
import { WorkflowExecutionSchema } from '../../../src/proto/temporal/api/common/v1/message_pb'
import { createClient } from '@connectrpc/connect'
import { createGrpcTransport } from '@connectrpc/connect-node'
import { Code, ConnectError } from '@connectrpc/connect'

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
          workflowService: workflowService.client,
          handles,
          stats,
          namespace: resolvedConfig.namespace,
          timeoutMs: loadConfig.workflowDurationBudgetMs,
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

const COMPLETION_POLL_INTERVAL_MS = 500
const MAX_HISTORY_BACKOFF_MS = 5_000
const MAX_STATUS_POLLERS = 8

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
}: {
  workflowService: ReturnType<typeof createClient<typeof WorkflowService>>
  handles: WorkflowExecutionHandle[]
  stats: RuntimeStats
  namespace: string
  timeoutMs: number
}) => {
  const pending = new Map(handles.map((handle) => [handle.workflowId, handle]))
  const deadline = Date.now() + timeoutMs

  const describeUntilClosed = async (handle: WorkflowExecutionHandle): Promise<void> => {
    let backoffMs = COMPLETION_POLL_INTERVAL_MS
    while (true) {
      if (Date.now() > deadline) {
        throw new Error(`Timed out waiting for workflow ${handle.workflowId} to complete`)
      }
      try {
        const request = create(DescribeWorkflowExecutionRequestSchema, {
          namespace,
          execution: create(WorkflowExecutionSchema, {
            workflowId: handle.workflowId,
            runId: handle.runId,
          }),
        })
        const response = await workflowService.describeWorkflowExecution(request, {})
        const status =
          response.workflowExecutionInfo?.status ??
          WorkflowExecutionStatus.WORKFLOW_EXECUTION_STATUS_UNSPECIFIED
        if (TERMINAL_WORKFLOW_STATUSES.has(status)) {
          if (pending.delete(handle.workflowId)) {
            stats.completed += 1
          }
          return
        }
        backoffMs = COMPLETION_POLL_INTERVAL_MS
      } catch (error) {
        if (error instanceof ConnectError && (error.code === Code.ResourceExhausted || error.code === Code.Unavailable)) {
          backoffMs = Math.min(backoffMs * 2, MAX_HISTORY_BACKOFF_MS)
        } else {
          backoffMs = COMPLETION_POLL_INTERVAL_MS
        }
        console.warn('[temporal-bun-sdk:load] describeWorkflowExecution failed', {
          workflowId: handle.workflowId,
          runId: handle.runId,
          error,
        })
      }
      await sleep(backoffMs)
    }
  }

  const queue = [...handles]
  const workerCount = Math.min(MAX_STATUS_POLLERS, queue.length)
  await Promise.all(
    Array.from({ length: workerCount }, async () => {
      while (queue.length > 0) {
        const handle = queue.shift()
        if (!handle) {
          return
        }
        await describeUntilClosed(handle)
      }
    }),
  )

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

const TERMINAL_WORKFLOW_STATUSES = new Set<WorkflowExecutionStatus>([
  WorkflowExecutionStatus.WORKFLOW_EXECUTION_STATUS_COMPLETED,
  WorkflowExecutionStatus.WORKFLOW_EXECUTION_STATUS_FAILED,
  WorkflowExecutionStatus.WORKFLOW_EXECUTION_STATUS_CANCELED,
  WorkflowExecutionStatus.WORKFLOW_EXECUTION_STATUS_TERMINATED,
  WorkflowExecutionStatus.WORKFLOW_EXECUTION_STATUS_CONTINUED_AS_NEW,
  WorkflowExecutionStatus.WORKFLOW_EXECUTION_STATUS_TIMED_OUT,
])

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
