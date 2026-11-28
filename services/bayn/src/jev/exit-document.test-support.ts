import { Effect, Result, Schema } from 'effect'

import { CycleState } from '../cycle/model'
import { makeCycleDraft, makeCycleIdentity } from '../cycle/construction'
import { makeInitialCycle } from '../cycle/store/decisions'
import { bindCycleExecutionSession } from '../execution-session'
import { canonicalHashV1Result } from '../hash'
import { IntradaySnapshotPurpose } from '../market-data/intraday/model'
import { persistIntradayRecordRows } from '../market-data/intraday/verification'
import { executionMarketDataBinding, adverseClosingQuotePrices } from '../observe-composition/intraday-market-data'
import { StateSchema, BrokerMode } from '../risk'
import { constructExecutionDecision as buildExecutionDecision } from '../shadow-decision'
import { persistenceDocumentFixture } from '../system-assessment/decision-persistence.test-support'
import { makeIntradayMomentumTestSnapshot } from '../strategy/intraday-momentum/test-support'
import { streamingFixtureFromRaw } from '../testing/streaming-market-fixture'
import { deriveExecutionIntentPricing } from '../execution/intent-pricing'
import { OrderType, TimeInForce } from '../execution/contracts'
import {
  intradaySnapshotReferencePricesSchemaVersion,
  quoteBoundTargetPlannerInputSchemaVersion,
  planTargets,
  type QuoteBoundTargetPlannerInput,
} from '../target-planner/index'
import { decideJevExit, JevExitReason } from './exit'
import { nativeJevFixture } from './native.test-support'
import { JevPurpose } from './portfolio'
import { jevPricingQuery } from './runtime'
import { controlDocumentFixture } from './control-document.test-support'

/** Builds a complete native protective-stop document through the ordinary production constructor. */
export const makeProtectiveStopDocumentFixture = (control: 'candidate' | 'ablation' | 'momentum' = 'candidate') =>
  Effect.gen(function* () {
    const entry = yield* control === 'candidate' ? persistenceDocumentFixture : controlDocumentFixture(control)
    const original = nativeJevFixture(JevPurpose.Manage, '2026-09-04T14:30:33.000Z')
    const { cycleId: _cycleId, ...identityMaterial } = original.draft.identity
    const identity = yield* Effect.fromResult(
      makeCycleIdentity({ ...identityMaterial, strategyProtocolHash: entry.bindings.strategyProtocolHash }),
    )
    const draft = yield* Effect.fromResult(makeCycleDraft(identity, original.draft.window))
    const native = { ...original, draft }
    const observedAt = native.observation.payload.observedAt
    const query = yield* Effect.fromResult(
      jevPricingQuery(
        native.draft,
        native.protocol,
        native.snapshot.manifest.calendar,
        observedAt,
        ['AAPL'],
        IntradaySnapshotPurpose.Liquidation,
      ),
    )
    const raw = makeIntradayMomentumTestSnapshot(native.protocol, { ...query, archiveWatermarks: [] }, { AAPL: -0.02 })
    const snapshot = streamingFixtureFromRaw(raw, query).snapshot
    const rows = yield* Effect.fromResult(persistIntradayRecordRows(snapshot))
    const decision = yield* Effect.fromResult(
      decideJevExit({
        cycleId: native.draft.identity.cycleId,
        sessionDate: snapshot.manifest.sessionDate,
        protocol: native.protocol,
        portfolio: native.portfolio,
        observedAt,
        trigger: { reason: JevExitReason.ProtectiveStop, manifest: snapshot.manifest, rows },
      }),
    )
    const broker = native.portfolio.brokerState
    const policy = entry.riskPolicy
    const originalRisk = entry.bindings.riskContext
    if (policy === undefined || originalRisk === undefined)
      return yield* Effect.die('Expected the native entry risk policy')
    const cycle = { ...makeInitialCycle(native.draft, observedAt), state: CycleState.Active }
    const executionSession = yield* Effect.fromResult(
      bindCycleExecutionSession({
        cycle,
        executionSessionDate: snapshot.manifest.sessionDate,
        planningBrokerState: { observedAt, contentHash: broker.reconciliation.observedHash },
        calendar: snapshot.manifest.calendar,
        executionModel: native.protocol.executionModel,
      }),
    )
    const market = yield* Effect.fromResult(executionMarketDataBinding(snapshot))
    const quotes = yield* Effect.fromResult(adverseClosingQuotePrices(snapshot, decision.symbols))
    const prices = {
      schemaVersion: intradaySnapshotReferencePricesSchemaVersion,
      signalDate: snapshot.manifest.sessionDate,
      observedAt,
      snapshotId: market.snapshotId,
      snapshotContentHash: market.contentHash,
      priceReference: 'verified-adverse-quote-boundary' as const,
      priceMicros: quotes.askPriceMicros,
      ...quotes,
    }
    const expiresAt = new Date(
      Date.parse(cycle.window.executionCloseAt) - native.protocol.hardFlatBeforeCloseMinutes * 60_000,
    ).toISOString()
    const plannerInput: QuoteBoundTargetPlannerInput = {
      schemaVersion: quoteBoundTargetPlannerInputSchemaVersion,
      strategyName: 'jev',
      cycleId: cycle.identity.cycleId,
      decisionHash: Result.getOrThrow(canonicalHashV1Result(decision)),
      policyHash: Result.getOrThrow(canonicalHashV1Result(policy)),
      accountId: broker.account.accountId,
      signalDate: snapshot.manifest.sessionDate,
      targetWeights: decision.targetWeights,
      referencePrices: { ...prices, contentHash: Result.getOrThrow(canonicalHashV1Result(prices)) },
      brokerState: broker,
      precision: { ...native.protocol.executionModel.precision, quantityIncrementAtoms: '1' },
      allocationCapitalMicros: '0',
      executionTerms: {
        executionPurpose: 'forced-close',
        orderType: OrderType.Limit,
        timeInForce: TimeInForce.Day,
        priceReference: 'verified-adverse-quote-boundary',
        snapshotId: market.snapshotId,
        snapshotContentHash: market.contentHash,
        maximumBuyQuantityAtoms: { AAPL: '0' },
        maximumSellQuantityAtoms: Object.fromEntries(broker.positions.map((p) => [p.symbol, p.quantityAtoms])),
      },
      maximumInputAgeMs: 120_000,
      submissionCutoffAt: expiresAt,
      observedAt,
    }
    const targetPlan = yield* Effect.fromResult(planTargets(plannerInput))
    const riskContext = {
      ...originalRisk,
      authority: { ...originalRisk.authority, updatedAt: observedAt },
      authorityObservedAt: observedAt,
      dayStartEquityMicros: broker.account.equityMicros,
      peakEquityMicros: broker.account.equityMicros,
    }
    const riskInputs = yield* Effect.forEach(targetPlan.intentTargets, (target) =>
      Effect.gen(function* () {
        const planned = targetPlan.targets.find((t) => t.symbol === target.symbol)
        if (planned === undefined) return yield* Effect.die('Expected a planned native close')
        const pricing = yield* Effect.fromResult(
          deriveExecutionIntentPricing({
            ...target,
            quantityAtoms: BigInt(target.quantityAtoms),
            referencePriceMicros: BigInt(planned.referencePriceMicros),
            limitSlippageBps: BigInt(policy.maxAdverseSlippageBps),
          }),
        )
        return {
          symbol: target.symbol,
          notionalLimitMicros: String(pricing.notionalLimitMicros),
          limitPriceMicros: String(pricing.expectedExecutionPriceMicros),
          state: yield* Schema.decodeUnknownEffect(StateSchema)({
            schemaVersion: 'bayn.paper-risk-state.v2',
            brokerMode: BrokerMode.Execution,
            ...broker,
            ...riskContext,
            marketDataSymbol: target.symbol,
            marketDataHash: market.contentHash,
            executionMarketDataHash: market.contentHash,
            referencePriceMicros: planned.referencePriceMicros,
            expectedExecutionPriceMicros: String(pricing.expectedExecutionPriceMicros),
            marketDataObservedAt: observedAt,
            executionSession,
            reservedBuyingPowerMicros: '0',
            evaluatedAt: observedAt,
            closeOnly: true,
            closeOnlyExpiresAt: expiresAt,
          }),
        }
      }),
    )
    return yield* buildExecutionDecision({
      cycle,
      snapshot: {
        snapshotId: entry.bindings.snapshotId,
        contentHash: entry.bindings.snapshotContentHash,
        finalizedAt: entry.bindings.snapshotFinalizedAt,
      },
      compiledDecision: decision,
      decisionMarketDataRows: rows,
      executionMarketData: market,
      plannerInput,
      targetPlan,
      policy,
      closeLimitSlippageBps: policy.maxAdverseSlippageBps,
      riskInputs,
      authorityGenerationHash: native.observation.payload.authorityGenerationHash,
      executionSession,
      riskContext,
      submissionCutoffAt: expiresAt,
    })
  })

export const protectiveStopDocumentFixture = makeProtectiveStopDocumentFixture()
