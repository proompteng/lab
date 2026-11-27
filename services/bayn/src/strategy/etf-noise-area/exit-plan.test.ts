import { describe, expect, test } from 'bun:test'
import { Result } from 'effect'

import { OrderSide, OrderType } from '../../execution/contracts'
import { quantityScale } from '../../quantity'
import { planNoiseAreaEntries, planNoiseAreaProtection } from './exit-plan'
import { decodeEtfNoiseAreaPolicy, defaultEtfNoiseAreaPolicy, expandedEtfNoiseAreaPolicy } from './policy'
import type { NoiseAreaBreakout } from './signals'

const micros = 1_000_000n
const breakout = (
  symbol: NoiseAreaBreakout['symbol'] = 'QQQ',
  _tag: NoiseAreaBreakout['_tag'] = 'LongBreakout',
  atr14Micros = 2n * micros,
): NoiseAreaBreakout => ({
  _tag,
  symbol,
  checkpointAt: '2026-11-27T17:30:00.000Z',
  referencePriceMicros: 100n * micros,
  sessionOpenPriceMicros: 100n * micros,
  atr14Micros,
  flattenAt: '2026-11-27T17:58:00.000Z',
})

const run = (overrides: Partial<Parameters<typeof planNoiseAreaEntries>[0]> = {}) =>
  planNoiseAreaEntries({
    policy: defaultEtfNoiseAreaPolicy,
    capitalBudgetMicros: 250_000n * micros,
    usedGrossMicros: 0n,
    signals: [breakout(), breakout('SMH', 'ShortBreakout')],
    ...overrides,
  })

const entry = (signal: NoiseAreaBreakout) => {
  const [plan] = Result.getOrThrow(run({ signals: [signal] }))
  if (plan === undefined) throw new Error('expected funded entry')
  return plan
}

describe('entry limits and whole-share gross reservation', () => {
  test('prices both sides at 25 bp and rounds fractional ticks inside the collar', () => {
    expect(entry(breakout())).toMatchObject({
      side: OrderSide.Buy,
      orderType: OrderType.Limit,
      limitPriceMicros: 100_250_000n,
    })
    expect(entry(breakout('SMH', 'ShortBreakout'))).toMatchObject({
      side: OrderSide.Sell,
      orderType: OrderType.Limit,
      limitPriceMicros: 99_750_000n,
      grossReservePriceMicros: 100_250_000n,
    })
    const referencePriceMicros = 100_003_001n
    expect(entry({ ...breakout(), referencePriceMicros })).toMatchObject({
      limitPriceMicros: 100_250_000n,
      grossReservePriceMicros: 100_260_000n,
    })
    expect(entry({ ...breakout('SMH', 'ShortBreakout'), referencePriceMicros }).limitPriceMicros).toBe(99_760_000n)
    expect(entry(breakout())).toMatchObject({ exitRule: 'oppositeBand', flattenAt: '2026-11-27T17:58:00.000Z' })
  })

  test('caps both sides at $180k combined, reserves existing and pending gross, and respects lower budgets', () => {
    const sum = (plans: Result.Result.Success<ReturnType<typeof run>>) =>
      plans.reduce((total, plan) => total + plan.reservedGrossMicros, 0n)
    const full = Result.getOrThrow(run())
    expect(full.map(({ quantityAtoms }) => quantityAtoms)).toEqual([897n * quantityScale, 897n * quantityScale])
    expect(sum(full)).toBe(179_848_500_000n)
    const usedGrossMicros = 120_000n * micros
    const partial = Result.getOrThrow(run({ usedGrossMicros }))
    expect(sum(partial) + usedGrossMicros).toBeLessThanOrEqual(180_000n * micros)
    expect(sum(partial) + usedGrossMicros).toBeGreaterThan(179_800n * micros)
    const lower = Result.getOrThrow(run({ capitalBudgetMicros: 50_000n * micros, usedGrossMicros: 10_000n * micros }))
    expect(sum(lower)).toBeLessThanOrEqual(40_000n * micros)
    expect(sum(lower)).toBeGreaterThan(39_800n * micros)
    expect(Result.getOrThrow(run({ usedGrossMicros: 180_000n * micros }))).toEqual([])
    expect(Result.getOrThrow(run({ capitalBudgetMicros: 100n * micros }))).toEqual([])

    const one = Result.getOrThrow(run({ signals: [breakout()] }))
    expect(one).toEqual(full.slice(0, 1))
    expect(Result.getOrThrow(run({ signals: [breakout('SMH', 'ShortBreakout'), breakout()] }))).toEqual(full)
  })

  test('expanded cohort allocates only its own budget and inverse volatility uses relative ATR', () => {
    expect(
      Result.getOrThrow(
        run({
          policy: expandedEtfNoiseAreaPolicy,
          signals: expandedEtfNoiseAreaPolicy.symbols.map((symbol) => breakout(symbol)),
        }),
      ).map(({ quantityAtoms }) => quantityAtoms),
    ).toEqual(Array<bigint>(6).fill(299n * quantityScale))

    const policy = Result.getOrThrow(
      decodeEtfNoiseAreaPolicy({ ...defaultEtfNoiseAreaPolicy, sizing: 'inverseVolatility' }),
    )
    const signals = [
      breakout(),
      { ...breakout('SMH', 'ShortBreakout', 2n * micros), sessionOpenPriceMicros: 50n * micros },
    ]
    const full = Result.getOrThrow(run({ policy, signals }))
    expect(full.map(({ quantityAtoms }) => quantityAtoms)).toEqual([1_197n * quantityScale, 598n * quantityScale])
    expect(
      Result.getOrThrow(
        run({
          policy,
          signals: [breakout()],
          volatilityBySymbol: { SMH: { sessionOpenPriceMicros: 50n * micros, atr14Micros: 2n * micros } },
        }),
      ),
    ).toEqual(full.slice(0, 1))
    expect(Result.isFailure(run({ policy, signals: [breakout()] }))).toBe(true)
  })

  test('rejects duplicate, out-of-cohort and mixed-checkpoint signals and negative budget inputs', () => {
    for (const signals of [
      [breakout(), breakout()],
      [breakout('TLT')],
      [breakout(), { ...breakout('SMH'), checkpointAt: '2026-11-27T17:00:00.000Z' }],
      [{ ...breakout(), referencePriceMicros: 0n }],
    ])
      expect(Result.isFailure(run({ signals }))).toBe(true)
    expect(Result.isFailure(run({ usedGrossMicros: -1n }))).toBe(true)
    expect(Result.isFailure(run({ capitalBudgetMicros: -1n }))).toBe(true)
  })
})

describe('fill-anchored STOP_LIMIT protection', () => {
  test('uses 1.5×ATR14 and the 50 bp floor on a long and a short', () => {
    const policy = defaultEtfNoiseAreaPolicy
    const long = entry(breakout('QQQ', 'LongBreakout', micros))
    const short = entry(breakout('SMH', 'ShortBreakout', micros))
    expect(Result.getOrThrow(planNoiseAreaProtection(policy, long, 100n * micros))).toEqual({
      symbol: 'QQQ',
      side: OrderSide.Sell,
      orderType: OrderType.StopLimit,
      stopPriceMicros: 98_500_000n,
      stopLimitPriceMicros: 98_010_000n,
      flattenAt: long.flattenAt,
    })
    expect(Result.getOrThrow(planNoiseAreaProtection(policy, short, 100n * micros))).toEqual({
      symbol: 'SMH',
      side: OrderSide.Buy,
      orderType: OrderType.StopLimit,
      stopPriceMicros: 101_500_000n,
      stopLimitPriceMicros: 102_000_000n,
      flattenAt: short.flattenAt,
    })
  })

  test('keeps the quarter-ATR adaptive buffer separate from the stop trigger', () => {
    for (const [tag, stop, limit] of [
      ['LongBreakout', 94_000_000n, 93_000_000n],
      ['ShortBreakout', 106_000_000n, 107_000_000n],
    ] as const) {
      const plan = entry(breakout('QQQ', tag, 4n * micros))
      expect(Result.getOrThrow(planNoiseAreaProtection(defaultEtfNoiseAreaPolicy, plan, 100n * micros))).toMatchObject({
        stopPriceMicros: stop,
        stopLimitPriceMicros: limit,
      })
    }
  })

  test('caps the buffer at 150 bp and rejects an unprotectable entry or fill', () => {
    const policy = defaultEtfNoiseAreaPolicy
    const long = entry(breakout('QQQ', 'LongBreakout', 8n * micros))
    const short = entry(breakout('SMH', 'ShortBreakout', 8n * micros))
    expect(Result.getOrThrow(planNoiseAreaProtection(policy, long, 100n * micros))).toMatchObject({
      stopPriceMicros: 88_000_000n,
      stopLimitPriceMicros: 86_680_000n,
    })
    expect(Result.getOrThrow(planNoiseAreaProtection(policy, short, 100n * micros))).toMatchObject({
      stopPriceMicros: 112_000_000n,
      stopLimitPriceMicros: 113_680_000n,
    })
    expect(Result.isFailure(planNoiseAreaProtection(policy, long, 8n * micros))).toBe(true)
    expect(Result.getOrThrow(run({ signals: [breakout('QQQ', 'LongBreakout', 100n * micros)] }))).toEqual([])
  })
})
