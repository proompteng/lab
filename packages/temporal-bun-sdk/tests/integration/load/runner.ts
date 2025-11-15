import { randomUUID } from 'node:crypto'
import { writeFile } from 'node:fs/promises'
import { Effect } from 'effect'

import { createTemporalClient, type TemporalClient } from '../../../src/client'
import { loadTemporalConfig } from '../../../src/config'
import { WorkerRuntime } from '../../../src/worker/runtime'
import type { IntegrationHarness } from '../harness'
import { resolveTemporalCliExecutable } from '../harness'
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

  try {
    const cliPath = await Effect.runPromise(resolveTemporalCliExecutable())
    const { client: temporalClient, config: resolvedConfig } = await createTemporalClient({ config, taskQueue })
    try {
      const handles = await submitWorkflows(temporalClient, plans, taskQueue, loadConfig)
      const completionBudgetMs =
        loadConfig.workflowDurationBudgetMs + Math.max(loadConfig.metricsFlushTimeoutMs, 5_000)
      await runWithTimeout(
        waitForWorkflowCompletionsCli({
          handles,
          namespace: resolvedConfig.namespace,
          timeoutMs: completionBudgetMs,
          cliPath,
          address: options.address,
          tlsEnv: {
            TEMPORAL_TLS_CA_PATH: config.tls?.caPath,
            TEMPORAL_TLS_CERT_PATH: config.tls?.certPath,
            TEMPORAL_TLS_KEY_PATH: config.tls?.keyPath,
          },
        }),
        completionBudgetMs,
        `Worker load suite exceeded ${completionBudgetMs}ms without completing`,
      )
      stats.completed = stats.submitted
      stats.completedAt = Date.now()
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
): Promise<WorkflowHandle[]> => {
  const handles: WorkflowHandle[] = []
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

type WorkflowHandle = {
  readonly workflowId: string
  readonly runId: string
}

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

const waitForWorkflowCompletionsCli = async ({
  handles,
  namespace,
  timeoutMs,
  cliPath,
  address,
  tlsEnv,
}: {
  handles: WorkflowHandle[]
  namespace: string
  timeoutMs: number
  cliPath: string
  address: string
  tlsEnv: Record<string, string | undefined>
}): Promise<void> => {
  const deadline = Date.now() + timeoutMs
  const queue = [...handles]
  const workers = Math.min(8, queue.length)

  const describe = async (handle: WorkflowHandle): Promise<void> => {
    while (true) {
      if (Date.now() > deadline) {
        throw new Error(`Timed out waiting for workflow ${handle.workflowId} to complete`)
      }
      const command = [
        cliPath,
        'workflow',
        'describe',
        '--workflow-id',
        handle.workflowId,
        '--run-id',
        handle.runId,
        '--namespace',
        namespace,
        '--output',
        'json',
      ]
      const child = Bun.spawn(command, {
        stdout: 'pipe',
        stderr: 'pipe',
        env: {
          ...process.env,
          TEMPORAL_ADDRESS: address,
          TEMPORAL_NAMESPACE: namespace,
          ...tlsEnv,
        },
      })
      const exitCode = await child.exited
      const stdout = child.stdout ? await readStream(child.stdout) : ''
      const stderr = child.stderr ? await readStream(child.stderr) : ''
      if (exitCode !== 0) {
        console.warn('[temporal-bun-sdk:load] temporal workflow describe failed', {
          command,
          exitCode,
          stderr,
        })
        await sleep(500)
        continue
      }
      try {
        const parsed = JSON.parse(stdout)
        const status = parsed?.workflowExecutionInfo?.status
        if (typeof status === 'string' && status.startsWith('WORKFLOW_EXECUTION_STATUS_')) {
          if (status !== 'WORKFLOW_EXECUTION_STATUS_RUNNING') {
            return
          }
        }
      } catch (error) {
        console.warn('[temporal-bun-sdk:load] failed to parse workflow describe output', {
          workflowId: handle.workflowId,
          runId: handle.runId,
          error,
        })
      }
      await sleep(500)
    }
  }

  await Promise.all(
    Array.from({ length: workers }, async () => {
      while (queue.length > 0) {
        const handle = queue.shift()
        if (!handle) {
          return
        }
        await describe(handle)
      }
    }),
  )
}

const buildWorkflowPlans = (config: WorkerLoadConfig): WorkflowPlan[] => {
  const total = Math.max(1, config.workflowCount)
  let cpuCount = Math.max(1, Math.floor(total * 0.65))
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

const readStream = async (stream: ReadableStream<Uint8Array> | null): Promise<string> => {
  if (!stream) {
    return ''
  }
  const reader = stream.getReader()
  const chunks: Uint8Array[] = []
  while (true) {
    const { done, value } = await reader.read()
    if (done) {
      break
    }
    if (value) {
      chunks.push(value)
    }
  }
  if (chunks.length === 0) {
    return ''
  }
  const size = chunks.reduce((total, chunk) => total + chunk.length, 0)
  const merged = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) {
    merged.set(chunk, offset)
    offset += chunk.length
  }
  return new TextDecoder().decode(merged)
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
