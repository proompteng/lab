import { expect, test } from 'bun:test'
import { Result } from 'effect'

import { evidence, fixture } from '../macro-etf-core/fixtures.test-support'
import {
  drawdownState,
  ewmaCovariance,
  macroRiskRules,
  MacroRiskMode,
  MacroRiskState,
  portfolioVolatility,
} from './risk'
import { compileMacroPortfolioV2, prepareMacroPortfolioV2, sizeMacroPortfolioV2 } from './targets'

const cash = { mode: MacroRiskMode.Cash, targetVolatility: 0.1 }
const gross = (weights: readonly number[]) => weights.reduce((a, b) => a + b, 0)

test('EWMA includes simultaneous positive and negative covariance and emphasizes the latest shock', () => {
  const same = ewmaCovariance([{ f4: 0.01, o1: 0.01 }])
  const offset = ewmaCovariance([{ f4: 0.01, o1: -0.01 }])
  const fractions = { f4: 0.5, o1: 0.5 }
  expect(portfolioVolatility(same, fractions)).toBeCloseTo(0.01 * Math.sqrt(252), 12)
  expect(portfolioVolatility(offset, fractions)).toBe(0)
  const spike = { f4: 0.04, o1: 0.02 }
  const flat = { f4: 0, o1: 0 }
  expect(ewmaCovariance([flat, spike]).cross).toBeCloseTo((252 * 0.04 * 0.02) / (1 + macroRiskRules.decay), 12)
  expect(ewmaCovariance([flat, spike]).f4).toBeGreaterThan(ewmaCovariance([spike, flat]).f4)
})

test('drawdown thresholds are inclusive and never lose a micro at the boundary', () => {
  expect(drawdownState(9_501n, 10_000n)).toBe(MacroRiskState.Normal)
  expect(drawdownState(9_500n, 10_000n)).toBe(MacroRiskState.Brake)
  expect(drawdownState(9_001n, 10_000n)).toBe(MacroRiskState.Brake)
  expect(drawdownState(9_000n, 10_000n)).toBe(MacroRiskState.Halt)
})

test('the common portfolio forecast is bounded, and braking halves both capped target vectors', () => {
  const source = fixture()
  const market = evidence(source)
  const pairedClose = { signalDate: source.calendar.at(-2)?.date, f4EquityMicros: 35_000n, o1EquityMicros: 22_000n }
  const normal = Result.getOrThrow(compileMacroPortfolioV2(cash, market, { ...pairedClose, highWaterMicros: 57_000n }))
  const brake = Result.getOrThrow(compileMacroPortfolioV2(cash, market, { ...pairedClose, highWaterMicros: 60_000n }))
  expect(normal.f4.riskState).toBe(MacroRiskState.Normal)
  expect(brake.o1.riskState).toBe(MacroRiskState.Brake)
  expect(brake.f4.weights).toEqual(normal.f4.weights.map((w) => w / 2))
  expect(brake.o1.weights).toEqual(normal.o1.weights.map((w) => w / 2))
  expect(gross(normal.f4.weights)).toBeLessThanOrEqual(1 + 1e-12)
  expect(gross(normal.o1.weights)).toBeLessThanOrEqual(1 + 1e-12)
  expect(normal.forecastVolatility).toBeLessThanOrEqual(cash.targetVolatility + 1e-12)
  expect(brake.forecastVolatility).toBe(normal.forecastVolatility / 2)
  const stop = Result.getOrThrow(compileMacroPortfolioV2(cash, market, { ...pairedClose, highWaterMicros: 65_000n }))
  expect(stop.f4.riskState).toBe(MacroRiskState.Halt)
  expect(gross(stop.f4.weights)).toBe(0)
  expect(gross(stop.o1.weights)).toBe(0)
})

test('rejects stale or inconsistent equity, missed openings and out-of-band risk settings', () => {
  const source = fixture()
  const market = evidence(source)
  const pairedClose = {
    signalDate: source.calendar.at(-2)?.date,
    f4EquityMicros: 35_000n,
    o1EquityMicros: 25_000n,
    highWaterMicros: 60_000n,
  }
  expect(Result.isFailure(compileMacroPortfolioV2(cash, market, { ...pairedClose, signalDate: '2016-01-04' }))).toBe(
    true,
  )
  expect(Result.isFailure(compileMacroPortfolioV2(cash, market, { ...pairedClose, highWaterMicros: 59_999n }))).toBe(
    true,
  )
  expect(Result.isFailure(compileMacroPortfolioV2(cash, { ...market, asOf: market.asOf + 1 }, pairedClose))).toBe(true)
  for (const volatility of [0.079, 0.121, NaN])
    expect(Result.isFailure(prepareMacroPortfolioV2({ ...cash, targetVolatility: volatility }, market))).toBe(true)
})

test('a matched close prefix produces the same sized target as the corresponding full-path observation', () => {
  const long = Result.getOrThrow(prepareMacroPortfolioV2(cash, evidence(fixture(230))))
  const prefix = fixture(170)
  const decision = long.basis.find(({ schedule }) => schedule.signalDate === prefix.calendar.at(-2)?.date)
  if (decision === undefined) throw new Error('Expected a shared execution session')
  const close = {
    signalDate: decision.schedule.signalDate,
    f4EquityMicros: 40_000n,
    o1EquityMicros: 21_000n,
    highWaterMicros: 63_000n,
  }
  const walk = Result.getOrThrow(sizeMacroPortfolioV2(long, decision, close))
  const { snapshotHash, ...latest } = Result.getOrThrow(compileMacroPortfolioV2(cash, evidence(prefix), close))
  expect(snapshotHash).toBe(evidence(prefix).snapshotHash)
  expect(latest).toEqual(walk)
})
