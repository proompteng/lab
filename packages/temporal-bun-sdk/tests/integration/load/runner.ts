import { randomUUID } from 'node:crypto'
import { appendFile, mkdir, rm, writeFile } from 'node:fs/promises'
import { create } from '@bufbuild/protobuf'
import { Code, ConnectError } from '@connectrpc/connect'
import { Effect } from 'effect'

import { createTemporalClient, temporalCallOptions, type TemporalClient } from '../../../src/client'
import { loadTemporalConfig } from '../../../src/config'
import { WorkflowExecutionSchema } from '../../../src/proto/temporal/api/common/v1/message_pb'
import { WorkflowExecutionStatus } from '../../../src/proto/temporal/api/enums/v1/workflow_pb'
import { DescribeWorkflowExecutionRequestSchema } from '../../../src/proto/temporal/api/workflowservice/v1/request_response_pb'
import { WorkerRuntime } from '../../../src/worker/runtime'
import { resolveTemporalCliExecutable } from '../harness'
import { readWorkerLoadConfig, type WorkerLoadConfig } from './config'
import { readMetricsFromFile, summarizeLoadMetrics, type WorkerLoadMetricsSummary } from './metrics'
import {
  workerLoadActivities,
  workerLoadWorkflows,
  type WorkerLoadActivityWorkflowInput,
  type WorkerLoadCpuWorkflowInput,
  type WorkerLoadUpdateWorkflowInput,
} from './workflows'

export interface WorkerLoadRunnerOptions {
  readonly address: string
  readonly namespace: string
  readonly loadConfig?: WorkerLoadConfig
  readonly taskQueuePrefix?: string
}

export interface WorkerLoadRunResult {
  readonly stats: RuntimeStats
  readonly summary: WorkerLoadMetricsSummary
  readonly memorySummary: MemorySummary
  readonly plans: WorkflowPlan[]
  readonly loadConfig: WorkerLoadConfig
}

type ManagedWorkerRuntime = {
  readonly generation: number
  readonly runtime: WorkerRuntime
  readonly runPromise: Promise<void>
}

type RuntimeRestartEvent = {
  readonly reason: 'restart-after-submit'
  readonly startedAt: string
  readonly completedAt: string
  readonly delayMs: number
  readonly previousGeneration: number
  readonly nextGeneration: number
}

type ActivityCancellationEvent = {
  readonly workflowId: string
  readonly runId: string
  readonly requestedAt: string
  readonly completedAt: string
  readonly status: 'requested' | 'failed'
  readonly error?: string
}

type WorkflowCleanupEvent = {
  readonly workflowId: string
  readonly runId: string
  readonly requestedAt: string
  readonly completedAt: string
  readonly status: 'terminated' | 'already-completed' | 'transient-cleanup-failed' | 'failed'
  readonly reason: string
  readonly error?: string
}

type WorkflowUpdateTerminationEvent = {
  readonly workflowId: string
  readonly runId: string
  readonly requestedAt: string
  readonly completedAt: string
  readonly status: 'terminated' | 'already-completed' | 'transient-cleanup-failed'
  readonly error?: string
}

type SerializedError = {
  readonly name: string
  readonly message: string
  readonly stack?: string
}

const prepareArtifactsDir = async (root: string): Promise<string> => {
  await rm(root, { recursive: true, force: true })
  await mkdir(root, { recursive: true })
  return root
}

export const runWorkerLoad = async (options: WorkerLoadRunnerOptions): Promise<WorkerLoadRunResult> => {
  const loadConfig = options.loadConfig ?? readWorkerLoadConfig()
  const artifactsDir = await prepareArtifactsDir(loadConfig.artifactsDir)
  const memoryRecorder = createMemoryRecorder(loadConfig.memoryStreamPath)
  await memoryRecorder.sample('start')
  const stopMemorySampling = startMemorySampling(memoryRecorder, loadConfig.memorySampleIntervalMs)
  const taskQueue = buildTaskQueue(options.taskQueuePrefix ?? loadConfig.workflowTaskQueuePrefix)
  const config = await loadTemporalConfig({
    defaults: {
      address: options.address,
      namespace: options.namespace,
      taskQueue,
      workerWorkflowConcurrency: loadConfig.workflowConcurrencyTarget,
      workerActivityConcurrency: loadConfig.activityConcurrencyTarget,
      workerStickyCacheSize: loadConfig.stickyCacheSize,
      workerStickyTtlMs: loadConfig.stickyTtlMs,
      stickySchedulingEnabled: true,
    },
  })

  const plans = buildWorkflowPlans(loadConfig)
  const stats = createRuntimeStats(plans.length)
  const restartEvents: RuntimeRestartEvent[] = []
  const activityCancellationEvents: ActivityCancellationEvent[] = []
  const workflowCleanupEvents: WorkflowCleanupEvent[] = []
  const updateTerminationEvents: WorkflowUpdateTerminationEvent[] = []
  let runtimeGeneration = 0
  let managedRuntime: ManagedWorkerRuntime | null = null
  let completionResults: WorkflowCompletionResult[] = []
  let completionFailure: SerializedError | undefined
  let submittedHandles: WorkflowHandle[] = []
  let cleanupSubmittedWorkflowsAfterFailure = false
  const completionBudgetMs = calculateLoadCompletionBudgetMs(loadConfig)

  const startRuntime = async (reason: string): Promise<ManagedWorkerRuntime> => {
    runtimeGeneration += 1
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
      workflowGuards: 'warn',
    })
    const generation = runtimeGeneration
    await memoryRecorder.sample('runtime-created', { taskQueue, generation, reason })
    return {
      generation,
      runtime,
      runPromise: runtime.run().catch((error) => {
        console.error('[temporal-bun-sdk:load] worker runtime exited with error', { generation, error })
        throw error
      }),
    }
  }

  const shutdownRuntime = async (
    current: ManagedWorkerRuntime,
    reason: string,
    options: {
      readonly suppressRunFailure?: boolean
      readonly suppressTransientRunFailure?: boolean
    } = {},
  ): Promise<SerializedError | undefined> => {
    await memoryRecorder.sample('before-runtime-shutdown', { generation: current.generation, reason })
    await current.runtime.shutdown()
    let runFailure: SerializedError | undefined
    try {
      await current.runPromise
    } catch (error) {
      if (options.suppressTransientRunFailure && isTransientTemporalUnavailableFailure(error)) {
        await memoryRecorder.sample('runtime-shutdown-transient-failure', {
          generation: current.generation,
          reason,
          error: formatErrorMessage(error),
        })
      } else if (!options.suppressRunFailure) {
        throw error
      } else {
        runFailure = serializeError(error)
      }
    }
    await memoryRecorder.sample('after-runtime-shutdown', { generation: current.generation, reason })
    return runFailure
  }

  managedRuntime = await startRuntime('initial')

  let temporalCliVersion = 'unknown'
  try {
    const cliPath = await Effect.runPromise(resolveTemporalCliExecutable())
    temporalCliVersion = await readTemporalCliVersion(cliPath)
    const { client: temporalClient, config: resolvedConfig } = await createTemporalClient({ config, taskQueue })
    try {
      const submissions = await submitWorkflows(temporalClient, plans, taskQueue, loadConfig)
      await memoryRecorder.sample('workflows-submitted', { submitted: submissions.length })
      const handles = submissions.map((submission) => submission.handle)
      submittedHandles = handles
      if (loadConfig.restartAfterSubmit && managedRuntime) {
        const restartStartedAt = new Date().toISOString()
        const previousGeneration = managedRuntime.generation
        await shutdownRuntime(managedRuntime, 'restart-after-submit')
        managedRuntime = null
        await sleep(loadConfig.restartDelayMs)
        managedRuntime = await startRuntime('restart-after-submit')
        restartEvents.push({
          reason: 'restart-after-submit',
          startedAt: restartStartedAt,
          completedAt: new Date().toISOString(),
          delayMs: loadConfig.restartDelayMs,
          previousGeneration,
          nextGeneration: managedRuntime.generation,
        })
      }
      if (loadConfig.activityCancellationRatio > 0) {
        const cancellationEvents = await cancelActivityWorkflows(temporalClient, submissions, loadConfig)
        activityCancellationEvents.push(...cancellationEvents)
        await memoryRecorder.sample('activity-cancellations-driven', {
          attempted: cancellationEvents.length,
          succeeded: cancellationEvents.filter((event) => event.status === 'requested').length,
        })
      }
      const updateSubmissions = submissions.filter(
        (submission) => submission.plan.workflowType === 'workerLoadUpdateWorkflow',
      )
      if (updateSubmissions.length > 0) {
        const terminationEvents = await driveWorkflowUpdates(temporalClient, updateSubmissions, loadConfig)
        updateTerminationEvents.push(...terminationEvents)
        await memoryRecorder.sample('updates-driven', { updateWorkflows: updateSubmissions.length })
      }
      const observedCompletionResults: WorkflowCompletionResult[] = []
      try {
        const workflowCompletions = waitForWorkflowCompletionsRpc({
          client: temporalClient,
          handles,
          namespace: resolvedConfig.namespace,
          timeoutMs: completionBudgetMs,
          describeConcurrency: loadConfig.workflowDescribeConcurrency,
          onCompletion: (result) => {
            observedCompletionResults.push(result)
          },
        })
        const runtimeCompletionGuard = managedRuntime
          ? failOnRuntimeExitDuringCompletion(managedRuntime)
          : new Promise<never>(() => {})
        completionResults = await runWithTimeout(
          Promise.race([workflowCompletions, runtimeCompletionGuard]),
          completionBudgetMs,
          `Worker load suite exceeded ${completionBudgetMs}ms without completing`,
        )
        stats.completed = stats.submitted
        await memoryRecorder.sample('workflows-completed', { completed: stats.completed })
      } catch (error) {
        completionResults = [...observedCompletionResults]
        completionFailure = serializeError(error)
        cleanupSubmittedWorkflowsAfterFailure = true
        await memoryRecorder.sample('workflow-completion-failed', {
          completed: stats.completed,
          observedTerminalStatuses: completionResults.length,
          error: completionFailure.message,
        })
      }
    } catch (error) {
      cleanupSubmittedWorkflowsAfterFailure = true
      await memoryRecorder.sample('worker-load-failed-before-completion', {
        error: error instanceof Error ? error.message : String(error),
      })
      throw error
    } finally {
      if (cleanupSubmittedWorkflowsAfterFailure && submittedHandles.length > 0) {
        const cleanupStartedAt = new Date().toISOString()
        await memoryRecorder.sample('failure-cleanup-started', {
          submitted: submittedHandles.length,
          observedTerminalStatuses: completionResults.length,
        })
        const cleanupEvents = await cleanupSubmittedWorkflows(
          temporalClient,
          submittedHandles,
          completionResults,
          'worker-load-cleanup-after-failure',
          loadConfig.workflowDescribeConcurrency,
        )
        workflowCleanupEvents.push(...cleanupEvents)
        await memoryRecorder.sample('failure-cleanup-completed', {
          startedAt: cleanupStartedAt,
          attempted: cleanupEvents.length,
          terminated: cleanupEvents.filter((event) => event.status === 'terminated').length,
          alreadyCompleted: cleanupEvents.filter((event) => event.status === 'already-completed').length,
          transientCleanupFailed: cleanupEvents.filter((event) => event.status === 'transient-cleanup-failed').length,
          failed: cleanupEvents.filter((event) => event.status === 'failed').length,
        })
      }
      await temporalClient.shutdown()
      await memoryRecorder.sample('client-shutdown')
    }
  } finally {
    if (managedRuntime) {
      const shutdownFailure = await shutdownRuntime(managedRuntime, 'final', {
        suppressRunFailure: completionFailure !== undefined,
        suppressTransientRunFailure: true,
      })
      if (shutdownFailure && !completionFailure) {
        completionFailure = shutdownFailure
      }
      managedRuntime = null
    }
    stopMemorySampling()
    stats.completedAt = stats.completedAt ?? Date.now()
  }

  const durationMs = Math.max(1, (stats.completedAt ?? Date.now()) - stats.startedAt)
  stats.durationMs = durationMs

  const metrics = await readMetricsFromFile(loadConfig.metricsStreamPath)
  const summary = summarizeLoadMetrics(metrics, {
    durationMs,
    completedWorkflows: stats.completed,
  })
  await memoryRecorder.sample('report-ready', { durationMs, completed: stats.completed })
  await memoryRecorder.flush()
  const memorySummary = summarizeMemorySamples(
    memoryRecorder.samples,
    durationMs,
    loadConfig.memorySlopeMaxMbPerHour,
    loadConfig.memorySlopeMinElapsedMs,
  )
  const scenarioCoverage = plans.reduce<Record<string, number>>((coverage, plan) => {
    coverage[plan.workflowType] = (coverage[plan.workflowType] ?? 0) + 1
    return coverage
  }, {})
  const workflowStatusCounts = summarizeWorkflowStatusCounts(completionResults)
  const activityCancellationTargetIds = new Set(activityCancellationEvents.map((event) => event.workflowId))
  const activityCancellationFinalCanceledCount = completionResults.filter(
    (result) => activityCancellationTargetIds.has(result.workflowId) && result.status === 'CANCELED',
  ).length

  await writeFile(
    loadConfig.metricsReportPath,
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        config: {
          workflowCount: loadConfig.workflowCount,
          workflowConcurrencyTarget: loadConfig.workflowConcurrencyTarget,
          activityConcurrencyTarget: loadConfig.activityConcurrencyTarget,
          stickyCacheSize: loadConfig.stickyCacheSize,
          stickyTtlMs: loadConfig.stickyTtlMs,
          stickyHitRatioTarget: loadConfig.stickyHitRatioTarget,
          restartAfterSubmit: loadConfig.restartAfterSubmit,
          restartDelayMs: loadConfig.restartDelayMs,
          activityCancellationRatio: loadConfig.activityCancellationRatio,
          activityCancellationDelayMs: loadConfig.activityCancellationDelayMs,
          activityHeartbeatTimeoutMs: loadConfig.activityHeartbeatTimeoutMs,
          activityStartToCloseTimeoutMs: loadConfig.activityStartToCloseTimeoutMs,
          activityScheduleToStartTimeoutMs: loadConfig.activityScheduleToStartTimeoutMs,
          activityScheduleToCloseTimeoutMs: loadConfig.activityScheduleToCloseTimeoutMs,
          workflowPollP95TargetMs: loadConfig.workflowPollP95TargetMs,
          activityPollP95TargetMs: loadConfig.activityPollP95TargetMs,
          workflowDescribeConcurrency: loadConfig.workflowDescribeConcurrency,
          workflowDurationBudgetMs: loadConfig.workflowDurationBudgetMs,
          completionBudgetMs,
          metricsFlushTimeoutMs: loadConfig.metricsFlushTimeoutMs,
          throughputFloorPerSecond: loadConfig.throughputFloorPerSecond,
          memorySampleIntervalMs: loadConfig.memorySampleIntervalMs,
          memorySlopeMaxMbPerHour: loadConfig.memorySlopeMaxMbPerHour,
          memorySlopeMinElapsedMs: loadConfig.memorySlopeMinElapsedMs,
        },
        stats,
        completionFailure,
        workflowStatusCounts,
        workflowCompletions: completionResults,
        metrics: summary,
        memory: memorySummary,
        scenarioCoverage,
        failureInjection: {
          restartAfterSubmit: loadConfig.restartAfterSubmit,
          runtimeRestartCount: restartEvents.length,
          restartEvents,
          activityCancellationRatio: loadConfig.activityCancellationRatio,
          activityCancellationDelayMs: loadConfig.activityCancellationDelayMs,
          activityCancellationAttemptCount: activityCancellationEvents.length,
          activityCancellationSuccessCount: activityCancellationEvents.filter((event) => event.status === 'requested').length,
          activityCancellationFinalCanceledCount,
          activityCancellationEvents,
          updateTerminationAttemptCount: updateTerminationEvents.length,
          updateTerminationSuccessCount: updateTerminationEvents.filter((event) => event.status === 'terminated').length,
          updateTerminationAlreadyCompletedCount: updateTerminationEvents.filter(
            (event) => event.status === 'already-completed',
          ).length,
          updateTerminationTransientCleanupFailureCount: updateTerminationEvents.filter(
            (event) => event.status === 'transient-cleanup-failed',
          ).length,
          updateTerminationEvents,
          failureCleanupAttemptCount: workflowCleanupEvents.length,
          failureCleanupTerminatedCount: workflowCleanupEvents.filter((event) => event.status === 'terminated').length,
          failureCleanupAlreadyCompletedCount: workflowCleanupEvents.filter((event) => event.status === 'already-completed').length,
          failureCleanupTransientCleanupFailureCount: workflowCleanupEvents.filter(
            (event) => event.status === 'transient-cleanup-failed',
          ).length,
          failureCleanupFailedCount: workflowCleanupEvents.filter((event) => event.status === 'failed').length,
          workflowCleanupEvents,
        },
        environment: {
          bunVersion: Bun.version,
          platform: process.platform,
          arch: process.arch,
          temporalCliVersion,
          temporalAddress: options.address,
          temporalNamespace: options.namespace,
          taskQueue,
          stickySchedulingEnabled: true,
        },
        artifactsDir,
        metricsPath: loadConfig.metricsStreamPath,
        memoryPath: loadConfig.memoryStreamPath,
      },
      null,
      2,
    ),
    'utf8',
  )

  if (completionFailure) {
    throw new WorkflowCompletionError(`Worker load completion failed: ${completionFailure.message}`)
  }

  const failedWorkflow = completionResults.find((result) => !isAcceptedTerminalWorkflowStatus(result.status))
  if (failedWorkflow) {
    throw new WorkflowCompletionError(
      `Workflow ${failedWorkflow.workflowId} finished with status ${failedWorkflow.status}`,
    )
  }

  return {
    stats,
    summary,
    memorySummary,
    plans,
    loadConfig,
  }
}

export interface MemorySample {
  readonly timestamp: string
  readonly elapsedMs: number
  readonly phase: string
  readonly rssBytes: number
  readonly heapTotalBytes: number
  readonly heapUsedBytes: number
  readonly externalBytes: number
  readonly arrayBuffersBytes: number
  readonly context?: Record<string, string | number | boolean>
}

export interface MemorySummary {
  readonly sampleCount: number
  readonly startedAt: string
  readonly completedAt: string
  readonly elapsedMs: number
  readonly startRssBytes: number
  readonly endRssBytes: number
  readonly maxRssBytes: number
  readonly rssDeltaBytes: number
  readonly heapUsedDeltaBytes: number
  readonly rssSlopeBytesPerHour: number
  readonly rssSlopeMbPerHour: number
  readonly slopeLimitMbPerHour: number
  readonly slopeMinElapsedMs: number
  readonly slopeAssessment: 'passed' | 'failed' | 'insufficient-duration'
  readonly withinSlopeLimit: boolean
}

type MemoryRecorder = {
  readonly samples: MemorySample[]
  sample: (phase: string, context?: Record<string, string | number | boolean>) => Promise<MemorySample>
  flush: () => Promise<void>
}

const createMemoryRecorder = (path: string): MemoryRecorder => {
  const startedAt = Date.now()
  const samples: MemorySample[] = []
  let pendingWrite = Promise.resolve()

  return {
    samples,
    sample: async (phase, context) => {
      const usage = process.memoryUsage()
      const sample: MemorySample = {
        timestamp: new Date().toISOString(),
        elapsedMs: Date.now() - startedAt,
        phase,
        rssBytes: usage.rss,
        heapTotalBytes: usage.heapTotal,
        heapUsedBytes: usage.heapUsed,
        externalBytes: usage.external,
        arrayBuffersBytes: usage.arrayBuffers,
        ...(context ? { context } : {}),
      }
      samples.push(sample)
      pendingWrite = pendingWrite.then(() => appendFile(path, `${JSON.stringify(sample)}\n`, 'utf8'))
      await pendingWrite
      return sample
    },
    flush: () => pendingWrite,
  }
}

const startMemorySampling = (recorder: MemoryRecorder, intervalMs: number): (() => void) => {
  const timer = setInterval(() => {
    void recorder.sample('interval')
  }, intervalMs)
  const maybeNodeTimer = timer as { unref?: () => void }
  if (typeof maybeNodeTimer.unref === 'function') {
    maybeNodeTimer.unref()
  }
  return () => clearInterval(timer)
}

const summarizeMemorySamples = (
  samples: readonly MemorySample[],
  fallbackElapsedMs: number,
  slopeLimitMbPerHour: number,
  slopeMinElapsedMs: number,
): MemorySummary => {
  const first = samples[0]
  const last = samples.at(-1)
  if (!first || !last) {
    return {
      sampleCount: 0,
      startedAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
      elapsedMs: fallbackElapsedMs,
      startRssBytes: 0,
      endRssBytes: 0,
      maxRssBytes: 0,
      rssDeltaBytes: 0,
      heapUsedDeltaBytes: 0,
      rssSlopeBytesPerHour: 0,
      rssSlopeMbPerHour: 0,
      slopeLimitMbPerHour,
      slopeMinElapsedMs,
      slopeAssessment: 'insufficient-duration',
      withinSlopeLimit: true,
    }
  }

  const elapsedMs = Math.max(1, last.elapsedMs - first.elapsedMs, fallbackElapsedMs)
  const rssDeltaBytes = last.rssBytes - first.rssBytes
  const rssSlopeBytesPerHour = rssDeltaBytes * (3_600_000 / elapsedMs)
  const rssSlopeMbPerHour = rssSlopeBytesPerHour / (1024 * 1024)
  const slopeAssessment =
    elapsedMs < slopeMinElapsedMs ? 'insufficient-duration' : rssSlopeMbPerHour <= slopeLimitMbPerHour ? 'passed' : 'failed'

  return {
    sampleCount: samples.length,
    startedAt: first.timestamp,
    completedAt: last.timestamp,
    elapsedMs,
    startRssBytes: first.rssBytes,
    endRssBytes: last.rssBytes,
    maxRssBytes: Math.max(...samples.map((sample) => sample.rssBytes)),
    rssDeltaBytes,
    heapUsedDeltaBytes: last.heapUsedBytes - first.heapUsedBytes,
    rssSlopeBytesPerHour,
    rssSlopeMbPerHour,
    slopeLimitMbPerHour,
    slopeMinElapsedMs,
    slopeAssessment,
    withinSlopeLimit: slopeAssessment !== 'failed',
  }
}

const submitWorkflows = async (
  client: TemporalClient,
  plans: WorkflowPlan[],
  taskQueue: string,
  config: WorkerLoadConfig,
): Promise<SubmittedWorkflow[]> => {
  const submissions: SubmittedWorkflow[] = []
  for (const plan of plans) {
    const result = await client.startWorkflow({
      workflowId: plan.id,
      workflowType: plan.workflowType,
      taskQueue,
      args: [plan.input],
      workflowTaskTimeoutMs: config.workflowDurationBudgetMs,
    })
    submissions.push({ plan, handle: { workflowId: result.workflowId, runId: result.runId } })
  }
  return submissions
}

const driveWorkflowUpdates = async (
  client: TemporalClient,
  submissions: SubmittedWorkflow[],
  config: WorkerLoadConfig,
): Promise<WorkflowUpdateTerminationEvent[]> => {
  if (submissions.length === 0 || config.updatesPerWorkflow <= 0) {
    return []
  }
  const terminationEvents = await Promise.all(
    submissions.map(async ({ handle }) => {
      const workflowHandle = { workflowId: handle.workflowId, runId: handle.runId }
      const requestedAt = new Date().toISOString()
      let phase: 'updates' | 'termination' = 'updates'
      try {
        for (let index = 0; index < config.updatesPerWorkflow; index += 1) {
          await client.workflow.update(workflowHandle, {
            updateName: 'workerLoad.setStatus',
            args: [{ status: `phase-${index}` }],
            waitForStage: 'completed',
          })
        }
        await client.workflow.update(workflowHandle, {
          updateName: 'workerLoad.delayedSetStatus',
          args: [{ status: 'delayed', delayMs: config.updateDelayMs }],
          waitForStage: 'completed',
        })
        try {
          await client.workflow.update(workflowHandle, {
            updateName: 'workerLoad.guardStatus',
            args: [{ level: -1 }],
            waitForStage: 'completed',
          })
        } catch (error) {
          if (isWorkflowAlreadyCompletedForTermination(error)) {
            throw error
          }
          // Intentionally provoke a validation failure to exercise rejection paths.
        }
        await client.workflow.update(workflowHandle, {
          updateName: 'workerLoad.guardStatus',
          args: [{ level: 1 }],
          waitForStage: 'completed',
        })
        // After exercising update flows, terminate to keep the load suite bounded.
        phase = 'termination'
        await client.workflow.terminate(workflowHandle, { reason: 'worker-load-finish' })
        return {
          workflowId: handle.workflowId,
          runId: handle.runId,
          requestedAt,
          completedAt: new Date().toISOString(),
          status: 'terminated' as const,
        }
      } catch (error) {
        if (isWorkflowAlreadyCompletedForTermination(error)) {
          return {
            workflowId: handle.workflowId,
            runId: handle.runId,
            requestedAt,
            completedAt: new Date().toISOString(),
            status: 'already-completed' as const,
            error: error instanceof Error ? error.message : String(error),
          }
        }
        if (phase === 'termination' && isTransientWorkflowTerminationCleanupFailure(error)) {
          return {
            workflowId: handle.workflowId,
            runId: handle.runId,
            requestedAt,
            completedAt: new Date().toISOString(),
            status: 'transient-cleanup-failed' as const,
            error: error instanceof Error ? error.message : String(error),
          }
        }
        throw error
      }
    }),
  )
  return terminationEvents
}

const unwrapErrorChain = (error: unknown, seen = new Set<unknown>()): unknown[] => {
  if (!error || (typeof error !== 'object' && typeof error !== 'function')) {
    return [error]
  }
  if (seen.has(error)) {
    return [error]
  }
  seen.add(error)

  const values: unknown[] = [error]
  const candidate = error as { _tag?: string; cause?: unknown; error?: unknown; message?: unknown }
  if (candidate._tag === 'UnknownException') {
    if (candidate.cause !== undefined) {
      values.push(...unwrapErrorChain(candidate.cause, seen))
    }
    if (candidate.error !== undefined) {
      values.push(...unwrapErrorChain(candidate.error, seen))
    }
  } else if (candidate.cause !== undefined) {
    values.push(...unwrapErrorChain(candidate.cause, seen))
  }

  return values
}

const isWorkflowAlreadyCompletedForTermination = (error: unknown): boolean =>
  unwrapErrorChain(error).some((candidate) => {
    let message: string
    if (candidate instanceof Error) {
      message = candidate.message
    } else if (typeof candidate === 'object' && candidate && 'message' in candidate) {
      message = String((candidate as { message?: unknown }).message)
    } else {
      message = String(candidate)
    }

    if (!/workflow execution already completed/i.test(message)) {
      return false
    }
    return !(candidate instanceof ConnectError) || candidate.code === Code.NotFound
  })

const isTransientWorkflowTerminationCleanupFailure = (error: unknown): boolean =>
  isTransientTemporalUnavailableFailure(error)

const isTransientTemporalUnavailableFailure = (error: unknown): boolean =>
  unwrapErrorChain(error).some((candidate) => {
    let message: string
    if (candidate instanceof Error) {
      message = candidate.message
    } else if (typeof candidate === 'object' && candidate && 'message' in candidate) {
      message = String((candidate as { message?: unknown }).message)
    } else {
      message = String(candidate)
    }

    if (!/shard status unknown|service unavailable|temporarily unavailable|not enough hosts to serve the request/i.test(message)) {
      return false
    }
    return candidate instanceof ConnectError ? candidate.code === Code.Unavailable : true
  })

const cancelActivityWorkflows = async (
  client: TemporalClient,
  submissions: SubmittedWorkflow[],
  config: WorkerLoadConfig,
): Promise<ActivityCancellationEvent[]> => {
  const candidates = submissions.filter((submission) => submission.plan.workflowType === 'workerLoadActivityWorkflow')
  if (candidates.length === 0) {
    return []
  }

  const targetCount = Math.max(1, Math.ceil(candidates.length * config.activityCancellationRatio))
  const targets = candidates.slice(0, targetCount)
  await sleep(config.activityCancellationDelayMs)

  return await Promise.all(
    targets.map(async ({ handle }) => {
      const requestedAt = new Date().toISOString()
      try {
        await client.workflow.cancel(handle)
        return {
          workflowId: handle.workflowId,
          runId: handle.runId,
          requestedAt,
          completedAt: new Date().toISOString(),
          status: 'requested' as const,
        }
      } catch (error) {
        return {
          workflowId: handle.workflowId,
          runId: handle.runId,
          requestedAt,
          completedAt: new Date().toISOString(),
          status: 'failed' as const,
          error: error instanceof Error ? error.message : String(error),
        }
      }
    }),
  )
}

const cleanupSubmittedWorkflows = async (
  client: TemporalClient,
  handles: readonly WorkflowHandle[],
  completionResults: readonly WorkflowCompletionResult[],
  reason: string,
  concurrency: number,
): Promise<WorkflowCleanupEvent[]> => {
  const terminalWorkflowKeys = new Set(
    completionResults.filter((result) => isAcceptedTerminalWorkflowStatus(result.status)).map(workflowHandleKey),
  )
  const targets = handles.filter((handle) => !terminalWorkflowKeys.has(workflowHandleKey(handle)))
  if (targets.length === 0) {
    return []
  }

  const queue = [...targets]
  const workerCount = Math.min(Math.max(1, concurrency), queue.length)
  const events: WorkflowCleanupEvent[] = []
  await Promise.all(
    Array.from({ length: workerCount }, async () => {
      while (queue.length > 0) {
        const handle = queue.shift()
        if (!handle) {
          return
        }

        const requestedAt = new Date().toISOString()
        try {
          await client.workflow.terminate(handle, { reason })
          events.push({
            workflowId: handle.workflowId,
            runId: handle.runId,
            requestedAt,
            completedAt: new Date().toISOString(),
            status: 'terminated',
            reason,
          })
        } catch (error) {
          if (isWorkflowAlreadyCompletedForTermination(error)) {
            events.push({
              workflowId: handle.workflowId,
              runId: handle.runId,
              requestedAt,
              completedAt: new Date().toISOString(),
              status: 'already-completed',
              reason,
              error: error instanceof Error ? error.message : String(error),
            })
          } else if (isTransientWorkflowTerminationCleanupFailure(error)) {
            events.push({
              workflowId: handle.workflowId,
              runId: handle.runId,
              requestedAt,
              completedAt: new Date().toISOString(),
              status: 'transient-cleanup-failed',
              reason,
              error: error instanceof Error ? error.message : String(error),
            })
          } else {
            events.push({
              workflowId: handle.workflowId,
              runId: handle.runId,
              requestedAt,
              completedAt: new Date().toISOString(),
              status: 'failed',
              reason,
              error: error instanceof Error ? error.message : String(error),
            })
          }
        }
      }
    }),
  )
  return events
}

const workflowHandleKey = (handle: WorkflowHandle): string => `${handle.workflowId}/${handle.runId}`

type WorkflowHandle = {
  readonly workflowId: string
  readonly runId: string
}

type WorkflowCompletionResult = WorkflowHandle & {
  readonly status: string
}

class WorkflowCompletionError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'WorkflowCompletionError'
  }
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

const failOnRuntimeExitDuringCompletion = async (managedRuntime: ManagedWorkerRuntime): Promise<never> => {
  try {
    await managedRuntime.runPromise
  } catch (error) {
    throw new Error(`Worker runtime exited before load workflows completed: ${formatErrorMessage(error)}`, {
      cause: error,
    })
  }
  throw new Error(`Worker runtime stopped before load workflows completed`)
}

const waitForWorkflowCompletionsRpc = async ({
  client,
  handles,
  namespace,
  timeoutMs,
  describeConcurrency,
  onCompletion,
}: {
  client: TemporalClient
  handles: WorkflowHandle[]
  namespace: string
  timeoutMs: number
  describeConcurrency: number
  onCompletion?: (result: WorkflowCompletionResult) => void
}): Promise<WorkflowCompletionResult[]> => {
  const deadline = Date.now() + timeoutMs
  const queue = [...handles]
  const workers = Math.min(Math.max(1, describeConcurrency), queue.length)
  const completions: WorkflowCompletionResult[] = []
  const rpcTimeoutMs = Math.min(10_000, Math.max(1_000, Math.floor(timeoutMs / 4)))

  const describe = async (handle: WorkflowHandle): Promise<WorkflowCompletionResult> => {
    while (true) {
      if (Date.now() > deadline) {
        throw new Error(`Timed out waiting for workflow ${handle.workflowId} to complete`)
      }
      try {
        const response = await client.rpc.workflow.call(
          'describeWorkflowExecution',
          create(DescribeWorkflowExecutionRequestSchema, {
            namespace,
            execution: create(WorkflowExecutionSchema, {
              workflowId: handle.workflowId,
              runId: handle.runId ?? '',
            }),
          }),
          temporalCallOptions({ timeoutMs: rpcTimeoutMs }),
        )
        const statusField = response.workflowExecutionInfo?.status
        const normalizedStatus = normalizeWorkflowStatus(statusField)
        if (normalizedStatus === 'RUNNING') {
          await sleep(500)
          continue
        }
        if (normalizedStatus && normalizedStatus !== 'RUNNING') {
          return { ...handle, status: normalizedStatus }
        }
        throw new Error(`Workflow ${handle.workflowId} has unknown status ${String(statusField)}`)
      } catch (error) {
        console.warn('[temporal-bun-sdk:load] workflow describe RPC failed', {
          workflowId: handle.workflowId,
          runId: handle.runId,
          error,
        })
        await sleep(500)
      }
    }
  }

  await Promise.all(
    Array.from({ length: workers }, async () => {
      while (queue.length > 0) {
        const handle = queue.shift()
        if (!handle) {
          return
        }
        const completion = await describe(handle)
        completions.push(completion)
        onCompletion?.(completion)
      }
    }),
  )
  return completions
}

export type LoadCompletionBudgetConfig = Pick<WorkerLoadConfig, 'workflowDurationBudgetMs' | 'metricsFlushTimeoutMs'> &
  Partial<
    Pick<
      WorkerLoadConfig,
      | 'activityScheduleToCloseTimeoutMs'
      | 'activityScheduleToStartTimeoutMs'
      | 'activityStartToCloseTimeoutMs'
      | 'workflowCount'
      | 'workflowDescribeConcurrency'
    >
  >

export const calculateLoadCompletionBudgetMs = (config: LoadCompletionBudgetConfig): number => {
  const activityTimeoutBudgetMs = Math.max(
    config.activityScheduleToCloseTimeoutMs ?? 0,
    (config.activityScheduleToStartTimeoutMs ?? 0) + (config.activityStartToCloseTimeoutMs ?? 0),
  )
  const workflowCompletionBudgetMs = Math.max(config.workflowDurationBudgetMs, activityTimeoutBudgetMs)
  const describeDrainBudgetMs =
    typeof config.workflowCount === 'number'
      ? Math.ceil(
          Math.max(1, config.workflowCount) /
            Math.max(1, config.workflowDescribeConcurrency ?? config.workflowCount),
        ) * 10_000
      : 0
  const flushAndDescribeBudgetMs = Math.max(config.metricsFlushTimeoutMs, 5_000, describeDrainBudgetMs)
  return workflowCompletionBudgetMs + flushAndDescribeBudgetMs
}

export const calculateWorkerLoadTestTimeoutBudgetMs = (
  config: LoadCompletionBudgetConfig,
  harnessMarginMs = 15_000,
): number => calculateLoadCompletionBudgetMs(config) + harnessMarginMs

const isAcceptedTerminalWorkflowStatus = (status: string): boolean =>
  status === 'COMPLETED' || status === 'TERMINATED' || status === 'CANCELED'

const summarizeWorkflowStatusCounts = (results: readonly WorkflowCompletionResult[]): Record<string, number> => {
  const counts: Record<string, number> = {}
  for (const result of results) {
    counts[result.status] = (counts[result.status] ?? 0) + 1
  }
  return counts
}

type SubmittedWorkflow = {
  readonly plan: WorkflowPlan
  readonly handle: WorkflowHandle
}

const buildWorkflowPlans = (config: WorkerLoadConfig): WorkflowPlan[] => {
  const total = Math.max(1, config.workflowCount)
  let updateCount = Math.floor(total * config.updateWorkflowRatio)
  if (config.updateWorkflowRatio > 0 && updateCount === 0 && total > 0) {
    updateCount = 1
  }
  if (updateCount >= total) {
    updateCount = Math.max(0, total - 1)
  }
  updateCount = Math.max(0, updateCount)

  const remaining = Math.max(0, total - updateCount)
  let cpuCount = Math.floor(remaining * 0.65)
  let activityCount = remaining - cpuCount
  if (activityCount <= 0 && remaining > 0) {
    activityCount = 1
    cpuCount = Math.max(0, remaining - activityCount)
  }
  if (remaining === 0 && total > 0 && updateCount === 0) {
    cpuCount = Math.max(1, total)
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
        activityHeartbeatTimeoutMs: config.activityHeartbeatTimeoutMs,
        activityStartToCloseTimeoutMs: config.activityStartToCloseTimeoutMs,
        activityScheduleToStartTimeoutMs: config.activityScheduleToStartTimeoutMs,
        activityScheduleToCloseTimeoutMs: config.activityScheduleToCloseTimeoutMs,
      },
    })
  }
  for (let index = 0; index < updateCount; index += 1) {
    plans.push({
      id: `worker-load-update-${index}-${randomUUID()}`,
      workflowType: 'workerLoadUpdateWorkflow',
      input: {
        cycles: Math.max(2, config.cpuRounds),
        holdMs: Math.max(250, config.timerDelayMs * 2),
        delayMs: Math.max(50, config.updateDelayMs),
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
      stats.completed = Math.min(stats.submitted, stats.completed + 1)
      if (stats.completed === stats.submitted) {
        stats.completedAt = stats.completedAt ?? Date.now()
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

const normalizeWorkflowStatus = (status: unknown): string | undefined => {
  if (typeof status === 'number') {
    return workflowExecutionStatusNames[status]
  }
  if (typeof status !== 'string') {
    return undefined
  }
  if (status.startsWith('WORKFLOW_EXECUTION_STATUS_')) {
    return status.replace('WORKFLOW_EXECUTION_STATUS_', '')
  }
  return status.toUpperCase()
}

const serializeError = (error: unknown): SerializedError => {
  if (error instanceof Error) {
    return {
      name: error.name || 'Error',
      message: error.message,
      ...(error.stack ? { stack: error.stack } : {}),
    }
  }
  return {
    name: 'NonError',
    message: String(error),
  }
}

const formatErrorMessage = (error: unknown): string => {
  if (error instanceof Error) {
    return error.message
  }
  return String(error)
}

const workflowExecutionStatusNames: Record<number, string> = {
  [WorkflowExecutionStatus.RUNNING]: 'RUNNING',
  [WorkflowExecutionStatus.COMPLETED]: 'COMPLETED',
  [WorkflowExecutionStatus.FAILED]: 'FAILED',
  [WorkflowExecutionStatus.CANCELED]: 'CANCELED',
  [WorkflowExecutionStatus.TERMINATED]: 'TERMINATED',
  [WorkflowExecutionStatus.CONTINUED_AS_NEW]: 'CONTINUED_AS_NEW',
  [WorkflowExecutionStatus.TIMED_OUT]: 'TIMED_OUT',
  [WorkflowExecutionStatus.PAUSED]: 'PAUSED',
}

export const __workerLoadTestHooks = {
  calculateLoadCompletionBudgetMs,
  calculateWorkerLoadTestTimeoutBudgetMs,
  cleanupSubmittedWorkflows,
  driveWorkflowUpdates,
  isWorkflowAlreadyCompletedForTermination,
  isTransientWorkflowTerminationCleanupFailure,
  normalizeWorkflowStatus,
}

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

const readTemporalCliVersion = async (cliPath: string): Promise<string> => {
  const child = Bun.spawn([cliPath, '--version'], {
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const exitCode = await child.exited
  const stdout = child.stdout ? await readStream(child.stdout) : ''
  const stderr = child.stderr ? await readStream(child.stderr) : ''
  if (exitCode !== 0) {
    return `unknown (${stderr.trim() || stdout.trim() || `exit ${exitCode}`})`
  }
  return stdout.trim() || stderr.trim() || 'unknown'
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
  | {
      readonly id: string
      readonly workflowType: 'workerLoadUpdateWorkflow'
      readonly input: WorkerLoadUpdateWorkflowInput
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
