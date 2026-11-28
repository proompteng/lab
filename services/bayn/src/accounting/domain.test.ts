import { describe, expect, test } from 'bun:test'

import assert from 'node:assert/strict'

import { Result } from 'effect'

import { canonicalHashV1Result } from '../hash'
import { OrderSide, type Fill } from '../execution/contracts'
import { hashLedgerPlanResult } from '../ledger-plan'
import {
  brokerFeeLedgerPlan,
  cashSettlementLedgerPlan,
  coinFeeLedgerPlan,
  prepareAccounting,
  rebuildAccountingLedger,
} from './domain'
import type { AccountingFailure } from './failure'
import type { PositionCost, PreparedAccounting } from './model'

const eventId = 'a'.repeat(64)
const emptyPosition: PositionCost = { quantityAtoms: '0', costMicros: '0' }

const fill = (overrides: Partial<Fill> = {}): Fill => ({
  schemaVersion: 'bayn.fill.v2',
  accountId: 'paper-account',
  fillId: 'activity-1',
  brokerOrderId: 'broker-order-1',
  clientOrderId: 'bayn-order-1',
  symbol: 'NVDA',
  side: OrderSide.Buy,
  quantityAtoms: '1000000000',
  priceAtoms: '100000000000',
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

describe('execution accounting', () => {
  test.each([
    {
      name: 'buy with fee',
      overrides: { feeMicros: '2500' },
      prior: emptyPosition,
      ledgerPlanHash: '918948628ef0e46c31b8adfd6b40a269a6ade2d66004c310a2dfd217e5e860b1',
      contentHash: '7048ddd9a74ba9a77695926d8a54243564535ba73edf52b24ddba04233cb2cdd',
    },
    {
      name: 'partial gain with fee',
      overrides: { side: OrderSide.Sell, priceAtoms: '120000000000', feeMicros: '2500' },
      prior: { quantityAtoms: '3000000000', costMicros: '300000000' },
      ledgerPlanHash: 'ee0192ccf02a378bd8e95ec1276e7f2073b0579405661ffab2d3342421dcf574',
      contentHash: '86b220e92634d9ab696bab88a9794c938d98202ea9fe3393ee65a0aab00ab44a',
    },
    {
      name: 'full loss with fee',
      overrides: {
        side: OrderSide.Sell,
        quantityAtoms: '3000000000',
        priceAtoms: '90000000000',
        feeMicros: '500',
      },
      prior: { quantityAtoms: '3000000000', costMicros: '300000001' },
      ledgerPlanHash: '0fc004aa986e538ab268abbbd70cfd5fa9a2a6c4df9da98b0c0428a406b5f50b',
      contentHash: 'a4d3c291d411bac3858d1447805825c2cc34adda685cf425fcc080d8335f1e1b',
    },
    {
      name: 'partial sale with rounded zero basis',
      overrides: { side: OrderSide.Sell, quantityAtoms: '1000', priceAtoms: '1000000000' },
      prior: { quantityAtoms: '3000', costMicros: '1' },
      ledgerPlanHash: '4b993ba02e623db370ec4382c9268a7142c8260f87e568062e41b472794f8fe3',
      contentHash: '2029c37fecc918d40bbdd43ea621086d27a6b4dcaf8389c482599dadc6d50054',
    },
  ])(
    'preserves the complete historical ledger identity for $name',
    ({ overrides, prior, ledgerPlanHash, contentHash }) => {
      const prepared = successOf(prepareAccounting(eventId, fill(overrides), prior, 7001))
      expect(Result.getOrThrow(hashLedgerPlanResult(prepared.ledger))).toBe(ledgerPlanHash)
      expect(prepared.transaction).toMatchObject({ ledgerPlanHash, contentHash })
      expect(successOf(rebuildAccountingLedger(prepared.transaction, 7001))).toEqual(prepared.ledger)
    },
  )

  test.each([
    {
      amount: '0',
      fee: '06039382d0f602bb290ac1d5270fe96a1b06df59d8f0379a1f92542e95ba8fd2',
      settlement: '06039382d0f602bb290ac1d5270fe96a1b06df59d8f0379a1f92542e95ba8fd2',
    },
    {
      amount: '2300',
      fee: 'dd03ac463bc61969659e53dea81e2aefcfe2c775630dafbdd0c000051adc401f',
      settlement: 'aaf531cf64820d9d2c986e76dc19b9b5c07d66b5baff0434e074073bb2f381ca',
    },
    {
      amount: '-2300',
      fee: 'c190b516fb06e09162700467c5342d7736fd839a8ef3eeaffa013ed013efe4ff',
      settlement: 'eee511bd75f0709ce3b651c9f919553850f626db2e557edcd7edb77a81c4e091',
    },
  ])('preserves broker fee and cash settlement identities for $amount micros', ({ amount, fee, settlement }) => {
    expect(Result.getOrThrow(hashLedgerPlanResult(brokerFeeLedgerPlan('paper-account', 'fee-1', amount, 7001)))).toBe(
      fee,
    )
    expect(
      Result.getOrThrow(hashLedgerPlanResult(cashSettlementLedgerPlan('paper-account', 'settlement-1', amount, 7001))),
    ).toBe(settlement)
  })

  test.each([
    { amount: '0', hash: '06039382d0f602bb290ac1d5270fe96a1b06df59d8f0379a1f92542e95ba8fd2' },
    { amount: '2300', hash: '591d92a0b1c267207c29978463c582e6ef1cf4cbd95fb5efc3d0f3b0f88cf231' },
  ])('preserves the historical coin fee identity for $amount micros', ({ amount, hash }) => {
    expect(
      Result.getOrThrow(
        hashLedgerPlanResult(coinFeeLedgerPlan('paper-account', 'coin-fee-1', 'BTC/USD', amount, 7001)),
      ),
    ).toBe(hash)
  })

  test('keeps reconstructed records isolated across plans, accounts and ledgers', () => {
    const builders = [
      () => successOf(prepareAccounting(eventId, fill({ feeMicros: '2500' }), emptyPosition, 7001)).ledger,
      () => brokerFeeLedgerPlan('paper-account', 'fee-1', '-2300', 7001),
      () => cashSettlementLedgerPlan('paper-account', 'settlement-1', '2300', 7001),
      () => coinFeeLedgerPlan('paper-account', 'coin-fee-1', 'BTC/USD', '2300', 7001),
    ]
    for (const build of builders) {
      const first = build()
      const witness = structuredClone(first)
      const replay = build()
      assert(first.accounts[0] !== undefined && first.transfers[0] !== undefined)
      expect(replay.accounts[0]).not.toBe(first.accounts[0])
      expect(replay.transfers[0]).not.toBe(first.transfers[0])
      Object.assign(first.accounts[0], { debits_posted: 999n })
      Object.assign(first.transfers[0], { amount: 999n })
      expect(replay).toEqual(witness)
      expect(build()).toEqual(witness)
    }
    const other = brokerFeeLedgerPlan('other-account', 'fee-1', '-2300', 7002)
    const original = brokerFeeLedgerPlan('paper-account', 'fee-1', '-2300', 7001)
    expect(other.runKey).not.toBe(original.runKey)
    expect(other.runTag).not.toBe(original.runTag)
    expect(other.accounts.every((account) => account.ledger === 7002 && account.user_data_128 === other.runKey)).toBe(
      true,
    )
    expect(
      other.transfers.every((transfer) => transfer.ledger === 7002 && transfer.user_data_64 === other.runTag),
    ).toBe(true)
    expect(
      original.accounts.every((account) => account.ledger === 7001 && account.user_data_128 === original.runKey),
    ).toBe(true)
  })

  test('posts delayed broker fees and refunds with stable identities and the existing cash and expense accounts', () => {
    const fee = brokerFeeLedgerPlan('paper-account', 'fee-1', '-230000', 7001)
    const replay = brokerFeeLedgerPlan('paper-account', 'fee-1', '-230000', 7001)
    const refund = brokerFeeLedgerPlan('paper-account', 'refund-1', '230000', 7001)
    const withFillFee = successOf(prepareAccounting(eventId, fill({ feeMicros: '230000' }), emptyPosition, 7001))
    const knownFee = withFillFee.ledger.transfers.find((transfer) => transfer.amount === 230000n)
    if (knownFee === undefined) throw new Error('expected existing fee transfer')
    expect(fee).toEqual(replay)
    expect(fee.transfers).toHaveLength(1)
    expect(fee.transfers[0]?.amount).toBe(230000n)
    expect(fee.transfers[0]?.debit_account_id).toBe(knownFee.debit_account_id)
    expect(fee.transfers[0]?.credit_account_id).toBe(knownFee.credit_account_id)
    expect(refund.transfers[0]?.debit_account_id).toBe(fee.transfers[0]?.credit_account_id)
    expect(refund.transfers[0]?.credit_account_id).toBe(fee.transfers[0]?.debit_account_id)
    expect(refund.transfers[0]?.id).not.toBe(fee.transfers[0]?.id)
    expect(brokerFeeLedgerPlan('paper-account', 'zero', '0', 7001).transfers).toEqual([])
  })

  test('posts an exact buy with an explicit fee', () => {
    const prepared = successOf(prepareAccounting(eventId, fill({ feeMicros: '2500' }), emptyPosition, 7001))

    expect(prepared.transaction).toMatchObject({
      side: OrderSide.Buy,
      notionalMicros: '100000000',
      costBasisMicros: '100000000',
      realizedPnlMicros: '0',
      quantityDeltaAtoms: '1000000000',
      costBasisDeltaMicros: '100000000',
      cashDeltaMicros: '-100002500',
    })
    expect(prepared.transaction.ledgerPlanHash).toMatch(/^[a-f0-9]{64}$/)
    expect(postedMicros(prepared)).toBe(100_002_500n)
    expect(prepared.ledger.transfers).toHaveLength(2)
  })

  test('uses round-half-up for quantity times price', () => {
    const prepared = successOf(
      prepareAccounting(eventId, fill({ quantityAtoms: '500000000', priceAtoms: '100000001000' }), emptyPosition, 7001),
    )

    expect(prepared.transaction.notionalMicros).toBe('50000001')
  })

  test('preserves the exact half-up transaction and ledger identity golden', () => {
    const prepared = successOf(
      prepareAccounting(
        eventId,
        fill({ quantityAtoms: '500000000', priceAtoms: '100000001000', feeMicros: '2500' }),
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
      contentHash: '65aef852d6ee96cfa1ece78817bafde73f87f55ec220b4ea5e6265c57c7b24c0',
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
        fill({ side: OrderSide.Sell, quantityAtoms: '1000000000', priceAtoms: '120000000000' }),
        { quantityAtoms: '3000000000', costMicros: '300000000' },
        7001,
      ),
    )

    expect(prepared.transaction).toMatchObject({
      notionalMicros: '120000000',
      costBasisMicros: '100000000',
      realizedPnlMicros: '20000000',
      quantityDeltaAtoms: '-1000000000',
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
        fill({ side: OrderSide.Sell, quantityAtoms: '3000000000', priceAtoms: '90000000000', feeMicros: '500' }),
        { quantityAtoms: '3000000000', costMicros: '300000001' },
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
        fill({ side: OrderSide.Sell, quantityAtoms: '1000', priceAtoms: '1000000000' }),
        { quantityAtoms: '3000', costMicros: '1' },
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
        fill({ side: OrderSide.Sell, quantityAtoms: '1000', priceAtoms: '1000000000' }),
        { quantityAtoms: '1000', costMicros: '0' },
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
          fill({ side: OrderSide.Sell, quantityAtoms: '1000001000' }),
          { quantityAtoms: '1000000000', costMicros: '100000000' },
          7001,
        ),
      ),
    ).toEqual({
      _tag: 'AccountingSellQuantityExceedsPosition',
      saleQuantityAtoms: 1000001000n,
      positionQuantityAtoms: 1000000000n,
    })
  })

  test('returns exact failures for invalid position state and rounded-zero fills without throwing', () => {
    expect(failureOf(prepareAccounting(eventId, fill(), { quantityAtoms: '-1000', costMicros: '0' }, 7001))).toEqual({
      _tag: 'AccountingNegativePositionCost',
      quantityAtoms: -1000n,
      costMicros: 0n,
    })
    expect(failureOf(prepareAccounting(eventId, fill(), { quantityAtoms: '0', costMicros: '1' }, 7001))).toEqual({
      _tag: 'AccountingEmptyPositionRetainsCost',
      costMicros: 1n,
    })
    expect(
      failureOf(prepareAccounting(eventId, fill({ quantityAtoms: '1000', priceAtoms: '1' }), emptyPosition, 7001)),
    ).toEqual({
      _tag: 'AccountingFillNotionalRoundedToZero',
      quantityAtoms: 1000n,
      priceAtoms: 1n,
    })
  })

  test('returns parse and canonicalization defects as concrete failure data', () => {
    expect(failureOf(prepareAccounting(eventId, fill(), { quantityAtoms: 'invalid', costMicros: '0' }, 7001))).toEqual({
      _tag: 'AccountingMicrosParseFailed',
      field: 'position.quantityAtoms',
      value: 'invalid',
    })
    expect(failureOf(prepareAccounting(eventId, fill(), { quantityAtoms: '+1', costMicros: '0' }, 7001))).toEqual({
      _tag: 'AccountingMicrosParseFailed',
      field: 'position.quantityAtoms',
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
      failureOf(
        rebuildAccountingLedger({ ...material, contentHash: Result.getOrThrow(canonicalHashV1Result(material)) }, 7001),
      ),
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
