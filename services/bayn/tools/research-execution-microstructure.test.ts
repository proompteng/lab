import { expect, test } from 'bun:test'
import { NodeServices } from '@effect/platform-node'
import { Effect, Result } from 'effect'

import {
  intradayAlphaStrategyIdentity,
  IntradayAlphaPhase,
  IntradayAlphaSetup,
} from '../src/strategy/intraday-alpha/policy'
import type { SelectedAlphaLeg } from '../src/strategy/intraday-alpha/signals'
import { TargetPlanReason, TargetPlanStatus } from '../src/target-planner'
import {
  phaseDeadline,
  planCohortLegs,
  policy,
  scanExecutionCohort,
  type CohortLeg,
} from './execution-microstructure-cohort'
import { asReplayBar, splitAdjustedBar } from './execution-microstructure-data'
import { entryLimit, followExit, probeTimedClose, stopLimit } from './execution-microstructure-model'
import { decodeRegularCalendar, type Bar } from './midday-research-data'
import { probeEntry, runExecutionMicrostructureCommand } from './research-execution-microstructure'
import { buildReplaySnapshot, makeShortEligibility } from './verify-intraday-alpha-replay'

const bar = (open: number, high = open, low = open, close = open): Bar => ({
  open,
  high,
  low,
  close,
  vwap: close,
  volume: 500,
})

const legFixture: CohortLeg = {
  date: '2026-11-25',
  symbol: 'AAPL',
  phase: IntradayAlphaPhase.MorningOrb,
  direction: 1,
  completedMinute: 30,
  nextMinute: 31,
  postDecisionMinute: 32,
  sessionMinutes: 390,
  bars: new Map([
    [31, asReplayBar('AAPL', Date.parse('2026-11-25T14:30:00Z'), 31, bar(100.12))],
    [32, asReplayBar('AAPL', Date.parse('2026-11-25T14:30:00Z'), 32, bar(99.9))],
  ]),
  close: 100,
  limit: 100.1,
  shares: 100,
  atr14: 2.5,
  stop: 98,
  target: 104,
  dueMinute: () => 91,
}

test('the adjacent open identifies a favorable chase miss; the executable clock is separate', () => {
  expect(probeEntry(legFixture, 31, 10, 5)?.fills).toBe(false)
  expect(probeEntry(legFixture, 31, 10, 5)?.driftBps).toBeCloseTo(12)
  expect(probeEntry(legFixture, 31, 15, 5)?.fills).toBe(true)
  expect(probeEntry(legFixture, 31, 'atr14', 5)?.fills).toBe(true)
  expect(probeEntry(legFixture, 32, 10, 5)?.fills).toBe(true)
  expect(probeEntry(legFixture, 33, 10, 5)).toBeNull()
  expect(probeEntry({ ...legFixture, atr14: null }, 31, 'atr14', 2)).toBeNull()
  expect(probeEntry({ ...legFixture, direction: -1, limit: 99.9 }, 31, 10, 5)?.fills).toBe(true)
  expect(probeEntry({ ...legFixture, direction: -1, limit: 99.9 }, 32, 10, 5)?.fills).toBe(false)
})

test('collars and buffers retain inward broker ticks for both sides', () => {
  expect(entryLimit('AAPL', 1, 100, 10)).toBe(100.1)
  expect(entryLimit('AAPL', -1, 100, 10)).toBe(99.9)
  expect(entryLimit('AAPL', 1, 100, 15.5)).toBe(100.15)
  expect(entryLimit('AAPL', -1, 100, 15.5)).toBe(99.85)
  expect(stopLimit('AAPL', 1, 100, 25.5)).toBe(99.75)
  expect(stopLimit('AAPL', -1, 100, 25.5)).toBe(100.25)
})

const exitTerms = {
  entryMinute: 31,
  dueMinute: 35,
  sessionMinutes: 38,
  stop: 100,
  stopLimit: 99.9,
  target: 104,
  direction: 1 as const,
  roundTripBps: 5,
}

test('a raw stop-price recovery is not executable when the stressed sell price is still below limit', () => {
  const bars = new Map([
    [31, bar(99.8, 99.91, 99.7, 99.8)],
    [33, bar(99, 99.5, 98, 99.2)],
    [34, bar(99.95)],
  ])
  const result = followExit({ ...exitTerms, bars })
  expect(result.triggeredMinute).toBe(31)
  expect(result.blockedMinutes).toBe(2)
  expect(result.missingWorkingMinutes).toBe(1)
  expect(result.worstBlockedPrice).toBeCloseTo(97.9755)
  expect(result.exit?.reason).toBe('stop')
  expect(result.exit?.minute).toBe(34)
  expect(result.exit?.price).toBeCloseTo(99.9250125)
  const wider = followExit({ ...exitTerms, bars, stopLimit: 99.75 })
  expect(wider.exit?.minute).toBe(31)
  expect(wider.blockedMinutes).toBe(0)
})

test('a wider buffer does not charge an artificial fill at the new limit after a marketable trigger', () => {
  const bars = new Map([[31, bar(100.5, 101, 99.95, 100.01)]])
  const baseline = followExit({ ...exitTerms, bars })
  const wider = followExit({ ...exitTerms, bars, stopLimit: 99.5 })
  expect(baseline.exit?.price).toBeCloseTo(99.9250125)
  expect(wider.exit).toEqual(baseline.exit)
})

test('short stop gaps are symmetric and a later target cannot erase an already active stop', () => {
  const result = followExit({
    ...exitTerms,
    direction: -1,
    stopLimit: 100.1,
    target: 95,
    bars: new Map([
      [31, bar(100.5, 101, 100.09, 100.2)],
      [33, bar(93)],
    ]),
  })
  expect(result.triggeredMinute).toBe(31)
  expect(result.blockedMinutes).toBe(1)
  expect(result.exit?.minute).toBe(33)
  expect(result.exit?.reason).toBe('stop')
})

test('after an intrabar activation the pre-trigger favorable high does not prove a sell', () => {
  const result = followExit({
    ...exitTerms,
    bars: new Map([
      [31, bar(101, 105, 97, 98)],
      [36, bar(97)],
    ]),
  })
  expect(result.ambiguousTriggers).toBe(1)
  expect(result.blockedMinutes).toBe(1)
  expect(result.exit?.reason).toBe('timed')
  expect(result.exit?.minute).toBe(36)
  expect(followExit({ ...exitTerms, bars: new Map([[31, bar(101, 105, 97, 98)]]) }).exit).toBeNull()
  const marketableAtOpen = followExit({ ...exitTerms, bars: new Map([[31, bar(105, 106, 97, 98)]]) })
  expect(marketableAtOpen.exit?.reason).toBe('target')
  expect(marketableAtOpen.triggeredMinute).toBeNull()
})

test('timed limits treat missing or out-of-session executable marks as unknown, not a clamped fill', () => {
  expect(phaseDeadline(IntradayAlphaPhase.MorningOrb, 390)).toBe(118)
  expect(phaseDeadline(IntradayAlphaPhase.MiddayReversion, 210)).toBe(205)
  expect(phaseDeadline(IntradayAlphaPhase.NoiseAreaTrend, 210)).toBe(208)
  const input = {
    bars: new Map([
      [207, bar(100)],
      [209, bar(99)],
      [210, bar(100)],
    ]),
    dueMinute: 208,
    sessionMinutes: 210,
    direction: 1 as const,
    roundTripBps: 5,
    limitBps: 10,
  }
  expect(probeTimedClose({ ...input, delayMinutes: 1 })?.clears).toBe(false)
  expect(probeTimedClose({ ...input, delayMinutes: 2 })).toBeNull()
  expect(probeTimedClose({ ...input, bars: new Map(), delayMinutes: 1 })).toBeNull()
})

test('frozen historical NVDA split adjusts price and volume once before June 10 only', () => {
  const unadjusted = asReplayBar('NVDA', Date.parse('2024-06-07T13:30:00Z'), 0, bar(1200, 1210, 1190, 1205))
  expect(splitAdjustedBar('NVDA', '2024-06-07', unadjusted)).toMatchObject({
    open: 120,
    high: 121,
    low: 119,
    close: 120.5,
    volume: 5_000,
    vwap: 120.5,
  })
  expect(splitAdjustedBar('NVDA', '2024-06-10', unadjusted)).toBe(unadjusted)
  expect(splitAdjustedBar('AAPL', '2024-06-07', unadjusted)).toBe(unadjusted)
})

test('real funded sizing and planner keep four legs or block the whole basket at the collateral cliff', () => {
  const date = '2026-11-25'
  const sessionOpenMs = Date.parse(`${date}T14:30:00Z`)
  const calendar = decodeRegularCalendar({
    query: { start: date, end: date },
    response: [{ date, open: '09:30', close: '16:00' }],
  })
  const completedMinute = 120
  const legs = ['AAPL', 'AMZN', 'NVDA', 'WDC'].map(
    (symbol, index): SelectedAlphaLeg => ({
      symbol,
      phase: IntradayAlphaPhase.MiddayReversion,
      setup: index < 2 ? IntradayAlphaSetup.MiddayVwapReversionLong : IntradayAlphaSetup.MiddayVwapReversionShort,
      direction: index < 2 ? 'LONG' : 'SHORT',
      targetWeight: 0.18,
      protectiveStopBps: 500,
      profitTargetBps: 800,
      maximumHoldingMinutes: 200,
      scoreBps: 50,
      relVwapDevBps: index < 2 ? -50 : 50,
    }),
  )
  const symMap = new Map(
    legs.map(({ symbol }, i) => [symbol, [asReplayBar(symbol, sessionOpenMs, completedMinute, bar(100 + i * 17))]]),
  )
  const snapshot = buildReplaySnapshot({
    sessionDate: date,
    calendar,
    sessionOpenMs,
    symMap,
    quoteModel: { slippageRtBps: 2 },
    rangeEndMs: sessionOpenMs + (completedMinute + 1) * 60_000,
  })
  const input = {
    date,
    legs,
    completedMinute,
    snapshot,
    equityUsd: 100_000,
    eligibility: makeShortEligibility(snapshot.manifest.observedAt),
    bars: new Map([...symMap].map(([symbol, bars]) => [symbol, new Map(bars.map((row) => [completedMinute, row]))])),
  }
  const funded = planCohortLegs({ ...input, buyingPowerUsd: 100_000 })
  expect(funded.planned?.status).toBe(TargetPlanStatus.Planned)
  expect(funded.balanced).toBe(true)
  expect(funded.planned?.intentTargets).toHaveLength(4)
  const blocked = planCohortLegs({ ...input, buyingPowerUsd: 80_000 })
  expect(blocked.fundedSymbols).toHaveLength(4)
  expect(blocked.planned?.reason).toBe(TargetPlanReason.InsufficientBuyingPower)
  expect(blocked.planned?.intentTargets).toHaveLength(0)
})

test('the compiled v2 protocol matches the retained PAPER activation and still uses 10 bp', () => {
  expect(policy.entryLimitSlippageBps).toBe(10)
  expect(Result.getOrThrow(intradayAlphaStrategyIdentity(policy)).protocolHash).toBe(
    '5863a919110021b7bf7f27872aafe0bed44092cf832f8d0e3a6fdb66fb73ff2d',
  )
})

test('an already taken Noise leg does not shadow a Midday signal on the overlapping final checkpoint', () => {
  const date = '2026-11-24'
  const history = ['2026-11-17', '2026-11-18', '2026-11-19', '2026-11-20', '2026-11-23', date]
  const calendar = decodeRegularCalendar({
    query: { start: history[0], end: date },
    response: history.map((day) => ({ date: day, open: '09:30', close: '16:00' })),
  })
  const byDate = new Map(
    history.map((day) => [
      day,
      new Map(
        ['SPY', 'AAPL', 'QQQ'].map((symbol) => [
          symbol,
          Array.from({ length: 390 }, (_, minute) => {
            const price =
              day === date && symbol === 'QQQ' && minute >= 30
                ? 102
                : day === date && symbol === 'AAPL' && minute >= 150
                  ? 97
                  : day !== date && symbol === 'QQQ' && minute > 0
                    ? 100.1
                    : 100
            return asReplayBar(symbol, Date.parse(`${day}T14:30:00Z`), minute, bar(price, price + 0.2, price - 0.2))
          }),
        ]),
      ),
    ]),
  )
  const diagnosticAtOverlap: string[] = []
  const { cohort } = scanExecutionCohort({
    byDate,
    calendar,
    dates: [date],
    onCheckpoint: (checkpoint) => {
      if (checkpoint.completedMinute === 150) diagnosticAtOverlap.push(...checkpoint.legs.map(({ symbol }) => symbol))
    },
  })
  expect(diagnosticAtOverlap).toEqual(['QQQ'])
  expect(cohort.map(({ symbol, phase, completedMinute }) => [symbol, phase, completedMinute])).toEqual([
    ['QQQ', IntradayAlphaPhase.NoiseAreaTrend, 30],
    ['AAPL', IntradayAlphaPhase.MiddayReversion, 150],
  ])
})

test('the command reports an input error before publishing evidence', async () => {
  const result = await Effect.runPromise(
    runExecutionMicrostructureCommand(['/dev/null', '/dev/null']).pipe(
      // @effect-diagnostics-next-line strictEffectProvide:off -- this test owns the command's filesystem
      Effect.provide(NodeServices.layer),
      Effect.result,
    ),
  )
  expect(Result.isFailure(result)).toBe(true)
  if (Result.isFailure(result))
    expect(result.failure).toMatchObject({
      _tag: 'ExecutionMicrostructureError',
      message: 'Cannot load frozen live inputs',
    })
})
