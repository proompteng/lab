import { describe, expect, test } from 'bun:test'
import { context, propagation, trace, TraceFlags } from '@opentelemetry/api'
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node'
import {
  Cause,
  Context,
  Deferred,
  Effect,
  Exit,
  Fiber,
  Layer,
  ManagedRuntime,
  Option,
  Redacted,
  Result,
  ScopedRef,
  type Scope,
} from 'effect'
import { TestClock } from 'effect/testing'
import { PgClient } from '@effect/sql-pg'
import { nativeActivationPreflight, NativeActivationPreflightError } from './native-activation-preflight'

import type { ApplicationPlan } from '../app'
import type { NativeExecutionRuntime } from '../restate/restate-execution-controller'
import { config, fixtureRuntime } from '../testing/runtime-fixtures'
import { alpacaSandboxBaseUrl } from '../broker/connection'
import { BrokerEnvironment, BrokerProvider, makeBrokerIdentity } from '../broker/identity'
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
import type { RecoveryFirstRuntime } from '../observe-composition/model'
import type { CycleRunnerError } from '../cycle/runner/model'
import { CandidateObservationStore, type CandidateObservation } from '../observe-composition/candidate-observation'
import { JevBatchStore, type JevBatchEvidence } from '../jev/batch-evaluation'
import { operationalError } from '../errors'
import { makeRebindingCycleDriver } from './generation-cycle'
import { makeRepeatedMomentumPolicy } from '../strategy/repeated-momentum/policy'
import { executionControllerPlanHash } from '../execution/controller'
import {
  bindRecoveryFirstCycleDriver,
  executeNativeExecutionAdvance,
  executionControllerConfig,
  initializeNativeExecutionProjectionRuntime,
  makeExecutionCycleDriverLive,
  makeRecoveringManagedNativeExecutionRuntimeAdapter,
  NativeExecutionRuntimeError,
  nativeExecutionRuntimeInitializationTimeoutMs,
  projectExecutionControllerState,
  ExecutionCycleDriver,
  type BoundRecoveryFirstCycleDriver,
} from './native-execution-runtime'

const executionBuild = {
  sourceRevision: 'a'.repeat(40),
  imageRepository: 'registry.example.test/lab/bayn',
  imageDigest: `sha256:${'1'.repeat(64)}`,
}

const hash = (character: string): string => character.repeat(64)
const sourceRevision = 'a'.repeat(40)
const completedAt = '2026-08-13T18:00:00.000Z'
const controllerPlanHash = hash('9')

type PlanOverrides = {
  readonly brokerAccess?: 'mutation' | 'read-only'
  readonly capitalAuthorityKind?: 'granted-capital' | 'none'
  readonly imageDigest?: string
  readonly cyclePollIntervalMs?: number
  readonly reconciliationStaleThresholdMs?: number
  readonly persistedGrantHash?: string
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
  timeoutMs: 30_000,
  onTimeout: (error: CycleRunnerError) => Effect.fail(error),
  advance: Effect.succeed({
    observation: {
      result: 'SUCCESS' as const,
      observedAt: completedAt,
      outcome: 'WINDOW_CLOSED' as const,
    },
  }),
  nextDelayMs: 30_000,
}

const windowClosedObservation = {
  result: 'SUCCESS' as const,
  observedAt: completedAt,
  outcome: 'WINDOW_CLOSED' as const,
}

const windowClosedDriver = {
  timeoutMs: 30_000,
  onTimeout: (error: CycleRunnerError) => Effect.fail(error),
  advance: Effect.succeed({ observation: windowClosedObservation }),
  nextDelayMs: 30_000,
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

const withExecutionRuntime = (
  prepare: Effect.Effect<BoundRecoveryFirstCycleDriver, never, Scope.Scope>,
  use: (runtime: NativeExecutionRuntime) => Promise<void>,
): Promise<void> =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const resources = Layer.merge(
          Layer.effect(ExecutionCycleDriver, prepare),
          Layer.succeed(
            ExecutionControllerStatusStore,
            statusStore((candidate) => ({ _tag: 'Applied', status: candidate })),
          ),
        )
        const managed = yield* ScopedRef.fromAcquire(
          Effect.acquireRelease(
            Effect.sync(() => ManagedRuntime.make(resources)),
            (runtime) => runtime.disposeEffect,
          ),
        )
        const runtime = makeRecoveringManagedNativeExecutionRuntimeAdapter(
          managed,
          resources,
          ScopedRef.getUnsafe(managed),
          { runPromise: Effect.runPromise },
          controllerPlanHash,
          () => Promise.resolve(),
        )
        yield* Effect.promise(() => use(runtime))
      }),
    ),
  )

const plan = (overrides: PlanOverrides = {}): ApplicationPlan => {
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
    parameterHash: fixtureRuntime.provenance.strategy.parameterHash,
    strategyProtocolHash: hash('7'),
  }
}

describe('native execution runtime', () => {
  const observePreflight = <E>(read: Effect.Effect<readonly unknown[], E>) => {
    const original = plan({ brokerAccess: 'read-only' })
    const { capitalActivationRequestJson: _request, ...config } = original.config
    const sql = (() => read) as unknown as PgClient.PgClient
    return nativeActivationPreflight({ ...original, config }).pipe(Effect.provideService(PgClient.PgClient, sql))
  }
  const authorityRow = {
    schema_version: 'bayn.paper-authority.v1',
    generation_hash: 'a'.repeat(64),
    maximum: 'OBSERVE',
    effective: 'OBSERVE',
    kill_state: 'CLEAR',
    reason: null,
    version: '1',
    updated_at: '2026-11-05T18:00:00.000Z',
    observed_at: new Date('2026-11-05T18:01:00.000Z'),
  }

  test.each([{ rows: [] }, { rows: [authorityRow] }])(
    'authority preflight reads once without initializing or replacing execution resources: %j',
    async ({ rows }) => {
      let reads = 0
      await Effect.runPromise(
        observePreflight(
          Effect.sync(() => {
            reads += 1
            return rows
          }),
        ),
      )
      expect(reads).toBe(1)
    },
  )

  test.each([
    { ...authorityRow, maximum: 'PAPER', effective: 'PAPER' },
    { ...authorityRow, maximum: 'invalid' },
    { ...authorityRow, version: '0' },
    { ...authorityRow, updated_at: '2026-11-05T18:02:00.000Z' },
  ])('authority preflight rejects incompatible or invalid durable state: %j', async (row) => {
    const result = await Effect.runPromise(observePreflight(Effect.succeed([row])).pipe(Effect.result))
    expect(Result.isFailure(result)).toBe(true)
    if (Result.isFailure(result)) expect(result.failure).toBeInstanceOf(NativeActivationPreflightError)
  })

  test('authority preflight retains typed read failures and propagates defects', async () => {
    const failure = new Error('database unavailable')
    const result = await Effect.runPromise(observePreflight(Effect.fail(failure)).pipe(Effect.result))
    expect(result).toMatchObject({ _tag: 'Failure', failure: { cause: failure } })
    const defect = await Effect.runPromiseExit(observePreflight(Effect.die(failure)))
    expect(Exit.isFailure(defect)).toBe(true)
    if (Exit.isFailure(defect)) expect(Cause.hasDies(defect.cause)).toBe(true)
  })

  test.each(['timeout', 'interruption'])(
    'authority preflight cancels its read and finalizes once on %s',
    async (kind) => {
      let released = 0
      const result = await Effect.runPromise(
        Effect.gen(function* () {
          const started = yield* Deferred.make<void>()
          const read = Effect.gen(function* () {
            yield* Deferred.succeed(started, undefined)
            return yield* Effect.never
          }).pipe(
            Effect.ensuring(
              Effect.sync(() => {
                released += 1
              }),
            ),
          )
          const fiber = yield* Effect.forkChild(observePreflight(read))
          yield* Deferred.await(started)
          if (kind === 'timeout') yield* TestClock.adjust(30_000)
          else yield* Fiber.interrupt(fiber)
          return yield* Fiber.await(fiber)
        }).pipe(Effect.provide(TestClock.layer())),
      )
      expect(Exit.isFailure(result)).toBe(true)
      expect(released).toBe(1)
      if (Exit.isFailure(result) && kind === 'timeout') {
        expect(Cause.hasFails(result.cause)).toBe(true)
      }
    },
  )
  test('retains exact Jev observation references across stores, waiting, recovery and subsequent passes', async () => {
    const firstHash = hash('b')
    const recoveredHash = hash('a')
    const candidate = {
      contentHash: firstHash,
      payload: { schemaVersion: 'bayn.jev-observation.v1' },
    } as CandidateObservation
    const batch = { plan: { observationHash: recoveredHash }, result: null } as JevBatchEvidence
    const momentum = makeRepeatedMomentumPolicy(fixtureRuntime.definition.parameters)
    const retainedPolicies: Array<typeof momentum | undefined> = []
    let advances = 0
    const currentDriver = {
      ...driver,
      advance: Effect.gen(function* () {
        if (++advances === 1) {
          yield* (yield* CandidateObservationStore).record(candidate, momentum).pipe(Effect.orDie)
          yield* (yield* CandidateObservationStore).record(candidate).pipe(Effect.orDie)
          yield* (yield* JevBatchStore).finish(hash('c')).pipe(Effect.orDie)
        }
        return { observation: windowClosedObservation }
      }),
    }
    const context = Context.make(CandidateObservationStore, {
      record: (_source, policy) =>
        Effect.sync(() => {
          retainedPolicies.push(policy)
        }),
      latestJevWindowEnd: () => Effect.succeed(Option.none()),
    }).pipe(
      Context.add(JevBatchStore, {
        read: () => Effect.succeed(batch),
        pending: () => Effect.succeed([]),
        begin: () => Effect.succeed({ ...batch, dispatches: [] }),
        complete: () => Effect.succeed(batch),
        finish: () => Effect.succeed(batch),
      }),
    ) as Context.Context<RecoveryFirstRuntime>
    const results = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const bound = yield* bindRecoveryFirstCycleDriver(currentDriver, executionBuild).pipe(
            Effect.provideContext(context),
          )
          return [yield* bound.advance, yield* bound.advance]
        }),
      ),
    )
    expect(results[0]?.observation).toEqual({
      ...windowClosedObservation,
      executionBuild,
      jevObservationReferences: { hashes: [recoveredHash, firstHash], complete: true },
    })
    expect(results[1]?.observation).toEqual({
      ...windowClosedObservation,
      executionBuild,
      jevObservationReferences: { hashes: [], complete: true },
    })
    expect(retainedPolicies).toEqual([momentum, undefined])
  })

  test.each([false, true])(
    'failed Jev store access preserves earlier references without claiming completeness (%s)',
    async (retainEarlier) => {
      const failure = operationalError({ component: 'database', operation: 'fixture', message: 'record failed' })
      const candidate = {
        contentHash: hash('a'),
        payload: { schemaVersion: 'bayn.jev-observation.v1' },
      } as CandidateObservation
      const context = Context.make(CandidateObservationStore, {
        record: (observation) => (observation.contentHash === hash('b') ? Effect.void : Effect.fail(failure)),
        latestJevWindowEnd: () => Effect.succeed(Option.none()),
      }).pipe(
        Context.add(JevBatchStore, {
          read: () => Effect.succeed(null),
          pending: () => Effect.succeed([]),
          begin: () => Effect.fail(failure),
          complete: () => Effect.fail(failure),
          finish: () => Effect.fail(failure),
        }),
      ) as Context.Context<RecoveryFirstRuntime>
      const result = await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const bound = yield* bindRecoveryFirstCycleDriver(
              {
                ...driver,
                advance: Effect.gen(function* () {
                  if (retainEarlier)
                    yield* (yield* CandidateObservationStore)
                      .record({ ...candidate, contentHash: hash('b') })
                      .pipe(Effect.orDie)
                  yield* (yield* CandidateObservationStore).record(candidate).pipe(Effect.ignore)
                  return {
                    observation: {
                      result: 'FAILURE' as const,
                      observedAt: completedAt,
                      operation: 'build-decision' as const,
                      failure: 'database' as const,
                      message: 'record failed',
                    },
                  }
                }),
              },
              executionBuild,
            ).pipe(Effect.provideContext(context))
            return yield* bound.advance
          }),
        ),
      )
      expect(result.observation).toMatchObject({
        result: 'FAILURE',
        jevObservationReferences: { hashes: retainEarlier ? [hash('b')] : [], complete: false },
      })
    },
  )

  test.each(['overflow', 'malformed', 'instrumentation-failure'] as const)(
    'Jev reference %s does not change pass results',
    async (mode) => {
      const context = Context.make(CandidateObservationStore, {
        record: () => Effect.void,
        latestJevWindowEnd: () => Effect.succeed(Option.none()),
      }).pipe(
        Context.add(JevBatchStore, {
          read: () => Effect.succeed(null),
          pending: () => Effect.succeed([]),
          begin: () => Effect.die('unused'),
          complete: () => Effect.die('unused'),
          finish: () => Effect.die('unused'),
        }),
      ) as Context.Context<RecoveryFirstRuntime>
      let writes = 0
      const result = await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const bound = yield* bindRecoveryFirstCycleDriver(
              {
                ...driver,
                advance: Effect.gen(function* () {
                  const store = yield* CandidateObservationStore
                  for (let index = 20; index > 0; index--) {
                    const candidate = {
                      get contentHash() {
                        if (mode === 'instrumentation-failure') throw new Error('evidence unavailable')
                        return mode === 'malformed' ? 'invalid' : index.toString(16).padStart(64, '0')
                      },
                      payload: { schemaVersion: 'bayn.jev-observation.v1' },
                    } as CandidateObservation
                    yield* store.record(candidate).pipe(Effect.orDie)
                    writes++
                  }
                  return { observation: windowClosedObservation, nextDelayMs: 1_000 }
                }),
              },
              executionBuild,
            ).pipe(Effect.provideContext(context))
            return yield* bound.advance
          }),
        ),
      )
      expect(writes).toBe(20)
      expect(result.nextDelayMs).toBe(1_000)
      expect(result.observation).toEqual({
        ...windowClosedObservation,
        executionBuild,
        jevObservationReferences: {
          hashes:
            mode === 'overflow'
              ? Array.from({ length: 16 }, (_, index) => (index + 5).toString(16).padStart(64, '0'))
              : [],
          complete: false,
        },
      })
    },
  )

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

  test('keeps the owned execution runtime lazy until its first driver acquisition', async () => {
    let acquired = 0
    let released = 0
    const execution = ManagedRuntime.make(
      Layer.merge(
        Layer.effect(
          ExecutionCycleDriver,
          Effect.acquireRelease(
            Effect.sync(() => {
              acquired += 1
              return driver
            }),
            () =>
              Effect.sync(() => {
                released += 1
              }),
          ),
        ),
        Layer.succeed(
          ExecutionControllerStatusStore,
          statusStore((candidate) => ({ _tag: 'Applied', status: candidate })),
        ),
      ),
    )

    expect(acquired).toBe(0)

    await execution.runPromise(ExecutionCycleDriver.pipe(Effect.asVoid))
    expect(acquired).toBe(1)
    await execution.dispose()
    expect(released).toBe(1)
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

  test('keeps the Restate controller protocol stable across worker and trading-plan changes', () => {
    const first = executionControllerConfig(plan())
    const replay = executionControllerConfig(plan())
    const changedPlans = [
      plan({ imageDigest: `sha256:${hash('a')}` }),
      plan({ cyclePollIntervalMs: 60_000 }),
      plan({ reconciliationStaleThresholdMs: 180_000 }),
      plan({ persistedGrantHash: hash('d') }),
      plan({ brokerAccess: 'read-only' }),
      plan({ capitalAuthorityKind: 'none' }),
      plan({ tigerBeetleClusterId: 2_002n }),
      plan({ tigerBeetleLedger: 7_002 }),
    ].map(executionControllerConfig)

    expect(Result.isSuccess(first)).toBe(true)
    expect(replay).toEqual(first)
    if (Result.isFailure(first)) return
    expect(first.success.controllerKey).toBe(command.controllerKey)
    expect(first.success.planHash).toBe(executionControllerPlanHash)
    for (const changed of changedPlans) {
      expect(Result.isSuccess(changed)).toBe(true)
      if (Result.isSuccess(changed)) expect(changed.success.planHash).toBe(first.success.planHash)
    }
    expect(nativeExecutionRuntimeInitializationTimeoutMs(30_000)).toBe(150_000)
  })

  test('the native worker executes exactly one bounded pass for one Restate advance', async () => {
    let advances = 0
    const captured = await Effect.runPromise(
      bindRecoveryFirstCycleDriver(
        {
          ...driver,
          advance: Effect.sync(() => {
            advances++
            return { observation: windowClosedObservation }
          }),
        },
        executionBuild,
      ).pipe(Effect.provideContext(Context.empty() as Context.Context<RecoveryFirstRuntime>)),
    )
    await Effect.runPromise(
      executeNativeExecutionAdvance(
        command,
        captured,
        statusStore((candidate) => ({ _tag: 'Applied', status: candidate })),
        controllerPlanHash,
      ),
    )
    expect(advances).toBe(1)
  })

  test('keeps replacement registration and projection writer-fence-free until the first execution tick', async () => {
    let acquired = 0
    let released = 0
    let preflights = 0
    const context = Context.empty() as Context.Context<RecoveryFirstRuntime>
    const executionResources = Layer.merge(
      makeExecutionCycleDriverLive(
        30_000,
        Effect.acquireRelease(
          Effect.sync(() => {
            acquired += 1
            return undefined
          }),
          () =>
            Effect.sync(() => {
              released += 1
            }),
        ).pipe(
          Effect.andThen(bindRecoveryFirstCycleDriver(driver, executionBuild).pipe(Effect.provideContext(context))),
        ),
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
            async () => {
              preflights += 1
            },
          )

          expect(acquired).toBe(0)
          yield* Effect.promise(() => runtime.prepareActivation(new AbortController().signal))
          expect(preflights).toBe(1)
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
  })

  test('managed execution uses the replacement driver and retains its Jev references', async () => {
    const calls: string[] = []
    let rebind = false
    const candidate = {
      contentHash: hash('b'),
      payload: { schemaVersion: 'bayn.jev-observation.v1' },
    } as CandidateObservation
    const resources = Context.make(CandidateObservationStore, {
      record: () => Effect.void,
      latestJevWindowEnd: () => Effect.succeed(Option.none()),
    }).pipe(
      Context.add(JevBatchStore, {
        read: () => Effect.succeed(null),
        pending: () => Effect.succeed([]),
        begin: () => Effect.die('unused'),
        complete: () => Effect.die('unused'),
        finish: () => Effect.die('unused'),
      }),
    ) as Context.Context<RecoveryFirstRuntime>
    const bound = await Effect.runPromise(
      Effect.gen(function* () {
        const initial = {
          driver: {
            ...driver,
            advance: Effect.sync(() => {
              calls.push('restricted')
              rebind = true
              return { observation: windowClosedObservation }
            }),
          },
          needsRebind: Effect.sync(() => rebind),
        }
        const replacement = {
          driver: {
            ...driver,
            advance: Effect.gen(function* () {
              calls.push('successor')
              yield* (yield* CandidateObservationStore).record(candidate).pipe(Effect.orDie)
              return { observation: windowClosedObservation }
            }),
          },
          needsRebind: Effect.succeed(false),
        }
        const current = yield* makeRebindingCycleDriver(initial, Effect.succeed(replacement))
        return yield* bindRecoveryFirstCycleDriver(current, executionBuild)
      }).pipe(Effect.provideContext(resources)),
    )
    await withExecutionRuntime(Effect.succeed(bound), async (runtime) => {
      await runtime.advance(command, new AbortController().signal)
      await runtime.advance({ ...command, sequence: command.sequence + 1 }, new AbortController().signal)
    })
    const evidence = await Effect.runPromise(bound.advance)
    expect(evidence.observation.jevObservationReferences).toEqual({ hashes: [hash('b')], complete: true })
    expect(calls).toEqual(['restricted', 'successor', 'successor'])
  })

  test('reacquires execution resources after an initialization failure', async () => {
    let acquired = 0
    let released = 0
    const failure = new Error('transient dependency unavailable')
    const executionResources = Layer.merge(
      Layer.effect(
        ExecutionCycleDriver,
        Effect.acquireRelease(
          Effect.sync(() => {
            acquired += 1
            return acquired
          }),
          () =>
            Effect.sync(() => {
              released += 1
            }),
        ).pipe(Effect.flatMap((attempt) => (attempt === 1 ? Effect.fail(failure) : Effect.succeed(driver)))),
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
            () => Promise.resolve(),
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
    expect(result.second.outcome).toMatchObject({ _tag: 'Waiting', nextDelayMs: 30_000 })
    expect(acquired).toBe(2)
    expect(released).toBe(2)
  })

  test('times out stalled driver preparation and finalizes acquired resources exactly once', async () => {
    let released = 0
    const failure = await Effect.runPromise(
      Effect.gen(function* () {
        const started = yield* Deferred.make<void>()
        const resources = makeExecutionCycleDriverLive(
          20,
          Effect.acquireRelease(Deferred.succeed(started, undefined), () =>
            Effect.sync(() => {
              released++
            }),
          ).pipe(Effect.andThen(Effect.never)),
        )
        const pending = yield* Layer.build(resources).pipe(Effect.scoped, Effect.forkChild)
        yield* Deferred.await(started)
        yield* TestClock.adjust(nativeExecutionRuntimeInitializationTimeoutMs(20))
        return yield* Fiber.join(pending).pipe(Effect.flip)
      }).pipe(Effect.provide(TestClock.layer())),
    )
    expect(failure).toBeInstanceOf(NativeExecutionRuntimeError)
    expect(failure).toMatchObject({ operation: 'initialize' })
    expect(released).toBe(1)
  })

  test('projects the exact completed tick before returning the compact Restate result', async () => {
    let projected: ExecutionControllerStatus | undefined
    const result = await Effect.runPromise(
      executeNativeExecutionAdvance(
        command,
        windowClosedDriver,
        statusStore((candidate) => {
          projected = candidate
          return { _tag: 'Applied', status: candidate }
        }),
        controllerPlanHash,
      ),
    )

    expect(result.outcome).toMatchObject({ _tag: 'Waiting', nextDelayMs: 30_000 })
    expect(result.observation).toEqual({ ...windowClosedObservation, executionIssuedAt: command.issuedAt })
    expect(projected).toMatchObject({
      controllerKey: command.controllerKey,
      planHash: controllerPlanHash,
      epoch: command.epoch,
      nextSequence: command.sequence + 1,
      lastSequence: command.sequence,
      lastOutcome: 'Waiting',
      lastReceiptHash: result.outcome.receiptHash,
      lastPass: { ...windowClosedObservation, executionIssuedAt: command.issuedAt },
    })
    if (projected === undefined || !executionControllerStatusHasCompletion(projected)) {
      throw new Error('completed execution did not project completion evidence')
    }
    expect(projected.nextDueAt).toBe(
      new Date(Date.parse(result.completedAt) + result.outcome.nextDelayMs).toISOString(),
    )
  })

  test.each([
    [7_000, 3_000],
    [7_000, 8_000],
    [30_000, 2_000],
    [31_000, 2_000],
    [100_000, 2_000],
  ])('preserves an absolute wake %dms ahead across %dms of work and projected replay', async (dueMs, elapsedMs) => {
    const start = Date.parse(completedAt)
    const nextWakeAt = new Date(start + dueMs).toISOString()
    const delay = Math.min(30_000, dueMs)
    let projected: ExecutionControllerStatus | null = null
    let advances = 0
    const store: ExecutionControllerStatusStoreShape = {
      read: () => Effect.succeed(projected),
      project: (candidate) =>
        Effect.sync(() => {
          projected = candidate
          return { _tag: 'Applied', status: candidate }
        }),
    }
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        yield* TestClock.adjust(start)
        const boundedDriver = {
          ...windowClosedDriver,
          advance: Effect.gen(function* () {
            advances += 1
            yield* TestClock.adjust(elapsedMs)
            return { observation: windowClosedObservation, nextDelayMs: delay, nextWakeAt }
          }),
        }
        const first = yield* executeNativeExecutionAdvance(command, boundedDriver, store, controllerPlanHash)
        yield* TestClock.adjust(20_000)
        const replayed = yield* executeNativeExecutionAdvance(command, boundedDriver, store, controllerPlanHash)
        expect(replayed).toEqual(first)
        return first
      }).pipe(Effect.provide(TestClock.layer())),
    )
    expect(advances).toBe(1)
    const expectedDelay = Math.min(delay, Math.max(1, dueMs - elapsedMs))
    expect(result.outcome.nextDelayMs).toBe(expectedDelay)
    expect(result.outcome.nextWakeAt).toBe(nextWakeAt)
    expect(projected).toMatchObject({
      nextDueAt: new Date(start + elapsedMs + expectedDelay).toISOString(),
      lastPass: { nextWakeAt },
    })
  })

  test('old persisted completions do not opt into absolute-wake journal commands', async () => {
    const retained = status({ lastPass: windowClosedObservation })
    const result = await Effect.runPromise(
      executeNativeExecutionAdvance(
        command,
        { ...windowClosedDriver, advance: Effect.die('old completion must replay without a new pass') },
        { read: () => Effect.succeed(retained), project: () => Effect.die('old completion must not be rewritten') },
        controllerPlanHash,
      ),
    )
    expect(result.outcome).not.toHaveProperty('nextWakeAt')
    expect(result.outcome.nextDelayMs).toBe(30_000)
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

  test('keeps retained pass evidence in PostgreSQL while Restate state remains rollback-compatible', async () => {
    const retained = status({ lastPass: windowClosedObservation })
    if (!executionControllerStatusHasCompletion(retained)) {
      throw new Error('retained projection fixture must contain completion evidence')
    }
    if (retained.nextDueAt === undefined) throw new Error('retained projection fixture must contain a next due time')
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
          nextSequence: command.sequence + 1,
          lastCompletion: {
            sequence: command.sequence,
            outcome: retained.lastOutcome,
            receiptHash: retained.lastReceiptHash,
            completedAt: retained.completedAt,
          },
          nextDueAt: retained.nextDueAt,
        },
        {
          read: () => Effect.succeed(retained),
          project: (candidate) =>
            Effect.sync(() => {
              projected = candidate
              return { _tag: 'Replayed' as const, status: candidate }
            }),
        },
      ),
    )

    expect(projected).toMatchObject({
      lastSequence: command.sequence,
      lastPass: windowClosedObservation,
    })
  })

  test.each([false, true])(
    'retains a pass only in its existing projection epoch (stored inactive: %s)',
    async (storedInactive) => {
      const retained = status({
        lastPass: windowClosedObservation,
        active: !storedInactive,
        epoch: storedInactive ? command.epoch + 1 : command.epoch,
      })
      if (!executionControllerStatusHasCompletion(retained)) throw new Error('Expected a retained completion')
      let projected: ExecutionControllerStatus | undefined
      await Effect.runPromise(
        projectExecutionControllerState(
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
              sequence: retained.lastSequence,
              outcome: retained.lastOutcome,
              receiptHash: retained.lastReceiptHash,
              completedAt: retained.completedAt,
            },
          },
          {
            read: () => Effect.succeed(retained),
            project: (candidate) =>
              Effect.sync(() => {
                projected = candidate
                return { _tag: 'Applied' as const, status: candidate }
              }),
          },
        ),
      )
      expect(projected).toMatchObject({ epoch: command.epoch + 1, lastReceiptHash: retained.lastReceiptHash })
      if (storedInactive) expect(projected).toHaveProperty('lastPass', windowClosedObservation)
      else expect(projected).not.toHaveProperty('lastPass')
    },
  )

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

  test.each([undefined, { hashes: [hash('a')], complete: true }])(
    'replays a duplicate Restate delivery after an ambiguous commit without another aggregate advance (%j)',
    async (jevObservationReferences) => {
      let advanceCount = 0
      let projectCount = 0
      const persistence: { current: ExecutionControllerStatus | null } = { current: null }
      const retainedObservation = {
        ...windowClosedObservation,
        ...(jevObservationReferences === undefined ? {} : { jevObservationReferences }),
      }
      const replayDriver = {
        ...windowClosedDriver,
        advance: Effect.sync(() => {
          advanceCount += 1
          return { observation: retainedObservation }
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

      const first = await Effect.runPromise(
        executeNativeExecutionAdvance(command, replayDriver, uncertainStore, controllerPlanHash),
      )
      const replay = await Effect.runPromise(
        executeNativeExecutionAdvance(command, replayDriver, uncertainStore, controllerPlanHash),
      )

      expect(advanceCount).toBe(1)
      expect(projectCount).toBe(1)
      const committed = persistence.current
      if (committed === null) throw new Error('ambiguous projection did not persist its status')
      if (!executionControllerStatusHasCompletion(committed)) {
        throw new Error('ambiguous completion projection lost its completion evidence')
      }
      expect(replay).toEqual({
        completedAt: committed.completedAt,
        observation: { ...retainedObservation, executionIssuedAt: command.issuedAt },
        outcome: {
          _tag: committed.lastOutcome,
          receiptHash: committed.lastReceiptHash,
          nextDelayMs: 30_000,
        },
      })
      expect(first).toEqual(replay)
    },
  )

  test('adopts the persisted winner when a replay loses the same-command projection race', async () => {
    let advanceCount = 0
    let projectCount = 0
    let readCount = 0
    const authoritative = status({
      lastReceiptHash: hash('a'),
      lastPass: windowClosedObservation,
    })
    if (!executionControllerStatusHasCompletion(authoritative)) {
      throw new Error('projection-race fixture requires completion evidence')
    }
    const racingStore: ExecutionControllerStatusStoreShape = {
      read: () =>
        Effect.sync(() => {
          readCount += 1
          return readCount === 1 ? null : authoritative
        }),
      project: () => {
        projectCount += 1
        return Effect.fail(
          new ExecutionControllerStatusStoreError({
            operation: 'project',
            failure: 'conflict',
            message: 'controller epoch and sequence were reused with different evidence',
          }),
        )
      },
    }
    const replayDriver = {
      ...windowClosedDriver,
      advance: Effect.sync(() => {
        advanceCount += 1
        return { observation: windowClosedObservation }
      }),
    }

    const observed = await Effect.runPromise(
      executeNativeExecutionAdvance(command, replayDriver, racingStore, controllerPlanHash),
    )

    expect(advanceCount).toBe(1)
    expect(projectCount).toBe(1)
    expect(readCount).toBe(2)
    expect(observed).toEqual({
      completedAt: authoritative.completedAt,
      observation: windowClosedObservation,
      outcome: {
        _tag: authoritative.lastOutcome,
        receiptHash: authoritative.lastReceiptHash,
        nextDelayMs: 30_000,
      },
    })
  })

  test('fails closed when a projection conflict resolves to a different controller command', async () => {
    let advanceCount = 0
    let readCount = 0
    const conflictingStore: ExecutionControllerStatusStoreShape = {
      read: () =>
        Effect.sync(() => {
          readCount += 1
          return readCount === 1 ? null : status({ planHash: hash('8') })
        }),
      project: () =>
        Effect.fail(
          new ExecutionControllerStatusStoreError({
            operation: 'project',
            failure: 'conflict',
            message: 'controller epoch and sequence were reused with different evidence',
          }),
        ),
    }
    const replayDriver = {
      ...driver,
      advance: Effect.sync(() => {
        advanceCount += 1
      }).pipe(Effect.andThen(driver.advance)),
    }

    const failure = await Effect.runPromise(
      executeNativeExecutionAdvance(command, replayDriver, conflictingStore, controllerPlanHash).pipe(Effect.flip),
    )

    expect(advanceCount).toBe(1)
    expect(readCount).toBe(2)
    expect(failure).toBeInstanceOf(TransientExecutionFailure)
    expect(failure.message).toBe('execution controller status projection did not complete')
  })

  test('rejects a retired unbound plan without advancing execution or rebinding its projection', async () => {
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
                outcome: 'WINDOW_CLOSED' as const,
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
      ).pipe(Effect.flip),
    )

    expect(failure).toBeInstanceOf(TransientExecutionFailure)
    expect(advanceCount).toBe(0)
    expect(projected).toBeUndefined()
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
                outcome: 'WINDOW_CLOSED' as const,
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

  test('execution spans retain the native Restate parent across the Effect runtime boundary', async () => {
    const provider = new NodeTracerProvider()
    provider.register()
    const nativeParent = { traceId: 'b'.repeat(32), spanId: 'c'.repeat(16), traceFlags: TraceFlags.SAMPLED }
    let observedTraceId: string | undefined
    let rootParentId: string | undefined
    try {
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const tracedDriver = {
              ...driver,
              advance: Effect.gen(function* () {
                const span = yield* Effect.currentSpan.pipe(Effect.orDie)
                observedTraceId = span.traceId
                let parent = span.parent
                while (Option.isSome(parent)) {
                  rootParentId = parent.value.spanId
                  parent = parent.value._tag === 'Span' ? parent.value.parent : Option.none()
                }
                return { observation: windowClosedObservation }
              }).pipe(Effect.withSpan('execution-pass-test')),
            }
            const store = statusStore((candidate) => ({ _tag: 'Applied', status: candidate }))
            const resources = Layer.merge(
              Layer.succeed(ExecutionCycleDriver, tracedDriver),
              Layer.succeed(ExecutionControllerStatusStore, store),
            )
            const managed = yield* ScopedRef.fromAcquire(
              Effect.acquireRelease(
                Effect.sync(() => ManagedRuntime.make(resources)),
                (runtime) => runtime.disposeEffect,
              ),
            )
            const runner = { runPromise: Effect.runPromise }
            const runtime = makeRecoveringManagedNativeExecutionRuntimeAdapter(
              managed,
              resources,
              ScopedRef.getUnsafe(managed),
              runner,
              controllerPlanHash,
              () => Promise.resolve(),
            )
            yield* Effect.promise(() =>
              context.with(trace.setSpanContext(context.active(), nativeParent), () =>
                runtime.advance(command, new AbortController().signal),
              ),
            )
          }),
        ),
      )
      expect(observedTraceId).toBe(nativeParent.traceId)
      expect(rootParentId).toBe(nativeParent.spanId)
    } finally {
      await provider.shutdown()
      context.disable()
      propagation.disable()
      trace.disable()
    }
  })

  test('interrupts an in-flight execution pass when Restate cancels it', async () => {
    const started = Effect.runSync(Deferred.make<void>())
    let interrupted = 0
    const current = {
      ...driver,
      advance: Deferred.succeed(started, undefined).pipe(
        Effect.andThen(Effect.never),
        Effect.onInterrupt(() =>
          Effect.sync(() => {
            interrupted += 1
          }),
        ),
      ),
    }
    await withExecutionRuntime(Effect.succeed(current), async (runtime) => {
      const abort = new AbortController()
      const pending = runtime.advance(command, abort.signal).then(
        () => undefined,
        (cause: unknown) => cause,
      )
      await Effect.runPromise(Deferred.await(started))
      abort.abort()
      expect(await pending).toBeDefined()
      expect(interrupted).toBe(1)
    })
    expect(interrupted).toBe(1)
  })

  test('a failed generation replacement retries without using the old driver or reacquiring clients', async () => {
    let acquired = 0
    let released = 0
    let rebind = false
    let calls = 0
    let preparations = 0
    const failure = operationalError({ component: 'database', operation: 'fixture', message: 'unavailable' })
    const current = await Effect.runPromise(
      makeRebindingCycleDriver(
        {
          driver: {
            ...driver,
            advance: Effect.sync(() => {
              calls++
              rebind = true
              return { observation: windowClosedObservation }
            }),
          },
          needsRebind: Effect.sync(() => rebind),
        },
        Effect.gen(function* () {
          preparations++
          if (preparations === 1) return yield* failure
          return { driver, needsRebind: Effect.succeed(false) }
        }),
      ),
    )
    const prepare = Effect.acquireRelease(
      Effect.sync(() => {
        acquired++
        return current
      }),
      () =>
        Effect.sync(() => {
          released++
        }),
    )
    await withExecutionRuntime(prepare, async (runtime) => {
      await runtime.advance(command, new AbortController().signal)
      const next = { ...command, sequence: command.sequence + 1 }
      const failed = await runtime.advance(next, new AbortController().signal).then(
        () => undefined,
        (error: unknown) => error,
      )
      expect(failed).toBeInstanceOf(TransientExecutionFailure)
      expect(calls).toBe(1)
      await runtime.advance(next, new AbortController().signal)
      expect(calls).toBe(1)
      expect(preparations).toBe(2)
      expect(acquired).toBe(1)
      expect(released).toBe(0)
    })
    expect(released).toBe(1)
  })
})
