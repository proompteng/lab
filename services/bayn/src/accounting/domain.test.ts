import { describe, expect, test } from 'bun:test'

import assert from 'node:assert/strict'

import { Result } from 'effect'

import { canonicalHashV1 } from '../hash'
import { OrderSide, type Fill } from '../paper'
import { prepareAccounting, rebuildAccountingLedger } from './domain'
import type { AccountingFailure } from './failure'
import type { PositionCost, PreparedAccounting } from './model'

const eventId = 'a'.repeat(64)
const emptyPosition: PositionCost = { quantityMicros: '0', costMicros: '0' }

const fill = (overrides: Partial<Fill> = {}): Fill => ({
  schemaVersion: 'bayn.paper-fill.v1',
  accountId: 'paper-account',
  fillId: 'activity-1',
  brokerOrderId: 'broker-order-1',
  clientOrderId: 'bayn-order-1',
  symbol: 'NVDA',
  side: OrderSide.Buy,
  quantityMicros: '1000000',
  priceMicros: '100000000',
  feeMicros: '0',
  occurredAt: '2026-07-22T15:30:00.000Z',
  ...overrides,
})

const successOf = <A>(result: Result.Result<A, AccountingFailure>): A => {
  assert(Result.isSuccess(result), 'accounting result must succeed')
  return result.success
}

const failureOf = <A>(result: Result.Result<A, AccountingFailure>): AccountingFailure => {
  assert(Result.isFailure(result), 'accounting result must fail')
  return result.failure
}

const postedMicros = (prepared: PreparedAccounting): bigint =>
  prepared.ledger.transfers.reduce((sum, transfer) => sum + transfer.amount, 0n)

describe('paper accounting', () => {
  test('posts an exact buy with an explicit fee', () => {
    const prepared = successOf(prepareAccounting(eventId, fill({ feeMicros: '2500' }), emptyPosition, 7001))

    expect(prepared.transaction).toMatchObject({
      side: OrderSide.Buy,
      notionalMicros: '100000000',
      costBasisMicros: '100000000',
      realizedPnlMicros: '0',
      quantityDeltaMicros: '1000000',
      costBasisDeltaMicros: '100000000',
      cashDeltaMicros: '-100002500',
    })
    expect(prepared.transaction.ledgerPlanHash).toMatch(/^[a-f0-9]{64}$/)
    expect(postedMicros(prepared)).toBe(100_002_500n)
    expect(prepared.ledger.transfers).toHaveLength(2)
  })

  test('uses round-half-up for quantity times price', () => {
    const prepared = successOf(
      prepareAccounting(eventId, fill({ quantityMicros: '500000', priceMicros: '100000001' }), emptyPosition, 7001),
    )

    expect(prepared.transaction.notionalMicros).toBe('50000001')
  })

  test('preserves the exact half-up transaction and ledger identity golden', () => {
    const prepared = successOf(
      prepareAccounting(
        eventId,
        fill({ quantityMicros: '500000', priceMicros: '100000001', feeMicros: '2500' }),
        emptyPosition,
        7001,
      ),
    )

    expect(prepared.transaction).toMatchObject({
      transactionId: '5c30c458a20098f8a787b1a9e098c0756bf710f06683a740aba539b20c1a39f8',
      notionalMicros: '50000001',
      costBasisMicros: '50000001',
      cashDeltaMicros: '-50002501',
      ledgerPlanHash: 'ed64d5c2d5e9dbb34eaf42b9f86d6afb7323478e2550e2921dbd22a3edef3657',
      contentHash: '7d91dd98ee38ce4a6bb1c0a8e6ad032f6c3da9106847ddcf80c3f2fbf0042222',
    })
    expect(prepared.ledger.accounts.map((account) => account.id)).toEqual([
      11_018_531_402_962_299_880_943_285_336_145_171_022n,
      162_492_250_068_507_024_268_897_767_784_019_191_926n,
      256_393_807_197_113_497_662_451_249_474_476_167_056n,
    ])
    expect(prepared.ledger.transfers.map((transfer) => [transfer.id, transfer.amount])).toEqual([
      [67_063_131_099_678_162_361_447_000_629_170_124_156n, 2_500n],
      [230_986_136_044_309_168_085_596_967_250_981_161_443n, 50_000_001n],
    ])
  })

  test('uses average cost for a partial sale and records a gain', () => {
    const prepared = successOf(
      prepareAccounting(
        eventId,
        fill({ side: OrderSide.Sell, quantityMicros: '1000000', priceMicros: '120000000' }),
        { quantityMicros: '3000000', costMicros: '300000000' },
        7001,
      ),
    )

    expect(prepared.transaction).toMatchObject({
      notionalMicros: '120000000',
      costBasisMicros: '100000000',
      realizedPnlMicros: '20000000',
      quantityDeltaMicros: '-1000000',
      costBasisDeltaMicros: '-100000000',
      cashDeltaMicros: '120000000',
    })
    expect(prepared.ledger.transfers).toHaveLength(2)
    expect(postedMicros(prepared)).toBe(120_000_000n)
  })

  test('records a realized loss and consumes exact remaining cost on full close', () => {
    const prepared = successOf(
      prepareAccounting(
        eventId,
        fill({ side: OrderSide.Sell, quantityMicros: '3000000', priceMicros: '90000000', feeMicros: '500' }),
        { quantityMicros: '3000000', costMicros: '300000001' },
        7001,
      ),
    )

    expect(prepared.transaction).toMatchObject({
      notionalMicros: '270000000',
      costBasisMicros: '300000001',
      realizedPnlMicros: '-30000001',
      costBasisDeltaMicros: '-300000001',
      cashDeltaMicros: '269999500',
    })
    expect(prepared.ledger.transfers).toHaveLength(3)
    expect(postedMicros(prepared)).toBe(300_000_501n)
  })

  test('permits a rounded zero cost basis on a partial sale', () => {
    const prepared = successOf(
      prepareAccounting(
        eventId,
        fill({ side: OrderSide.Sell, quantityMicros: '1', priceMicros: '1000000' }),
        { quantityMicros: '3', costMicros: '1' },
        7001,
      ),
    )

    expect(prepared.transaction.costBasisMicros).toBe('0')
    expect(prepared.transaction.realizedPnlMicros).toBe('1')
    expect(prepared.ledger.transfers).toHaveLength(1)
    expect(postedMicros(prepared)).toBe(1n)
  })

  test('closes a position whose remaining cost rounded to zero', () => {
    const prepared = successOf(
      prepareAccounting(
        eventId,
        fill({ side: OrderSide.Sell, quantityMicros: '1', priceMicros: '1000000' }),
        { quantityMicros: '1', costMicros: '0' },
        7001,
      ),
    )

    expect(prepared.transaction.costBasisMicros).toBe('0')
    expect(prepared.transaction.costBasisDeltaMicros).toBe('0')
    expect(postedMicros(prepared)).toBe(1n)
  })

  test('fails closed when a sale exceeds the recorded long position', () => {
    expect(
      failureOf(
        prepareAccounting(
          eventId,
          fill({ side: OrderSide.Sell, quantityMicros: '1000001' }),
          { quantityMicros: '1000000', costMicros: '100000000' },
          7001,
        ),
      ),
    ).toEqual({
      _tag: 'AccountingSellQuantityExceedsPosition',
      saleQuantityMicros: 1_000_001n,
      positionQuantityMicros: 1_000_000n,
    })
  })

  test('returns exact failures for invalid position state and rounded-zero fills without throwing', () => {
    expect(failureOf(prepareAccounting(eventId, fill(), { quantityMicros: '-1', costMicros: '0' }, 7001))).toEqual({
      _tag: 'AccountingNegativePositionCost',
      quantityMicros: -1n,
      costMicros: 0n,
    })
    expect(failureOf(prepareAccounting(eventId, fill(), { quantityMicros: '0', costMicros: '1' }, 7001))).toEqual({
      _tag: 'AccountingEmptyPositionRetainsCost',
      costMicros: 1n,
    })
    expect(
      failureOf(prepareAccounting(eventId, fill({ quantityMicros: '1', priceMicros: '1' }), emptyPosition, 7001)),
    ).toEqual({
      _tag: 'AccountingFillNotionalRoundedToZero',
      quantityMicros: 1n,
      priceMicros: 1n,
    })
  })

  test('returns parse and canonicalization defects as concrete failure data', () => {
    expect(failureOf(prepareAccounting(eventId, fill(), { quantityMicros: 'invalid', costMicros: '0' }, 7001))).toEqual(
      {
        _tag: 'AccountingMicrosParseFailed',
        field: 'position.quantityMicros',
        value: 'invalid',
      },
    )
    expect(failureOf(prepareAccounting(eventId, fill(), { quantityMicros: '+1', costMicros: '0' }, 7001))).toEqual({
      _tag: 'AccountingMicrosParseFailed',
      field: 'position.quantityMicros',
      value: '+1',
    })

    expect(failureOf(prepareAccounting(eventId, fill({ accountId: '\ud800' }), emptyPosition, 7001))).toMatchObject({
      _tag: 'AccountingCanonicalizationFailed',
      operation: 'transaction-content',
      cause: {
        _tag: 'CanonicalJsonFailure',
        path: '$.accountId',
        reason: 'invalid-unicode-surrogate',
        actualType: 'string',
      },
    })
    expect(failureOf(prepareAccounting(eventId, fill(), emptyPosition, Number.NaN))).toEqual({
      _tag: 'AccountingCanonicalizationFailed',
      operation: 'ledger-plan',
      cause: {
        _tag: 'LedgerPlanHashCanonicalizationFailed',
        cause: {
          _tag: 'CanonicalJsonFailure',
          path: '$.accounts[0].ledger',
          reason: 'non-finite-number',
          actualType: 'number',
        },
      },
    })
  })

  test('validates decoded transaction content and ledger identity as separate failures', () => {
    expect(failureOf(rebuildAccountingLedger({}, 7001))).toMatchObject({
      _tag: 'AccountingTransactionDecodeFailed',
      cause: { _tag: 'SchemaError' },
    })

    const prepared = successOf(prepareAccounting(eventId, fill(), emptyPosition, 7001))
    const ledgerPlanHash = 'b'.repeat(64)
    const { contentHash: _contentHash, ...material } = {
      ...prepared.transaction,
      ledgerPlanHash,
    }
    expect(
      failureOf(rebuildAccountingLedger({ ...material, contentHash: canonicalHashV1(material) }, 7001)),
    ).toMatchObject({
      _tag: 'AccountingLedgerPlanHashMismatch',
      transactionId: prepared.transaction.transactionId,
      observedLedgerPlanHash: ledgerPlanHash,
      expectedLedgerPlanHash: prepared.transaction.ledgerPlanHash,
    })
  })

  test('is deterministic under replay', () => {
    const input = fill({ feeMicros: '100' })
    const first = successOf(prepareAccounting(eventId, input, emptyPosition, 7001))
    const replay = successOf(prepareAccounting(eventId, input, emptyPosition, 7001))

    expect(replay).toEqual(first)
    expect(new Set(first.ledger.accounts.map((account) => account.id)).size).toBe(first.ledger.accounts.length)
    expect(new Set(first.ledger.transfers.map((transfer) => transfer.id)).size).toBe(first.ledger.transfers.length)
  })
})
