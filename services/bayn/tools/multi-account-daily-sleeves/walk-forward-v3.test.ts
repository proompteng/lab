import { expect, test } from 'bun:test'

import { asset, emptyWeights, type Etf, universe } from '../../src/strategy/macro-etf-core/policy'
import { promotionChecks } from '../research-macro-portfolio-v3'
import type { DailyFrame } from '../research/macro-etf-core-dual-horizon-data'
import type { DailySession } from '../three-account-capital-core'
import { cashV3Rules, replayCashV3 } from './walk-forward-v3'

const flat = (symbol: Etf) => (symbol === 'SHY' ? 50 : 100)
const tape = (price: (symbol: Etf, i: number) => number = flat, f4Symbol: Etf = 'SHY') => {
  const frames: DailyFrame[] = Array.from({ length: 185 }, (_, i) => {
    const openAt = Date.UTC(2022, 0, 1 + i, 14, 30)
    return {
      date: new Date(openAt).toISOString().slice(0, 10),
      openAt,
      closeAt: openAt + 390 * 60_000,
      bars: new Map(
        universe.map((symbol) => {
          const mark = price(symbol, i)
          return [symbol, { open: mark, close: mark, low: mark, high: mark }]
        }),
      ),
    }
  })
  const weights = emptyWeights()
  weights[asset[f4Symbol]] = 1
  const daily = frames.map(
    ({ date, bars }, i): DailySession => ({
      date,
      bars,
      f4: i === 101 || i === 143 ? weights : undefined,
      o1: undefined,
    }),
  )
  return { frames, daily }
}

const markClose = (frames: readonly DailyFrame[], index: number, adjust: (symbol: Etf, mark: number) => number) =>
  frames.map((frame, i) =>
    i === index
      ? {
          ...frame,
          bars: new Map(
            [...frame.bars].map(([symbol, bar]) => {
              const close = adjust(symbol, bar.close)
              return [symbol, { ...bar, close, high: Math.max(bar.high, close), low: Math.min(bar.low, close) }]
            }),
          ),
        }
      : frame,
  )

test('keeps SHY carry, stages whole-share buys after sale settlement, and skips a review inside the band', () => {
  const { frames, daily } = tape()
  const sell = cashV3Rules.firstO1OpenIndex
  const path = replayCashV3(frames, daily, 2)
  expect(path.slice(1, sell).every(({ tradedUsd }) => tradedUsd === 0)).toBe(true)
  expect(path[sell].tradedUsd).toBe(12_500)
  expect(path[sell + 1].tradedUsd).toBe(12_200)
  expect(path.slice(sell + 2).every(({ tradedUsd }) => tradedUsd === 0)).toBe(true)
  expect(path.every(({ openingGross }) => openingGross <= 1)).toBe(true)
  expect(replayCashV3(frames, daily, 10).at(-1)?.o1).toBeLessThan(path.at(-1)?.o1 ?? 0)

  const higherShy = markClose(frames, sell + 2, (symbol, mark) => (symbol === 'SHY' ? mark + 1 : mark))
  const parked = replayCashV3(higherShy, daily, 2)[sell + 2]
  expect(parked.o1 - path[sell + 2].o1).toBe(249)
  expect(parked.tradedUsd).toBe(0)
})

test('an execution-session close cannot change that open or the buy already staged by that review', () => {
  const { frames, daily } = tape()
  const review = cashV3Rules.firstO1OpenIndex
  const loss = (symbol: Etf, mark: number) => (symbol === 'SHY' ? mark : mark / 2)
  const original = replayCashV3(frames, daily, 10)
  const currentClose = replayCashV3(markClose(frames, review, loss), daily, 10)
  const priorClose = replayCashV3(markClose(frames, review - 1, loss), daily, 10)
  expect(currentClose.slice(0, review)).toEqual(original.slice(0, review))
  expect(currentClose[review].tradedUsd).toBe(original[review].tradedUsd)
  expect(currentClose[review + 1].tradedUsd).toBe(original[review + 1].tradedUsd)
  expect(priorClose[review].tradedUsd).toBe(0)
  expect(priorClose[review + 1].tradedUsd).toBe(0)
})

test('rejects misaligned targets and cannot fund a purchase without a verified opening mark', () => {
  const { frames, daily } = tape()
  const buy = cashV3Rules.firstO1OpenIndex + 1
  const bars = new Map(frames[buy].bars)
  bars.delete('SPY')
  frames[buy] = { ...frames[buy], bars }
  expect(() => replayCashV3(frames, daily.slice(1), 10)).toThrow('Session count mismatch')
  expect(() => replayCashV3(frames, daily, 10)).toThrow(`Missing price: SPY ${frames[buy].date}`)
})

test('moves O1 away from SPY when its lagged returns duplicate F4', () => {
  const { frames, daily } = tape(
    (symbol, i) => (symbol === 'SPY' ? 100 + i * 0.07 + (i % 2) * 0.4 : flat(symbol)),
    'SPY',
  )
  const held = cashV3Rules.firstO1OpenIndex + 2
  const normal = replayCashV3(frames, daily, 5)[held]
  const spy = markClose(frames, held, (symbol, mark) => (symbol === 'SPY' ? mark * 1.2 : mark))
  const gold = markClose(frames, held, (symbol, mark) => (symbol === 'GLD' ? mark * 1.2 : mark))
  expect(replayCashV3(spy, daily, 5)[held].o1).toBe(normal.o1)
  expect(replayCashV3(gold, daily, 5)[held].o1).toBeGreaterThan(normal.o1)
})

test('lagged portfolio volatility can keep a turbulent F4 target parked', () => {
  const calm = tape(flat, 'SPY')
  const turbulent = tape((symbol, i) => (symbol === 'SPY' ? 100 + (i % 2) * 25 : flat(symbol)), 'SPY')
  expect(replayCashV3(calm.frames, calm.daily, 5)[143].tradedUsd).toBeGreaterThan(0)
  expect(replayCashV3(turbulent.frames, turbulent.daily, 5)[143].tradedUsd).toBe(0)
})

test('requires strict improvements and rejects unmeasured or boundary risk at both stress costs', () => {
  const frozen = {
    cagr: 0.0691277,
    sharpe: 1.1746678,
    maxDrawdown: 0.136,
    correlation: 0.78,
    correlationB0: 0.013,
    maxOpeningGross: null,
    oneWayTurnover: 1.5,
  }
  const winner = {
    ...frozen,
    cagr: 0.071,
    sharpe: 1.35,
    maxDrawdown: 0.09,
    correlation: 0.72,
    maxOpeningGross: 1,
    oneWayTurnover: 2,
  }
  for (const cost of [5, 10] as const) {
    const passes = (candidate: Parameters<typeof promotionChecks>[2]) =>
      Object.values(promotionChecks(cost, frozen, candidate)).every(Boolean)
    expect(passes(winner)).toBe(true)
    expect(passes({ ...winner, cagr: frozen.cagr })).toBe(false)
    expect(passes({ ...winner, sharpe: cost === 5 ? 1.175 : frozen.sharpe })).toBe(false)
    expect(passes({ ...winner, correlation: null })).toBe(false)
    expect(passes({ ...winner, correlation: 0.77 })).toBe(false)
    expect(passes({ ...winner, correlationB0: -0.15 })).toBe(false)
    expect(passes({ ...winner, maxDrawdown: 0.12 })).toBe(false)
    expect(passes({ ...winner, maxOpeningGross: 1.0001 })).toBe(false)
    expect(passes({ ...winner, oneWayTurnover: 2.0001 })).toBe(false)
  }
})
