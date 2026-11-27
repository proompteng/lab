import { describe, expect, test } from 'bun:test'
import { Result } from 'effect'

import { loadActiveStrategyProtocol } from '../../strategy'
import { intradayAlphaStrategyIdentity } from '../intraday-alpha/policy'
import { currentEquityUniverse } from '../intraday-market'
import {
  decodeEtfNoiseAreaPolicy,
  defaultEtfNoiseAreaPolicy,
  etfNoiseAreaPolicyHash,
  expandedEtfNoiseAreaPolicy,
} from './policy'

describe('ETF Noise Area policy identity', () => {
  test('pins the immutable default policy and hashes by content, not key order', () => {
    const policy = Result.getOrThrow(decodeEtfNoiseAreaPolicy(defaultEtfNoiseAreaPolicy))
    const reordered = Result.getOrThrow(
      decodeEtfNoiseAreaPolicy(Object.fromEntries(Object.entries(defaultEtfNoiseAreaPolicy).reverse())),
    )
    const hash = Result.getOrThrow(etfNoiseAreaPolicyHash(policy))
    expect(hash).toBe('4ab558b581a8788f97df40a8c30df13e8199c49cc7efbb33b29508d74085847e')
    expect(Result.getOrThrow(etfNoiseAreaPolicyHash(reordered))).toBe(hash)
    expect(Object.isFrozen(policy)).toBe(true)
    expect(Object.isFrozen(policy.symbols)).toBe(true)
    expect(Object.isFrozen(defaultEtfNoiseAreaPolicy)).toBe(true)
    expect(Object.isFrozen(defaultEtfNoiseAreaPolicy.symbols)).toBe(true)
  })

  test('supports two exact cohorts and hashes expanded symbols and alternate sizing separately', () => {
    const expanded = Result.getOrThrow(decodeEtfNoiseAreaPolicy(expandedEtfNoiseAreaPolicy))
    const inverse = Result.getOrThrow(
      decodeEtfNoiseAreaPolicy({ ...defaultEtfNoiseAreaPolicy, sizing: 'inverseVolatility' }),
    )
    expect(expanded.symbols).toEqual(['SPY', 'QQQ', 'IWM', 'SMH', 'TLT', 'GLD'])
    expect(
      new Set(
        [defaultEtfNoiseAreaPolicy, expanded, inverse].map((policy) =>
          Result.getOrThrow(etfNoiseAreaPolicyHash(policy)),
        ),
      ).size,
    ).toBe(3)
  })

  test('rejects unsupported and noncanonical policies at the boundary', () => {
    for (const patch of [
      { symbols: ['SMH', 'QQQ'] },
      { symbols: ['QQQ', 'QQQ'] },
      { symbols: ['QQQ', 'SMH', 'SPY'] },
      { symbols: ['SPY', 'QQQ', 'IWM', 'SMH', 'TLT', 'GLD', 'DIA'] },
      { lookbackSessions: 13 },
      { checkpointMinutes: 60 },
      { bandMultiplier: 1 },
      { exitRule: 'insideBand' },
      { entryLimitSlippageBps: 26 },
      { maximumStopLimitCollarBps: 151 },
      { maximumGrossUsd: 180_001 },
      { sizing: 'custom' },
      { useExtendedClose: true },
    ]) {
      expect(Result.isFailure(decodeEtfNoiseAreaPolicy({ ...defaultEtfNoiseAreaPolicy, ...patch }))).toBe(true)
    }
  })

  test('fits the current 22-symbol source universe without changing the active v2 policy hash', () => {
    expect(defaultEtfNoiseAreaPolicy.symbols).toEqual(['QQQ', 'SMH'])
    expect(currentEquityUniverse.symbols).toHaveLength(22)
    expect(defaultEtfNoiseAreaPolicy.symbols.every((symbol) => currentEquityUniverse.symbols.includes(symbol))).toBe(
      true,
    )
    const live = Result.getOrThrow(loadActiveStrategyProtocol())
    expect(Result.getOrThrow(intradayAlphaStrategyIdentity(live)).strategy.parameterHash).toBe(
      'f632170473534577a59a98c800bca69917b710c3857a68d0c52ec776ebcdd509',
    )
  })
})
