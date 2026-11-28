import { expect, test } from 'bun:test'

import { asset, emptyWeights, universe } from '../../src/strategy/macro-etf-core/policy'
import { stationaryBootstrap, stationaryMeanP } from '../research-lib/statistics'
import { mixes, replayAccount, toMarks, tradeNoise } from './macro-etf-core-dual-horizon-account'
import type { DailyFrame } from './macro-etf-core-dual-horizon-data'
import { bootstrap, drawdownDays, pairedCorrelation } from './macro-etf-core-dual-horizon-statistics'
import { type NoiseOrder, noiseOrders } from '../pure-etf-dual-horizon-noise'

const micros = (n: number) => BigInt(n * 1_000_000)
const order = (overrides: Partial<NoiseOrder> = {}): NoiseOrder => ({
  symbol: 'QQQ',
  side: 1,
  atr: 2,
  reference: 100,
  entrySlot: 6,
  exitSlot: 12,
  entry: 100,
  exit: 101,
  heldGaps: 0,
  ...overrides,
})

test('uses only opening-price reservations, releases exits before same-slot entries, and blocks overlapping symbols', () => {
  const positions = universe.map(() => 0n)
  const q = order()
  const s = order({ symbol: 'SMH', entrySlot: 12, exitSlot: 18 })
  const execute = (orders: NoiseOrder[]) =>
    tradeNoise('2016-01-04', orders, 1, micros(100_000), micros(40_000), positions, 10)
  expect(execute([q, s])).toMatchObject({ fills: 2, conflicts: 0, trims: 0, peak: micros(37_537.5) })
  expect(execute([q, { ...s, entrySlot: 11 }])).toMatchObject({ fills: 2, trims: 1 })
  positions[asset.QQQ] = 1n
  expect(execute([q, s])).toMatchObject({ fills: 1, conflicts: 1 })
  expect(() => execute([{ ...s, exit: undefined }])).toThrow('Unresolved Noise exit')
})

test('retains the first causal next-open Noise order and honors an early closing bell', () => {
  const prior = Array.from({ length: 14 }, (_, i) => ({
    date: String(i),
    slots: 78,
    bars: new Map([
      [
        'QQQ' as const,
        Array.from({ length: 78 }, (_, slot) => ({
          open: 100,
          high: 102,
          low: 99,
          close: slot === 77 ? 100 : 101,
        })),
      ],
    ]),
  }))
  const today = Array.from({ length: 42 }, (_, slot) => ({
    open: slot === 6 ? 104 : 100,
    high: slot === 5 || slot === 6 ? 104 : 101,
    low: 99,
    close: slot === 5 ? 104 : 100,
  }))
  const observed = noiseOrders([...prior, { date: 'early close', slots: 42, bars: new Map([['QQQ', today]]) }]).at(-1)
  expect(observed?.orders).toEqual([order({ atr: 3, reference: 104, entry: 104, exit: 100, exitSlot: 41 })])
})

test('marks inherited SHY to the next open before an inventory swap and reconciles account P&L', () => {
  const frame = (date: string, shyOpen: number, spyClose: number): DailyFrame => ({
    date,
    openAt: 0,
    closeAt: 0,
    bars: new Map([
      ['SPY', { open: 100, close: spyClose, high: spyClose, low: 100 }],
      ['SHY', { open: shyOpen, close: shyOpen, high: shyOpen, low: shyOpen }],
    ]),
  })
  const spy = emptyWeights()
  spy[asset.SPY] = 1
  const target = new Map([['2016-01-05', spy]])
  const frames = toMarks([frame('2016-01-04', 100, 100), frame('2016-01-05', 102, 110)])
  const [first, second] = replayAccount(frames, [[], []], { F2: target, F4: target, O1: [] }, mixes.E1, 2)
  expect(second.overnightTraded).toBeGreaterThan(190_000)
  expect(second.equity).toBeGreaterThan(111_000)
  expect(second.equity).toBeLessThan(112_200)
  expect(first.equity * (1 + second.net)).toBeCloseTo(second.equity, 7)
  expect(second.intraday).toBe(0)
})

test('SPY drawdown means below prior high water, not simply a down day', () => {
  const drawdown = drawdownDays([0.1, -0.1, 0.05, 0.07])
  expect(drawdown).toEqual([false, true, true, false])
  expect(pairedCorrelation([1, 2, 3, 4], [-1, -2, -3, -4], drawdown)).toEqual({
    all: -1,
    spyDrawdownDays: -1,
    spyDrawdownSessions: 2,
  })
  expect(stationaryMeanP([0, 0, 0], stationaryBootstrap(3, bootstrap))).toBeNull()
  expect(stationaryMeanP([0.01, 0.02, 0.01, 0.02], stationaryBootstrap(4, bootstrap))).toBe(1 / 10_001)
})
