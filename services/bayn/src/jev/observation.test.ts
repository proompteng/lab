import { describe, expect, test } from 'bun:test'
import { Result } from 'effect'

import { reconciledStateHash } from '../simulation-reconciliation/broker-model'
import { constructStreamingSnapshot } from '../market-data/streaming/snapshot'
import { nativeJevFixture } from './native.test-support'
import { makeOwnedJevObservation, reproduceJevCandidateObservation } from './observation'
import { JevObservationCheck, JevObservationField } from './observation-diagnostics'
import { decodeJevPortfolio } from './portfolio'
import { JevBatchPlanVersion } from './batch'
import { makeJevTradingSignalBatch, prepareJevTradingSignalBatch } from './trading-signals'

const withBrokerTime = (field: JevObservationField, ageMs: number) => {
  const { observation } = nativeJevFixture()
  const payload = observation.payload
  const at = new Date(Date.parse(payload.observedAt) - ageMs).toISOString()
  const original = payload.portfolio.brokerState
  const wholeCut = field === JevObservationField.Reconciliation && ageMs >= 0
  const state = {
    ...original,
    account: { ...original.account, ...(wholeCut || field === JevObservationField.Account ? { observedAt: at } : {}) },
    ...(wholeCut || field === JevObservationField.Positions ? { positionsObservedAt: at } : {}),
    ...(wholeCut || field === JevObservationField.Orders ? { ordersObservedAt: at } : {}),
  }
  const hash = Result.getOrThrow(reconciledStateHash(state))
  return {
    ...payload,
    portfolio: {
      ...payload.portfolio,
      brokerState: {
        ...state,
        reconciliation: {
          ...state.reconciliation,
          expectedHash: hash,
          observedHash: hash,
          ...(field === JevObservationField.Reconciliation || ageMs < 0 ? { reconciledAt: at } : {}),
        },
      },
    },
  }
}

const failure = (input: unknown) => {
  const result = reproduceJevCandidateObservation(input)
  expect(Result.isFailure(result)).toBe(true)
  if (Result.isSuccess(result)) throw new Error('Invalid fixture unexpectedly passed')
  return result.failure
}

describe('bounded Jev observation diagnostics', () => {
  test('does not alter accepted bytes, content identity or the freshness boundary', () => {
    const { observation } = nativeJevFixture()
    expect(Result.getOrThrow(reproduceJevCandidateObservation(observation.payload)).contentHash).toBe(
      observation.contentHash,
    )
    expect(
      Result.isSuccess(reproduceJevCandidateObservation(withBrokerTime(JevObservationField.Account, 10_000))),
    ).toBe(true)
  })

  test.each([JevObservationField.Account, JevObservationField.Positions, JevObservationField.Orders])(
    'identifies stale %s evidence without exposing account data',
    (field) => {
      const error = failure(withBrokerTime(field, 60_000))
      expect(error.observationCheck).toBe(JevObservationCheck.PortfolioStale)
      expect(error.observationField).toBe(field)
      expect(error.message).toContain(`[PORTFOLIO_STALE:${field}]`)
      expect(error.message).not.toContain('jev-native-test')
    },
  )

  test('separates premature reconciliation from stale observations', () => {
    const error = failure(withBrokerTime(JevObservationField.Reconciliation, -1))
    expect(error.observationCheck).toBe(JevObservationCheck.PortfolioPremature)
    expect(error.observationField).toBe(JevObservationField.Reconciliation)
  })

  test('preserves source errors as causes without leaking their raw content into the top-level message', () => {
    const error = failure({ privateAccount: 'do-not-log-this' })
    expect(error.observationCheck).toBe(JevObservationCheck.Schema)
    expect(error.cause).toBeDefined()
    expect(error.message).not.toContain('do-not-log-this')
    const { observation } = nativeJevFixture()
    expect(failure({ ...observation.payload, rows: { bars: [], quotes: [], trades: [] } }).observationCheck).toBe(
      JevObservationCheck.Snapshot,
    )
  })

  test('reports substituted observation time and protocol evidence independently', () => {
    const { observation } = nativeJevFixture()
    const payload = observation.payload
    expect(
      failure({ ...payload, observedAt: new Date(Date.parse(payload.observedAt) + 1).toISOString() }).observationCheck,
    ).toBe(JevObservationCheck.ObservationTime)
    const { candidateEvidencePolicy: _policy, ...protocol } = payload.protocol
    expect(failure({ ...payload, protocol }).observationCheck).toBe(JevObservationCheck.Schema)
  })
})

describe('owned Jev preparation', () => {
  test('reuses the exact immutable inputs and reproduces the independently verified plan', () => {
    const { input, observation, protocol } = nativeJevFixture()
    const owned = Result.getOrThrow(makeOwnedJevObservation(input))
    expect(owned.verified.portfolio).toBe(input.portfolio)
    expect(owned.verified.snapshot).toBe(input.snapshot)
    expect(owned.payload).toEqual(observation.payload)
    expect(owned.verified.contentHash).toBe(observation.contentHash)
    const expiresAt = new Date(Date.parse(observation.payload.observedAt) + protocol.inferenceValidityMs).toISOString()
    const planVersion = JevBatchPlanVersion.V8
    const prepared = Result.getOrThrow(prepareJevTradingSignalBatch(owned, expiresAt, planVersion))
    expect(prepared.plan).toEqual(
      Result.getOrThrow(makeJevTradingSignalBatch({ observation: observation.payload, expiresAt, planVersion })),
    )
  })

  test('detaches verified portfolio material and rejects a changed account or copied snapshot', () => {
    const { input, snapshot } = nativeJevFixture()
    const supplied = structuredClone(input.portfolio)
    const verified = Result.getOrThrow(decodeJevPortfolio(supplied))
    expect(Reflect.set(supplied.brokerState.account, 'cashMicros', '1')).toBe(true)
    expect(Reflect.set(verified.brokerState.account, 'cashMicros', '1')).toBe(false)
    expect(verified.brokerState.account.cashMicros).toBe(input.portfolio.brokerState.account.cashMicros)
    expect(makeOwnedJevObservation({ ...input, portfolio: supplied })).toMatchObject({
      failure: { observationCheck: JevObservationCheck.Schema },
    })
    expect(Reflect.set(snapshot.manifest.streaming, 'sequence', 0)).toBe(false)
    expect(makeOwnedJevObservation({ ...input, snapshot: { ...snapshot } })).toMatchObject({
      failure: { observationCheck: JevObservationCheck.Snapshot },
    })
    let reads = 0
    const prepared = Result.getOrThrow(
      makeOwnedJevObservation({
        ...input,
        get snapshot() {
          return reads++ === 0 ? snapshot : { ...snapshot }
        },
      }),
    )
    expect(prepared.verified.snapshot).toBe(snapshot)
    expect(reads).toBe(1)
  })

  test('malformed source bounds and deliveries cannot issue an owned market snapshot', () => {
    const { cut, query } = nativeJevFixture()
    const [position] = cut.positions
    const [entry] = cut.projection.bars
    if (position === undefined || entry === undefined) throw new Error('Expected native source positions and bars')
    const [symbol, records] = entry
    const [first, second] = records
    if (first === undefined || second === undefined) throw new Error('Expected two recorded bars')
    const bars = new Map(cut.projection.bars).set(symbol, [
      { ...first, sequence: second.sequence },
      ...records.slice(1),
    ])
    for (const invalid of [
      { ...cut, positions: cut.positions.toReversed() },
      { ...cut, positions: [...cut.positions, position] },
      { ...cut, bootstrap: { ...cut.bootstrap, partitions: cut.bootstrap.partitions.toReversed() } },
      { ...cut, bootstrap: { ...cut.bootstrap, epoch: '' }, projection: { ...cut.projection, epoch: '' } },
      { ...cut, projection: { ...cut.projection, bars } },
    ]) {
      expect(constructStreamingSnapshot(invalid, query)).toMatchObject({ failure: { reason: 'watermark' } })
    }
  })
})

test.each([
  JevObservationField.Account,
  JevObservationField.Positions,
  JevObservationField.Orders,
  JevObservationField.Reconciliation,
])('accepts a reconciled cached %s observation without applying the quote lifetime', (field) => {
  expect(Result.isSuccess(reproduceJevCandidateObservation(withBrokerTime(field, 23_039)))).toBe(true)
  expect(Result.isSuccess(reproduceJevCandidateObservation(withBrokerTime(field, 59_999)))).toBe(true)
})
