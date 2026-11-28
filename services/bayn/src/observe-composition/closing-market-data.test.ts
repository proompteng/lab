import { atTestTime } from '../effect-test-support'
import {
  noProtection,
  withFixtureIntentStore,
  withFixtureMutationStore,
} from '../testing/execution-stores.test-support'
import { DecisionConstruction } from '../decision-construction'
import { constructExecutionDecision, constructObserveShadowDecision } from '../shadow-decision'
import { entryProviderFixture } from '../jev/entry-inference.test-support'
import { entryInferenceFixtureLayer } from '../jev/entry-inference.test-support'
import { MarketCalendarObservationSchema, MarketCalendarResponseSchema } from '../broker/alpaca/model'
import { normalizeMarketCalendarResult } from '../broker/alpaca/normalizers'
import { IsoDateSchema, strictParseOptions } from '../schemas'
import { executionCloseRecoveryExpiry } from '../market-hours'
import { beforeAll, describe, expect, test } from 'bun:test'
import { Cause, Clock, Effect, Exit, Fiber, Option, Result, Schema } from 'effect'

const runWithConstruction = <A, E>(program: Effect.Effect<A, E, DecisionConstruction>) =>
  Effect.runPromise(
    program.pipe(
      Effect.provideService(DecisionConstruction, {
        observe: constructObserveShadowDecision,
        execution: constructExecutionDecision,
      }),
    ),
  )
import { TestClock } from 'effect/testing'

import { BrokerRead, type BrokerReadShape } from '../broker/alpaca/model'
import { BrokerReadError, BrokerReadErrorKind } from '../broker/alpaca/failures'
import { CycleState, AutonomousCycleSchema } from '../cycle/model'
import {
  Authority,
  IntentState,
  KillState,
  isBracketProtection,
  type Order,
  OrderType,
  OrderSide,
  OrderStatus,
  ReconciliationStatus,
  TerminalOutcome,
  TimeInForce,
} from '../execution/contracts'
import { planExecutionIntent, type StoredIntent } from '../execution/intents/domain'
import { MutationEventType, type MutationEvent } from '../execution/mutations/model'
import { MutationOperation } from '../broker/alpaca-mutations/model'
import { legacyCycleClosureSchemaVersion } from '../execution/legacy-wire'
import { canonicalHashV1Result } from '../hash'
import { decidePreparedMutationIntent } from './mutation-decisions'
import {
  makeExecutionCycleClosure,
  type ExecutionCycleClosure,
  type ExecutionCycleClosureStoreShape,
} from '../db/execution-cycle-closure'
import { nativeAlphaDecisionFixture } from '../strategy/intraday-alpha/alpha-decision.test-support'
import { IntradayAlphaPhase } from '../strategy/intraday-alpha/policy'
import { closeWindowForCycle, ensureExecutionCycleClosure } from './execution-cycle'
import { resolveExecutionCycleCloseWindow } from './execution-window'
import { BrokerAccess, grantedCapitalAuthority } from '../execution/authority'
import { advancePositionProtection } from './position-protection-interpreter'
import { prepareMutationIntent, readPreparedExecutionIntents } from './mutation-intent-interpreter'
import { JevBatchStore } from '../jev/batch-evaluation'
import { JevClient } from '../jev/client'
import { JevEvaluationStore } from '../jev/evaluation'
import { nativeJevBatchResult, nativeJevFixture } from '../jev/native.test-support'
import { JevPositionStore, JevPurpose } from '../jev/portfolio'
import { decideJevExit, JevExitReason, JevExitTargetSchema } from '../jev/exit'
import { makePersistenceDocumentFixture } from '../system-assessment/decision-persistence.test-support'
import { IntradaySnapshotPurpose, type IntradayMarketDataService } from '../market-data/intraday/model'
import { persistIntradayRecordRows } from '../market-data/intraday/verification'
import { evaluateJevPositionManagement, jevPricingQuery } from '../jev/runtime'
import { orderRequestBody } from '../broker/alpaca-mutations/decisions'

import { IntradaySnapshotFailure } from '../market-data/intraday/model'
import { OperationalError, retryableOperationalError } from '../errors'
import { reconciledStateHash } from '../simulation-reconciliation/broker-model'
import { type ReconciliationPassResult } from '../reconciler'
import { strategyExecutionRiskPolicy } from '../execution/risk-policy'
import { makeJevMarketTestSnapshot as makeIntradayMomentumTestSnapshot } from '../testing/jev-market-fixture'
import { fixtureRuntime } from '../testing/runtime-fixtures'
import { fixtureStreamingReference, streamingFixtureFromRaw } from '../testing/streaming-market-fixture'
import { currentUtcInstant } from '../time'
import { TargetPlanStatus } from '../target-planner/model'
import { CandidateObservationStore } from './candidate-observation'
import {
  checkAdvancedMarketProjection,
  executionEvidenceContinuationDelayMs,
  reconciliationForPreparation,
} from './recovery-driver'
import { advanceExecutionOnce } from '../execution/advance'
import { ExecutionControllerOutcome } from '../execution/controller-status'
import {
  completeExecutionControllerTick,
  decodeExecutionControllerState,
  decideExecutionControllerActivation,
  decideExecutionControllerTick,
} from '../execution/controller'
import {
  buildMutationShadowCycleDecision,
  ExecutionCloseAwaitingMarketData,
  ExecutionCloseAwaitingReconciliation,
  executionCloseMarketDataDiagnostics,
  prepareClosingExecutionCycleDecision,
} from './decision-builder'
import { prepareObserveStartup } from './startup'

const generationHash = 'b'.repeat(64)
// This suite exercises the active startup path; historical v1 fixtures stay v1 elsewhere.
const activeNativeFixture = (purpose: JevPurpose = JevPurpose.Entry) =>
  nativeJevFixture(purpose, undefined, 'jev-native-test', fixtureRuntime.definition.parameters)
const native = activeNativeFixture()
const managed = activeNativeFixture(JevPurpose.Manage).portfolio
const accountId = native.portfolio.brokerState.account.accountId
const at = native.query.observedAt
const activeCycle = Effect.runSync(
  Schema.decodeUnknownEffect(
    AutonomousCycleSchema,
    strictParseOptions,
  )({
    ...native.draft,
    state: CycleState.Active,
    bindings: {},
    stateVersion: 1,
    createdAt: at,
    updatedAt: at,
  }),
)

const factsAt = (observedAt: string, held = false): ReconciliationPassResult => {
  const source = held ? managed.brokerState : native.portfolio.brokerState
  const state = {
    ...source,
    account: { ...source.account, observedAt },
    positions: source.positions.map((position) => ({ ...position, observedAt })),
    positionsObservedAt: observedAt,
    orders: source.orders.map((order) => ({ ...order, observedAt })),
    ordersObservedAt: observedAt,
  }
  const hash = Result.getOrThrow(reconciledStateHash(state))
  const reconciliation = { ...source.reconciliation, reconciledAt: observedAt, expectedHash: hash, observedHash: hash }
  return {
    report: {
      reconciliation,
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
    brokerState: { ...state, reconciliation },
    riskContext: {
      tradingDate: native.query.sessionDate,
      authority: {
        schemaVersion: 'bayn.paper-authority.v1',
        generationHash,
        maximum: Authority.Execution,
        effective: Authority.Execution,
        kill: KillState.Clear,
        version: 1,
        updatedAt: observedAt,
      },
      authorityObservedAt: observedAt,
      unknownMutationCount: 0,
      dailyTradedNotionalMicros: '0',
      dayStartEquityMicros: state.account.equityMicros,
      peakEquityMicros: state.account.equityMicros,
    },
  }
}

const withBrokerCut = (
  facts: ReconciliationPassResult,
  state: ReconciliationPassResult['brokerState'],
  overrides: Partial<ReconciliationPassResult['report']['reconciliation']> = {},
): ReconciliationPassResult => {
  const hash = Result.getOrThrow(reconciledStateHash(state))
  const reconciliation = { ...state.reconciliation, expectedHash: hash, observedHash: hash, ...overrides }
  return { ...facts, brokerState: { ...state, reconciliation }, report: { ...facts.report, reconciliation } }
}

const unavailable = new IntradaySnapshotFailure({
  reason: 'not-ready',
  message: 'Fixture quote partition has not caught up',
  facts: { symbol: 'AAPL' },
})
const marketFailure = retryableOperationalError({
  component: 'market-data',
  operation: 'snapshot',
  message: 'Fixture archive cut unavailable',
  cause: unavailable,
})
const freshMarket: IntradayMarketDataService = {
  check: Effect.void,
  loadSnapshot: (query) =>
    Effect.sync(
      () =>
        streamingFixtureFromRaw(
          makeIntradayMomentumTestSnapshot(native.protocol, { ...query, archiveWatermarks: [] }, { AAPL: 0.02 }, 10),
          query,
        ).snapshot,
    ),
  verifyReference: fixtureStreamingReference,
}

const marketWith = (loadSnapshot: IntradayMarketDataService['loadSnapshot']): IntradayMarketDataService => ({
  ...freshMarket,
  loadSnapshot,
})
const unavailableMarket = marketWith(() => Effect.fail(marketFailure))

const makeFixture = async (source: typeof native) => {
  const selectedCycle = Effect.runSync(
    Schema.decodeUnknownEffect(
      AutonomousCycleSchema,
      strictParseOptions,
    )({
      ...source.draft,
      state: CycleState.Active,
      bindings: {},
      stateVersion: 1,
      createdAt: at,
      updatedAt: at,
    }),
  )
  const input = {
    accountId,
    authorityGenerationHash: generationHash,
    pollIntervalMs: 30_000,
    reconciliationIntervalMs: 30_000,
    reconciliationPassTimeoutMs: 30_000,
    strategy: fixtureRuntime,
    intradayMarketData: freshMarket,
  }
  const preparation = Result.getOrThrow(prepareObserveStartup(input))
  const policy = await runWithConstruction(Effect.fromResult(strategyExecutionRiskPolicy(accountId, fixtureRuntime)))
  const unused = Effect.die(new Error('Unexpected fixture I/O'))
  const broker: BrokerReadShape = {
    ...longEntryBrokerReads(source.portfolio.brokerState.account, at),
    positions: unused,
    orders: () => unused,
    orderById: () => unused,
    orderByClientId: () => unused,
    feeActivities: () => unused,
    fillActivities: () => unused,
    marketCalendar: () =>
      Effect.succeed({
        value: source.query.calendar,
        evidence: {
          requestId: 'fixture',
          status: 200,
          contentHash: 'f'.repeat(64),
          observedAt: at,
        },
      }),
  }
  const document = await runWithConstruction(
    atTestTime(Date.parse(at), () =>
      buildMutationShadowCycleDecision({
        authorityGenerationHash: generationHash,
        cycle: selectedCycle,
        executionModel: preparation.executionModel,
        policy,
        reconcile: Effect.succeed(factsAt(at)),
        strategy: fixtureRuntime,
        intradayMarketData: freshMarket,
      }),
    ).pipe(
      Effect.provideService(BrokerRead, broker),
      Effect.provideService(CandidateObservationStore, {
        record: () => Effect.void,
        latestJevWindowEnd: () => Effect.succeed(Option.none()),
      }),
      Effect.provideService(JevBatchStore, {
        read: () => unused,
        pending: () => Effect.succeed([]),
        begin: ({ plan }) =>
          Clock.currentTimeMillis.pipe(
            Effect.map((now) => ({
              plan,
              dispatches: [],
              result: nativeJevBatchResult(plan, new Date(now).toISOString(), (symbol) =>
                symbol === 'AAPL' ? true : false,
              ),
            })),
          ),
        complete: () => unused,
        finish: () => unused,
      }),
      Effect.provideService(JevEvaluationStore, {
        read: () => unused,

        recordAll: () => unused,
        abandon: () => unused,
      }),
      Effect.provide(entryInferenceFixtureLayer),
      Effect.provideService(JevClient, entryProviderFixture({ evaluate: () => unused })),
      Effect.provideService(JevPositionStore, { read: () => unused }),

      Effect.provide(TestClock.layer()),
    ),
  )
  return {
    input,
    preparation,
    policy,
    entryDocument: document,
    cycle: Effect.runSync(
      Schema.decodeUnknownEffect(
        AutonomousCycleSchema,
        strictParseOptions,
      )({
        ...selectedCycle,
        bindings: { snapshotId: document.bindings.snapshotId, decisionHash: document.contentHash },
        stateVersion: 2,
        updatedAt: document.createdAt,
      }),
    ),
    closeExpiresAt: selectedCycle.window.executionCloseAt,
  }
}

type ClosingFixture = Awaited<ReturnType<typeof makeFixture>>
const fixtureCloseWindow = (request: ClosingFixture) =>
  Result.getOrThrow(
    resolveExecutionCycleCloseWindow({
      executionCalendarSchemaVersion: request.cycle.window.executionCalendarSchemaVersion,
      recoveryExpiresAt: null,
      observedAt: '2026-08-19T19:00:00.000Z',
      executionCloseAt: request.closeExpiresAt,
      sessionCloseStartLeadMs: native.protocol.flattenBeforeCloseMinutes * 60_000,
      sessionCloseSubmitLeadMs: native.protocol.hardFlatBeforeCloseMinutes * 60_000,
    }),
  )

describe('closing market-data fallback boundaries', () => {
  let defaultFixture: ClosingFixture
  let shortEntry: Promise<ClosingFixture['entryDocument']> | undefined
  beforeAll(async () => {
    defaultFixture = await makeFixture(native)
  })

  const fixture = async (source = native) => {
    if (source !== native) return makeFixture(source)
    const { input, ...state } = defaultFixture
    return { input: { ...input }, ...structuredClone(state) }
  }

  test.each(['16:28:02.379', '17:55:02.000', '18:02:03.000'])(
    'Black Friday MorningOrb closes GOOGL -103 with a stale IEX quote at %sZ',
    async (time) => {
      const date = '2026-11-27'
      const calendar = Result.getOrThrow(
        normalizeMarketCalendarResult(
          [{ date, open: '09:30', close: '13:00', session_open: '0400', session_close: '1700' }],
          { start: date, end: date },
        ),
      )
      const { document, cycle, strategy, prepared, riskPolicy, reconciliation, policy } =
        await nativeAlphaDecisionFixture({
          calendar: Schema.decodeUnknownSync(MarketCalendarObservationSchema)(calendar),
          snapshot: {
            minutesFromOpen: 32,
            spyProfile: { basePrice: 550, endReturnBps: -55 },
            profiles: {
              GOOGL: {
                basePrice: 274,
                endReturnBps: -60,
                openingRangeLow: 272,
                overridePrevClose: 272.1,
                overrideLatestClose: 271.08,
              },
            },
          },
        })
      expect(document.strategyDecision).toMatchObject({
        phase: IntradayAlphaPhase.MorningOrb,
        selectedSymbols: ['GOOGL'],
        exitPolicy: {
          plans: { GOOGL: { levels: { minimumEntryPriceMicros: '270810000', maximumHoldingMinutes: 60 } } },
        },
      })
      expect(document.executionSession?.executionSession.closeAt).toBe('2026-11-27T22:00:00.000Z')
      const observedAt = `${date}T${time}Z`
      const state = {
        ...reconciliation.brokerState,
        account: { ...reconciliation.brokerState.account, observedAt },
        positions: [
          {
            schemaVersion: 'bayn.position.v2' as const,
            accountId: cycle.identity.accountId,
            symbol: 'GOOGL',
            quantityAtoms: '-103000000000',
            averageEntryPriceMicros: '271025500',
            costBasisMicros: '-27915626500',
            marketPriceMicros: '275880000',
            marketValueMicros: '-28415640000',
            unrealizedPnlMicros: '-500013500',
            observedAt,
          },
        ],
        positionsObservedAt: observedAt,
        ordersObservedAt: observedAt,
      }
      const hash = Result.getOrThrow(reconciledStateHash(state))
      const cut = { ...state.reconciliation, reconciledAt: observedAt, expectedHash: hash, observedHash: hash }
      const exact = {
        ...reconciliation,
        brokerState: { ...state, reconciliation: cut },
        report: { ...reconciliation.report, reconciliation: cut },
        riskContext: {
          ...reconciliation.riskContext,
          authority: { ...reconciliation.riskContext.authority, updatedAt: observedAt },
          authorityObservedAt: observedAt,
        },
      }
      const window = await Effect.runPromise(closeWindowForCycle(cycle, document, policy.sharedProtocol, observedAt))
      expect(window.startAt).toBe('2026-11-27T16:28:00.000Z')
      const postClose = time === '18:02:03.000'
      expect(window.expiresAt).toBe(postClose ? '2026-11-27T18:05:03.000Z' : '2026-11-27T18:00:00.000Z')
      let quoteReads = 0
      const input = {
        accountId: cycle.identity.accountId,
        authorityGenerationHash: document.bindings.authorityGenerationHash,
        pollIntervalMs: 30_000,
        reconciliationIntervalMs: 30_000,
        reconciliationPassTimeoutMs: 30_000,
        strategy,
        intradayMarketData: marketWith(() => {
          quoteReads++
          return Effect.fail(
            retryableOperationalError({
              component: 'market-data',
              operation: 'load',
              message: 'Streaming snapshot verification failed',
              cause: new IntradaySnapshotFailure({
                reason: 'not-ready',
                message: 'intraday snapshot lacks a post-range quote for every symbol',
                facts: { symbol: 'GOOGL', quoteAgeMs: 61_000 },
              }),
            }),
          )
        }),
      }
      if (!postClose) {
        const unused = () => Effect.die('Unexpected protection operation')
        let stored: StoredIntent | undefined
        let submitted: MutationEvent | undefined
        await Effect.runPromise(
          Effect.gen(function* () {
            yield* TestClock.setTime(Date.parse(observedAt))
            const [entry] = yield* readPreparedExecutionIntents(document)
            if (entry === undefined || !isBracketProtection(entry.intent.protection))
              throw new Error('Expected a durable native short bracket')
            const intent = entry.intent
            const terms = entry.intent.protection
            stored = {
              intent: { ...intent, state: IntentState.Terminal, terminalOutcome: TerminalOutcome.Filled },
              stateVersion: 3,
              updatedAt: '2026-11-27T15:02:09.000Z',
            }
            submitted = {
              schemaVersion: 'bayn.paper-mutation-event.v1',
              eventId: 'a'.repeat(64),
              mutationId: 'b'.repeat(64),
              intentId: intent.intentId,
              sequence: 2,
              operation: MutationOperation.Submit,
              eventType: MutationEventType.SubmitAccepted,
              requestHash: 'c'.repeat(64),
              consistencyDelayMs: 1_000,
              brokerOrderId: 'googl-entry',
              occurredAt: stored.updatedAt,
            }
            const stop: Order = {
              schemaVersion: 'bayn.order.v3',
              accountId: input.accountId,
              brokerOrderId: 'googl-stop',
              clientOrderId: 'googl-stop-client',
              intentId: intent.intentId,
              symbol: 'GOOGL',
              side: OrderSide.Buy,
              orderType: OrderType.StopLimit,
              timeInForce: TimeInForce.Day,
              quantityAtoms: '103000000000',
              filledQuantityAtoms: '0',
              status: OrderStatus.New,
              stopPriceMicros: terms.stopPriceMicros,
              limitPriceMicros: terms.stopLimitPriceMicros,
              observedAt,
            }
            const { stopPriceMicros: _stop, ...profit } = stop
            const orders: readonly Order[] = [
              stop,
              {
                ...profit,
                brokerOrderId: 'googl-profit',
                clientOrderId: 'googl-profit-client',
                orderType: OrderType.Limit,
                limitPriceMicros: terms.profitLimitPriceMicros,
              },
            ]
            const cancels: string[] = []
            const advance = (openOrders: readonly Order[]) =>
              advancePositionProtection({
                input,
                cycle,
                document,
                protocol: policy.sharedProtocol,
                policy: riskPolicy,
                reconciliation: { ...exact, brokerState: { ...exact.brokerState, orders: openOrders } },
                closeDue: observedAt >= window.startAt,
                closeExpiresAt: window.expiresAt,
                capability: {
                  _tag: 'Mutation',
                  executionProgram: {
                    _tag: 'ExecutionProgram',
                    schemaVersion: 'bayn.execution-program.v1',
                    authority: {
                      brokerAccess: BrokerAccess.Mutation,
                      brokerIdentity: exact.riskContext.brokerIdentity,
                      capitalAuthority: grantedCapitalAuthority(input.authorityGenerationHash),
                      strategy: strategy.provenance.strategy,
                    },
                    recordReconciliation: unused,
                    invalidateBrokerState: unused(),
                    dryRunSubmit: unused,
                    submit: unused,
                    submitProtectionClose: unused,
                    cancel: unused,
                    recover: unused,
                    cancelProtectionOrder: (intentId, brokerOrderId) =>
                      Effect.sync(() => {
                        cancels.push(brokerOrderId)
                        return {
                          _tag: 'Accepted',
                          phase: 'Fresh',
                          receipt: {
                            command: { intentId, accountId: input.accountId, brokerOrderId, requestedAt: observedAt },
                            requestHash: 'a'.repeat(64),
                            evidence: {
                              requestId: 'incident-test-cancel',
                              status: 204,
                              contentHash: 'b'.repeat(64),
                              observedAt,
                            },
                          },
                        } as const
                      }),
                  },
                },
              })
            expect(yield* advance(orders)).toMatchObject({ _tag: 'PostMutationReconciliation' })
            expect(cancels).toEqual(['googl-stop'])
            expect(yield* advance([])).toEqual({ _tag: 'Ready' })
            expect(quoteReads).toBe(0)
          }).pipe(
            withFixtureIntentStore({
              read: () => Effect.succeed(Option.fromUndefinedOr(stored)),
              protectionForCycle: () => Effect.succeed(stored === undefined ? [] : [stored]),
            }),
            withFixtureMutationStore({
              latest: (_id, operation) =>
                Effect.succeed(operation === MutationOperation.Submit ? submitted : undefined),
            }),
            Effect.provideService(JevPositionStore, { read: unused }),
            Effect.provide(TestClock.layer()),
          ),
        )
      }
      const closed = await runWithConstruction(
        TestClock.setTime(Date.parse(observedAt)).pipe(
          Effect.andThen(
            prepareClosingExecutionCycleDecision({
              input,
              preparation: prepared,
              policy: riskPolicy,
              cycle,
              entryDocument: document,
              closeExpiresAt: window.expiresAt,
              reconcile: Effect.succeed(exact),
            }),
          ),
          Effect.provide(TestClock.layer()),
        ),
      )
      expect(quoteReads).toBe(postClose ? 0 : 1)
      expect(closed.document.dispatchable).toBe(true)
      expect(closed.document.deltaRisk[0]?.limitPriceMicros).toBe('276150000')
      expect(closed.document.targetPlan.executionTerms?.priceReference).toBe('reconciled-broker-position-mark')
      expect(closed.document.targetPlan.intentTargets).toMatchObject([
        { symbol: 'GOOGL', side: OrderSide.Buy, quantityAtoms: '103000000000', orderType: OrderType.Limit },
      ])
    },
  )

  test.each([
    'stop',
    'target',
    'wide-stop',
    'inside',
    'pending',
    'typed-error',
    'defect',
    'interruption',
    'timeout',
    'near-expiry',
    'expired',
    'stale',
    'missing-bid',
    'missing-ask',
    'malformed',
    'partial',
    'cancel-accepted',
  ] as const)('pending entry preserves its original price boundaries: %s', async (scenario) => {
    const request = await fixture()
    const document = request.entryDocument
    const entry = document.strategyDecision
    if (entry?.schemaVersion !== 'bayn.jev-entry-target.v7') throw new Error('Expected a Jev entry')
    const plan = entry.exitPolicy.plans['AAPL']
    const risk = document.deltaRisk[0]
    const target = document.targetPlan.intentTargets[0]
    if (plan === undefined || risk === undefined || target === undefined) throw new Error('Expected a funded entry')
    const buildAt = document.createdAt
    const checkAt =
      scenario === 'expired'
        ? risk.evaluation.decision.expiresAt
        : scenario === 'near-expiry'
          ? new Date(Date.parse(risk.evaluation.decision.expiresAt) - 1).toISOString()
          : new Date(Date.parse(buildAt) + 1_499).toISOString()
    expect(checkAt <= risk.evaluation.decision.expiresAt).toBe(true)
    const initial = factsAt(checkAt)
    const authority = initial.riskContext.authority
    if (authority === null) throw new Error('Expected entry authority')
    const intent = await runWithConstruction(
      planExecutionIntent(
        {
          schemaVersion: 'bayn.intent-plan.v3',
          ...target,
          limitPriceMicros: risk.limitPriceMicros,
          notionalLimitMicros: risk.notionalLimitMicros,
          ...(risk.protection === undefined ? {} : { protection: risk.protection }),
          createdAt: buildAt,
        },
        { authority },
      ),
    )
    const accepted: MutationEvent = {
      schemaVersion: 'bayn.paper-mutation-event.v1',
      eventId: '1'.repeat(64),
      mutationId: '2'.repeat(64),
      intentId: intent.intentId,
      sequence: 2,
      operation: MutationOperation.Submit,
      eventType: MutationEventType.SubmitAccepted,
      requestHash: Result.getOrThrow(canonicalHashV1Result(Result.getOrThrow(orderRequestBody(intent)))),
      consistencyDelayMs: 1_000,
      brokerOrderId: 'unfilled-boundary-entry',
      occurredAt: buildAt,
    }
    const open = Result.getOrThrow(decidePreparedMutationIntent(intent, accepted))
    if (open._tag !== 'Pending') throw new Error('Expected acknowledged entry')
    const record: StoredIntent = {
      intent: { ...intent, state: IntentState.Acknowledged, riskDecisionId: risk.evaluation.decision.decisionId },
      decision: risk.evaluation.decision,
      stateVersion: 3,
      updatedAt: buildAt,
    }
    const state = {
      ...initial.brokerState,
      positions: scenario === 'partial' ? factsAt(checkAt, true).brokerState.positions : initial.brokerState.positions,
      orders: [
        ...initial.brokerState.orders,
        { ...open.order, status: OrderStatus.New, filledQuantityAtoms: '0', observedAt: checkAt },
      ],
    }
    const reconciliation = withBrokerCut(initial, state)
    const stop = Number(plan.levels.stopPriceMicros) / 1_000_000
    const profit = Number(plan.levels.profitLimitPriceMicros) / 1_000_000
    const bid =
      scenario === 'inside' || scenario === 'cancel-accepted'
        ? (stop + profit) / 2
        : scenario === 'target'
          ? profit
          : stop
    let marketReads = 0
    const finalizedAt: number[] = []
    const defect = new Error('Pending entry source defect')
    const typedFailure = new OperationalError({
      component: 'market-data',
      operation: 'snapshot',
      message: 'Pending entry source contract failed',
      retryable: false,
    })
    const market: IntradayMarketDataService = marketWith((query) =>
      Effect.suspend(() => {
        marketReads += 1
        if (scenario === 'pending') return Effect.fail(marketFailure)
        if (scenario === 'typed-error') return Effect.fail(typedFailure)
        if (scenario === 'defect') return Effect.die(defect)
        if (scenario === 'timeout' || scenario === 'near-expiry' || scenario === 'interruption') return Effect.never
        const raw = makeIntradayMomentumTestSnapshot(
          native.protocol,
          { ...query, archiveWatermarks: [] },
          { AAPL: 0.02 },
          10,
        )
        const snapshot = streamingFixtureFromRaw(
          {
            ...raw,
            quotes: raw.quotes.map((quote) => ({
              ...quote,
              eventAt:
                scenario === 'stale'
                  ? new Date(Date.parse(checkAt) - native.protocol.maximumQuoteAgeMs + 1).toISOString()
                  : quote.eventAt,
              bidPrice: bid,
              askPrice: bid + (scenario === 'wide-stop' ? 1 : 0.001),
              bidSize: scenario === 'missing-bid' ? 0 : quote.bidSize,
              askSize: scenario === 'missing-ask' ? 0 : quote.askSize,
            })),
          },
          query,
        ).snapshot
        return Effect.succeed(
          scenario === 'malformed'
            ? { ...snapshot, manifest: { ...snapshot.manifest, contentHash: '0'.repeat(64) } }
            : snapshot,
        )
      }).pipe(
        Effect.ensuring(
          Clock.currentTimeMillis.pipe(
            Effect.map((now) => {
              finalizedAt.push(now)
            }),
          ),
        ),
      ),
    )
    const unused = () => Effect.die(new Error('Pending entry must retain its immutable commit and mutation owner'))
    const cancel: MutationEvent = {
      ...accepted,
      sequence: 3,
      operation: MutationOperation.Cancel,
      eventType: MutationEventType.CancelAccepted,
      occurredAt: checkAt,
    }
    const program = prepareMutationIntent(
      { ...request.input, intradayMarketData: market },
      request.preparation,
      request.policy,
      request.cycle,
      document,
      Effect.succeed(reconciliation),
      true,
      false,
      {
        now:
          scenario === 'timeout' || scenario === 'near-expiry' || scenario === 'interruption'
            ? currentUtcInstant
            : Effect.sync(() =>
                scenario === 'stale' && marketReads > 0 ? new Date(Date.parse(checkAt) + 2).toISOString() : checkAt,
              ),
        restrictAuthority: unused,
        readFacts: () =>
          Effect.succeed({
            snapshot: {
              contentHash: document.bindings.snapshotContentHash,
              finalizedAt: document.bindings.snapshotFinalizedAt,
            },
            reconciliation,
            authority,
            evaluatedAt: checkAt,
          }),
      },
    ).pipe(
      withFixtureIntentStore({
        ...noProtection,
        read: () => Effect.succeed(Option.some(record)),
        commitClosing: unused,
      }),
      withFixtureMutationStore({
        latest: (_id: string, operation: MutationOperation) =>
          Effect.succeed(
            operation === MutationOperation.Submit ? accepted : scenario === 'cancel-accepted' ? cancel : undefined,
          ),
      }),
      Effect.result,
    )
    const exit = await runWithConstruction(
      Effect.gen(function* () {
        yield* TestClock.setTime(Date.parse(checkAt))
        const fiber = yield* program.pipe(Effect.forkChild({ startImmediately: true }))
        if (scenario === 'timeout' || scenario === 'near-expiry' || scenario === 'interruption') {
          yield* Effect.yieldNow
          expect(marketReads).toBe(1)
          expect(finalizedAt).toEqual([])
          if (scenario === 'interruption') yield* Fiber.interrupt(fiber)
          else {
            const budget = Math.min(
              native.protocol.maximumQuoteAgeMs,
              Date.parse(risk.evaluation.decision.expiresAt) - Date.parse(checkAt),
            )
            yield* TestClock.adjust(budget - 1)
            expect(finalizedAt).toEqual([])
            yield* TestClock.adjust(1)
            expect(finalizedAt).toEqual([Date.parse(checkAt) + budget])
            expect(finalizedAt[0]).toBeLessThanOrEqual(Date.parse(risk.evaluation.decision.expiresAt))
          }
        }
        return yield* Fiber.await(fiber)
      }).pipe(Effect.provide(TestClock.layer())),
    )
    expect(finalizedAt).toHaveLength(marketReads)
    if (scenario === 'defect' || scenario === 'interruption') {
      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) {
        if (scenario === 'defect') expect(Cause.squash(exit.cause)).toBe(defect)
        else expect(Cause.hasInterruptsOnly(exit.cause)).toBe(true)
      }
      expect(marketReads).toBe(1)
      return
    }
    if (Exit.isFailure(exit)) throw Cause.squash(exit.cause)
    const outcome = exit.value
    if (scenario === 'malformed' || scenario === 'typed-error') {
      expect(Result.isFailure(outcome)).toBe(true)
      if (Result.isFailure(outcome))
        expect(outcome.failure.message).toBe('Pending entry boundary evidence could not be verified')
    } else {
      expect(Result.getOrThrow(outcome)).toEqual(
        scenario === 'cancel-accepted'
          ? { _tag: 'Wait', observedAt: checkAt, waitReason: 'MUTATION_RECOVERY_BACKOFF' }
          : scenario === 'inside' ||
              scenario === 'pending' ||
              scenario === 'wide-stop' ||
              scenario === 'stale' ||
              scenario === 'missing-bid' ||
              scenario === 'missing-ask'
            ? { _tag: 'Wait', observedAt: checkAt, waitReason: 'intent-nonterminal' }
            : {
                _tag: 'Execute',
                action: 'CANCEL',
                intentId: intent.intentId,
                observedAt:
                  scenario === 'timeout' || scenario === 'near-expiry' ? risk.evaluation.decision.expiresAt : checkAt,
              },
      )
    }
    expect(marketReads).toBe(scenario === 'partial' || scenario === 'cancel-accepted' || scenario === 'expired' ? 0 : 1)
  })

  test.each([
    'profit',
    'stop',
    'holding',
    'released-profit',
    'released-stop',
    'pending-before-holding',
    'pending-at-stop',
    'partial-at-stop',
    'pending-stop-stale',
    'pending-stop-wrong-symbol',
    'pending-stop-wrong-source',
    'pending-stop-malformed',
    'pending-stop-unavailable',
    'pending-stop-error',
    'pending-stop-no-position',
    'pending-stop-inexact-accounting',
    'pending-stop-nonprofit',
    'pending-at-holding',
    'partial-at-holding',
  ] as const)('profit close preserves its price and mandatory exits: %s', async (scenario) => {
    const request = await fixture()
    const entry = request.entryDocument.strategyDecision
    if (entry?.schemaVersion !== 'bayn.jev-entry-target.v7') throw new Error('Expected a Jev entry')
    const plan = entry.exitPolicy.plans['AAPL']
    if (plan === undefined || plan.levels.schemaVersion !== 'bayn.jev-strategy-exit-plan.v4')
      throw new Error('Expected an entry-bound long plan')
    const floor = Number(plan.levels.profitLimitPriceMicros) / 1_000_000
    const pending = scenario.startsWith('pending-') || scenario.startsWith('partial-')
    const observedAt = new Date(
      Date.parse(at) +
        (pending
          ? scenario.includes('stop')
            ? 60_000
            : native.protocol.maximumHoldingMinutes * 60_000 - 1_500
          : 1_000),
    ).toISOString()
    const snapshotAt = (query: Parameters<IntradayMarketDataService['loadSnapshot']>[0], bid: number) => {
      const raw = makeIntradayMomentumTestSnapshot(
        native.protocol,
        { ...query, archiveWatermarks: [] },
        { AAPL: 0.02 },
        10,
      )
      return streamingFixtureFromRaw(
        {
          ...raw,
          quotes: raw.quotes.map((quote) =>
            quote.symbol === 'AAPL' ? { ...quote, bidPrice: bid, askPrice: bid + 0.01 } : quote,
          ),
        },
        query,
      ).snapshot
    }
    const query = Result.getOrThrow(
      jevPricingQuery(
        request.cycle,
        native.protocol,
        native.query.calendar,
        observedAt,
        ['AAPL'],
        IntradaySnapshotPurpose.Liquidation,
      ),
    )
    const stopBid = Number(plan.levels.stopPriceMicros) / 1_000_000
    const trigger = snapshotAt(query, scenario === 'pending-stop-nonprofit' ? stopBid : floor)
    const portfolio = structuredClone(managed)
    if (portfolio.purpose !== JevPurpose.Manage) throw new Error('Expected a managed portfolio')
    const fill = portfolio.entryFills[0]
    if (fill === undefined) throw new Error('Expected an entry fill')
    const quantity = BigInt(plan.maximumQuantityAtoms)
    const priceAtoms = BigInt(plan.levels.maximumEntryPriceMicros) * 1000n
    const cost = (quantity * priceAtoms) / 1_000_000_000_000n
    const makeHeldFacts = (observedAt: string) => {
      const originalFacts = factsAt(observedAt, true)
      const state = {
        ...originalFacts.brokerState,
        orders: originalFacts.brokerState.orders.map((order) => ({
          ...order,
          quantityAtoms: String(quantity + 1n),
          filledQuantityAtoms: String(quantity),
        })),
        positions: originalFacts.brokerState.positions.map((position) => ({
          ...position,
          quantityAtoms: String(quantity),
          costBasisMicros: String(cost),
        })),
      }
      return withBrokerCut(originalFacts, state)
    }
    const heldFacts = makeHeldFacts(observedAt)
    const triggeredTarget = Result.getOrThrow(
      decideJevExit({
        cycleId: request.cycle.identity.cycleId,
        sessionDate: request.cycle.identity.executionSessionDate,
        protocol: native.protocol,
        portfolio: {
          ...portfolio,
          entryDecisionHash: request.entryDocument.contentHash,
          exitPolicy: entry.exitPolicy,
          entryFills: [{ ...fill, quantityAtoms: String(quantity), priceAtoms: String(priceAtoms), occurredAt: at }],
          brokerState: heldFacts.brokerState,
        },
        observedAt,
        trigger: {
          reason: scenario === 'pending-stop-nonprofit' ? JevExitReason.ProtectiveStop : JevExitReason.ProfitTarget,
          manifest: trigger.manifest,
          rows: Result.getOrThrow(persistIntradayRecordRows(trigger)),
        },
      }),
    )
    const exitTarget = scenario.startsWith('released-')
      ? Result.getOrThrow(
          decideJevExit({
            ...triggeredTarget.evidence,
            portfolio: {
              ...portfolio,
              ...triggeredTarget.evidence.portfolio,
              exitRequestedAt: observedAt,
              profitExitRequested: scenario === 'released-profit',
            },
            trigger: { reason: JevExitReason.ProtectionReleased },
          }),
        )
      : triggeredTarget
    const expectProfitFloor =
      scenario !== 'stop' &&
      scenario !== 'holding' &&
      scenario !== 'released-stop' &&
      scenario !== 'pending-stop-nonprofit'
    const buildAt =
      scenario === 'holding'
        ? new Date(Date.parse(at) + native.protocol.maximumHoldingMinutes * 60_000).toISOString()
        : observedAt
    const bid = scenario === 'stop' || scenario === 'pending-stop-nonprofit' ? stopBid : floor - 0.01
    const result = await runWithConstruction(
      atTestTime(Date.parse(buildAt), () =>
        prepareClosingExecutionCycleDecision({
          ...request,
          exitTarget,
          ...(scenario === 'holding' ? { replanGenerationHash: 'f'.repeat(64) } : {}),
          reconcile: Effect.succeed(makeHeldFacts(buildAt)),
          input: {
            ...request.input,
            intradayMarketData: marketWith((pricing) => Effect.succeed(snapshotAt(pricing, bid))),
          },
        }),
      ).pipe(Effect.provide(entryInferenceFixtureLayer), Effect.provide(TestClock.layer())),
    )
    expect(result.document.dispatchable).toBe(true)
    const risk = result.document.deltaRisk[0]
    const target = result.document.targetPlan.intentTargets[0]
    if (risk === undefined || target === undefined) throw new Error('Expected a priced close')
    if (expectProfitFloor) {
      expect(risk.limitPriceMicros).toBe(plan.levels.profitLimitPriceMicros)
      expect(BigInt(result.document.targetPlan.targets[0]?.referencePriceMicros ?? '0')).toBeLessThan(
        BigInt(risk.limitPriceMicros),
      )
    } else {
      expect(BigInt(risk.limitPriceMicros ?? '0')).toBeLessThan(BigInt(plan.levels.profitLimitPriceMicros))
      expect(Number(risk.limitPriceMicros) / 1_000_000).toBeLessThanOrEqual(bid)
    }
    const order = Result.getOrThrow(
      orderRequestBody({
        ...target,
        clientOrderId: 'b1_' + 'A'.repeat(43),
        limitPriceMicros: risk.limitPriceMicros,
        notionalLimitMicros: risk.notionalLimitMicros,
      }),
    )
    expect(Number(order.limit_price)).toBe(Number(risk.limitPriceMicros) / 1_000_000)
    if (expectProfitFloor) expect(Number(order.limit_price)).toBe(floor)
    if (!pending) return
    const authority = heldFacts.riskContext.authority
    if (authority === null) throw new Error('Expected close authority')
    const intent = await runWithConstruction(
      planExecutionIntent(
        {
          schemaVersion: 'bayn.intent-plan.v3',
          ...target,
          limitPriceMicros: risk.limitPriceMicros,
          notionalLimitMicros: risk.notionalLimitMicros,
          createdAt: result.document.createdAt,
        },
        { authority },
      ),
    )
    const accepted: MutationEvent = {
      schemaVersion: 'bayn.paper-mutation-event.v1',
      eventId: '1'.repeat(64),
      mutationId: '2'.repeat(64),
      intentId: intent.intentId,
      sequence: 2,
      operation: MutationOperation.Submit,
      eventType: MutationEventType.SubmitAccepted,
      requestHash: Result.getOrThrow(canonicalHashV1Result(Result.getOrThrow(orderRequestBody(intent)))),
      consistencyDelayMs: 1_000,
      brokerOrderId: 'unfilled-profit-limit',
      occurredAt: buildAt,
    }
    const open = Result.getOrThrow(decidePreparedMutationIntent(intent, accepted))
    if (open._tag !== 'Pending') throw new Error('Expected acknowledged profit order')
    const checkAt = new Date(
      Date.parse(buildAt) + (scenario === 'pending-at-holding' || scenario === 'partial-at-holding' ? 1_500 : 1_499),
    ).toISOString()
    expect(Date.parse(checkAt)).toBeLessThan(Date.parse(risk.evaluation.decision.expiresAt))
    expect(Date.parse(checkAt)).toBeLessThan(Date.parse(result.document.submissionCutoffAt))
    const record: StoredIntent = {
      intent: { ...intent, state: IntentState.Acknowledged, riskDecisionId: risk.evaluation.decision.decisionId },
      decision: risk.evaluation.decision,
      stateVersion: 3,
      updatedAt: buildAt,
    }
    const freshFacts = makeHeldFacts(checkAt)
    const filled = scenario.startsWith('partial-') ? quantity / 2n : 0n
    const positionState = {
      ...freshFacts.brokerState,
      positions: freshFacts.brokerState.positions.map((position) => ({
        ...position,
        quantityAtoms: scenario === 'pending-stop-no-position' ? '0' : String(quantity - filled),
        costBasisMicros:
          scenario === 'pending-stop-no-position'
            ? '0'
            : String(((quantity - filled) * priceAtoms) / 1_000_000_000_000n),
      })),
      orders: [
        ...freshFacts.brokerState.orders,
        {
          ...open.order,
          status: filled === 0n ? OrderStatus.New : OrderStatus.PartiallyFilled,
          filledQuantityAtoms: String(filled),
          observedAt: checkAt,
        },
      ],
    }
    const hash = Result.getOrThrow(reconciledStateHash(positionState))
    const exact = { ...positionState.reconciliation, expectedHash: hash, observedHash: hash }
    const reconciliation = {
      ...freshFacts,
      brokerState: { ...positionState, reconciliation: exact },
      report: {
        ...freshFacts.report,
        reconciliation: exact,
        metrics: { ...freshFacts.report.metrics, accountingExact: scenario !== 'pending-stop-inexact-accounting' },
      },
    }
    for (const allowSubmit of [true, false]) {
      const unused = () => Effect.die(new Error('Pending profit must use its existing immutable commit'))
      let marketReads = 0
      const stopMarket: IntradayMarketDataService = marketWith((pricing) =>
        Effect.suspend(() => {
          marketReads += 1
          if (scenario === 'pending-stop-unavailable') return Effect.fail(marketFailure)
          if (scenario === 'pending-stop-error')
            return Effect.fail(
              new OperationalError({
                component: 'market-data',
                operation: 'snapshot',
                message: 'Fixture source contract failure',
                retryable: false,
                cause: { _tag: 'FixtureContractFailure' },
              }),
            )
          const source = scenario === 'pending-stop-wrong-symbol' ? { ...pricing, symbols: ['AMD'] } : pricing
          const snapshot = snapshotAt(source, scenario === 'pending-before-holding' ? floor - 0.01 : stopBid)
          return Effect.succeed(
            scenario === 'pending-stop-wrong-source'
              ? { ...snapshot, manifest: { ...snapshot.manifest, universeId: 'unrelated-source' } }
              : scenario === 'pending-stop-malformed'
                ? { ...snapshot, manifest: { ...snapshot.manifest, contentHash: '0'.repeat(64) } }
                : snapshot,
          )
        }),
      )
      const outcome = await runWithConstruction(
        prepareMutationIntent(
          {
            ...request.input,
            intradayMarketData: stopMarket,
            mutationPhase: 'CLOSE',
            executionCycleCloseSubmitCutoffAt: result.document.submissionCutoffAt,
            executionCycleCloseExpiresAt: result.document.expiresAt,
          },
          request.preparation,
          request.policy,
          request.cycle,
          result.document,
          Effect.succeed(reconciliation),
          allowSubmit,
          false,
          {
            now: Effect.sync(() =>
              scenario === 'pending-stop-stale' && marketReads > 0
                ? new Date(Date.parse(checkAt) + native.protocol.maximumQuoteAgeMs + 1).toISOString()
                : checkAt,
            ),
            restrictAuthority: unused,
            readFacts: () =>
              Effect.succeed({
                snapshot: {
                  contentHash: result.document.bindings.snapshotContentHash,
                  finalizedAt: result.document.bindings.snapshotFinalizedAt,
                },
                reconciliation,
                authority: { ...authority, updatedAt: checkAt },
                evaluatedAt: checkAt,
              }),
          },
        ).pipe(
          withFixtureIntentStore({
            ...noProtection,
            read: () => Effect.succeed(Option.some(record)),
            commitClosing: unused,
          }),
          withFixtureMutationStore({
            latest: (_intentId: string, operation: MutationOperation) =>
              Effect.succeed(operation === MutationOperation.Submit ? accepted : undefined),
          }),
          Effect.result,
        ),
      )
      if (
        [
          'pending-stop-stale',
          'pending-stop-wrong-symbol',
          'pending-stop-wrong-source',
          'pending-stop-malformed',
          'pending-stop-error',
        ].includes(scenario)
      ) {
        expect(Result.isFailure(outcome)).toBe(true)
        if (Result.isSuccess(outcome)) throw new Error('Invalid stop evidence selected an action')
        expect(outcome.failure.message).toBe('Pending profit stop evidence could not be verified')
        expect(marketReads).toBe(1)
        continue
      }
      const step = Result.getOrThrow(outcome)
      expect(step).toEqual(
        [
          'pending-before-holding',
          'pending-stop-unavailable',
          'pending-stop-no-position',
          'pending-stop-inexact-accounting',
          'pending-stop-nonprofit',
        ].includes(scenario)
          ? { _tag: 'Wait', observedAt: checkAt, waitReason: 'intent-nonterminal' }
          : { _tag: 'Execute', action: 'CANCEL', intentId: intent.intentId, observedAt: checkAt },
      )
      expect(marketReads).toBe(
        [
          'pending-at-holding',
          'partial-at-holding',
          'pending-stop-no-position',
          'pending-stop-inexact-accounting',
          'pending-stop-nonprofit',
        ].includes(scenario)
          ? 0
          : 1,
      )
    }
    if (scenario !== 'partial-at-stop') return
    // A stop releases only the resting remainder. A rebound cannot create another
    // order before cancellation settles, and the current-bid contract restores the floor.
    const closure = Result.getOrThrow(
      makeExecutionCycleClosure({
        schemaVersion: legacyCycleClosureSchemaVersion,
        cycleId: request.cycle.identity.cycleId,
        entryDecisionHash: request.entryDocument.contentHash,
        document: result.document,
        createdAt: result.document.createdAt,
        expiresAt: result.document.expiresAt,
      }),
    )
    let terminal = false
    let settled = false
    let replans = 0
    const unused = () => Effect.die(new Error('Stop recovery must not create another broker mutation'))
    const reboundAt = new Date(Date.parse(checkAt) + 1_000).toISOString()
    const settledState = {
      ...positionState,
      account: { ...positionState.account, observedAt: reboundAt },
      positions: positionState.positions.map((position) => ({ ...position, observedAt: reboundAt })),
      positionsObservedAt: reboundAt,
      ordersObservedAt: reboundAt,
      orders: positionState.orders.map((order) => ({ ...order, status: OrderStatus.Canceled, observedAt: reboundAt })),
    }
    const recovered = withBrokerCut(reconciliation, settledState, { reconciledAt: reboundAt })
    const closureStore: ExecutionCycleClosureStoreShape = {
      read: () => Effect.succeed(Option.some(closure)),
      readLatestReplan: () => Effect.succeed(Option.none()),
      bind: unused,
      bindReplan: (value) =>
        Effect.sync(() => {
          replans += 1
          return value
        }),
      containsIntent: () => Effect.succeed(true),
    }
    await runWithConstruction(
      Effect.gen(function* () {
        yield* TestClock.setTime(Date.parse(reboundAt))
        const reconcile = Effect.suspend(() => Effect.succeed(settled ? recovered : reconciliation))
        const recover = ensureExecutionCycleClosure({
          ...request,
          input: {
            ...request.input,
            executionCycleClosureStore: closureStore,
            intradayMarketData: marketWith((pricing) => Effect.succeed(snapshotAt(pricing, floor - 0.01))),
          },
          closeWindow: {
            startAt: result.document.createdAt,
            submitCutoffAt: result.document.submissionCutoffAt,
            expiresAt: result.document.expiresAt,
          },
          existing: closure,
          reconcile,
          refreshReconciliation: reconcile,
        })
        const pending = yield* recover
        expect(pending._tag).toBe('Close')
        if (pending._tag !== 'Close') throw new Error('Expected the immutable pending close')
        expect(pending.document.contentHash).toBe(result.document.contentHash)
        expect(replans).toBe(0)
        terminal = true
        expect(yield* recover).toMatchObject({ _tag: 'Wait', waitReason: 'COMPLETION_EVIDENCE_PENDING' })
        expect(replans).toBe(0)
        settled = true
        const replacement = yield* recover
        expect(replacement._tag).toBe('Close')
        if (replacement._tag !== 'Close') throw new Error('Expected a fresh residual close')
        expect(replans).toBe(1)
        expect(replacement.document.replanGenerationHash).toBe(closure.contentHash)
        expect(replacement.document.deltaRisk[0]?.limitPriceMicros).toBe(plan.levels.profitLimitPriceMicros)
        expect(replacement.document.targetPlan.intentTargets[0]?.quantityAtoms).toBe(String(quantity - filled))
        expect(replacement.document.orderedIntentIds).not.toEqual(result.document.orderedIntentIds)
      }).pipe(
        Effect.provide(entryInferenceFixtureLayer),
        Effect.provide(TestClock.layer()),
        withFixtureIntentStore({
          ...noProtection,
          read: () =>
            Effect.sync(() =>
              Option.some(
                terminal
                  ? {
                      ...record,
                      intent: {
                        ...record.intent,
                        state: IntentState.Terminal,
                        terminalOutcome: TerminalOutcome.Canceled,
                      },
                      updatedAt: reboundAt,
                    }
                  : record,
              ),
            ),
          commitClosing: unused,
        }),
        withFixtureMutationStore({
          latest: () => Effect.succeed(accepted),
        }),
      ),
    )
  })

  test('an equity-calendar recovery closes an external crypto holding with IOC', async () => {
    const request = await fixture()
    const observedAt = new Date(Date.parse(request.closeExpiresAt) - 60_000).toISOString()
    const facts = factsAt(observedAt, true)
    const state = {
      ...facts.brokerState,
      positions: facts.brokerState.positions.map((position) => ({ ...position, symbol: 'BTC/USD' })),
    }
    const stateHash = Result.getOrThrow(reconciledStateHash(state))
    const reconciliation = { ...state.reconciliation, expectedHash: stateHash, observedHash: stateHash }
    const result = await runWithConstruction(
      atTestTime(Date.parse(observedAt), () =>
        prepareClosingExecutionCycleDecision({
          ...request,
          reconcile: Effect.succeed({
            ...facts,
            brokerState: { ...state, reconciliation },
            report: { ...facts.report, reconciliation },
          }),
          input: {
            ...request.input,
            intradayMarketData: marketWith(() => Effect.die('An external holding uses reconciled position evidence')),
          },
        }),
      ).pipe(Effect.provide(entryInferenceFixtureLayer), Effect.provide(TestClock.layer())),
    )
    expect(result.document.dispatchable).toBe(true)
    expect(result.document.targetPlan.intentTargets).toMatchObject([
      { symbol: 'BTC/USD', orderType: OrderType.Limit, timeInForce: TimeInForce.ImmediateOrCancel },
    ])
  })

  test('an expired equity cycle closes from fresh reconciled positions during verified broker extended hours', async () => {
    const day = Schema.decodeUnknownSync(IsoDateSchema)(native.query.sessionDate)
    const calendarSource = Result.getOrThrow(
      normalizeMarketCalendarResult(
        Schema.decodeUnknownSync(MarketCalendarResponseSchema)([
          { date: day, open: '09:30', close: '16:00', session_open: '0400', session_close: '2000' },
        ]),
        { start: day, end: day },
      ),
    )
    const extended = nativeJevFixture(
      JevPurpose.Entry,
      at,
      accountId,
      native.protocol,
      'a'.repeat(64),
      { AAPL: 0.02, AMZN: 0.01 },
      calendarSource,
    )
    const request = await fixture(extended)
    const calendar = request.entryDocument.executionSession?.calendar
    if (calendar === undefined) throw new Error('Expected bound calendar')
    const observedAt = new Date(Date.parse(request.cycle.window.executionCloseAt) + 60_000).toISOString()
    const expiry = executionCloseRecoveryExpiry(calendar, observedAt)
    if (expiry === null) throw new Error('Expected broker extended hours')
    const closed = await runWithConstruction(
      atTestTime(Date.parse(observedAt), () =>
        prepareClosingExecutionCycleDecision({
          ...request,
          closeExpiresAt: expiry,
          reconcile: Effect.succeed(factsAt(observedAt, true)),
          input: {
            ...request.input,
            intradayMarketData: marketWith(() =>
              Effect.die('An expired IEX session cannot supply a fresh strategy quote'),
            ),
          },
        }),
      ).pipe(Effect.provide(entryInferenceFixtureLayer), Effect.provide(TestClock.layer())),
    )
    expect(closed.document.dispatchable).toBe(true)
    expect(closed.document.expiresAt).toBe(expiry)
    expect(closed.document.targetPlan.executionTerms).toMatchObject({
      executionPurpose: 'forced-close',
      orderType: OrderType.Limit,
      timeInForce: TimeInForce.Day,
      priceReference: 'reconciled-broker-position-mark',
    })
    expect(closed.document.targetPlan.intentTargets).toMatchObject([
      { side: OrderSide.Sell, symbol: 'AAPL', quantityAtoms: '5000000000' },
    ])
  })
  test.each(['cash-discrepancy', 'inexact-accounting', 'unknown-mutation', 'unknown-order'] as const)(
    'an inexact reconciliation waits before binding a close and recovers with exact evidence (%s)',
    async (scenario) => {
      const request = await fixture()
      const closeWindow = fixtureCloseWindow(request)
      let closure: ExecutionCycleClosure | undefined
      let archiveReads = 0
      const unused = () => Effect.die('reconciliation wait must not read or mutate intents')
      const store: ExecutionCycleClosureStoreShape = {
        read: unused,
        readLatestReplan: unused,
        bind: (value) =>
          Effect.sync(() => {
            closure = value
            return value
          }),
        bindReplan: unused,
        containsIntent: unused,
      }
      const input = {
        ...request.input,
        executionCycleClosureStore: store,
        intradayMarketData: marketWith((query: Parameters<IntradayMarketDataService['loadSnapshot']>[0]) =>
          Effect.sync(() => {
            archiveReads += 1
          }).pipe(Effect.andThen(freshMarket.loadSnapshot(query))),
        ),
      }
      await runWithConstruction(
        Effect.gen(function* () {
          yield* TestClock.setTime(Date.parse(closeWindow.startAt) + 1_000)
          const at = yield* currentUtcInstant
          const base = factsAt(at, true)
          const reconciliation = {
            ...base.brokerState.reconciliation,
            status: scenario === 'cash-discrepancy' ? ReconciliationStatus.Discrepancy : ReconciliationStatus.Exact,
          }
          const facts = {
            ...base,
            brokerState: {
              ...base.brokerState,
              reconciliation,
              unknownOrderCount: scenario === 'unknown-order' ? 1 : 0,
            },
            riskContext: { ...base.riskContext, unknownMutationCount: scenario === 'unknown-mutation' ? 1 : 0 },
            report: {
              ...base.report,
              reconciliation,
              metrics: {
                ...base.report.metrics,
                accountingExact: scenario !== 'inexact-accounting',
                discrepancyCount: scenario === 'cash-discrepancy' ? 1 : 0,
              },
            },
          }
          const failure = yield* Effect.flip(
            prepareClosingExecutionCycleDecision({
              ...request,
              input,
              reconcile: Effect.succeed(facts),
              initialReconciliation: facts,
            }),
          )
          expect(failure).toBeInstanceOf(ExecutionCloseAwaitingReconciliation)
          const close = (reconciled: ReconciliationPassResult) =>
            ensureExecutionCycleClosure({
              ...request,
              input,
              closeWindow,
              reconcile: Effect.succeed(reconciled),
              refreshReconciliation: unused(),
              existing: undefined,
            })
          expect(yield* close(facts)).toEqual({
            _tag: 'Wait',
            observedAt: at,
            waitReason: 'CLOSE_RECONCILIATION_PENDING',
          })
          expect(archiveReads).toBe(0)
          expect(closure).toBeUndefined()
          expect(
            executionEvidenceContinuationDelayMs(
              {
                outcome: 'RECOVERED',
                action: 'WAITING',
                observedAt: at,
                cycle: request.cycle,
                waitReason: 'CLOSE_RECONCILIATION_PENDING',
              },
              30_000,
              at,
            ),
          ).toBeUndefined()
          expect((yield* close(base))._tag).toBe('Close')
          expect(closure).toBeDefined()
          expect(archiveReads).toBeGreaterThan(0)
        }).pipe(
          withFixtureIntentStore({
            ...noProtection,
            commitClosing: unused,
          }),
          withFixtureMutationStore(),
          Effect.provide(entryInferenceFixtureLayer),
          Effect.provide(TestClock.layer()),
        ),
      )
    },
  )
  test.each([
    'filled',
    'filled reuses preflight',
    'filled refreshes older preflight',
    'filled refreshes unknown preflight',
    'filled refreshes inexact preflight',
    'denied',
    'unknown',
    'inexact-accounting',
    'failed-refresh',
    'pending-refresh',
    'invalid-refresh',
    'older-cut',
    'fallback-flat',
    'fallback-flat-exit',
  ] as const)('terminal close uses fresh settlement evidence before another action (%s)', async (scenario) => {
    const fallbackFlat = scenario.startsWith('fallback-flat')
    const request = await fixture()
    const closeWindow = fixtureCloseWindow(request)
    const records = new Map<string, StoredIntent>()
    let closure: ExecutionCycleClosure | undefined
    let retainedReplan: ExecutionCycleClosure | undefined
    let residualBinds = 0
    let freshReads = 0
    const store: ExecutionCycleClosureStoreShape = {
      read: () => Effect.sync(() => Option.fromUndefinedOr(closure)),
      readLatestReplan: () => Effect.sync(() => Option.fromUndefinedOr(retainedReplan)),
      bind: (value) =>
        Effect.sync(() => {
          closure = value
          return value
        }),
      bindReplan: (value) =>
        Effect.sync(() => {
          residualBinds += 1
          return value
        }),
      containsIntent: () => Effect.succeed(true),
    }
    await runWithConstruction(
      Effect.gen(function* () {
        yield* TestClock.setTime(Date.parse(closeWindow.startAt) + 1_000)
        const before = yield* currentUtcInstant
        const exitTarget =
          scenario === 'fallback-flat-exit'
            ? Result.getOrThrow(
                decideJevExit({
                  cycleId: request.cycle.identity.cycleId,
                  sessionDate: request.cycle.identity.executionSessionDate,
                  protocol: native.protocol,
                  portfolio: {
                    ...structuredClone(managed),
                    entryDecisionHash: request.entryDocument.contentHash,
                    brokerState: factsAt(before, true).brokerState,
                  },
                  observedAt: before,
                  trigger: { reason: JevExitReason.MaximumHold },
                }),
              )
            : undefined
        const initial = yield* ensureExecutionCycleClosure({
          ...request,
          input: { ...request.input, executionCycleClosureStore: store },
          closeWindow,
          reconcile: Effect.succeed(factsAt(before, true)),
          refreshReconciliation: Effect.die('an uncommitted close has no terminal evidence to refresh'),
          existing: undefined,
          ...(exitTarget === undefined ? {} : { exitTarget }),
        })
        if (initial._tag !== 'Close' || closure === undefined) throw new Error('missing committed close fixture')
        if (exitTarget !== undefined) expect(initial.document.strategyDecision).toEqual(exitTarget)
        yield* TestClock.adjust(1_000)
        const terminalAt = yield* currentUtcInstant
        if (scenario === 'denied') {
          const replan = yield* prepareClosingExecutionCycleDecision({
            ...request,
            reconcile: Effect.succeed(factsAt(terminalAt, true)),
            initialReconciliation: factsAt(terminalAt, true),
            replanGenerationHash: closure.contentHash,
          })
          retainedReplan = yield* Effect.fromResult(
            makeExecutionCycleClosure({
              schemaVersion: 'bayn.paper-cycle-closure.v1',
              cycleId: request.cycle.identity.cycleId,
              entryDecisionHash: request.entryDocument.contentHash,
              document: replan.document,
              createdAt: replan.document.createdAt,
              expiresAt: request.closeExpiresAt,
            }),
          )
        }
        for (const [document, terminalOutcome] of [
          [request.entryDocument, TerminalOutcome.Filled],
          [initial.document, TerminalOutcome.Filled],
          ...(retainedReplan === undefined ? [] : [[retainedReplan.document, TerminalOutcome.Rejected] as const]),
        ] as const) {
          const authority = factsAt(document.createdAt).riskContext.authority
          if (authority === null) throw new Error('missing fixture authority')
          for (const [index, target] of document.targetPlan.intentTargets.entries()) {
            const risk = document.deltaRisk[index]
            if (risk === undefined) throw new Error('missing fixture risk binding')
            const intent = yield* planExecutionIntent(
              {
                schemaVersion: 'bayn.intent-plan.v3',
                ...target,
                notionalLimitMicros: risk.notionalLimitMicros,
                limitPriceMicros: risk.limitPriceMicros,
                ...(risk.protection === undefined ? {} : { protection: risk.protection }),
                ...(document.replanGenerationHash === undefined
                  ? {}
                  : { replanGenerationHash: document.replanGenerationHash }),
                createdAt: document.createdAt,
              },
              { authority },
            )
            records.set(intent.intentId, {
              intent: {
                ...intent,
                state: IntentState.Terminal,
                terminalOutcome,
                riskDecisionId: risk.evaluation.decision.decisionId,
              },
              decision: risk.evaluation.decision,
              stateVersion: 5,
              updatedAt: terminalAt,
            })
          }
        }
        const expectedIntentCount = scenario === 'denied' ? 3 : 2
        expect(records.size).toBe(expectedIntentCount)
        const fresh = factsAt(scenario === 'older-cut' ? before : terminalAt)
        const refreshReconciliation = Effect.suspend(() => {
          freshReads += 1
          if (fallbackFlat && freshReads <= 4 && freshReads % 2 === 1) return Effect.succeed(factsAt(terminalAt, true))
          if (scenario === 'failed-refresh' || scenario === 'pending-refresh' || scenario === 'invalid-refresh')
            return Effect.fail(
              new BrokerReadError({
                operation: 'preflight',
                kind:
                  scenario === 'pending-refresh'
                    ? BrokerReadErrorKind.ObservationPending
                    : scenario === 'failed-refresh'
                      ? BrokerReadErrorKind.Transport
                      : BrokerReadErrorKind.InvalidResponse,
                message: 'synthetic terminal-close refresh unavailable',
                retryable: scenario !== 'invalid-refresh',
              }),
            )
          return Effect.succeed(
            scenario === 'inexact-accounting'
              ? { ...fresh, report: { ...fresh.report, metrics: { ...fresh.report.metrics, accountingExact: false } } }
              : scenario === 'unknown'
                ? { ...fresh, riskContext: { ...fresh.riskContext, unknownMutationCount: 1 } }
                : fresh,
          )
        })
        const preflight =
          scenario === 'filled refreshes older preflight'
            ? factsAt(before)
            : scenario === 'filled refreshes unknown preflight'
              ? { ...fresh, riskContext: { ...fresh.riskContext, unknownMutationCount: 1 } }
              : scenario === 'filled refreshes inexact preflight'
                ? {
                    ...fresh,
                    report: { ...fresh.report, metrics: { ...fresh.report.metrics, accountingExact: false } },
                  }
                : fresh
        if (fresh.riskContext.authority === null) throw new Error('fixture authority missing')
        const terminalReconciliation = yield* reconciliationForPreparation(
          preflight,
          refreshReconciliation,
          Effect.succeed(fresh.riskContext.authority),
          30_000,
        )
        const recoverClose = ensureExecutionCycleClosure({
          ...request,
          input: {
            ...request.input,
            executionCycleClosureStore: store,
            ...(fallbackFlat ? { intradayMarketData: unavailableMarket } : {}),
          },
          closeWindow,
          reconcile: scenario.startsWith('filled ') ? terminalReconciliation.read : refreshReconciliation,
          refreshReconciliation: scenario.startsWith('filled ')
            ? terminalReconciliation.refresh
            : refreshReconciliation,
          existing: closure,
        })
        for (let pass = 0; pass < (fallbackFlat ? 3 : 2); pass++) {
          const result = yield* Effect.exit(recoverClose)
          if (scenario === 'invalid-refresh') expect(Exit.isFailure(result)).toBe(true)
          else {
            if (Exit.isFailure(result)) throw new Error('terminal close fixture unexpectedly failed')
            expect(result.value._tag).toBe(
              scenario.startsWith('filled') || scenario === 'denied' || (fallbackFlat && pass === 2)
                ? 'Complete'
                : 'Wait',
            )
            if (result.value._tag === 'Wait' && !fallbackFlat) {
              if (result.value.waitReason === undefined) throw new Error('Expected a lifecycle publication wait')
              const pending = scenario === 'pending-refresh' || scenario === 'older-cut'
              expect(result.value.waitReason).toBe(
                pending ? 'BROKER_OBSERVATION_PENDING' : 'COMPLETION_EVIDENCE_PENDING',
              )
              expect(
                executionEvidenceContinuationDelayMs(
                  {
                    outcome: 'RECOVERED',
                    action: 'WAITING',
                    cycle: request.cycle,
                    observedAt: result.value.observedAt,
                    waitReason: result.value.waitReason,
                  },
                  30_000,
                  result.value.observedAt,
                ),
              ).toBeUndefined()
            }
          }
          expect(freshReads).toBe(
            scenario === 'filled reuses preflight'
              ? 0
              : scenario.startsWith('filled refreshes')
                ? 1
                : fallbackFlat
                  ? Math.min((pass + 1) * 2, 5)
                  : scenario === 'unknown' || scenario === 'inexact-accounting' || scenario === 'older-cut'
                    ? (pass + 1) * 2
                    : pass + 1,
          )
          expect(residualBinds).toBe(0)
          expect(records.size).toBe(expectedIntentCount)
        }
      }).pipe(
        withFixtureIntentStore({
          ...noProtection,
          read: (id) => Effect.sync(() => Option.fromUndefinedOr(records.get(id))),
          commit: () => Effect.die('terminal close must not commit another intent'),
          commitClosing: () => Effect.die('terminal close must not commit another close'),
        }),
        withFixtureMutationStore({
          latest: () => Effect.as(Effect.void, undefined),
        }),
        Effect.provide(entryInferenceFixtureLayer),
        Effect.provide(TestClock.layer()),
      ),
    )
  })

  test.each([
    'expiry',
    'partial fill',
    'partial fill reuses preflight',
    'cached residual refreshes after archive failure',
    'partial fill without archive',
    'fallback becomes unknown',
    'fallback loses accounting',
    'fallback becomes older',
    'fallback regresses after settlement',
    'fallback read fails',
    'fallback read is invalid',
  ] as const)('residual close uses fresh remaining exposure after %s', async (scenario) => {
    const terminalOutcome = scenario === 'expiry' ? TerminalOutcome.Expired : TerminalOutcome.Canceled
    const unavailableArchive =
      scenario !== 'expiry' && scenario !== 'partial fill' && scenario !== 'partial fill reuses preflight'
    const request = await fixture()
    const closeWindow = fixtureCloseWindow(request)
    const records = new Map<string, StoredIntent>()
    let closure: ExecutionCycleClosure | undefined
    let replan: ExecutionCycleClosure | undefined
    let closeCommits = 0
    let restrictions = 0
    let closeSettled = false
    let positionDivisor = 2n
    const store: ExecutionCycleClosureStoreShape = {
      read: () => Effect.sync(() => Option.fromUndefinedOr(closure)),
      readLatestReplan: () => Effect.sync(() => Option.fromUndefinedOr(replan)),
      bind: (value) =>
        Effect.sync(() => {
          closure = value
          return value
        }),
      bindReplan: (value) =>
        Effect.sync(() => {
          replan = value
          return value
        }),
      containsIntent: (id) =>
        Effect.sync(() =>
          [...(closure?.document.orderedIntentIds ?? []), ...(replan?.document.orderedIntentIds ?? [])].includes(id),
        ),
    }
    await runWithConstruction(
      Effect.gen(function* () {
        yield* TestClock.setTime(Date.parse(closeWindow.startAt) + 1_000)
        const reconcile = Effect.gen(function* () {
          const facts = factsAt(yield* currentUtcInstant, true)
          if (!closeSettled || terminalOutcome !== TerminalOutcome.Canceled) return facts
          const positions = facts.brokerState.positions.map((position) => ({
            ...position,
            quantityAtoms: (BigInt(position.quantityAtoms) / positionDivisor).toString(),
            marketValueMicros: (BigInt(position.marketValueMicros) / positionDivisor).toString(),
          }))
          const releasedValue = facts.brokerState.positions.reduce(
            (sum, position) =>
              sum + BigInt(position.marketValueMicros) - BigInt(position.marketValueMicros) / positionDivisor,
            0n,
          )
          const state = {
            ...facts.brokerState,
            positions,
            account: {
              ...facts.brokerState.account,
              cashMicros: (BigInt(facts.brokerState.account.cashMicros) + releasedValue).toString(),
              buyingPowerMicros: (BigInt(facts.brokerState.account.buyingPowerMicros) + releasedValue).toString(),
            },
          }
          return withBrokerCut(facts, state)
        })
        const prepare = (document: NonNullable<typeof closure>['document']) =>
          prepareMutationIntent(
            {
              accountId,
              authorityGenerationHash: generationHash,
              mutationPhase: 'CLOSE',
              executionCycleCloseSubmitCutoffAt: closeWindow.submitCutoffAt,
              executionCycleCloseExpiresAt: closeWindow.expiresAt,
            },
            request.preparation,
            request.policy,
            request.cycle,
            document,
            reconcile,
            true,
            false,
            {
              now: currentUtcInstant,
              readFacts: () =>
                Effect.gen(function* () {
                  const evaluatedAt = yield* currentUtcInstant
                  const reconciliation = yield* reconcile
                  const authority = reconciliation.riskContext.authority
                  if (authority === null) throw new Error('missing existing close authority')
                  return {
                    snapshot: {
                      contentHash: document.bindings.snapshotContentHash,
                      finalizedAt: document.bindings.snapshotFinalizedAt,
                    },
                    reconciliation,
                    authority,
                    evaluatedAt,
                  }
                }),
              restrictAuthority: () =>
                Effect.sync(() => {
                  restrictions += 1
                }),
            },
          )
        const first = yield* ensureExecutionCycleClosure({
          ...request,
          input: { ...request.input, executionCycleClosureStore: store },
          closeWindow,
          reconcile,
          refreshReconciliation: reconcile,
          existing: undefined,
        })
        if (first._tag !== 'Close') throw new Error('fresh owned position should produce a close')
        const selected = yield* prepare(first.document)
        expect(selected).toMatchObject({
          _tag: 'Execute',
          action: 'SUBMIT',
          intentId: first.document.orderedIntentIds[0],
        })
        expect(closeCommits).toBe(1)
        const prior = records.get(first.document.orderedIntentIds[0] ?? '')
        if (prior === undefined || closure === undefined) throw new Error('missing first committed close')
        records.set(prior.intent.intentId, {
          ...prior,
          intent: { ...prior.intent, state: IntentState.Terminal, terminalOutcome },
          stateVersion: prior.stateVersion + 1,
          updatedAt: new Date(Date.parse(first.document.createdAt) + 1_000).toISOString(),
        })
        closeSettled = true
        const expiredAt = first.document.deltaRisk[0]?.evaluation.decision.expiresAt
        if (expiredAt === undefined) throw new Error('missing original close risk deadline')
        yield* TestClock.setTime(Date.parse(first.document.createdAt) + 2_000)
        expect(Date.parse(yield* currentUtcInstant)).toBeLessThan(Date.parse(expiredAt))
        const stale = yield* prepare(first.document)
        expect(stale).toMatchObject({ _tag: 'Wait', waitReason: 'intent-unsuccessful' })
        expect(closeCommits).toBe(1)
        let unstableFallback = scenario.startsWith('fallback')
        let residualReads = 0
        const refreshResidual = reconcile.pipe(
          Effect.flatMap((facts) => {
            residualReads += 1
            if (!unstableFallback || residualReads % 2 === 1) return Effect.succeed(facts)
            if (scenario === 'fallback read fails' || scenario === 'fallback read is invalid')
              return Effect.fail(
                new BrokerReadError({
                  operation: 'preflight',
                  kind:
                    scenario === 'fallback read fails'
                      ? BrokerReadErrorKind.Timeout
                      : BrokerReadErrorKind.InvalidResponse,
                  message: 'synthetic residual fallback read failure',
                  retryable: scenario === 'fallback read fails',
                }),
              )
            if (scenario === 'fallback becomes unknown')
              return Effect.succeed({ ...facts, riskContext: { ...facts.riskContext, unknownMutationCount: 1 } })
            if (scenario === 'fallback loses accounting')
              return Effect.succeed({
                ...facts,
                report: { ...facts.report, metrics: { ...facts.report.metrics, accountingExact: false } },
              })
            return Effect.succeed(
              factsAt(
                scenario === 'fallback regresses after settlement'
                  ? new Date(Date.parse(first.document.createdAt) + 1_000).toISOString()
                  : first.document.createdAt,
                true,
              ),
            )
          }),
        )
        const residualReconciliation = yield* reconciliationForPreparation(
          yield* reconcile,
          refreshResidual,
          reconcile.pipe(
            Effect.map((facts) => {
              if (facts.riskContext.authority === null) throw new Error('fixture authority missing')
              return facts.riskContext.authority
            }),
          ),
          30_000,
        )
        const recoverResidual = ensureExecutionCycleClosure({
          ...request,
          input: {
            ...request.input,
            executionCycleClosureStore: store,
            ...(unavailableArchive
              ? {
                  intradayMarketData: marketWith(() =>
                    Effect.sync(() => {
                      if (scenario === 'cached residual refreshes after archive failure') positionDivisor = 4n
                    }).pipe(Effect.andThen(Effect.fail(marketFailure))),
                  ),
                }
              : {}),
          },
          closeWindow,
          reconcile:
            scenario === 'partial fill reuses preflight' ||
            scenario === 'cached residual refreshes after archive failure'
              ? residualReconciliation.read
              : refreshResidual,
          refreshReconciliation: refreshResidual,
          existing: closure,
        })
        if (scenario === 'fallback read is invalid') {
          expect(Exit.isFailure(yield* Effect.exit(recoverResidual))).toBe(true)
          expect(replan).toBeUndefined()
          expect(closeCommits).toBe(1)
          unstableFallback = false
        }
        let next = yield* recoverResidual
        if (unstableFallback) {
          expect(next).toMatchObject({ _tag: 'Wait', waitReason: 'COMPLETION_EVIDENCE_PENDING' })
          expect(replan).toBeUndefined()
          expect(closeCommits).toBe(1)
          expect((yield* recoverResidual)._tag).toBe('Wait')
          expect(replan).toBeUndefined()
          unstableFallback = false
          next = yield* recoverResidual
        }
        if (next._tag !== 'Close') throw new Error('remaining owned position should produce a residual replan')
        expect(next.document.replanGenerationHash).toBe(closure.contentHash)
        expect(next.document.bindings.authorityGenerationHash).toBe(first.document.bindings.authorityGenerationHash)
        expect(next.document.orderedIntentIds).not.toEqual(first.document.orderedIntentIds)
        expect(
          next.document.targetPlan.intentTargets.map(({ symbol, side, quantityAtoms }) => ({
            symbol,
            side,
            quantityAtoms,
          })),
        ).toEqual(
          first.document.targetPlan.intentTargets.map(({ symbol, side, quantityAtoms }) => ({
            symbol,
            side,
            quantityAtoms:
              terminalOutcome === TerminalOutcome.Canceled
                ? (BigInt(quantityAtoms) / positionDivisor).toString()
                : quantityAtoms,
          })),
        )
        expect(yield* prepare(next.document)).toMatchObject({
          _tag: 'Execute',
          action: 'SUBMIT',
          intentId: next.document.orderedIntentIds[0],
        })
        expect(closeCommits).toBe(2)
        expect(restrictions).toBe(1)
        if (scenario === 'partial fill reuses preflight') expect(residualReads).toBe(0)
        if (scenario === 'cached residual refreshes after archive failure') expect(residualReads).toBe(1)
        yield* TestClock.setTime(Date.parse(closeWindow.expiresAt))
        expect(yield* prepare(next.document)).toMatchObject({
          _tag: 'Block',
          reason: 'BLOCKED_MISSED_SUBMISSION_DEADLINE',
        })
        expect(closeCommits).toBe(2)
      }).pipe(
        withFixtureIntentStore({
          ...noProtection,
          read: (id) => Effect.sync(() => Option.fromUndefinedOr(records.get(id))),
          commit: () => Effect.die(new Error('residual close cannot use entry commit authority')),
          commitClosing: (intent, decision) =>
            Effect.sync(() => {
              closeCommits += 1
              const record: StoredIntent = {
                intent: { ...intent, state: IntentState.Approved, riskDecisionId: decision.decisionId },
                decision,
                stateVersion: 2,
                updatedAt: intent.createdAt,
              }
              records.set(intent.intentId, record)
              return { record, deduplicated: false }
            }),
        }),
        withFixtureMutationStore({
          latest: () => Effect.as(Effect.void, undefined),
        }),
        Effect.provide(entryInferenceFixtureLayer),
        Effect.provide(TestClock.layer()),
      ),
    )
  })

  test.each([undefined, 5_000])(
    'a failed post-pass projection check owns its retry delay (%s)',
    async (failureDelay) => {
      const result = {
        outcome: 'RECOVERED',
        action: 'WAITING',
        waitReason: 'CLOSE_QUOTE_PENDING',
        observedAt: at,
        cycle: activeCycle,
      } as const
      const advanced = {
        result,
        observation: {
          result: 'SUCCESS',
          outcome: 'RECOVERED',
          recoveryAction: 'WAITING',
          waitReason: 'CLOSE_QUOTE_PENDING',
          observedAt: at,
        } as const,
        nextDelayMs: 1_000,
        nextWakeAt: new Date(Date.parse(at) + 1_000).toISOString(),
      }
      let checks = 0
      const checked = checkAdvancedMarketProjection(
        advanced,
        Effect.sync(() => {
          checks += 1
        }).pipe(Effect.andThen(Effect.fail(marketFailure))),
        (error) => {
          expect(error.cause).toBe(marketFailure)
          return Effect.succeed({
            observation: {
              result: 'FAILURE',
              observedAt: at,
              operation: error.operation,
              failure: error.failure,
              message: error.message,
            },
            ...(failureDelay === undefined ? {} : { nextDelayMs: failureDelay }),
          })
        },
      )
      const outcome = await runWithConstruction(
        advanceExecutionOnce(
          {
            controllerKey: 'a'.repeat(64),
            epoch: 1,
            sequence: 0,
            issuedAt: at,
            sourceRevision: 'd'.repeat(40),
          },
          { advance: checked, nextDelayMs: 30_000 },
        ),
      )
      expect(checks).toBe(1)
      expect(outcome).toMatchObject({
        _tag: 'Blocked',
        nextDelayMs: failureDelay ?? 30_000,
        observation: { result: 'FAILURE', failure: 'market-data' },
      })
      expect(outcome).not.toHaveProperty('nextWakeAt')
    },
  )

  test('successful projection validation preserves the completed pass', async () => {
    const advanced = {
      observation: {
        result: 'SUCCESS',
        outcome: 'RECOVERED',
        recoveryAction: 'WAITING',
        waitReason: 'CLOSE_QUOTE_PENDING',
        observedAt: at,
      } as const,
      nextDelayMs: 1_000,
    }
    expect(
      await runWithConstruction(
        checkAdvancedMarketProjection(advanced, Effect.void, () =>
          Effect.die(new Error('successful health check cannot report a failure')),
        ),
      ),
    ).toBe(advanced)
  })

  test('quote scheduling uses completion time and the remaining session budget', async () => {
    const waiting = {
      outcome: 'RECOVERED',
      action: 'WAITING',
      waitReason: 'CLOSE_QUOTE_PENDING',
      observedAt: at,
      cycle: activeCycle,
    } as const
    const close = Date.parse(activeCycle.window.executionCloseAt)
    expect(executionEvidenceContinuationDelayMs(waiting, 30_000, new Date(close - 750).toISOString())).toBe(750)
    expect(executionEvidenceContinuationDelayMs(waiting, 30_000, new Date(close + 1).toISOString())).toBeUndefined()
    expect(
      executionEvidenceContinuationDelayMs(
        {
          outcome: 'RECOVERED',
          action: 'COMPLETED',
          observedAt: at,
          cycle: activeCycle,
        },
        30_000,
        at,
      ),
    ).toBeUndefined()
    await runWithConstruction(
      Effect.gen(function* () {
        yield* TestClock.setTime(close - 1)
        yield* checkAdvancedMarketProjection(
          {
            result: waiting,
            observation: { result: 'SUCCESS', outcome: 'RECOVERED', observedAt: at },
          },
          TestClock.setTime(close),
          () => Effect.die(new Error('unexpected failure')),
        )
        expect(executionEvidenceContinuationDelayMs(waiting, 30_000, yield* currentUtcInstant)).toBeUndefined()
      }).pipe(Effect.provide(entryInferenceFixtureLayer), Effect.provide(TestClock.layer())),
    )
  })

  test('the protection deadline catches a delayed close quote inside its original validity', async () => {
    const request = await fixture()
    const start = Date.parse(at) + 16 * 60_000 + 24_000
    const quoteEventAt = new Date(start + 3_100).toISOString()
    const quoteAvailableAt = start + 8_800
    const loadSnapshot: IntradayMarketDataService['loadSnapshot'] = (query) =>
      Effect.try({
        try: () => {
          const raw = makeIntradayMomentumTestSnapshot(
            native.protocol,
            { ...query, archiveWatermarks: [] },
            { AAPL: 0.02 },
            10,
          )
          const eventAt =
            Date.parse(query.observedAt) >= quoteAvailableAt ? quoteEventAt : new Date(start - 16_000).toISOString()
          return streamingFixtureFromRaw(
            {
              ...raw,
              quotes: raw.quotes.map((quote) => ({
                ...quote,
                eventAt,
                ingestedAt: new Date(Date.parse(eventAt) + 5_700).toISOString(),
              })),
            },
            query,
          ).snapshot
        },
        catch: (cause) =>
          retryableOperationalError({
            component: 'market-data',
            operation: 'snapshot',
            message: 'Fixture quote cut unavailable',
            cause,
          }),
      })
    const reconcile = Effect.gen(function* () {
      yield* TestClock.adjust(3_000)
      return factsAt(yield* currentUtcInstant, true)
    })
    await runWithConstruction(
      Effect.gen(function* () {
        yield* TestClock.setTime(start)
        const close = prepareClosingExecutionCycleDecision({
          ...request,
          input: { ...request.input, intradayMarketData: marketWith(loadSnapshot) },
          reconcile,
        })
        const first = yield* Effect.flip(close)
        expect(first).toMatchObject({ quotePending: true, readiness: { reason: 'SNAPSHOT_STALE', symbol: 'AAPL' } })
        const result = {
          outcome: 'RECOVERED',
          action: 'WAITING',
          waitReason: 'CLOSE_QUOTE_PENDING',
          observedAt: first instanceof ExecutionCloseAwaitingMarketData ? first.observedAt : '',
          cycle: request.cycle,
        } as const
        const nextDelayMs = executionEvidenceContinuationDelayMs(result, 30_000, yield* currentUtcInstant)
        expect(nextDelayMs).toBe(5_000)
        const command = {
          controllerKey: 'a'.repeat(64),
          epoch: 1,
          sequence: 0,
          issuedAt: result.observedAt,
          sourceRevision: 'd'.repeat(40),
        }
        const outcome = yield* advanceExecutionOnce(command, {
          advance: Effect.succeed({
            result,
            observation: {
              result: 'SUCCESS',
              outcome: 'RECOVERED',
              recoveryAction: 'WAITING',
              observedAt: result.observedAt,
              waitReason: 'CLOSE_QUOTE_PENDING',
            },
            ...(nextDelayMs === undefined
              ? {}
              : { nextDelayMs, nextWakeAt: new Date(start + 3_000 + nextDelayMs).toISOString() }),
          }),
          nextDelayMs: 30_000,
        })
        const activated = Result.getOrThrow(
          decideExecutionControllerActivation(null, {
            schemaVersion: 'bayn.execution-controller-activation.v1',
            controllerKey: command.controllerKey,
            epoch: 1,
            firstSequence: 0,
            planHash: 'b'.repeat(64),
            sourceRevision: command.sourceRevision,
          }),
        ).state
        expect(outcome._tag).toBe('Waiting')
        const completed = Result.getOrThrow(
          completeExecutionControllerTick(
            activated,
            { schemaVersion: 'bayn.execution-controller-tick.v1', epoch: 1, sequence: 0 },
            {
              completedAt: result.observedAt,
              outcome: {
                _tag: ExecutionControllerOutcome.Waiting,
                receiptHash: outcome.receiptHash,
                nextDelayMs: outcome.nextDelayMs,
                ...(outcome.nextWakeAt === undefined ? {} : { nextWakeAt: outcome.nextWakeAt }),
              },
            },
            command.sourceRevision,
          ),
        )
        const restarted = Result.getOrThrow(decodeExecutionControllerState(JSON.parse(JSON.stringify(completed))))
        expect(restarted.nextDueAt).toBe(new Date(start + 8_000).toISOString())
        expect(
          Result.getOrThrow(
            decideExecutionControllerTick(
              restarted,
              { schemaVersion: 'bayn.execution-controller-tick.v1', epoch: 1, sequence: 0 },
              command.controllerKey,
              command.sourceRevision,
            ),
          )._tag,
        ).toBe('Ignored')
        yield* TestClock.adjust(nextDelayMs ?? 30_000)
        const ready = yield* close
        expect(ready.document.dispatchable).toBe(true)
        expect(ready.document.targetPlan.intentTargets.every((target) => target.orderType === OrderType.Limit)).toBe(
          true,
        )
        expect(Date.parse(yield* currentUtcInstant) - Date.parse(quoteEventAt)).toBe(7_900)

        yield* TestClock.setTime(start + 3_000 + 30_000)
        const missed = yield* Effect.flip(close)
        expect(missed).toBeInstanceOf(ExecutionCloseAwaitingMarketData)
      }).pipe(Effect.provide(entryInferenceFixtureLayer), Effect.provide(TestClock.layer())),
    )
  })

  test('only quote-pending closes before the session deadline use a bounded continuation', () => {
    const waiting = {
      outcome: 'RECOVERED',
      action: 'WAITING',
      waitReason: 'CLOSE_QUOTE_PENDING',
      observedAt: at,
      cycle: activeCycle,
    } as const
    expect(executionEvidenceContinuationDelayMs(waiting, 500, at)).toBe(500)
    expect(
      executionEvidenceContinuationDelayMs({ ...waiting, waitReason: 'CLOSE_MARKET_DATA_UNAVAILABLE' }, 30_000, at),
    ).toBeUndefined()
    expect(
      executionEvidenceContinuationDelayMs({ ...waiting, waitReason: 'JEV_POSITION_HELD' }, 30_000, at),
    ).toBeUndefined()
    expect(executionEvidenceContinuationDelayMs(waiting, 30_000, activeCycle.window.executionCloseAt)).toBeUndefined()
  })

  test.each(['BROKER_OBSERVATION_PENDING', 'JEV_POSITION_AWAITING_RECONCILIATION'] as const)(
    'pending broker evidence %s preserves only a protection deadline',
    (waitReason) => {
      const waiting = {
        outcome: 'RECOVERED',
        action: 'WAITING',
        waitReason,
        observedAt: at,
        cycle: activeCycle,
      } as const
      expect(executionEvidenceContinuationDelayMs(waiting, 30_000, at)).toBe(
        waitReason === 'JEV_POSITION_AWAITING_RECONCILIATION' ? 5_000 : undefined,
      )
      expect(executionEvidenceContinuationDelayMs(waiting, 500, at)).toBe(
        waitReason === 'JEV_POSITION_AWAITING_RECONCILIATION' ? 500 : undefined,
      )
      const close = Date.parse(activeCycle.window.executionCloseAt)
      expect(executionEvidenceContinuationDelayMs(waiting, 30_000, new Date(close - 250).toISOString())).toBe(
        waitReason === 'JEV_POSITION_AWAITING_RECONCILIATION' ? 250 : undefined,
      )
      expect(executionEvidenceContinuationDelayMs(waiting, 30_000, activeCycle.window.executionCloseAt)).toBeUndefined()
      expect(
        executionEvidenceContinuationDelayMs({ ...waiting, waitReason: 'COMPLETION_EVIDENCE_PENDING' }, 30_000, at),
      ).toBeUndefined()
    },
  )

  test('verified protection publication uses the five-second continuation', () => {
    const waiting = {
      outcome: 'RECOVERED',
      action: 'WAITING',
      waitReason: 'PROTECTION_PUBLICATION_PENDING',
      observedAt: at,
      cycle: activeCycle,
    } as const
    expect(executionEvidenceContinuationDelayMs(waiting, 30_000, at)).toBe(5_000)
    expect(executionEvidenceContinuationDelayMs(waiting, 2_000, at)).toBe(2_000)
    const close = Date.parse(activeCycle.window.executionCloseAt)
    expect(executionEvidenceContinuationDelayMs(waiting, 30_000, new Date(close - 250).toISOString())).toBe(250)
    expect(executionEvidenceContinuationDelayMs(waiting, 30_000, activeCycle.window.executionCloseAt)).toBeUndefined()
  })

  test.each([
    'protective',
    'short-protective',
    'profit',
    'short-profit',
    'maximum-hold',
    'short-maximum-hold',
    'profit-hold-deadline',
    'short-profit-hold-deadline',
    'before-hold-profit',
    'before-hold-short-profit',
    'before-hold-maximum-hold',
    'deadline-foreign-cycle',
    'deadline-foreign-entry',
    'deadline-foreign-account',
    'deadline-altered-policy',
    'deadline-future-target',
    'deadline-unknown-order',
    'deadline-unknown-mutation',
    'deadline-open-protection',
    'deadline-stale-position',
    'deadline-inexact-reconciliation',
    'deadline-inexact-accounting',
    'deadline-missing-mark',
    'deadline-expired-lease',
    'deadline-target-expires-during-reconciliation',
    'missing-latch',
    'future-latch',
    'future-target',
    'foreign-cycle',
    'foreign-entry',
    'foreign-account',
    'altered-policy',
    'malformed-target',
    'unknown-order',
    'unknown-mutation',
    'open-protection',
    'stale-position',
    'inexact-reconciliation',
    'inexact-accounting',
    'missing-mark',
    'expired-lease',
    'invalid-archive',
    'target-expires-during-reconciliation',
  ] as const)('mandatory exit fallback before the session close window: %s', async (testScenario) => {
    const deadlineGuard = testScenario.startsWith('deadline-')
    const beforeHoldingDeadline = testScenario.startsWith('before-hold-')
    const scenario = deadlineGuard
      ? testScenario.slice('deadline-'.length)
      : beforeHoldingDeadline
        ? testScenario.slice('before-hold-'.length)
        : testScenario
    const fallbackReconciliationGuard =
      deadlineGuard &&
      [
        'unknown-order',
        'unknown-mutation',
        'open-protection',
        'stale-position',
        'inexact-reconciliation',
        'inexact-accounting',
        'missing-mark',
      ].includes(scenario)
    const request = await fixture()
    const short = scenario.startsWith('short-')
    const maximumHold = scenario === 'maximum-hold' || scenario === 'short-maximum-hold' || deadlineGuard
    const profitHoldDeadline = scenario === 'profit-hold-deadline' || scenario === 'short-profit-hold-deadline'
    const timedExit = maximumHold || profitHoldDeadline
    if (short) {
      const document = structuredClone(
        await (shortEntry ??= Effect.runPromise(makePersistenceDocumentFixture(accountId, 1, true))),
      )
      expect(document.bindings.cycleId).toBe(request.cycle.identity.cycleId)
      expect(document.bindings.strategyProtocolHash).toBe(request.cycle.identity.strategyProtocolHash)
      request.entryDocument = document
      request.cycle = {
        ...request.cycle,
        bindings: { snapshotId: document.bindings.snapshotId, decisionHash: document.contentHash },
      }
    }
    const entry = request.entryDocument.strategyDecision
    if (entry?.schemaVersion !== 'bayn.jev-entry-target.v7') throw new Error('Expected a Jev entry')
    const portfolio = structuredClone(managed)
    if (portfolio.purpose !== JevPurpose.Manage) throw new Error('Expected a managed portfolio')
    const plan = entry.exitPolicy.plans['AAPL']
    const fill = portfolio.entryFills[0]
    if (plan === undefined || fill === undefined) throw new Error('Expected an entry-bound plan and fill')
    const quantityAtoms = plan.maximumQuantityAtoms
    const priceMicros =
      plan.levels.schemaVersion === 'bayn.jev-short-strategy-exit-plan.v1'
        ? plan.levels.minimumEntryPriceMicros
        : plan.levels.maximumEntryPriceMicros
    const priceAtoms = String(BigInt(priceMicros) * 1000n)
    const signedQuantity = short ? -BigInt(quantityAtoms) : BigInt(quantityAtoms)
    const costBasisMicros = String((signedQuantity * BigInt(priceAtoms)) / 1_000_000_000_000n)
    const observedAt = new Date(
      Date.parse(at) + (beforeHoldingDeadline ? 899_999 : timedExit ? 900_000 : 60_000),
    ).toISOString()
    const facts = factsAt(observedAt, true)
    const state = {
      ...facts.brokerState,
      account: {
        ...facts.brokerState.account,
        ...(short
          ? { cashMicros: String(BigInt(facts.brokerState.account.equityMicros) - BigInt(costBasisMicros)) }
          : {}),
      },
      orders: facts.brokerState.orders.map((order) => ({
        ...order,
        side: short ? OrderSide.Sell : OrderSide.Buy,
        quantityAtoms: String(BigInt(quantityAtoms) + 1n),
        filledQuantityAtoms: quantityAtoms,
      })),
      positions: facts.brokerState.positions.map((position) => ({
        ...position,
        quantityAtoms: String(signedQuantity),
        averageEntryPriceMicros: priceMicros,
        marketPriceMicros: priceMicros,
        marketValueMicros: costBasisMicros,
        unrealizedPnlMicros: '0',
        costBasisMicros,
      })),
    }
    const heldFacts = withBrokerCut(facts, state)
    const exitTarget = Result.getOrThrow(
      decideJevExit({
        cycleId: request.cycle.identity.cycleId,
        sessionDate: request.cycle.identity.executionSessionDate,
        protocol: native.protocol,
        portfolio: {
          ...portfolio,
          entryDecisionHash: request.entryDocument.contentHash,
          exitPolicy: entry.exitPolicy,
          entryFills: [
            { ...fill, side: short ? OrderSide.Sell : OrderSide.Buy, quantityAtoms, priceAtoms, occurredAt: at },
          ],
          exitRequestedAt: maximumHold ? null : new Date(Date.parse(observedAt) - 1_000).toISOString(),
          profitExitRequested: scenario === 'profit' || scenario === 'short-profit' || profitHoldDeadline,
          brokerState: heldFacts.brokerState,
        },
        observedAt:
          beforeHoldingDeadline && maximumHold ? new Date(Date.parse(at) + 900_000).toISOString() : observedAt,
        trigger: {
          reason: maximumHold ? JevExitReason.MaximumHold : JevExitReason.ProtectionReleased,
        },
      }),
    )
    if (exitTarget.evidence.portfolio.purpose !== JevPurpose.Manage) throw new Error('Expected managed exit evidence')
    const exitPortfolio = exitTarget.evidence.portfolio
    if (beforeHoldingDeadline && maximumHold) {
      Object.assign(exitTarget, {
        observedAt,
        commitDeadlineAt: new Date(Date.parse(observedAt) + native.protocol.maximumQuoteAgeMs).toISOString(),
      })
      Object.assign(exitTarget.evidence, { observedAt })
      expect(Result.isSuccess(Schema.decodeUnknownResult(JevExitTargetSchema, strictParseOptions)(exitTarget))).toBe(
        false,
      )
    }
    if (scenario === 'missing-latch') Object.assign(exitTarget.evidence.portfolio, { exitRequestedAt: null })
    if (scenario === 'future-latch')
      Object.assign(exitTarget.evidence.portfolio, { exitRequestedAt: '2099-01-01T00:00:00.000Z' })
    if (scenario === 'future-target') Object.assign(exitTarget, { observedAt: '2099-01-01T00:00:00.000Z' })
    if (scenario === 'foreign-cycle')
      Object.assign(
        exitTarget,
        Result.getOrThrow(
          decideJevExit({
            ...exitTarget.evidence,
            cycleId: 'f'.repeat(64),
          }),
        ),
      )
    if (scenario === 'foreign-entry')
      Object.assign(
        exitTarget,
        Result.getOrThrow(
          decideJevExit({
            ...exitTarget.evidence,
            portfolio: { ...exitTarget.evidence.portfolio, entryDecisionHash: 'f'.repeat(64) },
          }),
        ),
      )
    if (scenario === 'foreign-cycle' || scenario === 'foreign-entry')
      expect(Result.isSuccess(Schema.decodeUnknownResult(JevExitTargetSchema, strictParseOptions)(exitTarget))).toBe(
        true,
      )
    if (scenario === 'foreign-account')
      Object.assign(exitTarget.evidence.portfolio.brokerState.account, { accountId: 'foreign-account' })
    if (scenario === 'altered-policy')
      Object.assign(exitTarget.evidence.portfolio.exitPolicy, { maximumHoldingMinutes: 14 })
    if (scenario === 'malformed-target') Object.assign(exitTarget, { commitDeadlineAt: 'not-an-instant' })
    const staleAt = new Date(Date.parse(observedAt) - request.policy.maxBrokerStateAgeMs - 1).toISOString()
    const currentState = {
      ...heldFacts.brokerState,
      unknownOrderCount: scenario === 'unknown-order' ? 1 : 0,
      orders: heldFacts.brokerState.orders.map((order) =>
        scenario === 'open-protection' ? { ...order, status: OrderStatus.New, filledQuantityAtoms: '0' } : order,
      ),
      positions: heldFacts.brokerState.positions.map((position) => ({
        ...position,
        ...(scenario === 'stale-position' ? { observedAt: staleAt } : {}),
        ...(scenario === 'missing-mark' ? { marketPriceMicros: '0' } : {}),
      })),
      positionsObservedAt: scenario === 'stale-position' ? staleAt : observedAt,
    }
    const currentHash = Result.getOrThrow(reconciledStateHash(currentState))
    const currentReconciliation = {
      ...heldFacts.report.reconciliation,
      expectedHash: currentHash,
      observedHash: currentHash,
      status: scenario === 'inexact-reconciliation' ? ReconciliationStatus.Discrepancy : ReconciliationStatus.Exact,
    }
    const currentFacts = {
      ...heldFacts,
      brokerState: { ...currentState, reconciliation: currentReconciliation },
      report: {
        ...heldFacts.report,
        reconciliation: currentReconciliation,
        metrics: { ...heldFacts.report.metrics, accountingExact: scenario !== 'inexact-accounting' },
      },
      riskContext: { ...heldFacts.riskContext, unknownMutationCount: scenario === 'unknown-mutation' ? 1 : 0 },
    }
    let latestFacts = currentFacts
    let recheckedAt = observedAt
    let reads = 0
    const result = await runWithConstruction(
      Effect.gen(function* () {
        yield* TestClock.setTime(Date.parse(scenario === 'expired-lease' ? request.closeExpiresAt : observedAt))
        const exerciseTimedManagement = timedExit && !deadlineGuard && !beforeHoldingDeadline
        const management = exerciseTimedManagement
          ? yield* evaluateJevPositionManagement({
              cycle: request.cycle,
              entryDecisionHash: request.entryDocument.contentHash,
              authorityGenerationHash: generationHash,
              protocol: native.protocol,
              calendar: native.snapshot.manifest.calendar,
              brokerState: heldFacts.brokerState,
              marketData: marketWith(() => Effect.die('A due holding deadline must not require archive prices')),
            }).pipe(Effect.provideService(JevPositionStore, { read: () => Effect.succeed(exitPortfolio) }))
          : undefined
        if (exerciseTimedManagement && management?._tag !== 'Exit') throw new Error('Expected mandatory position exit')
        if (management?._tag === 'Exit') expect(management.target).toEqual(exitTarget)
        return yield* prepareClosingExecutionCycleDecision({
          ...request,
          exitTarget: management?._tag === 'Exit' ? management.target : exitTarget,
          ...(fallbackReconciliationGuard ? { initialReconciliation: heldFacts } : {}),
          input: {
            ...request.input,
            intradayMarketData: marketWith(() =>
              scenario === 'invalid-archive'
                ? Effect.fail(
                    new OperationalError({
                      component: 'market-data',
                      operation: 'snapshot',
                      message: 'Invalid archive contract',
                      retryable: false,
                      cause: new Error('Invalid source'),
                    }),
                  )
                : Effect.fail(marketFailure),
            ),
          },
          reconcile: Effect.gen(function* () {
            reads += 1
            if (scenario === 'target-expires-during-reconciliation' && reads === 2) {
              yield* TestClock.adjust(native.protocol.maximumQuoteAgeMs + 1)
              recheckedAt = yield* currentUtcInstant
              const refreshedState = {
                ...currentState,
                account: { ...currentState.account, observedAt: recheckedAt },
                positions: currentState.positions.map((position) => ({ ...position, observedAt: recheckedAt })),
                orders: currentState.orders.map((order) => ({ ...order, observedAt: recheckedAt })),
                positionsObservedAt: recheckedAt,
                ordersObservedAt: recheckedAt,
              }
              const refreshedHash = Result.getOrThrow(reconciledStateHash(refreshedState))
              const refreshedReconciliation = {
                ...currentReconciliation,
                reconciledAt: recheckedAt,
                expectedHash: refreshedHash,
                observedHash: refreshedHash,
              }
              latestFacts = {
                ...currentFacts,
                brokerState: { ...refreshedState, reconciliation: refreshedReconciliation },
                report: { ...currentFacts.report, reconciliation: refreshedReconciliation },
              }
            }
            return latestFacts
          }),
        })
      }).pipe(Effect.exit, Effect.provide(entryInferenceFixtureLayer), Effect.provide(TestClock.layer())),
    )
    if (scenario === 'target-expires-during-reconciliation') {
      expect(Exit.isFailure(result)).toBe(true)
      expect(reads).toBe(2)
      const renewedTarget = Result.getOrThrow(
        decideJevExit({
          ...exitTarget.evidence,
          portfolio: { ...exitTarget.evidence.portfolio, brokerState: latestFacts.brokerState },
          observedAt: recheckedAt,
        }),
      )
      const renewed = await runWithConstruction(
        atTestTime(Date.parse(recheckedAt), () =>
          prepareClosingExecutionCycleDecision({
            ...request,
            exitTarget: renewedTarget,
            reconcile: Effect.succeed(latestFacts),
            input: {
              ...request.input,
              intradayMarketData: unavailableMarket,
            },
          }),
        ).pipe(Effect.provide(entryInferenceFixtureLayer), Effect.provide(TestClock.layer())),
      )
      expect(renewedTarget.observedAt).toBe(recheckedAt)
      expect(renewedTarget.commitDeadlineAt > exitTarget.commitDeadlineAt).toBe(true)
      expect(renewed.document.targetPlan.status).toBe(TargetPlanStatus.Planned)
      return
    }
    if (
      (scenario !== 'protective' && scenario !== 'short-protective' && !timedExit) ||
      deadlineGuard ||
      beforeHoldingDeadline
    ) {
      expect(Exit.isFailure(result) || result.value.document.targetPlan.status !== TargetPlanStatus.Planned).toBe(true)
      if (fallbackReconciliationGuard) expect(reads).toBe(1)
      if (
        scenario === 'profit' ||
        scenario === 'short-profit' ||
        scenario === 'invalid-archive' ||
        scenario === 'foreign-entry' ||
        scenario === 'foreign-cycle'
      )
        expect(reads).toBe(1)
      return
    }
    if (Exit.isFailure(result)) throw result.cause
    const prepared = result.value
    expect(reads).toBe(2)
    expect(prepared.document.targetPlan.status).toBe(TargetPlanStatus.Planned)
    expect(prepared.document.strategyDecision).toEqual(exitTarget)
    expect(prepared.document.bindings.executionMarketData).toMatchObject({
      source: 'alpaca-v2-positions',
      purpose: IntradaySnapshotPurpose.Liquidation,
      observedAt,
    })
    expect(prepared.document.targetPlan.executionTerms).toMatchObject({
      executionPurpose: 'forced-close',
      priceReference: 'reconciled-broker-position-mark',
    })
    expect(prepared.document.targetPlan.intentTargets).toHaveLength(1)
    expect(prepared.document.targetPlan.intentTargets[0]?.side).toBe(short ? OrderSide.Buy : OrderSide.Sell)
    expect(prepared.document.targetPlan.intentTargets[0]?.quantityAtoms).toBe(quantityAtoms)
    if (profitHoldDeadline) {
      const intent = prepared.document.deltaRisk[0]
      if (intent?.limitPriceMicros === undefined) throw new Error('Expected a priced mandatory close')
      // Time releases the original profit restriction; a mark never creates a new stop trigger.
      expect(
        short
          ? BigInt(intent.limitPriceMicros) > BigInt(plan.levels.profitLimitPriceMicros)
          : BigInt(intent.limitPriceMicros) < BigInt(plan.levels.profitLimitPriceMicros),
      ).toBe(true)
    }
  })

  test('an unavailable intraday cut preserves its cause without a second reconciliation', async () => {
    const request = await fixture()
    let reads = 0
    const failure = await runWithConstruction(
      atTestTime(Date.parse(at) + 60_000, () =>
        Effect.flip(
          prepareClosingExecutionCycleDecision({
            ...request,
            input: {
              ...request.input,
              intradayMarketData: unavailableMarket,
            },
            reconcile: currentUtcInstant.pipe(
              Effect.map((now) => {
                reads += 1
                return factsAt(now, true)
              }),
            ),
          }),
        ),
      ).pipe(Effect.provide(entryInferenceFixtureLayer), Effect.provide(TestClock.layer())),
    )
    expect(reads).toBe(1)
    expect(failure).toBeInstanceOf(ExecutionCloseAwaitingMarketData)
    expect(failure.cause).toBe(marketFailure)
    if (!(failure instanceof ExecutionCloseAwaitingMarketData)) throw new Error('Expected a close wait')
    expect(executionCloseMarketDataDiagnostics(failure)).toMatchObject({
      component: 'market-data',
      operation: 'snapshot',
      snapshotFailure: 'not-ready',
    })
    expect(failure).toMatchObject({
      message: marketFailure.message,
      readiness: { reason: 'SNAPSHOT_UNAVAILABLE', message: unavailable.message, symbol: 'AAPL' },
    })
  })

  test('an absent executable quote never receives the stale-quote continuation', async () => {
    const request = await fixture()
    const failure = await runWithConstruction(
      atTestTime(Date.parse(at) + 60_000, () =>
        Effect.flip(
          prepareClosingExecutionCycleDecision({
            ...request,
            input: {
              ...request.input,
              intradayMarketData: marketWith((query) =>
                freshMarket.loadSnapshot(query).pipe(Effect.map((snapshot) => ({ ...snapshot, latestQuotes: {} }))),
              ),
            },
            reconcile: currentUtcInstant.pipe(Effect.map((now) => factsAt(now, true))),
          }),
        ),
      ).pipe(Effect.provide(entryInferenceFixtureLayer), Effect.provide(TestClock.layer())),
    )
    expect(failure).toBeInstanceOf(ExecutionCloseAwaitingMarketData)
    expect(failure).toMatchObject({
      quotePending: false,
      readiness: { reason: 'SNAPSHOT_UNAVAILABLE', symbol: 'AAPL' },
      cause: { operation: 'close-quote-not-ready', symbol: 'AAPL' },
    })
  })

  test.each([0, -1])('fallback is allowed when the archive finishes at the window boundary (%ims)', async (offset) => {
    const request = await fixture()
    let reads = 0
    const start = Date.parse(request.cycle.window.executionCloseAt) - native.protocol.flattenBeforeCloseMinutes * 60_000
    const result = await runWithConstruction(
      atTestTime(start + offset, () =>
        prepareClosingExecutionCycleDecision({
          ...request,
          input: {
            ...request.input,
            intradayMarketData: marketWith(() =>
              TestClock.setTime(start).pipe(Effect.andThen(Effect.fail(marketFailure))),
            ),
          },
          reconcile: currentUtcInstant.pipe(
            Effect.map((now) => {
              reads += 1
              return factsAt(now, true)
            }),
          ),
        }),
      ).pipe(Effect.provide(entryInferenceFixtureLayer), Effect.provide(TestClock.layer())),
    )
    expect(reads).toBe(2)
    expect(result.document.bindings.executionMarketData?.schemaVersion).toBe(
      'bayn.reconciled-position-liquidation-binding.v1',
    )
    expect(
      result.document.targetPlan.intentTargets.every(
        (target) => target.orderType === OrderType.Limit && target.timeInForce === TimeInForce.Day,
      ),
    ).toBe(true)
  })

  test('the second boundary check still refuses a fallback that expires during reconciliation', async () => {
    const request = await fixture()
    let reads = 0
    const close = Date.parse(request.closeExpiresAt)
    const failure = await runWithConstruction(
      atTestTime(close - 1, () =>
        Effect.flip(
          prepareClosingExecutionCycleDecision({
            ...request,
            input: {
              ...request.input,
              intradayMarketData: unavailableMarket,
            },
            reconcile: Effect.gen(function* () {
              reads += 1
              if (reads === 2) yield* TestClock.setTime(close)
              return factsAt(yield* currentUtcInstant, true)
            }),
          }),
        ),
      ).pipe(Effect.provide(entryInferenceFixtureLayer), Effect.provide(TestClock.layer())),
    )
    expect(reads).toBe(2)
    expect(failure).toBeInstanceOf(ExecutionCloseAwaitingMarketData)
    expect(failure.message).toBe(marketFailure.message)
  })
})
import { longEntryBrokerReads } from '../testing/entry-broker-reads.test-support'
