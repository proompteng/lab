import { randomUUID } from 'node:crypto'
import { writeFile } from 'node:fs/promises'
import { Effect } from 'effect'

import { createTemporalClient, type TemporalClient } from '../../../src/client'
import { loadTemporalConfig } from '../../../src/config'
import { WorkerRuntime } from '../../../src/worker/runtime'
import type { IntegrationHarness } from '../harness'
import { readWorkerLoadConfig, type WorkerLoadConfig } from './config'
import { readMetricsFromFile, summarizeLoadMetrics, type WorkerLoadMetricsSummary } from './metrics'
import {
  workerLoadActivities,
  workerLoadWorkflows,
  type WorkerLoadActivityWorkflowInput,
  type WorkerLoadCpuWorkflowInput,
} from './workflows'

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
  const expectedWorkflowTasks = calculateExpectedWorkflowTasks(plans)
  const stats = createRuntimeStats(plans.length, expectedWorkflowTasks)
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

  try {
    const { client: temporalClient } = await createTemporalClient({ config, taskQueue })
    try {
      await submitWorkflows(temporalClient, plans, taskQueue, loadConfig)
      await waitForCompletion(stats, loadConfig.workflowDurationBudgetMs)
    } finally {
      await temporalClient.shutdown()
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
) => {
  for (const plan of plans) {
    await client.startWorkflow({
      workflowId: plan.id,
      workflowType: plan.workflowType,
      taskQueue,
      args: [plan.input],
      workflowTaskTimeoutMs: config.workflowDurationBudgetMs,
    })
  }
}

const waitForCompletion = async (stats: RuntimeStats, timeoutMs: number) => {
  const deadline = Date.now() + timeoutMs
  while (stats.processedTasks < stats.expectedWorkflowTasks) {
    if (Date.now() > deadline) {
      throw new Error(
        `Processed ${stats.processedTasks}/${stats.expectedWorkflowTasks} workflow tasks before timeout`,
      )
    }
    await sleep(250)
  }
  stats.completed = stats.submitted
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

const createRuntimeStats = (submitted: number, expectedWorkflowTasks: number): RuntimeStats => ({
  submitted,
  completed: 0,
  processedTasks: 0,
  expectedWorkflowTasks,
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
      stats.processedTasks += 1
      if (!stats.completedAt && stats.processedTasks >= stats.expectedWorkflowTasks) {
        stats.completedAt = Date.now()
      }
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

const calculateExpectedWorkflowTasks = (plans: WorkflowPlan[]): number =>
  plans.reduce((total, plan) => {
    if (plan.workflowType === 'workerLoadActivityWorkflow') {
      const { bursts } = plan.input as WorkerLoadActivityWorkflowInput
      const normalizedBursts = Number.isFinite(bursts) ? Math.max(1, Math.trunc(bursts)) : 1
      return total + normalizedBursts + 1
    }
    return total + 1
  }, 0)

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
  processedTasks: number
  expectedWorkflowTasks: number
  active: number
  peakConcurrent: number
  startedAt: number
  completedAt?: number
  durationMs: number
}
