import { expect, test } from 'bun:test'
import { Result, Schema } from 'effect'
import fc from 'fast-check'

import { quantityScale } from '../quantity'
import { checkProperty } from '../testing/property-test-support'

import { nativeJevFixture } from './native.test-support'
import { JevPurpose } from './portfolio'
import { jevProfitTargetBid, jevProfitTargetCrossed } from './profit-target'
import { decideJevEntry, JevEntryTargetSchema } from './decision'
import { nativeJevDecisionEvidence } from './native.test-support'
import { decodeJevProtocol, defaultJevProtocolDocument } from './protocol'

const held = (symbol: string, feeMicros = '0') => {
  const fixture = nativeJevFixture(JevPurpose.Manage)
  const original = fixture.portfolio
  if (original.purpose !== JevPurpose.Manage) throw new Error('Expected held position')
  const crypto = symbol.includes('/')
  return {
    ...original,
    exitPolicy: {
      ...original.exitPolicy,
      plans: Object.fromEntries(
        Object.values(original.exitPolicy.plans).map((plan) => [
          symbol,
          { ...plan, levels: { ...plan.levels, symbol } },
        ]),
      ),
    },
    entryFills: original.entryFills.map((fill) => ({ ...fill, symbol, feeMicros })),
    entryInventoryDebit: {
      quantityAtoms: crypto ? '12500000' : '0',
      costBasisMicros: crypto ? '1250000' : '0',
    },
    brokerState: {
      ...original.brokerState,
      positions: original.brokerState.positions.map((position) => ({
        ...position,
        symbol,
        quantityAtoms: crypto ? '4987500000' : '5000000000',
      })),
    },
  }
}

for (const symbol of ['AAPL', 'BTC/USD', 'ETH/USD', 'SOL/USD']) {
  test(`${symbol} crosses the immutable profit target only at its sealed bid`, () => {
    const portfolio = held(symbol)
    const bid = Result.getOrThrow(jevProfitTargetBid(portfolio))
    expect(Result.getOrThrow(jevProfitTargetCrossed(portfolio, 100_000_000n))).toBe(false)
    expect(Result.getOrThrow(jevProfitTargetCrossed(portfolio, bid - 1n))).toBe(false)
    expect(Result.getOrThrow(jevProfitTargetCrossed(portfolio, bid))).toBe(true)
  })
}

test('reported cash fees cannot move the pre-entry target', () => {
  const portfolio = held('AAPL', '1000000')
  expect(Result.getOrThrow(jevProfitTargetBid(portfolio))).toBe(Result.getOrThrow(jevProfitTargetBid(held('AAPL'))))
})

test('the entry target seals the exit policy and rejects a rehashed policy substitution', () => {
  const entry = Result.getOrThrow(decideJevEntry(nativeJevDecisionEvidence()))
  expect(entry.exitPolicy.schemaVersion).toBe('bayn.position-exit-policy.v4')
  expect(entry.exitPolicy.maximumPriceCheckIntervalMs).toBe(5000)
  expect(entry.exitPolicy.plans['AAPL']?.levels.stopPriceMicros).toBeDefined()
  expect(
    Result.isFailure(
      Schema.decodeUnknownResult(JevEntryTargetSchema)({
        ...entry,
        exitPolicy: { ...entry.exitPolicy, plans: {} },
      }),
    ),
  ).toBe(true)
  expect(Result.isFailure(decodeJevProtocol({ ...defaultJevProtocolDocument, minimumExitProbability: 0.65 }))).toBe(
    true,
  )
  expect(
    Result.isFailure(decodeJevProtocol({ ...defaultJevProtocolDocument, schemaVersion: 'bayn.jev.protocol.v12' })),
  ).toBe(true)
})

test('property: position size and observed fees never reprice the immutable strategy target', () => {
  const base = held('BTC/USD')
  const first = base.entryFills[0]
  if (first === undefined) throw new Error('Expected an entry fill')
  checkProperty(
    'native-profit-target',
    fc.property(
      fc.bigInt({ min: quantityScale, max: 1000n * quantityScale }),
      fc.integer({ min: 1, max: 500 }),
      (quantity, feeMicros) => {
        const debit = (quantity * 25n + 9999n) / 10000n
        const received = quantity - debit
        const portfolio = {
          ...base,
          exitPolicy: base.exitPolicy,
          entryInventoryDebit: { quantityAtoms: String(debit), costBasisMicros: String(debit / 10n) },
          entryFills: [
            {
              ...first,
              quantityAtoms: String(quantity),
              symbol: 'BTC/USD',
              feeMicros: String(feeMicros),
              priceAtoms: '100000000000',
            },
          ],
          brokerState: {
            ...base.brokerState,
            positions: base.brokerState.positions.map((position) => ({ ...position, quantityAtoms: String(received) })),
          },
        }
        const bid = Result.getOrThrow(jevProfitTargetBid(portfolio))
        expect(bid).toBe(BigInt(base.exitPolicy.plans['BTC/USD']?.levels.profitLimitPriceMicros ?? '0'))
      },
    ),
  )
})
