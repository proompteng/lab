import { equityMarketProfile } from '../jev/markets'
import { Effect, Schema, Result } from 'effect'
import { CycleState } from '../cycle/model'
import { makeInitialCycle } from '../cycle/store/decisions'
import { Authority, KillState, OrderType, TimeInForce } from '../execution/contracts'
import { bindCycleExecutionSession } from '../execution-session'
import { canonicalHashV1Result } from '../hash'
import { decideJevEntry } from '../jev/decision'
import { type nativeJevDecisionEvidence, type nativeJevFixture } from '../jev/native.test-support'
import { compileJevEntry } from '../jev/runtime'
import { BrokerMode, PolicySchema } from '../risk'
import { buildExecutionDecision } from '../shadow-decision'
import {
  intradaySnapshotReferencePricesSchemaVersion,
  planTargets,
  quoteBoundTargetPlannerInputSchemaVersion,
  type QuoteBoundTargetPlannerInput,
} from '../target-planner/index'

export const matchedCommittedDecisionFixture = (
  native: Omit<ReturnType<typeof nativeJevFixture>, 'snapshot'> & {
    readonly snapshot: import('../market-data/streaming/snapshot').StreamingVerifiedMarketSnapshot
  },
  evidence: ReturnType<typeof nativeJevDecisionEvidence>,
  allocationCapitalMicros = '1',
) =>
  Effect.gen(function* () {
    const decision = yield* Effect.fromResult(decideJevEntry(evidence))
    const compiled = yield* Effect.fromResult(compileJevEntry(decision, native.snapshot, native.snapshot))
    const broker = native.portfolio.brokerState
    const at = decision.decidedAt
    const cycle = { ...makeInitialCycle(native.draft, native.observation.payload.observedAt), state: CycleState.Active }
    const policy = yield* Schema.decodeUnknownEffect(PolicySchema)({
      schemaVersion: 'bayn.execution-risk-policy.v4',
      accountId: broker.account.accountId,
      brokerMode: BrokerMode.Execution,
      allowedSymbols: equityMarketProfile.candidateSymbols,
      allowedOrderTypes: [OrderType.Limit],
      allowedTimeInForce: [TimeInForce.ImmediateOrCancel],
      maxOrderNotionalMicros: '100000000000',
      maxSymbolExposureMicros: '100000000000',
      maxGrossExposureMicros: '100000000000',
      maxNetExposureMicros: '100000000000',
      maxDailyTradedNotionalMicros: '200000000000',
      maxDailyLossMicros: '1000000000',
      maxDrawdownMicros: '1000000000',
      maxIntentAgeMs: 120_000,
      maxBrokerStateAgeMs: 120_000,
      maxMarketDataAgeMs: 120_000,
      maxAdverseSlippageBps: 100,
      maxOpenOrders: 2,
      decisionTtlMs: 120_000,
    })
    const market = compiled.executionMarketData
    const prices = {
      schemaVersion: intradaySnapshotReferencePricesSchemaVersion,
      signalDate: native.snapshot.manifest.sessionDate,
      observedAt: market.observedAt,
      snapshotId: market.snapshotId,
      snapshotContentHash: market.contentHash,
      priceReference: 'verified-adverse-quote-boundary' as const,
      priceMicros: compiled.priceMicros,
      bidPriceMicros: compiled.bidPriceMicros,
      askPriceMicros: compiled.askPriceMicros,
    }
    const plannerInput: QuoteBoundTargetPlannerInput = {
      schemaVersion: quoteBoundTargetPlannerInputSchemaVersion,
      strategyName: 'jev',
      cycleId: cycle.identity.cycleId,
      decisionHash: Result.getOrThrow(canonicalHashV1Result(decision)),
      policyHash: Result.getOrThrow(canonicalHashV1Result(policy)),
      accountId: broker.account.accountId,
      signalDate: native.snapshot.manifest.sessionDate,
      targetWeights: compiled.planningTargetWeights,
      referencePrices: { ...prices, contentHash: Result.getOrThrow(canonicalHashV1Result(prices)) },
      brokerState: broker,
      precision: { ...native.protocol.executionModel.precision, quantityIncrementAtoms: '1' },
      allocationCapitalMicros,
      executionTerms: {
        orderType: OrderType.Limit,
        timeInForce: TimeInForce.Day,
        priceReference: 'verified-adverse-quote-boundary' as const,
        snapshotId: market.snapshotId,
        snapshotContentHash: market.contentHash,
        maximumBuyQuantityAtoms: compiled.maximumBuyQuantityAtoms,
        maximumSellQuantityAtoms: compiled.maximumSellQuantityAtoms,
      },
      maximumInputAgeMs: 120_000,
      submissionCutoffAt: cycle.window.submissionCutoffAt,
      observedAt: at,
    }
    const targetPlan = yield* Effect.fromResult(planTargets(plannerInput))
    if (targetPlan.intentTargets.length !== 0) throw new Error('Timing fixture requires a sub-share allocation')
    const executionSession = yield* Effect.fromResult(
      bindCycleExecutionSession({
        cycle,
        executionSessionDate: native.snapshot.manifest.sessionDate,
        planningBrokerState: { observedAt: broker.account.observedAt, contentHash: broker.reconciliation.observedHash },
        calendar: native.snapshot.manifest.calendar,
        executionModel: native.protocol.executionModel,
      }),
    )
    const authorityGenerationHash = native.observation.payload.authorityGenerationHash
    return yield* buildExecutionDecision({
      cycle,
      snapshot: {
        snapshotId: native.snapshot.manifest.snapshotId,
        contentHash: native.snapshot.manifest.contentHash,
        finalizedAt: native.snapshot.manifest.observedAt,
      },
      compiledDecision: decision,
      decisionMarketDataRows: compiled.decisionMarketDataRows,
      executionMarketData: market,
      plannerInput,
      targetPlan,
      policy,
      riskInputs: [],
      authorityGenerationHash,
      executionSession,
      riskContext: {
        authority: {
          schemaVersion: 'bayn.paper-authority.v1',
          generationHash: authorityGenerationHash,
          maximum: Authority.Execution,
          effective: Authority.Execution,
          kill: KillState.Clear,
          version: 1,
          updatedAt: at,
        },
        authorityObservedAt: at,
        unknownMutationCount: 0,
        dailyTradedNotionalMicros: '0',
        dayStartEquityMicros: broker.account.equityMicros,
        peakEquityMicros: broker.account.equityMicros,
      },
    })
  })
