import { expect, test } from 'bun:test'

import {
  calmar,
  deflatedSharpe,
  expectedMaximumSharpe,
  exTopExcess,
  maxDrawdown,
  pairedSharpeDiff,
  sharpe,
  sortino,
  stationaryBootstrap,
  stationaryMeanP,
  StationarySampling,
} from './statistics'

test('annualizes sample Sharpe and downside RMS while retaining fixed and compound drawdowns', () => {
  const returns = [0.2, -0.1, 0.05]
  expect(sharpe(returns)).toBeCloseTo((0.05 * Math.sqrt(252)) / 0.15, 12)
  expect(sortino(returns)).toBeCloseTo((0.05 * Math.sqrt(252)) / Math.sqrt(0.01 / 3), 12)
  expect(maxDrawdown(returns, true)).toBeCloseTo(0.1, 12)
  expect(maxDrawdown(returns, false)).toBeCloseTo(0.1 / 1.2, 12)
  expect(calmar(0.15, 0.1)).toBeCloseTo(1.5, 12)
  expect(calmar(0.15, 0)).toBeNull()
  expect(calmar(null, 0.1)).toBeNull()
  expect(sharpe([])).toBeNull()
  expect(sharpe([0.1, 0.1, 0.1])).toBeNull()
  expect(sortino([0.1, 0])).toBeNull()
})

test('Ex-Top-10 removes matched dates and resolves equally good returns chronologically', () => {
  const net = [...Array<number>(11).fill(0.1), -0.03]
  const benchmark = [0.15, ...Array<number>(9).fill(0), 0.02, 0.01]
  expect(exTopExcess(net, benchmark, false, [10])[0]).toBeCloseTo(0.04, 12)
  expect(exTopExcess(net, benchmark, true, [10])[0]).toBeCloseTo(1.1 * 0.97 - 1.02 * 1.01, 12)
  expect(exTopExcess([-0.1, -0.2], [0, 0], false, [10])[0]).toBeCloseTo(-0.3, 12)
  expect(() => exTopExcess(net, [], true, [10])).toThrow('same session count')
})

test('paired Sharpe difference is not the Sharpe of the excess path', () => {
  const net = [0.2, -0.1, 0.05]
  const benchmark = [0.02, -0.08, 0.03]
  expect(pairedSharpeDiff(net, benchmark)).toBeCloseTo((0.05 / 0.15 + 0.01 / Math.sqrt(0.0037)) * Math.sqrt(252), 12)
  expect(pairedSharpeDiff(net, [0, 0, 0])).toBeNull()
  expect(() => pairedSharpeDiff(net, [0])).toThrow('same session count')
})

test('Deflated Sharpe matches the retained nonannualized CDF convention', () => {
  expect(expectedMaximumSharpe([0.1, 0.2, -0.15, 0.16], 17)).toBeCloseTo(0.28725889910159275, 12)
  const net = [0.01, -0.02, 0.03, -0.01, 0.02, 0, 0.05, -0.02]
  const base = deflatedSharpe(net, 0)
  const deflated = deflatedSharpe(net, 0.15)
  expect(base).not.toBeNull()
  expect(deflated).not.toBeNull()
  expect(deflated ?? Infinity).toBeLessThan(base ?? -Infinity)
  expect(deflatedSharpe(net, null)).toBeNull()
  expect(deflatedSharpe([0.01, 0.01], 0)).toBeNull()
  expect(expectedMaximumSharpe([0.1])).toBeNull()
})

test('stationary plans preserve complete draws, circular wrap and the centered null', () => {
  const protocol = { draws: 64, meanBlock: 3, seed: 0x5c2016 }
  for (const sampling of [StationarySampling.LeftTail, StationarySampling.RightTailMidpoint]) {
    const plan = stationaryBootstrap(5, protocol, sampling)
    expect(stationaryBootstrap(5, protocol, sampling)).toEqual(plan)
    const outcomes = []
    const values = [3, 0, -1, 2, 1]
    const center = 1
    let wrapped = false
    for (let draw = 0; draw < plan.draws; draw++) {
      const sample = []
      for (let i = plan.offsets[draw]; i < plan.offsets[draw + 1]; i += 2) {
        const start = plan.blocks[i]
        const end = plan.blocks[i + 1]
        expect(start).toBeLessThan(values.length)
        expect(end).toBeGreaterThan(start)
        if (end > values.length) wrapped = true
        for (let j = start; j < end; j++) sample.push(values[j % values.length] - center)
      }
      expect(sample).toHaveLength(values.length)
      outcomes.push(sample.reduce((total, value) => total + value, 0))
    }
    expect(wrapped).toBe(true)
    expect(stationaryMeanP(values, plan)).toBe((outcomes.filter((value) => value >= 5).length + 1) / 65)
    expect(stationaryMeanP([0, 0, 0, 0, 0], plan)).toBeNull()
    expect(() => stationaryMeanP([0], plan)).toThrow('length mismatch')
  }
  expect(() => stationaryBootstrap(0, protocol)).toThrow('Invalid stationary bootstrap')
  expect(() => stationaryBootstrap(5, { ...protocol, seed: 0 })).toThrow('Invalid stationary bootstrap')
})
