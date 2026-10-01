import { describe, expect, test } from 'bun:test'
import { Result } from 'effect'

import { reconciledStateHash } from '../reconciliation'
import { nativeJevFixture } from './native.test-support'
import { reproduceJevCandidateObservation } from './observation'
import { JevObservationCheck, JevObservationField } from './observation-diagnostics'

const withBrokerTime = (field: JevObservationField, ageMs: number) => {
  const { observation } = nativeJevFixture()
  const payload = observation.payload
  const at = new Date(Date.parse(payload.observedAt) - ageMs).toISOString()
  const original = payload.portfolio.brokerState
  const state = {
    ...original,
    account: { ...original.account, ...(field === JevObservationField.Account ? { observedAt: at } : {}) },
    ...(field === JevObservationField.Positions ? { positionsObservedAt: at } : {}),
    ...(field === JevObservationField.Orders ? { ordersObservedAt: at } : {}),
  }
  // Preserve a genuine reconciliation of the altered fixture so the temporal predicate is actually reached.
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
    expect(failure({ ...payload, protocol }).observationCheck).toBe(JevObservationCheck.Feed)
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
