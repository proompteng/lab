import { expect, test } from 'bun:test'
import { Result } from 'effect'

import { OrderSide } from '../../execution/contracts'
import {
  AlphaV3Direction,
  AlphaV3Engine,
  AlphaV3NoonExit,
  buildIntradayAlphaV3ExitPlan,
  decodeIntradayAlphaV3Policy,
  defaultIntradayAlphaV3Policy as policy,
  entryLimitMicros,
  guardIntradayAlphaV3NoonBasket,
  stopLimitCollar,
  type NoontimeLegFill,
} from './index'
import { at, blackFriday, regularSession, usd } from './test-support'

const long = AlphaV3Direction.Long
const short = AlphaV3Direction.Short
const orb = {
  engine: AlphaV3Engine.Orb,
  signal: { symbol: 'AAPL', direction: long, referenceMicros: usd(100), atr14Micros: usd(1), rangeStopMicros: usd(96) },
} as const
const noon = {
  engine: AlphaV3Engine.Reversion,
  signal: { symbol: 'GOOGL', direction: short, referenceMicros: usd(100), atr14Micros: usd(4) },
} as const
const noise = {
  engine: AlphaV3Engine.Noise,
  signal: { symbol: 'QQQ', direction: long, referenceMicros: usd(100), atr14Micros: usd(2) },
} as const
const fill = { averagePriceMicros: usd(101), observedAt: at(blackFriday, 10), shares: 17n }

test('side-aware entry limits enforce the 30 bp collar after quantizing inward', () => {
  expect(entryLimitMicros(policy, long, usd(100))).toBe(usd(100.3))
  expect(entryLimitMicros(policy, short, usd(100))).toBe(usd(99.7))
  expect(entryLimitMicros(policy, long, usd(1.994))).toBe(usd(1.99))
  expect(entryLimitMicros(policy, short, usd(1.994))).toBe(usd(1.99))
})

test('GOOGL buy-to-cover collar covers 275.88 from a 275.31 trigger; ATR dominates for wider names', () => {
  const floor = stopLimitCollar(policy, short, usd(275.31), usd(4))
  expect(floor).toEqual({ distanceMicros: 1_376_550n, limitMicros: usd(276.69) })
  expect(floor?.limitMicros).toBeGreaterThan(usd(275.88))
  expect(stopLimitCollar(policy, short, usd(275.31), usd(12))).toEqual({
    distanceMicros: usd(3),
    limitMicros: usd(278.31),
  })
  expect(stopLimitCollar(policy, long, usd(100), usd(12))).toEqual({
    distanceMicros: usd(3),
    limitMicros: usd(97),
  })
  expect(stopLimitCollar(policy, long, usd(1), usd(4))).toBeNull()
})

test('OR5 native OCO protects only confirmed shares and recomputes its 2R target from the actual fill', () => {
  const result = Result.getOrThrow(buildIntradayAlphaV3ExitPlan(policy, blackFriday, orb, fill))
  expect(result).toMatchObject({
    kind: 'native-oco',
    side: OrderSide.Sell,
    shares: 17n,
    stop: { triggerMicros: usd(96), limitMicros: usd(95.52) },
    target: { limitMicros: usd(111) },
  })
  const sell = { ...orb, signal: { ...orb.signal, direction: short, rangeStopMicros: usd(106) } }
  expect(Result.getOrThrow(buildIntradayAlphaV3ExitPlan(policy, blackFriday, sell, fill))).toMatchObject({
    kind: 'native-oco',
    side: OrderSide.Buy,
    stop: { triggerMicros: usd(106), limitMicros: usd(106.53) },
    target: { limitMicros: usd(91) },
  })
  expect(
    Result.getOrThrow(buildIntradayAlphaV3ExitPlan(policy, blackFriday, orb, { ...fill, averagePriceMicros: usd(95) })),
  ).toMatchObject({
    kind: 'flatten',
    reason: 'fill-through-stop',
    shares: 17n,
    side: OrderSide.Sell,
  })
})

test('noon modes preserve timed flatten; optional 500/800 protection uses the stop ATR floor', () => {
  expect(Result.getOrThrow(buildIntradayAlphaV3ExitPlan(policy, blackFriday, noon, fill))).toMatchObject({
    kind: 'managed',
    side: OrderSide.Buy,
    oppositeBandExit: false,
    maximumHold: { reason: 'MaximumHold', dueAt: '2026-11-27T17:55:00.000Z' },
  })
  const bracket = Result.getOrThrow(
    decodeIntradayAlphaV3Policy({
      ...policy,
      reversion: { ...policy.reversion, exit: AlphaV3NoonExit.Bracket },
    }),
  )
  expect(
    Result.getOrThrow(
      buildIntradayAlphaV3ExitPlan(bracket, blackFriday, noon, { ...fill, averagePriceMicros: usd(100) }),
    ),
  ).toMatchObject({
    kind: 'native-oco',
    side: OrderSide.Buy,
    stop: { triggerMicros: usd(105), limitMicros: usd(106) },
    target: { limitMicros: usd(92) },
    maximumHold: { dueAt: '2026-11-27T17:55:00.000Z' },
  })
})

test('Black Friday and Christmas Eve use 13:00 ET regularCloseAt, not extended 17:00 ET', () => {
  for (const date of ['2026-11-27', '2026-12-24'] as const) {
    const fullSession = regularSession(date)
    const halfDay = { ...fullSession, regularCloseAt: `${date}T18:00:00.000Z` }
    const shortLimits = ['16:28', '17:55', '17:58']
    const fullLimits = ['16:28', '20:55', '20:58']
    for (const [i, entry] of [orb, noon, noise].entries()) {
      const check = (session: typeof halfDay, time: string) => {
        const observed = { ...fill, observedAt: at(session, 10) }
        const expected = `${date}T${time}:00.000Z`
        expect(
          Result.getOrThrow(buildIntradayAlphaV3ExitPlan(policy, session, entry, observed)).maximumHold.dueAt,
        ).toBe(expected)
        expect(
          Result.getOrThrow(
            buildIntradayAlphaV3ExitPlan(policy, session, entry, { ...observed, observedAt: expected }),
          ),
        ).toMatchObject({ kind: 'flatten', reason: 'MaximumHold', shares: 17n })
      }
      const shortLimit = shortLimits[i]
      const fullLimit = fullLimits[i]
      if (shortLimit === undefined || fullLimit === undefined) throw new Error('Missing fixture deadline')
      check(halfDay, shortLimit)
      check(fullSession, fullLimit)
    }
  }
  const earlier = { ...blackFriday, regularCloseAt: '2026-11-27T16:30:00.000Z' }
  expect(Result.getOrThrow(buildIntradayAlphaV3ExitPlan(policy, earlier, orb, fill)).maximumHold.dueAt).toBe(
    '2026-11-27T16:15:00.000Z',
  )
})

const symbols = ['AAPL', 'AMD', 'GOOGL', 'NVDA'] as const
const working = symbols.map(
  (symbol, i): NoontimeLegFill => ({
    symbol,
    direction: i < 2 ? long : short,
    requestedShares: 10n,
    filledShares: i === 0 ? 4n : 0n,
    remainingShares: i === 0 ? 4n : 0n,
    entry: 'working',
    protection: 'terminal',
    reduction: 'terminal',
  }),
)
const guard = (legs: readonly NoontimeLegFill[], minute: number, aborting = false) =>
  Result.getOrThrow(
    guardIntradayAlphaV3NoonBasket(policy, {
      legs,
      aborting,
      entryDeadlineAt: at(blackFriday, 151),
      observedAt: at(blackFriday, minute),
    }),
  )

test('partial noon basket cancels entry and protection before issuing reduce-only confirmed residuals', () => {
  expect(guard(working, 150)).toMatchObject({ kind: 'await-fills' })
  expect(guard(working, 151)).toEqual({ kind: 'cancel-entries', aborting: true, symbols: [...symbols] })
  const rejected = working.map((row): NoontimeLegFill => (row.symbol === 'NVDA' ? { ...row, entry: 'terminal' } : row))
  expect(guard(rejected, 150).kind).toBe('cancel-entries')
  const late = working.map(
    (row): NoontimeLegFill => ({
      ...row,
      entry: 'terminal',
      filledShares: 10n,
      remainingShares: 10n,
      protection: row.symbol === 'GOOGL' ? 'working' : 'terminal',
    }),
  )
  expect(guard(late, 152, true)).toEqual({ kind: 'cancel-protection', aborting: true, symbols: ['GOOGL'] })
  const cleared = late.map(
    (row): NoontimeLegFill => ({
      ...row,
      protection: 'terminal',
      remainingShares: row.symbol === 'GOOGL' ? 3n : row.symbol === 'AAPL' ? 4n : 0n,
    }),
  )
  expect(guard(cleared, 152, true)).toEqual({
    kind: 'reduce-residuals',
    aborting: true,
    reductions: [
      { symbol: 'AAPL', side: OrderSide.Sell, shares: 4n, reduceOnly: true },
      { symbol: 'GOOGL', side: OrderSide.Buy, shares: 3n, reduceOnly: true },
    ],
  })
  expect(
    guard(
      cleared.map(
        (row): NoontimeLegFill => ({
          ...row,
          reduction: row.symbol === 'GOOGL' ? 'working' : 'terminal',
        }),
      ),
      152,
      true,
    ).kind,
  ).toBe('await-reductions')
  expect(
    guard(
      cleared.map((row) => ({ ...row, remainingShares: 0n })),
      152,
      true,
    ).kind,
  ).toBe('flat')
  expect(guard(late, 150).kind).toBe('complete')
  expect(guard(cleared, 150).kind).toBe('reduce-residuals')
  expect(guard(cleared, 151).kind).toBe('reduce-residuals')
})
