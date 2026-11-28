import { describe, expect, test } from 'bun:test'

import { etfs as premiaEtfs } from './multi-asset-risk-premia-protocol'
import { buyingPower, mixes, replayAccount, tradeNoise } from './pure-etf-dual-horizon-account'
import type { DailyFrame, IntradayDay } from './pure-etf-dual-horizon-data'
import { bindExitSupplement, executionSupplement, noiseOrders, type NoiseOrder } from './pure-etf-dual-horizon-noise'
import {
  attribution,
  bootstrapRisk,
  correlations,
  spyDrawdownIndices,
  bootstrapProtocol,
  summarize,
} from './pure-etf-dual-horizon-statistics'
import { stationaryBootstrap, StationarySampling } from './research-lib/statistics'

const quote = (open: number, close = open) => ({ open, high: Math.max(open, close), low: Math.min(open, close), close })
const order = (overrides: Partial<NoiseOrder> = {}): NoiseOrder => ({
  symbol: 'QQQ',
  side: 1,
  atr: 1,
  reference: 100,
  entrySlot: 6,
  exitSlot: 77,
  entry: 100,
  exit: 102,
  heldGaps: 0,
  ...overrides,
})
const flat = { O1: [], O2: [] }

describe('frozen SIP contracts', () => {
  test('binds only the missing IWM exit to an overlapping SIP receipt without modifying signal input', () => {
    const { anchor, exit, date, symbol } = executionSupplement
    const bars: (ReturnType<typeof quote> | undefined)[] = Array.from({ length: 78 }, (_, i) =>
      i === anchor.slot ? anchor : undefined,
    )
    const day = { date, slots: bars.length, bars: new Map([[symbol, bars]]) }
    const intent = order({ symbol, entrySlot: anchor.slot, exitSlot: exit.slot, entry: anchor.open, exit: undefined })
    expect(bindExitSupplement(day, [intent])[0]).toMatchObject({ exit: 148.79, exitSource: 'sip-execution-supplement' })
    expect(intent.exit).toBeUndefined()
    expect(bars[exit.slot]).toBeUndefined()
    bars[anchor.slot] = { ...anchor, low: 1 }
    expect(() => bindExitSupplement(day, [intent])).toThrow('conflicts with frozen tape')
  })
})

describe('frozen Noise rule', () => {
  const day = (
    offset: number,
    slots: number,
    overrides: ReadonlyMap<number, ReturnType<typeof quote> | undefined> = new Map(),
  ): IntradayDay => ({
    date: new Date(Date.UTC(2020, 0, offset + 1)).toISOString().slice(0, 10),
    slots,
    bars: new Map([
      [
        'QQQ',
        Array.from({ length: slots }, (_, slot) => (overrides.has(slot) ? overrides.get(slot) : quote(100, 101))),
      ],
    ]),
  })
  const history = Array.from({ length: 14 }, (_, i) => day(i, 78))

  test('uses completed 30m checkpoints and flattens at the next open after an opposite breach', () => {
    const today = day(
      14,
      78,
      new Map([
        [4, quote(100, 140)],
        [5, quote(100, 103)],
        [6, quote(104)],
        [11, quote(100, 98)],
        [12, quote(97)],
        [17, quote(100, 110)],
      ]),
    )
    const recent = noiseOrders([...history, today])
    expect(recent.slice(0, 14).every(({ orders }) => orders.length === 0)).toBe(true)
    expect(recent[14].orders).toEqual([
      { symbol: 'QQQ', side: 1, atr: 1, reference: 103, entrySlot: 6, exitSlot: 12, entry: 104, exit: 97, heldGaps: 0 },
    ])
  })

  test('clamps early close, resets on an incomplete prior session, never delays a missing entry', () => {
    const overrides = new Map([
      [5, quote(100, 103)],
      [6, undefined],
      [11, quote(100, 110)],
    ])
    const result = noiseOrders([...history, day(14, 42, overrides), day(15, 78, overrides)])
    expect(result[14].orders).toHaveLength(1)
    expect(result[14].orders[0]).toMatchObject({ entrySlot: 6, entry: undefined, exitSlot: 41 })
    expect(result[15].orders).toHaveLength(0)
    expect(result[15].ready).toHaveLength(0)
  })
})

describe('shared account', () => {
  test('enforces reserved gross, removes closing trades before new entries, and rejects a same-symbol conflict', () => {
    const result = tradeNoise(
      '2020-01-02',
      [
        order({ symbol: 'IWM' }),
        order({ exitSlot: 12 }),
        order({ symbol: 'SMH', entrySlot: 12, side: -1 }),
        order({ symbol: 'SPY', entrySlot: 12 }),
      ],
      'I2',
      1,
      100_000,
      20_000,
      new Set(['IWM']),
      2,
    )
    expect(result.conflicts).toBe(1)
    expect(result.trims).toBe(3)
    expect(result.trades.map((trade) => [trade.symbol, trade.signedShares])).toEqual([
      ['QQQ', 199],
      ['SMH', -199],
    ])
    expect(result.peakReserved).toBeCloseTo(19_909.95)
    expect(result.trades[0].fee).toBeCloseTo(199 * 102 * 0.9999 * 0.000021, 8)
    expect(result.trades[1].fee).toBeCloseTo(199 * 100 * 0.9999 * 0.000021, 8)
    expect(result.trades[0].slippage).toBeCloseTo(199 * 202 * 0.0001, 8)
    expect(() => tradeNoise('d', [order({ exit: undefined })], 'I1', 1, 100_000, 180_000, new Set(), 2)).toThrow(
      'Unresolved intraday exit',
    )
  })

  test('treats prior-close equity and maintenance as separate requirements', () => {
    expect(buyingPower(24_999, 0)).toBe(0)
    expect(buyingPower(30_000, 22_000)).toBe(32_000)
    expect(buyingPower(30_000, 40_000)).toBe(0)
  })

  test('prevents lookahead; nets positions, charges weekend financing once and reconciles USD attribution', () => {
    const bars: DailyFrame['bars'] = new Map([
      ['SPY', quote(100)],
      ['IEF', quote(100)],
    ])
    const days: DailyFrame[] = [
      { date: '2020-01-02', bars },
      { date: '2020-01-03', bars },
      { date: '2020-01-06', bars },
    ]
    const target = premiaEtfs.map((symbol) => (symbol === 'SPY' ? 1.4 : symbol === 'IEF' ? -0.4 : 0))
    const rows = replayAccount(
      days,
      [],
      { O1: [], O2: [target, target] },
      {
        mix: { O1: 0, O2: 1, intraday: 0 },
        bp: 2,
        carry: 'zero',
        mode: 'fixed',
      },
    )
    expect(rows[0].overnightClose).toEqual({})
    expect(rows[1].closeGross).toBeCloseTo(150_000)
    expect(rows[1].overnightTrim).toBe(true)
    expect(rows[1].borrow).toBe(0)
    expect(rows[2].borrow).toBeCloseTo((((150_000 * 0.4) / 1.8) * 0.015 * 3) / 365, 8)
    expect(rows[2].debit).toBeCloseTo((((150_000 * 1.4) / 1.8 - rows[1].equity) * 0.065 * 3) / 360, 8)
    expect(rows[2].dtbp).toBeCloseTo(4 * (rows[1].equity - 45_000), 8)
    const components = attribution(rows)
    const { total, ...parts } = components
    expect(Object.values(parts).reduce((a, b) => a + b, 0)).toBeCloseTo(total, 8)
  })

  test('fixed sizing does not compound and carry remains an actual holding; Noise closes in-session', () => {
    const bars = new Map([['SHY', quote(100)]])
    const days = [
      { date: '2020-01-02', bars },
      { date: '2020-01-03', bars },
    ]
    const trades = [[order({ atr: 2, exit: 120 })], [order({ atr: 2, exit: 120 })]]
    const options = { mix: mixes.M2, carry: 'SHY', bp: 2 } as const
    const fixed = replayAccount(days, trades, flat, { ...options, mode: 'fixed' })
    const compound = replayAccount(days, trades, flat, { ...options, mode: 'compound' })
    expect(fixed[0].trades[0].signedShares).toBe(375)
    expect(fixed[1].trades[0].signedShares).toBe(375)
    expect(compound[1].trades[0].signedShares).toBeGreaterThan(375)
    expect(Object.keys(fixed[1].overnightClose)).toEqual(['SHY'])
    expect(compound[1].openGross + compound[1].intradayPeak).toBeLessThanOrEqual(180_000)
    expect(fixed.every(({ borrow, debit }) => borrow === 0 && debit === 0)).toBe(true)
    expect(replayAccount(days, trades, flat, { ...options, mode: 'fixed', carry: 'zero' })[1].overnightClose).toEqual(
      {},
    )
  })
})

describe('paired metrics and stationary bootstrap', () => {
  test('uses paired dates, additive vs multiplicative NAV, and true below-high-water observations', () => {
    const dates = ['2020-01-01', '2020-01-02', '2020-01-03']
    const net = [0.2, -0.1, 0.05]
    const shy = [0.01, 0.01, 0.01]
    const a = summarize(dates, net, shy, net, 'fixed')
    const b = summarize(dates, net, shy, net, 'compound')
    expect(a.netReturn).toBeCloseTo(0.15)
    expect(b.netReturn).toBeCloseTo(0.134)
    expect(a.exTop10ExcessOverShy).toBeCloseTo(-0.11)
    expect(a.spyBeta).toBe(1)
    expect(spyDrawdownIndices(net)).toEqual([1, 2])
    expect(correlations({ A: net, B: net.map((x) => -x) }, [0, 1, 2]).matrix[0][1]).toBe(-1)
  })

  test('centers paired excess for the null and uses the uncentered strategy path for tail losses', () => {
    const constant = [0.01, 0.01, 0.01]
    const plan = stationaryBootstrap(constant.length, bootstrapProtocol, StationarySampling.RightTailMidpoint)
    expect(bootstrapRisk(constant, [0, 0, 0], 'compound', plan)).toEqual({
      draws: 10_000,
      pExcess: 1 / 10_001,
      maxDrawdownVaR95: 0,
      maxDrawdownCVaR95: 0,
    })
    const result = bootstrapRisk([-0.01, -0.01, -0.01], [-0.01, -0.01, -0.01], 'compound', plan)
    expect(result.pExcess).toBe(1)
    expect(result.maxDrawdownVaR95).toBeCloseTo(1 - 0.99 ** 3, 12)
    expect(result.maxDrawdownCVaR95).toBeCloseTo(result.maxDrawdownVaR95, 12)
  })
})
