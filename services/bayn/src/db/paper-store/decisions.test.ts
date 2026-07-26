import { describe, expect, test } from 'bun:test'

import { Result } from 'effect'

import type { BrokerEventInput, PositionEventInput, PositionSnapshotInput } from '../../broker/observations'
import { canonicalHashV1 } from '../../hash'
import { AccountStatus, Broker } from '../../paper'
import {
  decideBrokerEventAppend,
  decideNextSourceSequence,
  decidePositionSnapshotInsert,
  decidePredecessorCoverage,
  decideStoredValuation,
  finishPositionSnapshot,
  planPositionSnapshot,
  planValuation,
  requireValuationPositionSnapshot,
  validateStoredPositionSnapshot,
  type PaperStoreDecisionFailure,
} from './decisions'
import type { EventRow, PositionRow, PositionSnapshotRow } from './rows'

const accountId = 'paper-account-1'
const occurredAt = '2026-07-22T15:30:00.000Z'
const observedAt = '2026-07-22T15:30:01.000Z'
const hash = (value: string): string => canonicalHashV1({ value })

const value = <A, E>(result: Result.Result<A, E>): A => {
  expect(Result.isSuccess(result)).toBe(true)
  if (Result.isFailure(result)) return expect.unreachable('expected a successful PaperStore decision')
  return result.success
}

const failure = <A>(result: Result.Result<A, PaperStoreDecisionFailure>): PaperStoreDecisionFailure => {
  expect(Result.isFailure(result)).toBe(true)
  if (Result.isSuccess(result)) return expect.unreachable('expected a failed PaperStore decision')
  return result.failure
}

const accountEvent = (): Extract<BrokerEventInput, { readonly _tag: 'Account' }> => ({
  _tag: 'Account',
  broker: Broker.Alpaca,
  accountId,
  sourceEventId: 'account-response-1',
  contentHash: hash('account-response-1'),
  occurredAt,
  observedAt,
  account: {
    schemaVersion: 'bayn.paper-account-snapshot.v1',
    accountId,
    status: AccountStatus.Active,
    currency: 'USD',
    cashMicros: '1000000000',
    equityMicros: '1150000000',
    buyingPowerMicros: '2000000000',
    observedAt,
  },
})

const positionEvent = (
  sourceHash: string,
  assetId: string,
  symbol: string,
  marketValueMicros: string,
): PositionEventInput => ({
  _tag: 'Position',
  broker: Broker.Alpaca,
  accountId,
  sourceEventId: `position:${sourceHash}:${observedAt}:${assetId}`,
  contentHash: hash(`position:${assetId}`),
  occurredAt: observedAt,
  observedAt,
  position: {
    schemaVersion: 'bayn.paper-position.v1',
    accountId,
    symbol,
    quantityMicros: marketValueMicros.startsWith('-') ? '-500000' : '2000000',
    averageEntryPriceMicros: '100000000',
    marketPriceMicros: '100000000',
    marketValueMicros,
    unrealizedPnlMicros: '0',
    observedAt,
  },
})

const positionSnapshot = (): PositionSnapshotInput => {
  const sourceHash = hash('positions-response')
  return {
    accountId,
    sourceHash,
    observedAt,
    positions: [
      positionEvent(sourceHash, 'asset-1', 'NVDA', '200000000'),
      positionEvent(sourceHash, 'asset-2', 'AMD', '-50000000'),
    ],
  }
}

describe('PaperStore decisions', () => {
  test('separates broker replay, append, and conflicting source reuse', () => {
    const input = accountEvent()
    const append = value(decideBrokerEventAppend(input, []))
    expect(append).toMatchObject({ _tag: 'AppendBrokerEvent', eventKind: 'ACCOUNT' })
    if (append._tag !== 'AppendBrokerEvent') return expect.unreachable('expected append decision')

    const stored: EventRow = {
      event_id: append.eventId,
      event_kind: append.eventKind,
      content_hash: input.contentHash,
      source_sequence: '7',
    }
    expect(value(decideBrokerEventAppend(input, [stored]))).toEqual({
      _tag: 'ReplayBrokerEvent',
      receipt: { eventId: append.eventId, sourceSequence: '7', deduplicated: true },
    })
    expect(
      failure(decideBrokerEventAppend({ ...input, contentHash: hash('changed-account-response') }, [stored])),
    ).toMatchObject({ failure: 'conflict', message: expect.stringContaining('different content') })
    expect(failure(decideBrokerEventAppend(input, [stored, stored]))).toMatchObject({ failure: 'invariant' })
  })

  test('derives source sequences without a hidden partial bigint conversion', () => {
    expect(value(decideNextSourceSequence('-1'))).toBe('0')
    expect(value(decideNextSourceSequence('9007199254740993'))).toBe('9007199254740994')
    expect(failure(decideNextSourceSequence('not-an-integer'))).toMatchObject({
      failure: 'invariant',
      message: expect.stringContaining('source sequence'),
      cause: expect.anything(),
    })
  })

  test('plans complete position snapshots and rejects duplicate semantic identity', () => {
    const input = positionSnapshot()
    const plan = value(planPositionSnapshot(input))
    expect(plan.eventIds).toEqual([...plan.eventIds].sort())
    expect(plan.snapshotId).toHaveLength(64)
    expect(plan.contentHash).toHaveLength(64)

    const duplicateSymbol: PositionSnapshotInput = {
      ...input,
      positions: [
        input.positions[0],
        { ...input.positions[1], position: { ...input.positions[1].position, symbol: 'NVDA' } },
      ],
    }
    expect(failure(planPositionSnapshot(duplicateSymbol))).toMatchObject({
      failure: 'conflict',
      message: expect.stringContaining('duplicate'),
    })
  })

  test('validates snapshot replay and exact persisted membership', () => {
    const input = positionSnapshot()
    const plan = value(planPositionSnapshot(input))
    const stored: PositionSnapshotRow = {
      snapshot_id: plan.snapshotId,
      schema_version: 'bayn.paper-position-snapshot.v1',
      account_id: input.accountId,
      source_hash: input.sourceHash,
      observed_at: new Date(input.observedAt),
      position_count: plan.eventIds.length,
      content_hash: plan.contentHash,
    }
    expect(value(validateStoredPositionSnapshot(input, plan, [stored]))).toBeUndefined()
    expect(value(decidePositionSnapshotInsert([]))).toBe(true)
    expect(value(decidePositionSnapshotInsert([plan.snapshotId]))).toBe(false)
    expect(
      value(
        finishPositionSnapshot(
          plan,
          plan.eventIds.map((event_id) => ({ event_id })),
          true,
        ),
      ),
    ).toEqual({
      snapshotId: plan.snapshotId,
      eventIds: plan.eventIds,
      deduplicated: true,
    })
    expect(failure(finishPositionSnapshot(plan, [], true))).toMatchObject({ failure: 'conflict' })
  })

  test('derives valuation totals as a pure decision and detects replay drift', () => {
    const input = positionSnapshot()
    const plan = value(planPositionSnapshot(input))
    const snapshot: PositionSnapshotRow = value(
      requireValuationPositionSnapshot([
        {
          snapshot_id: plan.snapshotId,
          schema_version: 'bayn.paper-position-snapshot.v1',
          account_id: accountId,
          source_hash: input.sourceHash,
          observed_at: new Date(observedAt),
          position_count: 2,
          content_hash: plan.contentHash,
        },
      ]),
    )
    const rows: readonly PositionRow[] = input.positions.map((position, index) => ({
      event_id: plan.eventIds[index] ?? expect.unreachable('expected planned event identity'),
      account_id: accountId,
      source_event_id: position.sourceEventId,
      symbol: position.position.symbol,
      market_value_micros: position.position.marketValueMicros,
      observed_at: new Date(observedAt),
    }))
    const valuation = value(
      planValuation(
        { accountEventId: hash('account-event'), positionSnapshotId: plan.snapshotId },
        {
          event_id: hash('account-event'),
          account_id: accountId,
          cash_micros: '1000000000',
          observed_at: new Date(observedAt),
        },
        snapshot,
        rows,
        30_000,
      ),
    )
    expect(valuation).toMatchObject({
      cashMicros: '1000000000',
      longMarketValueMicros: '200000000',
      shortMarketValueMicros: '-50000000',
      equityMicros: '1150000000',
    })
    expect(value(decideStoredValuation([valuation], valuation))).toEqual(valuation)
    expect(failure(decideStoredValuation([{ ...valuation, equityMicros: '1' }], valuation))).toMatchObject({
      failure: 'conflict',
      message: expect.stringContaining('deterministic replay'),
    })
  })

  test('represents predecessor containment as a total Result decision', () => {
    expect(value(decidePredecessorCoverage(false))).toBeUndefined()
    expect(failure(decidePredecessorCoverage(true))).toMatchObject({
      failure: 'conflict',
      message: expect.stringContaining('earlier fill'),
    })
  })
})
