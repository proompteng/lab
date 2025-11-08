import { describe, expect, test } from 'bun:test'
import { Effect } from 'effect'

import { makeActivityLifecycle } from '../../src/activities/lifecycle'
import { createDefaultDataConverter } from '../../src/common/payloads'
import type { ActivityContext } from '../../src/worker/activity-context'

const converter = createDefaultDataConverter()

describe('activity lifecycle helpers', () => {
  test('registerHeartbeat forwards details to workflow service', async () => {
    const lifecycle = await Effect.runPromise(
      makeActivityLifecycle({
        heartbeatIntervalMs: 10,
        heartbeatRpcTimeoutMs: 50,
        heartbeatRetry: {
          initialIntervalMs: 5,
          maxIntervalMs: 20,
          backoffCoefficient: 2,
          maxAttempts: 3,
        },
      }),
    )

    const controller = new AbortController()
    const context = createTestContext(controller)
    const stub = new StubWorkflowService()

    const registration = await Effect.runPromise(
      lifecycle.registerHeartbeat({
        context,
        workflowService: stub,
        taskToken: new Uint8Array([1, 2, 3]),
        identity: 'test-worker',
        namespace: 'default',
        dataConverter: converter,
        abortController: controller,
      }),
    )

    await Effect.runPromise(registration.heartbeat(['beat-1']))
    await Effect.runPromise(registration.shutdown)

    expect(stub.calls.length).toBeGreaterThanOrEqual(1)
    expect(stub.calls[0]?.details?.payloads?.length ?? 0).toBe(1)
  })

  test('nextRetryDelay respects maximum attempts', async () => {
    const lifecycle = await Effect.runPromise(
      makeActivityLifecycle({
        heartbeatIntervalMs: 10,
        heartbeatRpcTimeoutMs: 50,
        heartbeatRetry: {
          initialIntervalMs: 5,
          maxIntervalMs: 20,
          backoffCoefficient: 2,
          maxAttempts: 3,
        },
      }),
    )

    const state = { attempt: 1, retryCount: 0, nextDelayMs: 0 }
    const retryPolicy = {
      maximumAttempts: 2,
      initialIntervalMs: 100,
      backoffCoefficient: 2,
    }
    const next = await Effect.runPromise(lifecycle.nextRetryDelay(retryPolicy, state))
    expect(next?.attempt).toBe(2)
    const exhausted = await Effect.runPromise(lifecycle.nextRetryDelay(retryPolicy, next!))
    expect(exhausted).toBeUndefined()
  })
})

const createTestContext = (abortController: AbortController): ActivityContext => ({
  info: {
    activityId: 'test',
    activityType: 'integration',
    workflowNamespace: 'default',
    workflowType: 'wf',
    workflowId: 'wf-test',
    runId: 'run',
    taskQueue: 'queue',
    attempt: 1,
    isLocal: false,
    lastHeartbeatDetails: [],
  },
  cancellationSignal: abortController.signal,
  get isCancellationRequested() {
    return abortController.signal.aborted
  },
  async heartbeat() {},
  throwIfCancelled() {
    if (abortController.signal.aborted) {
      throw abortController.signal.reason ?? new Error('cancelled')
    }
  },
})

class StubWorkflowService {
  readonly calls: { details?: { payloads?: unknown[] } }[] = []

  async recordActivityTaskHeartbeat(request: Record<string, unknown>): Promise<{ cancelRequested: false }> {
    this.calls.push(request as { details?: { payloads?: unknown[] } })
    return { cancelRequested: false }
  }
}
