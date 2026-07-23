import { describe, expect, test } from 'bun:test'

import { Effect } from 'effect'
import { TestClock } from 'effect/testing'

import type { BrokerReadShape, MarketCalendarObservation, ReadResult } from './broker/alpaca'
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
import type { CycleStoreShape } from './db/cycle-store'
import type { PaperStoreShape } from './db/paper-store'
import { canonicalHashV1 } from './hash'
import type { MarketDataService, MarketDataSnapshot } from './market-data'
import {
  buildObserveCycleDecision,
  loadObserveRiskPolicy,
  makeObserveAutonomousCycleStartup,
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
import type { ReconciliationPassResult } from './reconciler'
import { reconciledStateHash } from './reconciliation'
import { Reason } from './risk'
import { fixtureProtocol, makeSnapshot } from './test-fixtures'
import type { DecisionPlan } from './types'

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

const executionPolicy = makeCycleExecutionPolicyFromModel(fixtureProtocol.executionModel)
const executionCalendar = makeExecutionCalendarObservation({
  schemaVersion: calendar.schemaVersion,
  source: calendar.source,
  ...calendar.sessions[1],
})
const identity = makeCycleIdentity({
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
const window = makeCycleWindow(
  {
    calendar_version: 'fixture-calendar-v2',
    session_date: signalDate,
    close_time: '16:00',
    timezone: 'America/New_York',
  },
  executionCalendar,
  executionPolicy,
)
const draft = makeCycleDraft(identity, window)
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
  const stateHash = reconciledStateHash({
    account,
    positions: [],
    positionsObservedAt: reconciledAt,
    orders: [],
    ordersObservedAt: reconciledAt,
    accountingHash,
  })
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

describe('OBSERVE runtime composition', () => {
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
        marketCalendar: calendarRead(calendarQueries),
        marketData: marketData(snapshotRequests),
        policy,
        reconcile: Effect.succeed(reconciliationResult()),
        strategy: {
          currentDecision: (_bars, _manifest, binding) => {
            strategyCalls += 1
            expect(binding.signal.sessionDate).toBe(signalDate)
            expect(binding.executionSession.date).toBe(executionDate)
            expect(binding.submissionOpenAt).toBe(reconciledAt)
            return { decision, priceMicros }
          },
        },
      })
    }).pipe(Effect.provide(TestClock.layer()))

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
    const exit = await Effect.runPromiseExit(
      Effect.gen(function* () {
        yield* TestClock.setTime(Date.parse(evaluatedAt))
        return yield* buildObserveCycleDecision({
          authorityGenerationHash: generationHash,
          cycle,
          executionModel: fixtureProtocol.executionModel,
          marketCalendar: calendarRead([]),
          marketData: marketData([]),
          policy,
          reconcile: Effect.succeed(reconciliationResult('9'.repeat(64))),
          strategy: {
            currentDecision: () => {
              strategyCalls += 1
              return { decision, priceMicros }
            },
          },
        })
      }).pipe(Effect.provide(TestClock.layer())),
    )

    expect(exit.toString()).toContain('same-pass reconciliation did not return the configured OBSERVE authority')
    expect(strategyCalls).toBe(0)
  })

  test('fails PAPER startup before authority initialization or autonomous work can begin', async () => {
    const unused = Effect.die(new Error('PAPER startup must fail before using runtime capabilities'))
    let authorityInitializations = 0
    const paperStore: PaperStoreShape = {
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
          throw new Error('PAPER startup must not initialize synthetic OBSERVE authority')
        }),
      preparePaperGeneration: () => unused,
      activatePaperGeneration: () => unused,
      restrictAuthority: () => unused,
    }
    const cycleStore: CycleStoreShape = {
      acquire: () => unused,
      read: () => unused,
      readAuthoritySlot: () => unused,
      readDecisionDocument: () => unused,
      readOldestUnfinished: () => unused,
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
    const startup = makeObserveAutonomousCycleStartup({
      accountId,
      authorityGenerationHash: generationHash,
      brokerRead,
      cycleStore,
      marketData: marketData([]),
      maximumAuthority: Authority.Paper,
      paperStore,
      pollIntervalMs: 30_000,
      reconcile: unused,
      strategy: {
        currentDecision: () => {
          throw new Error('PAPER startup must not compile a shadow decision')
        },
        parameters: fixtureProtocol,
      },
    })

    const exit = await Effect.runPromiseExit(
      Effect.scoped(
        startup({
          qualificationRunId: 'c'.repeat(64),
          strategyProtocolHash: 'd'.repeat(64),
          recordPass: () => unused,
        }),
      ),
    )

    expect(exit.toString()).toContain(
      'PAPER autonomous startup requires the gated Phase B authority generation and dispatch transition',
    )
    expect(authorityInitializations).toBe(0)
  })
})
