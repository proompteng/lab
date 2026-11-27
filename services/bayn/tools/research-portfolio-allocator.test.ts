import { expect, test } from 'bun:test'

import { IntradayAlphaPhase, IntradayAlphaSetup } from '../src/strategy/intraday-alpha/constants'
import { trailingSleeveRisk } from '../src/strategy/intraday-alpha/portfolio-allocator'
import type { SelectedAlphaLeg } from '../src/strategy/intraday-alpha/signals'
import { nvdaSplitAdjusted, type Decision, type Opportunity, type PortfolioSession } from './portfolio-research-data'
import { replayPortfolioDay, type PortfolioDay, trialGrid } from './portfolio-research-replay'
import { bootstrapPortfolio, commonSessions, economics } from './portfolio-research-statistics'
import { selectOnPrior } from './research-portfolio-allocator'
import type { RawBar } from './verify-intraday-alpha-replay'

const risk = trailingSleeveRisk([], '2026-11-02', 3)
const staticArm = { name: 'v2-static' }
const orb = IntradayAlphaPhase.MorningOrb
const midday = IntradayAlphaPhase.MiddayReversion
const noise = IntradayAlphaPhase.NoiseAreaTrend

const leg = (
  symbol: string,
  phase: SelectedAlphaLeg['phase'],
  direction: SelectedAlphaLeg['direction'] = 'LONG',
): SelectedAlphaLeg => ({
  symbol,
  phase,
  direction,
  setup:
    phase === orb
      ? IntradayAlphaSetup.Orb30Long
      : phase === noise
        ? IntradayAlphaSetup.NoiseAreaLong
        : direction === 'LONG'
          ? IntradayAlphaSetup.MiddayVwapReversionLong
          : IntradayAlphaSetup.MiddayVwapReversionShort,
  targetWeight: 0.3,
  protectiveStopBps: 500,
  profitTargetBps: 800,
  maximumHoldingMinutes: 60,
  scoreBps: 100,
  relVwapDevBps: 100,
})

const bar = (
  symbol: string,
  open: number,
  close = open,
  low = Math.min(open, close),
  high = Math.max(open, close),
): RawBar => ({
  symbol,
  eventMs: 0,
  eventAt: '2026-11-02T14:30:00.000Z',
  open,
  high,
  low,
  close,
  volume: 100,
  vwap: open,
})

const tape = (symbol: string, start: number, end: number, overrides: readonly (readonly [number, RawBar])[] = []) =>
  new Map([...Array.from({ length: end - start + 1 }, (_, i) => [start + i, bar(symbol, 100)] as const), ...overrides])

const opportunity = (phase: Opportunity['phase'], legs: readonly SelectedAlphaLeg[]): Opportunity => ({
  phase,
  legs,
  dispersion: 20,
  trailingDispersion: 10,
})

type FixtureDecision = Omit<Decision, 'observedMsFromOpen'>

const session = (
  bars: PortfolioSession['bars'],
  decisions: ReadonlyMap<number, FixtureDecision>,
): PortfolioSession => ({
  date: '2026-11-02',
  minutes: 390,
  bars,
  decisions: new Map(
    [...decisions].map(([minute, decision]) => [
      minute,
      { ...decision, observedMsFromOpen: (minute + 1) * 60_000 + 2_000 },
    ]),
  ),
  baselineAvailable: true,
  noiseSymbolCount: 2,
  spyReturn: 0.01,
  highVol: true,
})

test('only a post-observation open can fill; symmetric cost shocks, sell-side fee, and whole shares are reproducible', () => {
  const data = session(
    new Map([
      [
        'AAPL',
        tape('AAPL', 31, 94, [
          [32, bar('AAPL', 99)],
          [94, bar('AAPL', 104)],
        ]),
      ],
    ]),
    new Map([[31, { equity: opportunity(orb, [leg('AAPL', orb)]), noise: undefined, missingBenchmark: false }]]),
  )
  const nets = ([2, 5, 10] as const).map((cost) => {
    const outcome = replayPortfolioDay(data, staticArm, cost, risk, [])
    const sold = 104 * (1 - cost / 20_000)
    expect(outcome.filled).toBe(1)
    expect(outcome.net).toBeCloseTo(299 * (sold - 100 * (1 + cost / 20_000) - (sold * 0.21) / 10_000))
    expect(outcome.peakReservedGross).toBeCloseTo(299 * 100.1)
    return outcome.net ?? 0
  })
  expect(nets[0]).toBeGreaterThan(nets[1] ?? 0)
  expect(nets[1]).toBeGreaterThan(nets[2] ?? 0)
  const missingOpen = session(
    new Map([
      [
        'AAPL',
        new Map([
          [31, bar('AAPL', 100)],
          [32, bar('AAPL', 100)],
          [34, bar('AAPL', 100)],
        ]),
      ],
    ]),
    data.decisions,
  )
  const unknown = replayPortfolioDay(missingOpen, staticArm, 5, risk, [])
  expect(unknown).toMatchObject({ filled: 0, missingEntryPrices: 1, net: null, sleeveNet: [null, null, null] })

  const rejected = session(
    new Map([
      [
        'AAPL',
        new Map([
          [31, bar('AAPL', 100)],
          [33, bar('AAPL', 101)],
        ]),
      ],
    ]),
    data.decisions,
  )
  expect(replayPortfolioDay(rejected, staticArm, 5, risk, [])).toMatchObject({
    filled: 0,
    missingEntryPrices: 0,
    net: 0,
  })
})

test('a later timed open cannot repair a missing held bar or support that trade’s P&L', () => {
  const interrupted = tape('AAPL', 31, 94, [[94, bar('AAPL', 104)]])
  interrupted.delete(44)
  const data = session(
    new Map([['AAPL', interrupted]]),
    new Map([[31, { equity: opportunity(orb, [leg('AAPL', orb)]), noise: undefined, missingBenchmark: false }]]),
  )
  expect(replayPortfolioDay(data, staticArm, 5, risk, [])).toMatchObject({
    filled: 1,
    unresolvedExits: 0,
    missingHeldBars: 1,
    closedNet: 0,
    net: null,
    sleeveNet: [null, null, null],
  })
})

test('the next delayed decision admits ORB using the expiring Noise order’s open, not its future close', () => {
  const decisions = new Map<number, FixtureDecision>([
    [30, { noise: opportunity(noise, [leg('QQQ', noise)]), equity: undefined, missingBenchmark: false }],
    [31, { equity: opportunity(orb, [leg('AAPL', orb)]), noise: undefined, missingBenchmark: false }],
  ])
  const outcomes = [100, 104].map((close) => {
    const data = session(
      new Map([
        ['QQQ', tape('QQQ', 30, 94, [[32, bar('QQQ', 100, close)]])],
        ['AAPL', tape('AAPL', 31, 94, [[94, bar('AAPL', 104)]])],
      ]),
      decisions,
    )
    return replayPortfolioDay(data, { name: 'overlap', grossCap: 45_000 }, 5, risk, [])
  })
  expect(outcomes[0]).toMatchObject({ orderLegs: 2, filled: 2, capConstrained: 1, peakReservedGross: 44_915 })
  expect(outcomes[1]?.peakReservedGross).toBe(outcomes[0]?.peakReservedGross)
  expect(outcomes[1]?.sleeveNet).toEqual(outcomes[0]?.sleeveNet)
})

test('an unresolved exit and a missing eligible benchmark are not zero-return days', () => {
  const data = session(
    new Map([
      [
        'AAPL',
        new Map([
          [31, bar('AAPL', 100)],
          [33, bar('AAPL', 100)],
        ]),
      ],
    ]),
    new Map([[31, { equity: opportunity(orb, [leg('AAPL', orb)]), noise: undefined, missingBenchmark: false }]]),
  )
  const missingExit = replayPortfolioDay(data, staticArm, 5, risk, [])
  expect(missingExit.unresolvedExits).toBe(1)
  expect(missingExit.net).toBeNull()
  const missingBenchmark = replayPortfolioDay(
    {
      ...data,
      decisions: new Map([
        [31, { equity: undefined, noise: undefined, missingBenchmark: true, observedMsFromOpen: 1_922_000 }],
      ]),
    },
    staticArm,
    5,
    risk,
    [],
  )
  expect(missingBenchmark.net).toBeNull()
  expect(missingBenchmark.missingBenchmarkChecks).toBe(1)
  expect(commonSessions([[missingExit], [missingBenchmark]])).toEqual(new Set())
})

test('dispersion sizes only Midday and concurrent admission reserves room for both sides', () => {
  const decisions = new Map<number, FixtureDecision>([
    [
      30,
      { equity: undefined, noise: opportunity(noise, [leg('QQQ', noise), leg('SMH', noise)]), missingBenchmark: false },
    ],
    [
      120,
      {
        equity: opportunity(midday, [leg('AAPL', midday), leg('NVDA', midday, 'SHORT')]),
        noise: undefined,
        missingBenchmark: false,
      },
    ],
  ])
  const tapes = ['QQQ', 'SMH', 'AAPL', 'NVDA'].map((symbol) => [symbol, tape(symbol, 30, 183)] as const)
  const unboundedHold = [...decisions].map(
    ([minute, decision]) =>
      [
        minute,
        decision.noise === undefined
          ? decision
          : {
              ...decision,
              noise: {
                ...decision.noise,
                legs: decision.noise.legs.map((order) => ({ ...order, maximumHoldingMinutes: 150 })),
              },
            },
      ] as const,
  )
  const data = session(new Map(tapes), new Map(unboundedHold))
  const constrained = replayPortfolioDay(data, { name: 'cap', grossCap: 100_000 }, 5, risk, [])
  expect(constrained.filled).toBe(4)
  expect(constrained.peakReservedGross).toBeLessThanOrEqual(100_000)
  expect(constrained.peakReservedGross).toBeGreaterThan(99_000)
  expect(constrained.capConstrained).toBe(1)
  const dispersed = replayPortfolioDay(data, { name: 'dispersion', dispersion: 1 }, 5, risk, [])
  expect(dispersed.peakReservedGross).toBeGreaterThan(130_000)
  expect(dispersed.peakReservedGross).toBeLessThanOrEqual(140_000)
})

test('the static control preserves the single-leg v2 Midday fallback', () => {
  const data = session(
    new Map([['AAPL', tape('AAPL', 120, 183, [[183, bar('AAPL', 102)]])]]),
    new Map([
      [
        120,
        {
          equity: opportunity(midday, [{ ...leg('AAPL', midday), targetWeight: 0.2 }]),
          noise: undefined,
          missingBenchmark: false,
        },
      ],
    ]),
  )
  const outcome = replayPortfolioDay(data, staticArm, 5, risk, [])
  expect(outcome.orderLegs).toBe(1)
  expect(outcome.filled).toBe(1)
  expect(outcome.peakReservedGross).toBeCloseTo(199 * 100.1)
  expect(outcome.net).toBeGreaterThan(0)
})

test('earlier loss can throttle an afternoon order; a later loss cannot', () => {
  const cases = [94, 123].map((lossMinute) => {
    const decisions = new Map<number, FixtureDecision>([
      [
        30,
        {
          equity: undefined,
          noise: opportunity(noise, [{ ...leg('QQQ', noise), maximumHoldingMinutes: 150 }]),
          missingBenchmark: false,
        },
      ],
      [
        120,
        {
          equity: opportunity(midday, [leg('AAPL', midday), leg('NVDA', midday, 'SHORT')]),
          noise: undefined,
          missingBenchmark: false,
        },
      ],
    ])
    return session(
      new Map([
        [
          'QQQ',
          tape(
            'QQQ',
            30,
            183,
            Array.from({ length: 184 - lossMinute }, (_, i) => [lossMinute + i, bar('QQQ', 94)] as const),
          ),
        ],
        ...['AAPL', 'NVDA'].map((symbol) => [symbol, tape(symbol, 120, 183)] as const),
      ]),
      decisions,
    )
  })
  const losses = cases.map((data) =>
    replayPortfolioDay(data, { name: 'loss', throttle: { lossDrawdown: 0.015 } }, 5, risk, []),
  )
  expect(losses.map((day) => day.throttleEntries)).toEqual([1, 0])
  expect(losses[0]?.peakReservedGross).toBeLessThan(losses[1]?.peakReservedGross ?? 0)
})

test('walk-forward choice ignores current/future results and rejects fragile train arms', () => {
  const path = (values: readonly number[]) =>
    values.map((net, i) => ({
      ...replayPortfolioDay(session(new Map(), new Map()), staticArm, 5, risk, []),
      date: `2026-11-${String(i + 1).padStart(2, '0')}`,
      net,
    }))
  const make = (name: string, values: readonly number[]) => {
    const days: PortfolioDay[] = path(values)
    return { trial: { name }, costs: { 2: days, 5: days, 10: days } }
  }
  const reliable = make('reliable', [1, 1, 1, 1, 1, 1, 1, 1, -1, -1e6])
  const fragile = make('fragile', [0, 0, 0, 0, 0, 0, 0, -1, 50, 1e6])
  expect(selectOnPrior([fragile, reliable], '2026-11-10')).toEqual({ name: 'reliable', trainingSessions: 9 })
  expect(selectOnPrior([fragile, reliable], '2026-11-04').name).toBe('v2-static')
})

test('split, tail removal, fixed-notional Calmar and seeded bootstrap are deterministic', () => {
  const before = bar('NVDA', 1000)
  expect(nvdaSplitAdjusted(before, '2024-06-07')).toMatchObject({ open: 100, vwap: 100, volume: 1000 })
  expect(nvdaSplitAdjusted(before, '2024-06-10')).toEqual(before)
  expect(nvdaSplitAdjusted(bar('AMZN', 100), '2024-06-07').open).toBe(100)
  const values = [200, -100, 300, -200, 400, 80, -50, 100, 20, 10]
  const result = economics(values)
  expect(result.exTop5Usd).toBe(-320)
  expect(result.exWorst5Usd).toBe(1080)
  expect(result.maxDrawdown).toBeCloseTo(200 / 100_400, 10)
  const boot = bootstrapPortfolio(values)
  expect(boot).toEqual(bootstrapPortfolio(values))
  expect(boot).toMatchObject({ trials: 10_000, blockSessions: 5 })
  expect(trialGrid.at(0)?.name).toBe('v2-static')
})
