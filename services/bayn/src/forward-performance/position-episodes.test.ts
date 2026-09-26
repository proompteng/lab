import assert from 'node:assert/strict'

import { describe, expect, test } from 'bun:test'
import { Result } from 'effect'

import { prepareAccounting } from '../accounting/domain'
import type { AccountingTransaction } from '../accounting/schema'
import { OrderSide } from '../execution/contracts'
import { canonicalHashV1 } from '../hash'
import {
  decodeForwardPerformanceReceiptEnvelopeResult,
  makeForwardPerformanceReceiptEnvelope,
} from '../db/forward-performance-receipt'
import { makeForwardPerformanceReport } from './report'
import type { ForwardPerformanceEvidenceInput } from './model'
import { measurePositionEpisodes, PositionEpisodeReason } from './position-episodes'

const success = <A, E>(result: Result.Result<A, E>): A => {
  assert(Result.isSuccess(result))
  return result.success
}

const transaction = (index: number, side: OrderSide, quantity: number, symbol = 'NVDA'): AccountingTransaction => {
  const quantityMicros = BigInt(quantity) * 1_000_000n
  return success(
    prepareAccounting(
      canonicalHashV1({ index, side, quantity, symbol }),
      {
        schemaVersion: 'bayn.paper-fill.v1',
        accountId: 'episode-account',
        fillId: `fill-${index}`,
        brokerOrderId: `order-${index}`,
        clientOrderId: `client-${index}`,
        symbol,
        side,
        quantityMicros: quantityMicros.toString(),
        priceMicros: '100000000',
        feeMicros: '100',
        occurredAt: `2026-09-18T15:30:${String(index).padStart(2, '0')}.000Z`,
      },
      side === OrderSide.Buy
        ? { quantityMicros: '0', costMicros: '0' }
        : {
            quantityMicros: quantityMicros.toString(),
            costMicros: (quantityMicros * 100n).toString(),
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
  ...overrides,
})

const roundTrip = () => [transaction(1, OrderSide.Buy, 2), transaction(2, OrderSide.Sell, 2)]

describe('position episodes', () => {
  test('counts a scaled-in position with partial exits as one episode', () => {
    const history = [
      transaction(1, OrderSide.Buy, 2),
      transaction(2, OrderSide.Buy, 3),
      transaction(3, OrderSide.Sell, 1),
      transaction(4, OrderSide.Sell, 4),
    ]
    const result = success(measurePositionEpisodes(evidence(history)))
    expect(result).toMatchObject({ status: 'MEASURED', completedCount: 1, openCount: 0, crossScopeCount: 0 })
    const report = success(makeForwardPerformanceReport(evidence(history)))
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
              ...(fault === 'delta' ? { quantityDeltaMicros: '2000000' } : {}),
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

  test('keeps the strict v3 stored receipt unchanged and binds episodes in a separate versioned report', () => {
    const report = success(makeForwardPerformanceReport(evidence(roundTrip())))
    const { receipt, reportHash, ...reportFields } = report
    expect(report.schemaVersion).toBe('bayn.forward-performance-report.v1')
    expect(receipt.schemaVersion).toBe('bayn.forward-performance-receipt.v3')
    expect(receipt).not.toHaveProperty('positionEpisodes')
    expect(canonicalHashV1({ ...reportFields, receipt })).toBe(reportHash)
    expect(
      canonicalHashV1({
        ...reportFields,
        receipt,
        positionEpisodes: { ...report.positionEpisodes, completedCount: 99 },
      }),
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
    const changedReceipt = { ...changedMaterial, receiptHash: canonicalHashV1(changedMaterial) }
    const { contentHash: _contentHash, ...envelopeMaterial } = envelope
    const changedEnvelope = { ...envelopeMaterial, receiptHash: changedReceipt.receiptHash, receipt: changedReceipt }
    expect(
      Result.isFailure(
        decodeForwardPerformanceReceiptEnvelopeResult({
          ...changedEnvelope,
          contentHash: canonicalHashV1(changedEnvelope),
        }),
      ),
    ).toBe(true)
  })
})
