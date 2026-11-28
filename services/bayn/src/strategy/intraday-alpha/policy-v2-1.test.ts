import { expect, test } from 'bun:test'
import { Result, Schema } from 'effect'

import { canonicalHashV1Result } from '../../hash'
import { decodeJevProtocol, defaultJevProtocolDocument } from '../../jev/protocol'
import { strictParseOptions } from '../../schemas'
import { makeIntradayAlphaFundedExitPlan } from './exit-plan'
import { evaluateMiddayResidualProtection } from './midday-residual-protection'
import {
  IntradayAlphaPhase,
  IntradayAlphaSetup,
  intradayAlphaStrategyIdentity,
  makeIntradayAlphaPolicy,
} from './policy'
import {
  IntradayAlphaPolicyV21Schema,
  intradayAlphaV21StopLimitPriceMicros,
  makeIntradayAlphaPolicyV21,
} from './policy-v2-1'
import { makeAlphaStreamingSnapshot, makeFlatAlphaPortfolio, makeTestTrailingBaseline } from './test-support'

const protocol = Result.getOrThrow(decodeJevProtocol(defaultJevProtocolDocument))
const v2 = makeIntradayAlphaPolicy(protocol)
const v21 = Result.getOrThrow(makeIntradayAlphaPolicyV21(protocol))
const hash = (material: unknown) => Result.getOrThrow(canonicalHashV1Result(material))

test('pins v2 and v2.1 hashes and inherits every non-execution field', () => {
  expect(hash(v2)).toBe('f632170473534577a59a98c800bca69917b710c3857a68d0c52ec776ebcdd509')
  expect(Result.getOrThrow(intradayAlphaStrategyIdentity(v2)).protocolHash).toBe(
    '5863a919110021b7bf7f27872aafe0bed44092cf832f8d0e3a6fdb66fb73ff2d',
  )
  expect(hash(v21)).toBe('5b3c0205f2ff3ba18bc70197fbc4b715fd8d1f721ea59114232bde95fde527bd')
  expect(hash(Result.getOrThrow(makeIntradayAlphaPolicyV21(protocol, 30)))).toBe(hash(v21))
  const { schemaVersion: _version, entryLimitSlippageBps, stopLimitCollar, partialBasketProtection, ...rest } = v21
  expect(entryLimitSlippageBps).toBe(30)
  expect(stopLimitCollar).toEqual({ minimumBps: 50, atr14Multiplier: 0.25, maximumBps: 150 })
  expect(partialBasketProtection).toBe('CANCEL_RECONCILE_TRIM')
  expect({ ...rest, schemaVersion: v2.schemaVersion, entryLimitSlippageBps: 10 }).toEqual(v2)
  expect(v21.candidateSymbols).toHaveLength(20)
  expect(Object.isFrozen(v21)).toBe(true)
  expect(Object.isFrozen(v21.sharedProtocol.executionModel.precision)).toBe(true)
  expect(Object.isFrozen(v21.candidateSymbols)).toBe(true)
})

test('validates the entire candidate contract and hashes entry collar overrides separately', () => {
  for (const bps of [25, 35])
    expect(hash(Result.getOrThrow(makeIntradayAlphaPolicyV21(protocol, bps)))).not.toBe(hash(v21))
  for (const bps of [24, 30.5, 36, NaN, Infinity])
    expect(Result.isFailure(makeIntradayAlphaPolicyV21(protocol, bps))).toBe(true)

  const decode = Schema.decodeUnknownResult(IntradayAlphaPolicyV21Schema, strictParseOptions)
  for (const input of [
    { ...v21, candidateSymbols: [...v21.candidateSymbols].reverse() },
    { ...v21, noiseArea: { ...v21.noiseArea, checkpointMinutesFromOpen: [31] } },
    { ...v21, maximumPositions: 5 },
    { ...v21, stopLimitCollar: { ...v21.stopLimitCollar, maximumBps: 151 } },
    { ...v21, unrelated: true },
  ])
    expect(Result.isFailure(decode(input))).toBe(true)
})

test('uses the adaptive stop collar without letting broker tick rounding exceed 150 bp', () => {
  const limit = (direction: 'LONG' | 'SHORT', stopPriceMicros: bigint, atr14Ratio: number) =>
    intradayAlphaV21StopLimitPriceMicros({
      collar: v21.stopLimitCollar,
      symbol: 'GOOGL',
      direction,
      stopPriceMicros,
      atr14Ratio,
    })

  // Reported Black Friday short: the $275.88 price was above the $275.58 v2 buy limit.
  const print = 275_880_000n
  const candidateBuyLimit = limit('SHORT', 275_310_000n, 0.01)
  expect(print > 275_580_000n).toBe(true)
  expect(candidateBuyLimit).toBe(276_690_000n)
  expect(print <= (candidateBuyLimit ?? 0n)).toBe(true)

  expect(limit('LONG', 100_000_000n, 0.01)).toBe(99_500_000n)
  expect(limit('LONG', 100_000_000n, 0.04)).toBe(99_000_000n)
  expect(limit('SHORT', 100_000_000n, 0.04)).toBe(101_000_000n)
  expect(limit('SHORT', 275_310_000n, 0.2)).toBe(279_430_000n)
  expect(limit('LONG', 275_310_000n, 0.2)).toBe(271_190_000n)
  expect(limit('SHORT', 1_000_000n, 0.01)).toBe(1_010_000n)
  for (const ratio of [NaN, Infinity, -0.01, 0, 0.51]) expect(limit('SHORT', 100_000_000n, ratio)).toBeNull()
})

test('funds long and short entries at 30 bp with a separate causal ATR stop limit', () => {
  const { snapshot, observedAt } = makeAlphaStreamingSnapshot({
    minutesFromOpen: 121,
    profiles: { AAPL: { basePrice: 100, endReturnBps: 0 }, GOOGL: { basePrice: 100, endReturnBps: 0 } },
  })
  const trailingBaseline = makeTestTrailingBaseline()
  const observation = {
    snapshot,
    observedAt,
    trailingBaseline,
    portfolio: makeFlatAlphaPortfolio(observedAt),
    contentHash: 'd'.repeat(64),
  }
  const material = {
    phase: IntradayAlphaPhase.MiddayReversion as const,
    targetWeight: 0.18,
    protectiveStopBps: 500,
    profitTargetBps: 800,
    maximumHoldingMinutes: 120,
    scoreBps: 50,
    relVwapDevBps: 50,
  }
  const long = {
    ...material,
    symbol: 'AAPL',
    direction: 'LONG' as const,
    setup: IntradayAlphaSetup.MiddayVwapReversionLong,
  }
  const short = {
    ...material,
    symbol: 'GOOGL',
    direction: 'SHORT' as const,
    setup: IntradayAlphaSetup.MiddayVwapReversionShort,
  }
  expect(
    Result.getOrThrow(makeIntradayAlphaFundedExitPlan({ policy: v21, observation, leg: long }))?.plan.levels,
  ).toMatchObject({
    maximumEntryPriceMicros: '100300000',
    stopPriceMicros: '95280000',
    stopLimitPriceMicros: '94320000',
    source: { policyHash: hash(v21) },
  })
  expect(
    Result.getOrThrow(makeIntradayAlphaFundedExitPlan({ policy: v21, observation, leg: short }))?.plan.levels,
  ).toMatchObject({
    minimumEntryPriceMicros: '99700000',
    stopPriceMicros: '104690000',
    stopLimitPriceMicros: '105740000',
    source: { policyHash: hash(v21) },
  })
  expect(
    Result.getOrThrow(makeIntradayAlphaFundedExitPlan({ policy: v2, observation, leg: long }))?.plan.levels,
  ).toMatchObject({ maximumEntryPriceMicros: '100100000', stopLimitPriceMicros: '95000000' })
  const { trailingBaseline: _baseline, ...unavailable } = observation
  expect(
    Result.getOrThrow(makeIntradayAlphaFundedExitPlan({ policy: v21, observation: unavailable, leg: long })),
  ).toBeNull()
  expect(
    Result.getOrThrow(
      makeIntradayAlphaFundedExitPlan({
        policy: v21,
        observation: {
          ...observation,
          trailingBaseline: { ...trailingBaseline, latestPriorSessionDate: trailingBaseline.sessionDate },
        },
        leg: short,
      }),
    ),
  ).toBeNull()
})

const basket = (mask: number) =>
  ['AAPL', 'AMZN', 'GOOGL', 'NVDA'].map((symbol, i) => {
    const filledShares = (mask & (1 << i)) === 0 ? 0n : 10n
    return {
      symbol,
      direction: i < 2 ? ('LONG' as const) : ('SHORT' as const),
      intendedShares: 10n,
      filledShares,
      openShares: filledShares,
      workingEntry: false,
      markPriceMicros: 100_000_000n,
    }
  })

test('resolves every 0/4 through 4/4 terminal fill permutation with exact, reduce-only residual math', () => {
  for (let mask = 0; mask < 16; mask++) {
    const legs = basket(mask)
    const long = legs.slice(0, 2).reduce((sum, leg) => sum + leg.openShares, 0n)
    const short = legs.slice(2).reduce((sum, leg) => sum + leg.openShares, 0n)
    const guard = Result.getOrThrow(evaluateMiddayResidualProtection(legs))
    expect(guard).toHaveProperty('exposure', {
      longNotionalMicros: long * 100_000_000n,
      shortNotionalMicros: short * 100_000_000n,
      signedNotionalMicros: (long - short) * 100_000_000n,
    })
    expect(Result.getOrThrow(evaluateMiddayResidualProtection(legs.toReversed()))).toEqual(guard)
    if (mask === 15) expect(guard.action).toBe('KEEP_COMPLETE')
    else if ('trims' in guard) {
      expect(guard.action).toBe(long === short ? 'NO_TRIM' : 'TRIM_REDUCE_ONLY')
      expect(guard.modeledSignedNotionalAfterTrimMicros).toBe(0n)
      const trimmed = guard.trims.reduce((sum, trim) => sum + trim.shares * (trim.side === 'SELL' ? 1n : -1n), 0n)
      expect(long - short - trimmed).toBe(0n)
      for (const trim of guard.trims)
        expect(trim.shares <= (legs.find((leg) => leg.symbol === trim.symbol)?.openShares ?? 0n)).toBe(true)
    } else throw new Error('Terminal incomplete basket did not resolve')
  }
})

test('cancels working remainders before trim and recomputes against open, not historical fill, shares', () => {
  const legs = basket(15).map((leg) =>
    leg.symbol === 'NVDA' ? { ...leg, filledShares: 4n, openShares: 3n, workingEntry: true } : leg,
  )
  const cancel = Result.getOrThrow(evaluateMiddayResidualProtection(legs))
  expect(cancel).toMatchObject({
    action: 'CANCEL_AND_RECONCILE',
    exposure: { signedNotionalMicros: 700_000_000n },
    cancelSymbols: ['NVDA'],
  })
  expect(cancel).not.toHaveProperty('trims')
  expect(
    Result.getOrThrow(evaluateMiddayResidualProtection(legs.map((leg) => ({ ...leg, markPriceMicros: null })))),
  ).toEqual({ action: 'CANCEL_AND_RECONCILE', cancelSymbols: ['NVDA'], exposure: null })

  const settled = legs.map((leg) =>
    leg.symbol === 'NVDA'
      ? { ...leg, filledShares: 6n, openShares: 5n, workingEntry: false, markPriceMicros: 101_000_000n }
      : leg,
  )
  expect(Result.getOrThrow(evaluateMiddayResidualProtection(settled))).toMatchObject({
    action: 'TRIM_REDUCE_ONLY',
    exposure: { signedNotionalMicros: 495_000_000n },
    trims: [{ symbol: 'AAPL', side: 'SELL', shares: 4n }],
    modeledSignedNotionalAfterTrimMicros: 95_000_000n,
  })

  expect(Result.isFailure(evaluateMiddayResidualProtection(settled.slice(0, 3)))).toBe(true)
  expect(
    Result.isFailure(evaluateMiddayResidualProtection(settled.map((leg) => ({ ...leg, markPriceMicros: null })))),
  ).toBe(true)
})
