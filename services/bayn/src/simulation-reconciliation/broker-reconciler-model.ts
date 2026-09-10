import { Cause, Data, Result, pipe } from 'effect'

import type {
  Account as BrokerAccount,
  BrokerReadError,
  FillActivity,
  Order as BrokerOrder,
  Position as BrokerPosition,
  ReadEvidence,
  ReadResult,
} from '../broker/alpaca'
import {
  renderBrokerObservationError,
  sourceTimestamp,
  type BrokerEventInput,
  type BrokerObservationError,
  type FillEventInput,
  type PositionSnapshotInput,
} from '../broker/observations'
import type { ExecutionStoreError } from '../db/execution-store/contract'
import { reconciliationIncompleteRestrictionReason } from '../execution/authority'
import type { BrokerSnapshot, ReconciliationReport } from '../db/reconciliation'
import type { WriterFenceError } from '../execution/writer-fence'
import type { CanonicalHashFailure } from '../hash'
import type { ReconciledBrokerState, ReconciliationRiskContext } from '../reconciliation'
import { Pipeable } from '../pipeable'

export const maximumRows = 10_000
export const ordersPageSize = 500
export const fillsPageSize = 100
export const incompletePassReason = reconciliationIncompleteRestrictionReason

export interface Observed<A> {
  readonly value: A
  readonly evidence: ReadEvidence
}

export interface OrderRead {
  readonly rows: readonly Observed<BrokerOrder>[]
  readonly observedAt: string
}

export interface BrokerHistory {
  readonly orders: OrderRead
  readonly fills: readonly Observed<FillActivity>[]
}

export interface StableBrokerSnapshot {
  readonly account: ReadResult<BrokerAccount>
  readonly positions: ReadResult<readonly BrokerPosition[]>
  readonly history: BrokerHistory
}

export type AccountEventInput = Extract<BrokerEventInput, { readonly _tag: 'Account' }>
export type OrderEventInput = Extract<BrokerEventInput, { readonly _tag: 'Order' }>

export interface NormalizedBrokerSnapshot {
  readonly account: AccountEventInput
  readonly positions: PositionSnapshotInput
  readonly orderEvents: readonly OrderEventInput[]
  readonly fillEvents: readonly FillEventInput[]
}

export interface ReconciliationWriteDecision {
  readonly snapshot: BrokerSnapshot
  readonly unknownOrderCount: number
  readonly orderCount: number
  readonly fillCount: number
}

export interface ReconciliationPassResult {
  readonly report: ReconciliationReport
  readonly brokerState: ReconciledBrokerState
  readonly riskContext: ReconciliationRiskContext
}

export type PaginationFailureReason =
  | 'OrderPageTooLarge'
  | 'OrderSubmittedAtMissing'
  | 'OrderHistoryNotAscending'
  | 'OrderTimestampCursorDidNotAdvance'
  | 'DuplicateOrder'
  | 'OrderHistoryTooLarge'
  | 'OrderCursorDidNotAdvance'
  | 'FillPageTooLarge'
  | 'DuplicateFill'
  | 'FillHistoryTooLarge'
  | 'FillCursorDidNotAdvance'

export type SnapshotFailureReason = 'HistoryChanged' | 'AccountBaselineMissing'
export type HistorySnapshotSide = 'before' | 'after'
export type HistoryHashFailure =
  | { readonly _tag: 'HistoryMaterializationFailed'; readonly cause: unknown }
  | { readonly _tag: 'HistoryCanonicalizationFailed'; readonly cause: CanonicalHashFailure }
export type ValidationFailureReason =
  | 'DuplicateIntentClientOrderId'
  | 'DuplicateBrokerClientOrderId'
  | 'UnexpectedOrderEvent'
  | 'FillOrderMissing'
  | 'UnexpectedAccountEvent'
export type NormalizationStage = 'order-timestamp' | 'order' | 'fill-ordering' | 'fill' | 'account' | 'positions'

type ReconciliationFailure =
  | { readonly _tag: 'Pagination'; readonly reason: PaginationFailureReason }
  | { readonly _tag: 'Snapshot'; readonly reason: SnapshotFailureReason }
  | { readonly _tag: 'HistoryHash'; readonly side: HistorySnapshotSide; readonly error: HistoryHashFailure }
  | { readonly _tag: 'Validation'; readonly reason: ValidationFailureReason; readonly detail: string }
  | {
      readonly _tag: 'Normalization'
      readonly stage: NormalizationStage
      readonly identity?: string
      readonly error: BrokerObservationError
    }
  | {
      readonly _tag: 'AuthorityRestrictionFailed'
      readonly reconciliationCause: Cause.Cause<
        BrokerReadError | ExecutionStoreError | ReconciliationError | WriterFenceError
      >
      readonly restrictionCause: Cause.Cause<ExecutionStoreError | WriterFenceError>
    }

export class ReconciliationError extends Data.TaggedError('ReconciliationError')<{
  readonly operation: 'containment' | 'normalization' | 'pagination' | 'snapshot'
  readonly message: string
  readonly failure?: ReconciliationFailure
  readonly cause?: unknown
}> {}

export type ReconciliationPassError = BrokerReadError | ExecutionStoreError | ReconciliationError | WriterFenceError

const paginationFailureDataFirst = (reason: PaginationFailureReason, message: string): ReconciliationError =>
  new ReconciliationError({ operation: 'pagination', message, failure: { _tag: 'Pagination', reason } })

export const paginationFailure = Pipeable.dual(2, paginationFailureDataFirst)

const snapshotFailureDataFirst = (reason: SnapshotFailureReason, message: string): ReconciliationError =>
  new ReconciliationError({ operation: 'snapshot', message, failure: { _tag: 'Snapshot', reason } })

export const snapshotFailure = Pipeable.dual(2, snapshotFailureDataFirst)

const historyHashFailureDataFirst = (side: HistorySnapshotSide, error: HistoryHashFailure): ReconciliationError =>
  new ReconciliationError({
    operation: 'snapshot',
    message:
      error._tag === 'HistoryMaterializationFailed'
        ? `broker ${side} history materialization failed`
        : `broker ${side} history canonicalization failed`,
    cause: error.cause,
    failure: { _tag: 'HistoryHash', side, error },
  })

export const historyHashFailure = Pipeable.dual(2, historyHashFailureDataFirst)

const validationFailureDataFirst = (reason: ValidationFailureReason, detail: string): ReconciliationError =>
  new ReconciliationError({
    operation: 'normalization',
    message: detail,
    failure: { _tag: 'Validation', reason, detail },
  })

export const validationFailure = Pipeable.dual(2, validationFailureDataFirst)

const normalizationFailure = (
  stage: NormalizationStage,
  identity: string | undefined,
  error: BrokerObservationError,
): ReconciliationError =>
  new ReconciliationError({
    operation: 'normalization',
    message: renderBrokerObservationError(error),
    cause: error,
    failure: {
      _tag: 'Normalization',
      stage,
      ...(identity === undefined ? {} : { identity }),
      error,
    },
  })

const mapObservationFailureDataFirst = <A>(
  stage: NormalizationStage,
  identity: string | undefined,
  result: Result.Result<A, BrokerObservationError>,
): Result.Result<A, ReconciliationError> =>
  pipe(
    result,
    Result.mapError((error) => normalizationFailure(stage, identity, error)),
  )

export const mapObservationFailure = Pipeable.generic<
  <A>(
    identity: string | undefined,
    result: Result.Result<A, BrokerObservationError>,
  ) => (stage: NormalizationStage) => Result.Result<A, ReconciliationError>,
  typeof mapObservationFailureDataFirst
>(3, mapObservationFailureDataFirst)

const normalizeTimestampDataFirst = (
  stage: Extract<NormalizationStage, 'order-timestamp' | 'fill-ordering'>,
  identity: string,
  value: string,
): Result.Result<string, ReconciliationError> => mapObservationFailure(stage, identity, sourceTimestamp(value))

export const normalizeTimestamp = Pipeable.dual(3, normalizeTimestampDataFirst)

const compareTextDataFirst = (left: string, right: string): number => (left < right ? -1 : left > right ? 1 : 0)

export const compareText = Pipeable.dual(2, compareTextDataFirst)
