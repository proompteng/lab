import { describe, expect, test } from 'bun:test'

import { prepareAccounting, type PositionCost } from './accounting'
import { OrderSide, type Fill } from './paper'

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

const postedMicros = (prepared: ReturnType<typeof prepareAccounting>): bigint =>
  prepared.ledger.transfers.reduce((sum, transfer) => sum + transfer.amount, 0n)

describe('paper accounting', () => {
  test('posts an exact buy with an explicit fee', () => {
    const prepared = prepareAccounting(eventId, fill({ feeMicros: '2500' }), emptyPosition, 7001)

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
    const prepared = prepareAccounting(
      eventId,
      fill({ quantityMicros: '500000', priceMicros: '100000001' }),
      emptyPosition,
      7001,
    )

    expect(prepared.transaction.notionalMicros).toBe('50000001')
  })

  test('uses average cost for a partial sale and records a gain', () => {
    const prepared = prepareAccounting(
      eventId,
      fill({ side: OrderSide.Sell, quantityMicros: '1000000', priceMicros: '120000000' }),
      { quantityMicros: '3000000', costMicros: '300000000' },
      7001,
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
    const prepared = prepareAccounting(
      eventId,
      fill({ side: OrderSide.Sell, quantityMicros: '3000000', priceMicros: '90000000', feeMicros: '500' }),
      { quantityMicros: '3000000', costMicros: '300000001' },
      7001,
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
    const prepared = prepareAccounting(
      eventId,
      fill({ side: OrderSide.Sell, quantityMicros: '1', priceMicros: '1000000' }),
      { quantityMicros: '3', costMicros: '1' },
      7001,
    )

    expect(prepared.transaction.costBasisMicros).toBe('0')
    expect(prepared.transaction.realizedPnlMicros).toBe('1')
    expect(prepared.ledger.transfers).toHaveLength(1)
    expect(postedMicros(prepared)).toBe(1n)
  })

  test('closes a position whose remaining cost rounded to zero', () => {
    const prepared = prepareAccounting(
      eventId,
      fill({ side: OrderSide.Sell, quantityMicros: '1', priceMicros: '1000000' }),
      { quantityMicros: '1', costMicros: '0' },
      7001,
    )

    expect(prepared.transaction.costBasisMicros).toBe('0')
    expect(prepared.transaction.costBasisDeltaMicros).toBe('0')
    expect(postedMicros(prepared)).toBe(1n)
  })

  test('fails closed when a sale exceeds the recorded long position', () => {
    expect(() =>
      prepareAccounting(
        eventId,
        fill({ side: OrderSide.Sell, quantityMicros: '1000001' }),
        { quantityMicros: '1000000', costMicros: '100000000' },
        7001,
      ),
    ).toThrow('sell fill exceeds the recorded long position')
  })

  test('is deterministic under replay', () => {
    const input = fill({ feeMicros: '100' })
    const first = prepareAccounting(eventId, input, emptyPosition, 7001)
    const replay = prepareAccounting(eventId, input, emptyPosition, 7001)

    expect(replay).toEqual(first)
    expect(new Set(first.ledger.accounts.map((account) => account.id)).size).toBe(first.ledger.accounts.length)
    expect(new Set(first.ledger.transfers.map((transfer) => transfer.id)).size).toBe(first.ledger.transfers.length)
  })
})
