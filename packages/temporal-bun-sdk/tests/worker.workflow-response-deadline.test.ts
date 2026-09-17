import { create } from '@bufbuild/protobuf'
import { Code, ConnectError } from '@connectrpc/connect'
import { expect, test } from 'bun:test'
import { Effect } from 'effect'

import { EventType } from '../src/proto/temporal/api/enums/v1/event_type_pb'
import { PollWorkflowTaskQueueResponseSchema } from '../src/proto/temporal/api/workflowservice/v1/request_response_pb'
import { WorkerRuntime, type WorkflowServiceClient } from '../src/worker/runtime'
import { defineWorkflow } from '../src/workflow/definition'
import { createObservabilityStub, createTestTemporalConfig } from './helpers/observability'

const waitFor = async (predicate: () => boolean) => {
  const deadline = Date.now() + 1_600
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('workflow response exceeded its task budget')
    await Bun.sleep(10)
  }
}

const waitForAbort = (signal?: AbortSignal) =>
  new Promise<never>((_, reject) => {
    const abort = () => reject(new ConnectError('aborted', Code.Canceled))
    if (signal?.aborted) abort()
    else signal?.addEventListener('abort', abort, { once: true })
  })

for (const mode of ['slow-response', 'retry-backoff', 'expired-task'] as const) {
  test(`workflow response budget bounds ${mode}`, async () => {
    const config = createTestTemporalConfig({
      stickySchedulingEnabled: false,
      rpcRetryPolicy: {
        maxAttempts: 3,
        initialDelayMs: 2_000,
        maxDelayMs: 2_000,
        backoffCoefficient: 1,
        jitterFactor: 0,
        retryableStatusCodes: [Code.Unavailable],
      },
    })
    const observability = createObservabilityStub()
    let polled = false
    let localInvocations = 0
    let failures = 0
    let aborted = false
    const timeouts: number[] = []
    const workflowService = {
      pollWorkflowTaskQueue: async (_request: unknown, { signal }: { signal?: AbortSignal }) => {
        if (polled) return await waitForAbort(signal)
        polled = true
        const now = Date.now() - (mode === 'expired-task' ? 1_100 : 0)
        return create(PollWorkflowTaskQueueResponseSchema, {
          taskToken: new Uint8Array([31]),
          workflowExecution: { workflowId: mode, runId: 'run-1' },
          workflowType: { name: 'responseDeadline' },
          startedEventId: 3n,
          startedTime: { seconds: BigInt(Math.floor(now / 1_000)), nanos: (now % 1_000) * 1_000_000 },
          history: {
            events: [
              {
                eventId: 1n,
                eventType: EventType.WORKFLOW_EXECUTION_STARTED,
                attributes: {
                  case: 'workflowExecutionStartedEventAttributes',
                  value: {
                    workflowType: { name: 'responseDeadline' },
                    workflowTaskTimeout: { seconds: 1n },
                  },
                },
              },
            ],
          },
        })
      },
      pollActivityTaskQueue: async (_request: unknown, { signal }: { signal?: AbortSignal }) =>
        await waitForAbort(signal),
      respondWorkflowTaskCompleted: async (_request: unknown, options: { signal?: AbortSignal; timeoutMs: number }) => {
        timeouts.push(options.timeoutMs)
        if (mode === 'retry-backoff') throw new ConnectError('temporarily unavailable', Code.Unavailable)
        if (mode === 'slow-response')
          await new Promise<void>((resolve, reject) => {
            const timer = setTimeout(resolve, 2_000)
            options.signal?.addEventListener(
              'abort',
              () => {
                aborted = true
                clearTimeout(timer)
                reject(new ConnectError('aborted', Code.Canceled))
              },
              { once: true },
            )
          })
        return {}
      },
      respondWorkflowTaskFailed: async () => {
        failures += 1
        return {}
      },
    } as unknown as WorkflowServiceClient
    const runtime = await WorkerRuntime.create({
      config,
      workflowService,
      pollers: { workflow: 1, activity: 0 },
      workflows: [
        defineWorkflow('responseDeadline', ({ determinism }) =>
          Effect.sync(() => {
            determinism.localActivity('slow-local', [], {
              handler: async () => {
                localInvocations += 1
                await Bun.sleep(1_500)
                return 42
              },
            })
            return 'done'
          }),
        ),
      ],
      logger: observability.services.logger,
      metrics: observability.services.metricsRegistry,
      metricsExporter: observability.services.metricsExporter,
    })
    const running = runtime.run()
    try {
      await waitFor(() => observability.logs.some(({ message }) => message.includes('awaiting server redelivery')))
      expect(failures).toBe(0)
      expect(localInvocations).toBe(mode === 'expired-task' ? 0 : 1)
      expect(timeouts).toHaveLength(mode === 'expired-task' ? 0 : 1)
      for (const timeout of timeouts) {
        expect(timeout).toBeGreaterThan(0)
        expect(timeout).toBeLessThanOrEqual(500)
      }
      if (mode === 'slow-response') expect(aborted).toBeTrue()
    } finally {
      await runtime.shutdown()
      await running
    }
  })
}
