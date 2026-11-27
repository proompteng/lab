import { describe, expect, test } from 'bun:test'
import { nominate, parseArgs } from './research-3yr-crypto-24x7-trend'
import { parseBars, type Coin, type Market } from './research-crypto-trend-data'
import { blockP, economics, economicGates, plateau, summarize } from './research-crypto-trend-metrics'
import {
  dailyPair,
  dayMs,
  fees,
  neighbors,
  registry,
  symbols,
  venues,
  windows,
  type Trial,
} from './research-crypto-trend-protocol'
import { prepareMarket, simulate, type Day } from './research-crypto-trend-simulation'

const bar = (symbol: string, time: string, close = 100) =>
  `${symbol}\t${time}T00:00:00Z\t100\t110\t99\t${close}\t0\t101`
const market = (prices: readonly (readonly [number, number])[]): Market => {
  const column = (values: readonly (readonly [number, number])[]): Coin => ({
    open: Float64Array.from(values, ([open]) => open),
    close: Float64Array.from(values, ([, close]) => close),
    high: Float64Array.from(values, ([open, close]) => Math.max(open, close)),
    low: Float64Array.from(values, ([open, close]) => Math.min(open, close)),
  })
  return {
    start: Date.parse('2022-01-01'),
    count: prices.length,
    barsPerDay: 1,
    excludedEndRows: 0,
    coins: new Map(symbols.map((name) => [name, column(name === 'BTC/USD' ? prices : prices.map(() => [0, 0]))])),
  }
}
const dateAt = (i: number) => new Date(Date.parse('2022-01-01') + i * dayMs).toISOString().slice(0, 10)

describe('frozen Alpaca research inputs', () => {
  test('does not decode holdout prices during development and rejects them when scoring', () => {
    const rows = [bar('BTC/USD', '2025-08-31'), bar('BTC/USD', '2025-09-01', 111)].join('\n')
    const dev = parseBars(rows, '1d', venues['1d'].holdout, 2)
    expect(dev.coins.get('BTC/USD')?.close.at(-1)).toBe(100)
    expect(() => parseBars(rows, '1d', '2025-09-02', 2)).toThrow('Invalid or duplicate')
  })

  test('rejects duplicate, misaligned, unknown and incomplete bars', () => {
    const valid = bar('BTC/USD', '2022-01-01')
    const parse = (rows: string, count: number) => parseBars(rows, '1d', '2022-01-02', count)
    expect(() => parse(`${valid}\n${valid}`, 2)).toThrow('duplicate')
    expect(() => parse(valid.replace('T00:', 'T01:'), 1)).toThrow('Invalid')
    expect(() => parse(valid.replace('BTC/USD', 'GOLD/USD'), 1)).toThrow('Invalid')
    expect(() => parse(valid, 2)).toThrow('Expected 2')
  })

  test('counts but never scores the exclusive-end row from the immutable objects', () => {
    const rows = [bar('BTC/USD', '2026-11-26'), bar('BTC/USD', '2026-11-27', 999)].join('\n')
    const market = parseBars(rows, '1d', '2026-11-27', 2)
    expect(market.excludedEndRows).toBe(1)
    expect(market.coins.get('BTC/USD')?.close.at(-1)).toBe(100)
    expect(() => parseBars(rows.replace('2026-11-27T00', '2026-11-27T01'), '1d', '2026-11-27', 2)).toThrow('Invalid')
  })

  test('retains independent chronology and does not permit scoring without a stage', () => {
    expect(windows('1h')).toEqual({
      train: ['2024-01-01', '2025-07-01'],
      validation: ['2025-07-01', '2026-04-01'],
      holdout: ['2026-04-01', '2026-11-27'],
    })
    expect(windows('1d')).toEqual({
      train: ['2022-01-01', '2024-07-01'],
      validation: ['2024-07-01', '2025-09-01'],
      holdout: ['2025-09-01', '2026-11-27'],
    })
    expect(() => parseArgs(['--freeze', '--score'])).toThrow('Usage')
    expect(parseArgs(['--score', '--output', 'unseen.json'])).toEqual({ stage: 'score', output: 'unseen.json' })
  })
})

describe('24/7 self-financing portfolios', () => {
  test('cash funds both taker and maker fees, never spends missing basket slots', () => {
    const prepared = prepareMarket(
      market([
        [100, 100],
        [120, 120],
      ]),
    )
    const btc = simulate(prepared, 'btc', [dateAt(0), dateAt(2)])
    const basket = simulate(prepared, 'equal', [dateAt(0), dateAt(2)])
    for (const bp of fees) {
      const fee = bp / 20_000
      const expected = ((120 / 100) * (1 - fee)) / (1 + fee) - 1
      expect(economics(btc[bp]).net).toBeCloseTo(expected, 12)
      expect(economics(basket[bp]).net).toBeCloseTo(expected / symbols.length, 12)
      expect(economics(btc[bp]).annualFeeDrag).toBeCloseTo(economics(btc[bp]).annualTurnover * fee, 12)
    }
  })

  test('a missing terminal bar cannot liquidate at a stale price', () => {
    const prepared = prepareMarket(
      market([
        [100, 100],
        [0, 0],
        [150, 150],
      ]),
    )
    const incomplete = economics(simulate(prepared, 'btc', [dateAt(0), dateAt(2)])[50])
    expect(incomplete.staleBars).toBe(1)
    expect(incomplete.unsettled).toBe(1)
    expect(incomplete.net).toBeCloseTo(1 / 1.0025 - 1, 12)
    const recovered = economics(simulate(prepared, 'btc', [dateAt(0), dateAt(3)])[50])
    expect(recovered.unsettled).toBe(0)
    expect(recovered.net).toBeCloseTo((1.5 * 0.9975) / 1.0025 - 1, 12)
  })

  test('a prior completed trend buys the next open, not the signal close or a missing next open', () => {
    const trial: Trial = {
      id: 'test',
      frame: '1d',
      universe: 'full',
      axes: [],
      rule: { kind: 'ema', fast: 24, slow: 48, target: 0.25 },
    }
    const rising = Array.from({ length: 25 }, (_, i): [number, number] => [100 + i, 101 + i])
    const prefix = simulate(prepareMarket(market([...rising, [200, 250]])), trial, [dateAt(25), dateAt(26)])[50]
    const sameOpen = simulate(prepareMarket(market([...rising, [200, 200]])), trial, [dateAt(25), dateAt(26)])[50]
    expect(prefix[0].net).toBeGreaterThan(0)
    expect(sameOpen[0].net).toBeLessThan(0) // Fees, not the preceding close-to-open gap.
    const missing = simulate(prepareMarket(market([...rising, [0, 0], [250, 300]])), trial, [
      dateAt(25),
      dateAt(27),
    ])[50]
    expect(missing.map(({ net }) => net)).toEqual([0, 0])
  })

  test('a channel liquidated after a missing bar requires a fresh breakout after warmup', () => {
    const trial: Trial = {
      id: 'gap-reset',
      frame: '1d',
      universe: 'full',
      axes: [],
      rule: { kind: 'channel', entry: 72, exit: 24, stop: null, target: 0.25 },
    }
    const prices: [number, number][] = Array.from({ length: 55 }, (_, i) => {
      if (i === 25) return [0, 0]
      if (i > 25) {
        const price = 110 - (i - 26) / 2
        return [price - 1, price]
      }
      const price = 100 + (i % 3)
      if (i === 23) return [price, 115]
      if (i === 24) return [115, 117]
      return [price, price]
    })
    const history = simulate(prepareMarket(market(prices)), trial, [dateAt(0), dateAt(prices.length)])[50]
    expect(history[24].turnover).toBeGreaterThan(0)
    expect(history[25].staleBars).toBe(1)
    expect(history[26].turnover).toBeGreaterThan(0)
    expect(history.slice(27).every(({ turnover }) => turnover === 0)).toBe(true)
  })
})

describe('pre-registered diagnostics', () => {
  const day = (net: number): Day => ({
    net,
    min: Math.min(1, 1 + net),
    max: Math.max(1, 1 + net),
    drawdown: Math.max(0, -net),
    turnover: 0.01,
    feeDrag: 0.000025,
    heldBars: 1,
    staleBars: 0,
    unsettled: 0,
  })

  test('compounds days, removes only the largest five and retains intraday drawdown', () => {
    const days = [day(0.1), ...Array.from({ length: 5 }, () => day(0.02)), day(-0.02)]
    days[0] = { ...days[0], min: 0.8, drawdown: 0.2 }
    const m = economics(days)
    expect(m.net).toBeCloseTo(1.1 * 1.02 ** 5 * 0.98 - 1, 12)
    expect(m.exTop5Net).toBeCloseTo(1.02 * 0.98 - 1, 12)
    expect(m.maxDrawdown).toBeCloseTo(0.2, 12)
  })

  test('resamples centered contiguous blocks deterministically and never treats all-cash as significant', () => {
    const positive = Array.from({ length: 62 }, (_, i) => 0.003 + Math.sin(i) * 0.001)
    expect(blockP(positive)).toBe(1 / 10_001)
    expect(blockP(positive.map((r) => -r))).toBe(1)
    expect(blockP(Array.from({ length: 62 }, () => 0))).toBeNull()
  })

  test('plateau requires neighbors to clear net, outlier and drawdown gates, not just high Sharpe', () => {
    const days = Array.from({ length: 30 }, (_, i) => day(i % 3 === 0 ? -0.001 : 0.003))
    const candidate = summarize(days, { ...economics(days), maxDrawdown: 0.4 }, 0)
    expect(Object.values(economicGates(candidate)).every(Boolean)).toBe(true)
    expect(plateau(candidate, [{ id: 'a', metrics: candidate }]).pass).toBe(false)
    expect(
      plateau(candidate, [
        { id: 'a', metrics: candidate },
        { id: 'b', metrics: { ...candidate, exTop5Net: -0.01 } },
        { id: 'c', metrics: { ...candidate, maxDrawdownVsBtc: 0.5 } },
      ]),
    ).toEqual({ tested: ['a', 'b', 'c'], stable: ['a'], pass: false })
  })

  test('registry neighbors stay on their grid; hourly eligibility requires a daily full-cycle companion', () => {
    const trials = registry()
    expect(trials).toHaveLength(280)
    expect(new Set(trials.map(({ id }) => id)).size).toBe(trials.length)
    const trial = trials[0]
    const pair = dailyPair(trial, trials)
    if (pair === undefined) throw new Error('Expected paired daily trial')
    expect(pair.rule).toEqual(trial.rule)
    expect(
      neighbors(trial, trials).every(({ frame, rule }) => frame === trial.frame && rule.kind === trial.rule.kind),
    ).toBe(true)
    const m = summarize(
      Array.from({ length: 30 }, (_, i) => day(i % 3 === 0 ? -0.001 : 0.003)),
      {
        ...economics([day(-0.3)]),
        maxDrawdown: 0.4,
      },
      0,
    )
    const stats = { 50: m, 30: m, 20: m }
    const checks = { economics: economicGates(m), plateau: { tested: ['a', 'b'], stable: ['a', 'b'], pass: true } }
    const row = (trial: Trial) => ({
      trial,
      metrics: { train: stats, validation: stats },
      checks: { train: checks, validation: checks },
    })
    expect(nominate([row(trial)])['1h/channel'].nominee).toBeNull()
    expect(nominate([row(trial), row(pair)])['1h/channel'].nominee).toBe(trial.id)
  })
})
