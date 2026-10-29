import { equityMarketProfile } from './markets'
import { describe, expect, test } from 'bun:test'
import { Result, Schema } from 'effect'

import { JevBatchPlanVersion, JevCandidatePlanStatus } from './batch'
import { nativeJevBatchResult, nativeJevDecisionEvidence, nativeJevFixture } from './native.test-support'
import { decideJevEntry, jevEntryQuoteMaximumAgeMs, JevEntryTargetSchema } from './decision'
import { entryQuoteExpiresAtMillis } from '../risk'
import { makeStrategyProtocolHashResult } from '../contracts'
import { canonicalHashV1Result } from '../hash'
import { reconciledStateHash } from '../simulation-reconciliation/broker-model'
import { jevProtocolIdentityMatches } from '../shadow-decision-contract'
import { makeJevObservation, reproduceJevCandidateObservation } from './observation'
import { streamingFixtureFromRaw } from '../testing/streaming-market-fixture'
import { decodeJevPortfolio, JevPurpose } from './portfolio'
import { decodeJevProtocol, defaultJevProtocolDocument, jevBehaviorHash } from './protocol'
import { makeJevTradingSignalBatch, reproduceJevTradingSignalBatch } from './trading-signals'

const batchFor = (fixture: ReturnType<typeof nativeJevFixture>) =>
  Result.getOrThrow(
    makeJevTradingSignalBatch({
      observation: fixture.observation.payload,
      expiresAt: new Date(
        Date.parse(fixture.observation.payload.observedAt) + fixture.protocol.inferenceValidityMs,
      ).toISOString(),
      planVersion: JevBatchPlanVersion.V7,
    }),
  )

describe('native Jev entry and position observations', () => {
  test('repeated target verification rechecks changed source bytes and never trusts a claimed source identity', () => {
    const target = Result.getOrThrow(decideJevEntry(nativeJevDecisionEvidence()))
    const decode = Schema.decodeUnknownResult(JevEntryTargetSchema)
    expect(Result.getOrThrow(decode(target))).toEqual(target)
    expect(Result.getOrThrow(decode(structuredClone(target)))).toEqual(target)

    const changed = structuredClone(target)
    const originalHash = changed.evidence.batchPlan.observationHash
    Object.assign(changed.evidence.observation.portfolio.brokerState.account, {
      cashMicros: (BigInt(changed.evidence.observation.portfolio.brokerState.account.cashMicros) + 1n).toString(),
    })
    expect(changed.evidence.batchPlan.observationHash).toBe(originalHash)
    expect(Result.isFailure(decode(changed))).toBe(true)
    expect(Result.getOrThrow(decode(target))).toEqual(target)

    Object.assign(changed, structuredClone(target))
    Object.assign(changed.evidence, { decidedAt: changed.evidence.batchPlan.expiresAt })
    expect(Result.isFailure(decode(changed))).toBe(true)
    expect(Result.getOrThrow(decode(target))).toEqual(target)
  })

  test('complete recorded responses determine one capped target and reproduce without a model', () => {
    const evidence = nativeJevDecisionEvidence()
    const target = Result.getOrThrow(decideJevEntry(evidence))
    expect(target.selectedSymbols).toEqual(['AAPL'])
    expect(target.targetWeights['AAPL']).toBeGreaterThan(0)
    expect(target.targetWeights['AAPL']).toBeLessThanOrEqual(0.2)
    expect(Object.values(target.targetWeights).reduce((sum, weight) => sum + weight, 0)).toBe(
      target.targetWeights['AAPL'] ?? 0,
    )
    expect(
      Result.getOrThrow(Schema.decodeUnknownResult(JevEntryTargetSchema)(JSON.parse(JSON.stringify(target)))),
    ).toEqual(target)
    for (const change of [
      { selectedSymbols: ['AMZN'] },
      { targetWeights: { ...target.targetWeights, AAPL: 0.4 } },
      { decidedAt: evidence.observation.observedAt },
    ])
      expect(Result.isFailure(Schema.decodeUnknownResult(JevEntryTargetSchema)({ ...target, ...change }))).toBe(true)
    for (const [supportsEntry, probability] of [
      [false, 0.9],
      [true, 0.42],
    ] as const) {
      // Only the recorded judgments vary; keep the same verified source and request plan.
      const changedJudgments = {
        ...evidence,
        batchResult: nativeJevBatchResult(evidence.batchPlan, evidence.decidedAt, () => supportsEntry, probability),
      }
      expect(Result.getOrThrow(decideJevEntry(changedJudgments)).selectedSymbols).toEqual([])
    }
  })

  test.each([0.1, 0.42, 0.69])('unsupported or uncertain judgments at %s cannot authorize an entry', (probability) => {
    const target = Result.getOrThrow(decideJevEntry(nativeJevDecisionEvidence(undefined, true, probability)))
    expect(target.selectedSymbols).toEqual([])
    expect(Object.values(target.targetWeights).every((weight) => weight === 0)).toBe(true)
  })

  test('held positions reject entry inference even when sunk entry cash fees change', () => {
    const fixture = nativeJevFixture(JevPurpose.Manage)
    const portfolio = fixture.portfolio
    if (portfolio.purpose !== JevPurpose.Manage) throw new Error('Expected management fixture')
    const changed = Result.getOrThrow(
      makeJevObservation({
        ...fixture.input,
        portfolio: {
          ...portfolio,
          entryFills: portfolio.entryFills.map((fill) => ({ ...fill, feeMicros: '1000000' })),
        },
      }),
    )
    expect(changed.contentHash).not.toBe(fixture.observation.contentHash)
    expect(() => batchFor(fixture)).toThrow()
    expect(
      Result.isFailure(
        makeJevTradingSignalBatch({
          observation: changed.payload,
          expiresAt: new Date(
            Date.parse(changed.payload.observedAt) + fixture.protocol.inferenceValidityMs,
          ).toISOString(),
          planVersion: JevBatchPlanVersion.V7,
        }),
      ),
    ).toBe(true)
  })

  test('entry cannot reuse expired, partial, or another portfolio decision evidence', () => {
    const evidence = nativeJevDecisionEvidence()
    expect(Result.isFailure(decideJevEntry({ ...evidence, decidedAt: evidence.batchPlan.expiresAt }))).toBe(true)
    expect(
      Result.isFailure(
        decideJevEntry({
          ...evidence,
          batchResult: { ...evidence.batchResult, candidates: evidence.batchResult.candidates.slice(1) },
        }),
      ),
    ).toBe(true)
    expect(
      Result.isFailure(
        decideJevEntry({ ...evidence, observation: nativeJevFixture(JevPurpose.Manage).observation.payload }),
      ),
    ).toBe(true)
  })

  test('a completed Jev batch leaves time to price and submit against a fresh quote', () => {
    const fixture = nativeJevFixture()
    const observation = fixture.observation.payload
    const observed = Date.parse(observation.observedAt)
    const batchPlan = Result.getOrThrow(
      makeJevTradingSignalBatch({
        observation,
        expiresAt: new Date(observed + 10_000).toISOString(),
        planVersion: JevBatchPlanVersion.V7,
      }),
    )
    const decidedAt = new Date(observed + 7_000).toISOString()
    const target = Result.getOrThrow(
      decideJevEntry({
        observation,
        batchPlan,
        batchResult: nativeJevBatchResult(batchPlan, decidedAt),
        decidedAt,
      }),
    )
    expect(target.selectedSymbols).toEqual(['AAPL'])
    const quoteEventAt = new Date(observed + 7_100).toISOString()
    const maximumAgeMs = jevEntryQuoteMaximumAgeMs(target, quoteEventAt, fixture.protocol.maximumQuoteAgeMs)
    expect(maximumAgeMs).toBe(10_000)
    expect(entryQuoteExpiresAtMillis({ eventAt: quoteEventAt, maximumAgeMs })).toBe(observed + 17_100)

    const historical = Result.getOrThrow(decideJevEntry(nativeJevDecisionEvidence()))
    const historicalQuoteAt = historical.decidedAt
    expect(
      entryQuoteExpiresAtMillis({
        eventAt: historicalQuoteAt,
        maximumAgeMs: jevEntryQuoteMaximumAgeMs(historical, historicalQuoteAt, fixture.protocol.maximumQuoteAgeMs),
      }),
    ).toBe(Date.parse(historicalQuoteAt) + fixture.protocol.maximumQuoteAgeMs)
  })

  test('retired Jev protocols cannot be decoded for execution', () => {
    for (const schemaVersion of [
      'bayn.jev.protocol.v1',
      'bayn.jev.protocol.v2',
      'bayn.jev.protocol.v3',
      'bayn.jev.protocol.v4',
      'bayn.jev.protocol.v5',
      'bayn.jev.protocol.v6',
      'bayn.jev.protocol.v7',
      'bayn.jev.protocol.v8',
      'bayn.jev.protocol.v9',
      'bayn.jev.protocol.v10',
      'bayn.jev.protocol.v11',
    ])
      expect(Result.isFailure(decodeJevProtocol({ ...defaultJevProtocolDocument, schemaVersion }))).toBe(true)
    expect(Result.isFailure(decodeJevProtocol({ ...defaultJevProtocolDocument, minimumEntryProbability: 0.65 }))).toBe(
      true,
    )
  })

  test('execution authority requires the exact current protocol and batch identity', () => {
    const active = Result.getOrThrow(decodeJevProtocol(defaultJevProtocolDocument))
    const identity = Result.getOrThrow(
      makeStrategyProtocolHashResult({
        name: 'jev',
        behaviorHash: jevBehaviorHash,
        parameterHash: Result.getOrThrow(canonicalHashV1Result(active)),
        parameterSchemaVersion: active.schemaVersion,
      }),
    )
    expect(jevProtocolIdentityMatches(active, identity)).toBe(true)
    expect(jevProtocolIdentityMatches(active, '0'.repeat(64))).toBe(false)
    expect(
      jevProtocolIdentityMatches({ ...active, maximumSymbolWeight: active.maximumSymbolWeight / 2 }, identity),
    ).toBe(false)
  })

  test('recomputed reconciliation hashes cannot legitimize mixed-account or future position evidence', () => {
    const portfolio = nativeJevFixture(JevPurpose.Manage).portfolio
    const state = portfolio.brokerState
    for (const altered of [
      { ...state, positions: state.positions.map((position) => ({ ...position, accountId: 'different-account' })) },
      { ...state, orders: state.orders.map((order) => ({ ...order, accountId: 'different-account' })) },
      {
        ...state,
        positions: state.positions.map((position) => ({ ...position, observedAt: '2026-09-04T14:31:00.000Z' })),
      },
      { ...state, orders: [...state.orders, ...state.orders] },
    ]) {
      const hash = Result.getOrThrow(reconciledStateHash(altered))
      expect(
        Result.isFailure(
          decodeJevPortfolio({
            ...portfolio,
            brokerState: {
              ...altered,
              reconciliation: { ...state.reconciliation, expectedHash: hash, observedHash: hash },
            },
          }),
        ),
      ).toBe(true)
    }
  })
  test('freezes a complete entry universe with explicit flat position context', () => {
    const fixture = nativeJevFixture()
    const batch = batchFor(fixture)
    expect(batch.candidates.map(({ symbol }) => symbol)).toEqual([...equityMarketProfile.candidateSymbols])
    expect(Result.getOrThrow(reproduceJevTradingSignalBatch(fixture.observation.payload, batch))).toEqual(batch)
    expect(
      batch.candidates
        .filter((candidate) => candidate.status === JevCandidatePlanStatus.Requested)
        .map((candidate) => candidate.symbol),
    ).toEqual([...equityMarketProfile.candidateSymbols])
    for (const candidate of batch.candidates) {
      if (candidate.status !== JevCandidatePlanStatus.Requested) continue
      expect(candidate.request.request.numericalState).toMatchObject({
        schemaVersion: 'bayn.jev-entry-state.v22',
        task: { decisionPurpose: JevPurpose.Entry },
      })
    }
  })

  test('management retains actual partial fills and rejects entry-inference batches', () => {
    const fixture = nativeJevFixture(JevPurpose.Manage)
    expect(fixture.portfolio.purpose).toBe(JevPurpose.Manage)
    expect(fixture.portfolio.brokerState.positions[0]?.quantityAtoms).toBe('5000000000')
    expect(fixture.entryFills.map((fill) => fill.quantityAtoms)).toEqual(['3000000000', '2000000000'])
    expect(() => batchFor(fixture)).toThrow()
  })

  test('rejects wrong quantities, missing fills, a held entry and substituted reconciled positions', () => {
    const fixture = nativeJevFixture(JevPurpose.Manage)
    const portfolio = fixture.portfolio
    if (portfolio.purpose !== JevPurpose.Manage) throw new Error('Expected management fixture')
    for (const altered of [
      { ...portfolio, entryFills: portfolio.entryFills.slice(1) },
      { ...portfolio, entryFills: [...portfolio.entryFills, portfolio.entryFills[0]] },
      { purpose: JevPurpose.Entry, brokerState: portfolio.brokerState },
      { ...portfolio, brokerState: { ...portfolio.brokerState, positions: [] } },
      { ...portfolio, entryDecisionHash: 'invalid' },
    ])
      expect(Result.isFailure(decodeJevPortfolio(altered))).toBe(true)
  })

  test('rejects stale portfolio evidence, source substitution and an extended inference deadline', () => {
    const fixture = nativeJevFixture()
    const payload = fixture.observation.payload
    expect(
      Result.isFailure(reproduceJevCandidateObservation({ ...payload, observedAt: '2026-09-04T14:31:02.000Z' })),
    ).toBe(true)
    expect(
      Result.isFailure(
        reproduceJevCandidateObservation({ ...payload, protocol: { ...payload.protocol, candidateSymbols: ['AAPL'] } }),
      ),
    ).toBe(true)
    expect(
      Result.isFailure(
        makeJevTradingSignalBatch({
          observation: payload,
          expiresAt: new Date(
            Date.parse(payload.observedAt) + fixture.protocol.inferenceValidityMs + 1000,
          ).toISOString(),
          planVersion: JevBatchPlanVersion.V7,
        }),
      ),
    ).toBe(true)
  })

  test('the development protocol covers all available non-benchmark symbols without changing broker execution terms', () => {
    const protocol = Result.getOrThrow(decodeJevProtocol(defaultJevProtocolDocument))
    expect(protocol.candidateSymbols).toHaveLength(18)
    expect(protocol.maximumPositions).toBe(1)
    expect(protocol.executionModel.order.timeInForce).toBe('asset-session')
    expect(Result.isFailure(decodeJevProtocol({ ...protocol, candidateSymbols: ['AAPL', 'AAPL'] }))).toBe(true)
    expect(Result.isFailure(decodeJevProtocol({ ...protocol, maximumSymbolWeight: 1 }))).toBe(true)
  })

  test('the protocol and saved observation must select the same candidate evidence policy', () => {
    const { observation } = nativeJevFixture()
    const { candidateEvidencePolicy: _policy, ...historicalProtocol } = observation.payload.protocol
    expect(
      Result.isFailure(
        reproduceJevCandidateObservation({
          ...observation.payload,
          protocol: historicalProtocol,
        }),
      ),
    ).toBe(true)
  })

  test('a native batch requests a quote-ready candidate with only a real pre-range-end trade', () => {
    const fixture = nativeJevFixture()
    const { snapshot } = streamingFixtureFromRaw(
      {
        ...fixture.snapshot,
        quotes: fixture.snapshot.quotes.map((quote) =>
          quote.symbol === 'AAPL'
            ? { ...quote, eventAt: '2026-09-04T14:29:59.000Z', ingestedAt: '2026-09-04T14:29:59.000Z' }
            : quote,
        ),
        trades: fixture.snapshot.trades.map((trade) =>
          trade.symbol === 'AAPL'
            ? { ...trade, eventAt: '2026-09-04T14:20:00.000Z', ingestedAt: '2026-09-04T14:20:00.000Z' }
            : trade,
        ),
      },
      fixture.query,
    )
    const observation = Result.getOrThrow(
      makeJevObservation({
        ...fixture.observation.payload,
        snapshot,
      }),
    )
    const batch = Result.getOrThrow(
      makeJevTradingSignalBatch({
        observation: observation.payload,
        expiresAt: '2026-09-04T14:30:12.000Z',
        planVersion: JevBatchPlanVersion.V7,
      }),
    )
    expect(batch.candidates.find((entry) => entry.symbol === 'AAPL')?.status).toBe(JevCandidatePlanStatus.Requested)
    expect(Result.getOrThrow(reproduceJevTradingSignalBatch(observation.payload, batch))).toEqual(batch)
  })
})
