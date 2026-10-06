import { describe, expect, test } from 'bun:test'

import { TerminalError, type ObjectSharedContext, type ObjectContext } from '@restatedev/restate-sdk'
import { Result } from 'effect'
import {
  CaptureInvalidation,
  type ResearchCaptureEvent,
  type ResearchCaptureObserver,
} from '../research-capture/capture'

import {
  executionControllerMaximumRecoveryWindow,
  executionControllerSuccessorPassCompleted,
  type ExecutionControllerState,
} from '../execution/controller'
import { TransientExecutionFailure } from '../execution/advance'
import { ExecutionControllerOutcome } from '../execution/controller-status'
import { CycleRunnerError } from '../cycle/runner/model'
import { OperationalError } from '../errors'
import {
  executionControllerAdvanceRunOptions,
  executionControllerAdvanceMaximumAttempts,
  executionControllerDeploymentCompletionMaximumAttempts,
  executionControllerDeploymentCompletionPollIntervalMs,
  executionControllerDeploymentHandlerTimeouts,
  executionControllerDeploymentRotationBoundMs,
  executionControllerCommandRetryPolicy,
  executionControllerHandlerTimeouts,
  executionControllerInitialTickDelayMs,
  executionControllerRecoveryDelayMs,
  executionControllerRecoveryMaximumDelayMs,
  executionControllerRecoveryTickDelayMs,
  executionControllerRecoveryTickIdempotencyKey,
  executionControllerSourceCatchUpTickIdempotencyKey,
  executionControllerTickIdempotencyKey,
  executionControllerTickRetryPolicy,
  executionActivationAuthorizationHash,
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
  activationAuthorizationHash: Result.getOrThrow(
    executionActivationAuthorizationHash(Buffer.alloc(32, 7).toString('base64url')),
  ),
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
        readonly activateDeployment: (ctx: ObjectSharedContext, candidate: unknown) => Promise<ExecutionControllerState>
      }
    }
  ).object

type TestContext = ObjectContext<{ readonly controller: ExecutionControllerState }>

test.each([undefined, { hashes: ['a'.repeat(64), 'b'.repeat(64)], complete: true }])(
  'journal replay cannot fabricate a fresh runtime start or a complete original capture (%j)',
  async (jevObservationReferences) => {
    let state: ExecutionControllerState = {
      schemaVersion: 1,
      active: true,
      epoch: 1,
      planHash,
      sourceRevision,
      initialSequence: 4,
      nextSequence: 4,
    }
    const receipts: ResearchCaptureEvent[] = []
    const invalidations: CaptureInvalidation[] = []
    let runtimeCalls = 0
    const cachedResult = {
      completedAt: '2026-08-13T18:00:01.000Z',
      ...(jevObservationReferences === undefined
        ? {}
        : {
            observation: {
              result: 'SUCCESS' as const,
              outcome: 'WINDOW_CLOSED' as const,
              observedAt: '2026-08-13T18:00:01.000Z',
              jevObservationReferences,
            },
          }),
      outcome: { _tag: ExecutionControllerOutcome.Blocked, receiptHash: 'd'.repeat(64), nextDelayMs: 30_000 },
    }
    const controller = handlers(
      makeBaynExecutionController(config, {
        capture: {
          record: (event) => {
            receipts.push(event)
          },
          invalidate: (reason) => {
            invalidations.push(reason)
          },
        },
        advance: async () => {
          runtimeCalls++
          return cachedResult
        },
        log: async () => undefined,
        projectState: async () => undefined,
      }),
    )
    const context = {
      key: controllerKey,
      get: async () => state,
      set: (_key: string, next: ExecutionControllerState) => {
        state = next
      },
      genericSend: () => undefined,
      run: async () => cachedResult,
      date: {
        toJSON: async () => {
          throw new Error('Unexpected journal clock')
        },
      },
      request: () => ({ id: 'replayed-invocation', attemptCompletedSignal: new AbortController().signal }),
    } as unknown as TestContext
    await controller.tick(context, {
      schemaVersion: 'bayn.execution-controller-tick.v1',
      epoch: 1,
      sequence: 4,
      issuedAt: '2026-08-13T18:00:00.000Z',
    })
    expect(runtimeCalls).toBe(0)
    expect(state.nextSequence).toBe(5)
    expect(receipts.map((receipt) => (receipt.kind === 'controller-pass' ? receipt.phase : undefined))).toEqual([
      'COMPLETED',
      'SCHEDULED',
    ])
    expect(receipts[0]).toMatchObject({ runtimeAttempted: false, completedAt: cachedResult.completedAt })
    expect(receipts[0]).toMatchObject(jevObservationReferences === undefined ? {} : { jevObservationReferences })
    if (jevObservationReferences === undefined) expect(receipts[0]).not.toHaveProperty('jevObservationReferences')
    expect(invalidations).toEqual([CaptureInvalidation.ControllerReplay])
  },
)

test('optional capture preserves synchronous scheduling, supplied command timestamps and native retry identity', async () => {
  const exercise = async (mode: 'absent' | 'record' | 'broken' | 'mutating') => {
    let state: ExecutionControllerState | null = null
    const deliveries: Delivery[] = []
    const trace: string[] = []
    const receipts: ResearchCaptureEvent[] = []
    const commands: unknown[] = []
    let calls = 0
    let journalClockCalls = 0
    const signal = new AbortController().signal
    const capture: ResearchCaptureObserver | undefined =
      mode === 'absent'
        ? undefined
        : {
            record: (event) => {
              if (mode === 'broken') throw new Error('capture unavailable')
              if (mode === 'mutating' && event.kind === 'controller-pass')
                Object.assign(event.tick, { sequence: 999, epoch: 999, issuedAt: '2099-01-01T00:00:00.000Z' })
              receipts.push(event)
            },
            invalidate: () => {
              if (mode === 'broken') throw new Error('capture invalidation unavailable')
            },
          }
    const runtime = {
      ...(capture === undefined ? {} : { capture }),
      advance: async (command: Parameters<Parameters<typeof makeBaynExecutionController>[1]['advance']>[0]) => {
        commands.push(command)
        trace.push('advance')
        if (++calls === 1) throw new Error('recoverable fixture failure')
        return {
          completedAt: '2026-08-13T18:00:01.000Z',
          outcome: { _tag: ExecutionControllerOutcome.Blocked, receiptHash: 'd'.repeat(64), nextDelayMs: 30_000 },
        }
      },
      log: async () => undefined,
      projectState: async () => {
        trace.push('project')
      },
    }
    const context = {
      key: controllerKey,
      get: async () => state,
      set: (_key: string, next: ExecutionControllerState) => {
        trace.push('set')
        state = next
      },
      genericSend: (delivery: Delivery) => {
        trace.push('send')
        deliveries.push(delivery)
      },
      run: async <A>(name: string, action: () => Promise<A>) => {
        trace.push(name)
        return action()
      },
      date: {
        toJSON: async () => {
          journalClockCalls++
          throw new Error('No new journal clock is allowed')
        },
      },
      request: () => ({ id: 'capture-test-invocation', attemptCompletedSignal: signal }),
    } as unknown as TestContext
    const controller = handlers(makeBaynExecutionController(config, runtime))
    await controller.activate(context, activation)
    const suppliedIssuedAt = '2026-08-13T18:00:00.000Z'
    const tick = {
      schemaVersion: 'bayn.execution-controller-tick.v1',
      epoch: 1,
      sequence: 4,
      attempt: 0,
      issuedAt: suppliedIssuedAt,
    }
    await controller.tick(context, tick)
    const retry = deliveries[1]
    if (retry === undefined) throw new Error('Missing native retry')
    await controller.tick(context, retry.parameter)
    await controller.tick(context, tick)
    expect(journalClockCalls).toBe(0)
    expect(commands).toHaveLength(2)
    expect(commands.every((command) => (command as { issuedAt: string }).issuedAt === suppliedIssuedAt)).toBe(true)
    expect(retry).toMatchObject({
      delay: 1000,
      idempotencyKey: executionControllerTickIdempotencyKey(1, 4, 1),
      parameter: { issuedAt: suppliedIssuedAt },
    })
    if (mode === 'record') {
      expect(receipts.map((receipt) => (receipt.kind === 'controller-pass' ? receipt.phase : undefined))).toEqual([
        'SCHEDULED',
        'STARTED',
        'FAILED',
        'SCHEDULED',
        'STARTED',
        'COMPLETED',
        'SCHEDULED',
        'IGNORED',
      ])
      expect(receipts[3]).toMatchObject({
        kind: 'controller-pass',
        phase: 'SCHEDULED',
        tick: retry.parameter,
        idempotencyKey: retry.idempotencyKey,
      })
      expect(receipts[5]).toMatchObject({
        kind: 'controller-pass',
        commandIssuedAt: suppliedIssuedAt,
        completedAt: '2026-08-13T18:00:01.000Z',
      })
    }
    return { trace, deliveries, commands, state }
  }
  const baseline = await exercise('absent')
  expect(await exercise('record')).toEqual(baseline)
  expect(await exercise('broken')).toEqual(baseline)
  expect(await exercise('mutating')).toEqual(baseline)
})

describe('native Restate execution controller', () => {
  test('uses bounded pause-on-exhaustion policies and a complete command timeout', () => {
    expect(executionControllerInitialTickDelayMs).toBe(0)
    expect(executionControllerRecoveryTickDelayMs).toBe(30_000)
    expect(executionControllerRecoveryDelayMs(1)).toBe(30_000)
    expect(executionControllerRecoveryDelayMs(2)).toBe(120_000)
    expect(executionControllerRecoveryDelayMs(executionControllerMaximumRecoveryWindow)).toBe(
      executionControllerRecoveryMaximumDelayMs,
    )
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
    expect(executionControllerDeploymentRotationBoundMs(30_000)).toBe(480_000)
    expect(executionControllerDeploymentCompletionPollIntervalMs).toBe(5_000)
    expect(executionControllerDeploymentCompletionMaximumAttempts(30_000)).toBe(85)
    expect(executionControllerDeploymentHandlerTimeouts(30_000, true)).toEqual({
      inactivityTimeout: 480_000,
      abortTimeout: 30_000,
    })
    expect(executionControllerDeploymentHandlerTimeouts(30_000, false)).toEqual(
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
            outcome: 'WINDOW_CLOSED' as const,
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
      },
      nextDueAt: '2026-08-13T18:00:31.000Z',
    })
    expect((state as ExecutionControllerState | null)?.lastCompletion).not.toHaveProperty('lastPass')
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

  test('replayed activation schedules the missing catch-up pass for a newer worker revision', async () => {
    const previousSourceRevision = 'd'.repeat(40)
    const state: ExecutionControllerState = {
      schemaVersion: 1,
      active: true,
      epoch: activation.epoch,
      planHash,
      sourceRevision: previousSourceRevision,
      initialSequence: activation.firstSequence,
      nextSequence: activation.firstSequence,
    }
    const deliveries: Delivery[] = []
    const normalKey = executionControllerTickIdempotencyKey(state.epoch, state.nextSequence, 0)
    const acceptedKeys = new Set([normalKey])
    let committed = false
    const context = {
      key: controllerKey,
      get: async () => state,
      set: () => {
        committed = true
      },
      genericSend: (delivery: Delivery) => {
        if (delivery.idempotencyKey === undefined || acceptedKeys.has(delivery.idempotencyKey)) return
        acceptedKeys.add(delivery.idempotencyKey)
        deliveries.push(delivery)
      },
      run: async <A>(_name: string, action: () => Promise<A>) => action(),
      request: () => ({ id: 'source-catch-up', attemptCompletedSignal: new AbortController().signal }),
    } as unknown as TestContext
    const object = handlers(
      makeBaynExecutionController(config, {
        advance: () => Promise.reject(new Error('activation must not advance inline')),
        log: () => Promise.resolve(),
        projectState: () => Promise.resolve(),
      }),
    )

    expect(await object.activate(context, activation)).toEqual(state)
    expect(await object.activate(context, activation)).toEqual(state)
    expect(committed).toBe(false)
    expect(deliveries).toEqual([
      expect.objectContaining({
        delay: executionControllerInitialTickDelayMs,
        idempotencyKey: executionControllerSourceCatchUpTickIdempotencyKey(
          state.epoch,
          state.nextSequence,
          0,
          sourceRevision,
        ),
        parameter: expect.objectContaining({
          epoch: state.epoch,
          sequence: state.nextSequence,
          attempt: 0,
          sourceCatchUpRevision: sourceRevision,
        }),
      }),
    ])
    expect(deliveries[0]?.idempotencyKey).not.toBe(normalKey)
  })

  test('quiesces a source catch-up routed to a different immutable worker', async () => {
    const state: ExecutionControllerState = {
      schemaVersion: 1,
      active: true,
      epoch: 7,
      planHash,
      sourceRevision,
      initialSequence: 12,
      nextSequence: 12,
    }
    const logged: string[] = []
    let advances = 0
    const context = {
      key: controllerKey,
      get: async () => state,
      set: () => undefined,
      genericSend: () => undefined,
      run: async <A>(_name: string, action: () => Promise<A>) => action(),
      request: () => ({ id: 'foreign-catch-up', attemptCompletedSignal: new AbortController().signal }),
    } as unknown as TestContext
    const object = handlers(
      makeBaynExecutionController(config, {
        advance: () => {
          advances += 1
          return Promise.reject(new Error('foreign catch-up must not advance'))
        },
        log: (_level, message) => {
          logged.push(message)
          return Promise.resolve()
        },
        projectState: () => Promise.resolve(),
      }),
    )

    await object.tick(context, {
      schemaVersion: 'bayn.execution-controller-tick.v1',
      epoch: 7,
      sequence: 12,
      sourceCatchUpRevision: 'f'.repeat(40),
    })

    expect(advances).toBe(0)
    expect(logged).toEqual(['Bayn execution controller quiesced a foreign source catch-up'])
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
    expect(failure).toBeInstanceOf(TerminalError)
    expect((failure as TerminalError).code).toBe(400)
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

  test('authenticates deployment activation and derives activation counters from durable state', async () => {
    const token = Buffer.alloc(32, 7).toString('base64url')
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
    const start = handlers(controller).activateDeployment
    const context = {
      key: controllerKey,
      request: () => ({
        id: 'deployment-authorized',
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
      genericCall: (command: { service: string; method: string; key: string; parameter: unknown }) => {
        genericCalls += 1
        expect(command).toMatchObject({
          service: 'BaynBrokerObservations',
          method: 'activate',
          key: controllerKey,
          parameter: { sourceRevision },
        })
        return Promise.resolve({ sourceRevision, epoch: 1, sequence: 1, lastSnapshotHash: 'a'.repeat(64) })
      },
    } as unknown as ObjectSharedContext

    await start(context, {
      schemaVersion: 'bayn.execution-deployment-activation.v1',
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
    expect(genericCalls).toBe(1)
  })

  test('does not activate execution when the initial broker poll has no published cut', async () => {
    const token = Buffer.alloc(32, 7).toString('base64url')
    const controller = makeBaynExecutionController(config, {
      advance: () => Promise.reject(new Error('must not advance')),
      log: () => Promise.resolve(),
      projectState: () => Promise.resolve(),
    })
    let activations = 0
    const context = {
      key: controllerKey,
      request: () => ({
        id: 'deployment-missing-observation',
        headers: new Map([['authorization', `Bearer ${token}`]]),
        attemptCompletedSignal: new AbortController().signal,
      }),
      objectClient: () => ({
        status: async () => null,
        activate: async () => {
          activations += 1
        },
      }),
      genericCall: async () => ({ sourceRevision, epoch: 1, sequence: 1 }),
    } as unknown as ObjectSharedContext
    const failure = await handlers(controller)
      .activateDeployment(context, {
        schemaVersion: 'bayn.execution-deployment-activation.v1',
        controllerKey,
        planHash,
        sourceRevision,
      })
      .catch((cause: unknown) => cause)
    expect(String(failure)).toContain('requires a fresh published broker observation')
    expect(activations).toBe(0)
  })

  test('rotates the exact previous binding into one immediate pass and ignores its stale tick', async () => {
    const token = Buffer.alloc(32, 7).toString('base64url')
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
    const start = handlers(controller).activateDeployment
    const context = {
      key: controllerKey,
      request: () => ({
        id: 'deployment-native-rotation',
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
      genericCall: (command: { service: string; method: string; key: string; parameter: unknown }) => {
        genericCalls += 1
        expect(command).toMatchObject({
          service: 'BaynBrokerObservations',
          method: 'activate',
          key: controllerKey,
          parameter: { sourceRevision },
        })
        return Promise.resolve({ sourceRevision, epoch: 1, sequence: 1, lastSnapshotHash: 'a'.repeat(64) })
      },
    } as unknown as ObjectSharedContext
    const request = {
      schemaVersion: 'bayn.execution-deployment-activation.v1' as const,
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
    expect(genericCalls).toBe(1)

    await start(context, request)
    expect(projectedStates).toHaveLength(3)
    expect(projectedStates[2]).toEqual(state)
    expect(deliveries).toHaveLength(1)
    expect(genericCalls).toBe(2)

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
    const previousBinding = { planHash: 'd'.repeat(64), sourceRevision: 'e'.repeat(40) }
    const rotationConfig = { ...config, previousBinding }
    let objectCalls = 0
    const controller = makeBaynExecutionController(rotationConfig, {
      advance: () => Promise.reject(new Error('must not advance')),
      log: () => Promise.resolve(),
      projectState: () => Promise.resolve(),
    })
    const start = handlers(controller).activateDeployment
    const context = {
      key: controllerKey,
      request: () => ({
        id: 'deployment-native-rotation-rejected',
        headers: new Map([['authorization', `Bearer ${token}`]]),
        attemptCompletedSignal: new AbortController().signal,
      }),
      objectClient: () => {
        objectCalls += 1
        return { status: () => Promise.reject(new Error('must not read')) }
      },
    } as unknown as ObjectSharedContext

    for (const candidate of [
      {
        schemaVersion: 'bayn.execution-deployment-activation.v1',
        controllerKey,
        planHash,
        sourceRevision,
      },
      {
        schemaVersion: 'bayn.execution-deployment-activation.v1',
        controllerKey,
        planHash,
        sourceRevision,
        previousBinding: { ...previousBinding, planHash: 'f'.repeat(64) },
      },
    ]) {
      expect(start(context, candidate)).rejects.toThrow(
        'execution controller deployment activation does not match this immutable deployment',
      )
    }
    expect(objectCalls).toBe(0)
  })

  test('activates null native state without calling any legacy service', async () => {
    const token = Buffer.alloc(32, 7).toString('base64url')
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
    const start = handlers(controller).activateDeployment
    const context = {
      key: controllerKey,
      request: () => ({
        id: 'deployment-null-native-state',
        headers: new Map([['authorization', `Bearer ${token}`]]),
        attemptCompletedSignal: new AbortController().signal,
      }),
      genericCall: (command: { service: string; method: string; key: string; parameter: unknown }) => {
        genericCalls += 1
        expect(command).toMatchObject({
          service: 'BaynBrokerObservations',
          method: 'activate',
          key: controllerKey,
          parameter: { sourceRevision },
        })
        return Promise.resolve({ sourceRevision, epoch: 1, sequence: 1, lastSnapshotHash: 'a'.repeat(64) })
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
    } as unknown as ObjectSharedContext

    await start(context, {
      schemaVersion: 'bayn.execution-deployment-activation.v1',
      controllerKey,
      planHash,
      sourceRevision,
    })

    expect(events).toEqual(['native-status', 'native-activate', 'native-sleep', 'native-status'])
    expect(forwarded).toMatchObject({ epoch: 1, firstSequence: 0, planHash, sourceRevision })
    expect(genericCalls).toBe(1)
  })

  test('waits for durable successor evidence and fails deployment when it never arrives', async () => {
    const token = Buffer.alloc(32, 7).toString('base64url')
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
    const start = handlers(controller).activateDeployment
    let sleeps = 0
    let statusReads = 0
    const context = {
      key: controllerKey,
      request: () => ({
        id: 'deployment-first-pass-timeout',
        headers: new Map([['authorization', `Bearer ${token}`]]),
        attemptCompletedSignal: new AbortController().signal,
      }),
      genericCall: async () => ({ sourceRevision, epoch: 1, sequence: 1, lastSnapshotHash: 'a'.repeat(64) }),
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
    } as unknown as ObjectSharedContext

    let failure: unknown
    try {
      await start(context, {
        schemaVersion: 'bayn.execution-deployment-activation.v1',
        controllerKey,
        planHash,
        sourceRevision,
      })
    } catch (cause) {
      failure = cause
    }
    expect(failure).toBeInstanceOf(Error)
    expect((failure as Error).message).toBe(
      'execution controller deployment activation did not observe a completed durable successor pass',
    )
    expect(sleeps).toBe(executionControllerDeploymentCompletionMaximumAttempts(config.operationTimeoutMs) - 1)
    expect(statusReads).toBe(executionControllerDeploymentCompletionMaximumAttempts(config.operationTimeoutMs))
    expect(executionControllerSuccessorPassCompleted(pending, activation)).toBe(false)
  })

  test('rejects unauthenticated deployment activation and caller-selected activation counters', async () => {
    let objectCalls = 0
    const controller = makeBaynExecutionController(config, {
      advance: () => Promise.reject(new Error('must not advance')),
      log: () => Promise.resolve(),
      projectState: () => Promise.resolve(),
    })
    const start = handlers(controller).activateDeployment
    const context = {
      key: controllerKey,
      request: () => ({
        id: 'deployment-rejected',
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
    } as unknown as ObjectSharedContext
    const deployment = {
      schemaVersion: 'bayn.execution-deployment-activation.v1',
      controllerKey,
      planHash,
      sourceRevision,
    }

    expect(start(context, deployment)).rejects.toThrow(
      'execution controller deployment activation authorization failed',
    )
    expect(start(context, { ...deployment, epoch: 19, firstSequence: 41 })).rejects.toThrow(
      'execution controller deployment activation failed validation',
    )
    expect(objectCalls).toBe(0)
  })

  test('rejects a plan-drifted deployment before touching the native controller', async () => {
    const token = Buffer.alloc(32, 7).toString('base64url')
    let controllerCalls = 0
    const controller = makeBaynExecutionController(config, {
      advance: () => Promise.reject(new Error('must not advance')),
      log: () => Promise.resolve(),
      projectState: () => Promise.resolve(),
    })
    const start = handlers(controller).activateDeployment
    const context = {
      key: controllerKey,
      request: () => ({
        id: 'deployment-plan-drift',
        headers: new Map([['authorization', `Bearer ${token}`]]),
        attemptCompletedSignal: new AbortController().signal,
      }),
      objectClient: () => {
        controllerCalls += 1
        return { status: () => Promise.reject(new Error('must not read')) }
      },
    } as unknown as ObjectSharedContext

    expect(
      start(context, {
        schemaVersion: 'bayn.execution-deployment-activation.v1',
        controllerKey,
        planHash: 'f'.repeat(64),
        sourceRevision,
      }),
    ).rejects.toThrow('execution controller deployment activation does not match this immutable deployment')
    expect(controllerCalls).toBe(0)
  })

  test('rejects a different object key before touching either owner', async () => {
    const token = Buffer.alloc(32, 7).toString('base64url')
    let ownerCalls = 0
    const controller = makeBaynExecutionController(config, {
      advance: () => Promise.reject(new Error('must not advance')),
      log: () => Promise.resolve(),
      projectState: () => Promise.resolve(),
    })
    const context = {
      key: 'd'.repeat(64),
      request: () => ({
        id: 'deployment-wrong-object-key',
        headers: new Map([['authorization', `Bearer ${token}`]]),
        attemptCompletedSignal: new AbortController().signal,
      }),
      objectClient: () => {
        ownerCalls += 1
      },
      genericCall: () => {
        ownerCalls += 1
      },
    } as unknown as ObjectSharedContext

    expect(
      handlers(controller).activateDeployment(context, {
        schemaVersion: 'bayn.execution-deployment-activation.v1',
        controllerKey,
        planHash,
        sourceRevision,
      }),
    ).rejects.toThrow('execution controller deployment activation does not match this immutable deployment')
    expect(ownerCalls).toBe(0)
  })

  test('retries the same command identity durably and starts a diagnosed recovery window after exhaustion', async () => {
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
    const loggedAnnotations: Array<Readonly<Record<string, string | number | boolean>>> = []
    const failure = new TransientExecutionFailure({
      operation: 'advance',
      message: 'execution advance did not complete within its bounded interpreter',
      cause: new CycleRunnerError({
        operation: 'read-authority-slot',
        failure: 'database',
        message: 'cycle runner could not read the authority slot',
        cause: new Error('database-secret-must-not-be-logged'),
      }),
    })
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
            return Promise.reject(failure)
          },
          log: (level, _message, annotations) => {
            loggedLevels.push(level)
            loggedAnnotations.push(annotations)
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

    await object.tick(context, tick)
    const recovery = deliveries.shift()
    if (recovery === undefined) throw new Error('retry exhaustion did not schedule a recovery window')
    expect(recovery.delay).toBe(executionControllerRecoveryTickDelayMs)
    const recoveryTick = recovery.parameter as { readonly retryWindowHash: string }
    expect(recovery.parameter).toMatchObject({
      schemaVersion: 'bayn.execution-controller-tick.v1',
      epoch: 7,
      sequence: 12,
      attempt: 0,
      issuedAt: '2026-08-13T18:00:00.000Z',
      recoveryWindow: 1,
    })
    expect(recoveryTick.retryWindowHash).toMatch(/^[0-9a-f]{64}$/)
    expect(recovery.idempotencyKey).toBe(
      executionControllerRecoveryTickIdempotencyKey(7, 12, 0, recoveryTick.retryWindowHash),
    )
    expect(commands).toHaveLength(maximumAttempts)
    expect(new Set(commands.map(({ issuedAt }) => issuedAt))).toEqual(new Set(['2026-08-13T18:00:00.000Z']))
    expect(deliveries).toHaveLength(0)
    expect(loggedLevels).toEqual(['warning', 'warning', 'error', 'warning'])
    expect(loggedAnnotations[2]).toMatchObject({
      failureCauseCategory: 'database',
      failureCauseOperation: 'read-authority-slot',
      failureCauseTag: 'CycleRunnerError',
      failureMessage: 'execution advance did not complete within its bounded interpreter',
      failureOperation: 'advance',
      failureTag: 'TransientExecutionFailure',
    })
    expect(loggedAnnotations[2]?.['failureFingerprint']).toMatch(/^[0-9a-f]{64}$/)
    expect(JSON.stringify(loggedAnnotations)).not.toContain('database-secret-must-not-be-logged')
  })

  test.each([
    {
      failure: new TransientExecutionFailure({
        operation: 'advance',
        message: 'execution advance did not complete within its bounded interpreter',
        cause: new CycleRunnerError({
          operation: 'read-authority-slot',
          failure: 'database',
          message: 'cycle runner could not read the authority slot',
          cause: new Error('database-secret-must-not-be-logged'),
        }),
      }),
      expected: {
        failureTag: 'TransientExecutionFailure',
        failureOperation: 'advance',
        failureCauseTag: 'CycleRunnerError',
        failureCauseOperation: 'read-authority-slot',
        failureCauseCategory: 'database',
      },
    },
    {
      failure: new OperationalError({
        component: 'strategy',
        operation: 'capital-activation',
        message: 'research capital pre-activation reconciliation was not exact',
        retryable: false,
        cause: { _tag: 'CapitalActivationPreparationRejected' },
      }),
      expected: {
        failureTag: 'OperationalError',
        failureOperation: 'capital-activation',
        failureCauseTag: 'CapitalActivationPreparationRejected',
      },
    },
  ])(
    'retains $expected.failureTag diagnostics across the durable run boundary and replay',
    async ({ failure, expected }) => {
      const state: ExecutionControllerState = {
        schemaVersion: 1,
        active: true,
        epoch: 7,
        planHash,
        sourceRevision,
        initialSequence: 12,
        nextSequence: 12,
      }
      const deliveries: Delivery[] = []
      const logged: Array<Readonly<Record<string, string | number | boolean>>> = []
      let advances = 0
      let recorded: { message: string; code: number; metadata: Record<string, string> } | undefined
      const context = {
        key: controllerKey,
        get: async () => state,
        set: () => undefined,
        genericSend: (delivery: Delivery) => deliveries.push(delivery),
        run: async <A>(_name: string, action: () => Promise<A>): Promise<A> => {
          if (recorded === undefined) {
            try {
              return await action()
            } catch (cause) {
              // Restate retains message, code and string metadata, not the original error's prototype or fields.
              recorded = JSON.parse(
                JSON.stringify(
                  cause instanceof TerminalError
                    ? { message: cause.message, code: cause.code, metadata: cause.metadata ?? {} }
                    : { message: 'run attempts exhausted', code: 500, metadata: {} },
                ),
              ) as typeof recorded
            }
          }
          if (recorded === undefined) throw new Error('missing retained failure')
          throw new TerminalError(recorded.message, { errorCode: recorded.code, metadata: recorded.metadata })
        },
        date: { toJSON: async () => '2026-08-13T18:00:00.000Z' },
        request: () => ({ id: 'diagnostic-replay', attemptCompletedSignal: new AbortController().signal }),
      } as unknown as TestContext
      const object = handlers(
        makeBaynExecutionController(config, {
          advance: () => {
            advances += 1
            return Promise.reject(failure)
          },
          log: (_level, _message, annotations) => {
            logged.push(annotations)
            return Promise.resolve()
          },
          projectState: () => Promise.resolve(),
        }),
      )
      const tick = { schemaVersion: 'bayn.execution-controller-tick.v1', epoch: 7, sequence: 12 }
      await object.tick(context, tick)
      await object.tick(context, tick)
      expect(advances).toBe(1)
      expect(deliveries).toHaveLength(2)
      expect(logged).toHaveLength(2)
      for (const annotations of logged) {
        expect(annotations).toMatchObject(expected)
        expect(annotations['failureFingerprint']).toMatch(/^[0-9a-f]{64}$/)
      }
      expect(logged[0]?.['failureFingerprint']).toBe(logged[1]?.['failureFingerprint'])
      expect(JSON.stringify({ recorded, logged })).not.toContain('database-secret-must-not-be-logged')
    },
  )

  test.each(['not-json', '{"failureTag":"OperationalError","failureFingerprint":"invalid"}'])(
    'ignores malformed durable diagnostics without exposing the original error (%s)',
    async (metadata) => {
      const state: ExecutionControllerState = {
        schemaVersion: 1,
        active: true,
        epoch: 7,
        planHash,
        sourceRevision,
        initialSequence: 12,
        nextSequence: 12,
      }
      const logged: Array<Readonly<Record<string, string | number | boolean>>> = []
      const deliveries: Delivery[] = []
      const context = {
        key: controllerKey,
        get: async () => state,
        genericSend: (delivery: Delivery) => deliveries.push(delivery),
        run: async <A>(_name: string, action: () => Promise<A>) => action(),
        date: { toJSON: async () => '2026-08-13T18:00:00.000Z' },
        request: () => ({ id: 'invalid-diagnostic', attemptCompletedSignal: new AbortController().signal }),
      } as unknown as TestContext
      const object = handlers(
        makeBaynExecutionController(config, {
          advance: () =>
            Promise.reject(
              new TerminalError('provider-secret-must-not-be-logged', {
                errorCode: 500,
                metadata: { 'bayn.execution-advance-failure.v1': metadata },
              }),
            ),
          log: (_level, _message, annotations) => {
            logged.push(annotations)
            return Promise.resolve()
          },
          projectState: () => Promise.resolve(),
        }),
      )
      await object.tick(context, { schemaVersion: 'bayn.execution-controller-tick.v1', epoch: 7, sequence: 12 })
      expect(deliveries).toHaveLength(1)
      expect(logged).toHaveLength(1)
      expect(logged[0]).toMatchObject({ failureTag: 'TerminalError', failureOperation: 'unclassified' })
      expect(JSON.stringify(logged)).not.toContain('provider-secret-must-not-be-logged')
    },
  )

  test('backs off recovery windows and terminates after the durable recovery budget', async () => {
    const state: ExecutionControllerState = {
      schemaVersion: 1,
      active: true,
      epoch: 7,
      planHash,
      sourceRevision,
      initialSequence: 12,
      nextSequence: 12,
    }
    const deliveries: Delivery[] = []
    let invocation = 0
    const failure = new TransientExecutionFailure({
      operation: 'advance',
      message: 'execution advance did not complete within its bounded interpreter',
      cause: new Error('persistent database outage'),
    })
    const context = {
      key: controllerKey,
      get: async () => state,
      set: () => undefined,
      genericSend: (delivery: Delivery) => deliveries.push(delivery),
      run: async <A>(_name: string, action: () => Promise<A>) => action(),
      date: { toJSON: async () => '2026-08-13T18:00:00.000Z' },
      request: () => ({
        id: `recovery-budget-${invocation++}`,
        attemptCompletedSignal: new AbortController().signal,
      }),
    } as unknown as TestContext
    const object = handlers(
      makeBaynExecutionController(config, {
        advance: () => Promise.reject(failure),
        log: () => Promise.resolve(),
        projectState: () => Promise.resolve(),
      }),
    )
    let tick: unknown = {
      schemaVersion: 'bayn.execution-controller-tick.v1',
      epoch: 7,
      sequence: 12,
      attempt: executionControllerAdvanceMaximumAttempts(false) - 1,
    }

    for (let recoveryWindow = 1; recoveryWindow <= executionControllerMaximumRecoveryWindow; recoveryWindow += 1) {
      await object.tick(context, tick)
      const recovery = deliveries.shift()
      if (recovery === undefined) throw new Error(`recovery window ${recoveryWindow} was not scheduled`)
      expect(recovery.delay).toBe(executionControllerRecoveryDelayMs(recoveryWindow))
      expect(recovery.parameter).toMatchObject({ recoveryWindow })
      tick = {
        ...(recovery.parameter as object),
        attempt: executionControllerAdvanceMaximumAttempts(false) - 1,
      }
    }

    let terminalFailure: unknown
    try {
      await object.tick(context, tick)
    } catch (cause: unknown) {
      terminalFailure = cause
    }
    expect(terminalFailure).toBeInstanceOf(TerminalError)
    expect((terminalFailure as TerminalError).message).toBe('execution controller recovery budget exhausted')
    expect((terminalFailure as TerminalError).metadata).toMatchObject({
      failureOperation: 'advance',
      failureTag: 'TransientExecutionFailure',
      recoveryWindow: String(executionControllerMaximumRecoveryWindow),
    })
    expect((terminalFailure as TerminalError).metadata?.['failureFingerprint']).toMatch(/^[0-9a-f]{64}$/)
    expect(deliveries).toHaveLength(0)
  })

  test('releases the exclusive queue after a failed source catch-up so the established tick can advance', async () => {
    const establishedSourceRevision = 'd'.repeat(40)
    let state: ExecutionControllerState = {
      schemaVersion: 1,
      active: true,
      epoch: 7,
      planHash,
      sourceRevision: establishedSourceRevision,
      initialSequence: 12,
      nextSequence: 12,
      lastCompletion: {
        sequence: 11,
        outcome: ExecutionControllerOutcome.Blocked,
        receiptHash: 'e'.repeat(64),
        completedAt: '2026-08-13T17:59:30.000Z',
      },
    }
    const deliveries: Delivery[] = []
    const context = {
      key: controllerKey,
      get: async () => state,
      set: (_key: string, next: ExecutionControllerState) => {
        state = next
      },
      genericSend: (delivery: Delivery) => deliveries.push(delivery),
      run: async <A>(_name: string, action: () => Promise<A>) => action(),
      date: { toJSON: async () => '2026-08-13T18:00:00.000Z' },
      request: () => ({ id: 'catch-up-failure', attemptCompletedSignal: new AbortController().signal }),
    } as unknown as TestContext
    const replacement = handlers(
      makeBaynExecutionController(
        {
          ...config,
          previousBinding: { planHash: 'f'.repeat(64), sourceRevision: 'e'.repeat(40) },
        },
        {
          advance: () => Promise.reject(new Error('replacement runtime is invalid')),
          log: () => Promise.resolve(),
          projectState: () => Promise.resolve(),
        },
      ),
    )
    const established = handlers(
      makeBaynExecutionController(
        { ...config, sourceRevision: establishedSourceRevision },
        {
          advance: () =>
            Promise.resolve({
              completedAt: '2026-08-13T18:00:01.000Z',
              outcome: {
                _tag: ExecutionControllerOutcome.Blocked,
                receiptHash: 'f'.repeat(64),
                nextDelayMs: 30_000,
              },
            }),
          log: () => Promise.resolve(),
          projectState: () => Promise.resolve(),
        },
      ),
    )
    let catchUp: unknown = {
      schemaVersion: 'bayn.execution-controller-tick.v1',
      epoch: 7,
      sequence: 12,
      attempt: 0,
      sourceCatchUpRevision: sourceRevision,
    }

    const maximumAttempts = executionControllerAdvanceMaximumAttempts(false)
    for (let attempt = 0; attempt < maximumAttempts; attempt += 1) {
      await replacement.tick(context, catchUp)
      if (attempt < maximumAttempts - 1) {
        const retry = deliveries.shift()
        if (retry === undefined) throw new Error('source catch-up failure did not schedule its bounded retry')
        catchUp = retry.parameter
      }
    }
    expect(state.nextSequence).toBe(12)
    expect(deliveries).toHaveLength(0)

    await established.tick(context, {
      schemaVersion: 'bayn.execution-controller-tick.v1',
      epoch: 7,
      sequence: 12,
      attempt: 0,
    })

    expect(state).toMatchObject({
      sourceRevision: establishedSourceRevision,
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
