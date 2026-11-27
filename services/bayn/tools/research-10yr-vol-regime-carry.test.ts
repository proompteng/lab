import { describe, expect, test } from 'bun:test'
import { verifyReceipt } from './research-10yr-vol-regime-carry'
import { type Session, assets, parseBars } from './vol-regime-carry-data'
import { stationaryP, summarize, windows, windowDays } from './vol-regime-carry-metrics'
import { idleTarget, openingTrade, replay, shouldTrade } from './vol-regime-carry-replay'
import {
  compressionScale,
  creditAllocation,
  defensiveWinner,
  neighbors,
  riskParity,
  signalModel,
  trialId,
  trials,
  volatilityScale,
  weights,
} from './vol-regime-carry-signals'

const allocation = (spy: number, shy = 0) => {
  const target = weights()
  target[assets.SPY] = spy
  target[assets.SHY] = shy
  return target
}

const day = (date: string, open: number, close: number, shy = 100): Session => {
  const bars: Session['bars'] = []
  bars[assets.SPY] = { open, close }
  bars[assets.SHY] = { open: shy, close: shy }
  return { date, bars }
}

describe('Wave 5C registration and data', () => {
  test('all configurations are unique with symmetric one-parameter neighbors', () => {
    expect(trials).toHaveLength(62)
    expect(new Set(trials.map(trialId)).size).toBe(62)
    expect(trials.filter((trial) => trial.family === 'F1')).toHaveLength(18)
    expect(trials.filter((trial) => trial.family === 'F2')).toHaveLength(16)
    expect(trials.filter((trial) => trial.family === 'F3')).toHaveLength(12)
    expect(trials.filter((trial) => trial.family === 'F4')).toHaveLength(16)
    for (const [i, peers] of neighbors.entries()) {
      expect(peers.length).toBeGreaterThan(0)
      for (const j of peers) {
        expect(neighbors[j]).toContain(i)
        expect(trials[j].family).toBe(trials[i].family)
        expect(Object.values(trials[i]).filter((value, k) => value !== Object.values(trials[j])[k])).toHaveLength(1)
      }
    }
  })

  test('development does not decode later prices, while scoring rejects malformed and duplicate rows', () => {
    const row = 'SPY\t2023-12-29T05:00:00Z\t100\t102\t98\t101\t500\t100'
    const bad = 'SPY\t2024-01-02T05:00:00Z\tnot-a-price'
    expect(parseBars(`${row}\n${bad}`, ['SPY'], '2023-12-29').get('2023-12-29')?.bars[assets.SPY]).toEqual({
      open: 100,
      close: 101,
    })
    expect(() => parseBars(`${row}\n${bad}`, ['SPY'], '2024-01-02')).toThrow('2024-01-02')
    expect(() => parseBars(`${row}\n${row}`, ['SPY'], '2024-01-02')).toThrow('out-of-order')
    expect(() => verifyReceipt('development only\n', 'development only')).toThrow('holdout unopened')
  })
})

describe('structural signals', () => {
  test('risk parity equalizes contributions, not dollars; scale falls with realized variance', () => {
    const covariance = [
      [4, 0.5],
      [0.5, 1],
    ]
    const [a, b] = riskParity(covariance, [0.5, 0.5])
    expect(a + b).toBeCloseTo(1, 10)
    expect(a).toBeCloseTo(1 / 3, 10)
    expect(a * (4 * a + 0.5 * b)).toBeCloseTo(b * (0.5 * a + b), 10)
    expect(volatilityScale(0.1, 0.2, 2)).toBe(0.25)
    expect(volatilityScale(0.1, 0.2, 1)).toBe(0.5)
    expect(volatilityScale(0.1, 0.05, 2)).toBe(1)
    expect(compressionScale('both', 0.5, [0.3, 0.2, 0.2])).toBe(0.75)
    expect(compressionScale('both', 0.5, [0.5, 0.3, 0.2])).toBe(0.5)
    expect(compressionScale('slow', 0.75, [0.1, 0.3, 0.2])).toBe(0.25)
  })

  test('credit abstains on omissions; rate and inflation ratios change the winning haven', () => {
    expect(creditAllocation(0.03, -0.04)).toBeCloseTo(2 / 3)
    expect(creditAllocation(undefined, 0.03)).toBe(1)
    expect(creditAllocation(undefined, undefined)).toBe(0)
    const scores: Record<string, number> = {
      TLT: 0.1,
      IEF: 0.08,
      UUP: 0.07,
      DBC: 0.06,
      'TLT/IEF': -0.02,
      'TLT/SHY': -0.03,
      'DBC/TLT': 0.04,
      'GLD/TLT': 0.02,
      'UUP/SHY': 0.01,
    }
    const winner = () => defensiveWinner((a, b) => scores[b !== undefined ? `${a}/${b}` : a])
    expect(winner()).toBe('UUP')
    scores['UUP/SHY'] = -0.01
    expect(winner()).toBe('DBC')
    scores['TLT/IEF'] = 0.02
    scores['TLT/SHY'] = 0.03
    scores['DBC/TLT'] = -0.04
    scores['GLD/TLT'] = -0.02
    expect(winner()).toBe('TLT')
  })

  test('future prices do not affect earlier targets, and omitted symbols leave the allocation', () => {
    const sample = Array.from(
      { length: 145 },
      (_, t): Session => ({
        date: String(t),
        bars: weights().map((_, i) => {
          const price = 100 * Math.exp((t * (i + 1)) / 100_000 + Math.sin(t + i) * 0.01)
          return { open: price, close: price }
        }),
      }),
    )
    const config = { family: 'F4', cadence: 21, power: 2, credit: 'IEF', mix: 'equal' } as const
    const full = signalModel(sample)(config)
    const prefix = signalModel(sample.slice(0, 121))(config)
    expect(full.slice(0, 121)).toEqual(prefix)
    expect(full.slice(0, 99).every((target) => target === undefined)).toBe(true)
    expect(full[99]?.[assets.SPY]).toBeGreaterThan(0)
    const withoutSpy = signalModel(sample, 'SPY')(config)
    expect(withoutSpy[99]?.[assets.SPY]).toBe(0)
    expect(withoutSpy[99]?.[assets.EFA]).toBeGreaterThan(0)
  })
})

describe('next-open portfolio accounting and inference', () => {
  test('a prior close order earns no opening gap, existing shares do, and turnover excludes drift', () => {
    const days = [
      day('2023-12-29', 100, 100, 100),
      day('2024-01-02', 120, 132, 101),
      day('2024-01-03', 118.8, 118.8, 103),
    ]
    const path = replay(days, [allocation(1), allocation(0), allocation(1)], 10)
    expect(path[0].zero.net).toBe(0)
    expect(path[1].zero.net).toBeCloseTo(1.1 / 1.0005 - 1, 12)
    expect(path[2].zero.net).toBeCloseTo(0.9 * (1 - 0.000521) - 1, 12)
    expect(path[1].zero.turnover).toBeCloseTo(0.5 / 1.0005, 12)
    expect(path[2].zero.turnover).toBeCloseTo(0.5, 12)
    expect(path[2].idle.net).toBeCloseTo((0.9 * (1 - 0.000521)) / 1.0005 - 1, 12)
    const report = summarize(windowDays(path, windows[2]), 'idle')
    expect(report.excess).toBeCloseTo(report.net - (103 / 100 - 1), 12)
  })

  test('band is applied to total replacement and SHY orders net explicit and idle allocations', () => {
    expect(shouldTrade(allocation(0.5, 0.5), allocation(0.45, 0.55))).toBe(false)
    expect(shouldTrade(allocation(0.5, 0.5), allocation(0.38, 0.62))).toBe(true)
    expect(idleTarget(allocation(0.5, 0.2))[assets.SHY]).toBeCloseTo(0.5)
    expect(idleTarget(allocation(0.5, 0.2), 'SHY')[assets.SHY]).toBe(0.2)
    const trade = openingTrade(allocation(0.5, 0.5), 1, allocation(0.2, 0.7), 20)
    const buy = trade.invested[assets.SHY] - 0.5
    const sell = 0.5 - trade.invested[assets.SPY]
    expect(() => openingTrade(allocation(0.5, 0.5), 1, allocation(1, 0.2), 20)).toThrow('long-only')
    expect(trade.fees).toBeCloseTo(buy * 0.001 + sell * 0.001021, 12)
    expect(trade.cash + trade.invested.reduce((a, b) => a + b, 0) + trade.fees).toBeCloseTo(1, 12)
  })

  test('missing execution fails; SHY stays external when it is omitted', () => {
    const days = [day('2024-01-02', 100, 100, 100), day('2024-01-03', 100, 100, 101)]
    expect(replay(days, [], 10, 'SHY')[1]).toMatchObject({ shy: expect.closeTo(0.01), idle: { net: 0 } })
    const missing = weights()
    missing[assets.GLD] = 1
    expect(() => replay(days, [missing], 10)).toThrow('Unavailable or omitted execution: GLD')
  })

  test('paired stationary inference is deterministic, directional, and null for constant excess', () => {
    const events = Array.from({ length: 250 }, (_, i) => (i % 13 < 8 ? 0.003 : -0.002))
    const p = stationaryP(events)
    expect(p).toBe(stationaryP(events))
    expect(p).toBeLessThan(0.01)
    expect(stationaryP(events.map((value) => -value))).toBeGreaterThan(0.99)
    expect(stationaryP(events.map(() => 0))).toBeNull()
  })
})
