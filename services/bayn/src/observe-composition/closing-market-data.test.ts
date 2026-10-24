import { MarketCalendarResponseSchema } from '../broker/alpaca/model'
import { normalizeMarketCalendarResult } from '../broker/alpaca/normalizers'
import { IsoDateSchema, strictParseOptions } from '../schemas'
import { executionCloseRecoveryExpiry } from '../market-hours'
import { describe, expect, test } from 'bun:test'
import { Clock, Effect, Exit, Option, Result, Schema } from 'effect'
import { TestClock } from 'effect/testing'

import { BrokerRead, type BrokerReadShape } from '../broker/alpaca/model'
import { BrokerReadError, BrokerReadErrorKind } from '../broker/alpaca/failures'
import { CycleState, AutonomousCycleSchema } from '../cycle/model'
import {
  Authority,
  IntentState,
  KillState,
  OrderType,
  OrderSide,
  OrderStatus,
  ReconciliationStatus,
  TerminalOutcome,
  TimeInForce,
} from '../execution/contracts'
import { IntentStore, planExecutionIntent, type StoredIntent } from '../execution/intents/domain'
import {
  MutationEventType,
  MutationStore,
  type MutationEvent,
  type MutationStoreShape,
} from '../execution/mutations/model'
import { MutationOperation } from '../broker/alpaca-mutations/model'
import { legacyCycleClosureSchemaVersion } from '../execution/legacy-wire'
import { canonicalHashV1Result } from '../hash'
import { decidePreparedMutationIntent } from './mutation-decisions'
import {
  makeExecutionCycleClosure,
  type ExecutionCycleClosure,
  type ExecutionCycleClosureStoreShape,
} from '../db/execution-cycle-closure'
import { ensureExecutionCycleClosure } from './execution-cycle'
import { resolveExecutionCycleCloseWindow } from './execution-window'
import { prepareMutationIntent } from './mutation-intent-interpreter'
import { JevBatchStore } from '../jev/batch-evaluation'
import { JevClient } from '../jev/client'
import { JevEvaluationStore } from '../jev/evaluation'
import { nativeJevBatchResult, nativeJevFixture } from '../jev/native.test-support'
import { JevPositionStore, JevPurpose } from '../jev/portfolio'
import { decideJevExit, JevExitReason } from '../jev/exit'
import { IntradaySnapshotPurpose, type IntradayMarketDataService } from '../market-data/intraday/model'
import { persistIntradayRecordRows } from '../market-data/intraday/verification'
import { jevPricingQuery } from '../jev/runtime'
import { orderRequestBody } from '../broker/alpaca-mutations/decisions'

import { IntradaySnapshotFailure } from '../market-data/intraday/model'
import { OperationalError, retryableOperationalError } from '../errors'
import { reconciledStateHash } from '../simulation-reconciliation/broker-model'
import { type ReconciliationPassResult } from '../reconciler'
import { loadStrategyExecutionRiskPolicy } from './startup'
import { makeJevMarketTestSnapshot as makeIntradayMomentumTestSnapshot } from '../testing/jev-market-fixture'
import { fixtureRuntime } from '../testing/runtime-fixtures'
import { fixtureStreamingReference, streamingFixtureFromRaw } from '../testing/streaming-market-fixture'
import { currentUtcInstant } from '../time'
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
  const source = held ? activeNativeFixture(JevPurpose.Manage).portfolio.brokerState : native.portfolio.brokerState
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

const fixture = async (source = native) => {
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
  const policy = await Effect.runPromise(loadStrategyExecutionRiskPolicy(accountId, fixtureRuntime))
  const unused = Effect.die(new Error('Unexpected fixture I/O'))
  const broker: BrokerReadShape = {
    account: unused,
    accountConfiguration: unused,
    assetBySymbol: () => unused,
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
  const document = await Effect.runPromise(
    Effect.gen(function* () {
      yield* TestClock.setTime(Date.parse(at))
      return yield* buildMutationShadowCycleDecision({
        authorityGenerationHash: generationHash,
        cycle: selectedCycle,
        executionModel: preparation.executionModel,
        policy,
        reconcile: Effect.succeed(factsAt(at)),
        strategy: fixtureRuntime,
        intradayMarketData: freshMarket,
      })
    }).pipe(
      Effect.provideService(BrokerRead, broker),
      Effect.provideService(CandidateObservationStore, {
        record: () => Effect.void,
        latestJevWindowEnd: () => Effect.succeed(Option.none()),
      }),
      Effect.provideService(JevBatchStore, {
        read: () => unused,
        pending: () => Effect.succeed([]),
        begin: (plan) =>
          Clock.currentTimeMillis.pipe(
            Effect.map((now) => ({
              plan,
              dispatches: [],
              result: nativeJevBatchResult(plan, new Date(now).toISOString(), (symbol) =>
                symbol === 'AAPL' ? 'enter' : 'wait',
              ),
            })),
          ),
        finish: () => unused,
      }),
      Effect.provideService(JevEvaluationStore, {
        read: () => unused,

        record: () => unused,
        abandon: () => unused,
      }),
      Effect.provideService(JevClient, { evaluate: () => unused }),
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

describe('closing market-data fallback boundaries', () => {
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
    if (entry?.schemaVersion !== 'bayn.jev-entry-target.v6') throw new Error('Expected a Jev entry')
    const plan = entry.exitPolicy.plans['AAPL']
    if (plan === undefined) throw new Error('Expected an entry-bound plan')
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
    const managed = activeNativeFixture(JevPurpose.Manage).portfolio
    if (managed.purpose !== JevPurpose.Manage) throw new Error('Expected a managed portfolio')
    const fill = managed.entryFills[0]
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
      const stateHash = Result.getOrThrow(reconciledStateHash(state))
      const reconciliation = { ...state.reconciliation, expectedHash: stateHash, observedHash: stateHash }
      return {
        ...originalFacts,
        brokerState: { ...state, reconciliation },
        report: { ...originalFacts.report, reconciliation },
      }
    }
    const heldFacts = makeHeldFacts(observedAt)
    const triggeredTarget = Result.getOrThrow(
      decideJevExit({
        cycleId: request.cycle.identity.cycleId,
        sessionDate: request.cycle.identity.executionSessionDate,
        protocol: native.protocol,
        portfolio: {
          ...managed,
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
              ...managed,
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
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        yield* TestClock.setTime(Date.parse(buildAt))
        return yield* prepareClosingExecutionCycleDecision({
          ...request,
          exitTarget,
          ...(scenario === 'holding' ? { replanGenerationHash: 'f'.repeat(64) } : {}),
          reconcile: Effect.succeed(makeHeldFacts(buildAt)),
          input: {
            ...request.input,
            intradayMarketData: { ...freshMarket, loadSnapshot: (pricing) => Effect.succeed(snapshotAt(pricing, bid)) },
          },
        })
      }).pipe(Effect.provide(TestClock.layer())),
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
    const intent = await Effect.runPromise(
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
      const stopMarket: IntradayMarketDataService = {
        ...freshMarket,
        loadSnapshot: (pricing) =>
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
      }
      const outcome = await Effect.runPromise(
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
          Effect.provideService(IntentStore, {
            protectionForCycle: () => Effect.succeed([]),
            beginProtectionCancel: unused,
            read: () => Effect.succeed(Option.some(record)),
            commit: unused,
            commitClosing: unused,
          }),
          Effect.provideService(MutationStore, {
            latest: (_intentId: string, operation: MutationOperation) =>
              Effect.succeed(operation === MutationOperation.Submit ? accepted : undefined),
          } as unknown as MutationStoreShape),
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
    const settledHash = Result.getOrThrow(reconciledStateHash(settledState))
    const settledReconciliation = {
      ...exact,
      reconciledAt: reboundAt,
      expectedHash: settledHash,
      observedHash: settledHash,
    }
    const recovered = {
      ...reconciliation,
      brokerState: { ...settledState, reconciliation: settledReconciliation },
      report: { ...reconciliation.report, reconciliation: settledReconciliation },
    }
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
    await Effect.runPromise(
      Effect.gen(function* () {
        yield* TestClock.setTime(Date.parse(reboundAt))
        const reconcile = Effect.suspend(() => Effect.succeed(settled ? recovered : reconciliation))
        const recover = ensureExecutionCycleClosure({
          ...request,
          input: {
            ...request.input,
            executionCycleClosureStore: closureStore,
            intradayMarketData: {
              ...freshMarket,
              loadSnapshot: (pricing) => Effect.succeed(snapshotAt(pricing, floor - 0.01)),
            },
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
        Effect.provide(TestClock.layer()),
        Effect.provideService(IntentStore, {
          protectionForCycle: () => Effect.succeed([]),
          beginProtectionCancel: unused,
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
          commit: unused,
          commitClosing: unused,
        }),
        Effect.provideService(MutationStore, {
          latest: () => Effect.succeed(accepted),
        } as unknown as MutationStoreShape),
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
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        yield* TestClock.setTime(Date.parse(observedAt))
        return yield* prepareClosingExecutionCycleDecision({
          ...request,
          reconcile: Effect.succeed({
            ...facts,
            brokerState: { ...state, reconciliation },
            report: { ...facts.report, reconciliation },
          }),
          input: {
            ...request.input,
            intradayMarketData: {
              ...freshMarket,
              loadSnapshot: () => Effect.die('An external holding uses reconciled position evidence'),
            },
          },
        })
      }).pipe(Effect.provide(TestClock.layer())),
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
    const closed = await Effect.runPromise(
      Effect.gen(function* () {
        yield* TestClock.setTime(Date.parse(observedAt))
        return yield* prepareClosingExecutionCycleDecision({
          ...request,
          closeExpiresAt: expiry,
          reconcile: Effect.succeed(factsAt(observedAt, true)),
          input: {
            ...request.input,
            intradayMarketData: {
              ...freshMarket,
              loadSnapshot: () => Effect.die('An expired IEX session cannot supply a fresh strategy quote'),
            },
          },
        })
      }).pipe(Effect.provide(TestClock.layer())),
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
      const closeWindow = Result.getOrThrow(
        resolveExecutionCycleCloseWindow({
          executionCalendarSchemaVersion: request.cycle.window.executionCalendarSchemaVersion,
          recoveryExpiresAt: null,
          observedAt: '2026-08-19T19:00:00.000Z',
          executionCloseAt: request.closeExpiresAt,
          sessionCloseStartLeadMs: native.protocol.flattenBeforeCloseMinutes * 60_000,
          sessionCloseSubmitLeadMs: native.protocol.hardFlatBeforeCloseMinutes * 60_000,
        }),
      )
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
        intradayMarketData: {
          ...freshMarket,
          loadSnapshot: (query: Parameters<IntradayMarketDataService['loadSnapshot']>[0]) =>
            Effect.sync(() => {
              archiveReads += 1
            }).pipe(Effect.andThen(freshMarket.loadSnapshot(query))),
        },
      }
      await Effect.runPromise(
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
          Effect.provideService(IntentStore, {
            protectionForCycle: () => Effect.succeed([]),
            beginProtectionCancel: () => Effect.die(new Error('unexpected protection cancellation')),
            read: unused,
            commit: unused,
            commitClosing: unused,
          }),
          Effect.provideService(MutationStore, {
            authorizeSubmit: unused,
            beginSubmit: unused,
            submitAccepted: unused,
            submitRejected: unused,
            submitDenied: unused,
            submitUnknown: unused,
            beginCancel: unused,
            cancelAccepted: unused,
            cancelUnknown: unused,
            recoveryFound: unused,
            recoveryNotFound: unused,
            recoveryUnknown: unused,
            latest: unused,
          }),
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
    const closeWindow = Result.getOrThrow(
      resolveExecutionCycleCloseWindow({
        executionCalendarSchemaVersion: request.cycle.window.executionCalendarSchemaVersion,
        recoveryExpiresAt: null,
        observedAt: '2026-08-19T19:00:00.000Z',
        executionCloseAt: request.closeExpiresAt,
        sessionCloseStartLeadMs: native.protocol.flattenBeforeCloseMinutes * 60_000,
        sessionCloseSubmitLeadMs: native.protocol.hardFlatBeforeCloseMinutes * 60_000,
      }),
    )
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
    await Effect.runPromise(
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
                    ...activeNativeFixture(JevPurpose.Manage).portfolio,
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
            ...(fallbackFlat
              ? { intradayMarketData: { ...freshMarket, loadSnapshot: () => Effect.fail(marketFailure) } }
              : {}),
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
              ).toBe(pending ? 1_000 : undefined)
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
        Effect.provideService(IntentStore, {
          protectionForCycle: () => Effect.succeed([]),
          beginProtectionCancel: () => Effect.die(new Error('unexpected protection cancellation')),
          read: (id) => Effect.sync(() => Option.fromUndefinedOr(records.get(id))),
          commit: () => Effect.die('terminal close must not commit another intent'),
          commitClosing: () => Effect.die('terminal close must not commit another close'),
        }),
        Effect.provideService(MutationStore, { latest: () => Effect.void } as unknown as MutationStoreShape),
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
    const closeWindow = Result.getOrThrow(
      resolveExecutionCycleCloseWindow({
        executionCalendarSchemaVersion: request.cycle.window.executionCalendarSchemaVersion,
        recoveryExpiresAt: null,
        observedAt: '2026-08-19T19:00:00.000Z',
        executionCloseAt: request.closeExpiresAt,
        sessionCloseStartLeadMs: native.protocol.flattenBeforeCloseMinutes * 60_000,
        sessionCloseSubmitLeadMs: native.protocol.hardFlatBeforeCloseMinutes * 60_000,
      }),
    )
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
    await Effect.runPromise(
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
          const hash = Result.getOrThrow(reconciledStateHash(state))
          const reconciliation = { ...state.reconciliation, expectedHash: hash, observedHash: hash }
          return { ...facts, brokerState: { ...state, reconciliation }, report: { ...facts.report, reconciliation } }
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
                  intradayMarketData: {
                    ...freshMarket,
                    loadSnapshot: () =>
                      Effect.sync(() => {
                        if (scenario === 'cached residual refreshes after archive failure') positionDivisor = 4n
                      }).pipe(Effect.andThen(Effect.fail(marketFailure))),
                  },
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
        Effect.provideService(IntentStore, {
          protectionForCycle: () => Effect.succeed([]),
          beginProtectionCancel: () => Effect.die(new Error('unexpected protection cancellation')),
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
        Effect.provideService(MutationStore, { latest: () => Effect.void } as unknown as MutationStoreShape),
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
      const outcome = await Effect.runPromise(
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
      await Effect.runPromise(
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
    await Effect.runPromise(
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
      }).pipe(Effect.provide(TestClock.layer())),
    )
  })

  test('a short durable continuation catches a delayed quote that expires during the ordinary idle interval', async () => {
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
    await Effect.runPromise(
      Effect.gen(function* () {
        yield* TestClock.setTime(start)
        const close = prepareClosingExecutionCycleDecision({
          ...request,
          input: { ...request.input, intradayMarketData: { ...freshMarket, loadSnapshot } },
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
        expect(nextDelayMs).toBe(1_000)
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
            ...(nextDelayMs === undefined ? {} : { nextDelayMs }),
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
              },
            },
            command.sourceRevision,
          ),
        )
        const restarted = Result.getOrThrow(decodeExecutionControllerState(JSON.parse(JSON.stringify(completed))))
        expect(restarted.nextDueAt).toBe(new Date(start + 4_000).toISOString())
        expect(
          Result.getOrThrow(
            decideExecutionControllerTick(
              restarted,
              { schemaVersion: 'bayn.execution-controller-tick.v1', epoch: 1, sequence: 0 },
              command.controllerKey,
              restarted.nextDueAt ?? '',
              command.sourceRevision,
            ),
          )._tag,
        ).toBe('Ignored')
        yield* TestClock.adjust(nextDelayMs ?? 30_000)
        expect(yield* Effect.flip(close)).toMatchObject({ quotePending: true })
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
      }).pipe(Effect.provide(TestClock.layer())),
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
    'pending broker evidence %s uses a short continuation within the close deadline',
    (waitReason) => {
      const waiting = {
        outcome: 'RECOVERED',
        action: 'WAITING',
        waitReason,
        observedAt: at,
        cycle: activeCycle,
      } as const
      expect(executionEvidenceContinuationDelayMs(waiting, 30_000, at)).toBe(1_000)
      expect(executionEvidenceContinuationDelayMs(waiting, 500, at)).toBe(500)
      const close = Date.parse(activeCycle.window.executionCloseAt)
      expect(executionEvidenceContinuationDelayMs(waiting, 30_000, new Date(close - 250).toISOString())).toBe(250)
      expect(executionEvidenceContinuationDelayMs(waiting, 30_000, activeCycle.window.executionCloseAt)).toBeUndefined()
      expect(
        executionEvidenceContinuationDelayMs({ ...waiting, waitReason: 'COMPLETION_EVIDENCE_PENDING' }, 30_000, at),
      ).toBeUndefined()
    },
  )

  test('an unavailable intraday cut preserves its cause without a second reconciliation', async () => {
    const request = await fixture()
    let reads = 0
    const failure = await Effect.runPromise(
      Effect.gen(function* () {
        yield* TestClock.setTime(Date.parse(at) + 60_000)
        return yield* Effect.flip(
          prepareClosingExecutionCycleDecision({
            ...request,
            input: {
              ...request.input,
              intradayMarketData: { ...freshMarket, loadSnapshot: () => Effect.fail(marketFailure) },
            },
            reconcile: currentUtcInstant.pipe(
              Effect.map((now) => {
                reads += 1
                return factsAt(now, true)
              }),
            ),
          }),
        )
      }).pipe(Effect.provide(TestClock.layer())),
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
    const failure = await Effect.runPromise(
      Effect.gen(function* () {
        yield* TestClock.setTime(Date.parse(at) + 60_000)
        return yield* Effect.flip(
          prepareClosingExecutionCycleDecision({
            ...request,
            input: {
              ...request.input,
              intradayMarketData: {
                ...freshMarket,
                // Fault injection at the capability boundary: even if a reader omits the held-symbol
                // quote, absence is unavailable data, not a present quote awaiting refresh.
                loadSnapshot: (query) =>
                  freshMarket.loadSnapshot(query).pipe(Effect.map((snapshot) => ({ ...snapshot, latestQuotes: {} }))),
              },
            },
            reconcile: currentUtcInstant.pipe(Effect.map((now) => factsAt(now, true))),
          }),
        )
      }).pipe(Effect.provide(TestClock.layer())),
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
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        yield* TestClock.setTime(start + offset)
        return yield* prepareClosingExecutionCycleDecision({
          ...request,
          input: {
            ...request.input,
            intradayMarketData: {
              ...freshMarket,
              loadSnapshot: () => TestClock.setTime(start).pipe(Effect.andThen(Effect.fail(marketFailure))),
            },
          },
          reconcile: currentUtcInstant.pipe(
            Effect.map((now) => {
              reads += 1
              return factsAt(now, true)
            }),
          ),
        })
      }).pipe(Effect.provide(TestClock.layer())),
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
    const failure = await Effect.runPromise(
      Effect.gen(function* () {
        yield* TestClock.setTime(close - 1)
        return yield* Effect.flip(
          prepareClosingExecutionCycleDecision({
            ...request,
            input: {
              ...request.input,
              intradayMarketData: { ...freshMarket, loadSnapshot: () => Effect.fail(marketFailure) },
            },
            reconcile: Effect.gen(function* () {
              reads += 1
              if (reads === 2) yield* TestClock.setTime(close)
              return factsAt(yield* currentUtcInstant, true)
            }),
          }),
        )
      }).pipe(Effect.provide(TestClock.layer())),
    )
    expect(reads).toBe(2)
    expect(failure).toBeInstanceOf(ExecutionCloseAwaitingMarketData)
    expect(failure.message).toBe(marketFailure.message)
  })
})
