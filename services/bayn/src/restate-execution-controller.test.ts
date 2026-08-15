import { describe, expect, test } from 'bun:test'

import type { Context, ObjectContext } from '@restatedev/restate-sdk'
import { Result } from 'effect'

import type { ExecutionControllerState } from './execution/controller'
import { ExecutionControllerOutcome } from './execution/controller-status'
import {
  executionControllerAdvanceRunOptions,
  executionControllerAdvanceMaximumAttempts,
  executionControllerBootstrapHandlerTimeouts,
  executionControllerCommandRetryPolicy,
  executionControllerCutoverAwaitTimeoutMs,
  executionControllerHandlerTimeouts,
  executionControllerInitialTickDelayMs,
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
    expect(executionControllerAdvanceRunOptions).toEqual({ maxRetryAttempts: 0 })
    expect(executionControllerAdvanceMaximumAttempts).toBe(3)
    expect(executionControllerTickRetryPolicy).toEqual({ maxAttempts: 1, onMaxAttempts: 'pause' })
    expect(executionControllerCommandRetryPolicy).toMatchObject({ maxAttempts: 3, onMaxAttempts: 'pause' })
    expect(executionControllerHandlerTimeouts(30_000)).toEqual({
      inactivityTimeout: 450_000,
      abortTimeout: 30_000,
    })
    expect(executionControllerCutoverAwaitTimeoutMs(30_000)).toBe(651_000)
    expect(executionControllerBootstrapHandlerTimeouts(30_000, true)).toEqual({
      inactivityTimeout: 651_000,
      abortTimeout: 30_000,
    })
    expect(executionControllerBootstrapHandlerTimeouts(30_000, false)).toEqual(
      executionControllerHandlerTimeouts(30_000),
    )
  })

  test('serializes activation, one durable advance, scheduling, stale delivery, and deactivation', async () => {
    let state: ExecutionControllerState | null = null
    const deliveries: Delivery[] = []
    const calls: Array<{
      readonly command: Parameters<Parameters<typeof makeBaynExecutionController>[1]['advance']>[0]
      readonly signal: AbortSignal
    }> = []
    const attempt = new AbortController()
    const projectedStates: ExecutionControllerState[] = []
    const runtime = {
      advance: async (command: (typeof calls)[number]['command'], signal: AbortSignal) => {
        calls.push({ command, signal })
        return {
          completedAt: '2026-08-13T18:00:01.000Z',
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
      },
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
      delay: executionControllerInitialTickDelayMs,
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
    expect(projectedStates).toHaveLength(1)
    expect(projectedStates[0]).toMatchObject({ active: false, epoch: 2, nextSequence: 5 })
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
    let forwarded: unknown
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
          return state
        },
      }),
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
  })

  test('rotates only the exact previous native binding and replays without a second deactivation', async () => {
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
    const controller = makeBaynExecutionController(rotationConfig, {
      advance: () => Promise.reject(new Error('must not advance')),
      log: () => Promise.resolve(),
      projectState: () => Promise.resolve(),
    })
    const start = bootstrapHandlers(makeBaynExecutionBootstrap(rotationConfig, controller, authorizationHash)).start
    const context = {
      request: () => ({
        id: 'bootstrap-native-rotation',
        headers: new Map([['authorization', `Bearer ${token}`]]),
        attemptCompletedSignal: new AbortController().signal,
      }),
      objectClient: () => ({
        status: async () => state,
        deactivate: async (request: unknown) => {
          events.push('deactivate')
          expect(request).toEqual({
            schemaVersion: 'bayn.execution-controller-deactivation.v1',
            controllerKey,
            epoch: 4,
            ...previousBinding,
          })
          state = { ...state, active: false, epoch: 5 }
          return state
        },
        activate: async (request: unknown) => {
          events.push('activate')
          expect(request).toEqual({
            schemaVersion: 'bayn.execution-controller-activation.v1',
            controllerKey,
            epoch: 5,
            firstSequence: 12,
            planHash,
            sourceRevision,
          })
          state = {
            ...state,
            active: true,
            planHash,
            sourceRevision,
            initialSequence: 12,
          }
          return state
        },
      }),
    } as unknown as Context
    const request = {
      schemaVersion: 'bayn.execution-controller-bootstrap.v3' as const,
      controllerKey,
      planHash,
      sourceRevision,
      previousBinding,
    }

    expect(await start(context, request)).toMatchObject({ active: true, epoch: 5, planHash, sourceRevision })
    expect(events).toEqual(['deactivate', 'activate'])

    await start(context, request)
    expect(events).toEqual(['deactivate', 'activate', 'activate'])
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

  test('deactivates and verifies the exact legacy owner before first native activation', async () => {
    const token = Buffer.alloc(32, 7).toString('base64url')
    const authorizationHash = Result.getOrThrow(executionBootstrapAuthorizationHash(token))
    const events: string[] = []
    let forwarded: unknown
    const controller = makeBaynExecutionController(config, {
      advance: () => Promise.reject(new Error('must not advance')),
      log: () => Promise.resolve(),
      projectState: () => Promise.resolve(),
    })
    const legacy = {
      controllerKey: 'primary',
      deactivationSchemaVersion: 'bayn.restate-lifecycle-activation.v1' as const,
      planHash: 'd'.repeat(64),
      sourceRevision: 'e'.repeat(40),
    }
    const start = bootstrapHandlers(makeBaynExecutionBootstrap(config, controller, authorizationHash, [], legacy)).start
    const context = {
      request: () => ({
        id: 'bootstrap-cutover',
        headers: new Map([['authorization', `Bearer ${token}`]]),
        attemptCompletedSignal: new AbortController().signal,
      }),
      genericCall: async (call: { readonly service: string; readonly method: string; readonly key?: string }) => {
        events.push('legacy-deactivate')
        expect(call).toMatchObject({
          service: 'BaynLifecycle',
          method: 'deactivate',
          key: 'primary',
          parameter: {
            schemaVersion: 'bayn.restate-lifecycle-activation.v1',
            controllerKey: 'primary',
          },
        })
        return {
          schemaVersion: 'bayn.restate-lifecycle-state.v1',
          active: false,
          epoch: 11,
          planHash: legacy.planHash,
          sourceRevision: legacy.sourceRevision,
          cursor: { _tag: 'Next', sequence: 5511 },
          lastCompletion: null,
        }
      },
      objectClient: () => ({
        status: async () => {
          events.push('native-status')
          return null
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
            nextSequence: 0,
          }
        },
      }),
    } as unknown as Context

    await start(context, {
      schemaVersion: 'bayn.execution-controller-bootstrap.v2',
      controllerKey,
      planHash,
      sourceRevision,
    })

    expect(events).toEqual(['native-status', 'legacy-deactivate', 'native-activate'])
    expect(forwarded).toMatchObject({ epoch: 1, firstSequence: 0, planHash, sourceRevision })
  })

  test('uses the provenance-rich legacy deactivation wire when explicitly configured', async () => {
    const token = Buffer.alloc(32, 7).toString('base64url')
    const authorizationHash = Result.getOrThrow(executionBootstrapAuthorizationHash(token))
    const legacy = {
      controllerKey: 'primary',
      deactivationSchemaVersion: 'bayn.restate-lifecycle-deactivation.v1' as const,
      planHash: 'd'.repeat(64),
      sourceRevision: 'e'.repeat(40),
    }
    let parameter: unknown
    const controller = makeBaynExecutionController(config, {
      advance: () => Promise.reject(new Error('must not advance')),
      log: () => Promise.resolve(),
      projectState: () => Promise.resolve(),
    })
    const start = bootstrapHandlers(makeBaynExecutionBootstrap(config, controller, authorizationHash, [], legacy)).start
    const context = {
      request: () => ({
        id: 'bootstrap-cutover-v1',
        headers: new Map([['authorization', `Bearer ${token}`]]),
        attemptCompletedSignal: new AbortController().signal,
      }),
      genericCall: (call: { readonly parameter: unknown }) => {
        parameter = call.parameter
        return Promise.resolve({
          schemaVersion: 'bayn.restate-lifecycle-state.v1',
          active: false,
          epoch: 11,
          planHash: legacy.planHash,
          sourceRevision: legacy.sourceRevision,
          cursor: { _tag: 'Next', sequence: 5511 },
          lastCompletion: null,
        })
      },
      objectClient: () => ({
        status: () => Promise.resolve(null),
        activate: () =>
          Promise.resolve({
            schemaVersion: 1,
            active: true,
            epoch: 1,
            planHash,
            sourceRevision,
            initialSequence: 0,
            nextSequence: 0,
          }),
      }),
    } as unknown as Context

    await start(context, {
      schemaVersion: 'bayn.execution-controller-bootstrap.v2',
      controllerKey,
      planHash,
      sourceRevision,
    })

    expect(parameter).toEqual({
      schemaVersion: 'bayn.restate-lifecycle-deactivation.v1',
      controllerKey: legacy.controllerKey,
      planHash: legacy.planHash,
      sourceRevision: legacy.sourceRevision,
    })
  })

  test('does not activate when the legacy owner cannot be verified inactive', async () => {
    const token = Buffer.alloc(32, 7).toString('base64url')
    const authorizationHash = Result.getOrThrow(executionBootstrapAuthorizationHash(token))
    let activations = 0
    const controller = makeBaynExecutionController(config, {
      advance: () => Promise.reject(new Error('must not advance')),
      log: () => Promise.resolve(),
      projectState: () => Promise.resolve(),
    })
    const start = bootstrapHandlers(
      makeBaynExecutionBootstrap(config, controller, authorizationHash, [], {
        controllerKey: 'primary',
        deactivationSchemaVersion: 'bayn.restate-lifecycle-activation.v1',
        planHash: 'd'.repeat(64),
        sourceRevision: 'e'.repeat(40),
      }),
    ).start
    const context = {
      request: () => ({
        id: 'bootstrap-cutover-rejected',
        headers: new Map([['authorization', `Bearer ${token}`]]),
        attemptCompletedSignal: new AbortController().signal,
      }),
      genericCall: () =>
        Promise.resolve({
          schemaVersion: 'bayn.restate-lifecycle-state.v1',
          active: false,
          epoch: 11,
          planHash: 'f'.repeat(64),
          sourceRevision: 'e'.repeat(40),
          cursor: { _tag: 'Next', sequence: 5511 },
          lastCompletion: null,
        }),
      objectClient: () => ({
        status: () => Promise.resolve(null),
        activate: () => {
          activations += 1
          return Promise.reject(new Error('must not activate'))
        },
      }),
    } as unknown as Context

    expect(
      start(context, {
        schemaVersion: 'bayn.execution-controller-bootstrap.v2',
        controllerKey,
        planHash,
        sourceRevision,
      }),
    ).rejects.toThrow('legacy lifecycle deactivation did not prove the expected inactive owner')
    expect(activations).toBe(0)
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

  test('rejects a plan-drifted bootstrap before touching either lifecycle owner', async () => {
    const token = Buffer.alloc(32, 7).toString('base64url')
    const authorizationHash = Result.getOrThrow(executionBootstrapAuthorizationHash(token))
    let ownerCalls = 0
    const controller = makeBaynExecutionController(config, {
      advance: () => Promise.reject(new Error('must not advance')),
      log: () => Promise.resolve(),
      projectState: () => Promise.resolve(),
    })
    const start = bootstrapHandlers(
      makeBaynExecutionBootstrap(config, controller, authorizationHash, [], {
        controllerKey: 'primary',
        deactivationSchemaVersion: 'bayn.restate-lifecycle-activation.v1',
        planHash: 'd'.repeat(64),
        sourceRevision: 'e'.repeat(40),
      }),
    ).start
    const context = {
      request: () => ({
        id: 'bootstrap-plan-drift',
        headers: new Map([['authorization', `Bearer ${token}`]]),
        attemptCompletedSignal: new AbortController().signal,
      }),
      genericCall: () => {
        ownerCalls += 1
        return Promise.reject(new Error('must not deactivate'))
      },
      objectClient: () => {
        ownerCalls += 1
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
    expect(ownerCalls).toBe(0)
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
          return Promise.reject(new Error('telemetry unavailable'))
        },
        projectState: () => Promise.resolve(),
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
