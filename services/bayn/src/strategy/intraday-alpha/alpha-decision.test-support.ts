import { Effect, Layer, Option, Result, Schema } from 'effect'
import { TestClock } from 'effect/testing'

import { normalizeMarketCalendarResult } from '../../broker/alpaca/normalizers'
import { BrokerRead, type MarketCalendarObservationSchema } from '../../broker/alpaca/model'
import { BrokerEnvironment, BrokerProvider, makeBrokerIdentity } from '../../broker/identity'
import {
  makeCycleDraft,
  makeCycleIdentity,
  makeExecutionCalendarObservation,
  makeIntradayCycleWindow,
} from '../../cycle/construction'
import { CycleState, type AutonomousCycle } from '../../cycle/model'
import { DecisionConstruction } from '../../decision-construction'
import { operationalError } from '../../errors'
import { Authority, KillState, ReconciliationStatus } from '../../execution/contracts'
import { makeExecutionRiskPolicy } from '../../execution/risk-policy'
import { makeIntradayAlphaRuntime } from '../../intraday-replay/strategy'
import { JevBatchStore } from '../../jev/batch-evaluation'
import { JevClient } from '../../jev/client'
import { EntryInferenceJournal } from '../../jev/entry-inference'
import { JevEvaluationStore } from '../../jev/evaluation'
import { defaultJevProtocolDocument, decodeJevProtocol } from '../../jev/protocol'
import {
  NativeAlphaBaselinePreparation,
  reproduceAlphaBaselinePreparation,
  type RecordedAlphaBaselinePreparation,
} from '../../observe-composition/alpha-baseline-preparation'
import { preparedAlphaBaselineFixture } from '../../observe-composition/alpha-baseline-preparation.test-support'
import { constructStreamingSnapshot } from '../../market-data/streaming/snapshot'
import { CandidateObservationStore } from '../../observe-composition/candidate-observation'
import { buildMutationShadowCycleDecision } from '../../observe-composition/decision-builder'
import { prepareObserveStartup } from '../../observe-composition/startup'
import { IsoDateSchema } from '../../schemas'
import { constructExecutionDecision, constructObserveShadowDecision } from '../../shadow-decision'
import { shortEntryBrokerReads } from '../../testing/entry-broker-reads.test-support'
import { fixtureRuntime } from '../../testing/runtime-fixtures'
import { intradayAlphaStrategyIdentity, makeIntradayAlphaPolicy } from './policy'
import { makeAlphaStreamingSnapshot, makeFlatAlphaPortfolio } from './test-support'

/** Real native construction over synthetic market/account inputs, never operational trading evidence. */
export const nativeAlphaDecisionFixture = async (
  options: {
    readonly accountId?: string
    readonly authorityGenerationHash?: string
    readonly calendar?: typeof MarketCalendarObservationSchema.Type
    readonly snapshot?: Omit<Parameters<typeof makeAlphaStreamingSnapshot>[0], 'snapshotCalendar'>
    readonly baselinePreparation?: RecordedAlphaBaselinePreparation
  } = {},
) => {
  const accountId = options.accountId ?? 'alpha-test-account'
  const authorityGenerationHash = options.authorityGenerationHash ?? '2'.repeat(64)
  const protocol = Result.getOrThrow(decodeJevProtocol(defaultJevProtocolDocument))
  const policy = makeIntradayAlphaPolicy(protocol)
  const testTrailingBaselineLayer = Layer.succeed(NativeAlphaBaselinePreparation, {
    prepare: (request) =>
      Effect.fromResult(reproduceAlphaBaselinePreparation({ ...preparedBaseline.payload, ...request })).pipe(
        Effect.map(({ contentHash, payload }) => ({ contentHash, payload, recordedAt: preparedBaseline.recordedAt })),
      ),
  })
  const extendedCalendar =
    options.calendar ??
    Result.getOrThrow(
      normalizeMarketCalendarResult(
        [{ session_open: '0800', session_close: '1700', date: '2026-09-04', open: '09:30', close: '16:00' }],
        { start: '2026-09-04', end: '2026-09-04' },
      ),
    )
  const sessionDate = Schema.decodeUnknownSync(IsoDateSchema)(extendedCalendar.sessions[0]?.date)
  const preparedBaseline = options.baselinePreparation ?? preparedAlphaBaselineFixture(sessionDate)
  const { snapshot, cut, observedAt, rangeEndAt } = makeAlphaStreamingSnapshot({
    minutesFromOpen: 121,
    spyProfile: { basePrice: 550, endReturnBps: 0 },
    profiles: {
      COHR: { basePrice: 100, endReturnBps: -350 },
      LITE: { basePrice: 90, endReturnBps: -280 },
      SNDK: { basePrice: 60, endReturnBps: 340 },
      MU: { basePrice: 80, endReturnBps: 250 },
    },
    quoteSpreadBps: 450, // Wide single-exchange IEX spread (~4.5%)
    quoteBidSize: 1, // Thin top-of-book displayed bid size on IEX
    quoteAskSize: 1,
    ...options.snapshot,
    snapshotCalendar: extendedCalendar,
  })

  const identity = Result.getOrThrow(intradayAlphaStrategyIdentity(policy))
  const strategy = makeIntradayAlphaRuntime(policy, { ...fixtureRuntime.provenance, strategy: identity.strategy })
  const prepared = Result.getOrThrow(
    prepareObserveStartup({
      strategy,
      accountId,
      authorityGenerationHash,
      reconciliationIntervalMs: 30_000,
      reconciliationPassTimeoutMs: 30_000,
    }),
  )
  const brokerIdentity = Result.getOrThrow(
    makeBrokerIdentity({
      schemaVersion: 'bayn.broker-identity.v2',
      provider: BrokerProvider.Alpaca,
      environment: BrokerEnvironment.Sandbox,
      accountId,
    }),
  )
  const riskPolicy = Result.getOrThrow(
    makeExecutionRiskPolicy(accountId, policy.sharedProtocol.universe, BrokerEnvironment.Sandbox),
  )
  const portfolio = makeFlatAlphaPortfolio(observedAt, undefined, undefined, accountId)
  const calendarSession = extendedCalendar.sessions[0]
  if (calendarSession === undefined) throw new Error('Missing extended calendar session')
  const executionCalendar = Result.getOrThrow(
    makeExecutionCalendarObservation({
      schemaVersion: extendedCalendar.schemaVersion,
      source: extendedCalendar.source,
      ...calendarSession,
    }),
  )
  const cycleIdentity = Result.getOrThrow(
    makeCycleIdentity({
      schemaVersion: 'bayn.autonomous-cycle-identity.v4',
      qualificationRunId: '1'.repeat(64),
      strategyName: 'jev',
      strategyProtocolHash: identity.protocolHash,
      accountId,
      executionSessionDate: sessionDate,
      executionCalendarSchemaVersion: executionCalendar.executionCalendarSchemaVersion,
      executionCalendarSource: executionCalendar.executionCalendarSource,
      executionCalendarHash: executionCalendar.executionCalendarHash,
      entryAttemptOrdinal: 1,
      executionPolicy: prepared.executionPolicy,
    }),
  )
  const cycleWindow = Result.getOrThrow(makeIntradayCycleWindow(executionCalendar, prepared.executionPolicy))
  const cycleDraft = Result.getOrThrow(makeCycleDraft(cycleIdentity, cycleWindow))
  const cycle: AutonomousCycle = {
    ...cycleDraft,
    state: CycleState.Active,
    stateVersion: 1,
    bindings: {},
    createdAt: observedAt,
    updatedAt: observedAt,
  }
  const reconciliation = {
    brokerState: portfolio.brokerState,
    riskContext: {
      authority: {
        schemaVersion: 'bayn.paper-authority.v1' as const,
        generationHash: authorityGenerationHash,
        maximum: Authority.Execution,
        effective: Authority.Execution,
        kill: KillState.Clear,
        version: 2,
        updatedAt: observedAt,
      },
      authorityObservedAt: observedAt,
      brokerIdentity,
      tradingDate: sessionDate,
      dayStartEquityMicros: portfolio.brokerState.account.equityMicros,
      peakEquityMicros: portfolio.brokerState.account.equityMicros,
      dailyTradedNotionalMicros: '0',
      dailyLossMicros: '0',
      drawdownMicros: '0',
      unknownMutationCount: 0,
      observedAt,
    },
    report: {
      reconciliation: portfolio.brokerState.reconciliation,
      metrics: {
        reconciliationStatus: ReconciliationStatus.Exact,
        brokerPollAgeMs: 0,
        brokerEventLagMs: 0,
        cashDifferenceMicros: '0',
        positionDifferenceMicros: '0',
        equityDifferenceMicros: '0',
        discrepancyCount: 0,
        unknownMutationCount: 0,
        oldestUnknownMutationAgeMs: 0,
        accountingExact: true,
      },
    },
  }

  const unused = Effect.die('unused')
  let jevCalls = 0
  const document = await Effect.runPromise(
    TestClock.setTime(Date.parse(observedAt)).pipe(
      Effect.andThen(
        buildMutationShadowCycleDecision({
          authorityGenerationHash,
          cycle,
          executionModel: prepared.executionModel,
          policy: riskPolicy,
          strategy,
          reconcile: Effect.succeed(reconciliation),
          intradayMarketData: {
            check: Effect.void,
            verifyReference: () => unused,
            loadSnapshot: (query) =>
              query.purpose === 'ENTRY_PRICING'
                ? Effect.fromResult(constructStreamingSnapshot(cut, query)).pipe(
                    Effect.mapError((cause) =>
                      operationalError({
                        component: 'market-data',
                        operation: 'load-snapshot',
                        message: 'pricing snapshot failed',
                        cause,
                      }),
                    ),
                  )
                : Effect.succeed(snapshot),
          },
          decisionFinalizationHeadroomMs: 0,
        }),
      ),
      Effect.provide(
        Layer.mergeAll(
          Layer.succeed(CandidateObservationStore, {
            record: () => Effect.void,
            latestJevWindowEnd: () => Effect.succeed(Option.none()),
            readIntradayAlphaSessionState: () =>
              Effect.succeed({
                morningOrbTakenSymbols: [],
                middayReversionCompleted: false,
                noiseAreaTakenSymbols: [],
              }),
          }),
          testTrailingBaselineLayer,
          Layer.succeed(BrokerRead, {
            ...shortEntryBrokerReads(portfolio.brokerState.account, observedAt),
            positions: unused,
            orders: () => unused,
            orderById: () => unused,
            orderByClientId: () => unused,
            fillActivities: () => unused,
            feeActivities: () => unused,
            marketCalendar: () =>
              Effect.succeed({
                value: extendedCalendar,
                evidence: {
                  requestId: 'alpha-test-calendar',
                  status: 200,
                  contentHash: extendedCalendar.normalizedResponseHash,
                  observedAt,
                },
              }),
          }),
          Layer.succeed(EntryInferenceJournal, {
            recordVisualClaims: () => unused,
            recordTransitions: () => unused,
          }),
          Layer.succeed(JevBatchStore, {
            read: () => unused,
            pending: () => unused,
            begin: () => unused,
            complete: () => unused,
            finish: () => unused,
          }),
          Layer.succeed(JevEvaluationStore, {
            read: () => unused,
            recordAll: () => unused,
            abandon: () => unused,
          }),
          Layer.succeed(JevClient, {
            evaluate: () => {
              jevCalls += 1
              return Effect.die('catalyst veto must not execute while disabled')
            },
          }),
          Layer.succeed(DecisionConstruction, {
            observe: constructObserveShadowDecision,
            execution: constructExecutionDecision,
          }),
          TestClock.layer(),
        ),
      ),
    ),
  )

  return {
    document,
    cycle,
    rangeEndAt,
    jevCalls,
    observedAt,
    policy,
    identity,
    portfolio,
    strategy,
    reconciliation,
    prepared,
    riskPolicy,
  }
}
