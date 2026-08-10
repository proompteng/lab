import { pipe, Result } from 'effect'

import type { PreparedAccounting } from '../../accounting/model'
import type { AccountingTransaction } from '../../accounting/schema'
import type { BrokerEventInput, PositionSnapshotInput, ValuationInput } from '../../broker/observations'
import { canonicalHashV1, canonicalHashV1Result, type CanonicalHashFailure } from '../../hash'
import type { AccountingReceipt, Valuation } from '../../execution/contracts'
import type { EventReceipt, PositionSnapshotReceipt } from './contract'
import type { AccountRow, EventIdRow, EventRow, PositionRow, PositionSnapshotRow } from './rows'
import { EventKind } from './rows'
import { Pipeable } from '../../pipeable'
import { utcInstantFromEpochMillisResult } from '../../time'

export interface ExecutionStoreDecisionFailure {
  readonly failure: 'conflict' | 'invariant'
  readonly message: string
  readonly cause?: unknown
}

type ExecutionStoreHashOperation =
  | 'broker-event-id'
  | 'position-snapshot-id'
  | 'position-snapshot-content'
  | 'accounting-transaction-stored'
  | 'accounting-transaction-candidate'
  | 'accounting-receipt-id'
  | 'accounting-receipt-content'
  | 'accounting-receipt-stored'
  | 'accounting-receipt-candidate'
  | 'valuation-source'
  | 'valuation-id'
  | 'valuation-stored'
  | 'valuation-candidate'

type ExecutionStoreIntegerSource = 'source-sequence' | 'account-cash' | 'position-market-value'

interface ExecutionStoreHashFailure {
  readonly _tag: 'ExecutionStoreHashFailure'
  readonly operation: ExecutionStoreHashOperation
  readonly cause: CanonicalHashFailure
}

interface ExecutionStoreIntegerFailure {
  readonly _tag: 'ExecutionStoreIntegerFailure'
  readonly source: ExecutionStoreIntegerSource
  readonly value: string
  readonly eventId?: string
  readonly symbol?: string
}

interface ExecutionStoreTimestampFailure {
  readonly _tag: 'ExecutionStoreTimestampFailure'
  readonly source:
    | 'stored-position-snapshot-observed-at'
    | 'account-observed-at'
    | 'position-observed-at'
    | 'position-row-observed-at'
    | 'valuation-as-of'
  readonly epochMillis: number
}

const fail = (
  failure: ExecutionStoreDecisionFailure['failure'],
  message: string,
  cause?: unknown,
): Result.Result<never, ExecutionStoreDecisionFailure> => Result.fail({ failure, message, cause })

const hashDecision = (
  operation: ExecutionStoreHashOperation,
  value: unknown,
  message: string,
): Result.Result<string, ExecutionStoreDecisionFailure> =>
  pipe(
    canonicalHashV1Result(value),
    Result.mapError(
      (cause): ExecutionStoreDecisionFailure => ({
        failure: 'invariant',
        message,
        cause: { _tag: 'ExecutionStoreHashFailure', operation, cause } satisfies ExecutionStoreHashFailure,
      }),
    ),
  )

const integerDecision = (
  source: ExecutionStoreIntegerSource,
  value: string,
  message: string,
  facts: Pick<ExecutionStoreIntegerFailure, 'eventId' | 'symbol'> = {},
): Result.Result<bigint, ExecutionStoreDecisionFailure> =>
  /^-?[0-9]+$/.test(value)
    ? Result.succeed(BigInt(value))
    : fail('invariant', message, {
        _tag: 'ExecutionStoreIntegerFailure',
        source,
        value,
        ...(facts.eventId === undefined ? {} : { eventId: facts.eventId }),
        ...(facts.symbol === undefined ? {} : { symbol: facts.symbol }),
      } satisfies ExecutionStoreIntegerFailure)

const timestampDecision = (
  source: ExecutionStoreTimestampFailure['source'],
  epochMillis: number,
): Result.Result<string, ExecutionStoreDecisionFailure> => {
  const instant = utcInstantFromEpochMillisResult(epochMillis)
  return Result.isSuccess(instant)
    ? Result.succeed(instant.success)
    : fail('invariant', 'valuation timestamp evidence is invalid', {
        _tag: 'ExecutionStoreTimestampFailure',
        source,
        epochMillis,
      } satisfies ExecutionStoreTimestampFailure)
}

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

export const brokerEventIdResult = (input: BrokerEventInput): Result.Result<string, ExecutionStoreDecisionFailure> =>
  hashDecision(
    'broker-event-id',
    {
      schemaVersion: 'bayn.paper-broker-event-id.v1',
      broker: input.broker,
      accountId: input.accountId,
      sourceEventId: input.sourceEventId,
      contentHash: input.contentHash,
    },
    'broker event identity is not canonicalizable',
  )

export type BrokerEventAppendDecision =
  | { readonly _tag: 'ReplayBrokerEvent'; readonly receipt: EventReceipt }
  | {
      readonly _tag: 'AppendBrokerEvent'
      readonly eventId: string
      readonly eventKind: typeof EventKind.Type
    }

const decideBrokerEventAppendDataFirst = (
  input: BrokerEventInput,
  existing: readonly EventRow[],
): Result.Result<BrokerEventAppendDecision, ExecutionStoreDecisionFailure> => {
  if (existing.length > 1) return fail('invariant', 'broker source identity is not unique')
  const found = existing[0]
  const eventKind = brokerEventKind(input)
  if (found === undefined) {
    return Result.map(brokerEventIdResult(input), (eventId) => ({ _tag: 'AppendBrokerEvent', eventId, eventKind }))
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

export const decideBrokerEventAppend = Pipeable.dual(2, decideBrokerEventAppendDataFirst)

export const decideNextSourceSequence = (lastSequence: string): Result.Result<string, ExecutionStoreDecisionFailure> =>
  Result.map(
    integerDecision('source-sequence', lastSequence, 'durable broker source sequence is not an integer'),
    (sequence) => (sequence + 1n).toString(),
  )

export interface PositionSnapshotPlan {
  readonly snapshotId: string
  readonly contentHash: string
  readonly eventIds: readonly string[]
}

export const planPositionSnapshot = (
  input: PositionSnapshotInput,
): Result.Result<PositionSnapshotPlan, ExecutionStoreDecisionFailure> =>
  Result.gen(function* () {
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
      return yield* fail('conflict', 'position snapshot identity is inconsistent')
    }
    const sourceIds = input.positions.map((position) => position.sourceEventId)
    const symbols = input.positions.map((position) => position.position.symbol)
    if (new Set(sourceIds).size !== sourceIds.length || new Set(symbols).size !== symbols.length) {
      return yield* fail('conflict', 'position snapshot contains a duplicate source or symbol')
    }
    const eventIds: string[] = []
    for (const position of input.positions) eventIds.push(yield* brokerEventIdResult(position))
    eventIds.sort()
    const snapshotId = yield* hashDecision(
      'position-snapshot-id',
      {
        schemaVersion: 'bayn.paper-position-snapshot-id.v1',
        accountId: input.accountId,
        sourceHash: input.sourceHash,
        observedAt: input.observedAt,
      },
      'position snapshot identity is not canonicalizable',
    )
    const contentHash = yield* hashDecision(
      'position-snapshot-content',
      {
        schemaVersion: 'bayn.paper-position-snapshot.v1',
        accountId: input.accountId,
        sourceHash: input.sourceHash,
        observedAt: input.observedAt,
        eventIds,
      },
      'position snapshot content is not canonicalizable',
    )
    return {
      snapshotId,
      eventIds,
      contentHash,
    }
  })

export const decidePositionSnapshotInsert = (
  insertedSnapshotIds: readonly string[],
): Result.Result<boolean, ExecutionStoreDecisionFailure> =>
  insertedSnapshotIds.length > 1
    ? fail('invariant', 'position snapshot insert returned multiple rows')
    : Result.succeed(insertedSnapshotIds.length === 0)

const validateStoredPositionSnapshotDataFirst = (
  input: PositionSnapshotInput,
  plan: PositionSnapshotPlan,
  snapshots: readonly PositionSnapshotRow[],
): Result.Result<void, ExecutionStoreDecisionFailure> =>
  Result.gen(function* () {
    if (snapshots.length !== 1) {
      return yield* fail('invariant', 'position snapshot was not persisted exactly once')
    }
    const stored = snapshots[0]
    if (stored === undefined) return yield* fail('invariant', 'position snapshot was not persisted exactly once')
    const storedObservedAt = yield* timestampDecision(
      'stored-position-snapshot-observed-at',
      stored.observed_at.getTime(),
    )
    if (
      stored.snapshot_id !== plan.snapshotId ||
      stored.account_id !== input.accountId ||
      stored.source_hash !== input.sourceHash ||
      storedObservedAt !== input.observedAt ||
      stored.position_count !== plan.eventIds.length ||
      stored.content_hash !== plan.contentHash
    ) {
      return yield* fail('conflict', 'stored position snapshot differs from replay')
    }
    return undefined
  })

export const validateStoredPositionSnapshot = Pipeable.dual(3, validateStoredPositionSnapshotDataFirst)

const finishPositionSnapshotDataFirst = (
  plan: PositionSnapshotPlan,
  storedEvents: readonly EventIdRow[],
  deduplicated: boolean,
): Result.Result<PositionSnapshotReceipt, ExecutionStoreDecisionFailure> => {
  const storedEventIds = storedEvents.map((row) => row.event_id)
  if (
    storedEventIds.length !== plan.eventIds.length ||
    storedEventIds.some((eventId, index) => eventId !== plan.eventIds[index])
  ) {
    return fail('conflict', 'stored position snapshot membership is incomplete')
  }
  return Result.succeed({ snapshotId: plan.snapshotId, eventIds: plan.eventIds, deduplicated })
}

export const finishPositionSnapshot = Pipeable.dual(3, finishPositionSnapshotDataFirst)

export const decidePredecessorCoverage = (unresolved: boolean): Result.Result<void, ExecutionStoreDecisionFailure> =>
  unresolved ? fail('conflict', 'an earlier fill has not been posted to TigerBeetle') : Result.succeed(undefined)

export const decideSuccessorAbsence = (unresolved: boolean): Result.Result<void, ExecutionStoreDecisionFailure> =>
  unresolved
    ? fail('conflict', 'a later fill was already accounted before this economic predecessor')
    : Result.succeed(undefined)

export const decidePreparedTransaction = (
  transactions: readonly AccountingTransaction[],
): Result.Result<AccountingTransaction | undefined, ExecutionStoreDecisionFailure> => {
  if (transactions.length > 1) return fail('invariant', 'fill has multiple accounting transactions')
  return Result.succeed(transactions[0])
}

const decidePreparedAccountingReplayDataFirst = (
  stored: AccountingTransaction | undefined,
  expected: PreparedAccounting,
): Result.Result<PreparedAccounting, ExecutionStoreDecisionFailure> =>
  stored === undefined
    ? Result.succeed(expected)
    : Result.gen(function* () {
        const storedHash = yield* hashDecision(
          'accounting-transaction-stored',
          stored,
          'stored accounting transaction is not canonicalizable',
        )
        const candidateHash = yield* hashDecision(
          'accounting-transaction-candidate',
          expected.transaction,
          'candidate accounting transaction is not canonicalizable',
        )
        return storedHash === candidateHash
          ? expected
          : yield* fail('conflict', 'stored accounting plan differs from deterministic replay')
      })

export const decidePreparedAccountingReplay = Pipeable.dual(2, decidePreparedAccountingReplayDataFirst)

export const decideAccountingReceipt = (
  receipts: readonly AccountingReceipt[],
): Result.Result<AccountingReceipt | undefined, ExecutionStoreDecisionFailure> => {
  if (receipts.length > 1) return fail('invariant', 'fill has multiple accounting receipts')
  return Result.succeed(receipts[0])
}

export type AccountingReceiptPlan = Omit<AccountingReceipt, 'recordedAt'>

const planAccountingReceiptDataFirst = (
  prepared: PreparedAccounting,
  tigerBeetleClusterId: string,
  tigerBeetleLedger: number,
): Result.Result<AccountingReceiptPlan, ExecutionStoreDecisionFailure> =>
  Result.gen(function* () {
    const accountIds = prepared.ledger.accounts.map((account) => account.id.toString())
    const transferIds = prepared.ledger.transfers.map((transfer) => transfer.id.toString())
    const postedMicros = prepared.ledger.transfers.reduce((sum, transfer) => sum + transfer.amount, 0n).toString()
    const stable = {
      schemaVersion: 'bayn.paper-accounting-receipt.v1' as const,
      ...(prepared.transaction.intentId === undefined ? {} : { intentId: prepared.transaction.intentId }),
      brokerEventId: prepared.transaction.brokerEventId,
      tigerBeetleClusterId,
      tigerBeetleLedger,
      accountIds,
      transferIds,
      debitMicros: postedMicros,
      creditMicros: postedMicros,
    }
    const receiptId = yield* hashDecision(
      'accounting-receipt-id',
      {
        schemaVersion: 'bayn.paper-accounting-receipt-id.v1',
        brokerEventId: prepared.transaction.brokerEventId,
        tigerBeetleClusterId,
        tigerBeetleLedger,
      },
      'accounting receipt identity is not canonicalizable',
    )
    const contentHash = yield* hashDecision(
      'accounting-receipt-content',
      stable,
      'accounting receipt content is not canonicalizable',
    )
    return { ...stable, receiptId, contentHash }
  })

export const planAccountingReceipt = Pipeable.dual(3, planAccountingReceiptDataFirst)

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

const decideAccountingReceiptReplayDataFirst = (
  stored: AccountingReceipt | undefined,
  candidate: AccountingReceipt,
): Result.Result<AccountingReceipt, ExecutionStoreDecisionFailure> => {
  if (stored === undefined) return fail('invariant', 'accounting receipt was not persisted')
  return Result.gen(function* () {
    const storedHash = yield* hashDecision(
      'accounting-receipt-stored',
      stableAccountingReceipt(stored),
      'stored accounting receipt is not canonicalizable',
    )
    const candidateHash = yield* hashDecision(
      'accounting-receipt-candidate',
      stableAccountingReceipt(candidate),
      'candidate accounting receipt is not canonicalizable',
    )
    return storedHash === candidateHash
      ? stored
      : yield* fail('conflict', 'stored accounting receipt differs from deterministic replay')
  })
}

export const decideAccountingReceiptReplay = Pipeable.dual(2, decideAccountingReceiptReplayDataFirst)

const planValuationDataFirst = (
  input: ValuationInput,
  accountSnapshot: AccountRow,
  positionSnapshot: PositionSnapshotRow,
  positionRows: readonly PositionRow[],
  maximumSkewMs: number,
): Result.Result<Valuation, ExecutionStoreDecisionFailure> =>
  Result.gen(function* () {
    if (positionSnapshot.account_id !== accountSnapshot.account_id) {
      return yield* fail('conflict', 'valuation snapshots belong to different accounts')
    }
    if (positionRows.length !== positionSnapshot.position_count) {
      return yield* fail('conflict', 'valuation position snapshot is incomplete')
    }
    const positionTime = positionSnapshot.observed_at.getTime()
    const positionsObservedAt = yield* timestampDecision('position-observed-at', positionTime)
    const positionSourcePrefix = `position:${positionSnapshot.source_hash}:${positionsObservedAt}:`
    for (const position of positionRows) {
      const rowObservedAt = yield* timestampDecision('position-row-observed-at', position.observed_at.getTime())
      if (
        position.account_id !== accountSnapshot.account_id ||
        rowObservedAt !== positionsObservedAt ||
        !position.source_event_id.startsWith(positionSourcePrefix) ||
        position.source_event_id.length === positionSourcePrefix.length
      ) {
        return yield* fail('conflict', 'valuation snapshots disagree on source, account, or time')
      }
    }
    if (new Set(positionRows.map((position) => position.symbol)).size !== positionRows.length) {
      return yield* fail('conflict', 'valuation position symbols are not unique')
    }
    const accountTime = accountSnapshot.observed_at.getTime()
    const accountObservedAt = yield* timestampDecision('account-observed-at', accountTime)
    if (Math.abs(accountTime - positionTime) > maximumSkewMs) {
      return yield* fail('conflict', 'valuation snapshots exceed the maximum observation skew')
    }
    const cash = yield* integerDecision(
      'account-cash',
      accountSnapshot.cash_micros,
      'valuation account cash is invalid',
    )
    const marketValues: bigint[] = []
    for (const position of positionRows) {
      marketValues.push(
        yield* integerDecision(
          'position-market-value',
          position.market_value_micros,
          'valuation position market value is invalid',
          { eventId: position.event_id, symbol: position.symbol },
        ),
      )
    }
    const longMarketValue = marketValues.filter((value) => value >= 0n).reduce((sum, value) => sum + value, 0n)
    const shortMarketValue = marketValues.filter((value) => value < 0n).reduce((sum, value) => sum + value, 0n)
    const sourceHash = yield* hashDecision(
      'valuation-source',
      {
        schemaVersion: 'bayn.paper-valuation-source.v1',
        accountEventId: input.accountEventId,
        positionSnapshotId: positionSnapshot.snapshot_id,
        positionEventIds: positionRows.map((position) => position.event_id),
        positionsSourceHash: positionSnapshot.source_hash,
        accountObservedAt,
        positionsObservedAt,
      },
      'valuation source identity is not canonicalizable',
    )
    const valuationId = yield* hashDecision(
      'valuation-id',
      {
        schemaVersion: 'bayn.paper-valuation-id.v1',
        accountId: accountSnapshot.account_id,
        sourceHash,
      },
      'valuation identity is not canonicalizable',
    )
    const asOf = yield* timestampDecision('valuation-as-of', Math.max(accountTime, positionTime))
    return {
      schemaVersion: 'bayn.paper-valuation.v1',
      valuationId,
      accountId: accountSnapshot.account_id,
      sourceHash,
      cashMicros: cash.toString(),
      longMarketValueMicros: longMarketValue.toString(),
      shortMarketValueMicros: shortMarketValue.toString(),
      equityMicros: (cash + longMarketValue + shortMarketValue).toString(),
      asOf,
    }
  })

export const planValuation = Pipeable.dual(5, planValuationDataFirst)

export const requireValuationPositionSnapshot = (
  positionSnapshots: readonly PositionSnapshotRow[],
): Result.Result<PositionSnapshotRow, ExecutionStoreDecisionFailure> => {
  const snapshot = positionSnapshots[0]
  return positionSnapshots.length === 1 && snapshot !== undefined
    ? Result.succeed(snapshot)
    : fail('conflict', 'valuation position snapshot does not exist')
}

const decideStoredValuationDataFirst = (
  storedValuations: readonly Valuation[],
  candidate: Valuation,
): Result.Result<Valuation, ExecutionStoreDecisionFailure> => {
  if (storedValuations.length !== 1) return fail('invariant', 'valuation was not persisted')
  const stored = storedValuations[0]
  if (stored === undefined) return fail('invariant', 'valuation was not persisted')
  return Result.gen(function* () {
    const storedHash = yield* hashDecision('valuation-stored', stored, 'stored valuation is not canonicalizable')
    const candidateHash = yield* hashDecision(
      'valuation-candidate',
      candidate,
      'candidate valuation is not canonicalizable',
    )
    return storedHash === candidateHash
      ? stored
      : yield* fail('conflict', 'stored valuation differs from deterministic replay')
  })
}

export const decideStoredValuation = Pipeable.dual(2, decideStoredValuationDataFirst)
