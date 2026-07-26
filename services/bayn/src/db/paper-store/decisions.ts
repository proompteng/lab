import { Result } from 'effect'

import type { PreparedAccounting } from '../../accounting/model'
import type { AccountingTransaction } from '../../accounting/schema'
import type { BrokerEventInput, PositionSnapshotInput, ValuationInput } from '../../broker/observations'
import { canonicalHashV1 } from '../../hash'
import { utcInstantFromEpochMillis } from '../../time'
import type { AccountingReceipt, Valuation } from '../../paper'
import type { EventReceipt, PositionSnapshotReceipt } from './contract'
import type { AccountRow, EventIdRow, EventRow, PositionRow, PositionSnapshotRow } from './rows'
import { EventKind } from './rows'

export interface PaperStoreDecisionFailure {
  readonly failure: 'conflict' | 'invariant'
  readonly message: string
  readonly cause?: unknown
}

const fail = (
  failure: PaperStoreDecisionFailure['failure'],
  message: string,
  cause?: unknown,
): Result.Result<never, PaperStoreDecisionFailure> => Result.fail({ failure, message, cause })

export const brokerEventKind = (input: BrokerEventInput): typeof EventKind.Type => {
  switch (input._tag) {
    case 'Account':
      return 'ACCOUNT'
    case 'Position':
      return 'POSITION'
    case 'Order':
      return 'ORDER'
    case 'Fill':
      return 'FILL'
  }
}

export const brokerEventId = (input: BrokerEventInput): string =>
  canonicalHashV1({
    schemaVersion: 'bayn.paper-broker-event-id.v1',
    broker: input.broker,
    accountId: input.accountId,
    sourceEventId: input.sourceEventId,
    contentHash: input.contentHash,
  })

export type BrokerEventAppendDecision =
  | { readonly _tag: 'ReplayBrokerEvent'; readonly receipt: EventReceipt }
  | {
      readonly _tag: 'AppendBrokerEvent'
      readonly eventId: string
      readonly eventKind: typeof EventKind.Type
    }

export const decideBrokerEventAppend = (
  input: BrokerEventInput,
  existing: readonly EventRow[],
): Result.Result<BrokerEventAppendDecision, PaperStoreDecisionFailure> => {
  if (existing.length > 1) return fail('invariant', 'broker source identity is not unique')
  const found = existing[0]
  const eventKind = brokerEventKind(input)
  if (found === undefined) {
    return Result.succeed({ _tag: 'AppendBrokerEvent', eventId: brokerEventId(input), eventKind })
  }
  if (found.event_kind !== eventKind || found.content_hash !== input.contentHash) {
    return fail('conflict', 'broker source identity was reused with different content')
  }
  return Result.succeed({
    _tag: 'ReplayBrokerEvent',
    receipt: {
      eventId: found.event_id,
      sourceSequence: found.source_sequence,
      deduplicated: true,
    },
  })
}

export const decideNextSourceSequence = (lastSequence: string): Result.Result<string, PaperStoreDecisionFailure> =>
  Result.mapError(
    Result.try(() => (BigInt(lastSequence) + 1n).toString()),
    (cause) => ({
      failure: 'invariant' as const,
      message: 'durable broker source sequence is not an integer',
      cause,
    }),
  )

export interface PositionSnapshotPlan {
  readonly snapshotId: string
  readonly contentHash: string
  readonly eventIds: readonly string[]
}

export const planPositionSnapshot = (
  input: PositionSnapshotInput,
): Result.Result<PositionSnapshotPlan, PaperStoreDecisionFailure> => {
  const sourcePrefix = `position:${input.sourceHash}:${input.observedAt}:`
  if (
    input.positions.some(
      (position) =>
        position.accountId !== input.accountId ||
        position.position.accountId !== input.accountId ||
        position.observedAt !== input.observedAt ||
        position.position.observedAt !== input.observedAt ||
        !position.sourceEventId.startsWith(sourcePrefix) ||
        position.sourceEventId.length === sourcePrefix.length,
    )
  ) {
    return fail('conflict', 'position snapshot identity is inconsistent')
  }
  const sourceIds = input.positions.map((position) => position.sourceEventId)
  const symbols = input.positions.map((position) => position.position.symbol)
  if (new Set(sourceIds).size !== sourceIds.length || new Set(symbols).size !== symbols.length) {
    return fail('conflict', 'position snapshot contains a duplicate source or symbol')
  }
  const eventIds = input.positions.map(brokerEventId).sort()
  const snapshotId = canonicalHashV1({
    schemaVersion: 'bayn.paper-position-snapshot-id.v1',
    accountId: input.accountId,
    sourceHash: input.sourceHash,
    observedAt: input.observedAt,
  })
  return Result.succeed({
    snapshotId,
    eventIds,
    contentHash: canonicalHashV1({
      schemaVersion: 'bayn.paper-position-snapshot.v1',
      accountId: input.accountId,
      sourceHash: input.sourceHash,
      observedAt: input.observedAt,
      eventIds,
    }),
  })
}

export const decidePositionSnapshotInsert = (
  insertedSnapshotIds: readonly string[],
): Result.Result<boolean, PaperStoreDecisionFailure> =>
  insertedSnapshotIds.length > 1
    ? fail('invariant', 'position snapshot insert returned multiple rows')
    : Result.succeed(insertedSnapshotIds.length === 0)

export const validateStoredPositionSnapshot = (
  input: PositionSnapshotInput,
  plan: PositionSnapshotPlan,
  snapshots: readonly PositionSnapshotRow[],
): Result.Result<void, PaperStoreDecisionFailure> => {
  if (snapshots.length !== 1) return fail('invariant', 'position snapshot was not persisted exactly once')
  const stored = snapshots[0]
  if (
    stored === undefined ||
    stored.snapshot_id !== plan.snapshotId ||
    stored.account_id !== input.accountId ||
    stored.source_hash !== input.sourceHash ||
    stored.observed_at.toISOString() !== input.observedAt ||
    stored.position_count !== plan.eventIds.length ||
    stored.content_hash !== plan.contentHash
  ) {
    return fail('conflict', 'stored position snapshot differs from replay')
  }
  return Result.succeed(undefined)
}

export const finishPositionSnapshot = (
  plan: PositionSnapshotPlan,
  storedEvents: readonly EventIdRow[],
  deduplicated: boolean,
): Result.Result<PositionSnapshotReceipt, PaperStoreDecisionFailure> => {
  const storedEventIds = storedEvents.map((row) => row.event_id)
  if (
    storedEventIds.length !== plan.eventIds.length ||
    storedEventIds.some((eventId, index) => eventId !== plan.eventIds[index])
  ) {
    return fail('conflict', 'stored position snapshot membership is incomplete')
  }
  return Result.succeed({ snapshotId: plan.snapshotId, eventIds: plan.eventIds, deduplicated })
}

export const decidePredecessorCoverage = (unresolved: boolean): Result.Result<void, PaperStoreDecisionFailure> =>
  unresolved ? fail('conflict', 'an earlier fill has not been posted to TigerBeetle') : Result.succeed(undefined)

export const decideSuccessorAbsence = (unresolved: boolean): Result.Result<void, PaperStoreDecisionFailure> =>
  unresolved
    ? fail('conflict', 'a later fill was already accounted before this economic predecessor')
    : Result.succeed(undefined)

export const decidePreparedTransaction = (
  transactions: readonly AccountingTransaction[],
): Result.Result<AccountingTransaction | undefined, PaperStoreDecisionFailure> => {
  if (transactions.length > 1) return fail('invariant', 'fill has multiple accounting transactions')
  return Result.succeed(transactions[0])
}

export const decidePreparedAccountingReplay = (
  stored: AccountingTransaction | undefined,
  expected: PreparedAccounting,
): Result.Result<PreparedAccounting, PaperStoreDecisionFailure> =>
  stored === undefined || canonicalHashV1(stored) === canonicalHashV1(expected.transaction)
    ? Result.succeed(expected)
    : fail('conflict', 'stored accounting plan differs from deterministic replay')

export const decideAccountingReceipt = (
  receipts: readonly AccountingReceipt[],
): Result.Result<AccountingReceipt | undefined, PaperStoreDecisionFailure> => {
  if (receipts.length > 1) return fail('invariant', 'fill has multiple accounting receipts')
  return Result.succeed(receipts[0])
}

export const stableAccountingReceipt = (receipt: AccountingReceipt) => ({
  schemaVersion: receipt.schemaVersion,
  receiptId: receipt.receiptId,
  ...(receipt.intentId === undefined ? {} : { intentId: receipt.intentId }),
  brokerEventId: receipt.brokerEventId,
  tigerBeetleClusterId: receipt.tigerBeetleClusterId,
  tigerBeetleLedger: receipt.tigerBeetleLedger,
  accountIds: receipt.accountIds,
  transferIds: receipt.transferIds,
  debitMicros: receipt.debitMicros,
  creditMicros: receipt.creditMicros,
  contentHash: receipt.contentHash,
})

export const decideAccountingReceiptReplay = (
  stored: AccountingReceipt | undefined,
  candidate: AccountingReceipt,
): Result.Result<AccountingReceipt, PaperStoreDecisionFailure> => {
  if (stored === undefined) return fail('invariant', 'accounting receipt was not persisted')
  return canonicalHashV1(stableAccountingReceipt(stored)) === canonicalHashV1(stableAccountingReceipt(candidate))
    ? Result.succeed(stored)
    : fail('conflict', 'stored accounting receipt differs from deterministic replay')
}

export const planValuation = (
  input: ValuationInput,
  accountSnapshot: AccountRow,
  positionSnapshot: PositionSnapshotRow,
  positionRows: readonly PositionRow[],
  maximumSkewMs: number,
): Result.Result<Valuation, PaperStoreDecisionFailure> => {
  if (positionSnapshot.account_id !== accountSnapshot.account_id) {
    return fail('conflict', 'valuation snapshots belong to different accounts')
  }
  if (positionRows.length !== positionSnapshot.position_count) {
    return fail('conflict', 'valuation position snapshot is incomplete')
  }
  const positionsObservedAt = positionSnapshot.observed_at.toISOString()
  const positionSourcePrefix = `position:${positionSnapshot.source_hash}:${positionsObservedAt}:`
  if (
    positionRows.some(
      (position) =>
        position.account_id !== accountSnapshot.account_id ||
        position.observed_at.toISOString() !== positionsObservedAt ||
        !position.source_event_id.startsWith(positionSourcePrefix) ||
        position.source_event_id.length === positionSourcePrefix.length,
    )
  ) {
    return fail('conflict', 'valuation snapshots disagree on source, account, or time')
  }
  if (new Set(positionRows.map((position) => position.symbol)).size !== positionRows.length) {
    return fail('conflict', 'valuation position symbols are not unique')
  }
  const accountObservedAt = accountSnapshot.observed_at.toISOString()
  const accountTime = accountSnapshot.observed_at.getTime()
  const positionTime = positionSnapshot.observed_at.getTime()
  if (Math.abs(accountTime - positionTime) > maximumSkewMs) {
    return fail('conflict', 'valuation snapshots exceed the maximum observation skew')
  }
  return Result.mapError(
    Result.try(() => {
      const cash = BigInt(accountSnapshot.cash_micros)
      const marketValues = positionRows.map((position) => BigInt(position.market_value_micros))
      const longMarketValue = marketValues.filter((value) => value >= 0n).reduce((sum, value) => sum + value, 0n)
      const shortMarketValue = marketValues.filter((value) => value < 0n).reduce((sum, value) => sum + value, 0n)
      const sourceHash = canonicalHashV1({
        schemaVersion: 'bayn.paper-valuation-source.v1',
        accountEventId: input.accountEventId,
        positionSnapshotId: positionSnapshot.snapshot_id,
        positionEventIds: positionRows.map((position) => position.event_id),
        positionsSourceHash: positionSnapshot.source_hash,
        accountObservedAt,
        positionsObservedAt,
      })
      return {
        schemaVersion: 'bayn.paper-valuation.v1' as const,
        valuationId: canonicalHashV1({
          schemaVersion: 'bayn.paper-valuation-id.v1',
          accountId: accountSnapshot.account_id,
          sourceHash,
        }),
        accountId: accountSnapshot.account_id,
        sourceHash,
        cashMicros: cash.toString(),
        longMarketValueMicros: longMarketValue.toString(),
        shortMarketValueMicros: shortMarketValue.toString(),
        equityMicros: (cash + longMarketValue + shortMarketValue).toString(),
        asOf: utcInstantFromEpochMillis(Math.max(accountTime, positionTime)),
      }
    }),
    (cause) => ({
      failure: 'invariant' as const,
      message: 'valuation numeric evidence is invalid',
      cause,
    }),
  )
}

export const requireValuationPositionSnapshot = (
  positionSnapshots: readonly PositionSnapshotRow[],
): Result.Result<PositionSnapshotRow, PaperStoreDecisionFailure> => {
  const snapshot = positionSnapshots[0]
  return positionSnapshots.length === 1 && snapshot !== undefined
    ? Result.succeed(snapshot)
    : fail('conflict', 'valuation position snapshot does not exist')
}

export const decideStoredValuation = (
  storedValuations: readonly Valuation[],
  candidate: Valuation,
): Result.Result<Valuation, PaperStoreDecisionFailure> => {
  if (storedValuations.length !== 1) return fail('invariant', 'valuation was not persisted')
  const stored = storedValuations[0]
  if (stored === undefined) return fail('invariant', 'valuation was not persisted')
  return canonicalHashV1(stored) === canonicalHashV1(candidate)
    ? Result.succeed(stored)
    : fail('conflict', 'stored valuation differs from deterministic replay')
}
