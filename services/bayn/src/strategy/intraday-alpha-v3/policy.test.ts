import { expect, test } from 'bun:test'
import { Result } from 'effect'

import { loadActiveStrategyProtocol } from '../../strategy'
import { intradayAlphaStrategyIdentity } from '../intraday-alpha/policy'
import {
  AlphaV3NoonExit,
  decodeIntradayAlphaV3Policy,
  defaultIntradayAlphaV3Policy,
  intradayAlphaV3PolicyHash,
  sipSymbols,
} from './index'

test('v3 binds the exact separate 46-stock, 2 ETF and benchmark universes and frozen defaults', () => {
  const policy = defaultIntradayAlphaV3Policy
  expect(policy.equitySymbols.join(' ')).toBe(
    'AAPL ALAB AMAT AMD AMZN ANET APP ARM ASML AVGO CEG COHR COIN CRDO CRWD GEV GOOGL HOOD INTC KLAC LITE LRCX META MRVL MSFT MSTR MU NET NFLX NOW NVDA ORCL PANW PLTR SHOP SMCI SNDK SNOW SOFI SPOT TSLA TSM UBER VRT VST WDC',
  )
  expect(policy.trendSymbols).toEqual(['QQQ', 'SMH'])
  expect(sipSymbols).toHaveLength(49)
  expect(new Set(sipSymbols).size).toBe(49)
  expect(policy.benchmarkSymbol).toBe('SPY')
  expect(policy.entryLimitSlippageBps).toBe(30)
  expect(policy.stopLimitSlippageBps).toBe(50)
  expect(policy.stopLimitAtrMultiplier).toBe(0.25)
  expect(policy.sharedGrossCapMicros).toBe('180000000000')
  expect(policy.reversion.minimumIqrBps).toBe(100)
  expect(Object.isFrozen(policy)).toBe(true)
  expect(Object.isFrozen(policy.equitySymbols)).toBe(true)
  expect(Object.isFrozen(policy.orb)).toBe(true)
})

test('strict policy decoding rejects any silent universe, data or signal drift', () => {
  const policy = defaultIntradayAlphaV3Policy
  for (const input of [
    { ...policy, equitySymbols: policy.equitySymbols.slice(1) },
    { ...policy, equitySymbols: [...policy.equitySymbols].reverse() },
    { ...policy, trendSymbols: ['QQQ', 'AAPL'] },
    { ...policy, benchmarkSymbol: 'QQQ' },
    { ...policy, feed: 'iex' },
    { ...policy, stopLimitSlippageBps: 10 },
    { ...policy, entryLimitSlippageBps: 24 },
    { ...policy, entryLimitSlippageBps: 36 },
    { ...policy, reversion: { ...policy.reversion, minimumIqrBps: 99 } },
    { ...policy, foo: 'bar' },
  ]) {
    expect(Result.isFailure(decodeIntradayAlphaV3Policy(input))).toBe(true)
  }
  for (const entryLimitSlippageBps of [25, 35]) {
    expect(Result.isSuccess(decodeIntradayAlphaV3Policy({ ...policy, entryLimitSlippageBps }))).toBe(true)
  }
})

test('canonical v3 hash is invariant to JSON key order and binds the configurable exit mode', () => {
  const policy = defaultIntradayAlphaV3Policy
  const hash = Result.getOrThrow(intradayAlphaV3PolicyHash(policy))
  expect(hash).toBe('8c980d8e70502261134c45f5919705171f61ce40990aa9e129a47e5a6a22f0a1')
  const reordered = Result.getOrThrow(decodeIntradayAlphaV3Policy(Object.fromEntries(Object.entries(policy).reverse())))
  expect(Result.getOrThrow(intradayAlphaV3PolicyHash(reordered))).toBe(hash)
  const bracket = Result.getOrThrow(
    decodeIntradayAlphaV3Policy({
      ...policy,
      reversion: { ...policy.reversion, exit: AlphaV3NoonExit.Bracket },
    }),
  )
  expect(Result.getOrThrow(intradayAlphaV3PolicyHash(bracket))).not.toBe(hash)
  expect(Object.isFrozen(bracket.reversion)).toBe(true)
})

test('the actual active strategy still loads the exact pre-Wave-4F v2 policy and protocol hashes', () => {
  const live = Result.getOrThrow(loadActiveStrategyProtocol())
  expect(live.schemaVersion).toBe('bayn.intraday-alpha-policy.v2')
  const { strategy, protocolHash } = Result.getOrThrow(intradayAlphaStrategyIdentity(live))
  expect(strategy.parameterHash).toBe('f632170473534577a59a98c800bca69917b710c3857a68d0c52ec776ebcdd509')
  expect(protocolHash).toBe('5863a919110021b7bf7f27872aafe0bed44092cf832f8d0e3a6fdb66fb73ff2d')
})
