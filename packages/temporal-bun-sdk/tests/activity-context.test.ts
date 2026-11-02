import { describe, expect, test } from 'bun:test'

import {
  currentActivityContext,
  runWithActivityContext,
  type ActivityContext,
  type ActivityInfo,
} from '../src/worker/activity-context'

const baseInfo: ActivityInfo = {
  activityId: 'activity-123',
  activityType: 'integrationTest',
  workflowNamespace: 'default',
  workflowType: 'exampleWorkflow',
  workflowId: 'test-workflow',
  runId: 'test-run',
  taskQueue: 'temporal-bun-integration',
  attempt: 1,
  isLocal: false,
  lastHeartbeatDetails: [],
}

const createContext = (overrides: Partial<ActivityInfo> = {}): ActivityContext => {
  const info: ActivityInfo = { ...baseInfo, ...overrides }
  const abortController = new AbortController()
  return {
    info,
    cancellationSignal: abortController.signal,
    isCancellationRequested: abortController.signal.aborted,
    async heartbeat(...details) {
      info.lastHeartbeatDetails = details
    },
    throwIfCancelled() {
      if (abortController.signal.aborted) {
        throw new Error('cancelled')
      }
    },
  }
}

describe('activity context', () => {
  test('runWithActivityContext exposes context and restores previous value', async () => {
    expect(currentActivityContext()).toBeUndefined()

    const outer = createContext({ activityId: 'outer' })
    await runWithActivityContext(outer, async () => {
      expect(currentActivityContext()).toBe(outer)

      const inner = createContext({ activityId: 'inner' })
      await runWithActivityContext(inner, async () => {
        expect(currentActivityContext()).toBe(inner)
      })

      expect(currentActivityContext()).toBe(outer)
    })

    expect(currentActivityContext()).toBeUndefined()
  })

  test('heartbeat updates last heartbeat details', async () => {
    const context = createContext()

    await runWithActivityContext(context, async () => {
      await currentActivityContext()?.heartbeat('payload', 42)
      expect(context.info.lastHeartbeatDetails).toEqual(['payload', 42])
    })
  })
})
