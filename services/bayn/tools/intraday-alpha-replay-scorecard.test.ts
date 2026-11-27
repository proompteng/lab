import { expect, test } from 'bun:test'

import { replayBootstrap, replayScorecard } from './intraday-alpha-replay-scorecard'

test('scorecard computes chronologically ordered folds, leg profit factor, drawdown and ex-top-five', () => {
  const nets = [[9, -1], [6], [-10], [4], [-4], [2], [3], [-2]]
  const score = replayScorecard(
    nets.map((legs, index) => ({
      date: `2026-11-0${index + 1}`,
      trades: legs.map((netPnlUsd) => ({ netPnlUsd })),
    })),
    100,
  )
  expect(score.netPnlUsd).toBe(7)
  expect(score.maxDrawdownUsd).toBe(10)
  expect(score.maxDrawdownRatio).toBeCloseTo(10 / 114, 10)
  expect(score.calmar).toBeCloseTo((1.07 ** (252 / 8) - 1) / (10 / 114), 10)
  expect(score.profitFactor).toBeCloseTo(24 / 17, 10)
  expect(score.exTopFiveDaysNetPnlUsd).toBe(-16)
  expect(score.chronologicalFolds.map(({ start, end, sessions }) => [start, end, sessions])).toEqual([
    ['2026-11-01', '2026-11-03', 3],
    ['2026-11-04', '2026-11-06', 3],
    ['2026-11-07', '2026-11-08', 2],
  ])
})

test('circular block test is seeded, centered, one-sided, and requires at least five sessions', () => {
  expect(replayBootstrap([1, 1, 1, 1]).pValue).toBeNull()
  expect(replayBootstrap(Array(6).fill(0)).pValue).toBe(1)
  expect(replayBootstrap(Array(6).fill(1)).pValue).toBe(1 / 10_001)
  const sample = [0, 1, 2, 2, 1, -1, -2, -1, -1, 1, 1, 0]
  const result = replayBootstrap(sample)
  expect(result).toEqual(replayBootstrap(sample))
  expect(result.blockLength).toBe(5)
  expect(result.trials).toBe(10_000)
  expect(result.pValue ?? -1).toBeGreaterThan(0)
  expect(result.pValue ?? -1).toBeLessThan(1)
})
