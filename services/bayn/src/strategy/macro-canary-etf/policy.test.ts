import { expect, test } from 'bun:test'
import { Result } from 'effect'

import { canonicalHashV1Result } from '../../hash'
import { loadActiveStrategyProtocol } from '../../strategy'
import { decodeMacroCanaryEtfPolicy, defaultMacroCanaryEtfPolicy } from './policy'

const { policy, policyHash } = defaultMacroCanaryEtfPolicy

test('binds the exact Wave 5D universe, risk budgets, and separate execution deadband in an immutable receipt', () => {
  expect(policy.universe.join(' ')).toBe(
    'SPY QQQ IWM DIA XLK XLF XLE XLV XLI XLP XLU XLY XLB XLC XLRE TLT IEF SHY HYG LQD GLD SLV DBC USO UUP EFA EEM',
  )
  expect(policy.ensemble.relativeRiskBudgets).toEqual([1, 1, 1])
  expect(policy.ensemble.researchDriftBps).toBe(500)
  expect(policy.execution.minDriftBps).toBe(1000)
  expect(Object.isFrozen(policy)).toBe(true)
  expect(Object.isFrozen(policy.macro.regimeBaskets.Stagflation)).toBe(true)
  expect(Object.isFrozen(policy.trend.book)).toBe(true)
  expect(() => Object.assign(policy.execution, { maxEtfWeight: 1 })).toThrow(TypeError)
  const reordered = Object.fromEntries(Object.entries(policy).reverse())
  expect(Result.getOrThrow(decodeMacroCanaryEtfPolicy(reordered)).policyHash).toBe(policyHash)
  expect(policyHash).toBe('4da4e8fae0e1b3ba74ddff7f79f0f8197f9247a7fccbd6bb5fd9bb695d99f2b0')
})

test('rejects unreviewed equations, symbols, roles, extraneous keys and inconsistent exposure caps', () => {
  for (const invalid of [
    { ...policy, universe: [...policy.universe].reverse() },
    { ...policy, canaryAssets: ['EEM', 'LQD', 'IEF', 'TLT'] },
    { ...policy, cashProxy: 'IEF' },
    { ...policy, historyStartSession: '2026-02-30' },
    { ...policy, features: { ...policy.features, horizons: [21, 63, 126] } },
    { ...policy, macro: { ...policy.macro, lookback: 126 } },
    { ...policy, execution: { ...policy.execution, maxGrossLeverage: 1.001 } },
    { ...policy, execution: { ...policy.execution, maxGrossLeverage: 0.4 } },
    { ...policy, trend: { ...policy.trend, book: { kind: 'signed', maxShortGrossWeight: 0 } } },
    { ...policy, trend: { ...policy.trend, book: { kind: 'longOnly', maxShortGrossWeight: 0.2 } } },
    { ...policy, extra: true },
  ])
    expect(Result.isFailure(decodeMacroCanaryEtfPolicy(invalid))).toBe(true)
  const signed = Result.getOrThrow(
    decodeMacroCanaryEtfPolicy({
      ...policy,
      trend: { ...policy.trend, book: { kind: 'signed', maxShortGrossWeight: 0.15 } },
    }),
  )
  expect(signed.policyHash).not.toEqual(policyHash)
})

test('leaves the active intraday v2 parameter hash at its origin/main value', () => {
  const active = Result.getOrThrow(loadActiveStrategyProtocol())
  expect(active.schemaVersion).toBe('bayn.intraday-alpha-policy.v2')
  expect(Result.getOrThrow(canonicalHashV1Result(active))).toBe(
    'f632170473534577a59a98c800bca69917b710c3857a68d0c52ec776ebcdd509',
  )
})
