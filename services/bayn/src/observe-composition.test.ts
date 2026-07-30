import { describe, expect, test } from 'bun:test'

import { Cause, Deferred, Effect, Exit, Fiber, Option, Result } from 'effect'
import { TestClock } from 'effect/testing'

import type { AutonomousCycleLoop } from './app'
import { fixtureStrategy } from './app-test-support'
import {
  AccountStatus as BrokerAccountStatus,
  BrokerRead,
  BrokerReadError,
  BrokerReadErrorKind,
  type Account as BrokerAccount,
  type BrokerReadShape,
  type MarketCalendarObservation,
  type ReadEvidence,
  type ReadResult,
} from './broker/alpaca'
import { unusedAssetBySymbol } from './broker/alpaca-test-support'
import { MutationOperation } from './broker/alpaca-mutations'
import { BrokerEnvironment, BrokerProvider, makeBrokerIdentity } from './broker/identity'
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
import type { BrokerSnapshot, ReconciliationWriteResult } from './db/reconciliation'
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
import { BrokerAccess, makeExecutionAuthority, sandboxCapitalAuthority } from './execution/authority'
import { IntentStore, type IntentStoreService } from './execution/intents'
import { MutationEventType, MutationStore, type MutationEvent, type MutationStoreShape } from './execution/mutations'
import type { ExecutionProgram } from './execution/runtime-program'
import { WriterFence, WriterFenceError, type WriterFenceService } from './execution/writer-fence'
import { canonicalHashV1 } from './hash'
import { MarketData, type MarketDataService, type MarketDataSnapshot } from './market-data'
import {
  buildMutationShadowCycleDecision,
  buildObserveCycleDecision,
  appendPendingMutationOrder,
  decidePreparedMutationIntent,
  decideMutationIntentSettlement,
  executeMutationIntent,
  mutationIntentReconciliationDelayMs,
  projectWorstCasePendingMutationPosition,
  loadObserveRiskPolicy,
  makeMutationAutonomousCycleStartup,
  makeObserveAutonomousCycleStartup,
  prepareObserveStartup,
} from './observe-composition'
import {
  AccountStatus,
  Authority,
  IntentState,
  KillState,
  OrderSide,
  OrderStatus,
  OrderType,
  ReconciliationStatus,
  RiskOutcome,
  TerminalOutcome,
  TimeInForce,
  type AccountSnapshot,
  type Intent,
  type Position,
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

const reconciliationResult = (
  authorityGenerationHash = generationHash,
  maximum: Authority = Authority.Observe,
): ReconciliationPassResult => {
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
        maximum,
        effective: maximum,
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

const sandboxExecutionProgram = (
  authorityGenerationHash = generationHash,
  strategy = fixtureStrategy.provenance.strategy,
): ExecutionProgram => {
  const brokerIdentity = Result.getOrThrow(
    makeBrokerIdentity({
      schemaVersion: 'bayn.broker-identity.v2',
      provider: BrokerProvider.Alpaca,
      environment: BrokerEnvironment.Sandbox,
      accountId,
    }),
  )
  const authority = Result.getOrThrow(
    makeExecutionAuthority({
      brokerIdentity,
      brokerAccess: BrokerAccess.Mutation,
      capitalAuthority: sandboxCapitalAuthority(authorityGenerationHash),
      strategy,
      observedAt: evaluatedAt,
    }),
  ) as ExecutionProgram['authority']
  const unused = Effect.die(new Error('execution program operation must not run during startup validation'))
  return {
    _tag: 'ExecutionProgram',
    schemaVersion: 'bayn.execution-program.v1',
    authority,
    dryRunSubmit: () => unused,
    submit: () => unused,
    cancel: () => unused,
    recover: () => unused,
  }
}

describe('OBSERVE runtime composition', () => {
  test('projects accepted nonterminal intents as one unresolved order for the next risk pass', () => {
    const intent: Intent = {
      schemaVersion: 'bayn.paper-intent.v3',
      intentId: '1'.repeat(64),
      authorityGenerationHash: generationHash,
      riskDecisionId: '2'.repeat(64),
      strategyName: 'risk-balanced-trend',
      cycleId: '3'.repeat(64),
      decisionHash: '4'.repeat(64),
      policyHash: '5'.repeat(64),
      accountId,
      clientOrderId: 'accepted-prior-intent',
      symbol: 'NVDA',
      side: OrderSide.Buy,
      orderType: OrderType.Market,
      timeInForce: TimeInForce.Day,
      quantityMicros: '1000000',
      notionalLimitMicros: '100000000',
      state: IntentState.Acknowledged,
      createdAt: evaluatedAt,
    }
    const accepted: MutationEvent = {
      schemaVersion: 'bayn.paper-mutation-event.v1',
      eventId: '6'.repeat(64),
      mutationId: '7'.repeat(64),
      intentId: intent.intentId,
      sequence: 2,
      operation: MutationOperation.Submit,
      eventType: MutationEventType.SubmitAccepted,
      requestHash: '8'.repeat(64),
      consistencyDelayMs: 1_000,
      brokerOrderId: 'accepted-broker-order',
      occurredAt: evaluatedAt,
    }

    const decision = Result.getOrThrow(decidePreparedMutationIntent(intent, accepted))
    expect(decision._tag).toBe('Pending')
    if (decision._tag !== 'Pending') return expect.unreachable(decision._tag)
    expect(decision.order).toMatchObject({
      brokerOrderId: accepted.brokerOrderId,
      clientOrderId: intent.clientOrderId,
      intentId: intent.intentId,
      status: OrderStatus.New,
      filledQuantityMicros: '0',
    })
    const projected = appendPendingMutationOrder([], decision.order)
    expect(projected).toEqual([decision.order])
    expect(appendPendingMutationOrder(projected, decision.order)).toBe(projected)
  })

  test('executes unsubmitted intents and skips terminal intents in fresh mutation passes', () => {
    const base: Intent = {
      schemaVersion: 'bayn.paper-intent.v3',
      intentId: '9'.repeat(64),
      authorityGenerationHash: generationHash,
      strategyName: 'risk-balanced-trend',
      cycleId: 'a'.repeat(64),
      decisionHash: 'b'.repeat(64),
      policyHash: 'c'.repeat(64),
      accountId,
      clientOrderId: 'fresh-pass-intent',
      symbol: 'AMD',
      side: OrderSide.Buy,
      orderType: OrderType.Market,
      timeInForce: TimeInForce.Day,
      quantityMicros: '1000000',
      notionalLimitMicros: '100000000',
      state: IntentState.Planned,
      createdAt: evaluatedAt,
    }

    expect(Result.getOrThrow(decidePreparedMutationIntent(base, undefined))).toEqual({ _tag: 'Execute' })
    expect(
      Result.getOrThrow(
        decidePreparedMutationIntent(
          { ...base, state: IntentState.Terminal, terminalOutcome: TerminalOutcome.Filled },
          undefined,
        ),
      ),
    ).toEqual({ _tag: 'SkipTerminal' })
  })

  test('retains an unfilled sell while reserving a later buy in projected risk positions', () => {
    const observedAt = '2026-07-28T13:45:00.000Z'
    const existing: Position = {
      schemaVersion: 'bayn.paper-position.v1',
      accountId,
      symbol: 'AAPL',
      quantityMicros: '100000000',
      averageEntryPriceMicros: '100000000',
      marketPriceMicros: '100000000',
      marketValueMicros: '10000000000',
      unrealizedPnlMicros: '0',
      observedAt,
    }
    const afterSell = projectWorstCasePendingMutationPosition(
      [existing],
      {
        symbol: 'AAPL',
        targetWeight: 0.2,
        referencePriceMicros: '100000000',
        currentQuantityMicros: '100000000',
        targetQuantityMicros: '20000000',
      },
      accountId,
      observedAt,
    )
    const afterLaterBuy = projectWorstCasePendingMutationPosition(
      afterSell,
      {
        symbol: 'AMD',
        targetWeight: 0.6,
        referencePriceMicros: '50000000',
        currentQuantityMicros: '0',
        targetQuantityMicros: '60000000',
      },
      accountId,
      observedAt,
    )

    expect(afterSell).toEqual([existing])
    expect(afterLaterBuy.map(({ symbol, quantityMicros }) => ({ symbol, quantityMicros }))).toEqual([
      { symbol: 'AAPL', quantityMicros: '100000000' },
      { symbol: 'AMD', quantityMicros: '60000000' },
    ])
  })

  test('settles terminal submit denials and broker rejections so later cycles can continue', () => {
    expect(decideMutationIntentSettlement(MutationEventType.SubmitRejected)).toEqual({
      _tag: 'Settled',
      outcome: 'rejected',
    })

    expect(decideMutationIntentSettlement(MutationEventType.SubmitDenied)).toEqual({
      _tag: 'Settled',
      outcome: 'denied',
    })
    expect(decideMutationIntentSettlement(MutationEventType.SubmitUnknown)).toEqual({
      _tag: 'Unresolved',
      eventType: MutationEventType.SubmitUnknown,
    })
  })

  test('waits the durable consistency window only after accepted submit settlement', () => {
    expect(
      mutationIntentReconciliationDelayMs({
        settlement: { _tag: 'Settled', outcome: 'accepted' },
        consistencyDelayMs: 1_250,
      }),
    ).toBe(1_250)
    expect(
      mutationIntentReconciliationDelayMs({
        settlement: { _tag: 'Settled', outcome: 'rejected' },
        consistencyDelayMs: 1_250,
      }),
    ).toBe(0)
  })

  test('replays a terminal rejection without resubmission and executes the later-cycle intent', async () => {
    const rejectedIntentId = 'a'.repeat(64)
    const laterIntentId = 'b'.repeat(64)
    const event = (intentId: string, eventType: MutationEventType) => ({
      schemaVersion: 'bayn.paper-mutation-event.v1' as const,
      eventId: canonicalHashV1({ intentId, eventType }),
      mutationId: canonicalHashV1({ intentId, operation: 'SUBMIT' }),
      intentId,
      sequence: 2,
      operation: MutationOperation.Submit,
      eventType,
      requestHash: '1'.repeat(64),
      consistencyDelayMs: 1_000,
      occurredAt: evaluatedAt,
    })
    const rejected = event(rejectedIntentId, MutationEventType.SubmitRejected)
    const accepted = event(laterIntentId, MutationEventType.SubmitAccepted)
    const submitted: string[] = []
    let recoveries = 0
    const program: ExecutionProgram = {
      ...sandboxExecutionProgram(),
      submit: (intentId) =>
        Effect.sync(() => {
          submitted.push(intentId)
          return accepted
        }),
      recover: () =>
        Effect.sync(() => {
          recoveries += 1
          return accepted
        }),
    }
    const store = {
      latest: (intentId: string) => Effect.succeed(intentId === rejectedIntentId ? rejected : undefined),
    } as unknown as MutationStoreShape

    await Effect.runPromise(
      Effect.forEach([rejectedIntentId, laterIntentId], (intentId) => executeMutationIntent(program, intentId), {
        concurrency: 1,
        discard: true,
      }).pipe(Effect.provideService(MutationStore, store)),
    )

    expect(submitted).toEqual([laterIntentId])
    expect(recoveries).toBe(0)
  })

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

  test('builds the durable non-dispatchable shadow plan from an exact PAPER authority without requiring OBSERVE', async () => {
    const policy = await Effect.runPromise(loadObserveRiskPolicy(accountId, fixtureProtocol.universe))
    const program = Effect.gen(function* () {
      yield* TestClock.setTime(Date.parse(evaluatedAt))
      return yield* buildMutationShadowCycleDecision({
        authorityGenerationHash: generationHash,
        cycle,
        executionModel: fixtureProtocol.executionModel,
        policy,
        reconcile: Effect.succeed(reconciliationResult(generationHash, Authority.Paper)),
        strategy: { currentDecision: () => Result.succeed({ decision, priceMicros }) },
      })
    }).pipe(
      (program) => provideDecisionServices(program, marketData([]), calendarRead([])),
      Effect.provide(TestClock.layer()),
    )

    const document = await Effect.runPromise(program)

    expect(document).toMatchObject({
      mode: 'OBSERVE',
      dispatchable: false,
      bindings: { accountId, cycleId: cycle.identity.cycleId },
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

  test('persists one writer-fenced reconciliation before reporting a NOT_DUE OBSERVE pass', async () => {
    const signalSessionDate: IsoDate = '2020-04-29'
    const calendarMaterial = {
      schemaVersion: 'bayn.alpaca-market-calendar-observation.v1' as const,
      source: 'alpaca-v2-calendar' as const,
      requestedRange: { start: signalSessionDate, end: '2020-05-29' },
      timeZone: 'UTC' as const,
      sessions: [
        {
          date: signalSessionDate,
          openAt: '2020-04-29T13:30:00.000Z',
          closeAt: '2020-04-29T20:00:00.000Z',
        },
        {
          date: signalDate,
          openAt: '2020-04-30T13:30:00.000Z',
          closeAt: '2020-04-30T20:00:00.000Z',
        },
      ],
    }
    const ordinaryCalendar: MarketCalendarObservation = {
      ...calendarMaterial,
      normalizedResponseHash: canonicalHashV1(calendarMaterial),
    }
    const readEvidence = (identity: string): ReadEvidence => ({
      requestId: `not-due-${identity}`,
      status: 200,
      contentHash: canonicalHashV1({ identity }),
      observedAt: reconciledAt,
    })
    const brokerAccount: BrokerAccount = {
      id: accountId,
      status: BrokerAccountStatus.Active,
      currency: 'USD',
      cashMicros: account.cashMicros,
      equityMicros: account.equityMicros,
      lastEquityMicros: account.equityMicros,
      buyingPowerMicros: account.buyingPowerMicros,
      accountBlocked: false,
      tradingBlocked: false,
      tradeSuspendedByUser: false,
      observedAt: reconciledAt,
    }
    let accountReads = 0
    let positionReads = 0
    let orderReads = 0
    let fillReads = 0
    const unusedRead = Effect.die(new Error('NOT_DUE reconciliation used an unrelated broker read'))
    const brokerRead: BrokerReadShape = {
      account: Effect.sync(() => {
        accountReads += 1
        return { value: brokerAccount, evidence: readEvidence('account') }
      }),
      accountConfiguration: unusedRead,
      assetBySymbol: unusedAssetBySymbol,
      positions: Effect.sync(() => {
        positionReads += 1
        return { value: [], evidence: readEvidence('positions') }
      }),
      orders: () =>
        Effect.sync(() => {
          orderReads += 1
          return { value: [], evidence: readEvidence(`orders-${orderReads}`) }
        }),
      orderById: () => unusedRead,
      orderByClientId: () => unusedRead,
      fillActivities: () =>
        Effect.sync(() => {
          fillReads += 1
          return { value: { items: [] }, evidence: readEvidence(`fills-${fillReads}`) }
        }),
      marketCalendar: (query) => {
        expect(query).toEqual(calendarMaterial.requestedRange)
        return Effect.succeed({ value: ordinaryCalendar, evidence: readEvidence('calendar') })
      },
    }
    const inspection = {
      manifest: snapshot.manifest,
      sessionDates: [signalSessionDate],
      signalSession: {
        calendar_version: 'fixture-calendar-v2',
        session_date: signalSessionDate,
        close_time: '16:00',
        timezone: 'America/New_York' as const,
      },
    }
    const marketDataService: MarketDataService = {
      ...marketData([]),
      inspectCyclePublications: Effect.succeed({
        outcome: 'FINALIZED',
        observedAt: '2020-04-29T22:00:00.000Z',
        publications: [inspection],
      }),
    }
    let acquisitions = 0
    const unusedCycleStore = Effect.die(new Error('NOT_DUE pass attempted to mutate cycle state'))
    const cycleStore: CycleStoreShape = {
      acquire: () => {
        acquisitions += 1
        return unusedCycleStore
      },
      read: () => unusedCycleStore,
      readAuthoritySlot: () => Effect.succeed(Option.none()),
      readDecisionDocument: () => unusedCycleStore,
      readOldestUnfinished: () => Effect.succeed(Option.none()),
      bindSnapshot: () => unusedCycleStore,
      activate: () => unusedCycleStore,
      bindDecision: () => unusedCycleStore,
      finish: () => unusedCycleStore,
      block: () => unusedCycleStore,
    }
    const exact = reconciliationResult()
    const persisted: ReconciliationWriteResult = {
      reconciliation: exact.report.reconciliation,
      metrics: exact.report.metrics,
      accountingHash: exact.brokerState.accountingHash,
      riskContext: exact.riskContext,
    }
    const reconciledSnapshots: BrokerSnapshot[] = []
    let brokerEventWrites = 0
    let positionWrites = 0
    let valuationWrites = 0
    let authorityRestrictions = 0
    const unusedAccounting = Effect.die(new Error('empty NOT_DUE reconciliation must not account a fill'))
    const executionStore = {
      ingest: () =>
        Effect.sync(() => {
          brokerEventWrites += 1
          return { eventId: '1'.repeat(64), sourceSequence: '1', deduplicated: false }
        }),
      ingestPositions: () =>
        Effect.sync(() => {
          positionWrites += 1
          return { snapshotId: '2'.repeat(64), eventIds: [], deduplicated: false }
        }),
      account: () => unusedAccounting,
      value: () =>
        Effect.sync(() => {
          valuationWrites += 1
          return {
            schemaVersion: 'bayn.paper-valuation.v1' as const,
            valuationId: '3'.repeat(64),
            accountId,
            sourceHash: '4'.repeat(64),
            cashMicros: account.cashMicros,
            longMarketValueMicros: '0',
            shortMarketValueMicros: '0',
            equityMicros: account.equityMicros,
            asOf: reconciledAt,
          }
        }),
      hasAccountBaseline: () => Effect.succeed(true),
      bindings: () => Effect.succeed([]),
      reconcile: (brokerSnapshot: BrokerSnapshot) =>
        Effect.sync(() => {
          reconciledSnapshots.push(brokerSnapshot)
          return persisted
        }),
      ensureAuthorityGeneration: () => {
        const authority = exact.riskContext.authority
        return authority === null
          ? Effect.die(new Error('NOT_DUE fixture requires OBSERVE authority'))
          : Effect.succeed(authority)
      },
      restrictAuthority: () =>
        Effect.sync(() => {
          authorityRestrictions += 1
        }),
    } satisfies BrokerEventStoreShape &
      FillAccountingStoreShape &
      ValuationStoreShape &
      ReconciliationStoreShape &
      AuthorityGenerationStoreShape &
      AuthorityRestrictionStoreShape
    let fencedTransactions = 0
    const writerFence: WriterFenceService = {
      backendPid: 1,
      check: Effect.void,
      transaction: (effect) =>
        Effect.sync(() => {
          fencedTransactions += 1
        }).pipe(Effect.andThen(effect)),
    }
    const startup = makeObserveAutonomousCycleStartup({
      accountId,
      authorityGenerationHash: generationHash,
      pollIntervalMs: 30_000,
      strategy: fixtureStrategy,
    })

    const observation = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          yield* TestClock.setTime(Date.parse(reconciledAt))
          const pass = yield* Deferred.make<Parameters<Parameters<typeof startup>[0]['recordPass']>[0]>()
          const loop = yield* startup({
            qualificationRunId: 'c'.repeat(64),
            recordPass: (result) => Deferred.succeed(pass, result).pipe(Effect.asVoid),
          }).pipe(Effect.provideService(AuthorityGenerationStore, executionStore))
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
            Effect.forkScoped({ startImmediately: true }),
          )
          const result = yield* Deferred.await(pass).pipe(Effect.timeout('1 second'))
          yield* Fiber.interrupt(fiber)
          return result
        }),
      ).pipe(Effect.provide(TestClock.layer())),
    )

    expect(observation).toMatchObject({ result: 'SUCCESS', outcome: 'NOT_DUE' })
    expect(acquisitions).toBe(0)
    expect(accountReads).toBe(1)
    expect(positionReads).toBe(1)
    expect(orderReads).toBe(2)
    expect(fillReads).toBe(2)
    expect(brokerEventWrites).toBe(1)
    expect(positionWrites).toBe(1)
    expect(valuationWrites).toBe(1)
    expect(reconciledSnapshots).toHaveLength(1)
    expect(reconciledSnapshots[0]).toMatchObject({
      account,
      positions: [],
      orders: [],
      fills: [],
      reconciledAt,
    })
    expect(fencedTransactions).toBe(1)
    expect(authorityRestrictions).toBe(0)
  })

  test('starts mutation mode without projecting or initializing OBSERVE authority', async () => {
    const unused = Effect.die(new Error('missing-publication mutation loop must not use this capability'))
    let authorityInitializations = 0
    const executionStore = {
      ingest: () => unused,
      ingestPositions: () => unused,
      account: () => unused,
      value: () => unused,
      hasAccountBaseline: () => unused,
      bindings: () => unused,
      reconcile: () => unused,
      ensureAuthorityGeneration: () =>
        Effect.sync(() => {
          authorityInitializations += 1
          throw new Error('mutation startup must not initialize OBSERVE authority')
        }),
      restrictAuthority: () => unused,
    } satisfies BrokerEventStoreShape &
      FillAccountingStoreShape &
      ValuationStoreShape &
      ReconciliationStoreShape &
      AuthorityGenerationStoreShape &
      AuthorityRestrictionStoreShape
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
    const intentStore = {} as IntentStoreService
    const mutationStore = {} as MutationStoreShape
    const startup = makeMutationAutonomousCycleStartup({
      accountId,
      authorityGenerationHash: generationHash,
      pollIntervalMs: 30_000,
      strategy: fixtureStrategy,
      executionProgram: sandboxExecutionProgram(),
    })

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const pass = yield* Deferred.make<Parameters<Parameters<typeof startup>[0]['recordPass']>[0]>()
          const loop = yield* startup({
            qualificationRunId: 'c'.repeat(64),
            recordPass: (observation) => Deferred.succeed(pass, observation).pipe(Effect.asVoid),
          })
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
            Effect.provideService(IntentStore, intentStore),
            Effect.provideService(MutationStore, mutationStore),
            Effect.forkScoped,
          )
          const observation = yield* Deferred.await(pass).pipe(Effect.timeout('1 second'))
          expect(observation).toMatchObject({
            result: 'SUCCESS',
            outcome: 'NO_PUBLICATION',
          })
          expect(authorityInitializations).toBe(0)
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

  test('binds mutation startup to the exact guarded execution program authority and strategy identity', async () => {
    for (const executionProgram of [
      sandboxExecutionProgram('9'.repeat(64)),
      sandboxExecutionProgram(generationHash, {
        ...fixtureStrategy.provenance.strategy,
        behaviorHash: '8'.repeat(64),
      }),
    ]) {
      const startup = makeMutationAutonomousCycleStartup({
        accountId,
        authorityGenerationHash: generationHash,
        pollIntervalMs: 30_000,
        strategy: fixtureStrategy,
        executionProgram,
      })

      const failure = await Effect.runPromise(
        Effect.flip(
          startup({
            qualificationRunId: 'c'.repeat(64),
            recordPass: () => Effect.void,
          }),
        ),
      )

      expect(failure).toMatchObject({
        _tag: 'OperationalError',
        component: 'config',
        operation: 'cycle-loop',
        message: 'mutation cycle execution program does not match its account, authority generation, and strategy',
      })
    }
  })
})
