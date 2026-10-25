import { maximumAllocatedBuyQuantities } from './entry-sizing'
import { CycleState } from '../cycle/model'
import { IntradaySnapshotPurpose } from '../market-data/intraday/model'
import { constructStreamingSnapshot } from '../market-data/streaming/snapshot'
import { expect, test } from 'bun:test'
import { Effect, Result, Schema } from 'effect'

import { canonicalHashV1Result } from '../hash'
import { reconciledStateHash } from '../simulation-reconciliation/broker-model'
import { makeStrategyProtocolHashResult } from '../contracts'
import { makeCycleExecutionPolicyFromModel } from '../cycle/construction'
import { makeIntradayCycleDraft } from '../cycle/runner/calendar-decisions'
import { makeInitialCycle } from '../cycle/store/decisions'
import { continuousMarketHours, continuousExecutionPolicy, tradingWindow } from '../market-hours'
import { OrderSide, OrderType, TimeInForce } from '../execution/contracts'
import { loadExecutionRiskPolicy } from '../observe-composition/decision-builder'
import { adverseQuotePrices, executionMarketDataBinding } from '../observe-composition/intraday-market-data'
import {
  planTargets,
  quoteBoundTargetPlannerInputSchemaVersion,
  intradaySnapshotReferencePricesSchemaVersion,
  TargetPlanStatus,
  type QuoteBoundTargetPlannerInput,
} from '../target-planner/index'
import { cryptoMarketFixture } from '../testing/crypto-market-fixture'
import { jevObservationForSnapshot, nativeJevBatchResult } from './native.test-support'
import { makeJevObservation } from './observation'
import { jevBehaviorHash } from './protocol'
import {
  constrainExecutionTargetAllocationCapitalMicros,
  executionMandateAllocationCapitalMicros,
} from '../execution/mandate'
import { makeJevTradingSignalBatch } from './trading-signals'
import { JevBatchPlanVersion } from './batch'
import { decideJevEntry, jevPlanningTargetWeights, JevEntryTargetSchema } from './decision'

for (const symbol of ['BTC/USD', 'ETH/USD', 'SOL/USD'] as const) {
  test.each([false, true])(
    `${symbol} honors model abstention and retains exact reducing precision with first-minute history=%s`,
    async (firstMinute) => {
      const { cut, query, snapshot } = cryptoMarketFixture(symbol, { firstMinute, observedPriceChoices: true })
      expect(snapshot.bars.filter((bar) => bar.symbol === symbol)).toHaveLength(firstMinute ? 1 : 30)
      const native = Result.getOrThrow(jevObservationForSnapshot(snapshot)).payload
      const { protocol, portfolio, observedAt } = native
      const broker = portfolio.brokerState
      const policy = await Effect.runPromise(loadExecutionRiskPolicy(broker.account.accountId, protocol.universe))
      const executionPolicy = Result.getOrThrow(makeCycleExecutionPolicyFromModel(protocol.executionModel))
      if (executionPolicy.schemaVersion !== 'bayn.autonomous-cycle-execution-policy.v3')
        throw new Error('Expected current policy')
      const lease = Result.getOrThrow(
        tradingWindow(continuousMarketHours, observedAt, { ...continuousExecutionPolicy, sessionEntryCutoffMs: 0 }),
      )
      if (lease === null) throw new Error('Continuous market must admit a lease')
      const strategyProtocolHash = Result.getOrThrow(
        makeStrategyProtocolHashResult({
          name: 'jev',
          behaviorHash: jevBehaviorHash,
          parameterHash: Result.getOrThrow(canonicalHashV1Result(protocol)),
          parameterSchemaVersion: protocol.schemaVersion,
        }),
      )
      const draft = Result.getOrThrow(
        makeIntradayCycleDraft(
          {
            cycleBindingId: 'a'.repeat(64),
            strategyName: 'jev',
            strategyProtocolHash,
            accountId: broker.account.accountId,
            executionPolicy,
          },
          continuousMarketHours,
          lease,
        ),
      )
      const cycle = { ...makeInitialCycle(draft, observedAt), state: CycleState.Active }
      const observation = Result.getOrThrow(
        makeJevObservation({
          cycleId: cycle.identity.cycleId,
          authorityGenerationHash: native.authorityGenerationHash,
          protocol,
          portfolio,
          snapshot,
        }),
      ).payload
      const batchPlan = Result.getOrThrow(
        makeJevTradingSignalBatch({
          observation,
          planVersion: JevBatchPlanVersion.V6,
          expiresAt: new Date(Date.parse(observedAt) + protocol.inferenceValidityMs).toISOString(),
        }),
      )
      const decidedAt = new Date(Date.parse(observedAt) + 100).toISOString()
      const compiledDecision = Result.getOrThrow(
        decideJevEntry({
          observation,
          batchPlan,
          batchResult: nativeJevBatchResult(batchPlan, decidedAt, () => 'wait', 0.42),
          decidedAt,
        }),
      )
      const {
        candidateSymbols: _candidates,
        candidateEvidencePolicy: _evidencePolicy,
        benchmarkEvidencePolicy: _benchmarkPolicy,
        benchmarkSymbols: _benchmarkSymbols,
        ...pricingQuery
      } = query
      const pricingSnapshot = Result.getOrThrow(
        constructStreamingSnapshot(cut, {
          ...pricingQuery,
          symbols: [symbol],
          purpose: IntradaySnapshotPurpose.EntryPricing,
          observedAt: decidedAt,
        }),
      )
      const market = Result.getOrThrow(executionMarketDataBinding(pricingSnapshot))
      const prices = Result.getOrThrow(adverseQuotePrices(pricingSnapshot, [symbol]))
      expect(jevPlanningTargetWeights(compiledDecision)).toEqual({})
      const targetWeights = { [symbol]: 0 }
      const allocationCapitalMicros = Result.getOrThrow(
        executionMandateAllocationCapitalMicros({
          accountEquityMicros: BigInt(broker.account.equityMicros),
          dailyTradedNotionalMicros: 0n,
          maxGrossExposureMicros: BigInt(policy.maxGrossExposureMicros),
          maxNetExposureMicros: BigInt(policy.maxNetExposureMicros),
          maxDailyTradedNotionalMicros: BigInt(policy.maxDailyTradedNotionalMicros),
          maxAdverseSlippageBps: BigInt(policy.maxAdverseSlippageBps),
          targetWeights,
          positions: broker.positions,
          referencePriceMicros: prices.askPriceMicros,
        }).pipe(
          Result.flatMap((capitalMicros) =>
            constrainExecutionTargetAllocationCapitalMicros({
              allocationCapitalMicros: capitalMicros,
              maxOrderNotionalMicros: BigInt(policy.maxOrderNotionalMicros),
              maxSymbolExposureMicros: BigInt(policy.maxSymbolExposureMicros),
              maxAdverseSlippageBps: BigInt(policy.maxAdverseSlippageBps),
              targetWeights,
            }),
          ),
        ),
      )
      const reference = {
        schemaVersion: intradaySnapshotReferencePricesSchemaVersion,
        signalDate: snapshot.manifest.sessionDate,
        observedAt: decidedAt,
        snapshotId: market.snapshotId,
        snapshotContentHash: market.contentHash,
        priceReference: 'verified-adverse-quote-boundary' as const,
        priceMicros: prices.askPriceMicros,
        ...prices,
      }
      const plannerInput: QuoteBoundTargetPlannerInput = {
        schemaVersion: quoteBoundTargetPlannerInputSchemaVersion,
        strategyName: 'jev',
        cycleId: cycle.identity.cycleId,
        decisionHash: Result.getOrThrow(canonicalHashV1Result(compiledDecision)),
        policyHash: Result.getOrThrow(canonicalHashV1Result(policy)),
        accountId: broker.account.accountId,
        signalDate: snapshot.manifest.sessionDate,
        targetWeights,
        referencePrices: { ...reference, contentHash: Result.getOrThrow(canonicalHashV1Result(reference)) },
        brokerState: broker,
        precision: protocol.executionModel.precision,
        allocationCapitalMicros: allocationCapitalMicros.toString(),
        executionTerms: {
          orderType: OrderType.Limit,
          timeInForce: TimeInForce.ImmediateOrCancel,
          priceReference: 'verified-adverse-quote-boundary',
          snapshotId: market.snapshotId,
          snapshotContentHash: market.contentHash,
          maximumBuyQuantityAtoms: Result.getOrThrow(
            maximumAllocatedBuyQuantities({
              askPriceMicros: prices.askPriceMicros,
              targetWeights,
              capitalMicros: broker.account.equityMicros,
              precision: protocol.executionModel.precision,
            }),
          ),
          maximumSellQuantityAtoms: Object.fromEntries(Object.keys(targetWeights).map((target) => [target, '0'])),
        },
        maximumInputAgeMs: 10_000,
        submissionCutoffAt: cycle.window.submissionCutoffAt,
        observedAt: decidedAt,
      }
      const targetPlan = Result.getOrThrow(planTargets(plannerInput))
      expect(targetPlan).toMatchObject({ status: TargetPlanStatus.NoTrade })
      expect(targetPlan.intentTargets).toHaveLength(0)
      // A native coin fee can leave a quantity that is not a multiple of a micro-unit.
      const entryQuantity = 1_234_567_891n
      const heldQuantity = (entryQuantity - (entryQuantity * 25n + 9999n) / 10000n).toString()
      expect(protocol.executionModel.precision.quantityIncrementAtoms).toBe('1')
      const closeMaterial = {
        ...broker,
        positions: [
          {
            schemaVersion: 'bayn.position.v2' as const,
            accountId: broker.account.accountId,
            symbol,
            quantityAtoms: heldQuantity,
            averageEntryPriceMicros: '103123457',
            costBasisMicros: ((BigInt(heldQuantity) * 103123457n) / 1_000_000_000n).toString(),
            marketPriceMicros: '103123457',
            marketValueMicros: ((BigInt(heldQuantity) * 103123457n) / 1_000_000_000n).toString(),
            unrealizedPnlMicros: '0',
            observedAt,
          },
        ],
        positionsObservedAt: observedAt,
      }
      const closeHash = Result.getOrThrow(reconciledStateHash(closeMaterial))
      const closePlan = Result.getOrThrow(
        planTargets({
          ...plannerInput,
          allocationCapitalMicros: '0',
          targetWeights: { [symbol]: 0 },
          executionTerms: {
            ...plannerInput.executionTerms,
            maximumBuyQuantityAtoms: { [symbol]: '0' },
            maximumSellQuantityAtoms: { [symbol]: heldQuantity },
          },
          brokerState: {
            ...closeMaterial,
            reconciliation: { ...broker.reconciliation, expectedHash: closeHash, observedHash: closeHash },
          },
        }),
      )
      expect(closePlan.status).toBe(TargetPlanStatus.Planned)
      expect(closePlan.intentTargets).toMatchObject([
        {
          symbol,
          side: OrderSide.Sell,
          quantityAtoms: heldQuantity,
          orderType: OrderType.Limit,
          timeInForce: TimeInForce.ImmediateOrCancel,
        },
      ])
      expect(compiledDecision.selectedSymbols).toEqual([])
      expect(compiledDecision.exitPolicy.plans).toEqual({})
      expect(Result.isSuccess(Schema.decodeUnknownResult(JevEntryTargetSchema)(compiledDecision))).toBe(true)
    },
  )
}
