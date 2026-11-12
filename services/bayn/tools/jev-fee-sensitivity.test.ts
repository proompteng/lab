import { cryptoMaximumTakerFeeBps } from '../src/broker/crypto-fees'
import { expect, test } from 'bun:test'
import { Result } from 'effect'
import { canonicalHashV1Result } from '../src/hash'
import { jevEntryEconomics } from '../src/jev/entry-economics'
import { defaultJevProtocolDocument } from '../src/jev/protocol'
import { decideJevEntry } from '../src/jev/decision'
import { nativeJevDecisionEvidence, jevObservationForSnapshot } from '../src/jev/native.test-support'
import { cryptoMarketFixture } from '../src/testing/crypto-market-fixture'
import { receivedCryptoFee } from '../src/strategy/execution-model/fees'
import { reportJevAbstention } from './jev-abstention-report'
import { historicalFeeProvenance, hypotheticalCryptoFeeSensitivity } from './jev-fee-sensitivity'

const hash = (value: unknown) => Result.getOrThrow(canonicalHashV1Result(value))

test('native sensitivity keeps received coin atoms distinct from cent-rounded sell cash', () => {
  for (const bps of [25, 22, 20, 18]) {
    const multiplier = BigInt(bps) * 40_000n
    const buy = receivedCryptoFee(
      { symbol: 'BTC/USD', side: 'buy', quantityAtoms: 10001n, notionalMicros: 10000001n },
      multiplier,
      cryptoMaximumTakerFeeBps,
    )
    const sell = receivedCryptoFee(
      { symbol: 'BTC/USD', side: 'sell', quantityAtoms: 10001n, notionalMicros: 10000001n },
      multiplier,
      cryptoMaximumTakerFeeBps,
    )
    expect(buy.quantityAtoms).toBe((10001n * BigInt(bps) + 9999n) / 10000n)
    expect(sell.cashMicros).toBe(((10000001n * BigInt(bps) + 99999999n) / 100000000n) * 10000n)
    expect(buy.cashMicros).toBe(0n)
    expect(sell.quantityAtoms).toBe(0n)
  }
})

test('optional provenance preserves sealed decision and default report, without qualifying profit', () => {
  const { snapshot } = cryptoMarketFixture('SOL/USD')
  const observation = Result.getOrThrow(jevObservationForSnapshot(snapshot))
  const evidence = nativeJevDecisionEvidence({ observation, protocol: observation.payload.protocol }, false)
  const strategyDecision = Result.getOrThrow(decideJevEntry(evidence))
  const document = { mode: 'PAPER', bindings: { cycleId: observation.payload.cycleId }, strategyDecision }
  const original = hash(document)
  const baseline = reportJevAbstention(document)
  const accountId = evidence.observation.portfolio.brokerState.account.accountId
  const historical = {
    ...source(),
    accountId,
    effectiveAt: '2020-01-01T00:00:00.000Z',
    observedAt: '2020-01-02T00:00:00.000Z',
    matches: source().matches.map((match) => ({ ...match, providerAccountId: accountId })),
  }
  const report = reportJevAbstention(document, { source: historical, expectedSourceHash: hash(historical) })
  expect(report.feeProvenance?.currentTier).toBe('UNKNOWN')
  expect(report.profitableEdgeProven).toBe(false)
  expect(report.selectedSymbols).toEqual(baseline.selectedSymbols)
  const candidate = report.candidates.find((c) => 'feeSensitivity' in c)
  if (candidate === undefined || !('feeSensitivity' in candidate)) throw new Error('Expected sensitivity')
  expect(candidate.feeSensitivity?.baselineReproducedExactly).toBe(true)
  expect(hash(document)).toBe(original)
  expect(reportJevAbstention(document)).toEqual(baseline)
})
const source = () => ({
  schemaVersion: 'bayn.historical-matched-fees.v1',
  provider: 'alpaca',
  environment: 'sandbox',
  accountId: 'synthetic-paper-account',
  effectiveAt: '2026-10-01T00:00:00.000Z',
  observedAt: '2026-10-02T00:00:00.000Z',
  rounding: 'OBSERVED_PROVIDER_DEBITS_NOT_INFERRED_RATES',
  matches: [
    {
      symbol: 'BTC/USD',
      side: 'buy',
      sourceFillHash: 'a'.repeat(64),
      providerActivityHash: 'b'.repeat(64),
      providerAccountId: 'synthetic-paper-account',
      providerEnvironment: 'sandbox',
      providerSymbol: 'BTC/USD',
      providerSide: 'buy',
      fillQuantityAtoms: '1000000000',
      fillNotionalMicros: '100000000',
      providerDebit: { kind: 'COIN', quantityAtoms: '2200000' },
      matchedDebit: { kind: 'COIN', quantityAtoms: '2200000' },
    },
    {
      symbol: 'BTC/USD',
      side: 'sell',
      sourceFillHash: 'c'.repeat(64),
      providerActivityHash: 'd'.repeat(64),
      providerAccountId: 'synthetic-paper-account',
      providerEnvironment: 'sandbox',
      providerSymbol: 'BTC/USD',
      providerSide: 'sell',
      fillQuantityAtoms: '1000000000',
      fillNotionalMicros: '100000000',
      providerDebit: { kind: 'CASH', cashMicros: '180000' },
      matchedDebit: { kind: 'CASH', cashMicros: '180000' },
    },
  ],
})
const provenance = (s: unknown, account = 'synthetic-paper-account') =>
  historicalFeeProvenance({ source: s, expectedSourceHash: hash(s) }, account, '2026-10-03T00:00:00.000Z')

test('historical matching derives cash and coin rates without claiming current tier or authenticity', () => {
  const result = provenance(source())
  expect(result.matches.map((x) => [x.debitKind, x.observedDebitRatioBps])).toEqual([
    ['COIN', 22],
    ['CASH', 18],
  ])
  expect(result.currentTier).toBe('UNKNOWN')
  expect(result.providerAuthenticityIndependentlyVerified).toBe(false)
  expect(result.historicalOnly).toBe(true)
})
test('rejects mismatched accounts, environments, future evidence, hashes and asserted rates', () => {
  expect(() => provenance(source(), 'different')).toThrow('account')
  expect(() => provenance({ ...source(), environment: 'live' })).toThrow()
  expect(() => provenance({ ...source(), observedAt: '2026-10-04T00:00:00.000Z' })).toThrow('historically')
  expect(() => provenance({ ...source(), effectiveAt: '2026-10-03T00:00:00.000Z' })).toThrow('historically')
  expect(() => provenance({ ...source(), effectiveAt: 'invalid' })).toThrow()
  const s = source()
  expect(() => historicalFeeProvenance({ source: s, expectedSourceHash: hash(s) }, s.accountId, 'invalid')).toThrow()
  expect(() => provenance({ ...source(), takerBps: 18 })).toThrow()
  expect(() =>
    historicalFeeProvenance(
      { source: source(), expectedSourceHash: '0'.repeat(64) },
      'synthetic-paper-account',
      '2026-10-03T00:00:00.000Z',
    ),
  ).toThrow('hash')
})
test('rejects unmatched debits, wrong debit assets and duplicate matches', () => {
  const s = source()
  const first = s.matches[0]
  if (first === undefined) throw new Error('fixture')
  expect(() =>
    provenance({ ...s, matches: [{ ...first, matchedDebit: { kind: 'COIN', quantityAtoms: '1' } }] }),
  ).toThrow('equal')
  expect(() => provenance({ ...s, matches: [{ ...first, side: 'sell', providerSide: 'sell' }] })).toThrow('asset')
  expect(() => provenance({ ...s, matches: [{ ...first, providerAccountId: 'other' }] })).toThrow('identity')
  expect(() => provenance({ ...s, matches: [{ ...first, providerSymbol: 'ETH/USD' }] })).toThrow('identity')
  expect(() => provenance({ ...s, matches: [{ ...first, providerSide: 'sell' }] })).toThrow('identity')
  expect(() => provenance({ ...s, matches: [first, first] })).toThrow('Duplicate')
})
test.each(['BTC/USD', 'ETH/USD', 'SOL/USD'])(
  '%s preserves exact baseline and monotonic rounded fee scenarios',
  (symbol) => {
    const protocol = defaultJevProtocolDocument
    const economics = Result.getOrThrow(
      jevEntryEconomics({
        feeAt: '2026-09-04T14:15:00.000Z',
        cryptoFeeTier: null,

        protocol,
        symbol,
        bidMicros: 100_000_000n,
        askMicros: 100_020_000n,
        capitalMicros: '100000000000',
      }),
    )
    if (economics === null) throw new Error('funded fixture')
    const result = hypotheticalCryptoFeeSensitivity({
      feeAt: '2026-09-04T14:15:00.000Z',
      symbol,
      protocol,
      economics,
      bidMicros: 100_000_000n,
    })
    expect(result.baselineReproducedExactly).toBe(true)
    expect(() =>
      hypotheticalCryptoFeeSensitivity({
        feeAt: '2026-09-04T14:15:00.000Z',
        symbol,
        protocol,
        economics: { ...economics, receivedQuantityAtoms: '1' },
        bidMicros: 100_000_000n,
      }),
    ).toThrow('baseline')
    expect(result.profitableEdgeProven).toBe(false)
    expect(result.scenarios.map((x) => x.hypotheticalFeeBpsPerSide)).toEqual([25, 22, 20, 18])
    for (let i = 1; i < result.scenarios.length; i++) {
      const prior = result.scenarios[i - 1],
        current = result.scenarios[i]
      if (prior === undefined || current === undefined) throw new Error('fixture')
      expect(BigInt(current.holdingExitBreakEvenBidMicros)).toBeLessThan(BigInt(prior.holdingExitBreakEvenBidMicros))
      expect(BigInt(current.receivedQuantityAtoms)).toBeGreaterThan(BigInt(prior.receivedQuantityAtoms))
    }
    expect(() =>
      hypotheticalCryptoFeeSensitivity({
        feeAt: '2026-09-04T14:15:00.000Z',
        symbol,
        protocol,
        economics: { ...economics, holdingExitBreakEvenBidUsd: 1 },
        bidMicros: 100_000_000n,
      }),
    ).toThrow('baseline')
  },
)
