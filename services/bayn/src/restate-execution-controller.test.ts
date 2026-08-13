import { describe, expect, test } from 'bun:test'

import type { ObjectContext } from '@restatedev/restate-sdk'

import type { ExecutionControllerState } from './execution/controller'
import {
  executionControllerAdvanceRunOptions,
  executionControllerAdvanceMaximumAttempts,
  executionControllerCommandRetryPolicy,
  executionControllerHandlerTimeouts,
  executionControllerTickIdempotencyKey,
  executionControllerTickRetryPolicy,
  makeBaynExecutionController,
} from './restate-execution-controller'

const controllerKey = 'a'.repeat(64)
const planHash = 'b'.repeat(64)
const sourceRevision = 'c'.repeat(40)
const config = {
  controllerKey,
  operationTimeoutMs: 30_000,
  planHash,
  sourceRevision,
}
const activation = {
  schemaVersion: 'bayn.execution-controller-activation.v1' as const,
  controllerKey,
  epoch: 1,
  firstSequence: 4,
  planHash,
  sourceRevision,
}

type Delivery = {
  readonly parameter: unknown
  readonly delay?: number
  readonly idempotencyKey?: string
}

const handlers = (controller: ReturnType<typeof makeBaynExecutionController>) =>
  (
    controller as unknown as {
      readonly object: {
        readonly activate: (ctx: TestContext, candidate: unknown) => Promise<ExecutionControllerState>
        readonly tick: (ctx: TestContext, candidate: unknown) => Promise<void>
        readonly deactivate: (ctx: TestContext, candidate: unknown) => Promise<ExecutionControllerState>
      }
    }
  ).object

type TestContext = ObjectContext<{ readonly controller: ExecutionControllerState }>

describe('native Restate execution controller', () => {
  test('uses bounded pause-on-exhaustion policies and a complete command timeout', () => {
    expect(executionControllerAdvanceRunOptions).toEqual({ maxRetryAttempts: 0 })
    expect(executionControllerAdvanceMaximumAttempts).toBe(3)
    expect(executionControllerTickRetryPolicy).toEqual({ maxAttempts: 1, onMaxAttempts: 'pause' })
    expect(executionControllerCommandRetryPolicy).toMatchObject({ maxAttempts: 3, onMaxAttempts: 'pause' })
    expect(executionControllerHandlerTimeouts(30_000)).toEqual({
      inactivityTimeout: 450_000,
      abortTimeout: 30_000,
    })
  })

  test('serializes activation, one durable advance, scheduling, stale delivery, and deactivation', async () => {
    let state: ExecutionControllerState | null = null
    const deliveries: Delivery[] = []
    const calls: Array<{
      readonly command: Parameters<Parameters<typeof makeBaynExecutionController>[1]['advance']>[0]
      readonly signal: AbortSignal
    }> = []
    const attempt = new AbortController()
    const runtime = {
      advance: async (command: (typeof calls)[number]['command'], signal: AbortSignal) => {
        calls.push({ command, signal })
        return {
          completedAt: '2026-08-13T18:00:01.000Z',
          outcome: {
            _tag: 'Blocked' as const,
            receiptHash: 'd'.repeat(64),
            nextDelayMs: 30_000,
          },
        }
      },
      log: () => Promise.resolve(),
    }
    const context = {
      key: controllerKey,
      get: async () => state,
      set: (_key: string, next: ExecutionControllerState) => {
        state = next
      },
      genericSend: (delivery: Delivery) => {
        deliveries.push(delivery)
      },
      run: async <A>(_name: string, action: () => Promise<A>) => action(),
      date: { toJSON: async () => '2026-08-13T18:00:00.000Z' },
      request: () => ({ id: 'invocation-1', attemptCompletedSignal: attempt.signal }),
    } as unknown as TestContext
    const object = handlers(makeBaynExecutionController(config, runtime))

    expect(await object.activate(context, activation)).toMatchObject({ active: true, epoch: 1, nextSequence: 4 })
    expect(deliveries).toHaveLength(1)
    expect(deliveries[0]).toMatchObject({
      delay: 0,
      idempotencyKey: executionControllerTickIdempotencyKey(1, 4, 0),
      parameter: { epoch: 1, sequence: 4, attempt: 0 },
    })

    await object.activate(context, activation)
    expect(deliveries).toHaveLength(1)

    const firstTick = deliveries.shift()
    if (firstTick === undefined) throw new Error('activation did not schedule the first tick')
    await object.tick(context, firstTick.parameter)
    expect(calls).toHaveLength(1)
    expect(calls[0]).toEqual({
      command: {
        controllerKey,
        epoch: 1,
        sequence: 4,
        issuedAt: '2026-08-13T18:00:00.000Z',
        sourceRevision,
      },
      signal: attempt.signal,
    })
    expect(state).toMatchObject({
      active: true,
      epoch: 1,
      nextSequence: 5,
      lastCompletion: { sequence: 4, outcome: 'Blocked' },
      nextDueAt: '2026-08-13T18:00:31.000Z',
    })
    expect(deliveries).toHaveLength(1)
    expect(deliveries[0]).toMatchObject({
      delay: 30_000,
      idempotencyKey: executionControllerTickIdempotencyKey(1, 5, 0),
      parameter: { epoch: 1, sequence: 5, attempt: 0 },
    })

    await object.tick(context, firstTick.parameter)
    expect(calls).toHaveLength(1)
    expect(deliveries).toHaveLength(1)

    await object.deactivate(context, {
      schemaVersion: 'bayn.execution-controller-deactivation.v1',
      controllerKey,
      epoch: 1,
      planHash,
      sourceRevision,
    })
    expect(state).toMatchObject({ active: false, epoch: 2 })
    const pending = deliveries.shift()
    if (pending === undefined) throw new Error('completed tick did not schedule its successor')
    await object.tick(context, pending.parameter)
    expect(calls).toHaveLength(1)
    expect(deliveries).toHaveLength(0)
  })

  test('fails closed on conflicting activation without scheduling work', async () => {
    const state: ExecutionControllerState = {
      schemaVersion: 1,
      active: true,
      epoch: 1,
      planHash,
      sourceRevision,
      initialSequence: 0,
      nextSequence: 0,
    }
    const deliveries: Delivery[] = []
    const context = {
      key: controllerKey,
      get: async () => state,
      set: () => undefined,
      genericSend: (delivery: Delivery) => deliveries.push(delivery),
      request: () => ({ id: 'invocation-2', attemptCompletedSignal: new AbortController().signal }),
    } as unknown as TestContext
    const object = handlers(
      makeBaynExecutionController(config, {
        advance: () => Promise.reject(new Error('must not advance')),
        log: () => Promise.resolve(),
      }),
    )

    let activationFailure: unknown
    try {
      await object.activate(context, { ...activation, firstSequence: 1 })
    } catch (cause) {
      activationFailure = cause
    }
    expect(activationFailure).toBeInstanceOf(Error)
    expect((activationFailure as Error).message).toBe(
      'execution controller activation conflicts with durable controller state',
    )
    expect(deliveries).toHaveLength(0)
  })

  test('retries the same command identity durably and pauses after the bounded budget', async () => {
    const state: ExecutionControllerState = {
      schemaVersion: 1,
      active: true,
      epoch: 7,
      planHash,
      sourceRevision,
      initialSequence: 12,
      nextSequence: 12,
    }
    const commands: Array<Parameters<Parameters<typeof makeBaynExecutionController>[1]['advance']>[0]> = []
    const deliveries: Delivery[] = []
    const loggedLevels: string[] = []
    let invocation = 0
    const context = {
      key: controllerKey,
      get: async () => state,
      set: () => undefined,
      genericSend: (delivery: Delivery) => deliveries.push(delivery),
      run: async <A>(_name: string, action: () => Promise<A>) => action(),
      date: { toJSON: async () => `2026-08-13T18:00:0${invocation}.000Z` },
      request: () => ({
        id: `invocation-${invocation++}`,
        attemptCompletedSignal: new AbortController().signal,
      }),
    } as unknown as TestContext
    const object = handlers(
      makeBaynExecutionController(config, {
        advance: (command) => {
          commands.push(command)
          return Promise.reject(new Error('temporary database outage'))
        },
        log: (level) => {
          loggedLevels.push(level)
          return Promise.resolve()
        },
      }),
    )
    let tick: unknown = {
      schemaVersion: 'bayn.execution-controller-tick.v1',
      epoch: 7,
      sequence: 12,
      attempt: 0,
    }

    for (let attempt = 0; attempt < executionControllerAdvanceMaximumAttempts - 1; attempt += 1) {
      await object.tick(context, tick)
      const retry = deliveries.shift()
      if (retry === undefined) throw new Error('transient failure did not schedule its durable retry')
      expect(retry).toMatchObject({
        parameter: {
          epoch: 7,
          sequence: 12,
          attempt: attempt + 1,
          issuedAt: '2026-08-13T18:00:00.000Z',
        },
      })
      tick = retry.parameter
    }

    let exhaustionFailure: unknown
    try {
      await object.tick(context, tick)
    } catch (cause) {
      exhaustionFailure = cause
    }
    expect(exhaustionFailure).toBeInstanceOf(Error)
    expect((exhaustionFailure as Error).message).toBe(
      'Bayn execution controller advance exhausted its durable retry budget',
    )
    expect(commands).toHaveLength(executionControllerAdvanceMaximumAttempts)
    expect(new Set(commands.map(({ issuedAt }) => issuedAt))).toEqual(new Set(['2026-08-13T18:00:00.000Z']))
    expect(deliveries).toHaveLength(0)
    expect(loggedLevels).toEqual(['warning', 'warning', 'error'])
  })
})
