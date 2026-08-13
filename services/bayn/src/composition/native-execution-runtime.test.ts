import { describe, expect, test } from 'bun:test'
import { Context, Deferred, Effect, Fiber, Layer, ManagedRuntime, Redacted, Ref, Result } from 'effect'
import { TestClock } from 'effect/testing'

import type { ApplicationPlanFor } from '../app'
import { config, fixtureRuntime } from '../app-test-support'
import { alpacaSandboxBaseUrl } from '../broker/connection'
import { BrokerEnvironment, BrokerProvider, makeBrokerIdentity } from '../broker/identity'
import type { RuntimeConfig } from '../config'
import {
  ExecutionControllerOutcome,
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
  acquireScopedManagedRuntime,
  awaitNativeExecutionRuntimeDriver,
  captureRecoveryFirstCycleDriver,
  executeNativeExecutionAdvance,
  executionControllerConfig,
  failRecoveryFirstCycleDriverSlot,
  makeNativeExecutionRuntimeAdapter,
  NativeExecutionRuntimeError,
  nativeExecutionRuntimeInitializationTimeoutMs,
  readRecoveryFirstCycleDriverSlot,
  type BoundRecoveryFirstCycleDriver,
  type RecoveryFirstCycleDriverSlot,
  type RecoveryFirstCycleDriverSlotState,
} from './native-execution-runtime'

const hash = (character: string): string => character.repeat(64)
const sourceRevision = 'a'.repeat(40)
const completedAt = '2026-08-13T18:00:00.000Z'

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
  epoch: command.epoch,
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
      lifecycleOwner: 'Restate',
      lifecycleCommandPort: 8081,
      lifecycleControllerKey: 'primary',
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
      operationTimeoutMs: 30_000,
    },
    strategy: fixtureRuntime,
    protocol: fixtureProtocol,
    parameterHash: fixtureRuntime.provenance.strategy.parameterHash,
    strategyProtocolHash: hash('7'),
  }
}

describe('native execution runtime', () => {
  test('binds controller identity to code, authority, qualification, market data, and cadence', () => {
    const first = executionControllerConfig(plan())
    const replay = executionControllerConfig(plan())
    const changedPlans = [
      plan({ imageDigest: `sha256:${hash('a')}` }),
      plan({ cyclePollIntervalMs: 60_000 }),
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

  test('interrupts preparation and releases every managed client when its scope closes', async () => {
    class RuntimeProbe extends Context.Service<RuntimeProbe, true>()('test/RuntimeProbe') {}

    const acquired: string[] = []
    const released: string[] = []
    let preparationInterrupted = false
    const resource = (name: string) =>
      Layer.effectDiscard(
        Effect.acquireRelease(
          Effect.sync(() => acquired.push(name)),
          () => Effect.sync(() => released.push(name)),
        ),
      )
    const resources = Layer.mergeAll(
      Layer.succeed(RuntimeProbe, true),
      resource('postgresql'),
      resource('clickhouse'),
      resource('broker'),
      resource('status-projection'),
    )

    await Effect.runPromise(
      Effect.gen(function* () {
        const started = yield* Deferred.make<void>()
        const preparation = Effect.gen(function* () {
          yield* RuntimeProbe
          yield* Deferred.succeed(started, undefined)
          return yield* Effect.never
        }).pipe(Effect.onInterrupt(() => Effect.sync(() => (preparationInterrupted = true))))

        yield* acquireScopedManagedRuntime(ManagedRuntime.make(resources), preparation)
        yield* Deferred.await(started)
      }).pipe(Effect.scoped),
    )

    expect(acquired.toSorted()).toEqual(['broker', 'clickhouse', 'postgresql', 'status-projection'])
    expect(released.toSorted()).toEqual(acquired.toSorted())
    expect(preparationInterrupted).toBe(true)
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
      ),
    )

    expect(result.outcome).toMatchObject({ _tag: 'Blocked', nextDelayMs: 30_000 })
    expect(projected).toMatchObject({
      controllerKey: command.controllerKey,
      epoch: command.epoch,
      lastSequence: command.sequence,
      lastOutcome: 'Blocked',
      lastReceiptHash: result.outcome.receiptHash,
    })
    expect(projected?.nextDueAt).toBe(
      new Date(Date.parse(result.completedAt) + result.outcome.nextDelayMs).toISOString(),
    )
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

    const first = await Effect.runPromiseExit(executeNativeExecutionAdvance(command, replayDriver, uncertainStore))
    const replay = await Effect.runPromise(executeNativeExecutionAdvance(command, replayDriver, uncertainStore))

    expect(first._tag).toBe('Failure')
    expect(advanceCount).toBe(1)
    expect(projectCount).toBe(1)
    const committed = persistence.current
    if (committed === null) throw new Error('ambiguous projection did not persist its status')
    expect(replay).toEqual({
      completedAt: committed.completedAt,
      outcome: {
        _tag: committed.lastOutcome,
        receiptHash: committed.lastReceiptHash,
        nextDelayMs: 30_000,
      },
    })
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
