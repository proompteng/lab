import { randomUUID } from 'node:crypto'
import { writeFile } from 'node:fs/promises'
import { Effect } from 'effect'
import { create } from '@bufbuild/protobuf'
import { createClient } from '@connectrpc/connect'
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
import { EventType } from '../../../src/proto/temporal/api/enums/v1/event_type_pb'
import { WorkflowService } from '../../../src/proto/temporal/api/workflowservice/v1/service_pb'
import { GetWorkflowExecutionHistoryRequestSchema } from '../../../src/proto/temporal/api/workflowservice/v1/request_response_pb'
import { WorkflowExecutionSchema } from '../../../src/proto/temporal/api/common/v1/message_pb'

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
      await waitForWorkflowCompletions({
        handles,
        stats,
        workflowService: workflowService.client,
        namespace: resolvedConfig.namespace,
        timeoutMs: loadConfig.workflowDurationBudgetMs,
      })
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

  while (pending.size > 0) {
    if (Date.now() > deadline) {
      throw new Error(`Timed out waiting for ${pending.size} workflows to complete`)
    }

    for (const [workflowId, handle] of pending) {
      try {
        const request = create(GetWorkflowExecutionHistoryRequestSchema, {
          namespace,
          execution: create(WorkflowExecutionSchema, {
            workflowId: handle.workflowId,
            runId: handle.runId,
          }),
          maximumPageSize: 1_000,
        })
        const response = await workflowService.getWorkflowExecutionHistory(request, {})
        const history = response.history?.events ?? []
        const lastEvent = history.at(-1)
        if (lastEvent && WORKFLOW_CLOSED_EVENTS.has(lastEvent.eventType ?? EventType.EVENT_TYPE_UNSPECIFIED)) {
          pending.delete(workflowId)
          stats.completed += 1
        }
      } catch (error) {
        console.warn('[temporal-bun-sdk:load] getWorkflowExecutionHistory failed', {
          workflowId: handle.workflowId,
          runId: handle.runId,
          error,
        })
      }
    }

    if (pending.size > 0) {
      await sleep(1_000)
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

const WORKFLOW_CLOSED_EVENTS = new Set<EventType>([
  EventType.WORKFLOW_EXECUTION_COMPLETED,
  EventType.WORKFLOW_EXECUTION_FAILED,
  EventType.WORKFLOW_EXECUTION_TIMED_OUT,
  EventType.WORKFLOW_EXECUTION_TERMINATED,
  EventType.WORKFLOW_EXECUTION_CANCELED,
  EventType.WORKFLOW_EXECUTION_CONTINUED_AS_NEW,
])

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
