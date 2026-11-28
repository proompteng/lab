import { ledgerTotalsFixture } from './ledger-totals.test-support'
import assert from 'node:assert/strict'

import { describe, expect, test } from 'bun:test'
import { Result } from 'effect'

import { AccountingInventorySide, prepareAccounting } from '../accounting/domain'
import type { AccountingTransaction } from '../accounting/schema'
import { OrderSide, OrderType, TimeInForce } from '../execution/contracts'
import { canonicalHashV1Result } from '../hash'
import { IntradayAlphaPhase, IntradayAlphaSetup } from '../strategy/intraday-alpha/constants'
import { IntradayAlphaDecisionReason } from '../strategy/intraday-alpha/decision'
import { TargetPlanStatus } from '../target-planner/model'
import type { NativeAlphaDecisionEvidence } from './alpha-decisions'
import { measureNativeAlphaAttribution, NativeAlphaAttributionReason } from './alpha-attribution'
import { makeForwardPerformanceReceipt } from './domain'
import type {
  ForwardPerformanceEvidenceInput,
  ForwardPerformanceExecutionEvidence,
  ForwardPerformanceExecutionFillEvidence,
  ForwardPerformanceReceipt,
} from './model'
import { measurePositionEpisodes } from './position-episodes'

const success = <A, E>(result: Result.Result<A, E>): A => {
  assert(Result.isSuccess(result))
  return result.success
}
const hash = (value: string) => success(canonicalHashV1Result({ value }))
const accountId = 'synthetic-native-alpha'
const createdAt = '2026-09-18T15:00:00.000Z'
const reconciledAt = '2026-09-18T21:00:00.000Z'
const build = {
  sourceRevision: 'a'.repeat(40),
  imageRepository: 'registry.example.test/bayn',
  imageDigest: 'sha256:' + 'b'.repeat(64),
}
const intentId = (key: string, symbol: string) => hash(`intent-${key}-${symbol}`)

const decision = (
  key: string,
  specifications: readonly { symbol: string; side: OrderSide; shares?: number }[],
  phase = IntradayAlphaPhase.MiddayReversion,
): NativeAlphaDecisionEvidence => ({
  cycleId: hash(`cycle-${key}`),
  accountId,
  authorityGenerationHash: hash('generation'),
  decisionDocumentHash: hash(`document-${key}`),
  decisionHash: hash(`decision-${key}`),
  decisionCreatedAt: createdAt,
  sessionDate: '2026-09-18',
  phase,
  reason: IntradayAlphaDecisionReason.SelectedMiddayReversion,
  strategyProtocolHash: hash('protocol'),
  strategyBehaviorHash: hash('behavior'),
  strategyParameterHash: hash('parameters'),
  policySchemaVersion: 'bayn.intraday-alpha-policy.v2',
  riskPolicyHash: hash('risk'),
  qualificationBuild: build,
  activationBuild: build,
  executingBuild: null,
  cycleState: 'COMPLETED',
  terminalAt: reconciledAt,
  reconciledAt,
  executionEvidenceInScope: true,
  dispatchable: true,
  selectedSymbols: specifications.map((item) => item.symbol),
  targetWeights: Object.fromEntries(
    specifications.map((item) => [item.symbol, item.side === OrderSide.Buy ? 0.1 : -0.1]),
  ),
  signals: specifications.map((item) => ({
    symbol: item.symbol,
    phase: phase === IntradayAlphaPhase.OutsideWindow ? IntradayAlphaPhase.MiddayReversion : phase,
    setup:
      item.side === OrderSide.Buy
        ? IntradayAlphaSetup.MiddayVwapReversionLong
        : IntradayAlphaSetup.MiddayVwapReversionShort,
    direction: item.side === OrderSide.Buy ? 'LONG' : 'SHORT',
    scoreBps: 10,
    relVwapDevBps: 10,
    vetoed: false,
  })),
  targetPlan: {
    status: TargetPlanStatus.Planned,
    reason: null,
    legs: specifications.map((item) => ({
      symbol: item.symbol,
      side: item.side,
      quantityAtoms: (BigInt(item.shares ?? 1) * 1_000_000_000n).toString(),
      referencePriceMicros: '100000000',
      intentId: intentId(key, item.symbol),
    })),
  },
})

interface Trade {
  readonly symbol: string
  readonly side: OrderSide
  readonly intent: string
  readonly shares?: number
  readonly price?: number
  readonly priceAtoms?: string
  readonly short?: boolean
  readonly feeMicros?: string
}

const fixture = (
  decisions: readonly NativeAlphaDecisionEvidence[],
  trades: readonly Trade[],
): ForwardPerformanceEvidenceInput & {
  readonly executionEvidence: readonly ForwardPerformanceExecutionEvidence[]
  readonly accountTransactions: readonly AccountingTransaction[]
} => {
  const inventory = new Map<string, { quantityAtoms: string; costMicros: string }>()
  const fills: ForwardPerformanceExecutionFillEvidence[] = []
  const history = trades.map((trade, index) => {
    const occurredAt = `2026-09-18T15:01:${String(index).padStart(2, '0')}.000Z`
    const fill = {
      schemaVersion: 'bayn.fill.v2' as const,
      accountId,
      fillId: `fill-${index}`,
      brokerOrderId: `broker-${trade.intent}`,
      clientOrderId: `client-${trade.intent}`,
      intentId: trade.intent,
      symbol: trade.symbol,
      side: trade.side,
      quantityAtoms: (BigInt(trade.shares ?? 1) * 1_000_000_000n).toString(),
      priceAtoms: trade.priceAtoms ?? (BigInt(trade.price ?? 100) * 1_000_000_000n).toString(),
      feeMicros: trade.feeMicros ?? '1000',
      occurredAt,
    }
    const prior = inventory.get(trade.symbol) ?? { quantityAtoms: '0', costMicros: '0' }
    const prepared = success(
      prepareAccounting(
        hash(`fill-event-${index}`),
        fill,
        prior,
        7001,
        trade.short === true ? AccountingInventorySide.Short : AccountingInventorySide.Long,
      ),
    )
    inventory.set(trade.symbol, {
      quantityAtoms: (BigInt(prior.quantityAtoms) + BigInt(prepared.transaction.quantityDeltaAtoms)).toString(),
      costMicros: (BigInt(prior.costMicros) + BigInt(prepared.transaction.costBasisDeltaMicros)).toString(),
    })
    fills.push({
      ...fill,
      brokerEventId: prepared.transaction.brokerEventId,
      sourceTimestamp: occurredAt,
      observedAt: occurredAt,
    })
    return prepared.transaction
  })
  const executionEvidence: ForwardPerformanceExecutionEvidence[] = decisions.flatMap((item) =>
    item.targetPlan.legs.flatMap((leg) => {
      if (leg.intentId === null) return []
      const id = leg.intentId
      const entryFills = fills.filter((fill) => fill.intentId === id && fill.side === leg.side)
      const quantity = entryFills.reduce((sum, fill) => sum + BigInt(fill.quantityAtoms), 0n)
      const status =
        quantity === BigInt(leg.quantityAtoms)
          ? ('FILLED' as const)
          : quantity > 0n
            ? ('CANCELED' as const)
            : ('EXPIRED' as const)
      const identity = { intentId: id, accountId, symbol: leg.symbol, side: leg.side }
      return [
        {
          ...identity,
          cycleId: item.cycleId,
          decisionDocumentHash: item.decisionDocumentHash,
          decisionHash: item.decisionHash,
          decisionCreatedAt: item.decisionCreatedAt,
          plannedQuantityAtoms: leg.quantityAtoms,
          referencePriceMicros: leg.referencePriceMicros ?? '100000000',
          intent: {
            ...identity,
            clientOrderId: `client-${id}`,
            cycleId: item.cycleId,
            decisionHash: item.decisionHash,
            quantityAtoms: leg.quantityAtoms,
            terminalOutcome: status,
            createdAt,
            updatedAt: reconciledAt,
          },
          terminalOrder: {
            ...identity,
            eventId: hash(`order-${id}`),
            brokerOrderId: `broker-${id}`,
            clientOrderId: `client-${id}`,
            quantityAtoms: leg.quantityAtoms,
            filledQuantityAtoms: quantity.toString(),
            status,
            occurredAt: reconciledAt,
            observedAt: reconciledAt,
          },
          fills: entryFills,
        },
      ]
    }),
  )
  const gains = history.reduce(
    (sum, trade) => sum + (BigInt(trade.realizedPnlMicros) > 0n ? BigInt(trade.realizedPnlMicros) : 0n),
    0n,
  )
  const losses = history.reduce(
    (sum, trade) => sum + (BigInt(trade.realizedPnlMicros) < 0n ? -BigInt(trade.realizedPnlMicros) : 0n),
    0n,
  )
  const fees = history.reduce((sum, trade) => sum + BigInt(trade.feeMicros), 0n)
  const openCount = [...inventory.values()].filter((item) => item.quantityAtoms !== '0').length
  const first = decisions[0]
  const cycleFor = (id: string | undefined) =>
    decisions.find((item) => item.targetPlan.legs.some((leg) => leg.intentId === id))?.cycleId ??
    first?.cycleId ??
    hash('unowned-cycle')
  return {
    runtime: build,
    account: { accountId, accountReferenceHash: hash('account'), provider: 'alpaca', environment: 'sandbox' },
    durableExecutionBindings: [],
    cycles: decisions.map((item) => ({
      cycleId: item.cycleId,
      qualificationRunId: hash('qualification'),
      strategyName: 'jev',
      strategyProtocolHash: item.strategyProtocolHash,
      accountId,
      executionPolicyHash: hash('execution-policy'),
      strategyExecutionModelHash: hash('execution-model'),
      state: 'COMPLETED',
      submissionOpenAt: createdAt,
      terminalAt: reconciledAt,
    })),
    alphaDecisions: decisions,
    unverifiedAlphaDecisionHashes: [],
    executionEvidence,
    reconciliation: {
      reconciliationId: hash('reconciliation'),
      contentHash: hash('reconciliation-content'),
      status: 'EXACT',
      performanceExact: true,
      cashYieldAdjustedExact: false,
      reconciledAt,
    },
    startingCapitalMicros: '100000000000',
    transactions: history.map((trade) => ({ ...trade, cycleId: cycleFor(trade.intentId) })),
    accountTransactions: history,
    ledgerTotals: ledgerTotalsFixture({
      realizedGainMicros: gains.toString(),
      realizedLossMicros: losses.toString(),
      brokerExecutionFeesMicros: (fees + 50000n).toString(),
      otherChargedCostsMicros: '20000',
    }),
    brokerFees: [{ accountId, activityId: 'pooled-session-fee', date: '2026-09-18', netAmountMicros: '-50000' }],
    accountingReceiptsExact: true,
    ledgerExact: true,
    missingLedgerAccountCount: 0,
    cashYieldEvidenceRequired: false,
    unresolvedMutationCount: 0,
    unclosedCycleCount: 0,
    openPositionCount: openCount,
    accountPositionCounts: { postgres: openCount, ledger: openCount, reconciledAt, exact: true },
  }
}
const measure = (input: ForwardPerformanceEvidenceInput, receipt?: ForwardPerformanceReceipt) =>
  success(
    measureNativeAlphaAttribution(
      input,
      receipt ?? success(makeForwardPerformanceReceipt(input)),
      success(measurePositionEpisodes(input)),
    ),
  )

const longRoundTrip = () =>
  fixture(
    [decision('a', [{ symbol: 'NVDA', side: OrderSide.Buy }])],
    [
      { symbol: 'NVDA', side: OrderSide.Buy, intent: intentId('a', 'NVDA') },
      { symbol: 'NVDA', side: OrderSide.Sell, intent: hash('protective-exit'), price: 110 },
    ],
  )

describe('native alpha basket attribution', () => {
  test.each([false, true])('rejects a false terminal zero when a canonical entry fill is omitted (open=%s)', (open) => {
    const item = decision('a', [{ symbol: 'NVDA', side: OrderSide.Buy }])
    const input = open
      ? fixture([item], [{ symbol: 'NVDA', side: OrderSide.Buy, intent: intentId('a', 'NVDA') }])
      : longRoundTrip()
    const execution = input.executionEvidence[0]
    assert(execution?.intent && execution.terminalOrder)
    const result = measure({
      ...input,
      executionEvidence: [
        {
          ...execution,
          intent: { ...execution.intent, terminalOutcome: 'EXPIRED' },
          terminalOrder: { ...execution.terminalOrder, status: 'EXPIRED', filledQuantityAtoms: '0' },
          fills: [],
        },
      ],
    })
    expect(result.baskets[0]?.executionStatus).toBe('UNKNOWN')
    expect(result.baskets[0]?.economics.completeGrossPnlMicros).toBeNull()
    expect(result.reasonCodes).toContain(NativeAlphaAttributionReason.FillBinding)
  })

  test('uses canonical rounded transaction notional for entry imbalance', () => {
    const input = fixture(
      [decision('a', [{ symbol: 'NVDA', side: OrderSide.Buy }])],
      [
        { symbol: 'NVDA', side: OrderSide.Buy, intent: intentId('a', 'NVDA'), priceAtoms: '100000000333' },
        { symbol: 'NVDA', side: OrderSide.Sell, intent: hash('exit'), price: 110 },
      ],
    )
    const first = input.accountTransactions[0]
    assert(first)
    expect(measure(input).baskets[0]?.entryFillGrossNotionalMicros).toBe(first.notionalMicros)
    expect(measure(input).baskets[0]?.entryFillSignedNotionalMicros).toBe(first.notionalMicros)
  })

  test('keeps native child exit fills out of entry notional while attributing the completed episode to its entry', () => {
    const input = fixture(
      [decision('a', [{ symbol: 'NVDA', side: OrderSide.Buy }])],
      [
        { symbol: 'NVDA', side: OrderSide.Buy, intent: intentId('a', 'NVDA') },
        { symbol: 'NVDA', side: OrderSide.Sell, intent: intentId('a', 'NVDA'), price: 110 },
      ],
    )
    const entry = input.executionEvidence[0]
    const closing = input.accountTransactions[1]
    assert(entry && closing && closing.intentId)
    const childFill: ForwardPerformanceExecutionFillEvidence = {
      brokerEventId: closing.brokerEventId,
      fillId: 'native-child-fill',
      brokerOrderId: 'native-child-order',
      clientOrderId: 'native-child-client',
      intentId: closing.intentId,
      accountId,
      symbol: closing.symbol,
      side: closing.side,
      quantityAtoms: closing.quantityAtoms,
      priceAtoms: closing.priceAtoms,
      feeMicros: closing.feeMicros,
      sourceTimestamp: closing.occurredAt,
      occurredAt: closing.occurredAt,
      observedAt: closing.occurredAt,
    }
    const result = measure({
      ...input,
      executionEvidence: [
        {
          ...entry,
          nativeProtection: {
            schemaVersion: 'bayn.forward-performance-native-protection.v1',
            target: {
              symbol: entry.symbol,
              side: OrderSide.Buy,
              orderType: OrderType.Limit,
              timeInForce: TimeInForce.Day,
              quantityAtoms: '1000000000',
            },
            limitPriceMicros: '100000000',
            protection: {
              _tag: 'Bracket',
              stopPriceMicros: '99000000',
              stopLimitPriceMicros: '98000000',
              profitLimitPriceMicros: '110000000',
            },
            authorityGenerationHash: hash('generation'),
            orders: [],
            fills: [childFill],
          },
        },
      ],
    })
    expect(result.baskets[0]).toMatchObject({
      executionStatus: 'FULL',
      entryFillGrossNotionalMicros: '100000000',
      economics: { completedEpisodeCount: 1, completeGrossPnlMicros: '10000000' },
    })
    expect(result.episodes.attributedCount).toBe(1)
  })

  test('withholds complete engine totals when an omitted unverified decision has unknown engine ownership', () => {
    const input = longRoundTrip()
    const result = measure({ ...input, unverifiedAlphaDecisionHashes: [hash('unverified-omitted-decision')] })
    expect(result.baskets[0]?.economics.completeGrossPnlMicros).toBe('10000000')
    expect(result.engines[0]?.economics).toMatchObject({
      status: 'PARTIAL_COMPLETED_EPISODES',
      knownCompletedGrossPnlMicros: '10000000',
      completeGrossPnlMicros: null,
      completeNetAfterDirectFillFeesMicros: null,
    })
  })

  test('conserves long/short completed gross and direct fees while leaving pooled account fees unallocated', () => {
    const input = fixture(
      [
        decision('a', [
          { symbol: 'NVDA', side: OrderSide.Buy },
          { symbol: 'AAPL', side: OrderSide.Sell },
        ]),
      ],
      [
        { symbol: 'NVDA', side: OrderSide.Buy, intent: intentId('a', 'NVDA') },
        { symbol: 'AAPL', side: OrderSide.Sell, intent: intentId('a', 'AAPL'), short: true },
        { symbol: 'NVDA', side: OrderSide.Sell, intent: hash('long-exit'), price: 110 },
        { symbol: 'AAPL', side: OrderSide.Buy, intent: hash('short-exit'), short: true, price: 95 },
      ],
    )
    const result = measure(input)
    expect(result.baskets[0]).toMatchObject({
      executionStatus: 'FULL',
      filledLegCount: 2,
      entryFillGrossNotionalMicros: '200000000',
      entryFillSignedNotionalMicros: '0',
      economics: {
        status: 'CLOSED_FILLED_ENTRIES',
        completedEpisodeCount: 2,
        completeGrossPnlMicros: '15000000',
        knownCompletedDirectFillFeesMicros: '4000',
        completeNetAfterDirectFillFeesMicros: '14996000',
        exactBrokerNetPnlMicros: null,
        allInProfitMicros: null,
      },
    })
    expect(result.financialConservation).toEqual({
      status: 'RECONCILED',
      scopedGrossPnlMicros: '15000000',
      attributedCompletedGrossPnlMicros: '15000000',
      unattributedGrossPnlMicros: '0',
      scopedDirectFillFeesMicros: '4000',
      attributedCompletedDirectFillFeesMicros: '4000',
      unattributedDirectFillFeesMicros: '0',
      scopedBrokerExecutionFeesMicros: '54000',
      unallocatedBrokerCostsBeyondDirectFillFeesMicros: '50000',
      unallocatedOtherChargedCostsMicros: '20000',
    })
    expect(JSON.stringify(result)).not.toContain(accountId)
    expect(result.baskets[0]?.decision.executingBuild).toBeNull()
    expect(result.scope.controllerNoCycleAbstentionsIncluded).toBe(false)
  })

  test('reports a one-sided partial basket from actual fills despite balanced planned weights', () => {
    const input = fixture(
      [
        decision('a', [
          { symbol: 'NVDA', side: OrderSide.Buy, shares: 2 },
          { symbol: 'MSFT', side: OrderSide.Buy },
          { symbol: 'AAPL', side: OrderSide.Sell },
          { symbol: 'AMD', side: OrderSide.Sell },
        ]),
      ],
      [
        { symbol: 'NVDA', side: OrderSide.Buy, intent: intentId('a', 'NVDA') },
        { symbol: 'NVDA', side: OrderSide.Sell, intent: hash('exit'), price: 99 },
      ],
    )
    const result = measure(input)
    expect(result.baskets[0]).toMatchObject({
      selectedLegCount: 4,
      fundedLegCount: 4,
      filledLegCount: 1,
      fundingStatus: 'FULL',
      executionStatus: 'PARTIAL',
      entryFillGrossNotionalMicros: '100000000',
      entryFillSignedNotionalMicros: '100000000',
    })
    expect(result.baskets[0]?.legs.map((leg) => leg.status)).toEqual(['PARTIAL', 'ZERO', 'ZERO', 'ZERO'])
    expect(result.baskets[0]?.legs[0]?.unfilledQuantityAtoms).toBe('1000000000')
    expect(result.baskets[0]?.economics.completeGrossPnlMicros).toBe('-1000000')
    expect(result.scope.markedExposureMeasured).toBe(false)
  })

  test('requires terminal zero-quantity evidence; blocked or empty execution alone never proves zero', () => {
    const item = decision('a', [{ symbol: 'NVDA', side: OrderSide.Buy }])
    const input = fixture([item], [])
    expect(measure(input).baskets[0]?.executionStatus).toBe('ZERO')
    expect(measure(input).baskets[0]?.economics.status).toBe('NO_FILLED_ENTRIES')
    const execution = input.executionEvidence[0]
    assert(execution?.intent)
    const { terminalOrder: _order, ...withoutOrder } = execution
    const blocked = measure({
      ...input,
      alphaDecisions: [{ ...item, cycleState: 'BLOCKED' }],
      executionEvidence: [{ ...withoutOrder, intent: { ...execution.intent, terminalOutcome: 'BLOCKED' } }],
    })
    expect(blocked.baskets[0]?.executionStatus).toBe('UNKNOWN')
    expect(blocked.baskets[0]?.legs[0]?.filledQuantityAtoms).toBeNull()
    expect(blocked.baskets[0]?.economics.completeGrossPnlMicros).toBeNull()
  })

  test('retains selected but unfunded and excluded financial cohorts without inventing orders or zero returns', () => {
    const item = decision('a', [{ symbol: 'NVDA', side: OrderSide.Buy }])
    const unfunded = { ...item, targetPlan: { ...item.targetPlan, status: TargetPlanStatus.NoTrade, legs: [] } }
    const result = measure(fixture([unfunded], []))
    expect(result.baskets[0]).toMatchObject({
      selectedLegCount: 1,
      fundedLegCount: 0,
      boundIntentLegCount: 0,
      executionStatus: 'UNFUNDED',
      entryFillGrossNotionalMicros: null,
      economics: { completeGrossPnlMicros: null },
    })
    const excluded = measure(fixture([{ ...item, executionEvidenceInScope: false }], []))
    expect(excluded.baskets[0]?.executionStatus).toBe('UNKNOWN')
    expect(excluded.reasonCodes).toContain(NativeAlphaAttributionReason.ExecutionOutsideScope)
    const unbound = measure(
      fixture(
        [
          {
            ...item,
            targetPlan: { ...item.targetPlan, legs: item.targetPlan.legs.map((leg) => ({ ...leg, intentId: null })) },
          },
        ],
        [],
      ),
    )
    expect(unbound.baskets[0]?.boundIntentLegCount).toBe(0)
    expect(unbound.baskets[0]?.filledLegCount).toBeNull()
  })

  test('does not assign a scaled-in episode to its first engine when another entry decision increased inventory', () => {
    const input = fixture(
      [
        decision('a', [{ symbol: 'NVDA', side: OrderSide.Buy }], IntradayAlphaPhase.MorningOrb),
        decision('b', [{ symbol: 'NVDA', side: OrderSide.Buy }], IntradayAlphaPhase.MiddayReversion),
      ],
      [
        { symbol: 'NVDA', side: OrderSide.Buy, intent: intentId('a', 'NVDA') },
        { symbol: 'NVDA', side: OrderSide.Buy, intent: intentId('b', 'NVDA') },
        { symbol: 'NVDA', side: OrderSide.Sell, intent: hash('exit'), shares: 2, price: 110 },
      ],
    )
    const result = measure(input)
    expect(result.episodes.attributedCount).toBe(0)
    expect(result.episodes.unassigned[0]?.reason).toBe(NativeAlphaAttributionReason.MixedEpisodeOwners)
    expect(result.financialConservation.unattributedGrossPnlMicros).toBe('20000000')
    expect(result.engines.every((engine) => engine.economics.completeGrossPnlMicros === null)).toBe(true)
    expect(result.baskets.map((basket) => basket.economics.unresolvedEntryFillCount)).toEqual([1, 1])
  })

  test('permits same-owner scale-ins and multiple partial closing fills', () => {
    const input = fixture(
      [decision('a', [{ symbol: 'NVDA', side: OrderSide.Buy, shares: 2 }])],
      [
        { symbol: 'NVDA', side: OrderSide.Buy, intent: intentId('a', 'NVDA') },
        { symbol: 'NVDA', side: OrderSide.Buy, intent: intentId('a', 'NVDA') },
        { symbol: 'NVDA', side: OrderSide.Sell, intent: hash('exit-1'), price: 110 },
        { symbol: 'NVDA', side: OrderSide.Sell, intent: hash('exit-2'), price: 90 },
      ],
    )
    expect(measure(input).baskets[0]?.economics).toMatchObject({
      status: 'CLOSED_FILLED_ENTRIES',
      unresolvedEntryFillCount: 0,
      completedEpisodeCount: 1,
      completeGrossPnlMicros: '0',
      knownCompletedDirectFillFeesMicros: '4000',
    })
  })

  test('keeps open and cross-scope episode holdings unresolved', () => {
    const item = decision('a', [{ symbol: 'NVDA', side: OrderSide.Buy }])
    const open = measure(fixture([item], [{ symbol: 'NVDA', side: OrderSide.Buy, intent: intentId('a', 'NVDA') }]))
    expect(open.episodes.openCount).toBe(1)
    expect(open.baskets[0]?.economics).toMatchObject({ unresolvedEntryFillCount: 1, completeGrossPnlMicros: null })
    const input = longRoundTrip()
    const crossed = measure({
      ...input,
      transactions: input.transactions.slice(0, 1),
      ledgerTotals: { ...input.ledgerTotals!, realizedGainMicros: '0' },
    })
    expect(crossed.episodes.crossScopeCount).toBe(1)
    expect(crossed.baskets[0]?.economics.completeGrossPnlMicros).toBeNull()
  })

  test('keeps missing receipt fee totals null despite available raw pooled broker fees', () => {
    const input = longRoundTrip()
    const receipt = success(makeForwardPerformanceReceipt(input))
    const result = measure(input, {
      ...receipt,
      totals: { ...receipt.totals, brokerExecutionFeesMicros: null, otherChargedCostsMicros: null },
    })
    expect(result.financialConservation).toMatchObject({
      status: 'UNDETERMINED',
      scopedBrokerExecutionFeesMicros: null,
      unallocatedBrokerCostsBeyondDirectFillFeesMicros: null,
      unallocatedOtherChargedCostsMicros: null,
    })
    expect(result.baskets[0]?.economics.completeGrossPnlMicros).toBe('10000000')
    expect(result.engines[0]?.economics.exactBrokerNetPnlMicros).toBeNull()
  })

  test('rejects duplicate execution and fill identities instead of deduplicating them into profit', () => {
    const input = longRoundTrip()
    const execution = input.executionEvidence[0]
    assert(execution)
    const duplicateExecution = measure({ ...input, executionEvidence: [...input.executionEvidence, execution] })
    expect(duplicateExecution.baskets[0]?.executionStatus).toBe('UNKNOWN')
    expect(duplicateExecution.reasonCodes).toContain(NativeAlphaAttributionReason.DuplicateExecution)
    const fill = execution.fills[0]
    assert(fill)
    const duplicateFill = measure({
      ...input,
      executionEvidence: [{ ...execution, fills: [...execution.fills, fill] }],
    })
    expect(duplicateFill.baskets[0]?.entryFillGrossNotionalMicros).toBeNull()
    expect(duplicateFill.reasonCodes).toContain(NativeAlphaAttributionReason.DuplicateFill)
    expect(duplicateFill.episodes.attributedCount).toBe(0)
  })

  test.each([
    [
      'foreign account',
      (execution: ForwardPerformanceExecutionEvidence) => ({ ...execution, accountId: 'foreign-account' }),
    ],
    [
      'wrong decision document',
      (execution: ForwardPerformanceExecutionEvidence) => ({
        ...execution,
        decisionDocumentHash: hash('wrong-document'),
      }),
    ],
    [
      'wrong strategy decision',
      (execution: ForwardPerformanceExecutionEvidence) => ({ ...execution, decisionHash: hash('wrong-decision') }),
    ],
    [
      'wrong fill price',
      (execution: ForwardPerformanceExecutionEvidence) => ({
        ...execution,
        fills: execution.fills.map((fill) => ({ ...fill, priceAtoms: '99000000000' })),
      }),
    ],
    ['missing fill', (execution: ForwardPerformanceExecutionEvidence) => ({ ...execution, fills: [] })],
    [
      'wrong fill intent',
      (execution: ForwardPerformanceExecutionEvidence) => ({
        ...execution,
        fills: execution.fills.map((fill) => ({ ...fill, intentId: hash('wrong-intent') })),
      }),
    ],
  ])('withholds unsupported economics for %s', (_label, mutate) => {
    const input = longRoundTrip()
    const execution = input.executionEvidence[0]
    assert(execution)
    const result = measure({ ...input, executionEvidence: [mutate(execution)] })
    expect(result.baskets[0]?.executionStatus).toBe('UNKNOWN')
    expect(result.baskets[0]?.entryFillSignedNotionalMicros).toBeNull()
    expect(result.baskets[0]?.economics.completeGrossPnlMicros).toBeNull()
    expect(result.financialConservation.unattributedGrossPnlMicros).toBe('10000000')
  })

  test('rejects duplicate decision identities and unverified decision sources', () => {
    const input = longRoundTrip()
    const item = input.alphaDecisions?.[0]
    assert(item)
    expect(measure({ ...input, alphaDecisions: [item, item] }).reasonCodes).toContain(
      NativeAlphaAttributionReason.DuplicateDecision,
    )
    const unverified = measure({ ...input, unverifiedAlphaDecisionHashes: [item.decisionDocumentHash] })
    expect(unverified.baskets[0]?.executionStatus).toBe('UNKNOWN')
    expect(unverified.financialConservation.attributedCompletedGrossPnlMicros).toBe('0')
  })

  test('does not touch execution evidence for unavailable or verified-empty alpha capture', () => {
    const input = longRoundTrip()
    const receipt = success(makeForwardPerformanceReceipt(input))
    const episodes = success(measurePositionEpisodes(input))
    const { alphaDecisions: _decisions, executionEvidence: _execution, ...legacy } = input
    const guarded = Object.defineProperty(legacy, 'executionEvidence', {
      get: () => {
        throw new Error('extra verification pass')
      },
    })
    const absent = success(measureNativeAlphaAttribution(guarded, receipt, episodes))
    expect(absent.status).toBe('UNAVAILABLE')
    expect(absent.financialConservation.attributedCompletedGrossPnlMicros).toBeNull()
    const empty = success(measureNativeAlphaAttribution({ ...legacy, alphaDecisions: [] }, receipt, episodes))
    expect(empty.status).toBe('NO_RECORDED_ALPHA_DECISIONS')
    expect(empty.engines).toEqual([])
  })

  test('binds evidence/provenance in deterministic hashes without altering financial or episode hashes', () => {
    const input = longRoundTrip()
    const receipt = success(makeForwardPerformanceReceipt(input))
    const episodes = success(measurePositionEpisodes(input))
    const before = JSON.stringify({ receipt, episodes })
    const measured = success(measureNativeAlphaAttribution(input, receipt, episodes))
    expect(success(measureNativeAlphaAttribution(input, receipt, episodes)).evidenceHash).toBe(measured.evidenceHash)
    expect(JSON.stringify({ receipt, episodes })).toBe(before)
    const altered = measure({
      ...input,
      alphaDecisions: (input.alphaDecisions ?? []).map((item) => ({
        ...item,
        activationBuild: { ...build, sourceRevision: 'd'.repeat(40) },
      })),
    })
    expect(altered.evidenceHash).not.toBe(measured.evidenceHash)
    const changedAccount = { ...input, account: { ...input.account, accountId: 'foreign-account' } }
    expect(measure(changedAccount).evidenceHash).not.toBe(measured.evidenceHash)
  })
})
