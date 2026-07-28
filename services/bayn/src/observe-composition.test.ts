import { describe, expect, test } from 'bun:test'

import { Cause, Deferred, Effect, Exit, Fiber, Option, Result } from 'effect'
import { TestClock } from 'effect/testing'

import type { AutonomousCycleLoop } from './app'
import { fixtureStrategy } from './app-test-support'
import {
  BrokerRead,
  BrokerReadError,
  BrokerReadErrorKind,
  type BrokerReadShape,
  type MarketCalendarObservation,
  type ReadResult,
} from './broker/alpaca'
import { unusedAssetBySymbol } from './broker/alpaca-test-support'
import {
  CycleState,
  decodeAutonomousCycle,
  makeCycleDraft,
  makeCycleExecutionPolicyFromModel,
  makeCycleIdentity,
  makeCycleWindow,
  makeExecutionCalendarObservation,
} from './cycle'
import { makeStrategyProtocolHash } from './contracts'
import { CycleStore, type CycleStoreShape } from './db/cycle-store'
import {
  BrokerEventStore,
  AuthorityGenerationStore,
  AuthorityRestrictionStore,
  ExecutionStoreError,
  FillAccountingStore,
  ReconciliationStore,
  ValuationStore,
  type BrokerEventStoreShape,
  type AuthorityGenerationStoreShape,
  type AuthorityRestrictionStoreShape,
  type FillAccountingStoreShape,
  type ReconciliationStoreShape,
  type ValuationStoreShape,
} from './db/execution-store'
import { operationalError, type OperationalError } from './errors'
import { WriterFence, WriterFenceError, type WriterFenceService } from './execution/writer-fence'
import { canonicalHashV1 } from './hash'
import { MarketData, type MarketDataService, type MarketDataSnapshot } from './market-data'
import {
  buildObserveCycleDecision,
  loadObserveRiskPolicy,
  makeObserveAutonomousCycleStartup,
  prepareObserveStartup,
} from './observe-composition'
import {
  AccountStatus,
  Authority,
  KillState,
  ReconciliationStatus,
  RiskOutcome,
  type AccountSnapshot,
  type Reconciliation,
} from './paper'
import { ReconciliationError, type ReconciliationPassResult } from './reconciler'
import { reconciledStateHash } from './reconciliation'
import { Reason } from './risk'
import { fixtureProtocol, makeSnapshot } from './test-fixtures'
import type { DecisionPlan, IsoDate } from './types'

const signalDate = '2020-04-30'
const executionDate = '2020-05-01'
const accountId = 'paper-account-1'
const snapshotId = '7'.repeat(64)
const generationHash = 'a'.repeat(64)
const accountingHash = 'b'.repeat(64)
const reconciledAt = '2020-05-01T12:45:01.000Z'
const evaluatedAt = '2020-05-01T12:45:02.000Z'

const calendarMaterial = {
  schemaVersion: 'bayn.alpaca-market-calendar-observation.v1' as const,
  source: 'alpaca-v2-calendar' as const,
  requestedRange: { start: signalDate, end: '2020-05-30' },
  timeZone: 'UTC' as const,
  sessions: [
    {
      date: signalDate,
      openAt: '2020-04-30T13:30:00.000Z',
      closeAt: '2020-04-30T20:00:00.000Z',
    },
    {
      date: executionDate,
      openAt: '2020-05-01T13:30:00.000Z',
      closeAt: '2020-05-01T20:00:00.000Z',
    },
  ],
}

const calendar: MarketCalendarObservation = {
  ...calendarMaterial,
  normalizedResponseHash: canonicalHashV1(calendarMaterial),
}

const executionPolicyResult = makeCycleExecutionPolicyFromModel(fixtureProtocol.executionModel)
expect(Result.isSuccess(executionPolicyResult)).toBe(true)
if (Result.isFailure(executionPolicyResult)) {
  expect.unreachable(executionPolicyResult.failure.message)
}
const executionPolicy = executionPolicyResult.success

const executionCalendarResult = makeExecutionCalendarObservation({
  schemaVersion: calendar.schemaVersion,
  source: calendar.source,
  ...calendar.sessions[1],
})
expect(Result.isSuccess(executionCalendarResult)).toBe(true)
if (Result.isFailure(executionCalendarResult)) {
  expect.unreachable(executionCalendarResult.failure.message)
}
const executionCalendar = executionCalendarResult.success

const identityResult = makeCycleIdentity({
  schemaVersion: 'bayn.autonomous-cycle-identity.v1',
  strategyName: 'risk-balanced-trend',
  qualificationRunId: 'c'.repeat(64),
  strategyProtocolHash: 'd'.repeat(64),
  accountId,
  signalSessionDate: signalDate,
  signalCalendarVersion: 'fixture-calendar-v2',
  executionSessionDate: executionDate,
  executionCalendarSchemaVersion: executionCalendar.executionCalendarSchemaVersion,
  executionCalendarSource: executionCalendar.executionCalendarSource,
  executionCalendarHash: executionCalendar.executionCalendarHash,
  executionPolicy,
})
expect(Result.isSuccess(identityResult)).toBe(true)
if (Result.isFailure(identityResult)) {
  expect.unreachable(identityResult.failure.message)
}
const identity = identityResult.success

const windowResult = makeCycleWindow(
  {
    calendar_version: 'fixture-calendar-v2',
    session_date: signalDate,
    close_time: '16:00',
    timezone: 'America/New_York',
  },
  executionCalendar,
  executionPolicy,
)
expect(Result.isSuccess(windowResult)).toBe(true)
if (Result.isFailure(windowResult)) {
  expect.unreachable(windowResult.failure.message)
}
const window = windowResult.success

const draftResult = makeCycleDraft(identity, window)
expect(Result.isSuccess(draftResult)).toBe(true)
if (Result.isFailure(draftResult)) {
  expect.unreachable(draftResult.failure.message)
}
const draft = draftResult.success
const cycle = Effect.runSync(
  decodeAutonomousCycle({
    ...draft,
    state: CycleState.Active,
    bindings: { snapshotId },
    stateVersion: 3,
    createdAt: '2020-05-01T12:44:00.000Z',
    updatedAt: window.submissionOpenAt,
  }),
)

const sourceSnapshot = makeSnapshot(1_129)
const snapshot: MarketDataSnapshot = {
  bars: sourceSnapshot.bars,
  manifest: {
    ...sourceSnapshot.manifest,
    finalizedSnapshot: {
      ...sourceSnapshot.manifest.finalizedSnapshot,
      snapshotId,
      finalizedAt: '2020-04-30T22:00:00.000Z',
    },
  },
}

const account: AccountSnapshot = {
  schemaVersion: 'bayn.paper-account-snapshot.v1',
  accountId,
  status: AccountStatus.Active,
  currency: 'USD',
  cashMicros: '1000000000',
  equityMicros: '1000000000',
  buyingPowerMicros: '1000000000',
  observedAt: reconciledAt,
}

const reconciliation = (): Reconciliation => {
  const stateHash = Result.getOrThrow(
    reconciledStateHash({
      account,
      positions: [],
      positionsObservedAt: reconciledAt,
      orders: [],
      ordersObservedAt: reconciledAt,
      accountingHash,
    }),
  )
  const material = {
    schemaVersion: 'bayn.paper-reconciliation.v1' as const,
    accountId,
    expectedHash: stateHash,
    observedHash: stateHash,
    status: ReconciliationStatus.Exact,
    discrepancies: [],
    reconciledAt,
  }
  const reconciliationId = canonicalHashV1({
    schemaVersion: 'bayn.paper-reconciliation-id.v1',
    material,
  })
  return {
    ...material,
    reconciliationId,
    contentHash: canonicalHashV1({ ...material, reconciliationId }),
  }
}

const reconciliationResult = (authorityGenerationHash = generationHash): ReconciliationPassResult => {
  const exact = reconciliation()
  return {
    report: {
      reconciliation: exact,
      metrics: {
        brokerPollAgeMs: 0,
        oldestUnknownMutationAgeMs: 0,
        cashDifferenceMicros: '0',
        positionDifferenceMicros: '0',
        equityDifferenceMicros: '0',
        accountingExact: true,
        discrepancyCount: 0,
      },
    },
    brokerState: {
      account,
      positions: [],
      positionsObservedAt: reconciledAt,
      orders: [],
      ordersObservedAt: reconciledAt,
      accountingHash,
      reconciliation: exact,
      unknownOrderCount: 0,
    },
    riskContext: {
      tradingDate: executionDate,
      authority: {
        schemaVersion: 'bayn.paper-authority.v1',
        generationHash: authorityGenerationHash,
        maximum: Authority.Observe,
        effective: Authority.Observe,
        kill: KillState.Clear,
        version: 1,
        updatedAt: window.submissionOpenAt,
      },
      authorityObservedAt: reconciledAt,
      unknownMutationCount: 0,
      dailyTradedNotionalMicros: '0',
      dayStartEquityMicros: account.equityMicros,
      peakEquityMicros: account.equityMicros,
    },
  }
}

const targetWeights = Object.fromEntries(
  fixtureProtocol.universe.map((symbol, index) => [symbol, index === 0 ? 0.5 : 0]),
)
const decision: DecisionPlan = {
  schemaVersion: 'bayn.risk-balanced-trend-decision-plan.v1',
  signalDate,
  covarianceWindow: {
    returnCount: 1,
    firstSession: signalDate,
    lastSession: signalDate,
    sessionsHash: 'e'.repeat(64),
  },
  estimatedAnnualizedPortfolioVolatility: 0.1,
  exposureScale: 1,
  targetWeights,
  signals: fixtureProtocol.universe.map((symbol, index) => ({
    symbol,
    horizons: [{ horizonSessions: 1, return: index === 0 ? 0.1 : 0, normalizedTrend: index === 0 ? 1 : 0 }],
    dailyVolatility: 0.1,
    annualizedVolatility: 0.1,
    compositeScore: index === 0 ? 1 : 0,
    positiveScore: index === 0 ? 1 : 0,
    eligible: true,
    uncappedWeight: index === 0 ? 0.5 : 0,
    cappedWeight: index === 0 ? 0.5 : 0,
    targetWeight: index === 0 ? 0.5 : 0,
  })),
}
const priceMicros = Object.fromEntries(fixtureProtocol.universe.map((symbol) => [symbol, '100000000']))

const marketData = (requests: unknown[]): MarketDataService => ({
  check: Effect.die(new Error('decision building must not run the static snapshot check')),
  inspect: Effect.die(new Error('decision building must not inspect the static snapshot')),
  inspectCyclePublications: Effect.die(new Error('decision building must not discover publications')),
  inspectPublication: () => Effect.die(new Error('decision building must not inspect another publication')),
  inspectSnapshotPublication: () => Effect.die(new Error('decision building must not re-inspect metadata')),
  loadSnapshotPublication: (request) =>
    Effect.sync(() => {
      requests.push(request)
      return snapshot
    }),
  load: Effect.die(new Error('decision building must not load the static qualification snapshot')),
})

const calendarRead =
  (
    queries: unknown[],
  ): ((query: {
    readonly start: string
    readonly end: string
  }) => Effect.Effect<ReadResult<MarketCalendarObservation>>) =>
  (query) =>
    Effect.sync(() => {
      queries.push(query)
      return {
        value: calendar,
        evidence: {
          requestId: 'calendar-request',
          status: 200,
          contentHash: 'f'.repeat(64),
          observedAt: reconciledAt,
        },
      }
    })

const decisionBrokerRead = (marketCalendar: BrokerReadShape['marketCalendar']): BrokerReadShape => {
  const unused = Effect.die(new Error('decision building must not use unrelated broker reads'))
  return {
    account: unused,
    accountConfiguration: unused,
    assetBySymbol: unusedAssetBySymbol,
    positions: unused,
    orders: () => unused,
    orderById: () => unused,
    orderByClientId: () => unused,
    fillActivities: () => unused,
    marketCalendar,
  }
}

const provideDecisionServices = <A, E>(
  program: Effect.Effect<A, E, BrokerRead | MarketData>,
  marketDataService: MarketDataService,
  marketCalendar: BrokerReadShape['marketCalendar'],
): Effect.Effect<A, E> =>
  program.pipe(
    Effect.provideService(BrokerRead, decisionBrokerRead(marketCalendar)),
    Effect.provideService(MarketData, marketDataService),
  )

describe('OBSERVE runtime composition', () => {
  test('derives the autonomous cycle protocol identity from the current strategy provenance', () => {
    const prepared = prepareObserveStartup({
      accountId,
      authorityGenerationHash: generationHash,
      pollIntervalMs: 30_000,
      strategy: fixtureStrategy,
    })

    expect(Result.isSuccess(prepared)).toBe(true)
    if (Result.isSuccess(prepared)) {
      expect(prepared.success.strategyProtocolHash).toBe(makeStrategyProtocolHash(fixtureStrategy.provenance.strategy))
    }
  })

  test('decodes the bounded source policy with the configured account and canonical universe', async () => {
    const policy = await Effect.runPromise(loadObserveRiskPolicy(accountId, [...fixtureProtocol.universe].reverse()))

    expect(policy).toMatchObject({
      accountId,
      allowedSymbols: fixtureProtocol.universe,
      maxOrderNotionalMicros: '600000000',
      maxGrossExposureMicros: '1000000000',
      maxUnresolvedOrders: 0,
    })
  })

  test('builds one exact cycle-bound non-dispatchable decision from same-pass inputs', async () => {
    const snapshotRequests: unknown[] = []
    const calendarQueries: unknown[] = []
    let strategyCalls = 0
    const policy = await Effect.runPromise(loadObserveRiskPolicy(accountId, fixtureProtocol.universe))
    const program = Effect.gen(function* () {
      yield* TestClock.setTime(Date.parse(evaluatedAt))
      return yield* buildObserveCycleDecision({
        authorityGenerationHash: generationHash,
        cycle,
        executionModel: fixtureProtocol.executionModel,
        policy,
        reconcile: Effect.succeed(reconciliationResult()),
        strategy: {
          currentDecision: (_bars, _manifest, binding) => {
            strategyCalls += 1
            expect(binding.signal.sessionDate).toBe(signalDate)
            expect(binding.executionSession.date).toBe(executionDate)
            expect(binding.submissionOpenAt).toBe(reconciledAt)
            return Result.succeed({ decision, priceMicros })
          },
        },
      })
    }).pipe(
      (program) => provideDecisionServices(program, marketData(snapshotRequests), calendarRead(calendarQueries)),
      Effect.provide(TestClock.layer()),
    )

    const document = await Effect.runPromise(program)

    expect(snapshotRequests).toEqual([
      {
        snapshotId,
        signalSessionDate: signalDate,
        signalCalendarVersion: 'fixture-calendar-v2',
      },
    ])
    expect(calendarQueries).toEqual([{ start: signalDate, end: '2020-05-30' }])
    expect(strategyCalls).toBe(1)
    expect(document).toMatchObject({
      mode: 'OBSERVE',
      dispatchable: false,
      bindings: {
        cycleId: cycle.identity.cycleId,
        snapshotId,
        accountId,
      },
      targetPlan: {
        status: 'PLANNED',
        intentTargets: [{ symbol: fixtureProtocol.universe[0], side: 'BUY', quantityMicros: '5000000' }],
      },
      deltaRisk: [
        {
          evaluation: {
            decision: {
              outcome: RiskOutcome.Blocked,
              reasonCodes: [Reason.AuthorityNotPaper],
            },
          },
        },
      ],
      createdAt: evaluatedAt,
      expiresAt: cycle.window.submissionCutoffAt,
    })
  })

  test('fails closed when same-pass reconciliation observes another authority generation', async () => {
    const policy = await Effect.runPromise(loadObserveRiskPolicy(accountId, fixtureProtocol.universe))
    let strategyCalls = 0
    const failure = await Effect.runPromise(
      Effect.flip(
        Effect.gen(function* () {
          yield* TestClock.setTime(Date.parse(evaluatedAt))
          return yield* buildObserveCycleDecision({
            authorityGenerationHash: generationHash,
            cycle,
            executionModel: fixtureProtocol.executionModel,
            policy,
            reconcile: Effect.succeed(reconciliationResult('9'.repeat(64))),
            strategy: {
              currentDecision: () => {
                strategyCalls += 1
                return Result.succeed({ decision, priceMicros })
              },
            },
          })
        }).pipe(
          (program) => provideDecisionServices(program, marketData([]), calendarRead([])),
          Effect.provide(TestClock.layer()),
        ),
      ),
    )

    expect(failure).toEqual({
      _tag: 'ObserveDecisionCompositionFailure',
      operation: 'observe-authority',
      message: 'same-pass reconciliation did not return the configured OBSERVE authority',
      cause: undefined,
    })
    expect(strategyCalls).toBe(0)
  })

  test('maps an expected strategy decision failure into the typed operational channel', async () => {
    const policy = await Effect.runPromise(loadObserveRiskPolicy(accountId, fixtureProtocol.universe))
    const strategyFailure = {
      _tag: 'CurrentDecisionCoverageMismatch' as const,
      signalDate: signalDate as IsoDate,
      expectedSymbols: fixtureProtocol.universe,
      observedSymbols: [],
    }
    const failure = await Effect.runPromise(
      Effect.flip(
        Effect.gen(function* () {
          yield* TestClock.setTime(Date.parse(evaluatedAt))
          return yield* buildObserveCycleDecision({
            authorityGenerationHash: generationHash,
            cycle,
            executionModel: fixtureProtocol.executionModel,
            policy,
            reconcile: Effect.succeed(reconciliationResult()),
            strategy: { currentDecision: () => Result.fail(strategyFailure) },
          })
        }).pipe(
          (program) => provideDecisionServices(program, marketData([]), calendarRead([])),
          Effect.provide(TestClock.layer()),
        ),
      ),
    )

    expect(failure._tag).toBe('OperationalError')
    if (failure._tag === 'OperationalError') {
      expect(failure.component).toBe('strategy')
      expect(failure.operation).toBe('current-decision')
      expect(failure.message).toStartWith('current strategy decision compilation failed')
      expect(failure.cause).toBe(strategyFailure)
    }
  })

  test('preserves a thrown strategy decision bug as the identical Effect defect', async () => {
    const policy = await Effect.runPromise(loadObserveRiskPolicy(accountId, fixtureProtocol.universe))
    const defect = new Error('unexpected current-decision defect')
    const exit = await Effect.runPromiseExit(
      Effect.gen(function* () {
        yield* TestClock.setTime(Date.parse(evaluatedAt))
        return yield* buildObserveCycleDecision({
          authorityGenerationHash: generationHash,
          cycle,
          executionModel: fixtureProtocol.executionModel,
          policy,
          reconcile: Effect.succeed(reconciliationResult()),
          strategy: {
            currentDecision: () => {
              throw defect
            },
          },
        })
      }).pipe(
        (program) => provideDecisionServices(program, marketData([]), calendarRead([])),
        Effect.provide(TestClock.layer()),
      ),
    )

    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit)) {
      const defects = exit.cause.reasons.flatMap((reason) => (Cause.isDieReason(reason) ? [reason.defect] : []))
      expect(defects).toContain(defect)
    }
  })

  test('closes read and reconciliation failures with their operational classifications and exact causes', async () => {
    const policy = await Effect.runPromise(loadObserveRiskPolicy(accountId, fixtureProtocol.universe))
    const snapshotCause = operationalError('market-data', 'load', 'snapshot fixture failed')
    const calendarRootCause = { _tag: 'CalendarTransportFixtureFailure' }
    const calendarCause = new BrokerReadError({
      operation: 'market-calendar',
      kind: BrokerReadErrorKind.Transport,
      message: 'calendar fixture failed',
      retryable: true,
      cause: calendarRootCause,
    })
    const reconciliationReadCause = new BrokerReadError({
      operation: 'orders',
      kind: BrokerReadErrorKind.Transport,
      message: 'reconciliation broker read fixture failed',
      retryable: true,
    })
    const reconciliationStoreCause = new ExecutionStoreError({
      operation: 'reconciliation',
      failure: 'query',
      message: 'reconciliation store fixture failed',
    })
    const reconciliationFenceCause = new WriterFenceError({
      operation: 'transaction',
      failure: 'unavailable',
      message: 'reconciliation fence fixture failed',
    })
    const reconciliationDomainCause = new ReconciliationError({
      operation: 'snapshot',
      message: 'reconciliation snapshot fixture failed',
    })
    const cases = [
      {
        expectedComponent: 'market-data',
        expectedOperation: 'load-snapshot-publication',
        cause: snapshotCause,
        marketData: {
          ...marketData([]),
          loadSnapshotPublication: () => Effect.fail(snapshotCause),
        },
        marketCalendar: calendarRead([]),
        reconcile: Effect.succeed(reconciliationResult()),
      },
      {
        expectedComponent: 'market-data',
        expectedOperation: 'market-calendar',
        cause: calendarCause,
        marketData: marketData([]),
        marketCalendar: () => Effect.fail(calendarCause),
        reconcile: Effect.succeed(reconciliationResult()),
      },
      {
        expectedComponent: 'market-data',
        expectedOperation: 'reconciliation',
        cause: reconciliationReadCause,
        marketData: marketData([]),
        marketCalendar: calendarRead([]),
        reconcile: Effect.fail(reconciliationReadCause),
      },
      {
        expectedComponent: 'database',
        expectedOperation: 'reconciliation',
        cause: reconciliationStoreCause,
        marketData: marketData([]),
        marketCalendar: calendarRead([]),
        reconcile: Effect.fail(reconciliationStoreCause),
      },
      {
        expectedComponent: 'database',
        expectedOperation: 'reconciliation',
        cause: reconciliationFenceCause,
        marketData: marketData([]),
        marketCalendar: calendarRead([]),
        reconcile: Effect.fail(reconciliationFenceCause),
      },
      {
        expectedComponent: 'strategy',
        expectedOperation: 'reconciliation',
        cause: reconciliationDomainCause,
        marketData: marketData([]),
        marketCalendar: calendarRead([]),
        reconcile: Effect.fail(reconciliationDomainCause),
      },
    ] as const

    for (const testCase of cases) {
      const failure = await Effect.runPromise(
        Effect.flip(
          buildObserveCycleDecision({
            authorityGenerationHash: generationHash,
            cycle,
            executionModel: fixtureProtocol.executionModel,
            policy,
            reconcile: testCase.reconcile,
            strategy: { currentDecision: () => Result.succeed({ decision, priceMicros }) },
          }).pipe((program) => provideDecisionServices(program, testCase.marketData, testCase.marketCalendar)),
        ),
      )

      expect(failure._tag).toBe('OperationalError')
      if (failure._tag !== 'OperationalError') return expect.unreachable(failure._tag)
      expect(failure.component).toBe(testCase.expectedComponent)
      expect(failure.operation).toBe(testCase.expectedOperation)
      expect(failure.cause).toBe(testCase.cause)
    }
  })

  test('keeps startup and long-lived loop requirements explicit at separate composition boundaries', async () => {
    const unused = Effect.die(new Error('missing-publication loop must not use this capability'))
    const authority = reconciliationResult().riskContext.authority
    if (authority === null) return expect.unreachable('fixture authority is required')
    type TestStore = BrokerEventStoreShape &
      FillAccountingStoreShape &
      ValuationStoreShape &
      ReconciliationStoreShape &
      AuthorityGenerationStoreShape &
      AuthorityRestrictionStoreShape
    const executionStore: TestStore = {
      ingest: () => unused,
      ingestPositions: () => unused,
      account: () => unused,
      value: () => unused,
      hasAccountBaseline: () => unused,
      bindings: () => unused,
      reconcile: () => unused,
      ensureAuthorityGeneration: () => Effect.succeed(authority),
      restrictAuthority: () => unused,
    }
    const cycleStore: CycleStoreShape = {
      acquire: () => unused,
      read: () => unused,
      readAuthoritySlot: () => unused,
      readDecisionDocument: () => unused,
      readOldestUnfinished: () => Effect.succeed(Option.none()),
      bindSnapshot: () => unused,
      activate: () => unused,
      bindDecision: () => unused,
      finish: () => unused,
      block: () => unused,
    }
    const brokerRead: BrokerReadShape = {
      account: unused,
      accountConfiguration: unused,
      assetBySymbol: unusedAssetBySymbol,
      positions: unused,
      orders: () => unused,
      orderById: () => unused,
      orderByClientId: () => unused,
      fillActivities: () => unused,
      marketCalendar: () => unused,
    }
    const marketDataService: MarketDataService = {
      ...marketData([]),
      inspectCyclePublications: Effect.succeed({
        outcome: 'MISSING',
        observedAt: '2026-01-30T21:20:00.000Z',
      }),
    }
    const writerFence: WriterFenceService = {
      backendPid: 1,
      check: unused,
      transaction: (effect) => effect,
    }
    const startup = makeObserveAutonomousCycleStartup({
      accountId,
      authorityGenerationHash: generationHash,
      pollIntervalMs: 30_000,
      strategy: fixtureStrategy,
    })

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const pass = yield* Deferred.make<Parameters<Parameters<typeof startup>[0]['recordPass']>[0]>()
          const acquireLoop: Effect.Effect<
            AutonomousCycleLoop<
              | BrokerRead
              | CycleStore
              | MarketData
              | BrokerEventStore
              | FillAccountingStore
              | ValuationStore
              | ReconciliationStore
              | AuthorityGenerationStore
              | AuthorityRestrictionStore
              | WriterFence
            >,
            OperationalError,
            AuthorityGenerationStore
          > = startup({
            qualificationRunId: 'c'.repeat(64),
            recordPass: (observation) => Deferred.succeed(pass, observation).pipe(Effect.asVoid),
          })
          const loop = yield* acquireLoop.pipe(Effect.provideService(AuthorityGenerationStore, executionStore))
          const fiber = yield* loop.pipe(
            Effect.provideService(BrokerRead, brokerRead),
            Effect.provideService(CycleStore, cycleStore),
            Effect.provideService(MarketData, marketDataService),
            Effect.provideService(BrokerEventStore, executionStore),
            Effect.provideService(FillAccountingStore, executionStore),
            Effect.provideService(ValuationStore, executionStore),
            Effect.provideService(ReconciliationStore, executionStore),
            Effect.provideService(AuthorityGenerationStore, executionStore),
            Effect.provideService(AuthorityRestrictionStore, executionStore),
            Effect.provideService(WriterFence, writerFence),
            Effect.forkScoped,
          )
          const observation = yield* Deferred.await(pass).pipe(Effect.timeout('1 second'))
          expect(observation).toMatchObject({
            result: 'SUCCESS',
            outcome: 'NO_PUBLICATION',
          })
          yield* Fiber.interrupt(fiber)
        }),
      ),
    )
  })

  test('keeps the observe startup interface read-only by construction', () => {
    const startup = makeObserveAutonomousCycleStartup({
      accountId,
      authorityGenerationHash: generationHash,
      pollIntervalMs: 30_000,
      strategy: fixtureStrategy,
    })

    expect(typeof startup).toBe('function')
  })
})
