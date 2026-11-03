import assert from 'node:assert/strict'

import { describe, expect, test } from 'bun:test'
import { Result, Schema } from 'effect'

import { coinFeeLedgerPlan, prepareAccounting } from '../accounting/domain'
import { prepareFeeAccrual } from '../accounting/fee-accrual'
import type { AccountingTransaction } from '../accounting/schema'
import { OrderSide } from '../execution/contracts'
import { canonicalHashV1Result } from '../hash'
import { hashLedgerPlanResult } from '../ledger-plan'
import {
  decodeForwardPerformanceReceiptEnvelopeResult,
  makeForwardPerformanceReceiptEnvelope,
} from '../db/forward-performance-receipt'
import { ForwardPerformanceScopeKind, makeForwardPerformanceReport } from './report'
import type { ForwardPerformanceEvidenceInput } from './model'
import type { ForwardInferenceExpenseSession } from './inference-expenses'
import { coinActivity, coinRoundTrip } from './coin-fee-episodes.test-support'
import { measurePositionEpisodes, PositionEpisodeEvidenceSchema, PositionEpisodeReason } from './position-episodes'
import { EpisodeCostReason } from './position-outcomes'
import { supportedAssessmentFixture } from '../system-assessment/fixtures.test-support'
import { evaluateSystemAssessment } from '../system-assessment/assessment'

const success = <A, E>(result: Result.Result<A, E>): A => {
  assert(Result.isSuccess(result))
  return result.success
}

const transaction = (
  index: number,
  side: OrderSide,
  quantity: number,
  symbol = 'NVDA',
  priceAtoms = '100000000000',
  occurredAt = `2026-09-18T15:30:${String(index).padStart(2, '0')}.000Z`,
): AccountingTransaction => {
  const quantityAtoms = BigInt(quantity) * 1_000_000n
  return success(
    prepareAccounting(
      Result.getOrThrow(canonicalHashV1Result({ index, side, quantity, symbol })),
      {
        schemaVersion: 'bayn.fill.v2',
        accountId: 'episode-account',
        fillId: `fill-${index}`,
        brokerOrderId: `order-${index}`,
        clientOrderId: `client-${index}`,
        symbol,
        side,
        quantityAtoms: quantityAtoms.toString(),
        priceAtoms,
        feeMicros: '100',
        occurredAt,
      },
      side === OrderSide.Buy
        ? { quantityAtoms: '0', costMicros: '0' }
        : {
            quantityAtoms: quantityAtoms.toString(),
            costMicros: (quantityAtoms / 10n).toString(),
          },
      7_001,
    ),
  ).transaction
}

const evidence = (
  history: readonly AccountingTransaction[],
  selected: readonly AccountingTransaction[] = history,
  overrides: Partial<ForwardPerformanceEvidenceInput> = {},
): ForwardPerformanceEvidenceInput => ({
  runtime: {
    sourceRevision: 'a'.repeat(40),
    imageRepository: 'registry.example.test/bayn',
    imageDigest: `sha256:${'b'.repeat(64)}`,
  },
  account: {
    accountId: 'episode-account',
    accountReferenceHash: 'c'.repeat(64),
    provider: 'alpaca',
    environment: 'sandbox',
  },
  durableExecutionBindings: [],
  cycles: [],
  reconciliation: {
    reconciliationId: 'd'.repeat(64),
    contentHash: 'e'.repeat(64),
    status: 'EXACT',
    performanceExact: true,
    cashYieldAdjustedExact: false,
    reconciledAt: '2026-09-18T21:00:00.000Z',
  },
  accountTransactions: history,
  transactions: selected.map((item) => ({ ...item, cycleId: 'f'.repeat(64) })),
  accountingReceiptsExact: true,
  ledgerExact: true,
  missingLedgerAccountCount: 0,
  cashYieldEvidenceRequired: false,
  unresolvedMutationCount: 0,
  unclosedCycleCount: 0,
  openPositionCount: 0,
  accountPositionCounts: {
    postgres: overrides.openPositionCount ?? 0,
    ledger: overrides.openPositionCount ?? 0,
    reconciledAt: overrides.reconciliation?.reconciledAt ?? '2026-09-18T21:00:00.000Z',
    exact: overrides.reconciliation?.performanceExact ?? true,
  },
  ...overrides,
})

const roundTrip = () => [transaction(1, OrderSide.Buy, 2), transaction(2, OrderSide.Sell, 2)]

const cashAccrual = (
  fills: readonly AccountingTransaction[],
  observedAt = '2026-09-18T16:00:00.000Z',
  debitMicros = '10000',
) => {
  const prepared = success(
    prepareFeeAccrual(
      {
        schemaVersion: 'bayn.broker-fee-accrual.v2',
        kind: 'CASH',
        accountId: 'episode-account',
        symbol: 'USD',
        date: '2026-09-18',
        cycleId: 'f'.repeat(64),
        observedAt,
        openingAccountEventId: 'a'.repeat(64),
        openingCashReportingQuantumMicros: '10000',
        accountEventId: 'b'.repeat(64),
        projectedCashMicros: '100000000',
        observedCashMicros: (100_000_000n - BigInt(debitMicros)).toString(),
        cashReportingQuantumMicros: '10000',
        sourceTrades: fills
          .filter((fill) => fill.side === OrderSide.Sell)
          .map(({ transactionId, quantityAtoms, priceAtoms }) => ({ transactionId, quantityAtoms, priceAtoms }))
          .sort((a, b) => a.transactionId.localeCompare(b.transactionId)),
      },
      7_001,
    ),
  )
  return {
    accrual_id: prepared.accrualId,
    data: prepared.data,
    settlement_date: prepared.data.date,
    content_hash: prepared.contentHash,
    coin_quantity_atoms: prepared.coinQuantityAtoms,
    cash_debit_micros: prepared.cashDebitMicros,
    expense_micros: prepared.expenseMicros,
    matched_coin_quantity_atoms: '0',
    matched_cash_micros: '0',
    ledger_plan_hash: success(hashLedgerPlanResult(prepared.plan)),
    tigerbeetle_cluster_id: '2001',
    tigerbeetle_ledger: 7_001,
    posted: true,
  }
}

const delayedCoinActivity = (sourceDate: '2026-09-18' | '2026-09-19'): ReturnType<typeof coinActivity> => {
  const original = coinActivity()
  const data: typeof original.data = {
    ...original.data,
    activityId: `synthetic-delayed-coin-fee-${sourceDate}`,
    date: '2026-09-19',
  }
  return {
    ...original,
    data,
    content_hash: success(canonicalHashV1Result({ schemaVersion: 'bayn.broker-fee.v1', ...data })),
    ledger_plan_hash: success(
      hashLedgerPlanResult(coinFeeLedgerPlan(data.accountId, data.activityId, 'ETH/USD', '0', 7_001)),
    ),
    read_evidence: {
      ...original.read_evidence,
      sourceCreatedAt: `${sourceDate}T15:30:${sourceDate === '2026-09-18' ? '01' : '04'}.500000000Z`,
      observedAt: '2026-09-20T08:00:00.000Z',
    },
  }
}

const laterAccountCut = (input: ForwardPerformanceEvidenceInput): ForwardPerformanceEvidenceInput => {
  assert(input.reconciliation !== undefined)
  const reconciledAt = '2026-09-20T09:00:00.000Z'
  return {
    ...input,
    reconciliation: { ...input.reconciliation, reconciledAt },
    accountPositionCounts: { postgres: 0, ledger: 0, exact: true, reconciledAt },
  }
}

describe('position episodes', () => {
  test('reports actual partial fills and multi-hour holding duration without allocating equity fees', () => {
    const history = [
      transaction(1, OrderSide.Buy, 2, 'NVDA', '100000000000', '2026-09-18T16:39:20.825Z'),
      transaction(2, OrderSide.Buy, 3, 'NVDA', '100000000000', '2026-09-18T16:39:22.000Z'),
      transaction(3, OrderSide.Sell, 1, 'NVDA', '99000000000', '2026-09-18T16:45:00.000Z'),
      transaction(4, OrderSide.Sell, 4, 'NVDA', '98000000000', '2026-09-18T22:22:53.283Z'),
    ]
    const result = success(
      measurePositionEpisodes(
        evidence(history, history, {
          accountPositionCounts: { postgres: 0, ledger: 0, exact: true, reconciledAt: '2026-09-18T23:00:00.000Z' },
        }),
      ),
    )
    assert(result.status === 'MEASURED')
    expect(Schema.is(PositionEpisodeEvidenceSchema)(result)).toBe(true)
    expect(result.completedCount).toBe(1)
    expect(result.completed).toHaveLength(1)
    expect(result.completed[0]).toMatchObject({
      symbol: 'NVDA',
      openedAt: '2026-09-18T16:39:20.825Z',
      closedAt: '2026-09-18T22:22:53.283Z',
      holdingDurationMs: 20_612_458,
      buyFillCount: 2,
      sellFillCount: 2,
      buyNotionalMicros: '500000',
      turnoverMicros: '991000',
      grossRealizedPnlMicros: '-9000',
      costs: { status: 'UNDETERMINED', reason: EpisodeCostReason.NonCryptoAllocationUnavailable },
    })
    expect(result.bySymbol[0]).toMatchObject({
      completedCount: 1,
      grossLosingCount: 1,
      maximumHoldingDurationMs: 20_612_458,
      medianHoldingDurationMs: 20_612_458,
      netPnlAfterAttributedCostsMicros: null,
    })
  })

  test('keeps per-symbol gross loss concentration and re-entries separate from sell counts', () => {
    const history = [
      transaction(1, OrderSide.Buy, 2),
      transaction(2, OrderSide.Sell, 2, 'NVDA', '99000000000'),
      transaction(3, OrderSide.Buy, 1),
      transaction(5, OrderSide.Sell, 1, 'NVDA', '101000000000'),
      transaction(6, OrderSide.Buy, 2, 'AAPL'),
      transaction(7, OrderSide.Sell, 2, 'AAPL', '101000000000'),
    ]
    const result = success(measurePositionEpisodes(evidence(history)))
    assert(result.status === 'MEASURED')
    expect(result.bySymbol.map((row) => row.symbol)).toEqual(['AAPL', 'NVDA'])
    expect(result.bySymbol[1]).toMatchObject({
      completedCount: 2,
      grossWinningCount: 1,
      grossLosingCount: 1,
      grossFlatCount: 0,
      grossRealizedPnlMicros: '-1000',
      worstGrossRealizedPnlMicros: '-2000',
      medianHoldingDurationMs: 1500,
      maximumHoldingDurationMs: 2000,
      attributedCostEpisodeCount: 0,
      netPnlAfterAttributedCostsMicros: null,
    })
    expect(success(measurePositionEpisodes(evidence(history.toReversed())))).toEqual(result)
    const scoped = success(measurePositionEpisodes(evidence(history, history.slice(1, 4))))
    assert(scoped.status === 'MEASURED')
    expect(scoped.completedCount).toBe(1)
    expect(scoped.crossScopeCount).toBe(1)
    expect(scoped.completed.map((row) => row.grossRealizedPnlMicros)).toEqual(['1000'])
  })

  test('attributes each complete crypto accrual once and leaves final and operating costs explicit', () => {
    const { fills, accrual } = coinRoundTrip()
    const cash = cashAccrual(fills)
    const input = evidence(fills, fills, { accountFeeAccruals: [cash, accrual], accountBrokerFees: [] })
    const result = success(measurePositionEpisodes(input))
    assert(result.status === 'MEASURED')
    expect(Schema.is(PositionEpisodeEvidenceSchema)(result)).toBe(true)
    expect(result.completed[0]).toMatchObject({
      grossRealizedPnlMicros: '0',
      holdingDurationMs: 2000,
      costs: {
        status: 'ATTRIBUTED_ACCRUALS',
        scope: 'FILL_FEES_AND_SOURCE_LINKED_ACCRUALS',
        attributedCostMicros: '18262',
        netPnlAfterAttributedCostsMicros: '-18262',
        finalExecutionCostCoverage: 'UNDETERMINED',
        brokerActivityAdjustmentsIncluded: false,
        allInProfitMicros: null,
      },
    })
    expect(result.bySymbol[0]).toMatchObject({
      attributedCostEpisodeCount: 1,
      netPnlAfterAttributedCostsMicros: '-18262',
      allInProfitMicros: null,
    })
    const matched = success(
      measurePositionEpisodes({
        ...input,
        accountFeeAccruals: [
          { ...accrual, matched_coin_quantity_atoms: '82625' },
          { ...cash, matched_cash_micros: '10000' },
        ],
        accountBrokerFees: [coinActivity()],
      }),
    )
    assert(matched.status === 'MEASURED')
    expect(matched.completed[0]?.costs).toMatchObject({
      attributedCostMicros: '18262',
      netPnlAfterAttributedCostsMicros: '-18262',
      finalExecutionCostCoverage: 'UNDETERMINED',
      brokerActivityAdjustmentsIncluded: false,
    })
  })

  test('does not turn absent or invalid cash cost linkage into zero per-episode costs', () => {
    const { fills, accrual } = coinRoundTrip()
    const cash = cashAccrual(fills)
    const missing = success(
      measurePositionEpisodes(evidence(fills, fills, { accountFeeAccruals: [accrual], accountBrokerFees: [] })),
    )
    assert(missing.status === 'MEASURED')
    expect(missing.completed[0]?.costs).toMatchObject({
      status: 'UNDETERMINED',
      reason: EpisodeCostReason.MissingSourceAccrual,
      attributedCostMicros: null,
      netPnlAfterAttributedCostsMicros: null,
    })
    for (const invalid of [
      { ...cash, posted: false },
      { ...cash, data: { ...cash.data, accountId: 'foreign-account' } },
      { ...cash, data: { ...cash.data, observedAt: '2026-09-19T00:00:00.000Z' } },
      {
        ...cash,
        data: { ...cash.data, sourceTrades: cash.data.sourceTrades.map((trade) => ({ ...trade, priceAtoms: '1' })) },
      },
    ]) {
      const result = success(
        measurePositionEpisodes(
          evidence(fills, fills, { accountFeeAccruals: [accrual, invalid], accountBrokerFees: [] }),
        ),
      )
      assert(result.status === 'MEASURED')
      expect(result.completed[0]?.costs).toMatchObject({
        status: 'UNDETERMINED',
        reason: EpisodeCostReason.InvalidFeeHistory,
      })
      expect(result.bySymbol[0]?.netPnlAfterAttributedCostsMicros).toBeNull()
    }
  })

  test('refuses to allocate pooled cash accruals across complete episodes', () => {
    const first = coinRoundTrip()
    const second = coinRoundTrip(3)
    const history = [...first.fills, ...second.fills]
    for (const selected of [history, first.fills]) {
      const result = success(
        measurePositionEpisodes(
          evidence(history, selected, {
            accountFeeAccruals: [first.accrual, second.accrual, cashAccrual(history)],
            accountBrokerFees: [],
          }),
        ),
      )
      assert(result.status === 'MEASURED')
      expect(result.completedCount).toBe(selected === history ? 2 : 1)
      expect(
        result.completed.every(
          (row) => row.costs.status === 'UNDETERMINED' && row.costs.reason === EpisodeCostReason.SharedSourceAccrual,
        ),
      ).toBe(true)
      expect(result.bySymbol[0]?.netPnlAfterAttributedCostsMicros).toBeNull()
    }
  })

  test('rejects two distinct valid cash accruals claiming the same source sell', () => {
    const { fills, accrual } = coinRoundTrip()
    const cash = cashAccrual(fills)
    const conflicting = cashAccrual(fills, '2026-09-18T16:00:01.000Z', '20000')
    expect(conflicting.accrual_id).not.toBe(cash.accrual_id)
    const result = success(
      measurePositionEpisodes(
        evidence(fills, fills, { accountFeeAccruals: [accrual, cash, conflicting], accountBrokerFees: [] }),
      ),
    )
    assert(result.status === 'MEASURED')
    expect(result.completed[0]?.costs).toMatchObject({
      status: 'UNDETERMINED',
      reason: EpisodeCostReason.InvalidFeeHistory,
      netPnlAfterAttributedCostsMicros: null,
    })
  })

  test('closes gross fractional buys and net sells using the observed coin debit', () => {
    const { fills, accrual } = coinRoundTrip()
    const input = evidence(fills, fills, { accountFeeAccruals: [accrual], accountBrokerFees: [] })
    expect(success(measurePositionEpisodes(input))).toMatchObject({
      status: 'MEASURED',
      completedCount: 1,
      openCount: 0,
      crossScopeCount: 0,
    })
    const report = success(makeForwardPerformanceReport(input, []))
    expect(report.receipt.counts.completedExecutionCount).toBe(2)
    expect(report.receipt.profitability).toBe('UNDETERMINED')
    expect(report.operatingCostCoverage).toBe('INCOMPLETE')
  })

  test('counts fractional re-entry, an open net holding and inherited inventory', () => {
    const first = coinRoundTrip()
    const second = coinRoundTrip(3)
    const history = [...first.fills, ...second.fills]
    const input = evidence(history, history, {
      accountFeeAccruals: [first.accrual, second.accrual],
      accountBrokerFees: [],
    })
    const result = success(measurePositionEpisodes(input))
    expect(result).toMatchObject({ status: 'MEASURED', completedCount: 2, openCount: 0, crossScopeCount: 0 })
    expect(
      success(
        measurePositionEpisodes({
          ...input,
          accountTransactions: history.toReversed(),
          transactions: input.transactions.toReversed(),
          accountFeeAccruals: [second.accrual, first.accrual],
        }),
      ),
    ).toEqual(result)
    expect(
      success(
        measurePositionEpisodes(
          evidence(first.fills.slice(0, 1), first.fills.slice(0, 1), {
            accountFeeAccruals: [first.accrual],
            accountBrokerFees: [],
            openPositionCount: 1,
          }),
        ),
      ),
    ).toMatchObject({ status: 'MEASURED', completedCount: 0, openCount: 1 })
    expect(
      success(
        measurePositionEpisodes(
          evidence(first.fills, first.fills.slice(1), {
            accountFeeAccruals: [first.accrual],
            accountBrokerFees: [],
          }),
        ),
      ),
    ).toMatchObject({ status: 'MEASURED', completedCount: 0, crossScopeCount: 1 })
  })

  test.each(['0', '40000', '82625'])(
    'counts an accrued debit once with %s atoms receipted and preserves financial uncertainty',
    (matched) => {
      const { fills, accrual } = coinRoundTrip()
      const fee = coinActivity(matched === '0' ? '82625' : matched)
      const settled = matched === '82625'
      const input = evidence(fills, fills, {
        startingCapitalMicros: '100000000',
        accountFeeAccruals: [{ ...accrual, matched_coin_quantity_atoms: matched }],
        accountBrokerFees: matched === '0' ? [] : [fee],
        brokerFeeAccruals: [
          {
            accrualId: accrual.accrual_id,
            accountId: accrual.data.accountId,
            expenseMicros: accrual.expense_micros,
            settled,
          },
        ],
        brokerFees: matched === '0' ? [] : [{ ...fee.data, inventoryCostMicros: '0' }],
        ledgerTotals: {
          realizedGainMicros: '0',
          cashSettlementRoundingMicros: '0',
          realizedLossMicros: '0',
          brokerExecutionFeesMicros: '8262',
          otherChargedCostsMicros: '0',
          cashYieldMicros: '0',
        },
      })
      const report = success(makeForwardPerformanceReport(input, []))
      expect(report.positionEpisodes).toMatchObject({ status: 'MEASURED', completedCount: 1, openCount: 0 })
      expect(report.receipt.totals.grossRealizedPnlMicros).toBe('0')
      expect(report.receipt.totals.brokerExecutionFeesMicros).toBe('8262')
      expect(report.receipt.totals.netRealizedPnlAfterCostsMicros).toBe('-8262')
      expect(report.receipt.evidence.reasonCodes).not.toContain('LEDGER_MISMATCH')
      expect(report.receipt.evidence.reasonCodes.includes('BROKER_FEE_SETTLEMENT_PENDING')).toBe(!settled)
      expect(report.receipt.profitability).toBe('UNDETERMINED')
    },
  )

  test('measures two source UTC cohorts whose settled coin receipts share a later posting date', () => {
    const first = coinRoundTrip()
    const second = coinRoundTrip(3, 'episode-account', 'f'.repeat(64), { sourceDate: '2026-09-19' })
    const fills = [...first.fills, ...second.fills]
    const accruals = [first.accrual, second.accrual].map((accrual) => ({
      ...accrual,
      matched_coin_quantity_atoms: '82625',
    }))
    const fees = [delayedCoinActivity('2026-09-18'), delayedCoinActivity('2026-09-19')]
    const input = laterAccountCut(evidence(fills, fills, { accountFeeAccruals: accruals, accountBrokerFees: fees }))
    const measured = success(measurePositionEpisodes(input))
    expect(measured).toMatchObject({
      status: 'MEASURED',
      completedCount: 2,
      openCount: 0,
      crossScopeCount: 0,
    })
    assert(measured.status === 'MEASURED')
    expect(
      measured.completed.map(({ openedAt, closedAt, holdingDurationMs }) => ({
        openedAt,
        closedAt,
        holdingDurationMs,
      })),
    ).toEqual([
      { openedAt: '2026-09-18T15:30:01.000Z', closedAt: '2026-09-18T15:30:03.000Z', holdingDurationMs: 2000 },
      { openedAt: '2026-09-19T15:30:04.000Z', closedAt: '2026-09-19T15:30:06.000Z', holdingDurationMs: 2000 },
    ])
    expect(
      success(
        measurePositionEpisodes({
          ...input,
          accountTransactions: fills.toReversed(),
          transactions: input.transactions.toReversed(),
          accountFeeAccruals: accruals.toReversed(),
          accountBrokerFees: fees.toReversed(),
        }),
      ),
    ).toEqual(measured)

    const report = success(makeForwardPerformanceReport({ ...input, transactions: [] }, []))
    expect(report.positionEpisodes).toMatchObject({
      status: 'MEASURED',
      completedCount: 0,
      openCount: 0,
      crossScopeCount: 0,
      completed: [],
      bySymbol: [],
    })
    expect(report.receipt.profitability).toBe('UNDETERMINED')
    expect(report.operatingCostCoverage).toBe('INCOMPLETE')
  })

  test('uses the source-trade cohort when a coin accrual is observed on the following UTC date', () => {
    const { fills, accrual } = coinRoundTrip(0, 'episode-account', 'f'.repeat(64), {
      sourceDate: '2026-09-18',
      observedDate: '2026-09-19',
    })
    expect(accrual.data.date).toBe('2026-09-19')
    expect(accrual.settlement_date).toBe('2026-09-18')
    const fee = coinActivity()
    const measured = success(
      measurePositionEpisodes(
        laterAccountCut(
          evidence(fills, fills, {
            accountFeeAccruals: [{ ...accrual, matched_coin_quantity_atoms: '82625' }],
            accountBrokerFees: [
              { ...fee, read_evidence: { ...fee.read_evidence, observedAt: '2026-09-20T08:00:00.000Z' } },
            ],
          }),
        ),
      ),
    )
    expect(measured).toMatchObject({ status: 'MEASURED', completedCount: 1, openCount: 0 })
    assert(measured.status === 'MEASURED')
    expect(measured.completed[0]).toMatchObject({
      openedAt: '2026-09-18T15:30:01.000Z',
      closedAt: '2026-09-19T15:30:03.000Z',
      holdingDurationMs: 86_402_000,
    })
  })

  test('retains posting-date settlement for legacy coin receipts without a source timestamp', () => {
    const { fills, accrual } = coinRoundTrip()
    const fee = coinActivity()
    expect(fee.read_evidence.sourceCreatedAt).toBeUndefined()
    expect(
      success(
        measurePositionEpisodes(
          evidence(fills, fills, {
            accountFeeAccruals: [{ ...accrual, matched_coin_quantity_atoms: '82625' }],
            accountBrokerFees: [fee],
          }),
        ),
      ),
    ).toMatchObject({ status: 'MEASURED', completedCount: 1, openCount: 0 })
  })

  test.each([
    '2026-02-30T15:30:01.500000000Z',
    '2026-09-18T25:30:01.500000000Z',
    '2026-09-18T15:30:01.500Z',
    '2026-09-18T16:00:00.000000001Z',
  ] as const)('rejects invalid or future coin receipt provenance %s', (sourceCreatedAt) => {
    const { fills, accrual } = coinRoundTrip()
    const fee = coinActivity()
    expect(
      success(
        measurePositionEpisodes(
          evidence(fills, fills, {
            accountFeeAccruals: [{ ...accrual, matched_coin_quantity_atoms: '82625' }],
            accountBrokerFees: [{ ...fee, read_evidence: { ...fee.read_evidence, sourceCreatedAt } }],
          }),
        ),
      ),
    ).toMatchObject({ status: 'UNDETERMINED', reason: PositionEpisodeReason.InvalidHistory })
  })

  test('does not use matching posting dates to conceal a different source UTC cohort', () => {
    const { fills, accrual } = coinRoundTrip()
    const fee = coinActivity()
    expect(
      success(
        measurePositionEpisodes(
          laterAccountCut(
            evidence(fills, fills, {
              accountFeeAccruals: [{ ...accrual, matched_coin_quantity_atoms: '82625' }],
              accountBrokerFees: [
                {
                  ...fee,
                  read_evidence: {
                    ...fee.read_evidence,
                    observedAt: '2026-09-20T08:00:00.000Z',
                    sourceCreatedAt: '2026-09-19T15:30:01.500000000Z',
                  },
                },
              ],
            }),
          ),
        ),
      ),
    ).toMatchObject({ status: 'UNDETERMINED', reason: PositionEpisodeReason.InvalidHistory })
  })

  test.each(['2026-02-30', '2026-09-19'] as const)(
    'rejects invalid or substituted source-trade settlement date %s',
    (settlement_date) => {
      const { fills, accrual } = coinRoundTrip()
      expect(
        success(
          measurePositionEpisodes(
            evidence(fills, fills, {
              accountFeeAccruals: [{ ...accrual, settlement_date, matched_coin_quantity_atoms: '82625' }],
              accountBrokerFees: [coinActivity()],
            }),
          ),
        ),
      ).toMatchObject({ status: 'UNDETERMINED', reason: PositionEpisodeReason.InvalidHistory })
    },
  )

  test('keeps missing fee history, an absent debit and unplaced fee receipts undetermined', () => {
    const { fills, accrual } = coinRoundTrip()
    for (const overrides of [{}, { accountFeeAccruals: [accrual] }, { accountBrokerFees: [] }])
      expect(success(measurePositionEpisodes(evidence(fills, fills, overrides)))).toMatchObject({
        status: 'UNDETERMINED',
        reason: PositionEpisodeReason.FeeHistoryUnavailable,
      })
    expect(
      success(
        measurePositionEpisodes(
          evidence(fills, fills, {
            accountFeeAccruals: [],
            accountBrokerFees: [],
          }),
        ),
      ),
    ).toMatchObject({ status: 'UNDETERMINED', reason: PositionEpisodeReason.ReconciliationGap })
    expect(
      success(
        measurePositionEpisodes(
          evidence(fills, fills, {
            accountFeeAccruals: [],
            accountBrokerFees: [coinActivity()],
          }),
        ),
      ),
    ).toMatchObject({ status: 'UNDETERMINED', reason: PositionEpisodeReason.AmbiguousFeeOrder })
  })

  test('keeps pooled partial fee receipts separate from individual episode boundaries', () => {
    const first = coinRoundTrip()
    const second = coinRoundTrip(3)
    const fills = [...first.fills, ...second.fills]
    expect(
      success(
        measurePositionEpisodes(
          evidence(fills, fills, {
            accountFeeAccruals: [{ ...first.accrual, matched_coin_quantity_atoms: '82625' }, second.accrual],
            accountBrokerFees: [coinActivity()],
          }),
        ),
      ),
    ).toMatchObject({ status: 'MEASURED', completedCount: 2, openCount: 0 })
  })

  test('requires a cumulative inventory boundary and retains disagreement with either independent count', () => {
    const { fills, accrual } = coinRoundTrip()
    const input = evidence(fills, fills, { accountFeeAccruals: [accrual], accountBrokerFees: [] })
    const { accountPositionCounts: counts, ...missing } = input
    if (counts === undefined) throw new Error('Missing account cut fixture')
    for (const value of [
      missing,
      { ...input, accountPositionCounts: { ...counts, postgres: 1, ledger: 0 } },
      { ...input, accountPositionCounts: { ...counts, postgres: 0, ledger: 1 } },
    ])
      expect(success(measurePositionEpisodes(value))).toMatchObject({
        status: 'UNDETERMINED',
        reason: PositionEpisodeReason.ReconciliationGap,
      })
  })

  test('rejects a coin debit bound to a previous gross-flat episode', () => {
    const first = coinRoundTrip()
    const second = coinRoundTrip(3)
    const firstFill = first.fills[0]
    const secondSell = second.fills[1]
    assert(firstFill !== undefined && secondSell !== undefined)
    const fills = [
      firstFill,
      {
        ...secondSell,
        transactionId: 'a'.repeat(64),
        brokerEventId: 'b'.repeat(64),
        quantityAtoms: firstFill.quantityAtoms,
        quantityDeltaAtoms: `-${firstFill.quantityAtoms}`,
        occurredAt: '2026-09-18T15:30:03.000Z',
      },
      ...second.fills,
    ]
    expect(
      success(
        measurePositionEpisodes(
          evidence(fills, fills, {
            accountFeeAccruals: [
              { ...first.accrual, data: { ...first.accrual.data, observedAt: '2026-09-18T15:30:05.000Z' } },
            ],
            accountBrokerFees: [],
          }),
        ),
      ),
    ).toMatchObject({ status: 'UNDETERMINED', reason: PositionEpisodeReason.InvalidHistory })
  })

  test('rejects duplicate, foreign, future, unposted and unbound coin accruals', () => {
    const { fills, accrual } = coinRoundTrip()
    assert(accrual.data.kind === 'COIN')
    const data = accrual.data
    const source = data.sourceTrades[0]
    assert(source !== undefined)
    const histories = [
      [accrual, accrual],
      [{ ...accrual, posted: false }],
      [{ ...accrual, coin_quantity_atoms: '82624' }],
      [{ ...accrual, matched_coin_quantity_atoms: '82626' }],
      [{ ...accrual, data: { ...data, accountId: 'another-account' } }],
      [{ ...accrual, data: { ...data, observedAt: '2026-09-19T00:00:00.000Z' } }],
      [{ ...accrual, data: { ...data, observedAt: '2026-09-18T15:30:00.000Z' } }],
      [{ ...accrual, data: { ...data, projectedQuantityAtoms: '33050001', observedQuantityAtoms: '32967376' } }],
      [{ ...accrual, data: { ...data, sourceTrades: [] } }],
      [{ ...accrual, data: { ...data, sourceTrades: [{ ...source, transactionId: 'a'.repeat(64) }] } }],
      [{ ...accrual, data: { ...data, sourceTrades: [{ ...source, quantityAtoms: '1' }] } }],
      [{ ...accrual, data: { ...data, sourceTrades: [{ ...source, priceAtoms: '1' }] } }],
      [{ ...accrual, data: { ...data, sourceTrades: [source, source] } }],
    ]
    for (const accountFeeAccruals of histories)
      expect(
        success(
          measurePositionEpisodes(
            evidence(fills, fills, {
              accountFeeAccruals,
              accountBrokerFees: [],
            }),
          ),
        ),
      ).toMatchObject({ status: 'UNDETERMINED', reason: PositionEpisodeReason.InvalidHistory })
  })

  test('does not order a same-instant fee against a fill', () => {
    const { fills, accrual } = coinRoundTrip()
    const simultaneous = { ...accrual, data: { ...accrual.data, observedAt: '2026-09-18T15:30:03.000Z' } }
    expect(
      success(
        measurePositionEpisodes(
          evidence(fills, fills, {
            accountFeeAccruals: [simultaneous],
            accountBrokerFees: [],
          }),
        ),
      ),
    ).toMatchObject({ status: 'UNDETERMINED', reason: PositionEpisodeReason.AmbiguousFeeOrder })
  })

  test('rejects duplicate receipts, unavailable matches and unmatched excess without double counting', () => {
    const { fills, accrual } = coinRoundTrip()
    const fee = coinActivity()
    for (const accountBrokerFees of [
      [],
      [fee, fee],
      [{ ...fee, posted: false }],
      [{ ...fee, data: { ...fee.data, accountId: 'another-account' } }],
      [{ ...fee, read_evidence: { ...fee.read_evidence, observedAt: '2026-09-19T00:00:00.000Z' } }],
    ])
      expect(
        success(
          measurePositionEpisodes(
            evidence(fills, fills, {
              accountFeeAccruals: [{ ...accrual, matched_coin_quantity_atoms: '82625' }],
              accountBrokerFees,
            }),
          ),
        ),
      ).toMatchObject({ status: 'UNDETERMINED', reason: PositionEpisodeReason.InvalidHistory })
    expect(
      success(
        measurePositionEpisodes(
          evidence(fills, fills, {
            accountFeeAccruals: [{ ...accrual, matched_coin_quantity_atoms: '40000' }],
            accountBrokerFees: [fee],
          }),
        ),
      ),
    ).toMatchObject({ status: 'UNDETERMINED', reason: PositionEpisodeReason.AmbiguousFeeOrder })
  })

  test('hashes complete fee provenance independently of selected-scope financial evidence', () => {
    const { fills, accrual } = coinRoundTrip()
    const input = evidence(fills, fills, { accountFeeAccruals: [accrual], accountBrokerFees: [] })
    const report = success(makeForwardPerformanceReport(input, []))
    const changed = success(
      makeForwardPerformanceReport(
        {
          ...input,
          accountFeeAccruals: [{ ...accrual, content_hash: 'b'.repeat(64) }],
        },
        [],
      ),
    )
    expect(changed.receipt).toEqual(report.receipt)
    expect(changed.positionEpisodes.evidenceHash).not.toBe(report.positionEpisodes.evidenceHash)
    expect(changed.reportHash).not.toBe(report.reportHash)
  })

  test('binds cumulative inventory to the current account cut independently of the generation cut', () => {
    const history = roundTrip()
    const first = history[0]
    if (first === undefined) throw new Error('Missing historical entry')
    const input = evidence(history, [first])
    if (input.reconciliation === undefined || input.accountPositionCounts === undefined)
      throw new Error('Missing account cut')
    const historical = { ...input, reconciliation: { ...input.reconciliation, reconciledAt: first.occurredAt } }
    expect(success(measurePositionEpisodes(historical))).toMatchObject({
      status: 'MEASURED',
      completedCount: 0,
      openCount: 0,
      crossScopeCount: 1,
    })
    expect(
      success(
        measurePositionEpisodes({
          ...historical,
          accountPositionCounts: { ...input.accountPositionCounts, reconciledAt: first.occurredAt },
        }),
      ),
    ).toMatchObject({ status: 'UNDETERMINED', reason: 'INVALID_HISTORY' })
  })

  test('counts a scaled-in position with partial exits as one episode', () => {
    const history = [
      transaction(1, OrderSide.Buy, 2),
      transaction(2, OrderSide.Buy, 3),
      transaction(3, OrderSide.Sell, 1),
      transaction(4, OrderSide.Sell, 4),
    ]
    const result = success(measurePositionEpisodes(evidence(history)))
    expect(result).toMatchObject({ status: 'MEASURED', completedCount: 1, openCount: 0, crossScopeCount: 0 })
    const report = success(makeForwardPerformanceReport(evidence(history), []))
    expect(report.receipt.counts.completedExecutionCount).toBe(4)
    expect(report.positionEpisodes).toEqual(result)
  })

  test('counts re-entry and interleaved symbols separately from open inventory', () => {
    const history = [
      transaction(1, OrderSide.Buy, 2),
      transaction(2, OrderSide.Buy, 3, 'AAPL'),
      transaction(3, OrderSide.Sell, 2),
      transaction(4, OrderSide.Buy, 1),
      transaction(5, OrderSide.Sell, 1),
      transaction(6, OrderSide.Sell, 2, 'AAPL'),
    ]
    expect(success(measurePositionEpisodes(evidence(history, history, { openPositionCount: 1 })))).toMatchObject({
      status: 'MEASURED',
      completedCount: 2,
      openCount: 1,
      crossScopeCount: 0,
    })
  })

  test('excludes inherited inventory from completed round trips in the selected scope', () => {
    const history = [
      transaction(1, OrderSide.Buy, 2),
      transaction(2, OrderSide.Buy, 1),
      transaction(3, OrderSide.Sell, 3),
    ]
    expect(success(measurePositionEpisodes(evidence(history, history.slice(1))))).toMatchObject({
      status: 'MEASURED',
      completedCount: 0,
      openCount: 0,
      crossScopeCount: 1,
    })
  })

  test('counts only the selected complete episodes from the cumulative history', () => {
    const history = [...roundTrip(), transaction(3, OrderSide.Buy, 1), transaction(4, OrderSide.Sell, 1)]
    const selected = history.slice(2)
    const first = success(measurePositionEpisodes(evidence(history, selected)))
    const reordered = success(measurePositionEpisodes(evidence(history.toReversed(), selected.toReversed())))
    expect(first).toEqual(reordered)
    expect(first).toMatchObject({ status: 'MEASURED', completedCount: 1 })
  })

  test('reports verified zero trades without turning absent history into zero', () => {
    expect(success(measurePositionEpisodes(evidence([])))).toMatchObject({ status: 'MEASURED', completedCount: 0 })
    const { accountTransactions: _history, ...input } = evidence([])
    expect(success(measurePositionEpisodes(input))).toMatchObject({
      status: 'UNDETERMINED',
      reason: PositionEpisodeReason.HistoryUnavailable,
    })
  })

  test('rejects a missing opening fill even when the selected sell has a receipt', () => {
    const history = [transaction(2, OrderSide.Sell, 2)]
    expect(success(measurePositionEpisodes(evidence(history)))).toMatchObject({
      status: 'UNDETERMINED',
      reason: PositionEpisodeReason.InvalidHistory,
    })
  })

  test('does not invent buy/sell ordering within one millisecond', () => {
    const [buy, sell] = roundTrip()
    assert(buy !== undefined && sell !== undefined)
    const history = [buy, { ...sell, occurredAt: buy.occurredAt }]
    expect(success(measurePositionEpisodes(evidence(history)))).toMatchObject({
      status: 'UNDETERMINED',
      reason: PositionEpisodeReason.AmbiguousFillOrder,
    })
  })

  test.each(['duplicate', 'account', 'delta', 'future'] as const)('rejects %s account history', (fault) => {
    const [buy, sell] = roundTrip()
    assert(buy !== undefined && sell !== undefined)
    const history =
      fault === 'duplicate'
        ? [buy, buy, sell]
        : [
            buy,
            {
              ...sell,
              ...(fault === 'account' ? { accountId: 'another-account' } : {}),
              ...(fault === 'delta' ? { quantityDeltaAtoms: '2000000000' } : {}),
              ...(fault === 'future' ? { occurredAt: '2026-09-19T15:30:02.000Z' } : {}),
            },
          ]
    expect(success(measurePositionEpisodes(evidence(history)))).toMatchObject({
      status: 'UNDETERMINED',
      reason: PositionEpisodeReason.InvalidHistory,
    })
  })

  test('rejects a missing, duplicate or mismatched selected transaction', () => {
    const history = roundTrip()
    const [buy] = history
    assert(buy !== undefined)
    for (const selected of [[buy, buy], [{ ...buy, symbol: 'AAPL' }], [transaction(3, OrderSide.Buy, 1)]]) {
      expect(success(measurePositionEpisodes(evidence(history, selected)))).toMatchObject({
        status: 'UNDETERMINED',
        reason: PositionEpisodeReason.ScopeMismatch,
      })
    }
  })

  test.each([
    { priceAtoms: '100000000001' },
    { notionalMicros: '200001' },
    { feeMicros: '0' },
    { realizedPnlMicros: '1000000' },
  ])('rejects conflicting scoped financial evidence %j', (override) => {
    const history = roundTrip()
    const input = evidence(history)
    const report = success(
      makeForwardPerformanceReport(
        { ...input, transactions: input.transactions.map((item) => ({ ...item, ...override })) },
        [],
      ),
    )
    expect(report.positionEpisodes).toMatchObject({
      status: 'UNDETERMINED',
      reason: PositionEpisodeReason.ScopeMismatch,
    })
    expect(report.receipt.profitability).toBe('UNDETERMINED')
    expect(report.operatingCostCoverage).toBe('INCOMPLETE')
  })

  test('retains matching partial scopes and historical projections without optional pricing', () => {
    const history = roundTrip()
    for (const selected of [history, history.slice(1)]) {
      const input = evidence(history, selected)
      const projection = input.transactions.map(({ priceAtoms: _price, notionalMicros: _notional, ...item }) => item)
      const report = success(makeForwardPerformanceReport({ ...input, transactions: projection }, []))
      expect(report.positionEpisodes).toMatchObject({
        status: 'MEASURED',
        completedCount: selected.length === history.length ? 1 : 0,
        crossScopeCount: selected.length === history.length ? 0 : 1,
      })
      expect(report.receipt.profitability).toBe('UNDETERMINED')
      expect(report.operatingCostCoverage).toBe('INCOMPLETE')
    }
  })

  test.each([
    { ledgerExact: false },
    { accountingReceiptsExact: false },
    { unresolvedMutationCount: 1 },
    { missingLedgerAccountCount: 1 },
    { openPositionCount: 1 },
  ])('withholds measurement for reconciliation gaps %j', (override) => {
    const history = roundTrip()
    expect(success(measurePositionEpisodes(evidence(history, history, override)))).toMatchObject({
      status: 'UNDETERMINED',
      reason: PositionEpisodeReason.ReconciliationGap,
    })
  })

  test('binds the declared inference expense snapshot timestamp in the report hash', () => {
    const expense: ForwardInferenceExpenseSession = {
      sessionDate: '2026-09-18',
      authorityGenerationHash: 'a'.repeat(64),
      sourceAsOf: '2026-09-18T21:01:00.000Z',
      knownEstimatedCostPicoUsd: '420000',
      claimedRequestCount: 1,
      missingQuoteCount: 0,
      unverifiedRequestCount: 0,
      gapRequestCount: 0,
      completeMeteredCoverage: true,
      exactSessionLedger: true,
      ledgerTimestampMax: '1791050000000000000',
      verifiedSessionTransferCount: 1,
      invoiceReconciled: false,
    }
    const report = success(makeForwardPerformanceReport(evidence(roundTrip()), [expense]))
    const { reportHash, ...material } = report
    expect(Result.getOrThrow(canonicalHashV1Result(material))).toBe(reportHash)
    expect(
      Result.getOrThrow(
        canonicalHashV1Result({
          ...material,
          inferenceExpenses: [{ ...expense, sourceAsOf: '2026-09-18T21:02:00.000Z' }],
        }),
      ),
    ).not.toBe(reportHash)
  })

  test('binds an empty financial report to the requested generation without supplying financial identity', () => {
    const input = evidence([])
    const firstGeneration = '1'.repeat(64)
    const secondGeneration = '2'.repeat(64)
    const first = success(makeForwardPerformanceReport(input, [], firstGeneration))
    const second = success(makeForwardPerformanceReport(input, [], secondGeneration))

    expect(first.scope).toEqual({
      kind: ForwardPerformanceScopeKind.AuthorityGeneration,
      authorityGenerationHash: firstGeneration,
    })
    expect(second.scope).toEqual({
      kind: ForwardPerformanceScopeKind.AuthorityGeneration,
      authorityGenerationHash: secondGeneration,
    })
    expect(first.receipt).toEqual(second.receipt)
    expect(first.receipt.bindings.source).toBeNull()
    expect(first.receipt.bindings.strategy).toBeNull()
    expect(Object.values(first.receipt.totals).every((total) => total === null)).toBe(true)
    expect(first.receipt.profitability).toBe('UNDETERMINED')
    expect(first.reportHash).not.toBe(second.reportHash)
    const { reportHash, ...material } = first
    expect(Result.getOrThrow(canonicalHashV1Result(material))).toBe(reportHash)
    expect(Result.getOrThrow(canonicalHashV1Result({ ...material, scope: second.scope }))).not.toBe(reportHash)
  })

  test('declares an account scope when no generation was requested', () => {
    const report = success(makeForwardPerformanceReport(evidence([]), []))
    expect(report.scope).toEqual({ kind: ForwardPerformanceScopeKind.Account })
    expect(report.receipt.profitability).toBe('UNDETERMINED')
  })

  test('keeps the strict v4 stored receipt unchanged and binds episodes in a separate versioned report', () => {
    const report = success(makeForwardPerformanceReport(evidence(roundTrip()), []))
    const { receipt, reportHash, ...reportFields } = report
    expect(report.schemaVersion).toBe('bayn.forward-performance-report.v6')
    expect(receipt.schemaVersion).toBe('bayn.forward-performance-receipt.v4')
    expect(receipt).not.toHaveProperty('positionEpisodes')
    expect(Result.getOrThrow(canonicalHashV1Result({ ...reportFields, receipt }))).toBe(reportHash)
    expect(
      Result.getOrThrow(
        canonicalHashV1Result({
          ...reportFields,
          receipt,
          positionEpisodes: { ...report.positionEpisodes, completedCount: 99 },
        }),
      ),
    ).not.toBe(reportHash)
    const envelope = success(
      makeForwardPerformanceReceiptEnvelope({
        schemaVersion: 'bayn.forward-performance-receipt-envelope.v1',
        authorityGenerationHash: 'a'.repeat(64),
        cycleId: 'b'.repeat(64),
        receiptHash: receipt.receiptHash,
        receipt,
        createdAt: '2026-09-18T21:01:00.000Z',
      }),
    )
    expect(success(decodeForwardPerformanceReceiptEnvelopeResult(envelope))).toEqual(envelope)
    const { receiptHash: _, ...receiptMaterial } = receipt
    const changedMaterial = { ...receiptMaterial, positionEpisodes: report.positionEpisodes }
    const changedReceipt = {
      ...changedMaterial,
      receiptHash: Result.getOrThrow(canonicalHashV1Result(changedMaterial)),
    }
    const { contentHash: _contentHash, ...envelopeMaterial } = envelope
    const changedEnvelope = { ...envelopeMaterial, receiptHash: changedReceipt.receiptHash, receipt: changedReceipt }
    expect(
      Result.isFailure(
        decodeForwardPerformanceReceiptEnvelopeResult({
          ...changedEnvelope,
          contentHash: Result.getOrThrow(canonicalHashV1Result(changedEnvelope)),
        }),
      ),
    ).toBe(true)
  })
})

test('v6 exposes complete operating costs only for the attached registered assessment scope', () => {
  const { input, verifiedSources } = supportedAssessmentFixture()
  const assessment = Result.getOrThrow(evaluateSystemAssessment(input, verifiedSources))
  const report = Result.getOrThrow(makeForwardPerformanceReport(evidence([]), [], undefined, assessment))
  expect(report.operatingCostCoverage).toBe('COMPLETE')
  expect(report.operatingCostScope).toEqual({
    registrationHash: assessment.registrationHash,
    sourceCutHash: assessment.sourceCutHash,
    asOf: assessment.asOf,
  })
  expect(report.systemAssessment?.profitability.netEconomicPnlMicros).toBe('20000000000')
  expect(Result.getOrThrow(makeForwardPerformanceReport(evidence([]), [])).operatingCostScope).toBeNull()
})
