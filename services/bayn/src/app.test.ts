import { describe, expect, test } from 'bun:test'

import { Clock, Context, Deferred, Effect, Fiber, Layer, Option, pipe, Redacted, Ref, Result, Scope } from 'effect'

import {
  config,
  fixtureEvaluation,
  fixtureRuntime,
  marketDataService,
  pinnedEvaluation,
  pinnedLock,
  pinnedQualification,
  pinnedRuntimeConfig,
  pinnedStore,
  successfulEvidenceStore,
  successfulJournal,
} from './app-test-support'
import { utcInstantFromEpochMillis } from './time'
import {
  type ApplicationIdentity,
  type AutonomousCycleStartupInput,
  type AutonomousApplicationConfig,
  type BrokerlessApplicationConfig,
  makeApplicationPlan,
  runApplication,
} from './app'
import {
  AccountStatus,
  BrokerProvider,
  BrokerSession,
  alpacaSandboxBaseUrl,
  type BrokerReadShape,
  type BrokerSessionShape,
} from './broker/alpaca'
import { unusedAssetBySymbol, unusedMarketCalendar } from './broker/alpaca-test-support'
import { makeBrokerIdentity } from './broker/identity'
import type { LoadedRuntimeConfig } from './config'
import { makeStrategyProtocolHash } from './contracts'
import { BrokerAccess, BrokerEnvironment, noCapitalAuthority } from './execution/authority'
import type { ExecutionProgram } from './execution/runtime-program'
import { executionPrepareBoundaryError, validateExecutionPreparePlan } from './entrypoint'
import { EvidenceStore } from './db/evidence-store'
import type { ExecutionPrepareRequest } from './execution-prepare'
import { makeExecutionPrepareDiscoveryReceiptFixture } from './execution-prepare/test-fixture'
import { canonicalHashV1OrThrow } from './hash'
import type { BrokerProbe } from './health'
import { HttpServerLive } from './http'
import { loadObserveRiskPolicy } from './observe-composition'
import { makeRiskBalancedTrendDefinition } from './strategy'
import { fixtureProtocol, makeSnapshot, makeTestProvenance } from './test-fixtures'
import { scopedAcquisition } from './resource-boundary'

const cycleObservability = {
  read: () =>
    Effect.succeed({
      current: null,
      last: null,
      unfinishedCycleCount: 0,
      authority: null,
      reconciliation: null,
      mutations: {
        eventCount: 0,
        recoveryFoundCount: 0,
        approvedIntentCount: 0,
        acknowledgedIntentCount: 0,
        unresolvedCount: 0,
        oldestUnresolvedAt: null,
        latestOccurredAt: null,
      },
    }),
}

const brokerAccountId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const brokerRead = (): BrokerReadShape => {
  const unused = Effect.die(new Error('application lifecycle test must only read the broker account'))
  return {
    account: Effect.succeed({
      value: {
        id: brokerAccountId,
        status: AccountStatus.Active,
        currency: 'USD',
        cashMicros: '1000000',
        equityMicros: '1000000',
        lastEquityMicros: '1000000',
        buyingPowerMicros: '1000000',
        accountBlocked: false,
        tradingBlocked: false,
        tradeSuspendedByUser: false,
        observedAt: '2026-07-20T00:00:00.000Z',
      },
      evidence: {
        requestId: 'application-lifecycle',
        status: 200,
        contentHash: 'a'.repeat(64),
        observedAt: '2026-07-20T00:00:00.000Z',
      },
    }),
    accountConfiguration: unused,
    assetBySymbol: unusedAssetBySymbol,
    positions: unused,
    orders: () => unused,
    orderById: () => unused,
    orderByClientId: () => unused,
    fillActivities: () => unused,
    marketCalendar: unusedMarketCalendar,
  }
}

const broker: BrokerProbe = {
  read: brokerRead(),
  expectedAccountId: brokerAccountId,
  executionEligible: false,
  executionDisabledReason: 'MAXIMUM_AUTHORITY_OBSERVE',
}

const autonomousConfig = (runtime: typeof config): AutonomousApplicationConfig => ({
  ...runtime,
  runtimeMode: 'AutonomousService',
  cyclePollIntervalMs: 30_000,
  execution: {
    brokerIdentity: Result.getOrThrow(
      makeBrokerIdentity({
        schemaVersion: 'bayn.broker-identity.v2',
        provider: BrokerProvider.Alpaca,
        environment: BrokerEnvironment.Sandbox,
        accountId: brokerAccountId,
      }),
    ),
    brokerAccess: BrokerAccess.ReadOnly,
    capitalAuthority: noCapitalAuthority,
  },
  alpaca: {
    provider: BrokerProvider.Alpaca,
    environment: BrokerEnvironment.Sandbox,
    identity: Result.getOrThrow(
      makeBrokerIdentity({
        schemaVersion: 'bayn.broker-identity.v2',
        provider: BrokerProvider.Alpaca,
        environment: BrokerEnvironment.Sandbox,
        accountId: brokerAccountId,
      }),
    ),
    baseUrl: alpacaSandboxBaseUrl,
    expectedAccountId: brokerAccountId,
    authorityGenerationHash: 'f'.repeat(64),
    key: Redacted.make('test-key'),
    secret: Redacted.make('test-secret'),
    proxyUrl: 'http://proxy.test:3128',
    operationTimeoutMs: runtime.operationTimeoutMs,
    retryAttempts: 0,
    reconciliationIntervalMs: 30_000,
  },
})

const brokerlessConfig = (runtime: typeof config): BrokerlessApplicationConfig => ({
  ...runtime,
  runtimeMode: 'BrokerlessService',
  cyclePollIntervalMs: 30_000,
  execution: {
    brokerIdentity: undefined,
    brokerAccess: BrokerAccess.ReadOnly,
    capitalAuthority: noCapitalAuthority,
  },
  alpaca: undefined,
})

const discoveryConfig = (
  runtime: typeof pinnedRuntimeConfig,
): Extract<LoadedRuntimeConfig, { readonly runtimeMode: 'ExecutionCandidateDiscovery' }> => ({
  ...autonomousConfig(runtime),
  runtimeMode: 'ExecutionCandidateDiscovery',
  qualificationRunId: pinnedEvaluation.runId,
  execution: {
    brokerIdentity: autonomousConfig(runtime).alpaca.identity,
    brokerAccess: BrokerAccess.ReadOnly,
    capitalAuthority: noCapitalAuthority,
  },
})

const prepareConfig = (
  runtime: typeof pinnedRuntimeConfig,
): Extract<LoadedRuntimeConfig, { readonly runtimeMode: 'ExecutionPrepare' }> => {
  const autonomous = autonomousConfig(runtime)
  const prepareStrategy = {
    ...fixtureRuntime.provenance.strategy,
    parameterSchemaVersion: 'bayn.risk-balanced-trend.protocol.v4' as const,
  }
  const riskPolicyHash = canonicalHashV1OrThrow(
    Effect.runSync(
      loadObserveRiskPolicy(autonomous.alpaca.expectedAccountId, fixtureRuntime.definition.parameters.universe),
    ),
  )
  const strategyProtocolHash = makeStrategyProtocolHash(prepareStrategy)
  const reconciliationId = 'd'.repeat(64)
  const reconciliationContentHash = 'e'.repeat(64)
  const discoveryReceipt = makeExecutionPrepareDiscoveryReceiptFixture({
    sourceRevision: runtime.build.sourceRevision,
    imageRepository: runtime.build.imageRepository,
    imageDigest: runtime.build.imageDigest,
    strategy: prepareStrategy,
    strategyProtocolHash,
    qualificationRunId: pinnedEvaluation.runId,
    accountId: autonomous.alpaca.expectedAccountId,
    authorityGenerationHash: autonomous.alpaca.authorityGenerationHash,
    policyHash: riskPolicyHash,
    reconciliationId,
    reconciliationContentHash,
  })
  const discoveredCandidate = discoveryReceipt.candidateFacts.candidates[0]!
  const executionPrepareRequest: ExecutionPrepareRequest = {
    schemaVersion: 'bayn.execution-prepare-request.v1',
    qualification: {
      runId: pinnedQualification.runId,
      lockId: pinnedLock.lockId,
      resultHash: pinnedQualification.resultHash,
      verdict: 'QUALIFIED',
      sourceRevision: pinnedLock.sourceRevision,
      imageRepository: pinnedLock.image.repository,
      imageDigest: pinnedLock.image.digest,
      candidateOrdinal: discoveredCandidate.ordinal,
    },
    discoveryReceipt,
  }
  return {
    ...autonomous,
    runtimeMode: 'ExecutionPrepare',
    qualificationRunId: pinnedEvaluation.runId,
    executionPrepareRequest,
    execution: {
      brokerIdentity: autonomous.alpaca.identity,
      brokerAccess: BrokerAccess.ReadOnly,
      capitalAuthority: noCapitalAuthority,
    },
  }
}

const applicationIdentity = (loaded: LoadedRuntimeConfig): ApplicationIdentity => ({
  config: loaded,
  protocol: fixtureProtocol,
  parameterHash: fixtureRuntime.provenance.strategy.parameterHash,
  strategy: fixtureRuntime,
  strategyProtocolHash: makeStrategyProtocolHash(fixtureRuntime.provenance.strategy),
})

describe('Bayn application composition', () => {
  test('constructs one exhaustive immutable application plan for every resolved runtime mode', () => {
    const modes = [
      { config: brokerlessConfig(config), expectedTag: 'BrokerlessService' },
      { config: autonomousConfig(config), expectedTag: 'AutonomousService' },
      { config: discoveryConfig(pinnedRuntimeConfig), expectedTag: 'ExecutionCandidateDiscovery' },
      { config: prepareConfig(pinnedRuntimeConfig), expectedTag: 'ExecutionPrepare' },
    ] as const

    for (const mode of modes) {
      const identity = Object.freeze(applicationIdentity(mode.config))
      const plan = makeApplicationPlan(identity)

      expect(plan._tag).toBe(mode.expectedTag)
      expect(plan.config).toBe(mode.config)
      expect(plan.protocol).toBe(identity.protocol)
      expect(plan.strategy).toBe(identity.strategy)
      expect(plan.parameterHash).toBe(identity.parameterHash)
      expect(plan.strategyProtocolHash).toBe(identity.strategyProtocolHash)
      expect(identity).not.toHaveProperty('_tag')
    }
  })

  test('redacts bounded-operation resource failures before stdout logging', () => {
    const accountNumber = 'account-number-must-remain-redacted'
    const failure = executionPrepareBoundaryError({
      _tag: 'BrokerSessionAcquisitionError',
      expectedAccountId: accountNumber,
      cause: new Error(`credential and ${accountNumber}`),
    })

    expect(failure).toMatchObject({
      component: 'strategy',
      operation: 'execution-prepare-resource',
      retryable: false,
      cause: { _tag: 'BrokerSessionAcquisitionError' },
    })
    expect(JSON.stringify(failure)).not.toContain(accountNumber)
    expect(JSON.stringify(failure)).not.toContain('credential')
  })

  test('rejects terminal and captured-discovery drift before downstream resources', async () => {
    const base = prepareConfig(pinnedRuntimeConfig)
    const requests: readonly ExecutionPrepareRequest[] = [
      {
        ...base.executionPrepareRequest,
        qualification: { ...base.executionPrepareRequest.qualification, resultHash: '0'.repeat(64) },
      },
      {
        ...base.executionPrepareRequest,
        discoveryReceipt: {
          ...base.executionPrepareRequest.discoveryReceipt,
          observationReceiptHash: '0'.repeat(64),
        },
      },
    ]
    for (const executionPrepareRequest of requests) {
      let acquisitions = 0
      const resources = Layer.effect(
        BrokerSession,
        Effect.sync(() => {
          acquisitions += 1
          return {} as BrokerSessionShape
        }),
      )
      const plan = makeApplicationPlan(
        applicationIdentity({
          ...base,
          executionPrepareRequest,
        }),
      )
      if (plan._tag !== 'ExecutionPrepare') throw new Error('fixture must produce EXECUTION_PREPARE')

      const qualifiedEvidenceStore = {
        ...pinnedStore(),
        readQualification: () =>
          Effect.succeed(
            Option.some({
              state: 'TERMINAL' as const,
              lock: pinnedLock,
              result: { ...pinnedQualification, verdict: 'QUALIFIED' as const },
            }),
          ),
      }

      const failure = await Effect.runPromise(
        Effect.flip(
          validateExecutionPreparePlan(plan).pipe(
            Effect.provide(Layer.succeed(EvidenceStore, qualifiedEvidenceStore)),
            Effect.flatMap(() => BrokerSession.pipe(Effect.provide(resources))),
          ),
        ),
      )

      expect(failure).toMatchObject({ component: 'strategy', operation: 'execution-prepare' })
      expect(acquisitions).toBe(0)
    }
  })

  test('starts one scoped autonomous cycle after initialization and interrupts it with the application', async () => {
    const calls: string[] = []
    let backgroundInterrupted = false
    const marketData = marketDataService(
      Effect.sync(() => {
        calls.push('initialize')
        return makeSnapshot()
      }),
    )
    let startupQualificationRunId: string | undefined
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const started = yield* Deferred.make<void>()
          const startCycle = ({ qualificationRunId, recordPass }: AutonomousCycleStartupInput) =>
            pipe(
              Effect.sync(() => {
                calls.push('autonomous-cycle')
                startupQualificationRunId = qualificationRunId
              }),
              Effect.andThen(Clock.currentTimeMillis),
              Effect.map(utcInstantFromEpochMillis),
              Effect.flatMap((observedAt) => recordPass({ result: 'SUCCESS', observedAt, outcome: 'NO_PUBLICATION' })),
              Effect.as(
                pipe(
                  Deferred.succeed(started, undefined),
                  Effect.andThen(Effect.never),
                  Effect.onInterrupt(() => Effect.sync(() => void (backgroundInterrupted = true))),
                ),
              ),
            )
          const fiber = yield* pipe(
            runApplication(
              autonomousConfig(config),
              fixtureRuntime,
              {
                marketData,
                journal: successfulJournal,
                evidenceStore: successfulEvidenceStore,
                cycleObservability,
              },
              { _tag: 'AutonomousRead', broker, startCycle },
            ),
            Effect.provide(HttpServerLive(config)),
            Effect.forkScoped,
          )
          yield* pipe(Deferred.await(started), Effect.timeout('1 second'))
          yield* Fiber.interrupt(fiber)
        }),
      ),
    )

    expect(calls).toEqual(['initialize', 'autonomous-cycle'])
    expect(startupQualificationRunId).toBe(fixtureEvaluation.runId)
    expect(backgroundInterrupted).toBe(true)
  })

  test('starts an observation-bound autonomous cycle without qualification evidence', async () => {
    const observationBinding = 'b'.repeat(64)
    let startedBindingId: string | undefined
    let observedBindingId: string | undefined
    let startupMarketDataLoads = 0
    let startupQualificationOpens = 0

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const started = yield* Deferred.make<void>()
          const observed = yield* Deferred.make<void>()
          const startCycle = ({ qualificationRunId }: AutonomousCycleStartupInput) =>
            Effect.sync(() => void (startedBindingId = qualificationRunId)).pipe(
              Effect.as(Deferred.succeed(started, undefined).pipe(Effect.andThen(Effect.never))),
            )
          const researchCycleObservability = {
            read: (bindingId: string) =>
              Effect.sync(() => void (observedBindingId = bindingId)).pipe(
                Effect.andThen(Deferred.succeed(observed, undefined)),
                Effect.andThen(cycleObservability.read()),
              ),
          }
          const fiber = yield* runApplication(
            autonomousConfig(config),
            fixtureRuntime,
            {
              marketData: marketDataService(
                Effect.sync(() => {
                  startupMarketDataLoads += 1
                  return makeSnapshot()
                }),
              ),
              journal: successfulJournal,
              evidenceStore: {
                ...successfulEvidenceStore,
                openQualification: (request) =>
                  Effect.sync(() => {
                    startupQualificationOpens += 1
                    return { state: 'ACQUIRED' as const, lock: request.lock }
                  }),
              },
              cycleObservability: researchCycleObservability,
            },
            {
              _tag: 'AutonomousRead',
              requiresQualificationEvidence: false,
              broker,
              cycleBindingId: observationBinding,
              cycleObservationId: observationBinding,
              startCycle,
            },
          ).pipe(Effect.provide(HttpServerLive(config)), Effect.forkScoped)
          yield* Deferred.await(started).pipe(Effect.timeout('1 second'))
          yield* Deferred.await(observed).pipe(Effect.timeout('1 second'))
          yield* Fiber.interrupt(fiber)
        }),
      ),
    )

    expect(startedBindingId).toBe(observationBinding)
    expect(observedBindingId).toBe(observationBinding)
    expect(startupMarketDataLoads).toBe(0)
    expect(startupQualificationOpens).toBe(0)
  })

  test('explicitly suppresses a pending research cycle despite recovered qualification evidence', async () => {
    let cycleStarted = false

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const resolved = yield* Deferred.make<void>()
          const fiber = yield* runApplication(
            autonomousConfig(config),
            fixtureRuntime,
            {
              marketData: marketDataService(Effect.succeed(makeSnapshot())),
              journal: successfulJournal,
              evidenceStore: successfulEvidenceStore,
              cycleObservability,
            },
            {
              _tag: 'AutonomousRead',
              cycleBindingId: null,
              broker,
              startCycle: () =>
                Effect.sync(() => {
                  cycleStarted = true
                }).pipe(Effect.as(Effect.never)),
              resolveAfterStartup: () =>
                Deferred.succeed(resolved, undefined).pipe(
                  Effect.as({
                    _tag: 'AutonomousRead' as const,
                    cycleBindingId: null,
                    broker,
                    startCycle: () =>
                      Effect.sync(() => {
                        cycleStarted = true
                      }).pipe(Effect.as(Effect.never)),
                  }),
                ),
            },
          ).pipe(Effect.provide(HttpServerLive(config)), Effect.forkScoped)
          yield* Deferred.await(resolved).pipe(Effect.timeout('1 second'))
          yield* Effect.yieldNow
          expect(cycleStarted).toBe(false)
          yield* Fiber.interrupt(fiber)
        }),
      ),
    )
  })

  test('resolves the autonomous broker runtime before starting its cycle', async () => {
    const events: string[] = []
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const started = yield* Deferred.make<void>()
          const startCycle = () =>
            Effect.sync(() => events.push('cycle')).pipe(
              Effect.andThen(Deferred.succeed(started, undefined)),
              Effect.andThen(Effect.never),
            )
          const unresolvedStartCycle = () => Effect.succeed(Effect.void)
          const fiber = yield* runApplication(
            autonomousConfig(config),
            fixtureRuntime,
            {
              marketData: marketDataService(Effect.succeed(makeSnapshot())),
              journal: successfulJournal,
              evidenceStore: successfulEvidenceStore,
              cycleObservability,
            },
            {
              _tag: 'AutonomousRead',
              brokerConfiguration: {
                expectedAccountId: brokerAccountId,
                executionEligible: false,
                executionDisabledReason: 'BROKER_ACCESS_READ_ONLY',
              },
              startCycle: unresolvedStartCycle,
              resolveAfterStartup: (state) =>
                Effect.gen(function* () {
                  const current = yield* Ref.get(state)
                  expect(current.broker?.readAvailable).toBe(null)
                  events.push('resolved')
                  return { _tag: 'AutonomousRead' as const, broker, startCycle }
                }),
            },
          ).pipe(Effect.provide(HttpServerLive(config)), Effect.forkScoped)
          yield* Deferred.await(started).pipe(Effect.timeout('1 second'))
          yield* Fiber.interrupt(fiber)
        }),
      ),
    )

    expect(events).toEqual(['resolved', 'cycle'])
  })

  test('keeps resolver-owned runtime resources open through cycle and health until application interruption', async () => {
    const events: string[] = []
    let finalizations = 0

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const cycleUsed = yield* Deferred.make<void>()
          const healthUsed = yield* Deferred.make<void>()
          interface RuntimeResourceShape {
            readonly close: () => void
            readonly use: (consumer: 'cycle' | 'health') => Effect.Effect<void>
          }
          class RuntimeResource extends Context.Service<RuntimeResource, RuntimeResourceShape>()(
            '@proompteng/bayn/app.test/RuntimeResource',
          ) {}
          const runtimeResourceLayer = Layer.effect(
            RuntimeResource,
            Effect.acquireRelease(
              Effect.sync(() => {
                let open = true
                const resource: RuntimeResourceShape = {
                  close: () => void (open = false),
                  use: (consumer) =>
                    Effect.sync(() => {
                      if (!open) throw new Error(`runtime resource was finalized before ${consumer} use`)
                      events.push(consumer)
                    }).pipe(
                      Effect.andThen(
                        consumer === 'cycle'
                          ? Deferred.succeed(cycleUsed, undefined)
                          : Deferred.succeed(healthUsed, undefined),
                      ),
                    ),
                }
                return resource
              }),
              (resource) =>
                Effect.sync(() => {
                  resource.close()
                  finalizations += 1
                }),
            ),
          )
          const fiber = yield* runApplication<never, never>(
            autonomousConfig(config),
            fixtureRuntime,
            {
              marketData: marketDataService(Effect.succeed(makeSnapshot())),
              journal: successfulJournal,
              evidenceStore: successfulEvidenceStore,
              cycleObservability,
            },
            {
              _tag: 'AutonomousRead',
              brokerConfiguration: {
                expectedAccountId: brokerAccountId,
                executionEligible: false,
                executionDisabledReason: 'BROKER_ACCESS_READ_ONLY',
              },
              startCycle: () => Effect.succeed(Effect.never),
              resolveAfterStartup: () =>
                Effect.flatMap(Scope.Scope, (scope) =>
                  scopedAcquisition(
                    (attemptScope) =>
                      Layer.buildWithMemoMap(
                        Layer.fresh(runtimeResourceLayer),
                        Layer.makeMemoMapUnsafe(),
                        attemptScope,
                      ).pipe(
                        Effect.map((context) => {
                          const resource = Context.get(context, RuntimeResource)
                          const runtimeBroker = {
                            ...broker,
                            read: {
                              ...broker.read,
                              account: resource.use('health').pipe(Effect.andThen(broker.read.account)),
                            },
                          }
                          return {
                            _tag: 'AutonomousRead' as const,
                            broker: runtimeBroker,
                            startCycle: ({ recordPass }: AutonomousCycleStartupInput) =>
                              resource.use('cycle').pipe(
                                Effect.andThen(Clock.currentTimeMillis),
                                Effect.map(utcInstantFromEpochMillis),
                                Effect.flatMap((observedAt) =>
                                  recordPass({ result: 'SUCCESS', observedAt, outcome: 'NO_PUBLICATION' }),
                                ),
                                Effect.as(Effect.never),
                              ),
                          }
                        }),
                      ),
                    scope,
                  ),
                ),
            },
          ).pipe(Effect.provide(HttpServerLive(config)), Effect.forkScoped)

          yield* Deferred.await(cycleUsed).pipe(Effect.timeout('1 second'))
          expect(finalizations).toBe(0)
          yield* Deferred.await(healthUsed).pipe(Effect.timeout('1 second'))
          expect(finalizations).toBe(0)
          yield* Fiber.interrupt(fiber)
        }),
      ),
    )

    expect(events).toContain('cycle')
    expect(events).toContain('health')
    expect(finalizations).toBe(1)
  })

  test('closes partial runtime acquisition before pending recovery', async () => {
    const acquisitionFailure = new Error('runtime resource acquisition failed')
    let finalizations = 0

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const parentScope = yield* Scope.Scope
          const partialLayer = Layer.effectDiscard(
            Effect.acquireRelease(Effect.void, () => Effect.sync(() => void (finalizations += 1))).pipe(
              Effect.andThen(Effect.fail(acquisitionFailure)),
            ),
          )
          const failure = yield* Effect.flip(
            scopedAcquisition(
              (attemptScope) =>
                Layer.buildWithMemoMap(Layer.fresh(partialLayer), Layer.makeMemoMapUnsafe(), attemptScope),
              parentScope,
            ),
          )

          expect(failure).toBe(acquisitionFailure)
          expect(finalizations).toBe(1)
        }),
      ),
    )

    expect(finalizations).toBe(1)
  })

  test('starts the same scoped autonomous cycle for mutation runtime readiness', async () => {
    let startedQualificationRunId: string | undefined
    let interrupted = false
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const started = yield* Deferred.make<void>()
          const startCycle = ({ qualificationRunId }: AutonomousCycleStartupInput) =>
            Effect.sync(() => void (startedQualificationRunId = qualificationRunId)).pipe(
              Effect.as(
                Deferred.succeed(started, undefined).pipe(
                  Effect.andThen(Effect.never),
                  Effect.onInterrupt(() => Effect.sync(() => void (interrupted = true))),
                ),
              ),
            )
          const fiber = yield* runApplication(
            autonomousConfig(config),
            fixtureRuntime,
            {
              marketData: marketDataService(Effect.succeed(makeSnapshot())),
              journal: successfulJournal,
              evidenceStore: successfulEvidenceStore,
              cycleObservability,
            },
            {
              _tag: 'AutonomousMutation',
              broker: { ...broker, executionEligible: true, executionDisabledReason: null },
              executionProgram: {} as ExecutionProgram,
              startCycle,
            },
          ).pipe(Effect.provide(HttpServerLive(config)), Effect.forkScoped)
          yield* Deferred.await(started).pipe(Effect.timeout('1 second'))
          yield* Fiber.interrupt(fiber)
        }),
      ),
    )

    expect(startedQualificationRunId).toBe(fixtureEvaluation.runId)
    expect(interrupted).toBe(true)
  })

  test('keeps the pinned qualification scope separate from the current decision protocol identity', async () => {
    const currentStrategy = {
      definition: makeRiskBalancedTrendDefinition(fixtureProtocol),
      provenance: makeTestProvenance(fixtureProtocol, { behaviorHash: 'c'.repeat(64) }),
    }

    const currentProtocolHash = makeStrategyProtocolHash(currentStrategy.provenance.strategy)
    expect(currentProtocolHash).not.toBe(pinnedEvaluation.protocolHash)

    let startupQualificationRunId: string | undefined
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const started = yield* Deferred.make<void>()
          const startCycle = ({ qualificationRunId }: AutonomousCycleStartupInput) =>
            pipe(
              Effect.sync(() => void (startupQualificationRunId = qualificationRunId)),
              Effect.as(pipe(Deferred.succeed(started, undefined), Effect.andThen(Effect.never))),
            )
          const fiber = yield* pipe(
            runApplication(
              autonomousConfig(pinnedRuntimeConfig),
              currentStrategy,
              {
                marketData: marketDataService(Effect.die(new Error('pinned startup must not load Signal bars'))),
                journal: successfulJournal,
                evidenceStore: pinnedStore(),
                cycleObservability,
              },
              { _tag: 'AutonomousRead', broker, startCycle },
            ),
            Effect.provide(HttpServerLive(pinnedRuntimeConfig)),
            Effect.forkScoped,
          )
          yield* pipe(Deferred.await(started), Effect.timeout('1 second'))
          yield* Fiber.interrupt(fiber)
        }),
      ),
    )

    expect(startupQualificationRunId).toBe(pinnedEvaluation.runId)
  })
})
