import { replayTestInstruments } from '../testing/replay-instruments'
import { equityMarketProfile } from '../jev/markets'

import { expect, test } from 'bun:test'
import { Result } from 'effect'

import { OrderSide, OrderType } from '../execution/contracts'
import { canonicalHashV1Result } from '../hash'
import { JevCandidateResultStatus, makeJevBatchResult } from '../jev/batch'
import { nativeJevDecisionEvidence, nativeJevFixture } from '../jev/native.test-support'
import { makeJevObservation } from '../jev/observation'
import type { IntradayQuote } from '../market-data/intraday/model'
import { streamingFixture, streamingFixtureFromRaw } from '../testing/streaming-market-fixture'
import { makeIntradayMomentumTestSnapshot } from '../strategy/intraday-momentum/test-support'
import {
  prepareSignalStudyBatch,
  SignalScreenRule,
  signalStudyDefinition,
  studyOrder,
  studyRoundTrip,
  summarizeSignalFactorOutcomes,
} from './signal-study'

const fixture = nativeJevFixture()
const batch = (action = 'enter') => {
  const { decidedAt: _at, ...evidence } = nativeJevDecisionEvidence(fixture, action)
  return evidence
}
const at = Date.parse(fixture.observation.payload.observedAt)
const assumptions = {
  instruments: replayTestInstruments,
  latencyMs: 100,
  slippageBps: 1,
  availableLiquidityPpm: 1_000_000,
  feeMultiplierPpm: 1_000_000,
}
const original = fixture.snapshot.latestQuotes['AAPL']
if (original === undefined) throw new Error('Fixture has no AAPL quote')
const quote = (atMs: number, overrides: Partial<IntradayQuote> = {}) => {
  const value = {
    ...original,
    eventAt: new Date(atMs).toISOString(),
    ingestedAt: new Date(atMs).toISOString(),
    bidPrice: 100,
    askPrice: 100.02,
    bidSize: 100,
    askSize: 100,
    ...overrides,
  }
  return { value, sequence: 1, availableAtMs: atMs, recordHash: Result.getOrThrow(canonicalHashV1Result(value)) }
}
const roundTrip = () => ({
  symbol: 'AAPL',
  protocol: fixture.protocol,
  assumptions,
  holdingIntervalMs: signalStudyDefinition.horizonMs,
  entryBudgetMicros: signalStudyDefinition.entryBudgetMicros,
  decidedAtMs: at,
  entryDecisionQuote: quote(at),
  entryArrivalQuote: quote(at + 100),
  exitDecisionQuote: quote(at + 100 + signalStudyDefinition.horizonMs, { bidPrice: 101, askPrice: 101.02 }),
  exitArrivalQuote: quote(at + 200 + signalStudyDefinition.horizonMs, { bidPrice: 101, askPrice: 101.02 }),
})

test('round trip uses the requested holding interval for exit execution', () => {
  const holdingIntervalMs = 5 * 60_000
  const result = Result.getOrThrow(
    studyRoundTrip({
      ...roundTrip(),
      holdingIntervalMs,
      exitDecisionQuote: quote(at + 100 + holdingIntervalMs, { bidPrice: 101, askPrice: 101.02 }),
      exitArrivalQuote: quote(at + 200 + holdingIntervalMs, { bidPrice: 101, askPrice: 101.02 }),
    }),
  )
  expect(result.outcome.status).toBe('RESOLVED')
  expect(result.fills[1]?.observedAt).toBe(new Date(at + 200 + holdingIntervalMs).toISOString())
})

test('round trip rejects an invalid holding interval', () => {
  expect(Result.isFailure(studyRoundTrip({ ...roundTrip(), holdingIntervalMs: 0 }))).toBeTrue()
  expect(Result.isFailure(studyRoundTrip({ ...roundTrip(), holdingIntervalMs: 1.5 }))).toBeTrue()
})

test('round trip sizes the actual requested entry budget', () => {
  const liquid = { bidSize: 500, askSize: 500 }
  const result = Result.getOrThrow(
    studyRoundTrip({
      ...roundTrip(),
      entryBudgetMicros: '20000000000',
      entryDecisionQuote: quote(at, liquid),
      entryArrivalQuote: quote(at + 100, liquid),
      exitDecisionQuote: quote(at + 100 + signalStudyDefinition.horizonMs, {
        ...liquid,
        bidPrice: 101,
        askPrice: 101.02,
      }),
      exitArrivalQuote: quote(at + 200 + signalStudyDefinition.horizonMs, {
        ...liquid,
        bidPrice: 101,
        askPrice: 101.02,
      }),
    }),
  )
  expect(result.outcome.status).toBe('RESOLVED')
  expect(BigInt(result.fills[0]?.notionalMicros ?? '0') > 15_000_000_000n).toBeTrue()
})

test('round trip rejects a zero entry budget', () => {
  expect(Result.isFailure(studyRoundTrip({ ...roundTrip(), entryBudgetMicros: '0' }))).toBeTrue()
})

test('screen reproduces actual Jev selection and fixes deterministic selections from past evidence', () => {
  const result = Result.getOrThrow(prepareSignalStudyBatch(batch()))
  expect(result.modelStatus).toBe('AVAILABLE')
  expect(result.selected[SignalScreenRule.Jev]).toBe('AAPL')
  expect(result.selected[SignalScreenRule.RelativeMomentum]).toBe('AAPL')
  expect(result.signals.find((signal) => signal.symbol === 'AAPL')?.setupProbability).toBeCloseTo(0.8)
  const wait = Result.getOrThrow(prepareSignalStudyBatch(batch('wait')))
  expect(wait.selected[SignalScreenRule.Jev]).toBeNull()
  expect(wait.selected[SignalScreenRule.RelativeMomentum]).toBe('AAPL')
  const factors = wait.signals.find((signal) => signal.symbol === 'AAPL')?.factors
  expect(factors?.status).toBe('AVAILABLE')
  if (factors?.status !== 'AVAILABLE') throw new Error('Missing native factors')
  expect(Object.keys(factors.answers)).toEqual(['action', 'setup'])
  expect(factors.answers['action']).toMatchObject({ type: 'choice', choice: 'wait' })
})

test('factor outcomes retain unselected candidates and unresolved labels in each denominator', () => {
  const prepared = Result.getOrThrow(prepareSignalStudyBatch(batch('wait')))
  const factors = prepared.signals.find((signal) => signal.symbol === 'AAPL')?.factors
  if (factors === undefined) throw new Error('Missing candidate')
  const rows = [
    {
      observedAt: fixture.observation.payload.observedAt,
      symbol: 'AAPL',
      factors,
      outcome: { status: 'UNRESOLVED' as const, reason: 'missing-future-quote' },
    },
    {
      observedAt: fixture.observation.payload.observedAt,
      symbol: 'AAPL',
      factors: { status: 'UNAVAILABLE' as const },
      outcome: { status: 'NO_ENTRY_FILL' as const, reason: 'no-entry-fill' },
    },
  ]
  const summaries = summarizeSignalFactorOutcomes(rows)
  expect(summaries.find((row) => row.dimension === 'all' && row.factor === 'coverage')).toMatchObject({
    candidateCount: 2,
    unresolvedCount: 1,
    noEntryFillCount: 1,
    resolvedCount: 0,
    meanExecutionReturnBpsAmongResolved: null,
  })
  expect(summaries.find((row) => row.dimension === 'symbol' && row.factor === 'action')).toMatchObject({
    value: 'AAPL',
    bin: 'wait',
    candidateCount: 1,
    unresolvedCount: 1,
  })
})

test('missing model batch remains unavailable while deterministic rules retain the observation', () => {
  const prepared = Result.getOrThrow(prepareSignalStudyBatch({ ...batch(), batchResult: null }))
  expect(prepared.modelStatus).toBe('UNAVAILABLE')
  expect(prepared.selected[SignalScreenRule.Jev]).toBeNull()
  expect(prepared.selected[SignalScreenRule.RelativeMomentum]).toBe('AAPL')
  expect(prepared.signals.every((signal) => signal.setupProbability === null)).toBeTrue()
})

test.each(['partial', 'expired'] as const)('retains received factors from an unusable %s batch', (status) => {
  const evidence = batch()
  const missing = evidence.batchResult.candidates.find(
    (candidate) => candidate.status === JevCandidateResultStatus.Resolved && candidate.symbol !== 'AAPL',
  )
  if (missing?.status !== JevCandidateResultStatus.Resolved) throw new Error('Missing requested candidate')
  const prepared = Result.getOrThrow(
    prepareSignalStudyBatch({
      ...evidence,
      batchResult: Result.getOrThrow(
        makeJevBatchResult(evidence.batchPlan, {
          schemaVersion: evidence.batchResult.schemaVersion,
          batchId: evidence.batchResult.batchId,
          completedAt: evidence.batchPlan.expiresAt,
          candidates: evidence.batchResult.candidates.map((candidate) =>
            status === 'partial' && candidate.symbol === missing.symbol
              ? {
                  status: JevCandidateResultStatus.Unattempted,
                  symbol: candidate.symbol,
                  requestId: missing.requestId,
                }
              : candidate,
          ),
        }),
      ),
    }),
  )
  expect(prepared.modelStatus).toBe('UNAVAILABLE')
  expect(prepared.selected[SignalScreenRule.Jev]).toBeNull()
  expect(prepared.signals.every((signal) => signal.setupProbability === null)).toBeTrue()
  expect(prepared.signals.find((signal) => signal.symbol === 'AAPL')?.factors.status).toBe('AVAILABLE')
  expect(prepared.signals.find((signal) => signal.symbol === missing.symbol)?.factors.status).toBe(
    status === 'partial' ? 'UNAVAILABLE' : 'AVAILABLE',
  )
})

test.each<{ premium: number; selected: string | null }>([
  { premium: 0.00005, selected: 'AAPL' },
  { premium: 0, selected: null },
  { premium: -0.00005, selected: null },
])('relative momentum applies exact positive return to premium $premium', ({ premium, selected }) => {
  const base = streamingFixture()
  const query = {
    ...base.query,
    symbols: [...equityMarketProfile.candidateSymbols, 'SPY'].sort(),
    candidateSymbols: equityMarketProfile.candidateSymbols,
    ...(fixture.protocol.candidateEvidencePolicy === undefined
      ? {}
      : { candidateEvidencePolicy: fixture.protocol.candidateEvidencePolicy }),
  }
  const { snapshot } = streamingFixtureFromRaw(
    makeIntradayMomentumTestSnapshot(
      fixture.protocol,
      { ...query, archiveWatermarks: base.archive.manifest.archiveWatermarks },
      { AAPL: premium },
    ),
    query,
  )
  const observation = Result.getOrThrow(
    makeJevObservation({
      cycleId: fixture.observation.payload.cycleId,
      authorityGenerationHash: fixture.observation.payload.authorityGenerationHash,
      protocol: fixture.protocol,
      portfolio: fixture.portfolio,
      snapshot,
    }),
  )
  const { decidedAt: _at, ...evidence } = nativeJevDecisionEvidence({ ...fixture, observation })
  const result = Result.getOrThrow(prepareSignalStudyBatch(evidence))
  if (selected === null) expect(result.selected[SignalScreenRule.RelativeMomentum]).toBeNull()
  else expect(result.selected[SignalScreenRule.RelativeMomentum]).toBe(selected)
  if (premium > 0) expect(result.signals.find((signal) => signal.symbol === 'AAPL')?.metrics.lookbackReturnBps).toBe(0)
})

test('mutated model results and mismatched observations cannot enter the screen', () => {
  const valid = batch()
  expect(
    Result.isFailure(
      prepareSignalStudyBatch({ ...valid, batchResult: { ...valid.batchResult, resultHash: 'f'.repeat(64) } }),
    ),
  ).toBeTrue()
  expect(
    Result.isFailure(
      prepareSignalStudyBatch({ ...valid, batchPlan: { ...valid.batchPlan, observationHash: 'f'.repeat(64) } }),
    ),
  ).toBeTrue()
  expect(
    Result.isFailure(
      prepareSignalStudyBatch({
        ...valid,
        observation: { ...valid.observation, observedAt: new Date(at + 1).toISOString() },
      }),
    ),
  ).toBeTrue()
})

test('round trip charges both adverse executions and fees against actual whole-share fills', () => {
  const result = Result.getOrThrow(studyRoundTrip(roundTrip()))
  expect(result.outcome.status).toBe('RESOLVED')
  expect(result.fills).toHaveLength(2)
  const [entry, exit] = result.fills
  if (entry === undefined || exit === undefined || result.outcome.status !== 'RESOLVED')
    throw new Error('Missing resolved fills')
  expect(BigInt(entry.priceMicros)).toBeGreaterThan(100_020_000n)
  expect(BigInt(exit.priceMicros)).toBeLessThan(101_000_000n)
  expect(entry.quantityAtoms).toBe(exit.quantityAtoms)
  expect(BigInt(entry.quantityAtoms) % 1_000_000n).toBe(0n)
  expect(BigInt(entry.notionalMicros)).toBeLessThanOrEqual(BigInt(signalStudyDefinition.entryBudgetMicros))
  expect(BigInt(result.outcome.netExecutionPnlMicros)).toBeLessThan(
    BigInt(exit.notionalMicros) - BigInt(entry.notionalMicros),
  )
  expect(result.quoteHashes).toHaveLength(4)
})

test('partial entry limits the exit to the actual acquired quantity', () => {
  const input = roundTrip()
  const result = Result.getOrThrow(studyRoundTrip({ ...input, entryArrivalQuote: quote(at + 100, { askSize: 5 }) }))
  expect(result.outcome.status).toBe('RESOLVED')
  expect(result.fills.map((fill) => fill.quantityAtoms)).toEqual(['5000000000', '5000000000'])
})

test.each([1_000_000, 10_000_000])(
  'entry sizing reserves fees within cash at fee multiplier %d',
  (feeMultiplierPpm) => {
    const result = Result.getOrThrow(
      studyRoundTrip({
        ...roundTrip(),
        assumptions: { ...assumptions, feeMultiplierPpm },
        entryDecisionQuote: quote(at, { bidPrice: 99.9, askPrice: 99.91 }),
        entryArrivalQuote: quote(at + 100, { bidPrice: 99.98, askPrice: 99.99 }),
      }),
    )
    expect(result.outcome.status).toBe('RESOLVED')
    expect(result.fills.map((fill) => fill.quantityAtoms)).toEqual(['99000000000', '99000000000'])
    expect(result.fills[0]?.priceMicros).toBe('100000000')
  },
)

test('a share whose notional fits but fees exceed cash remains an explicit unfilled hypothesis', () => {
  const result = Result.getOrThrow(
    studyRoundTrip({
      ...roundTrip(),
      entryDecisionQuote: quote(at, { bidPrice: 9990, askPrice: 9990.01 }),
      entryArrivalQuote: quote(at + 100, { bidPrice: 9998.99, askPrice: 9999 }),
    }),
  )
  expect(result.outcome).toEqual({ status: 'NO_ENTRY_FILL', reason: 'budget-below-instrument-minimum' })
  expect(result.fills).toHaveLength(0)
})

test('partial exit retains unresolved exposure instead of reporting flat profit', () => {
  const input = roundTrip()
  const result = Result.getOrThrow(
    studyRoundTrip({
      ...input,
      exitArrivalQuote: quote(at + 200 + signalStudyDefinition.horizonMs, {
        bidPrice: 101,
        askPrice: 101.02,
        bidSize: 2,
      }),
    }),
  )
  expect(result.outcome).toEqual({ status: 'UNRESOLVED', reason: 'partial-exit' })
  expect(result.fills).toHaveLength(2)
  expect(result.fills[1]?.quantityAtoms).toBe('2000000000')
})

test('a canceled entry is a no-fill result and missing exit evidence is unresolved', () => {
  const input = roundTrip()
  expect(
    Result.getOrThrow(
      studyRoundTrip({ ...input, entryArrivalQuote: quote(at + 100, { bidPrice: 102, askPrice: 102.02 }) }),
    ).outcome,
  ).toEqual({ status: 'NO_ENTRY_FILL', reason: 'adverse-price-exceeds-limit' })
  const unresolved = Result.getOrThrow(studyRoundTrip({ ...input, exitArrivalQuote: undefined }))
  expect(unresolved.outcome).toEqual({ status: 'UNRESOLVED', reason: 'exit-missing-arrival-quote' })
  expect(unresolved.fills).toHaveLength(1)
})

test.each([
  ['future arrival', quote(at + 101), 'arrival-quote-not-yet-available'],
  ['future event', quote(at + 100, { eventAt: new Date(at + 101).toISOString() }), 'arrival-quote-event-in-future'],
  ['stale event', quote(at + 100, { eventAt: new Date(at - 10_000).toISOString() }), 'stale-arrival-quote'],
  ['wrong symbol', quote(at + 100, { symbol: 'AMZN' }), 'arrival-quote-identity-mismatch'],
] as const)('IOC retains %s as unresolved', (_name, arrivalQuote, reason) => {
  const result = Result.getOrThrow(
    studyOrder({
      orderType: OrderType.Limit,
      symbol: 'AAPL',
      side: OrderSide.Buy,
      quantityAtoms: 10000000000n,
      decisionQuote: quote(at),
      arrivalQuote,
      decisionAtMs: at,
      arrivalAtMs: at + 100,
      protocol: fixture.protocol,
      assumptions,
    }),
  )
  expect(result).toEqual({ status: 'UNRESOLVED', reason })
})

test('execution cannot silently omit the registered routing latency', () => {
  expect(
    Result.isFailure(
      studyOrder({
        orderType: OrderType.Limit,
        symbol: 'AAPL',
        side: OrderSide.Buy,
        quantityAtoms: 10000000000n,
        decisionQuote: quote(at),
        arrivalQuote: quote(at),
        decisionAtMs: at,
        arrivalAtMs: at,
        protocol: fixture.protocol,
        assumptions,
      }),
    ),
  ).toBeTrue()
})
