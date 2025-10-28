import { describe, expect, test } from 'bun:test'
import { CancelledFailure } from '@temporalio/common'
import { coresdk } from '@temporalio/proto'
import { __testing } from '../../src/worker/runtime'

const {
  ActivityContextImpl,
  ActivityExecution,
  activityTokenToKey,
  formatActivityCancelReason,
  describeCancellationDetails,
} = __testing

const baseInfo = {
  activityId: 'activity-id',
  activityType: 'sampleActivity',
  workflowNamespace: 'default',
  workflowType: 'sampleWorkflow',
  workflowId: 'workflow-id',
  runId: 'run-id',
  taskQueue: 'task-queue',
  attempt: 1,
  isLocal: false,
  lastHeartbeatDetails: [],
} as const

const createContext = (recordedHeartbeats: unknown[][] = []) => {
  return new ActivityContextImpl({ ...baseInfo }, (details) => {
    recordedHeartbeats.push(details)
  })
}

const createExecution = (overrides: Partial<{
  handler: (...args: unknown[]) => unknown
  args: unknown[]
  context: ActivityContextImpl
  tokenKey: string
  taskToken: Uint8Array
  onSuccess: (value: unknown) => Promise<void> | void
  onFailure: (error: unknown) => Promise<void> | void
  onCancelled: (failure: CancelledFailure) => Promise<void> | void
  onFinished: () => void
}> = {}) => {
  const recordedHeartbeats: unknown[][] = []
  const context = overrides.context ?? createContext(recordedHeartbeats)
  const tokenKey = overrides.tokenKey ?? 'token'
  const taskToken = overrides.taskToken ?? new Uint8Array([1, 2, 3])
  const onSuccess = overrides.onSuccess ?? (async () => {})
  const onFailure = overrides.onFailure ?? (async () => {})
  const onCancelled = overrides.onCancelled ?? (async () => {})
  const onFinished = overrides.onFinished ?? (() => {})

  const execution = new ActivityExecution({
    tokenKey,
    taskToken,
    handler: overrides.handler ?? (() => 'ok'),
    args: overrides.args ?? [],
    context,
    onSuccess,
    onFailure,
    onCancelled,
    onFinished,
  })

  return { execution, context, recordedHeartbeats, tokenKey, taskToken }
}

describe('ActivityExecution', () => {
  test('completes successfully', async () => {
    const successValues: unknown[] = []
    const finished = { called: false }

    const { execution } = createExecution({
      handler: () => 'result',
      onSuccess: async (value) => {
        successValues.push(value)
      },
      onFinished: () => {
        finished.called = true
      },
    })

    await execution.start()

    expect(successValues).toEqual(['result'])
    expect(finished.called).toBe(true)
  })

  test('propagates handler errors', async () => {
    const failures: string[] = []
    const { execution } = createExecution({
      handler: () => {
        throw new Error('boom')
      },
      onFailure: async (error) => {
        failures.push((error as Error).message)
      },
    })

    await execution.start()

    expect(failures).toEqual(['boom'])
  })

  test('cancels long-running activity', async () => {
    const cancelled: string[] = []
    const { execution, context } = createExecution({
      handler: () => new Promise<never>(() => {}),
      onCancelled: async (failure) => {
        cancelled.push(failure.message ?? '')
      },
    })

    const runPromise = execution.start()
    context.requestCancel(new CancelledFailure('cancelled by test'))
    await runPromise

    expect(cancelled).toEqual(['cancelled by test'])
    expect(context.isCancellationRequested).toBe(true)
  })

  test('records heartbeats via context', async () => {
    const { execution, context, recordedHeartbeats } = createExecution({
      handler: () => {
        context.heartbeat('tick', 1)
        return 'done'
      },
    })

    await execution.start()

    expect(recordedHeartbeats.length).toBe(1)
    expect(recordedHeartbeats[0]).toEqual(['tick', 1])
  })

  test('throwIfCancelled raises when cancelled', () => {
    const context = createContext()
    expect(() => context.throwIfCancelled()).not.toThrow()
    context.requestCancel(new CancelledFailure('cancelled'))
    expect(() => context.throwIfCancelled()).toThrow(CancelledFailure)
  })
})

describe('Activity runtime helpers', () => {
  test('activity token to key is base64', () => {
    const token = new Uint8Array([0xff, 0x00, 0x10])
    expect(activityTokenToKey(token)).toBe(Buffer.from(token).toString('base64'))
  })

  test('formats cancel reasons', () => {
    expect(formatActivityCancelReason(undefined)).toBe('Activity cancelled')
    expect(formatActivityCancelReason(null)).toBe('Activity cancelled')
    expect(formatActivityCancelReason(coresdk.activity_task.ActivityCancelReason.TIMED_OUT)).toBe('Activity timed out')
  })

  test('describes cancellation detail flags', () => {
    const details = describeCancellationDetails({
      isCancelled: true,
      isWorkerShutdown: true,
    })
    expect(details).toEqual([{ isCancelled: true, isWorkerShutdown: true }])

    const empty = describeCancellationDetails(undefined)
    expect(empty).toBeUndefined()
  })
})
