import { describe, expect, test } from 'bun:test'

import type { Context, ObjectContext } from '@restatedev/restate-sdk'
import { Result } from 'effect'

import type { ExecutionControllerState } from '../execution/controller'
import { ExecutionControllerOutcome } from '../execution/controller-status'
import { CycleNotDueReason } from '../cycle/runner/model'
import {
  executionControllerAdvanceRunOptions,
  executionControllerAdvanceMaximumAttempts,
  executionControllerBootstrapCompletionMaximumAttempts,
  executionControllerBootstrapCompletionPollIntervalMs,
  executionControllerBootstrapHandlerTimeouts,
  executionControllerBootstrapRotationBoundMs,
  executionControllerCommandRetryPolicy,
  executionControllerHandlerTimeouts,
  executionControllerInitialTickDelayMs,
  executionControllerSuccessorPassCompleted,
  executionControllerTickIdempotencyKey,
  executionControllerTickRetryPolicy,
  executionBootstrapAuthorizationHash,
  makeBaynExecutionBootstrap,
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

const bootstrapHandlers = (bootstrap: ReturnType<typeof makeBaynExecutionBootstrap>) =>
  (
    bootstrap as unknown as {
      readonly service: {
        readonly start: (ctx: Context, candidate: unknown) => Promise<ExecutionControllerState>
      }
    }
  ).service

type TestContext = ObjectContext<{ readonly controller: ExecutionControllerState }>

describe('native Restate execution controller', () => {
  test('uses bounded pause-on-exhaustion policies and a complete command timeout', () => {
    expect(executionControllerInitialTickDelayMs).toBe(0)
    expect(executionControllerAdvanceRunOptions).toEqual({ maxRetryAttempts: 0 })
    expect(executionControllerAdvanceMaximumAttempts(false)).toBe(3)
    expect(executionControllerAdvanceMaximumAttempts(true)).toBe(7)
    expect(executionControllerTickRetryPolicy).toEqual({
      maxAttempts: 3,
      onMaxAttempts: 'pause',
      initialInterval: 1_000,
      maxInterval: 10_000,
      exponentiationFactor: 2,
    })
    expect(executionControllerCommandRetryPolicy).toMatchObject({ maxAttempts: 3, onMaxAttempts: 'pause' })
    expect(executionControllerHandlerTimeouts(30_000)).toEqual({
      inactivityTimeout: 450_000,
      abortTimeout: 30_000,
    })
    expect(executionControllerBootstrapRotationBoundMs(30_000)).toBe(480_000)
    expect(executionControllerBootstrapCompletionPollIntervalMs).toBe(5_000)
    expect(executionControllerBootstrapCompletionMaximumAttempts(30_000)).toBe(85)
    expect(executionControllerBootstrapHandlerTimeouts(30_000, true)).toEqual({
      inactivityTimeout: 480_000,
      abortTimeout: 30_000,
    })
    expect(executionControllerBootstrapHandlerTimeouts(30_000, false)).toEqual(
      executionControllerHandlerTimeouts(30_000),
    )
  })

  test('serializes null activation into one immediate first pass and one normal successor', async () => {
    let state: ExecutionControllerState | null = null
    const deliveries: Delivery[] = []
    const events: string[] = []
    const calls: Array<{
      readonly command: Parameters<Parameters<typeof makeBaynExecutionController>[1]['advance']>[0]
      readonly signal: AbortSignal
    }> = []
    const attempt = new AbortController()
    const projectedStates: ExecutionControllerState[] = []
    const runtime = {
      advance: async (command: (typeof calls)[number]['command'], signal: AbortSignal) => {
        calls.push({ command, signal })
        events.push('advance-completed')
        return {
          completedAt: '2026-08-13T18:00:01.000Z',
          observation: {
            result: 'SUCCESS' as const,
            observedAt: '2026-08-13T18:00:01.000Z',
            outcome: 'NOT_DUE' as const,
            cadence: 'EVERY_SESSION' as const,
            notDueReason: CycleNotDueReason.StaleExecutionBootstrap,
          },
          outcome: {
            _tag: ExecutionControllerOutcome.Blocked,
            receiptHash: 'd'.repeat(64),
            nextDelayMs: 30_000,
          },
        }
      },
      log: () => Promise.reject(new Error('telemetry unavailable')),
      projectState: async (_key: string, next: ExecutionControllerState) => {
        projectedStates.push(next)
        events.push(next.active ? 'activation-projected' : 'deactivation-projected')
      },
    }
    const context = {
      key: controllerKey,
      get: async () => state,
      set: (_key: string, next: ExecutionControllerState) => {
        events.push('state-committed')
        state = next
      },
      genericSend: (delivery: Delivery) => {
        events.push(
          delivery.delay === executionControllerInitialTickDelayMs ? 'first-pass-scheduled' : 'successor-scheduled',
        )
        deliveries.push(delivery)
      },
      run: async <A>(_name: string, action: () => Promise<A>) => action(),
      date: { toJSON: async () => '2026-08-13T18:00:00.000Z' },
      request: () => ({ id: 'invocation-1', attemptCompletedSignal: attempt.signal }),
    } as unknown as TestContext
    const object = handlers(makeBaynExecutionController(config, runtime))

    expect(await object.activate(context, activation)).toMatchObject({ active: true, epoch: 1, nextSequence: 4 })
    expect(projectedStates).toHaveLength(1)
    expect(projectedStates[0]).toMatchObject({ active: true, epoch: 1, nextSequence: 4 })
    expect(deliveries).toHaveLength(1)
    expect(events).toEqual(['activation-projected', 'state-committed', 'first-pass-scheduled'])
    expect(deliveries[0]).toMatchObject({
      delay: 0,
      idempotencyKey: executionControllerTickIdempotencyKey(1, 4, 0),
      parameter: { epoch: 1, sequence: 4, attempt: 0 },
    })

    await object.activate(context, activation)
    expect(projectedStates).toHaveLength(2)
    expect(projectedStates[1]).toEqual(projectedStates[0])
    expect(deliveries).toHaveLength(1)
    expect(events).toEqual(['activation-projected', 'state-committed', 'first-pass-scheduled', 'activation-projected'])

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
      lastCompletion: {
        sequence: 4,
        outcome: 'Blocked',
        lastPass: {
          result: 'SUCCESS',
          outcome: 'NOT_DUE',
          cadence: 'EVERY_SESSION',
          notDueReason: CycleNotDueReason.StaleExecutionBootstrap,
        },
      },
      nextDueAt: '2026-08-13T18:00:31.000Z',
    })
    expect(deliveries).toHaveLength(1)
    expect(deliveries[0]).toMatchObject({
      delay: 30_000,
      idempotencyKey: executionControllerTickIdempotencyKey(1, 5, 0),
      parameter: { epoch: 1, sequence: 5, attempt: 0 },
    })
    expect(events.slice(-3)).toEqual(['advance-completed', 'state-committed', 'successor-scheduled'])

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
    expect(projectedStates).toHaveLength(3)
    expect(projectedStates[2]).toMatchObject({ active: false, epoch: 2, nextSequence: 5 })
    const pending = deliveries.shift()
    if (pending === undefined) throw new Error('completed tick did not schedule its successor')
    await object.tick(context, pending.parameter)
    expect(calls).toHaveLength(1)
    expect(deliveries).toHaveLength(0)
  })

  test('fails activation closed before Restate state or scheduling when durable projection fails', async () => {
    let state: ExecutionControllerState | null = null
    let sets = 0
    const deliveries: Delivery[] = []
    const context = {
      key: controllerKey,
      get: async () => state,
      set: (_key: string, next: ExecutionControllerState) => {
        sets += 1
        state = next
      },
      genericSend: (delivery: Delivery) => deliveries.push(delivery),
      run: async <A>(_name: string, action: () => Promise<A>) => action(),
      request: () => ({ id: 'activation-projection-failed', attemptCompletedSignal: new AbortController().signal }),
    } as unknown as TestContext
    const object = handlers(
      makeBaynExecutionController(config, {
        advance: () => Promise.reject(new Error('must not advance')),
        log: () => Promise.resolve(),
        projectState: () => Promise.reject(new Error('postgres unavailable')),
      }),
    )

    expect(object.activate(context, activation)).rejects.toThrow('postgres unavailable')
    expect(state).toBeNull()
    expect(sets).toBe(0)
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
        projectState: () => Promise.resolve(),
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

  test('deactivates only the current or explicitly configured previous immutable binding', async () => {
    const previousBinding = { planHash: 'd'.repeat(64), sourceRevision: 'e'.repeat(40) }
    let state: ExecutionControllerState = {
      schemaVersion: 1,
      active: true,
      epoch: 6,
      ...previousBinding,
      initialSequence: 3,
      nextSequence: 9,
    }
    let projections = 0
    const context = {
      key: controllerKey,
      get: async () => state,
      set: (_key: string, next: ExecutionControllerState) => {
        state = next
      },
      run: async <A>(_name: string, action: () => Promise<A>) => action(),
      request: () => ({ id: 'deactivate-previous', attemptCompletedSignal: new AbortController().signal }),
    } as unknown as TestContext
    const object = handlers(
      makeBaynExecutionController(
        { ...config, previousBinding },
        {
          advance: () => Promise.reject(new Error('must not advance')),
          log: () => Promise.resolve(),
          projectState: () => {
            projections += 1
            return Promise.resolve()
          },
        },
      ),
    )

    await object.deactivate(context, {
      schemaVersion: 'bayn.execution-controller-deactivation.v1',
      controllerKey,
      epoch: 6,
      ...previousBinding,
    })
    expect(state).toMatchObject({ active: false, epoch: 7, ...previousBinding })
    expect(projections).toBe(1)

    expect(
      object.deactivate(context, {
        schemaVersion: 'bayn.execution-controller-deactivation.v1',
        controllerKey,
        epoch: 7,
        planHash: 'f'.repeat(64),
        sourceRevision: previousBinding.sourceRevision,
      }),
    ).rejects.toThrow('execution controller deactivation does not match this immutable deployment')
    expect(projections).toBe(1)
  })

  test('rejects sequence exhaustion before the durable advance step', async () => {
    const state: ExecutionControllerState = {
      schemaVersion: 1,
      active: true,
      epoch: 3,
      planHash,
      sourceRevision,
      initialSequence: Number.MAX_SAFE_INTEGER,
      nextSequence: Number.MAX_SAFE_INTEGER,
    }
    let advances = 0
    const deliveries: Delivery[] = []
    const context = {
      key: controllerKey,
      get: async () => state,
      set: () => undefined,
      genericSend: (delivery: Delivery) => deliveries.push(delivery),
      date: { toJSON: async () => '2026-08-13T18:00:00.000Z' },
      request: () => ({ id: 'invocation-exhausted', attemptCompletedSignal: new AbortController().signal }),
    } as unknown as TestContext
    const object = handlers(
      makeBaynExecutionController(config, {
        advance: () => {
          advances += 1
          return Promise.reject(new Error('must not advance'))
        },
        log: () => Promise.resolve(),
        projectState: () => Promise.resolve(),
      }),
    )

    let failure: unknown
    try {
      await object.tick(context, {
        schemaVersion: 'bayn.execution-controller-tick.v1',
        epoch: state.epoch,
        sequence: Number.MAX_SAFE_INTEGER,
      })
    } catch (cause) {
      failure = cause
    }

    expect(failure).toBeInstanceOf(Error)
    expect((failure as Error).message).toBe('execution controller sequence is exhausted before advance')
    expect(advances).toBe(0)
    expect(deliveries).toHaveLength(0)
  })

  test('rejects a delayed tick bound to a previous immutable deployment before advancing', async () => {
    const state: ExecutionControllerState = {
      schemaVersion: 1,
      active: true,
      epoch: 3,
      planHash: 'd'.repeat(64),
      sourceRevision,
      initialSequence: 8,
      nextSequence: 8,
    }
    let advances = 0
    const context = {
      key: controllerKey,
      get: async () => state,
      set: () => undefined,
      genericSend: () => undefined,
      request: () => ({ id: 'stale-deployment', attemptCompletedSignal: new AbortController().signal }),
    } as unknown as TestContext
    const object = handlers(
      makeBaynExecutionController(config, {
        advance: () => {
          advances += 1
          return Promise.reject(new Error('must not advance'))
        },
        log: () => Promise.resolve(),
        projectState: () => Promise.resolve(),
      }),
    )

    let failure: unknown
    try {
      await object.tick(context, {
        schemaVersion: 'bayn.execution-controller-tick.v1',
        epoch: state.epoch,
        sequence: state.nextSequence,
      })
    } catch (cause) {
      failure = cause
    }

    expect(failure).toBeInstanceOf(Error)
    expect((failure as Error).message).toBe(
      'execution controller durable state does not match this immutable deployment',
    )
    expect(advances).toBe(0)
  })

  test('quiesces the exact configured previous binding while the replacement waits to rotate it', async () => {
    const previousBinding = { planHash: 'd'.repeat(64), sourceRevision: 'e'.repeat(40) }
    const state: ExecutionControllerState = {
      schemaVersion: 1,
      active: true,
      epoch: 3,
      ...previousBinding,
      initialSequence: 8,
      nextSequence: 8,
    }
    let advances = 0
    const deliveries: Delivery[] = []
    const context = {
      key: controllerKey,
      get: async () => state,
      set: () => undefined,
      genericSend: (delivery: Delivery) => deliveries.push(delivery),
      request: () => ({ id: 'previous-binding', attemptCompletedSignal: new AbortController().signal }),
    } as unknown as TestContext
    const object = handlers(
      makeBaynExecutionController(
        { ...config, previousBinding },
        {
          advance: () => {
            advances += 1
            return Promise.reject(new Error('must not advance'))
          },
          log: () => Promise.resolve(),
          projectState: () => Promise.resolve(),
        },
      ),
    )

    await object.tick(context, {
      schemaVersion: 'bayn.execution-controller-tick.v1',
      epoch: state.epoch,
      sequence: state.nextSequence,
    })

    expect(advances).toBe(0)
    expect(deliveries).toHaveLength(0)
  })

  test('authenticates bootstrap and derives activation counters from durable state', async () => {
    const token = Buffer.alloc(32, 7).toString('base64url')
    const authorizationHash = Result.getOrThrow(executionBootstrapAuthorizationHash(token))
    const state: ExecutionControllerState = {
      schemaVersion: 1,
      active: false,
      epoch: 7,
      planHash,
      sourceRevision,
      initialSequence: 11,
      nextSequence: 17,
    }
    const completedState: ExecutionControllerState = {
      ...state,
      active: true,
      nextSequence: 19,
      lastCompletion: {
        sequence: 18,
        outcome: ExecutionControllerOutcome.Blocked,
        receiptHash: 'f'.repeat(64),
        completedAt: '2026-08-13T18:00:01.000Z',
      },
      nextDueAt: '2026-08-13T18:00:31.000Z',
    }
    let forwarded: unknown
    let genericCalls = 0
    const controller = makeBaynExecutionController(config, {
      advance: () => Promise.reject(new Error('must not advance')),
      log: () => Promise.resolve(),
      projectState: () => Promise.resolve(),
    })
    const start = bootstrapHandlers(makeBaynExecutionBootstrap(config, controller, authorizationHash)).start
    const context = {
      request: () => ({
        id: 'bootstrap-authorized',
        headers: new Map([['authorization', `Bearer ${token}`]]),
        attemptCompletedSignal: new AbortController().signal,
      }),
      objectClient: () => ({
        status: async () => state,
        activate: async (request: unknown) => {
          forwarded = request
          return completedState
        },
      }),
      sleep: () => Promise.reject(new Error('completed activation must not poll')),
      genericCall: () => {
        genericCalls += 1
        return Promise.reject(new Error('bootstrap must not call a legacy service'))
      },
    } as unknown as Context

    await start(context, {
      schemaVersion: 'bayn.execution-controller-bootstrap.v2',
      controllerKey,
      planHash,
      sourceRevision,
    })

    expect(forwarded).toEqual({
      schemaVersion: 'bayn.execution-controller-activation.v1',
      controllerKey,
      epoch: 7,
      firstSequence: 17,
      planHash,
      sourceRevision,
    })
    expect(genericCalls).toBe(0)
  })

  test('rotates the exact previous binding into one immediate pass and ignores its stale tick', async () => {
    const token = Buffer.alloc(32, 7).toString('base64url')
    const authorizationHash = Result.getOrThrow(executionBootstrapAuthorizationHash(token))
    const previousBinding = { planHash: 'd'.repeat(64), sourceRevision: 'e'.repeat(40) }
    const rotationConfig = { ...config, previousBinding }
    let state: ExecutionControllerState = {
      schemaVersion: 1,
      active: true,
      epoch: 4,
      ...previousBinding,
      initialSequence: 7,
      nextSequence: 12,
    }
    const events: string[] = []
    const deliveries: Delivery[] = []
    const calls: Array<Parameters<Parameters<typeof makeBaynExecutionController>[1]['advance']>[0]> = []
    const projectedStates: ExecutionControllerState[] = []
    let genericCalls = 0
    let sleeps = 0
    const attempt = new AbortController()
    const controller = makeBaynExecutionController(rotationConfig, {
      advance: async (command) => {
        calls.push(command)
        events.push('advance-completed')
        return {
          completedAt: '2026-08-13T18:00:01.000Z',
          outcome: {
            _tag: ExecutionControllerOutcome.Blocked,
            receiptHash: 'f'.repeat(64),
            nextDelayMs: 30_000,
          },
        }
      },
      log: () => Promise.resolve(),
      projectState: async (_key, next) => {
        projectedStates.push(next)
        events.push(next.active ? 'activation-projected' : 'deactivation-projected')
      },
    })
    const object = handlers(controller)
    const controllerContext = {
      key: controllerKey,
      get: async () => state,
      set: (_key: string, next: ExecutionControllerState) => {
        state = next
        events.push('state-committed')
      },
      genericSend: (delivery: Delivery) => {
        deliveries.push(delivery)
        events.push(
          delivery.delay === executionControllerInitialTickDelayMs ? 'first-pass-scheduled' : 'successor-scheduled',
        )
      },
      run: async <A>(_name: string, action: () => Promise<A>) => action(),
      date: { toJSON: async () => '2026-08-13T18:00:00.000Z' },
      request: () => ({ id: 'rotation-controller', attemptCompletedSignal: attempt.signal }),
    } as unknown as TestContext
    const start = bootstrapHandlers(makeBaynExecutionBootstrap(rotationConfig, controller, authorizationHash)).start
    const context = {
      request: () => ({
        id: 'bootstrap-native-rotation',
        headers: new Map([['authorization', `Bearer ${token}`]]),
        attemptCompletedSignal: new AbortController().signal,
      }),
      objectClient: () => ({
        status: async () => state,
        deactivate: (request: unknown) => object.deactivate(controllerContext, request),
        activate: (request: unknown) => object.activate(controllerContext, request),
      }),
      sleep: async () => {
        sleeps += 1
        const firstTick = deliveries.shift()
        if (firstTick === undefined) throw new Error('rotation did not schedule the new binding first pass')
        await object.tick(controllerContext, firstTick.parameter)
      },
      genericCall: () => {
        genericCalls += 1
        return Promise.reject(new Error('bootstrap must not call a legacy service'))
      },
    } as unknown as Context
    const request = {
      schemaVersion: 'bayn.execution-controller-bootstrap.v3' as const,
      controllerKey,
      planHash,
      sourceRevision,
      previousBinding,
    }

    expect(await start(context, request)).toMatchObject({
      active: true,
      epoch: 5,
      planHash,
      sourceRevision,
      lastCompletion: { sequence: 13, outcome: ExecutionControllerOutcome.Blocked },
      nextSequence: 14,
    })
    expect(projectedStates).toHaveLength(2)
    expect(projectedStates[0]).toMatchObject({ active: false, epoch: 5, ...previousBinding })
    expect(projectedStates[1]).toMatchObject({ active: true, epoch: 5, planHash, sourceRevision, nextSequence: 12 })
    expect(events).toEqual([
      'deactivation-projected',
      'state-committed',
      'activation-projected',
      'state-committed',
      'first-pass-scheduled',
      'advance-completed',
      'state-committed',
      'successor-scheduled',
      'advance-completed',
      'state-committed',
      'successor-scheduled',
    ])
    expect(deliveries).toHaveLength(1)
    expect(deliveries[0]).toMatchObject({
      delay: 30_000,
      idempotencyKey: executionControllerTickIdempotencyKey(5, 14, 0),
      parameter: { epoch: 5, sequence: 14, attempt: 0 },
    })
    expect(sleeps).toBe(2)
    expect(genericCalls).toBe(0)

    await start(context, request)
    expect(projectedStates).toHaveLength(3)
    expect(projectedStates[2]).toEqual(state)
    expect(deliveries).toHaveLength(1)
    expect(genericCalls).toBe(0)

    await object.tick(controllerContext, {
      schemaVersion: 'bayn.execution-controller-tick.v1',
      epoch: 4,
      sequence: 12,
      attempt: 0,
    })
    expect(calls).toHaveLength(2)
    expect(deliveries).toHaveLength(1)
    expect(calls).toEqual(
      [12, 13].map((sequence) => ({
        controllerKey,
        epoch: 5,
        sequence,
        issuedAt: '2026-08-13T18:00:00.000Z',
        sourceRevision,
      })),
    )
    expect(state).toMatchObject({
      active: true,
      epoch: 5,
      nextSequence: 14,
      lastCompletion: { sequence: 13, outcome: 'Blocked' },
      nextDueAt: '2026-08-13T18:00:31.000Z',
    })
    expect(deliveries).toHaveLength(1)
    expect(deliveries[0]).toMatchObject({
      delay: 30_000,
      idempotencyKey: executionControllerTickIdempotencyKey(5, 14, 0),
      parameter: { epoch: 5, sequence: 14, attempt: 0 },
    })
    expect(events.at(-1)).toBe('activation-projected')
  })

  test('fails native rotation before controller calls when prior provenance is missing or mismatched', async () => {
    const token = Buffer.alloc(32, 7).toString('base64url')
    const authorizationHash = Result.getOrThrow(executionBootstrapAuthorizationHash(token))
    const previousBinding = { planHash: 'd'.repeat(64), sourceRevision: 'e'.repeat(40) }
    const rotationConfig = { ...config, previousBinding }
    let objectCalls = 0
    const controller = makeBaynExecutionController(rotationConfig, {
      advance: () => Promise.reject(new Error('must not advance')),
      log: () => Promise.resolve(),
      projectState: () => Promise.resolve(),
    })
    const start = bootstrapHandlers(makeBaynExecutionBootstrap(rotationConfig, controller, authorizationHash)).start
    const context = {
      request: () => ({
        id: 'bootstrap-native-rotation-rejected',
        headers: new Map([['authorization', `Bearer ${token}`]]),
        attemptCompletedSignal: new AbortController().signal,
      }),
      objectClient: () => {
        objectCalls += 1
        return { status: () => Promise.reject(new Error('must not read')) }
      },
    } as unknown as Context

    for (const candidate of [
      {
        schemaVersion: 'bayn.execution-controller-bootstrap.v2',
        controllerKey,
        planHash,
        sourceRevision,
      },
      {
        schemaVersion: 'bayn.execution-controller-bootstrap.v3',
        controllerKey,
        planHash,
        sourceRevision,
        previousBinding: { ...previousBinding, planHash: 'f'.repeat(64) },
      },
    ]) {
      expect(start(context, candidate)).rejects.toThrow(
        'execution controller bootstrap does not match this immutable deployment',
      )
    }
    expect(objectCalls).toBe(0)
  })

  test('activates null native state without calling any legacy service', async () => {
    const token = Buffer.alloc(32, 7).toString('base64url')
    const authorizationHash = Result.getOrThrow(executionBootstrapAuthorizationHash(token))
    const events: string[] = []
    let genericCalls = 0
    let forwarded: unknown
    let statusReads = 0
    const successorState: ExecutionControllerState = {
      schemaVersion: 1,
      active: true,
      epoch: 1,
      planHash,
      sourceRevision,
      initialSequence: 0,
      nextSequence: 2,
      lastCompletion: {
        sequence: 1,
        outcome: ExecutionControllerOutcome.Blocked,
        receiptHash: 'e'.repeat(64),
        completedAt: '2026-08-13T18:00:31.000Z',
      },
      nextDueAt: '2026-08-13T18:01:01.000Z',
    }
    const controller = makeBaynExecutionController(config, {
      advance: () => Promise.reject(new Error('must not advance')),
      log: () => Promise.resolve(),
      projectState: () => Promise.resolve(),
    })
    const start = bootstrapHandlers(makeBaynExecutionBootstrap(config, controller, authorizationHash)).start
    const context = {
      request: () => ({
        id: 'bootstrap-null-native-state',
        headers: new Map([['authorization', `Bearer ${token}`]]),
        attemptCompletedSignal: new AbortController().signal,
      }),
      genericCall: () => {
        genericCalls += 1
        return Promise.reject(new Error('bootstrap must not call a legacy service'))
      },
      objectClient: () => ({
        status: async () => {
          events.push('native-status')
          statusReads += 1
          return statusReads === 1 ? null : successorState
        },
        activate: async (request: unknown) => {
          events.push('native-activate')
          forwarded = request
          return {
            schemaVersion: 1,
            active: true,
            epoch: 1,
            planHash,
            sourceRevision,
            initialSequence: 0,
            nextSequence: 1,
            lastCompletion: {
              sequence: 0,
              outcome: ExecutionControllerOutcome.Blocked,
              receiptHash: 'd'.repeat(64),
              completedAt: '2026-08-13T18:00:01.000Z',
            },
            nextDueAt: '2026-08-13T18:00:31.000Z',
          }
        },
      }),
      sleep: async () => {
        events.push('native-sleep')
      },
    } as unknown as Context

    await start(context, {
      schemaVersion: 'bayn.execution-controller-bootstrap.v2',
      controllerKey,
      planHash,
      sourceRevision,
    })

    expect(events).toEqual(['native-status', 'native-activate', 'native-sleep', 'native-status'])
    expect(forwarded).toMatchObject({ epoch: 1, firstSequence: 0, planHash, sourceRevision })
    expect(genericCalls).toBe(0)
  })

  test('waits for durable successor evidence and fails bootstrap when it never arrives', async () => {
    const token = Buffer.alloc(32, 7).toString('base64url')
    const authorizationHash = Result.getOrThrow(executionBootstrapAuthorizationHash(token))
    const pending: ExecutionControllerState = {
      schemaVersion: 1,
      active: true,
      epoch: 1,
      planHash,
      sourceRevision,
      initialSequence: 0,
      nextSequence: 0,
    }
    const controller = makeBaynExecutionController(config, {
      advance: () => Promise.reject(new Error('must not advance')),
      log: () => Promise.resolve(),
      projectState: () => Promise.resolve(),
    })
    const start = bootstrapHandlers(makeBaynExecutionBootstrap(config, controller, authorizationHash)).start
    let sleeps = 0
    let statusReads = 0
    const context = {
      request: () => ({
        id: 'bootstrap-first-pass-timeout',
        headers: new Map([['authorization', `Bearer ${token}`]]),
        attemptCompletedSignal: new AbortController().signal,
      }),
      objectClient: () => ({
        status: async () => {
          statusReads += 1
          return pending
        },
        activate: async () => pending,
      }),
      sleep: async () => {
        sleeps += 1
      },
    } as unknown as Context

    let failure: unknown
    try {
      await start(context, {
        schemaVersion: 'bayn.execution-controller-bootstrap.v2',
        controllerKey,
        planHash,
        sourceRevision,
      })
    } catch (cause) {
      failure = cause
    }
    expect(failure).toBeInstanceOf(Error)
    expect((failure as Error).message).toBe(
      'execution controller bootstrap did not observe a completed durable successor pass',
    )
    expect(sleeps).toBe(executionControllerBootstrapCompletionMaximumAttempts(config.operationTimeoutMs) - 1)
    expect(statusReads).toBe(executionControllerBootstrapCompletionMaximumAttempts(config.operationTimeoutMs))
    expect(executionControllerSuccessorPassCompleted(pending, activation)).toBe(false)
  })

  test('rejects unauthenticated bootstrap and caller-selected activation counters', async () => {
    const token = Buffer.alloc(32, 7).toString('base64url')
    const authorizationHash = Result.getOrThrow(executionBootstrapAuthorizationHash(token))
    let objectCalls = 0
    const controller = makeBaynExecutionController(config, {
      advance: () => Promise.reject(new Error('must not advance')),
      log: () => Promise.resolve(),
      projectState: () => Promise.resolve(),
    })
    const start = bootstrapHandlers(makeBaynExecutionBootstrap(config, controller, authorizationHash)).start
    const context = {
      request: () => ({
        id: 'bootstrap-rejected',
        headers: new Map<string, string>(),
        attemptCompletedSignal: new AbortController().signal,
      }),
      objectClient: () => {
        objectCalls += 1
        return {
          status: () => Promise.resolve(null),
          activate: () => Promise.reject(new Error('must not activate')),
        }
      },
    } as unknown as Context
    const bootstrap = {
      schemaVersion: 'bayn.execution-controller-bootstrap.v2',
      controllerKey,
      planHash,
      sourceRevision,
    }

    expect(start(context, bootstrap)).rejects.toThrow('execution controller bootstrap authorization failed')
    expect(start(context, { ...bootstrap, epoch: 19, firstSequence: 41 })).rejects.toThrow(
      'execution controller bootstrap failed validation',
    )
    expect(objectCalls).toBe(0)
  })

  test('rejects a plan-drifted bootstrap before touching the native controller', async () => {
    const token = Buffer.alloc(32, 7).toString('base64url')
    const authorizationHash = Result.getOrThrow(executionBootstrapAuthorizationHash(token))
    let controllerCalls = 0
    const controller = makeBaynExecutionController(config, {
      advance: () => Promise.reject(new Error('must not advance')),
      log: () => Promise.resolve(),
      projectState: () => Promise.resolve(),
    })
    const start = bootstrapHandlers(makeBaynExecutionBootstrap(config, controller, authorizationHash)).start
    const context = {
      request: () => ({
        id: 'bootstrap-plan-drift',
        headers: new Map([['authorization', `Bearer ${token}`]]),
        attemptCompletedSignal: new AbortController().signal,
      }),
      objectClient: () => {
        controllerCalls += 1
        return { status: () => Promise.reject(new Error('must not read')) }
      },
    } as unknown as Context

    expect(
      start(context, {
        schemaVersion: 'bayn.execution-controller-bootstrap.v2',
        controllerKey,
        planHash: 'f'.repeat(64),
        sourceRevision,
      }),
    ).rejects.toThrow('execution controller bootstrap does not match this immutable deployment')
    expect(controllerCalls).toBe(0)
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
      lastCompletion: {
        sequence: 11,
        outcome: ExecutionControllerOutcome.Blocked,
        receiptHash: 'e'.repeat(64),
        completedAt: '2026-08-13T17:59:30.000Z',
      },
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
      makeBaynExecutionController(
        {
          ...config,
          previousBinding: { planHash: 'd'.repeat(64), sourceRevision: 'e'.repeat(40) },
        },
        {
          advance: (command) => {
            commands.push(command)
            return Promise.reject(new Error('temporary database outage'))
          },
          log: (level) => {
            loggedLevels.push(level)
            return Promise.reject(new Error('telemetry unavailable'))
          },
          projectState: () => Promise.resolve(),
        },
      ),
    )
    let tick: unknown = {
      schemaVersion: 'bayn.execution-controller-tick.v1',
      epoch: 7,
      sequence: 12,
      attempt: 0,
    }

    const maximumAttempts = executionControllerAdvanceMaximumAttempts(false)
    for (let attempt = 0; attempt < maximumAttempts - 1; attempt += 1) {
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
    expect(commands).toHaveLength(maximumAttempts)
    expect(new Set(commands.map(({ issuedAt }) => issuedAt))).toEqual(new Set(['2026-08-13T18:00:00.000Z']))
    expect(deliveries).toHaveLength(0)
    expect(loggedLevels).toEqual(['warning', 'warning', 'error'])
  })

  test('keeps a replacement tick retryable across the predecessor termination grace period', async () => {
    let state: ExecutionControllerState = {
      schemaVersion: 1,
      active: true,
      epoch: 7,
      planHash,
      sourceRevision,
      initialSequence: 12,
      nextSequence: 12,
    }
    const deliveries: Delivery[] = []
    let advances = 0
    let invocation = 0
    const context = {
      key: controllerKey,
      get: async () => state,
      set: (_key: string, next: ExecutionControllerState) => {
        state = next
      },
      genericSend: (delivery: Delivery) => deliveries.push(delivery),
      run: async <A>(_name: string, action: () => Promise<A>) => action(),
      date: { toJSON: async () => '2026-08-13T18:00:00.000Z' },
      request: () => ({
        id: `rotation-${invocation++}`,
        attemptCompletedSignal: new AbortController().signal,
      }),
    } as unknown as TestContext
    const object = handlers(
      makeBaynExecutionController(
        {
          ...config,
          previousBinding: { planHash: 'd'.repeat(64), sourceRevision: 'e'.repeat(40) },
        },
        {
          advance: () => {
            advances += 1
            return advances <= 6
              ? Promise.reject(new Error('predecessor still owns the writer fence'))
              : Promise.resolve({
                  completedAt: '2026-08-13T18:00:16.000Z',
                  outcome: {
                    _tag: ExecutionControllerOutcome.Blocked,
                    receiptHash: 'f'.repeat(64),
                    nextDelayMs: 30_000,
                  },
                })
          },
          log: () => Promise.resolve(),
          projectState: () => Promise.resolve(),
        },
      ),
    )
    let tick: unknown = {
      schemaVersion: 'bayn.execution-controller-tick.v1',
      epoch: 7,
      sequence: 12,
      attempt: 0,
    }

    const handoffDelays: number[] = []
    for (let attempt = 0; attempt < 6; attempt += 1) {
      await object.tick(context, tick)
      const retry = deliveries.shift()
      if (retry === undefined) throw new Error('replacement handoff did not schedule its durable retry')
      if (retry.delay === undefined) throw new Error('replacement handoff retry did not include a delay')
      handoffDelays.push(retry.delay)
      tick = retry.parameter
    }
    await object.tick(context, tick)

    expect(handoffDelays).toEqual([1_000, 2_000, 4_000, 8_000, 16_000, 30_000])
    expect(handoffDelays.reduce((total, delay) => total + delay, 0)).toBeGreaterThan(60_000)
    expect(advances).toBe(7)
    expect(state).toMatchObject({
      nextSequence: 13,
      lastCompletion: { sequence: 12, receiptHash: 'f'.repeat(64) },
    })
    expect(deliveries).toEqual([
      expect.objectContaining({
        delay: 30_000,
        parameter: expect.objectContaining({ sequence: 13, attempt: 0 }),
      }),
    ])
  })
})
