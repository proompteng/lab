import { expect, test } from 'bun:test'
import { Effect } from 'effect'

import { createObservabilityStub, createTestTemporalConfig } from './helpers/observability'
import type { TemporalConfig } from '../src/config'
import { TaskQueueKind } from '../src/proto/temporal/api/enums/v1/task_queue_pb'
import type {
  PollActivityTaskQueueRequest,
  PollWorkflowTaskQueueRequest,
} from '../src/proto/temporal/api/workflowservice/v1/request_response_pb'
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

test('worker poll RPCs send NORMAL task queue kind for workflow and activity polls', async () => {
  const config: TemporalConfig = createTestTemporalConfig({
    taskQueue: 'queue-kind-normal',
    stickySchedulingEnabled: false,
  })
  const observability = createObservabilityStub()
  const workflowPolls: PollWorkflowTaskQueueRequest[] = []
  const activityPolls: PollActivityTaskQueueRequest[] = []

  const workflowService: WorkflowServiceClient = {
    pollWorkflowTaskQueue: async (request, { signal }: { signal?: AbortSignal }) => {
      workflowPolls.push(request)
      return await waitForAbort(signal)
    },
    pollActivityTaskQueue: async (request, { signal }: { signal?: AbortSignal }) => {
      activityPolls.push(request)
      return await waitForAbort(signal)
    },
    getWorkflowExecutionHistory: async () => ({ history: { events: [] }, nextPageToken: new Uint8Array() }),
    respondQueryTaskCompleted: async () => ({}),
    respondWorkflowTaskCompleted: async () => ({}),
    respondWorkflowTaskFailed: async () => ({}),
    respondActivityTaskCompleted: async () => ({}),
    respondActivityTaskFailed: async () => ({}),
    respondActivityTaskCanceled: async () => ({}),
    requestCancelWorkflowExecution: async () => ({}),
    pollWorkflowExecutionUpdate: async () => ({ messages: [] }),
  } as unknown as WorkflowServiceClient

  const runtime = await WorkerRuntime.create({
    config,
    taskQueue: config.taskQueue,
    namespace: config.namespace,
    workflows: [defineWorkflow('taskQueueKindWorkflow', () => Effect.succeed('ok'))],
    activities: {
      noop: async () => undefined,
    },
    workflowService,
    logger: observability.services.logger,
    metrics: observability.services.metricsRegistry,
    metricsExporter: observability.services.metricsExporter,
    stickyScheduling: false,
    pollers: { workflow: 1 },
    concurrency: { workflow: 1, activity: 1 },
  })

  const runPromise = runtime.run()
  await waitFor(() => workflowPolls.length > 0 && activityPolls.length > 0)
  await runtime.shutdown()
  await runPromise

  const [workflowPoll] = workflowPolls
  expect(workflowPoll).toBeDefined()
  expect(workflowPoll.taskQueue?.name).toBe(config.taskQueue)
  expect(workflowPoll.taskQueue?.kind).toBe(TaskQueueKind.NORMAL)
  expect(workflowPoll.taskQueue?.normalName ?? '').toBe('')

  const [activityPoll] = activityPolls
  expect(activityPoll).toBeDefined()
  expect(activityPoll.taskQueue?.name).toBe(config.taskQueue)
  expect(activityPoll.taskQueue?.kind).toBe(TaskQueueKind.NORMAL)
  expect(activityPoll.taskQueue?.normalName ?? '').toBe('')
})

test('worker sticky poll RPCs send STICKY task queue kind with normalName', async () => {
  const config: TemporalConfig = createTestTemporalConfig({
    taskQueue: 'queue-kind-sticky',
    stickySchedulingEnabled: true,
  })
  const observability = createObservabilityStub()
  const workflowPolls: PollWorkflowTaskQueueRequest[] = []

  const workflowService: WorkflowServiceClient = {
    pollWorkflowTaskQueue: async (request, { signal }: { signal?: AbortSignal }) => {
      workflowPolls.push(request)
      return await waitForAbort(signal)
    },
    pollActivityTaskQueue: async (_request, { signal }: { signal?: AbortSignal }) => {
      return await waitForAbort(signal)
    },
    getWorkflowExecutionHistory: async () => ({ history: { events: [] }, nextPageToken: new Uint8Array() }),
    respondQueryTaskCompleted: async () => ({}),
    respondWorkflowTaskCompleted: async () => ({}),
    respondWorkflowTaskFailed: async () => ({}),
    respondActivityTaskCompleted: async () => ({}),
    respondActivityTaskFailed: async () => ({}),
    respondActivityTaskCanceled: async () => ({}),
    requestCancelWorkflowExecution: async () => ({}),
    pollWorkflowExecutionUpdate: async () => ({ messages: [] }),
  } as unknown as WorkflowServiceClient

  const runtime = await WorkerRuntime.create({
    config,
    taskQueue: config.taskQueue,
    namespace: config.namespace,
    workflows: [defineWorkflow('stickyTaskQueueKindWorkflow', () => Effect.succeed('ok'))],
    workflowService,
    logger: observability.services.logger,
    metrics: observability.services.metricsRegistry,
    metricsExporter: observability.services.metricsExporter,
    stickyScheduling: true,
    pollers: { workflow: 1 },
    concurrency: { workflow: 1, activity: 0 },
  })

  const runPromise = runtime.run()
  await waitFor(() => workflowPolls.length >= 2)
  await runtime.shutdown()
  await runPromise

  const normalPoll = workflowPolls.find((poll) => poll.taskQueue?.name === config.taskQueue)
  expect(normalPoll).toBeDefined()
  expect(normalPoll?.taskQueue?.kind).toBe(TaskQueueKind.NORMAL)
  expect(normalPoll?.taskQueue?.normalName ?? '').toBe('')

  const stickyPoll = workflowPolls.find((poll) => poll.taskQueue?.name !== config.taskQueue)
  expect(stickyPoll).toBeDefined()
  expect(stickyPoll?.taskQueue?.kind).toBe(TaskQueueKind.STICKY)
  expect(stickyPoll?.taskQueue?.normalName).toBe(config.taskQueue)
})
