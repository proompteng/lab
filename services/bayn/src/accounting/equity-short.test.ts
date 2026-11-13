import { expect, test } from 'bun:test'
import fc from 'fast-check'
import { Result } from 'effect'
import { AccountingInventorySide, prepareAccounting, rebuildAccountingLedger } from './domain'
import { equityShortAccountingSchemaVersion } from './schema'
import type { PositionCost } from './model'
import { OrderSide, type Fill } from '../execution/contracts'
import { canonicalHashV1Result } from '../hash'
import { AccountCode } from '../ledger-plan'
import { verifyAccountingHistory } from '../reconciliation/algebra'

const fill = (side: OrderSide, quantity: bigint, price: bigint, fee = 0n, symbol = 'AAPL'): Fill => ({
  schemaVersion: 'bayn.fill.v2',
  accountId: 'synthetic-short-account',
  fillId: 'short-fill',
  brokerOrderId: 'short-order',
  clientOrderId: 'short-client',
  symbol,
  side,
  quantityAtoms: (quantity * 1_000_000_000n).toString(),
  priceAtoms: (price * 1_000n).toString(),
  feeMicros: fee.toString(),
  occurredAt: '2026-11-13T15:30:00.000Z',
})
const empty: PositionCost = { quantityAtoms: '0', costMicros: '0' }
const event = (id: string) => Result.getOrThrow(canonicalHashV1Result({ id }))
const prepare = (id: string, f: Fill, prior: PositionCost) =>
  Result.getOrThrow(prepareAccounting(event(id), f, prior, 7001, AccountingInventorySide.Short))
const advance = (prior: PositionCost, transaction: ReturnType<typeof prepare>['transaction']): PositionCost => ({
  quantityAtoms: (BigInt(prior.quantityAtoms) + BigInt(transaction.quantityDeltaAtoms)).toString(),
  costMicros: (BigInt(prior.costMicros) + BigInt(transaction.costBasisDeltaMicros)).toString(),
})

test('short proceeds create an equal inventory liability rather than realized income', () => {
  const p = prepare('open', fill(OrderSide.Sell, 3n, 100_000_000n, 30_000n), empty)
  expect(p.transaction).toMatchObject({
    schemaVersion: equityShortAccountingSchemaVersion,
    cashDeltaMicros: '299970000',
    quantityDeltaAtoms: '-3000000000',
    costBasisDeltaMicros: '-300000000',
    realizedPnlMicros: '0',
  })
  expect(Result.getOrThrow(rebuildAccountingLedger(p.transaction, 7001))).toEqual(p.ledger)
  const inventory = p.ledger.accounts.find((a) => a.code === AccountCode.inventory)
  expect(p.ledger.transfers.some((t) => t.credit_account_id === inventory?.id && t.amount === 300_000_000n)).toBe(true)
  expect(p.ledger.accounts.some((a) => a.code === AccountCode.realizedGain)).toBe(false)
})

test('partial covers and an adverse final cover settle exact liability, fees and realized P&L', () => {
  let prior = empty
  const history = []
  for (const [id, side, quantity, price, fee] of [
    ['open', OrderSide.Sell, 3n, 100_000_000n, 30_000n],
    ['partial', OrderSide.Buy, 1n, 90_000_000n, 20_000n],
    ['close', OrderSide.Buy, 2n, 120_000_000n, 30_000n],
  ] as const) {
    const f = fill(side, quantity, price, fee)
    const p = prepare(id, f, prior)
    history.push({ transaction: p.transaction, fill: f, prior })
    expect(Result.getOrThrow(rebuildAccountingLedger(p.transaction, 7001))).toEqual(p.ledger)
    prior = advance(prior, p.transaction)
  }
  expect(prior).toEqual(empty)
  expect(history.map(({ transaction: t }) => t.realizedPnlMicros)).toEqual(['0', '10000000', '-40000000'])
  expect(history.reduce((n, { transaction: t }) => n + BigInt(t.cashDeltaMicros), 0n)).toBe(-30_080_000n)
  expect(Result.isSuccess(verifyAccountingHistory(history, 7001))).toBe(true)
})

test('short gap losses can exceed original notional and are never clipped to collateral or stop', () => {
  const open = prepare('gap-open', fill(OrderSide.Sell, 1n, 100_000_000n), empty)
  const close = prepare('gap-close', fill(OrderSide.Buy, 1n, 350_000_000n), advance(empty, open.transaction))
  expect(close.transaction.realizedPnlMicros).toBe('-250000000')
  expect(Result.getOrThrow(rebuildAccountingLedger(close.transaction, 7001))).toEqual(close.ledger)
})

test('the default long-only path still rejects opening shorts, and the short path rejects flips and crypto', () => {
  expect(
    Result.isFailure(prepareAccounting(event('default'), fill(OrderSide.Sell, 1n, 100_000_000n), empty, 7001)),
  ).toBe(true)
  for (const [f, prior] of [
    [fill(OrderSide.Buy, 1n, 100_000_000n), empty],
    [fill(OrderSide.Buy, 2n, 100_000_000n), { quantityAtoms: '-1000000000', costMicros: '-100000000' }],
    [fill(OrderSide.Sell, 1n, 100_000_000n), { quantityAtoms: '1000000000', costMicros: '100000000' }],
    [fill(OrderSide.Sell, 1n, 100_000_000n, 0n, 'BTC/USD'), empty],
  ] as const)
    expect(Result.isFailure(prepareAccounting(event('invalid'), f, prior, 7001, AccountingInventorySide.Short))).toBe(
      true,
    )
})

test('rehashed short evidence cannot turn sale proceeds into fabricated realized profit', () => {
  const p = prepare('tamper', fill(OrderSide.Sell, 1n, 100_000_000n), empty)
  const { contentHash: _, ...material } = { ...p.transaction, realizedPnlMicros: '100000000' }
  const t = { ...material, contentHash: Result.getOrThrow(canonicalHashV1Result(material)) }
  expect(Result.isFailure(rebuildAccountingLedger(t, 7001))).toBe(true)
})

test('property: arbitrary partial short covers conserve basis, cash and exact terminal inventory', () => {
  fc.assert(
    fc.property(
      fc.integer({ min: 2, max: 1000 }),
      fc.integer({ min: 1, max: 1000000 }),
      fc.integer({ min: 1, max: 1000000 }),
      (quantity, entryPrice, coverPrice) => {
        const q = BigInt(quantity),
          e = BigInt(entryPrice),
          c = BigInt(coverPrice)
        const opened = prepare('property-open', fill(OrderSide.Sell, q, e), empty)
        const prior = advance(empty, opened.transaction)
        const part = prepare('property-part', fill(OrderSide.Buy, 1n, c), prior)
        const last = prepare('property-close', fill(OrderSide.Buy, q - 1n, c), advance(prior, part.transaction))
        expect(advance(advance(prior, part.transaction), last.transaction)).toEqual(empty)
        expect(BigInt(part.transaction.costBasisMicros) + BigInt(last.transaction.costBasisMicros)).toBe(q * e)
        expect(
          BigInt(opened.transaction.cashDeltaMicros) +
            BigInt(part.transaction.cashDeltaMicros) +
            BigInt(last.transaction.cashDeltaMicros),
        ).toBe(q * (e - c))
      },
    ),
    { numRuns: 200 },
  )
})
