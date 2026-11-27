import { expect, test } from 'bun:test'
import { Result } from 'effect'

import {
  AlphaV3Allocation,
  AlphaV3Direction,
  AlphaV3Engine,
  allocateIntradayAlphaV3,
  alphaV3SleeveBudgets,
  decodeIntradayAlphaV3Policy,
  defaultIntradayAlphaV3Policy as policy,
  type AlphaV3Entries,
  type AlphaV3Reservation,
  type AlphaV3Symbol,
} from './index'
import { usd } from './test-support'

const { Orb, Noise, Reversion } = AlphaV3Engine
const { Long, Short } = AlphaV3Direction
const equal = Result.getOrThrow(decodeIntradayAlphaV3Policy({ ...policy, allocation: AlphaV3Allocation.Equal }))
const empty: AlphaV3Entries = { [Orb]: null, [Noise]: [], [Reversion]: [] }
const entries: AlphaV3Entries = {
  [Orb]: { symbol: 'AAPL', direction: Long, referenceMicros: usd(100), atr14Micros: usd(1), rangeStopMicros: usd(99) },
  [Noise]: [
    { symbol: 'QQQ', direction: Long, referenceMicros: usd(100), atr14Micros: usd(1) },
    { symbol: 'SMH', direction: Short, referenceMicros: usd(100), atr14Micros: usd(1) },
  ],
  [Reversion]: (['AMD', 'MSFT', 'GOOGL', 'NVDA'] as const).map((symbol, i) => ({
    symbol,
    direction: i < 2 ? Long : Short,
    referenceMicros: usd(100),
    atr14Micros: usd(1),
  })),
}

const openings = new Map<AlphaV3Symbol, bigint>([
  ['AAPL', usd(100.25)],
  ['QQQ', usd(100)],
  ['SMH', usd(100.25)],
  ['AMD', usd(99.8)],
  ['MSFT', usd(100)],
  ['GOOGL', usd(100.1)],
  ['NVDA', usd(100.12)],
])
const allocate = (candidate = entries, occupied: readonly AlphaV3Reservation[] = []) =>
  Result.getOrThrow(allocateIntradayAlphaV3(policy, { entries: candidate, occupied, openingReferences: openings }))

test('static equal and OR5 tilt split the $180k into fixed sleeve budgets', () => {
  expect(alphaV3SleeveBudgets(equal)).toEqual({ [Orb]: usd(60_000), [Noise]: usd(60_000), [Reversion]: usd(60_000) })
  expect(alphaV3SleeveBudgets(policy)).toEqual({ [Orb]: usd(90_000), [Noise]: usd(45_000), [Reversion]: usd(45_000) })
})

test('whole shares reserve an adverse opening price in either direction and respect sleeve risk', () => {
  const output = allocate()
  expect(output.skipped).toEqual([])
  expect(output.orders.map(({ symbol }) => symbol)).toEqual(['AAPL', 'QQQ', 'SMH', 'AMD', 'MSFT', 'GOOGL', 'NVDA'])
  expect(output.orders[0]).toMatchObject({
    entryLimitMicros: usd(100.3),
    reservationPriceMicros: usd(100.56),
    shares: 298n,
  })
  expect(output.orders[2]).toMatchObject({
    entryLimitMicros: usd(99.7),
    reservationPriceMicros: usd(100.56),
    shares: 149n,
  })
  for (const order of output.orders) {
    expect(typeof order.shares).toBe('bigint')
    expect(order.reservedGrossMicros).toBe(order.shares * order.reservationPriceMicros)
  }
  expect(output.totalReservedGrossMicros).toBeLessThanOrEqual(usd(180_000))
  const basket = output.orders.filter(({ engine }) => engine === Reversion)
  for (const leg of basket) {
    expect(leg.reservedGrossMicros).toBeLessThanOrEqual(usd(11_250))
    expect(leg.reservedGrossMicros + leg.reservationPriceMicros).toBeGreaterThan(usd(11_250))
  }
})

test('pending and held reserves share one cap and an over-cap book fails closed', () => {
  const occupied = [
    { engine: Orb, symbol: 'AAPL', reservedGrossMicros: usd(100_000) },
    { engine: Noise, symbol: 'QQQ', reservedGrossMicros: usd(79_000) },
  ] as const
  const output = allocate({ ...empty, [Reversion]: entries[Reversion] }, occupied)
  expect(output.orders).toHaveLength(4)
  expect(output.orders.every(({ shares }) => shares === 2n)).toBe(true)
  expect(output.totalReservedGrossMicros).toBeLessThanOrEqual(usd(180_000))
  expect(output.totalReservedGrossMicros).toBeGreaterThan(usd(179_800))
  const beyond = [...occupied, { engine: Reversion, symbol: 'GOOGL', reservedGrossMicros: usd(1_001) }] as const
  expect(
    Result.isFailure(allocateIntradayAlphaV3(policy, { entries, occupied: beyond, openingReferences: openings })),
  ).toBe(true)
})

test('one symbol cannot be held by two sleeves; an affected noon basket is entirely withheld', () => {
  const booked = [{ engine: Orb, symbol: 'AMD', reservedGrossMicros: usd(500) }] as const
  expect(allocate({ ...empty, [Reversion]: entries[Reversion] }, booked)).toMatchObject({
    orders: [],
    skipped: [{ engine: Reversion, reason: 'occupied-symbol' }],
  })
  const duplicate = [...booked, { ...booked[0], engine: Reversion }]
  expect(
    Result.isFailure(allocateIntradayAlphaV3(policy, { entries, occupied: duplicate, openingReferences: openings })),
  ).toBe(true)
  const crossSleeve = {
    ...entries,
    [Reversion]: entries[Reversion].map((leg) => (leg.symbol === 'AMD' ? { ...leg, symbol: 'AAPL' as const } : leg)),
  }
  const admitted = allocate(crossSleeve)
  expect(admitted.orders.map(({ symbol }) => symbol)).toEqual(['AAPL', 'QQQ', 'SMH'])
  expect(admitted.skipped[0]).toMatchObject({ engine: Reversion, reason: 'occupied-symbol' })
})

test('noon basket never degrades to fewer legs when an opening price is missing or beyond its collar', () => {
  for (const reference of [undefined, usd(99)]) {
    const other = new Map(openings)
    if (reference === undefined) other.delete('GOOGL')
    else other.set('GOOGL', reference)
    const output = Result.getOrThrow(
      allocateIntradayAlphaV3(policy, {
        entries: { ...empty, [Reversion]: entries[Reversion] },
        occupied: [],
        openingReferences: other,
      }),
    )
    expect(output.orders).toEqual([])
    expect(output.skipped[0]).toMatchObject({ reason: 'missing-open-or-outside-entry-collar' })
  }
})

test('OR5 refuses a gap through its range stop even if the buy limit would fill', () => {
  const output = Result.getOrThrow(
    allocateIntradayAlphaV3(policy, {
      entries: { ...empty, [Orb]: entries[Orb] },
      occupied: [],
      openingReferences: new Map([['AAPL', usd(98)]]),
    }),
  )
  expect(output.orders).toEqual([])
  expect(output.skipped[0]).toMatchObject({ reason: 'invalid-risk-or-open-through-stop' })
})
