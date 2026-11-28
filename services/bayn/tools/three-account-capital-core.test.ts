import { describe, expect, test } from 'bun:test'

import { type Etf, universe } from '../src/strategy/macro-etf-core/policy'
import {
  assessPdtBuffer,
  type DailySession,
  IntradayMode,
  type IntradayLeg,
  type IntradaySession,
  IntradayVariant,
  ShareSizing,
  studyCapitalAllocation,
  tradeIntraday,
} from './three-account-capital-core'

const leg: IntradayLeg = { side: 1, weight: 0.5, entry: 100, reference: 110, exit: 120, missingHeld: 1 }

describe('intraday account', () => {
  test('uses the decision reference, floors whole shares, and pays both sides plus the sell fee', () => {
    const session = { date: '2024-01-02', legs: [leg] }
    const whole = tradeIntraday(session, 1_000, IntradayMode.UnleveredLongShort, ShareSizing.Whole, 10)
    const ideal = tradeIntraday(session, 1_000, IntradayMode.UnleveredLongShort, ShareSizing.Fractional, 10)
    const perShare = 120 * 0.999 * (1 - 0.000021) - 100 * 1.001
    expect(whole.pnl).toBeCloseTo(4 * perShare, 10)
    expect(ideal.pnl).toBeCloseTo((500 / 110) * perShare, 10)
    expect(whole).toMatchObject({ fills: 1, heldGaps: 1, withheldShorts: 0 })
    const cheaper = tradeIntraday(session, 1_000, IntradayMode.UnleveredLongShort, ShareSizing.Whole, 2)
    expect(cheaper.pnl).toBeGreaterThan(whole.pnl)
  })

  test('cash mode withholds shorts without reallocating their budgets', () => {
    const short: IntradayLeg = { ...leg, side: -1, reference: 100, exit: 80, missingHeld: 0 }
    const session = { date: '2024-01-02', legs: [leg, short] }
    const cash = tradeIntraday(session, 1_000, IntradayMode.SettledCashLongOnly, ShareSizing.Whole, 5)
    const signed = tradeIntraday(session, 1_000, IntradayMode.UnleveredLongShort, ShareSizing.Whole, 5)
    const longPnl = 4 * (120 * 0.9995 * (1 - 0.000021) - 100 * 1.0005)
    const shortPnl = 4 * (100 * 0.9995 * (1 - 0.000021) - 80 * 1.0005)
    expect(cash.pnl).toBeCloseTo(longPnl, 10)
    expect(cash).toMatchObject({ fills: 1, withheldShorts: 1 })
    expect(signed.pnl).toBeCloseTo(longPnl + shortPnl, 10)
    expect(signed).toMatchObject({ fills: 2, withheldShorts: 0 })
  })

  test('reserves for the worst entry cost at every tier and does not buy a partial whole share', () => {
    const session = { date: '2024-01-02', legs: [{ ...leg, reference: 90, weight: 1 }] }
    const whole = tradeIntraday(session, 100.05, IntradayMode.SettledCashLongOnly, ShareSizing.Whole, 2)
    const fractional = tradeIntraday(session, 100.05, IntradayMode.SettledCashLongOnly, ShareSizing.Fractional, 2)
    expect(whole).toEqual({ pnl: 0, fills: 0, withheldShorts: 0, heldGaps: 0 })
    expect(fractional.fills).toBe(1)
  })
})

const target = (weights: Partial<Record<Etf, number>>) => universe.map((symbol) => weights[symbol] ?? 0)

const day = (
  date: string,
  prices: readonly (readonly [Etf, number, number])[],
  f4?: DailySession['f4'],
  o1?: DailySession['o1'],
): DailySession => ({
  date,
  bars: new Map(prices.map(([symbol, open, close]) => [symbol, { open, close }])),
  f4,
  o1,
})

const tape = (
  daily: readonly DailySession[],
  b0: readonly IntradaySession[] = daily.map(({ date }) => ({ date, legs: [] })),
) => ({
  daily,
  intraday: { [IntradayVariant.B0]: b0, [IntradayVariant.Phase2]: b0 },
})

const smallestB0 = (result: ReturnType<typeof studyCapitalAllocation>) => {
  const row = result.scenarios.find(
    ({ tier, variant, oneWayBps }) => tier.totalUsd === 30_000 && variant === IntradayVariant.B0 && oneWayBps === 2,
  )
  if (row === undefined) throw new Error('Missing $30k B0 case')
  return row
}

describe('three isolated accounts', () => {
  test('marks prior holdings to the open, retains full QQQ targets, and honors the F4 deadband', () => {
    const daily = [
      day('2024-01-02', [['SHY', 100, 100]]),
      day(
        '2024-01-03',
        [
          ['SHY', 110, 110],
          ['QQQ', 200, 210],
        ],
        target({ QQQ: 1 }),
      ),
      day(
        '2024-01-04',
        [
          ['SHY', 115, 120],
          ['QQQ', 212, 220],
        ],
        target({ QQQ: 1 }),
      ),
    ]
    const result = studyCapitalAllocation(tape(daily))
    const { whole, fractional, rounding } = smallestB0(result)
    expect(result.scenarios).toHaveLength(24)
    expect([...new Set(result.scenarios.map(({ tier }) => tier.totalUsd))]).toEqual([30_000, 50_000, 100_000, 250_000])
    expect([...new Set(result.scenarios.map(({ oneWayBps }) => oneWayBps))]).toEqual([2, 5, 10])
    expect(result.window).toEqual({ from: '2024-01-02', through: '2024-01-04', sessions: 3, years: 3 / 365.2425 })
    expect(whole.accountMetrics.intraday.endingEquityUsd).toBe(10_000)
    // 99 SHY sold at 110; 54 QQQ bought at 200 and held through 220.
    expect(whole.accountMetrics.f4.endingEquityUsd).toBeCloseTo(12_063.453355, 6)
    expect(whole.accountMetrics.o1.endingEquityUsd).toBeCloseTo(11_978.02, 6)
    expect(whole.combined.endingEquityUsd).toBeCloseTo(34_041.473355, 6)
    expect(whole.combined.cagr).toBeCloseTo((34_041.473355 / 30_000) ** (365.2425 / 3) - 1, 6)
    expect(whole.combined.maxDrawdown).toBeCloseTo(3.96 / 30_000, 10)
    const returns = [29_996.04 / 30_000 - 1, 32_511.473355 / 29_996.04 - 1, 34_041.473355 / 32_511.473355 - 1]
    const average = (returns[0] + returns[1] + returns[2]) / 3
    const vol = Math.hypot(returns[0] - average, returns[1] - average, returns[2] - average) * Math.sqrt(126)
    expect(whole.combined.annualizedVolatility).toBeCloseTo(vol, 10)
    expect(whole.combined.sharpe).toBeCloseTo((average * 252) / vol, 10)
    expect(whole.combined.sortino).toBeCloseTo((average * Math.sqrt(252 * 3)) / -returns[0], 8)
    expect(whole.combined.calmar).toBeCloseTo(whole.combined.cagr / whole.combined.maxDrawdown, 8)
    expect(whole.pdt.thresholdAppliesInLegacyScenario).toBe(false)
    expect(rounding.combined.trackingErrorBps).toBeGreaterThan(0)
    expect(rounding.intraday).toEqual({ cagrDeltaBps: 0, endingEquityDeltaUsd: 0, trackingErrorBps: 0 })
    expect(rounding.f4.endingEquityDeltaUsd).toBeCloseTo(
      whole.accountMetrics.f4.endingEquityUsd - fractional.accountMetrics.f4.endingEquityUsd,
      8,
    )
    const { order, matrix } = whole.correlation
    expect(order).toEqual(['intraday', 'f4', 'o1'])
    expect(matrix[0]).toEqual([null, null, null])
    expect(matrix[1][0]).toBeNull()
    expect(matrix[1][1]).toBeCloseTo(1, 10)
    expect(matrix[2][2]).toBeCloseTo(1, 10)
    expect(matrix[1][2]).toBeCloseTo(matrix[2][1] ?? NaN, 10)
  })

  test('O1 reviews individual weights against prior-close strategy holdings, not its SHY sweep', () => {
    const prior = target({ SPY: 0.5, QQQ: 0.01 })
    const next = target({ SPY: 0.53, QQQ: 0.25 })
    const daily = [
      day('2024-01-02', [['SHY', 100, 100]]),
      day(
        '2024-01-03',
        [
          ['SHY', 100, 100],
          ['SPY', 100, 100],
        ],
        undefined,
        prior,
      ),
      day(
        '2024-01-04',
        [
          ['SHY', 100, 100],
          ['SPY', 200, 220],
          ['QQQ', 100, 110],
        ],
        undefined,
        next,
      ),
    ]
    // 49 SPY gets retained (less than 5 pp drift at the previous close); 37 QQQ bought on day 3.
    const { whole } = smallestB0(studyCapitalAllocation(tape(daily)))
    expect(whole.accountMetrics.o1.endingEquityUsd).toBeCloseTo(16_244.399435, 6)
  })

  test('rejects missing held marks, mismatched session dates, and duplicate sessions', () => {
    const daily = [day('2024-01-02', [['SHY', 100, 100]]), day('2024-01-03', [])]
    expect(() => studyCapitalAllocation(tape(daily))).toThrow('Missing or invalid close price: SHY 2024-01-03')
    expect(() =>
      studyCapitalAllocation(
        tape(daily, [
          { date: '2024-01-02', legs: [] },
          { date: '2024-01-04', legs: [] },
        ]),
      ),
    ).toThrow('Session alignment mismatch')
    expect(() => studyCapitalAllocation(tape([daily[0], daily[0]]))).toThrow('Duplicate or out-of-order')
  })
})

describe('legacy PDT drawdown stress', () => {
  test('requires strictly more than the floor even if the path rose before its worst drawdown', () => {
    const buffer = assessPdtBuffer(50_000, [80_000, 40_000, 45_000], 0.5)
    expect(buffer).toEqual({
      legacyFloorUsd: 25_000,
      minimumStartingEquityUsd: 50_000.01,
      stressedEquityUsd: 25_000,
      clearsDrawdownStress: false,
      lowestHistoricalEquityUsd: 40_000,
      sessionsAtOrBelowFloor: 0,
    })
    expect(assessPdtBuffer(50_000.01, [80_000, 40_000], 0.5).clearsDrawdownStress).toBe(true)
  })

  test('counts equality as a breach and includes initial equity in the observed low', () => {
    const buffer = assessPdtBuffer(24_000, [25_000, 26_000], 0)
    expect(buffer.minimumStartingEquityUsd).toBe(25_000.01)
    expect(buffer.sessionsAtOrBelowFloor).toBe(1)
    expect(buffer.lowestHistoricalEquityUsd).toBe(24_000)
  })
})
