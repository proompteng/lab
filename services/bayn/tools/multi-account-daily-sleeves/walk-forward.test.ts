import { expect, test } from 'bun:test'
import { Result } from 'effect'

import { fixture, preset } from '../../src/strategy/macro-etf-core/fixtures.test-support'
import { Profile } from '../../src/strategy/macro-etf-core/policy'
import { replayMacroEtfCoreSignals } from '../../src/strategy/macro-etf-core/signals'
import { MacroRiskMode, MacroRiskState } from '../../src/strategy/macro-portfolio/risk'
import { closeEvidence, type DailyFrame } from '../research/macro-etf-core-dual-horizon-data'
import { wave5dTargets } from '../research/macro-etf-core-wave5d'
import { costSweep, prepareV2WalkForward, replayV2, targetVolatility } from './walk-forward'

const sessions = (length: number): DailyFrame[] => {
  const { bars, calendar } = fixture(length)
  return bars.map((rows, i) => {
    const marks = new Map(rows.map(({ symbol, open, high, low, close }) => [symbol, { open, high, low, close }]))
    // The signal fixture includes a deliberate post-warmup XLRE outage. The
    // frozen replay expects complete held marks once allocation starts.
    if (i === 158) marks.set('XLRE', { open: 75, high: 76, low: 74, close: 75 })
    return { ...calendar[i], bars: marks }
  })
}

test('runs frozen F4/O1 and both v2 modes deterministically on matched opens at 2, 5 and 10 bp', () => {
  const frames = sessions(340)
  const f4 = new Map(
    Result.getOrThrow(replayMacroEtfCoreSignals(preset(Profile.F4), closeEvidence(frames))).map((target) => [
      target.executionDate,
      target.weights,
    ]),
  )
  const o1 = wave5dTargets(frames)
  const baseline = frames.map(({ date, bars }, i) => ({ date, bars, f4: f4.get(date), o1: o1[i - 1] }))
  const sweep = costSweep(frames, baseline, 127)
  const results = sweep.scenarios
  expect(sweep).toEqual(costSweep(frames, baseline, 127))
  expect(sweep.policyHashes.cash.o1PolicyHash).not.toBe(sweep.policyHashes.margin.o1PolicyHash)
  expect(results.map(({ bps }) => bps)).toEqual([2, 5, 10])
  for (const { baseline, cash, margin } of results) {
    expect(cash.sessions).toBe(baseline.sessions)
    expect(cash.first).toBe(baseline.first)
    expect(cash.last).toBe(baseline.last)
    expect(cash.maxOpeningGross ?? Infinity).toBeLessThanOrEqual(1)
    expect(margin.maxOpeningGross ?? Infinity).toBeLessThanOrEqual(1.5)
    expect(margin.maxOpeningGross ?? 0).toBeGreaterThan(1)
    for (const row of [baseline, cash, margin]) {
      expect(row.oneWayTurnover).toBeGreaterThan(0)
      expect(row.correlation).not.toBeNull()
      expect(row.sharpe).not.toBeNull()
      expect(row.sortino).not.toBeNull()
    }
  }
  expect(results[2].baseline.cagr).toBeLessThan(results[0].baseline.cagr)
  expect(results[2].cash.cagr).not.toBe(results[0].cash.cagr)
  expect(() => costSweep(frames, baseline.slice(1), 127)).toThrow('Session count mismatch')
})

test('a future loss cannot affect an earlier fill; only the following open sees the drawdown', () => {
  const frames = sessions(210)
  const crashIndex = 170
  const stressed = frames.map((day, i) => {
    if (i < crashIndex) return day
    return {
      ...day,
      bars: new Map(
        [...day.bars].map(([symbol, bar]) => {
          if (symbol === 'SHY') return [symbol, bar]
          const open = i === crashIndex ? bar.open : bar.open * 0.55
          const close = bar.close * 0.55
          return [symbol, { open, close, high: Math.max(open, close) + 1, low: Math.min(open, close) - 1 }]
        }),
      ),
    }
  })
  const risk = { mode: MacroRiskMode.Cash, targetVolatility }
  const normal = replayV2(frames, prepareV2WalkForward(frames, risk), 10)
  const shock = replayV2(stressed, prepareV2WalkForward(stressed, risk), 10)
  expect(shock.slice(0, crashIndex)).toEqual(normal.slice(0, crashIndex))
  expect(shock[crashIndex].riskState).toBe(normal[crashIndex].riskState)
  expect(shock[crashIndex].tradedUsd).toBe(normal[crashIndex].tradedUsd)
  expect(shock[crashIndex + 1].riskState).toBe(MacroRiskState.Halt)
  expect(shock[crashIndex + 1].openingGross).toBe(0)
  expect(shock[crashIndex + 2].tradedUsd).toBe(0)
})
