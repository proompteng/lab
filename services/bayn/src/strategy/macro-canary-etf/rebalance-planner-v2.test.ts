import { expect, test } from 'bun:test'
import { Result } from 'effect'

import { asset, emptyWeights } from '../macro-etf-core/policy'
import { MacroRiskMode, MacroRiskState } from '../macro-portfolio/risk'
import { canaryPolicyV2, decodeMacroCanaryEtfPolicyV2, defaultMacroCanaryEtfPolicy } from './policy'
import { planMacroCanaryEtfRebalanceV2 } from './rebalance-planner'

test('O1 v2 holds per-name drift under five points and rejects foreign positive weights', () => {
  const policy = { schemaVersion: canaryPolicyV2, risk: { mode: MacroRiskMode.Cash, targetVolatility: 0.1 } }
  const { policyHash } = Result.getOrThrow(decodeMacroCanaryEtfPolicyV2(policy))
  const signalCloseAt = Date.parse('2020-05-01T20:00:00Z')
  const executionOpenAt = Date.parse('2020-05-04T13:30:00Z')
  const weights = emptyWeights()
  weights[asset.GLD] = 0.2475
  const target = {
    signalDate: '2020-05-01',
    executionDate: '2020-05-04',
    riskState: MacroRiskState.Normal,
    signalCloseAt,
    executionOpenAt,
    policyHash,
    priorEquityMicros: 10_000_000_000n,
    weights,
  }
  const book = {
    asOf: executionOpenAt,
    priorEquityMicros: 10_000_000_000n,
    cashMicros: 8_000_000_000n,
    settledCashMicros: 8_000_000_000n,
    grossCapMicros: 10_000_000_000n,
    debitCapMicros: 0n,
    oneWayBps: 10,
    positions: [{ symbol: 'GLD', shares: 20n }],
    marks: [
      {
        symbol: 'GLD',
        openAt: executionOpenAt,
        availableAt: executionOpenAt,
        priorCloseAt: signalCloseAt,
        priorCloseMicros: 100_000_000n,
        openMicros: 80_000_000n,
        marginable: true,
      },
    ],
    protectedSymbols: [],
  }
  expect(Result.getOrThrow(planMacroCanaryEtfRebalanceV2(policy, target, book))).toMatchObject({
    deadband: true,
    orders: [],
  })
  weights[asset.GLD] = 0.26
  expect(Result.getOrThrow(planMacroCanaryEtfRebalanceV2(policy, target, book)).orders[0]).toMatchObject({
    symbol: 'GLD',
    side: 'buy',
  })
  weights[asset.GLD] = 0
  expect(
    Result.getOrThrow(
      planMacroCanaryEtfRebalanceV2(policy, target, { ...book, positions: [{ symbol: 'GLD', shares: 2n }] }),
    ).orders[0],
  ).toMatchObject({ symbol: 'GLD', side: 'sell', shares: 2n })
  expect(
    Result.isFailure(
      planMacroCanaryEtfRebalanceV2(policy, { ...target, policyHash: defaultMacroCanaryEtfPolicy.policyHash }, book),
    ),
  ).toBe(true)
  weights[asset.XLF] = 0.1
  expect(Result.isFailure(planMacroCanaryEtfRebalanceV2(policy, target, book))).toBe(true)
})
