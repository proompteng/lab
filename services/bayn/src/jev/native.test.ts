import { describe, expect, test } from 'bun:test'
import { Result, Schema } from 'effect'

import { JevBatchPlanVersion, JevCandidatePlanStatus } from './batch'
import { nativeJevBatchResult, nativeJevDecisionEvidence, nativeJevFixture } from './native.test-support'
import {
  decideJevEntry,
  decideJevManagement,
  jevEntryQuoteMaximumAgeMs,
  JevEntryTargetSchema,
  JevManagementAction,
  JevManagementDecisionSchema,
} from './decision'
import { entryQuoteExpiresAtMillis } from '../risk'
import { reconciledStateHash } from '../reconciliation'
import { reproduceJevCandidateObservation } from './observation'
import { decodeJevPortfolio, JevPurpose } from './portfolio'
import { decodeJevProtocol, defaultJevProtocolDocument } from './protocol'
import { makeJevTradingSignalBatch, reproduceJevTradingSignalBatch } from './trading-signals'

const batchFor = (fixture: ReturnType<typeof nativeJevFixture>) =>
  Result.getOrThrow(
    makeJevTradingSignalBatch({
      observation: fixture.observation.payload,
      expiresAt: new Date(
        Date.parse(fixture.observation.payload.observedAt) + fixture.protocol.inferenceValidityMs,
      ).toISOString(),
      planVersion: JevBatchPlanVersion.V1,
    }),
  )

describe('native Jev entry and position observations', () => {
  test('complete recorded responses determine one capped target and reproduce without a model', () => {
    const evidence = nativeJevDecisionEvidence()
    const target = Result.getOrThrow(decideJevEntry(evidence))
    expect(target.selectedSymbols).toEqual(['AAPL'])
    expect(target.targetWeights['AAPL']).toBe(0.2)
    expect(Object.values(target.targetWeights).reduce((sum, weight) => sum + weight, 0)).toBe(0.2)
    expect(
      Result.getOrThrow(Schema.decodeUnknownResult(JevEntryTargetSchema)(JSON.parse(JSON.stringify(target)))),
    ).toEqual(target)
    for (const change of [
      { selectedSymbols: ['AMZN'] },
      { targetWeights: { ...target.targetWeights, AAPL: 0.4 } },
      { decidedAt: evidence.observation.observedAt },
    ])
      expect(Result.isFailure(Schema.decodeUnknownResult(JevEntryTargetSchema)({ ...target, ...change }))).toBe(true)
    expect(Result.getOrThrow(decideJevEntry(nativeJevDecisionEvidence(undefined, 'wait'))).selectedSymbols).toEqual([])
    expect(
      Result.getOrThrow(decideJevEntry(nativeJevDecisionEvidence(undefined, 'enter', 0.64))).selectedSymbols,
    ).toEqual([])
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
      Result.isFailure(decideJevEntry(nativeJevDecisionEvidence(nativeJevFixture(JevPurpose.Manage), 'hold'))),
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
        planVersion: JevBatchPlanVersion.V3,
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
    ).toBe(Date.parse(historical.evidence.batchPlan.expiresAt))
  })

  test('retained version-two entry decisions keep their original batch-bound quote deadline', () => {
    const fixture = nativeJevFixture()
    const observation = fixture.observation.payload
    const observed = Date.parse(observation.observedAt)
    const batchPlan = Result.getOrThrow(
      makeJevTradingSignalBatch({
        observation,
        expiresAt: new Date(observed + 10_000).toISOString(),
        planVersion: JevBatchPlanVersion.V2,
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
    expect(
      Result.getOrThrow(Schema.decodeUnknownResult(JevEntryTargetSchema)(JSON.parse(JSON.stringify(target)))),
    ).toEqual(target)
    const quoteEventAt = new Date(observed + 7_100).toISOString()
    const maximumAgeMs = jevEntryQuoteMaximumAgeMs(target, quoteEventAt, fixture.protocol.maximumQuoteAgeMs)
    expect(maximumAgeMs).toBe(2_900)
    expect(entryQuoteExpiresAtMillis({ eventAt: quoteEventAt, maximumAgeMs })).toBe(observed + 10_000)
  })

  test('the held position can request an exit, while weaker or hold evidence retains it', () => {
    const fixture = nativeJevFixture(JevPurpose.Manage)
    expect(Result.getOrThrow(decideJevManagement(nativeJevDecisionEvidence(fixture, 'exit')))).toMatchObject({
      symbol: 'AAPL',
      action: JevManagementAction.Exit,
    })
    expect(Result.getOrThrow(decideJevManagement(nativeJevDecisionEvidence(fixture, 'hold'))).action).toBe(
      JevManagementAction.Hold,
    )
    expect(Result.getOrThrow(decideJevManagement(nativeJevDecisionEvidence(fixture, 'exit', 0.64))).action).toBe(
      JevManagementAction.Hold,
    )
    expect(Result.isFailure(decideJevManagement(nativeJevDecisionEvidence()))).toBe(true)
  })

  test('management replay rejects an altered action, position, cycle or entry document', () => {
    const decision = Result.getOrThrow(
      decideJevManagement(nativeJevDecisionEvidence(nativeJevFixture(JevPurpose.Manage), 'hold')),
    )
    expect(
      Result.getOrThrow(Schema.decodeUnknownResult(JevManagementDecisionSchema)(JSON.parse(JSON.stringify(decision)))),
    ).toEqual(decision)
    for (const change of [
      { action: JevManagementAction.Exit },
      { symbol: 'AMZN' },
      { cycleId: '0'.repeat(64) },
      { entryDecisionHash: '0'.repeat(64) },
    ])
      expect(
        Result.isFailure(Schema.decodeUnknownResult(JevManagementDecisionSchema)({ ...decision, ...change })),
      ).toBe(true)
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
    expect(batch.candidates.map(({ symbol }) => symbol)).toEqual([...fixture.protocol.candidateSymbols])
    expect(Result.getOrThrow(reproduceJevTradingSignalBatch(fixture.observation.payload, batch))).toEqual(batch)
    for (const candidate of batch.candidates) {
      if (candidate.status !== JevCandidatePlanStatus.Requested)
        throw new Error('Expected a requested fixture candidate')
      expect(candidate.request.request.state).toMatchObject({
        schemaVersion: 'bayn.jev-trading-signal-state.v2',
        position: null,
        task: { decisionPurpose: JevPurpose.Entry },
      })
    }
  })

  test('management uses actual partial fills, cost, held time and remaining horizon for the held symbol', () => {
    const fixture = nativeJevFixture(JevPurpose.Manage)
    const batch = batchFor(fixture)
    expect(batch.candidates.map(({ symbol }) => symbol)).toEqual(['AAPL'])
    const candidate = batch.candidates[0]
    if (candidate?.status !== JevCandidatePlanStatus.Requested) throw new Error('Expected a management request')
    expect(candidate.request.request.state).toMatchObject({
      task: { decisionPurpose: JevPurpose.Manage },
      position: {
        symbol: 'AAPL',
        quantityShares: 5,
        costBasisUsd: 500,
        averageEntryPriceUsd: 100,
        heldForMinutes: 3,
        remainingHoldingMinutes: 12,
        unrealizedPnlAtBidUsd: 9.95,
        unrealizedPnlAtBidBps: 199,
      },
    })
    expect(candidate.request.request.questions['action']?.criteria).toHaveProperty('hold')
    expect(candidate.request.request.questions['action']?.criteria).toHaveProperty('exit')
    expect(Result.getOrThrow(reproduceJevTradingSignalBatch(fixture.observation.payload, batch))).toEqual(batch)
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
          planVersion: JevBatchPlanVersion.V1,
        }),
      ),
    ).toBe(true)
  })

  test('the development protocol covers all available non-benchmark symbols without changing broker execution terms', () => {
    const protocol = Result.getOrThrow(decodeJevProtocol(defaultJevProtocolDocument))
    expect(protocol.candidateSymbols).toHaveLength(15)
    expect(protocol.maximumPositions).toBe(1)
    expect(protocol.executionModel.order.timeInForce).toBe('ioc')
    expect(Result.isFailure(decodeJevProtocol({ ...protocol, candidateSymbols: ['AAPL', 'AAPL'] }))).toBe(true)
    expect(Result.isFailure(decodeJevProtocol({ ...protocol, maximumSymbolWeight: 1 }))).toBe(true)
  })
})
