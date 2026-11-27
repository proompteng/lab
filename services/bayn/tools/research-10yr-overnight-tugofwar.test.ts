import { describe, expect, test } from 'bun:test'
import { type Bar, parseTape, type Tape, type Universe } from './overnight-tugofwar-data'
import { costs, grid } from './overnight-tugofwar-protocol'
import { prepare, replay } from './overnight-tugofwar-replay'
import { holm, metrics, net, riskParity, stationaryP, stationaryPlan } from './overnight-tugofwar-statistics'

const defaultBar: Bar = { open: 100, close: 100, volume: 1000 }
const dates: string[] = []
for (let i = 0; dates.length < 80; i++) {
  const date = new Date(Date.UTC(2022, 0, 3 + i))
  if (date.getUTCDay() >= 1 && date.getUTCDay() <= 5) dates.push(date.toISOString().slice(0, 10))
}

function fixture(count: number, overrides: (symbol: string, day: number) => Bar | undefined): Tape {
  const equities = new Map([
    ['AAA', 'XLK'],
    ['BBB', 'XLK'],
  ])
  const etfs = ['HYG']
  const symbols = new Set([...equities.keys(), ...etfs])
  return {
    universe: { equities, etfs, symbols },
    dates: dates.slice(0, count),
    bars: new Map([...symbols].map((symbol) => [symbol, dates.slice(0, count).map((_, i) => overrides(symbol, i))])),
    rows: 0,
  }
}
const etf = { id: 'etf', family: 'etf', universe: 'all', session: 'overnight', filter: 'none' } as const
const persistence = {
  id: 'persist',
  family: 'persistence',
  signal: 'overnight',
  side: 'long',
  lookback: 20,
  scope: 'universe',
  refresh: 1,
} as const
const gap = { id: 'gap', family: 'gap', signal: 'fade', scope: 'universe', threshold: 1.5, timing: 'prior' } as const

describe('frozen Wave 4G tape', () => {
  test('registers only 180 cells including four cost rows for the frozen blend', () => {
    const catalog = grid()
    expect(new Set(catalog.map((c) => c.id)).size).toBe(44)
    expect((catalog.length + 1) * costs.length).toBe(180)
    expect(catalog.filter((c) => c.family === 'gap' && c.timing === 'same')).toHaveLength(8)
  })

  test('projects development before decoding Holdout values and rejects duplicate or missing evidence', () => {
    const universe: Universe = { equities: new Map(), etfs: ['SPY', 'SHY'], symbols: new Set(['SPY', 'SHY']) }
    const line = (symbol: string, date: string) => `${symbol}\t${date}T05:00:00Z\t100\t101\t99\t100\t10\t100`
    const development = [line('SPY', '2023-12-29'), line('SHY', '2023-12-29')].join('\n')
    const all = `${development}\nINVALID\t2024-01-02T05:00:00Z\tnot a price`
    expect(parseTape(all, universe, '2023-12-29').rows).toBe(2)
    expect(() => parseTape(all, universe, '2024-01-02')).toThrow('Unexpected bar identity')
    expect(() => parseTape(`${development}\n${development}`, universe, '2023-12-29')).toThrow('Duplicate bar')
    expect(() => parseTape(`${development}\n${line('SPY', '2023-12-28')}`, universe, '2023-12-29')).toThrow(
      'Incomplete benchmark: SHY',
    )
  })
})

describe('auction timing and fate of actual entries', () => {
  test('MOC targets do not see the order-day open or close; they use the prior completed factor', () => {
    const run = (orderDayOpen: number) =>
      replay(
        prepare(
          fixture(23, (symbol, i) => ({
            ...defaultBar,
            open:
              symbol === 'HYG'
                ? 100
                : i === 21
                  ? orderDayOpen
                  : i === 22 && symbol === 'AAA'
                    ? 110
                    : symbol === 'AAA'
                      ? 101
                      : 99,
          })),
        ),
        persistence,
      )[22]
    expect(run(10).pnl).toBe(10_000)
    expect(run(230).pnl).toBe(10_000)
    expect(run(10).matchedOvernightPnl).toBe(10_000)
    expect(run(10).oppositePnl).toBe(-10_000)
  })

  test('prior gap and same-auction diagnostic are different; shorts pay borrow and sell fee', () => {
    const market = prepare(
      fixture(26, (symbol, i) => ({
        ...defaultBar,
        open:
          symbol === 'HYG'
            ? 100
            : i === 23
              ? symbol === 'AAA'
                ? 90
                : 110
              : i === 24
                ? symbol === 'AAA'
                  ? 120
                  : 80
                : 100 + (i % 2 === 0 ? 0.1 : -0.1),
      })),
    )
    const prior = replay(market, gap)[24]
    const oracle = replay(market, { ...gap, timing: 'same' })[24]
    expect(prior.pnl).toBe(-20_000)
    expect(oracle.pnl).toBe(20_000)
    expect(prior.turnover).toBe(200_000)
    expect(prior.sell).toBe(90_000)
    expect(prior.borrow).toBeCloseTo((40_000 * 0.015) / 365)
    expect(net(prior, 2)).toBeCloseTo(-20_000 - 20 - 1.89 - prior.borrow)
    expect(net(prior, 20) - net(prior, 2)).toBeCloseTo(-180)
  })

  test('gap continuation requires aligned prior trend and volume known before the gap', () => {
    const run = (priorVolume: number, signalDayVolume: number) => {
      const market = prepare(
        fixture(62, (symbol, i) => {
          if (symbol === 'HYG') return defaultBar
          const direction = symbol === 'AAA' ? 1 : -1
          return {
            open: i === 59 ? 100 + 20 * direction : i === 60 ? 100 : 100 + (i % 2 === 0 ? 0.1 : -0.1),
            close: i === 58 ? 100 + 10 * direction : i === 60 ? 100 + 5 * direction : 100,
            volume: i === 58 ? priorVolume : i === 59 ? signalDayVolume : 1000,
          }
        }),
      )
      return replay(market, { ...gap, signal: 'continuation' })[60]
    }
    expect(run(3000, 1000)).toMatchObject({ trades: 2, pnl: 5000 })
    expect(run(1000, 5000)).toMatchObject({ trades: 0, pnl: 0 })
  })

  test('a Friday short accrues three calendar days of borrow on actual entry notional', () => {
    const market = prepare(
      fixture(30, (symbol, i) => ({
        ...defaultBar,
        open: symbol === 'HYG' ? 100 : symbol === 'AAA' ? 101 : 99,
        close: i === 24 && symbol === 'BBB' ? 90 : 100,
      })),
    )
    const monday = replay(market, { ...persistence, side: 'neutral' })[25]
    expect(monday.borrow).toBeCloseTo((45_000 * 0.015 * 3) / 365)
  })

  test('late listing requires consecutive completed observations; missing exits are never a zero-return fill', () => {
    const market = prepare(
      fixture(25, (symbol, i) => {
        if (symbol !== 'HYG') return defaultBar
        if (i < 2 || i === 23) return undefined
        return i === 24 ? { ...defaultBar, open: 110 } : defaultBar
      }),
    )
    const path = replay(market, etf)
    expect(path.slice(0, 22).every((day) => day.trades === 0)).toBe(true)
    expect(path[23]).toMatchObject({ trades: 0, carry: 1 })
    expect(path[24]).toMatchObject({ trades: 1, pnl: 10_000, lateExit: 1, carry: 0 })
  })

  test('an announced end flattens at the last close and no new overnight order is placed there', () => {
    const market = prepare(
      fixture(25, (symbol, i) => {
        if (symbol !== 'HYG') return defaultBar
        if (i > 21) return undefined
        return i === 21 ? { ...defaultBar, open: 101, close: 103 } : defaultBar
      }),
    )
    const known = { symbol: 'HYG', announced: dates[19], lastClose: dates[21] }
    const flow = replay(market, etf, undefined, [known])
    expect(flow[21]).toMatchObject({ announcedExit: 1, trades: 1, pnl: 3000, carry: 0 })
    expect(flow.slice(22).every((day) => day.trades === 0 && day.carry === 0)).toBe(true)
    expect(replay(market, etf)[24].carry).toBe(1)
    expect(() => replay(market, etf, undefined, [{ ...known, announced: dates[22] }])).toThrow('Non-causal')
  })
})

describe('statistics', () => {
  test('fixed bootstrap is one-sided, stationary and reproducible; Holm accounts for all trials', () => {
    const plan = stationaryPlan(30)
    let cursor = 0
    for (const limit of plan.limits) {
      let sampled = 0
      for (; cursor < limit; cursor += 2) sampled += plan.pairs[cursor + 1] - plan.pairs[cursor]
      expect(sampled).toBe(30)
    }
    expect(stationaryP(Array<number>(30).fill(1), plan)).toBe(1 / 10_001)
    expect(stationaryP(Array<number>(30).fill(-1), plan)).toBe(1)
    const values = Array.from({ length: 30 }, (_, i) => (i < 10 ? 2 : -1))
    expect(stationaryP(values, plan)).toBe(stationaryP(values, stationaryPlan(30)))
    expect(holm([0.07, 0.01, 0.04])).toEqual([0.08, 0.03, 0.08])
  })

  test('fixed-capital cash excess, drawdown and one-way turnover use the registered units', () => {
    const market = prepare(
      fixture(25, (_symbol, i) =>
        i === 21 ? { ...defaultBar, open: 110 } : i === 22 ? { ...defaultBar, open: 90 } : defaultBar,
      ),
    )
    const path = replay(market, etf)
    const bench = { spy: path.map((_, i) => (i === 22 ? -200 : 0)), shy: path.map(() => 1) }
    const m = metrics(path, bench, { from: 21, to: 23 }, 0)
    expect(m.netUsd).toBeCloseTo(-4.2)
    expect(m.excessUsd).toBeCloseTo(-6.2)
    expect(m.maxDrawdownUsd).toBeCloseTo(10_001.89)
    expect(m.downSpyNetUsd).toBeCloseTo(-10_001.89)
    expect(m.oneWayDailyTurnover).toBeCloseTo(1)
  })

  test('uncorrelated legs contribute equally in risk, not equal dollars', () => {
    const weights = riskParity([
      [1, -1, 1, -1],
      [2, 2, -2, -2],
    ])
    expect(weights[0]).toBeCloseTo(2 / 3, 5)
    expect(weights[1]).toBeCloseTo(1 / 3, 5)
  })
})
