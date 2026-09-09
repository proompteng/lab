import { expect, test } from 'bun:test'
import { Effect } from 'effect'
import * as Schema from 'effect/Schema'

import { createObservabilityStub, createTestTemporalConfig } from './helpers/observability'
import type { TemporalConfig } from '../src/config'
import { QueryResultType } from '../src/proto/temporal/api/enums/v1/query_pb'
import type { RespondQueryTaskCompletedRequest } from '../src/proto/temporal/api/workflowservice/v1/request_response_pb'
import type { WorkflowServiceClient } from '../src/worker/runtime'
import { WorkerRuntime } from '../src/worker/runtime'
import { defineWorkflow } from '../src/workflow/definition'
import { defineWorkflowQueries } from '../src/workflow/inbound'

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

test('worker runtime responds to legacy query-only tasks with query completion RPC', async () => {
  const config: TemporalConfig = createTestTemporalConfig({ taskQueue: 'query-runtime-test' })
  const observability = createObservabilityStub()

  const queryHandles = defineWorkflowQueries({
    status: {
      input: Schema.Unknown,
      output: Schema.Struct({ value: Schema.String }),
    },
  })

  const workflows = [
    defineWorkflow({
      name: 'queryRuntimeWorkflow',
      queries: queryHandles,
      handler: ({ queries }) =>
        Effect.gen(function* () {
          let value = 'booting'
          yield* queries.register(queryHandles.status, () => Effect.sync(() => ({ value })))
          value = 'ready'
          return value
        }),
    }),
  ]

  const respondQueryCalls: RespondQueryTaskCompletedRequest[] = []
  let respondWorkflowTaskCompletedCalls = 0
  let historyCalls = 0

  let pollCount = 0
  const pollResponse = {
    taskToken: new Uint8Array([1, 2, 3]),
    workflowExecution: { workflowId: 'wf-query', runId: 'run-query' },
    workflowType: { name: 'queryRuntimeWorkflow' },
    query: { queryType: 'status', queryArgs: { payloads: [] } },
  }

  const workflowService: WorkflowServiceClient = {
    pollWorkflowTaskQueue: async (_request, { signal }: { signal?: AbortSignal }) => {
      pollCount += 1
      if (pollCount === 1) {
        return pollResponse
      }
      return await new Promise((_, reject) => {
        const abortError = new Error('aborted')
        abortError.name = 'AbortError'
        if (signal?.aborted) {
          reject(abortError)
          return
        }
        signal?.addEventListener('abort', () => reject(abortError), { once: true })
      })
    },
    getWorkflowExecutionHistory: async () => {
      historyCalls += 1
      return { history: { events: [] }, nextPageToken: new Uint8Array() }
    },
    respondQueryTaskCompleted: async (request: RespondQueryTaskCompletedRequest) => {
      respondQueryCalls.push(request)
      return {}
    },
    respondWorkflowTaskCompleted: async () => {
      respondWorkflowTaskCompletedCalls += 1
      return {}
    },
    respondWorkflowTaskFailed: async () => ({}),
    pollActivityTaskQueue: async () => ({ taskToken: new Uint8Array() }),
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
    workflows,
    workflowService,
    logger: observability.services.logger,
    metrics: observability.services.metricsRegistry,
    metricsExporter: observability.services.metricsExporter,
    stickyScheduling: false,
    pollers: { workflow: 1 },
    concurrency: { workflow: 1, activity: 0 },
  })

  const runPromise = runtime.run()
  await waitFor(() => respondQueryCalls.length > 0)
  await runtime.shutdown()
  await runPromise

  expect(respondWorkflowTaskCompletedCalls).toBe(0)
  expect(historyCalls).toBe(0)
  expect(respondQueryCalls).toHaveLength(1)
  const [request] = respondQueryCalls
  expect(request.completedType).toBe(QueryResultType.ANSWERED)
  const payloads = request.queryResult?.payloads ?? []
  expect(payloads.length).toBe(1)
})
