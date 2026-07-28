import { describe, expect, test } from 'bun:test'

import { Result } from 'effect'

import { prepareAccounting } from '../../accounting/domain'
import type { BrokerEventInput, PositionEventInput, PositionSnapshotInput } from '../../broker/observations'
import { canonicalHashV1 } from '../../hash'
import { AccountStatus, Broker, OrderSide, type AccountingReceipt, type Fill } from '../../execution/contracts'
import {
  brokerEventIdResult,
  decideAccountingReceiptReplay,
  decideBrokerEventAppend,
  decideNextSourceSequence,
  decidePositionSnapshotInsert,
  decidePredecessorCoverage,
  decidePreparedAccountingReplay,
  decideStoredValuation,
  finishPositionSnapshot,
  planAccountingReceipt,
  planPositionSnapshot,
  planValuation,
  requireValuationPositionSnapshot,
  validateStoredPositionSnapshot,
  type ExecutionStoreDecisionFailure,
} from './decisions'
import type { EventRow, PositionRow, PositionSnapshotRow } from './rows'

const accountId = 'paper-account-1'
const occurredAt = '2026-07-22T15:30:00.000Z'
const observedAt = '2026-07-22T15:30:01.000Z'
const hash = (value: string): string => canonicalHashV1({ value })

const value = <A, E>(result: Result.Result<A, E>): A => {
  expect(Result.isSuccess(result)).toBe(true)
  if (Result.isFailure(result)) return expect.unreachable('expected a successful ExecutionStore decision')
  return result.success
}

const failure = <A>(result: Result.Result<A, ExecutionStoreDecisionFailure>): ExecutionStoreDecisionFailure => {
  expect(Result.isFailure(result)).toBe(true)
  if (Result.isSuccess(result)) return expect.unreachable('expected a failed ExecutionStore decision')
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

const accountingFill: Fill = {
  schemaVersion: 'bayn.paper-fill.v1',
  accountId,
  fillId: 'fill-1',
  brokerOrderId: 'broker-order-1',
  clientOrderId: 'client-order-1',
  symbol: 'NVDA',
  side: OrderSide.Buy,
  quantityMicros: '1000000',
  priceMicros: '100000000',
  feeMicros: '0',
  occurredAt,
}

const preparedResult = prepareAccounting('a'.repeat(64), accountingFill, { quantityMicros: '0', costMicros: '0' }, 7001)
if (Result.isFailure(preparedResult)) throw new Error(`accounting fixture failed: ${preparedResult.failure._tag}`)
const prepared = preparedResult.success
const receiptPlan = value(planAccountingReceipt(prepared, '1', 7001))
const accountingReceipt: AccountingReceipt = {
  ...receiptPlan,
  recordedAt: observedAt,
}

describe('ExecutionStore decisions', () => {
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
    expect(failure(decideNextSourceSequence('not-an-integer'))).toEqual({
      failure: 'invariant',
      message: 'durable broker source sequence is not an integer',
      cause: {
        _tag: 'ExecutionStoreIntegerFailure',
        source: 'source-sequence',
        value: 'not-an-integer',
      },
    })
  })

  test('returns exact canonicalization failures for broker, snapshot, accounting, and receipt identities', () => {
    const hostileAccount = {
      ...accountEvent(),
      accountId: '\ud800',
      account: { ...accountEvent().account, accountId: '\ud800' },
    }
    expect(failure(brokerEventIdResult(hostileAccount))).toMatchObject({
      failure: 'invariant',
      message: 'broker event identity is not canonicalizable',
      cause: {
        _tag: 'ExecutionStoreHashFailure',
        operation: 'broker-event-id',
        cause: { reason: 'invalid-unicode-surrogate', path: '$.accountId' },
      },
    })

    const hostileSnapshot = positionSnapshot()
    const hostilePositions = hostileSnapshot.positions.map((position) => ({
      ...position,
      accountId: '\ud800',
      position: { ...position.position, accountId: '\ud800' },
    }))
    expect(
      failure(planPositionSnapshot({ ...hostileSnapshot, accountId: '\ud800', positions: hostilePositions })),
    ).toMatchObject({
      failure: 'invariant',
      cause: {
        _tag: 'ExecutionStoreHashFailure',
        operation: 'broker-event-id',
        cause: { reason: 'invalid-unicode-surrogate', path: '$.accountId' },
      },
    })

    expect(
      failure(
        decidePreparedAccountingReplay(prepared.transaction, {
          ...prepared,
          transaction: { ...prepared.transaction, accountId: '\ud800' },
        }),
      ),
    ).toMatchObject({
      failure: 'invariant',
      cause: {
        _tag: 'ExecutionStoreHashFailure',
        operation: 'accounting-transaction-candidate',
        cause: { reason: 'invalid-unicode-surrogate', path: '$.accountId' },
      },
    })

    expect(
      failure(
        decideAccountingReceiptReplay(accountingReceipt, {
          ...accountingReceipt,
          accountIds: ['\ud800'],
        }),
      ),
    ).toMatchObject({
      failure: 'invariant',
      cause: {
        _tag: 'ExecutionStoreHashFailure',
        operation: 'accounting-receipt-candidate',
        cause: { reason: 'invalid-unicode-surrogate', path: '$.accountIds[0]' },
      },
    })

    expect(failure(planAccountingReceipt(prepared, '1', Number.NaN))).toMatchObject({
      failure: 'invariant',
      message: 'accounting receipt identity is not canonicalizable',
      cause: {
        _tag: 'ExecutionStoreHashFailure',
        operation: 'accounting-receipt-id',
        cause: { reason: 'non-finite-number', path: '$.tigerBeetleLedger' },
      },
    })

    expect(
      failure(
        planAccountingReceipt({ ...prepared, transaction: { ...prepared.transaction, intentId: '\ud800' } }, '1', 7001),
      ),
    ).toMatchObject({
      failure: 'invariant',
      message: 'accounting receipt content is not canonicalizable',
      cause: {
        _tag: 'ExecutionStoreHashFailure',
        operation: 'accounting-receipt-content',
        cause: { reason: 'invalid-unicode-surrogate', path: '$.intentId' },
      },
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
    expect(
      failure(validateStoredPositionSnapshot(input, plan, [{ ...stored, observed_at: new Date(Number.NaN) }])),
    ).toEqual({
      failure: 'invariant',
      message: 'valuation timestamp evidence is invalid',
      cause: {
        _tag: 'ExecutionStoreTimestampFailure',
        source: 'stored-position-snapshot-observed-at',
        epochMillis: Number.NaN,
      },
    })
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
    expect(
      failure(
        planValuation(
          { accountEventId: hash('account-event'), positionSnapshotId: plan.snapshotId },
          {
            event_id: hash('account-event'),
            account_id: accountId,
            cash_micros: 'not-an-integer',
            observed_at: new Date(observedAt),
          },
          snapshot,
          rows,
          30_000,
        ),
      ),
    ).toEqual({
      failure: 'invariant',
      message: 'valuation account cash is invalid',
      cause: {
        _tag: 'ExecutionStoreIntegerFailure',
        source: 'account-cash',
        value: 'not-an-integer',
      },
    })
    expect(
      failure(
        planValuation(
          { accountEventId: hash('account-event'), positionSnapshotId: plan.snapshotId },
          {
            event_id: hash('account-event'),
            account_id: accountId,
            cash_micros: '1000000000',
            observed_at: new Date(observedAt),
          },
          snapshot,
          [{ ...rows[0]!, market_value_micros: 'invalid-market-value' }, rows[1]!],
          30_000,
        ),
      ),
    ).toMatchObject({
      failure: 'invariant',
      message: 'valuation position market value is invalid',
      cause: {
        _tag: 'ExecutionStoreIntegerFailure',
        source: 'position-market-value',
        value: 'invalid-market-value',
        eventId: rows[0]?.event_id,
        symbol: rows[0]?.symbol,
      },
    })
    expect(
      failure(
        planValuation(
          { accountEventId: hash('account-event'), positionSnapshotId: plan.snapshotId },
          {
            event_id: hash('account-event'),
            account_id: accountId,
            cash_micros: '1000000000',
            observed_at: new Date(Number.NaN),
          },
          snapshot,
          rows,
          30_000,
        ),
      ),
    ).toEqual({
      failure: 'invariant',
      message: 'valuation timestamp evidence is invalid',
      cause: {
        _tag: 'ExecutionStoreTimestampFailure',
        source: 'account-observed-at',
        epochMillis: Number.NaN,
      },
    })
    expect(failure(decideStoredValuation([{ ...valuation, accountId: '\ud800' }], valuation))).toMatchObject({
      failure: 'invariant',
      cause: {
        _tag: 'ExecutionStoreHashFailure',
        operation: 'valuation-stored',
        cause: { reason: 'invalid-unicode-surrogate', path: '$.accountId' },
      },
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
