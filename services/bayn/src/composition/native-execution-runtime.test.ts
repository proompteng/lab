import { describe, expect, test } from 'bun:test'
import {
  Cause,
  Context,
  Deferred,
  Effect,
  Exit,
  Fiber,
  Layer,
  ManagedRuntime,
  Redacted,
  Ref,
  Result,
  ScopedRef,
} from 'effect'
import { TestClock } from 'effect/testing'

import type { ApplicationPlanFor } from '../app'
import { config, fixtureRuntime } from '../app-test-support'
import { alpacaSandboxBaseUrl } from '../broker/connection'
import { BrokerEnvironment, BrokerProvider, makeBrokerIdentity } from '../broker/identity'
import type { RuntimeConfig } from '../config'
import {
  ExecutionControllerOutcome,
  ExecutionControllerStatusStore,
  executionControllerStatusHasCompletion,
  type ExecutionControllerStatus,
  type ExecutionControllerStatusProjection,
  ExecutionControllerStatusStoreError,
  type ExecutionControllerStatusStoreShape,
} from '../execution/controller-status'
import { TransientExecutionFailure, type AdvanceExecutionCommand } from '../execution/advance'
import { BrokerAccess, CapitalAuthorityKind } from '../execution/authority'
import type { RecoveryFirstRuntime } from '../observe-composition'
import { fixtureProtocol } from '../test-fixtures'
import {
  awaitNativeExecutionRuntimeDriver,
  captureRecoveryFirstCycleDriver,
  executeNativeExecutionAdvance,
  executionControllerConfig,
  failRecoveryFirstCycleDriverSlot,
  initializeNativeExecutionProjectionRuntime,
  makeManagedNativeExecutionRuntimeAdapter,
  makeNativeExecutionRuntimeAdapter,
  makePublishedExecutionCycleDriverLive,
  makeRecoveringManagedNativeExecutionRuntimeAdapter,
  NativeExecutionRuntimeError,
  nativeExecutionRuntimeInitializationTimeoutMs,
  projectExecutionControllerState,
  PublishedExecutionCycleDriver,
  readRecoveryFirstCycleDriverSlot,
  type BoundRecoveryFirstCycleDriver,
  type RecoveryFirstCycleDriverSlot,
  type RecoveryFirstCycleDriverSlotState,
} from './native-execution-runtime'

const hash = (character: string): string => character.repeat(64)
const sourceRevision = 'a'.repeat(40)
const completedAt = '2026-08-13T18:00:00.000Z'
const controllerPlanHash = hash('9')

type MarketDataBinding = Pick<
  RuntimeConfig['clickhouse'],
  'snapshotId' | 'publicationAsOf' | 'calendarVersion' | 'bounds'
>

const marketDataBinding: MarketDataBinding = {
  snapshotId: hash('8'),
  publicationAsOf: '2026-08-12',
  calendarVersion: 'xnys-2026-v1',
  bounds: {
    schemaVersion: 'bayn.evaluation-bounds.v1' as const,
    dataStart: '2020-01-01',
    dataEnd: '2026-08-12',
    lookbackStart: '2025-01-01',
    evaluationStart: '2026-01-01',
    evaluationEnd: '2026-08-12',
  },
}

type PlanOverrides = {
  readonly brokerAccess?: 'mutation' | 'read-only'
  readonly capitalAuthorityKind?: 'granted-capital' | 'none'
  readonly imageDigest?: string
  readonly cyclePollIntervalMs?: number
  readonly reconciliationStaleThresholdMs?: number
  readonly qualificationRunId?: string
  readonly persistedGrantHash?: string
  readonly marketDataBinding?: MarketDataBinding
  readonly tigerBeetleClusterId?: bigint
  readonly tigerBeetleLedger?: number
}

const brokerAccountId = '123e4567-e89b-42d3-a456-426614174000'
const brokerIdentity = Result.getOrThrow(
  makeBrokerIdentity({
    schemaVersion: 'bayn.broker-identity.v2',
    provider: BrokerProvider.Alpaca,
    environment: BrokerEnvironment.Sandbox,
    accountId: brokerAccountId,
  }),
)

const command: AdvanceExecutionCommand = {
  controllerKey: brokerIdentity.identityHash,
  epoch: 4,
  sequence: 7,
  issuedAt: completedAt,
  sourceRevision,
}

const driver = {
  advance: Effect.succeed({
    observation: {
      result: 'SUCCESS' as const,
      observedAt: completedAt,
      outcome: 'NOT_DUE' as const,
    },
  }),
  maintainReconciliation: Effect.void,
  nextDelayMs: 30_000,
  wait: () => Effect.void,
}

const status = (overrides: Partial<ExecutionControllerStatus> = {}): ExecutionControllerStatus => ({
  schemaVersion: 1,
  controllerKey: command.controllerKey,
  planHash: controllerPlanHash,
  active: true,
  epoch: command.epoch,
  nextSequence: command.sequence + 1,
  lastSequence: command.sequence,
  lastOutcome: ExecutionControllerOutcome.Blocked,
  lastReceiptHash: hash('2'),
  completedAt,
  nextDueAt: '2026-08-13T18:00:30.000Z',
  ...overrides,
})

const statusStore = (
  project: (candidate: ExecutionControllerStatus) => ExecutionControllerStatusProjection,
): ExecutionControllerStatusStoreShape => ({
  project: (candidate) => Effect.succeed(project(candidate)),
  read: () => Effect.succeed(null),
})

const plan = (overrides: PlanOverrides = {}): ApplicationPlanFor<'AutonomousService'> => {
  const readOnly = overrides.brokerAccess === 'read-only' || overrides.capitalAuthorityKind === 'none'
  return {
    _tag: 'AutonomousService',
    config: {
      ...config,
      runtimeMode: 'AutonomousService',
      alpaca: {
        provider: BrokerProvider.Alpaca,
        environment: BrokerEnvironment.Sandbox,
        identity: brokerIdentity,
        baseUrl: alpacaSandboxBaseUrl,
        expectedAccountId: brokerAccountId,
        authorityGenerationHash: hash('4'),
        key: Redacted.make('test-key'),
        secret: Redacted.make('test-secret'),
        proxyUrl: 'http://proxy.test:3128',
        operationTimeoutMs: config.operationTimeoutMs,
        retryAttempts: 0,
        reconciliationIntervalMs: 30_000,
      },
      build: {
        ...config.build,
        sourceRevision,
        imageDigest: overrides.imageDigest ?? `sha256:${hash('3')}`,
      },
      qualificationRunId: overrides.qualificationRunId ?? hash('9'),
      clickhouse: { ...config.clickhouse, ...(overrides.marketDataBinding ?? marketDataBinding) },
      execution: readOnly
        ? {
            brokerIdentity,
            brokerAccess: BrokerAccess.ReadOnly,
            capitalAuthority: { _tag: CapitalAuthorityKind.None },
          }
        : {
            brokerIdentity,
            brokerAccess: BrokerAccess.Mutation,
            capitalAuthority: {
              _tag: CapitalAuthorityKind.Granted,
              authorityGenerationHash: hash('4'),
              persistedGrantHash: overrides.persistedGrantHash ?? hash('c'),
            },
          },
      tigerBeetle: {
        clusterId: overrides.tigerBeetleClusterId ?? 2_001n,
        replicaAddresses: ['127.0.0.1:3000'],
        ledger: overrides.tigerBeetleLedger ?? 7_001,
      },
      capitalActivationRequestJson: '{"schemaVersion":"test"}',
      cyclePollIntervalMs: overrides.cyclePollIntervalMs ?? 30_000,
      reconciliationStaleThresholdMs: overrides.reconciliationStaleThresholdMs ?? config.reconciliationStaleThresholdMs,
      operationTimeoutMs: 30_000,
    },
    strategy: fixtureRuntime,
    protocol: fixtureProtocol,
    parameterHash: fixtureRuntime.provenance.strategy.parameterHash,
    strategyProtocolHash: hash('7'),
  }
}

describe('native execution runtime', () => {
  test('bootstraps controller persistence before exposing the projection runtime and fails closed on acquisition error', async () => {
    let acquired = 0
    let released = 0
    const projection = ManagedRuntime.make(
      Layer.effect(
        ExecutionControllerStatusStore,
        Effect.acquireRelease(
          Effect.sync(() => {
            acquired += 1
            return statusStore((candidate) => ({ _tag: 'Applied', status: candidate }))
          }),
          () =>
            Effect.sync(() => {
              released += 1
            }),
        ),
      ),
    )

    expect(acquired).toBe(0)
    await Effect.runPromise(initializeNativeExecutionProjectionRuntime(projection))
    expect(acquired).toBe(1)
    await projection.dispose()
    expect(released).toBe(1)

    const failure = new Error('migration bootstrap failed')
    const failedProjection = ManagedRuntime.make(Layer.effect(ExecutionControllerStatusStore, Effect.fail(failure)))
    const observed = await Effect.runPromise(Effect.flip(initializeNativeExecutionProjectionRuntime(failedProjection)))
    await failedProjection.dispose()

    expect(observed).toMatchObject({
      operation: 'initialize',
      message: 'native execution controller persistence bootstrap failed',
      cause: failure,
    })

    const defect = new Error('projection invariant defect')
    const defectingProjection = ManagedRuntime.make(Layer.effect(ExecutionControllerStatusStore, Effect.die(defect)))
    const defectExit = await Effect.runPromise(
      Effect.exit(initializeNativeExecutionProjectionRuntime(defectingProjection)),
    )
    await defectingProjection.dispose()

    expect(Exit.isFailure(defectExit)).toBe(true)
    if (Exit.isFailure(defectExit)) {
      expect(defectExit.cause.reasons.some((reason) => Cause.isDieReason(reason) && reason.defect === defect)).toBe(
        true,
      )
      expect(defectExit.cause.reasons.some(Cause.isFailReason)).toBe(false)
    }
  })

  test('interrupts an in-flight controller persistence bootstrap before releasing its acquired resource', async () => {
    const events: string[] = []

    await Effect.runPromise(
      Effect.gen(function* () {
        const started = yield* Deferred.make<void>()
        const managedProjection = ManagedRuntime.make(
          Layer.effect(
            ExecutionControllerStatusStore,
            Effect.acquireRelease(
              Effect.sync(() => {
                events.push('acquired')
              }),
              () =>
                Effect.sync(() => {
                  events.push('released')
                }),
            ).pipe(
              Effect.andThen(Deferred.succeed(started, undefined)),
              Effect.andThen(
                Effect.never.pipe(
                  Effect.onInterrupt(() =>
                    Effect.sync(() => {
                      events.push('interrupted')
                    }),
                  ),
                ),
              ),
              Effect.as(statusStore((candidate) => ({ _tag: 'Applied', status: candidate }))),
            ),
          ),
        )
        let bootstrapSignal: AbortSignal | undefined
        const projection = {
          ...managedProjection,
          runPromiseExit: ((effect, options) => {
            bootstrapSignal = options?.signal
            bootstrapSignal?.addEventListener(
              'abort',
              () => {
                events.push('signal-aborted')
              },
              { once: true },
            )
            return managedProjection.runPromiseExit(effect, options)
          }) as typeof managedProjection.runPromiseExit,
        } as typeof managedProjection

        const bootstrap = yield* Effect.forkChild(
          Effect.scoped(
            Effect.acquireRelease(Effect.succeed(projection), (runtime) => runtime.disposeEffect).pipe(
              Effect.flatMap(initializeNativeExecutionProjectionRuntime),
            ),
          ),
        )
        yield* Deferred.await(started)
        expect(events).toEqual(['acquired'])

        yield* Fiber.interrupt(bootstrap)
        expect(bootstrapSignal?.aborted).toBe(true)
        expect(events).toEqual(['acquired', 'signal-aborted', 'interrupted', 'released'])
      }),
    )
  })

  test('binds controller identity to code, authority, qualification, market data, and cadence', () => {
    const first = executionControllerConfig(plan())
    const replay = executionControllerConfig(plan())
    const changedPlans = [
      plan({ imageDigest: `sha256:${hash('a')}` }),
      plan({ cyclePollIntervalMs: 60_000 }),
      plan({ reconciliationStaleThresholdMs: 180_000 }),
      plan({ qualificationRunId: hash('a') }),
      plan({ persistedGrantHash: hash('d') }),
      plan({ brokerAccess: 'read-only' }),
      plan({ capitalAuthorityKind: 'none' }),
      plan({ tigerBeetleClusterId: 2_002n }),
      plan({ tigerBeetleLedger: 7_002 }),
      plan({ marketDataBinding: { ...marketDataBinding, snapshotId: hash('b') } }),
      plan({ marketDataBinding: { ...marketDataBinding, publicationAsOf: '2026-08-13' } }),
      plan({ marketDataBinding: { ...marketDataBinding, calendarVersion: 'xnys-2026-v2' } }),
      ...[
        { ...marketDataBinding.bounds, dataStart: '2020-01-02' as const },
        { ...marketDataBinding.bounds, dataEnd: '2026-08-13' as const },
        { ...marketDataBinding.bounds, lookbackStart: '2025-01-02' as const },
        { ...marketDataBinding.bounds, evaluationStart: '2026-01-02' as const },
        { ...marketDataBinding.bounds, evaluationEnd: '2026-08-13' as const },
      ].map((bounds) =>
        plan({
          marketDataBinding: {
            ...marketDataBinding,
            bounds,
          },
        }),
      ),
    ].map(executionControllerConfig)

    expect(Result.isSuccess(first)).toBe(true)
    expect(replay).toEqual(first)
    if (Result.isFailure(first)) return
    expect(first.success.controllerKey).toBe(command.controllerKey)
    for (const changed of changedPlans) {
      expect(Result.isSuccess(changed)).toBe(true)
      if (Result.isSuccess(changed)) expect(first.success.planHash).not.toBe(changed.success.planHash)
    }
    expect(nativeExecutionRuntimeInitializationTimeoutMs(30_000)).toBe(150_000)
  })

  test('keeps recovery-capable execution resources dormant until the first tick and releases them exactly once', async () => {
    let acquired = 0
    let released = 0
    let publishedSlot: RecoveryFirstCycleDriverSlot | undefined
    const context = Context.empty() as Context.Context<RecoveryFirstRuntime>
    const executionResources = Layer.merge(
      makePublishedExecutionCycleDriverLive(30_000, (slot) => {
        publishedSlot = slot
        return Effect.acquireRelease(
          Effect.sync(() => {
            acquired += 1
            return undefined
          }),
          () =>
            Effect.sync(() => {
              released += 1
            }),
        ).pipe(Effect.andThen(captureRecoveryFirstCycleDriver(slot)(driver).pipe(Effect.provideContext(context))))
      }),
      Layer.succeed(
        ExecutionControllerStatusStore,
        statusStore((candidate) => ({ _tag: 'Applied', status: candidate })),
      ),
    )
    const hostRunner = {
      runPromise: <A, E>(effect: Effect.Effect<A, E>, options?: { readonly signal?: AbortSignal }) =>
        Effect.runPromise(effect, options),
    }
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const managed = yield* ScopedRef.fromAcquire(
            Effect.acquireRelease(
              Effect.succeed(ManagedRuntime.make(executionResources)),
              (runtime) => runtime.disposeEffect,
            ),
          )
          const projectionManaged = yield* Effect.acquireRelease(
            Effect.succeed(
              ManagedRuntime.make(
                Layer.succeed(
                  ExecutionControllerStatusStore,
                  statusStore((candidate) => ({ _tag: 'Applied', status: candidate })),
                ),
              ),
            ),
            (runtime) => runtime.disposeEffect,
          )
          const runtime = makeRecoveringManagedNativeExecutionRuntimeAdapter(
            managed,
            executionResources,
            projectionManaged,
            hostRunner,
            controllerPlanHash,
          )

          expect(acquired).toBe(0)
          yield* Effect.promise(() => runtime.log('info', 'inactive worker discovery', {}))
          expect(acquired).toBe(0)
          yield* Effect.promise(() =>
            runtime.projectState(
              command.controllerKey,
              {
                schemaVersion: 1,
                active: false,
                epoch: command.epoch + 1,
                planHash: controllerPlanHash,
                sourceRevision,
                initialSequence: command.sequence,
                nextSequence: command.sequence + 1,
                lastCompletion: {
                  sequence: command.sequence,
                  outcome: ExecutionControllerOutcome.Blocked,
                  receiptHash: hash('2'),
                  completedAt,
                },
              },
              new AbortController().signal,
            ),
          )
          expect(acquired).toBe(0)
          yield* Effect.promise(() => runtime.advance(command, new AbortController().signal))
          yield* Effect.promise(() =>
            runtime.advance({ ...command, sequence: command.sequence + 1 }, new AbortController().signal),
          )
          expect(acquired).toBe(1)
        }),
      ),
    )
    expect(released).toBe(1)
    if (publishedSlot === undefined) throw new Error('production driver layer did not publish its slot')
    expect(await Effect.runPromise(Ref.get(publishedSlot.state))).toEqual({ _tag: 'Pending' })
  })

  test('managed runtime resolves the current driver after a restricted generation rebind', async () => {
    const calls: string[] = []
    const withCall = (name: string): BoundRecoveryFirstCycleDriver => ({
      ...driver,
      advance: Effect.sync(() => {
        calls.push(name)
        return {
          observation: {
            result: 'SUCCESS' as const,
            observedAt: completedAt,
            outcome: 'NOT_DUE' as const,
          },
        }
      }),
    })
    const slot = Effect.runSync(
      Effect.gen(function* () {
        const ready = yield* Deferred.make<void, NativeExecutionRuntimeError>()
        yield* Deferred.succeed(ready, undefined)
        return {
          state: yield* Ref.make<RecoveryFirstCycleDriverSlotState>({
            _tag: 'Ready',
            driver: withCall('restricted'),
          }),
          ready,
        } satisfies RecoveryFirstCycleDriverSlot
      }),
    )
    const managed = ManagedRuntime.make(
      Layer.merge(
        Layer.succeed(PublishedExecutionCycleDriver, slot),
        Layer.succeed(
          ExecutionControllerStatusStore,
          statusStore((candidate) => ({ _tag: 'Applied', status: candidate })),
        ),
      ),
    )
    const runtime = makeManagedNativeExecutionRuntimeAdapter(
      managed,
      {
        runPromise: (effect, options) => Effect.runPromise(effect, options),
      },
      controllerPlanHash,
    )

    await runtime.advance(command, new AbortController().signal)
    await Effect.runPromise(Ref.set(slot.state, { _tag: 'Ready', driver: withCall('observe') }))
    await runtime.advance({ ...command, sequence: command.sequence + 1 }, new AbortController().signal)
    await managed.dispose()

    expect(calls).toEqual(['restricted', 'observe'])
  })

  test('reacquires execution resources after a cold-start initialization failure', async () => {
    let acquired = 0
    let released = 0
    const failure = new Error('transient dependency unavailable')
    const readySlot = Effect.runSync(
      Effect.gen(function* () {
        const ready = yield* Deferred.make<void, NativeExecutionRuntimeError>()
        yield* Deferred.succeed(ready, undefined)
        return {
          state: yield* Ref.make<RecoveryFirstCycleDriverSlotState>({ _tag: 'Ready', driver }),
          ready,
        } satisfies RecoveryFirstCycleDriverSlot
      }),
    )
    const executionResources = Layer.merge(
      Layer.effect(
        PublishedExecutionCycleDriver,
        Effect.acquireRelease(
          Effect.sync(() => {
            acquired += 1
            return acquired
          }),
          () =>
            Effect.sync(() => {
              released += 1
            }),
        ).pipe(Effect.flatMap((attempt) => (attempt === 1 ? Effect.fail(failure) : Effect.succeed(readySlot)))),
      ),
      Layer.succeed(
        ExecutionControllerStatusStore,
        statusStore((candidate) => ({ _tag: 'Applied', status: candidate })),
      ),
    )
    const hostRunner = {
      runPromise: <A, E>(effect: Effect.Effect<A, E>, options?: { readonly signal?: AbortSignal }) =>
        Effect.runPromise(effect, options),
    }

    const result = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const managed = yield* ScopedRef.fromAcquire(
            Effect.acquireRelease(
              Effect.succeed(ManagedRuntime.make(executionResources)),
              (runtime) => runtime.disposeEffect,
            ),
          )
          const projectionManaged = yield* Effect.acquireRelease(
            Effect.succeed(
              ManagedRuntime.make(
                Layer.succeed(
                  ExecutionControllerStatusStore,
                  statusStore((candidate) => ({ _tag: 'Applied', status: candidate })),
                ),
              ),
            ),
            (runtime) => runtime.disposeEffect,
          )
          const runtime = makeRecoveringManagedNativeExecutionRuntimeAdapter(
            managed,
            executionResources,
            projectionManaged,
            hostRunner,
            controllerPlanHash,
          )
          const first = yield* Effect.tryPromise({
            try: () => runtime.advance(command, new AbortController().signal),
            catch: (cause) => cause,
          }).pipe(Effect.flip)
          const second = yield* Effect.promise(() =>
            runtime.advance({ ...command, sequence: command.sequence + 1 }, new AbortController().signal),
          )
          return { first, second }
        }),
      ),
    )

    expect(result.first).toBe(failure)
    expect(result.second.outcome).toMatchObject({ _tag: 'Blocked', nextDelayMs: 30_000 })
    expect(acquired).toBe(2)
    expect(released).toBe(2)
  })

  test('fails initialization deterministically when preparation never publishes a driver', async () => {
    const failure = await Effect.runPromise(
      Effect.gen(function* () {
        const slot: RecoveryFirstCycleDriverSlot = {
          state: yield* Ref.make<RecoveryFirstCycleDriverSlotState>({ _tag: 'Pending' }),
          ready: yield* Deferred.make<void, NativeExecutionRuntimeError>(),
        }
        const awaiting = yield* Effect.forkChild(awaitNativeExecutionRuntimeDriver(slot, 20))
        yield* TestClock.adjust(nativeExecutionRuntimeInitializationTimeoutMs(20))
        return yield* Fiber.join(awaiting).pipe(Effect.flip)
      }).pipe(Effect.provide(TestClock.layer())),
    )

    expect(failure).toBeInstanceOf(NativeExecutionRuntimeError)
    expect(failure).toMatchObject({ operation: 'initialize' })
  })

  test('projects the exact completed tick before returning the compact Restate result', async () => {
    let projected: ExecutionControllerStatus | undefined
    const result = await Effect.runPromise(
      executeNativeExecutionAdvance(
        command,
        driver,
        statusStore((candidate) => {
          projected = candidate
          return { _tag: 'Applied', status: candidate }
        }),
        controllerPlanHash,
      ),
    )

    expect(result.outcome).toMatchObject({ _tag: 'Blocked', nextDelayMs: 30_000 })
    expect(projected).toMatchObject({
      controllerKey: command.controllerKey,
      planHash: controllerPlanHash,
      epoch: command.epoch,
      nextSequence: command.sequence + 1,
      lastSequence: command.sequence,
      lastOutcome: 'Blocked',
      lastReceiptHash: result.outcome.receiptHash,
    })
    if (projected === undefined || !executionControllerStatusHasCompletion(projected)) {
      throw new Error('completed execution did not project completion evidence')
    }
    expect(projected.nextDueAt).toBe(
      new Date(Date.parse(result.completedAt) + result.outcome.nextDelayMs).toISOString(),
    )
  })

  test('projects active controller state before its first completion without inventing evidence', async () => {
    let projected: ExecutionControllerStatus | undefined
    await Effect.runPromise(
      projectExecutionControllerState(
        command.controllerKey,
        {
          schemaVersion: 1,
          active: true,
          epoch: command.epoch,
          planHash: controllerPlanHash,
          sourceRevision,
          initialSequence: command.sequence,
          nextSequence: command.sequence,
        },
        statusStore((candidate) => {
          projected = candidate
          return { _tag: 'Applied', status: candidate }
        }),
      ),
    )

    expect(projected).toEqual({
      schemaVersion: 1,
      controllerKey: command.controllerKey,
      planHash: controllerPlanHash,
      active: true,
      epoch: command.epoch,
      nextSequence: command.sequence,
    })
  })

  test('projects durable deactivation from the last real completion without fabricating another tick', async () => {
    let projected: ExecutionControllerStatus | undefined
    await Effect.runPromise(
      projectExecutionControllerState(
        command.controllerKey,
        {
          schemaVersion: 1,
          active: false,
          epoch: command.epoch + 1,
          planHash: hash('3'),
          sourceRevision,
          initialSequence: command.sequence,
          nextSequence: command.sequence + 1,
          lastCompletion: {
            sequence: command.sequence,
            outcome: ExecutionControllerOutcome.Blocked,
            receiptHash: hash('2'),
            completedAt,
          },
        },
        statusStore((candidate) => {
          projected = candidate
          return { _tag: 'Applied', status: candidate }
        }),
      ),
    )

    expect(projected).toEqual({
      schemaVersion: 1,
      controllerKey: command.controllerKey,
      planHash: hash('3'),
      active: false,
      epoch: command.epoch + 1,
      nextSequence: command.sequence + 1,
      lastSequence: command.sequence,
      lastOutcome: ExecutionControllerOutcome.Blocked,
      lastReceiptHash: hash('2'),
      completedAt,
    })
  })

  test('fails the Restate step when PostgreSQL has already advanced beyond this completion', async () => {
    const failure = await Effect.runPromise(
      Effect.flip(
        executeNativeExecutionAdvance(
          command,
          driver,
          statusStore(() => ({
            _tag: 'Stale',
            status: status({ lastSequence: command.sequence + 1 }),
          })),
          controllerPlanHash,
        ),
      ),
    )

    expect(failure).toBeInstanceOf(TransientExecutionFailure)
    expect(failure.message).toBe('execution controller status projection did not complete')
  })

  test('replays an ambiguously committed projection without advancing execution again', async () => {
    let advanceCount = 0
    let projectCount = 0
    const persistence: { current: ExecutionControllerStatus | null } = { current: null }
    const replayDriver = {
      ...driver,
      advance: Effect.sync(() => {
        advanceCount += 1
        return {
          observation: {
            result: 'SUCCESS' as const,
            observedAt: completedAt,
            outcome: 'NOT_DUE' as const,
          },
        }
      }),
    }
    const uncertainStore: ExecutionControllerStatusStoreShape = {
      read: () => Effect.succeed(persistence.current),
      project: (candidate) =>
        Effect.sync(() => {
          projectCount += 1
          persistence.current = candidate
        }).pipe(
          Effect.andThen(
            Effect.fail(
              new ExecutionControllerStatusStoreError({
                operation: 'project',
                failure: 'query',
                message: 'connection failed after commit',
              }),
            ),
          ),
        ),
    }

    const first = await Effect.runPromiseExit(
      executeNativeExecutionAdvance(command, replayDriver, uncertainStore, controllerPlanHash),
    )
    const replay = await Effect.runPromise(
      executeNativeExecutionAdvance(command, replayDriver, uncertainStore, controllerPlanHash),
    )

    expect(first._tag).toBe('Failure')
    expect(advanceCount).toBe(1)
    expect(projectCount).toBe(1)
    const committed = persistence.current
    if (committed === null) throw new Error('ambiguous projection did not persist its status')
    if (!executionControllerStatusHasCompletion(committed)) {
      throw new Error('ambiguous completion projection lost its completion evidence')
    }
    expect(replay).toEqual({
      completedAt: committed.completedAt,
      outcome: {
        _tag: committed.lastOutcome,
        receiptHash: committed.lastReceiptHash,
        nextDelayMs: 30_000,
      },
    })
  })

  test('binds the reserved legacy plan on the first not-ahead post-migration advance', async () => {
    let advanceCount = 0
    let projected: ExecutionControllerStatus | undefined
    const legacyStatus: ExecutionControllerStatus = {
      schemaVersion: 1,
      controllerKey: command.controllerKey,
      planHash: hash('0'),
      active: true,
      epoch: command.epoch,
      nextSequence: command.sequence,
      lastSequence: command.sequence - 1,
      lastOutcome: ExecutionControllerOutcome.Blocked,
      lastReceiptHash: hash('1'),
      completedAt: '2026-08-13T17:59:30.000Z',
      nextDueAt: completedAt,
    }
    const result = await Effect.runPromise(
      executeNativeExecutionAdvance(
        command,
        {
          ...driver,
          advance: Effect.sync(() => {
            advanceCount += 1
            return {
              observation: {
                result: 'SUCCESS' as const,
                observedAt: completedAt,
                outcome: 'NOT_DUE' as const,
              },
            }
          }),
        },
        {
          read: () => Effect.succeed(legacyStatus),
          project: (candidate) =>
            Effect.sync(() => {
              projected = candidate
              return { _tag: 'Applied' as const, status: candidate }
            }),
        },
        controllerPlanHash,
      ),
    )

    expect(advanceCount).toBe(1)
    expect(result.outcome._tag).toBe(ExecutionControllerOutcome.Blocked)
    expect(projected).toMatchObject({
      planHash: controllerPlanHash,
      epoch: command.epoch,
      nextSequence: command.sequence + 1,
      lastSequence: command.sequence,
    })
  })

  test('does not attribute an ahead reserved-legacy completion to the current plan', async () => {
    let advanceCount = 0
    const failure = await Effect.runPromise(
      executeNativeExecutionAdvance(
        command,
        {
          ...driver,
          advance: Effect.sync(() => {
            advanceCount += 1
            return driver.advance
          }).pipe(Effect.flatten),
        },
        {
          read: () => Effect.succeed(status({ planHash: hash('0') })),
          project: () => Effect.die('must not project'),
        },
        controllerPlanHash,
      ).pipe(Effect.flip),
    )

    expect(failure).toBeInstanceOf(TransientExecutionFailure)
    expect(advanceCount).toBe(0)
  })

  test('rejects a same-epoch projection from a different deployment plan without advancing execution', async () => {
    let advanceCount = 0
    const mismatched = status({ planHash: hash('8') })
    const failure = await Effect.runPromise(
      executeNativeExecutionAdvance(
        command,
        {
          ...driver,
          advance: Effect.sync(() => {
            advanceCount += 1
            return {
              observation: {
                result: 'SUCCESS' as const,
                observedAt: completedAt,
                outcome: 'NOT_DUE' as const,
              },
            }
          }),
        },
        { read: () => Effect.succeed(mismatched), project: () => Effect.die('must not project') },
        controllerPlanHash,
      ).pipe(Effect.flip),
    )

    expect(failure).toBeInstanceOf(TransientExecutionFailure)
    expect(advanceCount).toBe(0)
  })

  test('forwards Restate cancellation into the Effect runner', async () => {
    const abort = new AbortController()
    let observedSignal: AbortSignal | undefined
    const runtime = makeNativeExecutionRuntimeAdapter(
      Effect.succeed(driver),
      statusStore((candidate) => ({
        _tag: 'Applied',
        status: candidate,
      })),
      {
        runPromise: (effect, options) => {
          observedSignal = options?.signal
          return Effect.runPromise(effect, options)
        },
      },
      controllerPlanHash,
    )

    await runtime.advance(command, abort.signal)
    expect(observedSignal).toBe(abort.signal)
  })

  test('advances with the latest driver after a restricted generation rebind', async () => {
    const calls: string[] = []
    const withCall = (name: string): BoundRecoveryFirstCycleDriver => ({
      ...driver,
      advance: Effect.sync(() => {
        calls.push(name)
        return {
          observation: {
            result: 'SUCCESS' as const,
            observedAt: completedAt,
            outcome: 'NOT_DUE' as const,
          },
        }
      }),
    })
    const current = Effect.runSync(Ref.make<BoundRecoveryFirstCycleDriver | null>(withCall('restricted')))
    const runtime = makeNativeExecutionRuntimeAdapter(
      Ref.get(current).pipe(
        Effect.flatMap((published) =>
          published === null
            ? Effect.fail(new NativeExecutionRuntimeError({ operation: 'initialize', message: 'driver unavailable' }))
            : Effect.succeed(published),
        ),
      ),
      statusStore((candidate) => ({ _tag: 'Applied', status: candidate })),
      { runPromise: (effect, options) => Effect.runPromise(effect, options) },
      controllerPlanHash,
    )

    await runtime.advance(command, new AbortController().signal)
    Effect.runSync(Ref.set(current, withCall('observe')))
    await runtime.advance({ ...command, sequence: command.sequence + 1 }, new AbortController().signal)

    expect(calls).toEqual(['restricted', 'observe'])
  })

  test('propagates a preparation failure that occurs after the first driver was published', async () => {
    const failure = new NativeExecutionRuntimeError({
      operation: 'initialize',
      message: 'observe driver rebinding failed',
    })
    const slot = Effect.runSync(
      Effect.gen(function* () {
        const ready = yield* Deferred.make<void, NativeExecutionRuntimeError>()
        yield* Deferred.succeed(ready, undefined)
        const state = yield* Ref.make<RecoveryFirstCycleDriverSlotState>({ _tag: 'Ready', driver })
        return {
          state,
          ready,
        } satisfies RecoveryFirstCycleDriverSlot
      }),
    )
    const runtime = makeNativeExecutionRuntimeAdapter(
      readRecoveryFirstCycleDriverSlot(slot),
      statusStore((candidate) => ({ _tag: 'Applied', status: candidate })),
      { runPromise: (effect, options) => Effect.runPromise(effect, options) },
      controllerPlanHash,
    )

    await runtime.advance(command, new AbortController().signal)
    await Effect.runPromise(failRecoveryFirstCycleDriverSlot(slot, failure))
    const afterFailure = await runtime
      .advance({ ...command, sequence: command.sequence + 1 }, new AbortController().signal)
      .then(
        () => undefined,
        (error: unknown) => error,
      )

    expect(afterFailure).toBe(failure)
  })

  test('makes the old driver unavailable while a replacement is being prepared', async () => {
    const slot = Effect.runSync(
      Effect.gen(function* () {
        return {
          state: yield* Ref.make<RecoveryFirstCycleDriverSlotState>({ _tag: 'Pending' }),
          ready: yield* Deferred.make<void, NativeExecutionRuntimeError>(),
        } satisfies RecoveryFirstCycleDriverSlot
      }),
    )
    const context = Context.empty() as Context.Context<RecoveryFirstRuntime>
    const publication = Effect.runFork(
      captureRecoveryFirstCycleDriver(slot)(driver).pipe(Effect.provideContext(context)),
    )

    await Effect.runPromise(Deferred.await(slot.ready))
    expect(await Effect.runPromise(readRecoveryFirstCycleDriverSlot(slot))).toBeDefined()
    await Effect.runPromise(Fiber.interrupt(publication))
    const unavailable = await Effect.runPromise(Effect.flip(readRecoveryFirstCycleDriverSlot(slot)))

    expect(unavailable).toMatchObject({
      operation: 'initialize',
      message: 'native execution runtime driver is unavailable',
    })
  })
})
