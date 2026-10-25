import { expect, test } from 'bun:test'
import { create } from '@bufbuild/protobuf'
import { Code, ConnectError } from '@connectrpc/connect'
import { Effect } from 'effect'

import { createObservabilityStub, createTestTemporalConfig } from './helpers/observability'
import type { TemporalConfig } from '../src/config'
import { currentActivityContext } from '../src/worker/activity-context'
import type { WorkflowServiceClient } from '../src/worker/runtime'
import { WorkerRuntime } from '../src/worker/runtime'
import { defineWorkflow } from '../src/workflow/definition'
import { PollActivityTaskQueueResponseSchema, type RespondActivityTaskFailedRequest } from '../src/proto/temporal/api/workflowservice/v1/request_response_pb'

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


test('worker leaves retryable activity errors to Temporal when backoff exceeds the attempt timeout', async () => {
  const config = createTestTemporalConfig({ stickySchedulingEnabled: false })
  const observability = createObservabilityStub()
  let polls = 0
  let invocations = 0
  const failures: RespondActivityTaskFailedRequest[] = []
  const now = Date.now()
  const timestamp = { seconds: BigInt(Math.floor(now / 1000)), nanos: (now % 1000) * 1_000_000 }
  const workflowService = {
    pollWorkflowTaskQueue: async (_request: unknown, { signal }: { signal?: AbortSignal }) =>
      await waitForAbort(signal),
    pollActivityTaskQueue: async (_request: unknown, { signal }: { signal?: AbortSignal }) => {
      if (polls++ > 0) return await waitForAbort(signal)
      return create(PollActivityTaskQueueResponseSchema, {
        taskToken: new Uint8Array([21]),
        workflowExecution: { workflowId: 'retry-deadline', runId: 'run-1' },
        activityId: 'activity-1',
        activityType: { name: 'failOnce' },
        attempt: 1,
        scheduledTime: timestamp,
        startedTime: timestamp,
        startToCloseTimeout: { seconds: 1n },
        scheduleToCloseTimeout: { seconds: 10n },
        retryPolicy: { initialInterval: { seconds: 2n }, maximumAttempts: 3, backoffCoefficient: 1 },
      })
    },
    respondActivityTaskFailed: async (request: RespondActivityTaskFailedRequest) => {
      failures.push(request)
      return {}
    },
  } as unknown as WorkflowServiceClient
  const runtime = await WorkerRuntime.create({
    config,
    workflowService,
    workflows: [defineWorkflow('retryDeadline', () => Effect.void)],
    activities: {
      failOnce: async () => {
        invocations += 1
        throw new Error('temporary failure')
      },
    },
    logger: observability.services.logger,
    metrics: observability.services.metricsRegistry,
    metricsExporter: observability.services.metricsExporter,
    pollers: { workflow: 0 },
  })
  const running = runtime.run()
  try {
    await waitFor(() => failures.length > 0)
    expect(invocations).toBe(1)
    const failure = failures[0]?.failure?.failureInfo
    expect(failure?.case).toBe('applicationFailureInfo')
    if (failure?.case !== 'applicationFailureInfo') throw new Error('Activity failure missing')
    expect(failure.value.nonRetryable).toBe(false)
  } finally {
    await runtime.shutdown()
    await running
  }
})

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

test('worker treats heartbeat not-found as activity cancellation', async () => {
  const config: TemporalConfig = createTestTemporalConfig({
    taskQueue: 'activity-heartbeat-not-found',
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
  let heartbeats = 0
  let cancellations = 0
  let completions = 0
  let failures = 0

  const workflowService: WorkflowServiceClient = {
    pollWorkflowTaskQueue: async (_request, { signal }: { signal?: AbortSignal }) => await waitForAbort(signal),
    pollActivityTaskQueue: async (_request, { signal }: { signal?: AbortSignal }) => {
      activityPolls += 1
      if (activityPolls === 1) {
        return {
          taskToken: new Uint8Array([7, 8, 9]),
          workflowExecution: { workflowId: 'wf-heartbeat-not-found', runId: 'run-heartbeat-not-found' },
          workflowNamespace: config.namespace,
          workflowType: { name: 'activityHeartbeatNotFoundWorkflow' },
          activityId: 'activity-1',
          activityType: { name: 'heartbeatNotFoundActivity' },
          attempt: 1,
        }
      }
      return await waitForAbort(signal)
    },
    getWorkflowExecutionHistory: async () => ({ history: { events: [] }, nextPageToken: new Uint8Array() }),
    recordActivityTaskHeartbeat: async () => {
      heartbeats += 1
      throw new ConnectError('activity task token already resolved', Code.NotFound)
    },
    respondQueryTaskCompleted: async () => ({}),
    respondWorkflowTaskCompleted: async () => ({}),
    respondWorkflowTaskFailed: async () => ({}),
    respondActivityTaskCompleted: async () => {
      completions += 1
      return {}
    },
    respondActivityTaskFailed: async () => {
      failures += 1
      return {}
    },
    respondActivityTaskCanceled: async () => {
      cancellations += 1
      return {}
    },
    requestCancelWorkflowExecution: async () => ({}),
    pollWorkflowExecutionUpdate: async () => ({ messages: [] }),
  } as unknown as WorkflowServiceClient

  const runtime = await WorkerRuntime.create({
    config,
    taskQueue: config.taskQueue,
    namespace: config.namespace,
    workflows: [defineWorkflow('activityHeartbeatNotFoundWorkflow', () => Effect.succeed('ok'))],
    activities: {
      heartbeatNotFoundActivity: async () => {
        const context = currentActivityContext()
        if (!context) {
          throw new Error('missing activity context')
        }
        await context.heartbeat({ step: 'heartbeat-not-found' })
        return 'should-not-complete'
      },
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
  await waitFor(() => cancellations >= 1 || failures >= 1 || completions >= 1)
  await runtime.shutdown()
  await runPromise

  expect(heartbeats).toBe(1)
  expect(cancellations).toBe(1)
  expect(completions).toBe(0)
  expect(failures).toBe(0)
})

test('worker suppresses retryable heartbeat RPC failures so activity retry policy remains server-owned', async () => {
  const config: TemporalConfig = createTestTemporalConfig({
    taskQueue: 'activity-heartbeat-transient',
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
  let heartbeats = 0
  let cancellations = 0
  let completions = 0
  let failures = 0

  const workflowService: WorkflowServiceClient = {
    pollWorkflowTaskQueue: async (_request, { signal }: { signal?: AbortSignal }) => await waitForAbort(signal),
    pollActivityTaskQueue: async (_request, { signal }: { signal?: AbortSignal }) => {
      activityPolls += 1
      if (activityPolls === 1) {
        return {
          taskToken: new Uint8Array([10, 11, 12]),
          workflowExecution: { workflowId: 'wf-heartbeat-transient', runId: 'run-heartbeat-transient' },
          workflowNamespace: config.namespace,
          workflowType: { name: 'activityHeartbeatTransientWorkflow' },
          activityId: 'activity-1',
          activityType: { name: 'heartbeatTransientActivity' },
          attempt: 1,
        }
      }
      return await waitForAbort(signal)
    },
    getWorkflowExecutionHistory: async () => ({ history: { events: [] }, nextPageToken: new Uint8Array() }),
    recordActivityTaskHeartbeat: async () => {
      heartbeats += 1
      throw new ConnectError('[unavailable] shard status unknown', Code.Unavailable)
    },
    respondQueryTaskCompleted: async () => ({}),
    respondWorkflowTaskCompleted: async () => ({}),
    respondWorkflowTaskFailed: async () => ({}),
    respondActivityTaskCompleted: async () => {
      completions += 1
      return {}
    },
    respondActivityTaskFailed: async () => {
      failures += 1
      return {}
    },
    respondActivityTaskCanceled: async () => {
      cancellations += 1
      return {}
    },
    requestCancelWorkflowExecution: async () => ({}),
    pollWorkflowExecutionUpdate: async () => ({ messages: [] }),
  } as unknown as WorkflowServiceClient

  const runtime = await WorkerRuntime.create({
    config,
    taskQueue: config.taskQueue,
    namespace: config.namespace,
    workflows: [defineWorkflow('activityHeartbeatTransientWorkflow', () => Effect.succeed('ok'))],
    activities: {
      heartbeatTransientActivity: async () => {
        const context = currentActivityContext()
        if (!context) {
          throw new Error('missing activity context')
        }
        await context.heartbeat({ step: 'heartbeat-transient' })
        return 'completed-after-transient-heartbeat'
      },
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
  await waitFor(() => completions >= 1 || failures >= 1 || cancellations >= 1, 7_000)
  await runtime.shutdown()
  await runPromise

  expect(heartbeats).toBeGreaterThanOrEqual(1)
  expect(completions).toBe(1)
  expect(cancellations).toBe(0)
  expect(failures).toBe(0)
})
