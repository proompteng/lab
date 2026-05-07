import { expect, test } from 'bun:test'
import { Code, ConnectError } from '@connectrpc/connect'
import { Effect } from 'effect'

import { createObservabilityStub, createTestTemporalConfig } from './helpers/observability'
import type { TemporalConfig } from '../src/config'
import type { WorkflowServiceClient } from '../src/worker/runtime'
import { WorkerRuntime } from '../src/worker/runtime'
import { defineWorkflow } from '../src/workflow/definition'

const waitFor = async (predicate: () => boolean, timeoutMs = 2_000): Promise<void> => {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) {
      return
    }
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error('waitFor timed out')
}

const waitForAbort = async (signal?: AbortSignal) => {
  return await new Promise<never>((_, reject) => {
    const abortError = new Error('aborted')
    abortError.name = 'AbortError'
    if (signal?.aborted) {
      reject(abortError)
      return
    }
    signal?.addEventListener('abort', () => reject(abortError), { once: true })
  })
}

test('worker retries transient activity completion RPC failures', async () => {
  const config: TemporalConfig = createTestTemporalConfig({
    taskQueue: 'activity-completion-retry',
    stickySchedulingEnabled: false,
    rpcRetryPolicy: {
      maxAttempts: 2,
      initialDelayMs: 1,
      maxDelayMs: 1,
      backoffCoefficient: 1,
      jitterFactor: 0,
      retryableStatusCodes: [Code.DeadlineExceeded],
    },
  })
  const observability = createObservabilityStub()
  let activityPolls = 0
  let completions = 0
  let failures = 0

  const workflowService: WorkflowServiceClient = {
    pollWorkflowTaskQueue: async (_request, { signal }: { signal?: AbortSignal }) => await waitForAbort(signal),
    pollActivityTaskQueue: async (_request, { signal }: { signal?: AbortSignal }) => {
      activityPolls += 1
      if (activityPolls === 1) {
        return {
          taskToken: new Uint8Array([1, 2, 3]),
          workflowExecution: { workflowId: 'wf-activity-retry', runId: 'run-activity-retry' },
          workflowNamespace: config.namespace,
          workflowType: { name: 'activityRetryWorkflow' },
          activityId: 'activity-1',
          activityType: { name: 'retryActivity' },
          attempt: 1,
        }
      }
      return await waitForAbort(signal)
    },
    getWorkflowExecutionHistory: async () => ({ history: { events: [] }, nextPageToken: new Uint8Array() }),
    respondQueryTaskCompleted: async () => ({}),
    respondWorkflowTaskCompleted: async () => ({}),
    respondWorkflowTaskFailed: async () => ({}),
    respondActivityTaskCompleted: async () => {
      completions += 1
      if (completions === 1) {
        throw new ConnectError('transient activity completion timeout', Code.DeadlineExceeded)
      }
      return {}
    },
    respondActivityTaskFailed: async () => {
      failures += 1
      return {}
    },
    respondActivityTaskCanceled: async () => ({}),
    requestCancelWorkflowExecution: async () => ({}),
    pollWorkflowExecutionUpdate: async () => ({ messages: [] }),
  } as unknown as WorkflowServiceClient

  const runtime = await WorkerRuntime.create({
    config,
    taskQueue: config.taskQueue,
    namespace: config.namespace,
    workflows: [defineWorkflow('activityRetryWorkflow', () => Effect.succeed('ok'))],
    activities: {
      retryActivity: async () => 'activity-complete',
    },
    workflowService,
    logger: observability.services.logger,
    metrics: observability.services.metricsRegistry,
    metricsExporter: observability.services.metricsExporter,
    stickyScheduling: false,
    pollers: { workflow: 0 },
    concurrency: { workflow: 1, activity: 1 },
  })

  const runPromise = runtime.run()
  await waitFor(() => completions >= 2)
  await runtime.shutdown()
  await runPromise

  expect(completions).toBe(2)
  expect(failures).toBe(0)
})

test('worker treats activity completion not-found as already resolved', async () => {
  const config: TemporalConfig = createTestTemporalConfig({
    taskQueue: 'activity-completion-not-found',
    stickySchedulingEnabled: false,
    rpcRetryPolicy: {
      maxAttempts: 2,
      initialDelayMs: 1,
      maxDelayMs: 1,
      backoffCoefficient: 1,
      jitterFactor: 0,
      retryableStatusCodes: [Code.DeadlineExceeded],
    },
  })
  const observability = createObservabilityStub()
  let activityPolls = 0
  let completions = 0
  let failures = 0

  const workflowService: WorkflowServiceClient = {
    pollWorkflowTaskQueue: async (_request, { signal }: { signal?: AbortSignal }) => await waitForAbort(signal),
    pollActivityTaskQueue: async (_request, { signal }: { signal?: AbortSignal }) => {
      activityPolls += 1
      if (activityPolls === 1) {
        return {
          taskToken: new Uint8Array([4, 5, 6]),
          workflowExecution: { workflowId: 'wf-activity-not-found', runId: 'run-activity-not-found' },
          workflowNamespace: config.namespace,
          workflowType: { name: 'activityNotFoundWorkflow' },
          activityId: 'activity-1',
          activityType: { name: 'resolvedActivity' },
          attempt: 1,
        }
      }
      return await waitForAbort(signal)
    },
    getWorkflowExecutionHistory: async () => ({ history: { events: [] }, nextPageToken: new Uint8Array() }),
    respondQueryTaskCompleted: async () => ({}),
    respondWorkflowTaskCompleted: async () => ({}),
    respondWorkflowTaskFailed: async () => ({}),
    respondActivityTaskCompleted: async () => {
      completions += 1
      throw new ConnectError('activity task token already resolved', Code.NotFound)
    },
    respondActivityTaskFailed: async () => {
      failures += 1
      return {}
    },
    respondActivityTaskCanceled: async () => ({}),
    requestCancelWorkflowExecution: async () => ({}),
    pollWorkflowExecutionUpdate: async () => ({ messages: [] }),
  } as unknown as WorkflowServiceClient

  const runtime = await WorkerRuntime.create({
    config,
    taskQueue: config.taskQueue,
    namespace: config.namespace,
    workflows: [defineWorkflow('activityNotFoundWorkflow', () => Effect.succeed('ok'))],
    activities: {
      resolvedActivity: async () => 'already-completed',
    },
    workflowService,
    logger: observability.services.logger,
    metrics: observability.services.metricsRegistry,
    metricsExporter: observability.services.metricsExporter,
    stickyScheduling: false,
    pollers: { workflow: 0 },
    concurrency: { workflow: 1, activity: 1 },
  })

  const runPromise = runtime.run()
  await waitFor(() => activityPolls >= 2)
  await runtime.shutdown()
  await runPromise

  expect(completions).toBe(1)
  expect(failures).toBe(0)
})
