import { Cause, Chunk, Clock, Data, Effect, Exit, HashMap, HashSet, Option, Result } from 'effect'

import {
  BrokerRead,
  OrderCollection,
  SortDirection,
  type Account as BrokerAccount,
  type BrokerReadError,
  type BrokerReadShape,
  type FillActivity,
  type Order as BrokerOrder,
  type Position as BrokerPosition,
  type ReadEvidence,
  type ReadResult,
} from './broker/alpaca'
import {
  accountObservation,
  fillObservation,
  orderObservation,
  positionSnapshot,
  sourceTimestamp,
  type BrokerEventInput,
  type FillEventInput,
  type PositionSnapshotInput,
} from './broker/observations'
import { PaperStore, type PaperStoreError, type PaperStoreShape } from './db/paper-store'
import {
  type BrokerSnapshot,
  type IntentBinding,
  type ReconciliationReport,
  type ReconciliationWriteResult,
} from './db/reconciliation'
import { WriterFence, type WriterFenceError, type WriterFenceService } from './execution/writer-fence'
import { canonicalHashV1 } from './hash'
import type { ReconciledBrokerState, ReconciliationRiskContext } from './reconciliation'

const maximumRows = 10_000
const ordersPageSize = 500
const fillsPageSize = 100
const incompletePassReason = 'reconciliation pass incomplete'
const normalizationMessage = 'broker snapshot normalization failed'

interface Observed<A> {
  readonly value: A
  readonly evidence: ReadEvidence
}

interface OrderRead {
  readonly rows: readonly Observed<BrokerOrder>[]
  readonly observedAt: string
}

interface BrokerHistory {
  readonly orders: OrderRead
  readonly fills: readonly Observed<FillActivity>[]
}

interface StableBrokerSnapshot {
  readonly account: ReadResult<BrokerAccount>
  readonly positions: ReadResult<readonly BrokerPosition[]>
  readonly history: BrokerHistory
}

type AccountEventInput = Extract<BrokerEventInput, { readonly _tag: 'Account' }>
type OrderEventInput = Extract<BrokerEventInput, { readonly _tag: 'Order' }>

interface NormalizedBrokerSnapshot {
  readonly account: AccountEventInput
  readonly positions: PositionSnapshotInput
  readonly orderEvents: readonly OrderEventInput[]
  readonly fillEvents: readonly FillEventInput[]
}

interface ReconciliationDecision {
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

type PaginationFailureReason =
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

type SnapshotFailureReason = 'HistoryChanged' | 'AccountBaselineMissing'

type ValidationFailureReason =
  | 'DuplicateIntentClientOrderId'
  | 'DuplicateBrokerClientOrderId'
  | 'UnexpectedOrderEvent'
  | 'FillOrderMissing'
  | 'UnexpectedAccountEvent'

type NormalizationStage = 'order' | 'fill-ordering' | 'fill' | 'account' | 'positions'

type NormalizationDecisionFailure =
  | ReconciliationError
  | { readonly _tag: 'Defect'; readonly cause: Cause.Cause<never> }

type ReconciliationFailure =
  | { readonly _tag: 'Pagination'; readonly reason: PaginationFailureReason }
  | { readonly _tag: 'Snapshot'; readonly reason: SnapshotFailureReason }
  | { readonly _tag: 'Validation'; readonly reason: ValidationFailureReason; readonly detail: string }
  | {
      readonly _tag: 'Normalization'
      readonly stage: NormalizationStage
      readonly identity?: string
      readonly cause: Error
    }
  | {
      readonly _tag: 'AuthorityRestrictionFailed'
      readonly reconciliationCause: Cause.Cause<
        BrokerReadError | PaperStoreError | ReconciliationError | WriterFenceError
      >
      readonly restrictionCause: Cause.Cause<PaperStoreError | WriterFenceError>
    }

export class ReconciliationError extends Data.TaggedError('ReconciliationError')<{
  readonly operation: 'containment' | 'normalization' | 'pagination' | 'snapshot'
  readonly message: string
  readonly failure?: ReconciliationFailure
  readonly cause?: unknown
}> {}

export type ReconciliationPassError = BrokerReadError | PaperStoreError | ReconciliationError | WriterFenceError

const paginationFailure = (reason: PaginationFailureReason, message: string): ReconciliationError =>
  new ReconciliationError({
    operation: 'pagination',
    message,
    failure: { _tag: 'Pagination', reason },
  })

const snapshotFailure = (reason: SnapshotFailureReason, message: string): ReconciliationError =>
  new ReconciliationError({
    operation: 'snapshot',
    message,
    failure: { _tag: 'Snapshot', reason },
  })

const validationFailure = (reason: ValidationFailureReason, detail: string): ReconciliationError =>
  new ReconciliationError({
    operation: 'normalization',
    message: normalizationMessage,
    failure: { _tag: 'Validation', reason, detail },
  })

const decideNormalizationFailure = (
  stage: NormalizationStage,
  identity: string | undefined,
  cause: unknown,
): NormalizationDecisionFailure => {
  if (!(cause instanceof Error)) return { _tag: 'Defect', cause: Cause.die(cause) }
  return new ReconciliationError({
    operation: 'normalization',
    message: normalizationMessage,
    cause,
    failure: {
      _tag: 'Normalization',
      stage,
      ...(identity === undefined ? {} : { identity }),
      cause,
    },
  })
}

const normalizationAttempt = <A>(
  stage: NormalizationStage,
  identity: string | undefined,
  evaluate: () => A,
): Result.Result<A, NormalizationDecisionFailure> =>
  Result.try({
    try: evaluate,
    catch: (cause) => decideNormalizationFailure(stage, identity, cause),
  })

const compareText = (left: string, right: string): number => (left < right ? -1 : left > right ? 1 : 0)

interface OrderPaginationState {
  readonly rows: readonly Observed<BrokerOrder>[]
  readonly ids: HashSet.HashSet<string>
  readonly cursor: string | undefined
  readonly previousSubmittedAt: string | undefined
  readonly observedAt: string | undefined
}

interface FillPaginationState {
  readonly rows: readonly Observed<FillActivity>[]
  readonly ids: HashSet.HashSet<string>
  readonly cursor: string | undefined
}

type OrderPageDecision =
  | { readonly _tag: 'Continue'; readonly state: OrderPaginationState }
  | { readonly _tag: 'Complete'; readonly read: OrderRead }

type FillPageDecision =
  | { readonly _tag: 'Continue'; readonly state: FillPaginationState }
  | { readonly _tag: 'Complete'; readonly rows: readonly Observed<FillActivity>[] }

interface OrderPageAccumulator {
  readonly rows: Chunk.Chunk<Observed<BrokerOrder>>
  readonly ids: HashSet.HashSet<string>
  readonly previousSubmittedAt: string | undefined
}

interface FillPageAccumulator {
  readonly rows: Chunk.Chunk<Observed<FillActivity>>
  readonly ids: HashSet.HashSet<string>
}

const initialOrderPaginationState = (): OrderPaginationState => ({
  rows: [],
  ids: HashSet.empty(),
  cursor: undefined,
  previousSubmittedAt: undefined,
  observedAt: undefined,
})

const initialFillPaginationState = (): FillPaginationState => ({
  rows: [],
  ids: HashSet.empty(),
  cursor: undefined,
})

const decideOrderPage = (
  state: OrderPaginationState,
  limit: number,
  page: ReadResult<readonly BrokerOrder[]>,
): Result.Result<OrderPageDecision, ReconciliationError> => {
  const observedAt =
    state.observedAt === undefined || page.evidence.observedAt > state.observedAt
      ? page.evidence.observedAt
      : state.observedAt
  if (page.value.length > limit) {
    return Result.fail(paginationFailure('OrderPageTooLarge', 'Alpaca returned more orders than requested'))
  }
  if (page.value.length === 0) {
    return Result.succeed({ _tag: 'Complete', read: { rows: state.rows, observedAt } })
  }

  const pageResult = page.value.reduce<Result.Result<OrderPageAccumulator, ReconciliationError>>(
    (result, order) => {
      if (Result.isFailure(result)) return result
      const submittedAt = order.submittedAt
      if (submittedAt === undefined) {
        return Result.fail(
          paginationFailure('OrderSubmittedAtMissing', `Alpaca order ${order.brokerOrderId} is missing submitted_at`),
        )
      }

      const previousSubmittedAt = result.success.previousSubmittedAt
      if (previousSubmittedAt !== undefined && sourceTimestamp(submittedAt) < sourceTimestamp(previousSubmittedAt)) {
        return Result.fail(paginationFailure('OrderHistoryNotAscending', 'Alpaca order history is not ascending'))
      }
      if (state.cursor !== undefined && sourceTimestamp(submittedAt) <= sourceTimestamp(state.cursor)) {
        return Result.fail(
          paginationFailure('OrderTimestampCursorDidNotAdvance', 'Alpaca order timestamp cursor did not advance'),
        )
      }
      if (HashSet.has(result.success.ids, order.brokerOrderId)) {
        return Result.fail(paginationFailure('DuplicateOrder', `duplicate Alpaca order ${order.brokerOrderId}`))
      }

      const rows = Chunk.append(result.success.rows, { value: order, evidence: page.evidence })
      if (state.rows.length + Chunk.size(rows) > maximumRows) {
        return Result.fail(
          paginationFailure('OrderHistoryTooLarge', `Alpaca order history exceeds ${maximumRows} rows`),
        )
      }
      return Result.succeed({
        rows,
        ids: HashSet.add(result.success.ids, order.brokerOrderId),
        previousSubmittedAt: submittedAt,
      })
    },
    Result.succeed({
      rows: Chunk.empty(),
      ids: state.ids,
      previousSubmittedAt: state.previousSubmittedAt,
    }),
  )
  if (Result.isFailure(pageResult)) return Result.fail(pageResult.failure)

  const rows = [...state.rows, ...Chunk.toReadonlyArray(pageResult.success.rows)]
  if (page.value.length < limit) {
    return Result.succeed({ _tag: 'Complete', read: { rows, observedAt } })
  }

  const next = page.value[page.value.length - 1]?.submittedAt
  if (next === undefined || next === state.cursor) {
    return Result.fail(paginationFailure('OrderCursorDidNotAdvance', 'Alpaca order cursor did not advance'))
  }
  return Result.succeed({
    _tag: 'Continue',
    state: {
      rows,
      ids: pageResult.success.ids,
      cursor: next,
      previousSubmittedAt: pageResult.success.previousSubmittedAt,
      observedAt,
    },
  })
}

const decideFillPage = (
  state: FillPaginationState,
  pageSize: number,
  page: ReadResult<{ readonly items: readonly FillActivity[]; readonly nextPageToken?: string }>,
): Result.Result<FillPageDecision, ReconciliationError> => {
  if (page.value.items.length > pageSize) {
    return Result.fail(paginationFailure('FillPageTooLarge', 'Alpaca returned more fills than requested'))
  }

  const pageResult = page.value.items.reduce<Result.Result<FillPageAccumulator, ReconciliationError>>(
    (result, fill) => {
      if (Result.isFailure(result)) return result
      if (HashSet.has(result.success.ids, fill.activityId)) {
        return Result.fail(paginationFailure('DuplicateFill', `duplicate Alpaca fill ${fill.activityId}`))
      }

      const rows = Chunk.append(result.success.rows, { value: fill, evidence: page.evidence })
      if (state.rows.length + Chunk.size(rows) > maximumRows) {
        return Result.fail(paginationFailure('FillHistoryTooLarge', `Alpaca fill history exceeds ${maximumRows} rows`))
      }
      return Result.succeed({
        rows,
        ids: HashSet.add(result.success.ids, fill.activityId),
      })
    },
    Result.succeed({ rows: Chunk.empty(), ids: state.ids }),
  )
  if (Result.isFailure(pageResult)) return Result.fail(pageResult.failure)

  const rows = [...state.rows, ...Chunk.toReadonlyArray(pageResult.success.rows)]
  const next = page.value.nextPageToken
  if (next === undefined) return Result.succeed({ _tag: 'Complete', rows })

  const last = page.value.items[page.value.items.length - 1]?.activityId
  if (page.value.items.length === 0 || next === state.cursor || next !== last) {
    return Result.fail(paginationFailure('FillCursorDidNotAdvance', 'Alpaca fill cursor did not advance'))
  }
  return Result.succeed({
    _tag: 'Continue',
    state: {
      rows,
      ids: pageResult.success.ids,
      cursor: next,
    },
  })
}

const readOrderPages = (
  read: BrokerReadShape,
  until: string,
  state: OrderPaginationState,
): Effect.Effect<OrderRead, BrokerReadError | ReconciliationError> => {
  const limit = Math.min(ordersPageSize, maximumRows + 1 - state.rows.length)
  return Effect.suspend(() =>
    read.orders({
      status: OrderCollection.All,
      direction: SortDirection.Ascending,
      limit,
      until,
      ...(state.cursor === undefined ? {} : { after: state.cursor }),
    }),
  ).pipe(
    Effect.flatMap((page) => Effect.fromResult(decideOrderPage(state, limit, page))),
    Effect.flatMap((decision) =>
      decision._tag === 'Complete' ? Effect.succeed(decision.read) : readOrderPages(read, until, decision.state),
    ),
  )
}

const readFillPages = (
  read: BrokerReadShape,
  until: string,
  state: FillPaginationState,
): Effect.Effect<readonly Observed<FillActivity>[], BrokerReadError | ReconciliationError> => {
  const pageSize = Math.min(fillsPageSize, maximumRows + 1 - state.rows.length)
  return Effect.suspend(() =>
    read.fillActivities({
      direction: SortDirection.Ascending,
      pageSize,
      until,
      ...(state.cursor === undefined ? {} : { pageToken: state.cursor }),
    }),
  ).pipe(
    Effect.flatMap((page) => Effect.fromResult(decideFillPage(state, pageSize, page))),
    Effect.flatMap((decision) =>
      decision._tag === 'Complete' ? Effect.succeed(decision.rows) : readFillPages(read, until, decision.state),
    ),
  )
}

const readHistory = (
  read: BrokerReadShape,
  until: string,
): Effect.Effect<BrokerHistory, BrokerReadError | ReconciliationError> =>
  Effect.all(
    {
      orders: readOrderPages(read, until, initialOrderPaginationState()),
      fills: readFillPages(read, until, initialFillPaginationState()),
    },
    { concurrency: 2 },
  )

const historyHash = (history: BrokerHistory): string =>
  canonicalHashV1({
    schemaVersion: 'bayn.paper-broker-history.v1',
    orders: history.orders.rows
      .map(({ value }) => {
        const { observedAt: _observedAt, ...material } = value
        return material
      })
      .sort((left, right) => left.brokerOrderId.localeCompare(right.brokerOrderId)),
    fills: history.fills
      .map(({ value }) => value)
      .sort((left, right) => left.activityId.localeCompare(right.activityId)),
  })

const decideStableHistory = (
  before: BrokerHistory,
  after: BrokerHistory,
): Result.Result<BrokerHistory, ReconciliationError> =>
  historyHash(before) === historyHash(after)
    ? Result.succeed(after)
    : Result.fail(snapshotFailure('HistoryChanged', 'broker history changed during reconciliation'))

const currentInstant = Clock.currentTimeMillis.pipe(
  Effect.map((currentTimeMillis) => new Date(currentTimeMillis).toISOString()),
)

const readStableBrokerSnapshot = (
  read: BrokerReadShape,
): Effect.Effect<StableBrokerSnapshot, BrokerReadError | ReconciliationError> =>
  Effect.gen(function* () {
    const beforeUntil = yield* currentInstant
    const before = yield* readHistory(read, beforeUntil)
    const [account, positions] = yield* Effect.all([read.account, read.positions], { concurrency: 2 })
    const afterUntil = yield* currentInstant
    const after = yield* readHistory(read, afterUntil)
    const history = yield* Effect.fromResult(decideStableHistory(before, after))
    return { account, positions, history }
  })

const indexBindings = (
  bindings: readonly IntentBinding[],
): Result.Result<HashMap.HashMap<string, string>, NormalizationDecisionFailure> =>
  bindings.reduce<Result.Result<HashMap.HashMap<string, string>, NormalizationDecisionFailure>>((result, binding) => {
    if (Result.isFailure(result)) return result
    if (HashMap.has(result.success, binding.clientOrderId)) {
      return Result.fail(
        validationFailure('DuplicateIntentClientOrderId', `duplicate intent client order ID ${binding.clientOrderId}`),
      )
    }
    return Result.succeed(HashMap.set(result.success, binding.clientOrderId, binding.intentId))
  }, Result.succeed(HashMap.empty()))

interface OrderNormalizationState {
  readonly orderById: HashMap.HashMap<string, BrokerOrder>
  readonly clientOrderIds: HashSet.HashSet<string>
  readonly events: Chunk.Chunk<OrderEventInput>
}

const normalizeOrders = (
  rows: readonly Observed<BrokerOrder>[],
  intentByClient: HashMap.HashMap<string, string>,
): Result.Result<OrderNormalizationState, NormalizationDecisionFailure> =>
  rows.reduce<Result.Result<OrderNormalizationState, NormalizationDecisionFailure>>(
    (result, observed) => {
      if (Result.isFailure(result)) return result
      if (HashSet.has(result.success.clientOrderIds, observed.value.clientOrderId)) {
        return Result.fail(
          validationFailure(
            'DuplicateBrokerClientOrderId',
            `duplicate broker client order ID ${observed.value.clientOrderId}`,
          ),
        )
      }

      const normalized = normalizationAttempt('order', observed.value.brokerOrderId, () =>
        orderObservation(
          observed.value,
          observed.evidence,
          Option.getOrUndefined(HashMap.get(intentByClient, observed.value.clientOrderId)),
        ),
      )
      if (Result.isFailure(normalized)) return Result.fail(normalized.failure)
      if (normalized.success._tag !== 'Order') {
        return Result.fail(validationFailure('UnexpectedOrderEvent', 'normalized order event is not an order'))
      }
      return Result.succeed({
        orderById: HashMap.set(result.success.orderById, observed.value.brokerOrderId, observed.value),
        clientOrderIds: HashSet.add(result.success.clientOrderIds, observed.value.clientOrderId),
        events: Chunk.append(result.success.events, normalized.success),
      })
    },
    Result.succeed({
      orderById: HashMap.empty(),
      clientOrderIds: HashSet.empty(),
      events: Chunk.empty(),
    }),
  )

const normalizeFills = (
  fills: readonly Observed<FillActivity>[],
  orders: OrderNormalizationState,
  intentByClient: HashMap.HashMap<string, string>,
): Result.Result<readonly FillEventInput[], NormalizationDecisionFailure> => {
  const ordered = normalizationAttempt('fill-ordering', undefined, () =>
    [...fills].sort((left, right) => {
      const byTime = compareText(
        sourceTimestamp(left.value.transactionTime),
        sourceTimestamp(right.value.transactionTime),
      )
      return byTime === 0 ? compareText(left.value.activityId, right.value.activityId) : byTime
    }),
  )
  if (Result.isFailure(ordered)) return Result.fail(ordered.failure)

  return Result.all(
    ordered.success.map((observed) => {
      const order = Option.getOrUndefined(HashMap.get(orders.orderById, observed.value.brokerOrderId))
      if (order === undefined) {
        return Result.fail(
          validationFailure('FillOrderMissing', `Alpaca fill ${observed.value.activityId} references a missing order`),
        )
      }
      return normalizationAttempt('fill', observed.value.activityId, () =>
        fillObservation(observed.value, order, observed.evidence, {
          intentId: Option.getOrUndefined(HashMap.get(intentByClient, order.clientOrderId)),
        }),
      )
    }),
  )
}

const normalizeAccount = (
  account: ReadResult<BrokerAccount>,
): Result.Result<AccountEventInput, NormalizationDecisionFailure> => {
  const normalized = normalizationAttempt('account', account.value.id, () => accountObservation(account))
  if (Result.isFailure(normalized)) return Result.fail(normalized.failure)
  return normalized.success._tag === 'Account'
    ? Result.succeed(normalized.success)
    : Result.fail(validationFailure('UnexpectedAccountEvent', 'normalized account event is not an account'))
}

const normalizePositions = (
  accountId: string,
  positions: ReadResult<readonly BrokerPosition[]>,
): Result.Result<PositionSnapshotInput, NormalizationDecisionFailure> =>
  normalizationAttempt('positions', accountId, () => positionSnapshot(accountId, positions))

const normalizeSnapshot = (
  snapshot: StableBrokerSnapshot,
  bindings: readonly IntentBinding[],
): Result.Result<NormalizedBrokerSnapshot, NormalizationDecisionFailure> =>
  Result.gen(function* () {
    const intentByClient = yield* indexBindings(bindings)
    const orders = yield* normalizeOrders(snapshot.history.orders.rows, intentByClient)
    const fillEvents = yield* normalizeFills(snapshot.history.fills, orders, intentByClient)
    const account = yield* normalizeAccount(snapshot.account)
    const positions = yield* normalizePositions(snapshot.account.value.id, snapshot.positions)
    return {
      account,
      positions,
      orderEvents: Chunk.toReadonlyArray(orders.events),
      fillEvents,
    }
  })

const interpretNormalizationDecision = <A>(
  decision: Result.Result<A, NormalizationDecisionFailure>,
): Effect.Effect<A, ReconciliationError> => {
  if (Result.isSuccess(decision)) return Effect.succeed(decision.success)
  switch (decision.failure._tag) {
    case 'ReconciliationError':
      return Effect.fail(decision.failure)
    case 'Defect':
      return Effect.failCause(decision.failure.cause)
  }
}

const decideAccountBaseline = (hasAccountBaseline: boolean): Result.Result<void, ReconciliationError> =>
  hasAccountBaseline
    ? Result.succeed(undefined)
    : Result.fail(
        snapshotFailure(
          'AccountBaselineMissing',
          'paper account has fill history before Bayn established an opening cash baseline',
        ),
      )

const prepareNormalizedSnapshot = (
  store: PaperStoreShape,
  snapshot: StableBrokerSnapshot,
): Effect.Effect<NormalizedBrokerSnapshot, PaperStoreError | ReconciliationError> =>
  Effect.gen(function* () {
    const bindings = yield* store.bindings(snapshot.account.value.id)
    if (snapshot.history.fills.length > 0) {
      const hasAccountBaseline = yield* store.hasAccountBaseline(snapshot.account.value.id)
      yield* Effect.fromResult(decideAccountBaseline(hasAccountBaseline))
    }
    return yield* interpretNormalizationDecision(normalizeSnapshot(snapshot, bindings))
  })

const ingestBrokerEvents = (store: PaperStoreShape, normalized: NormalizedBrokerSnapshot) =>
  Effect.gen(function* () {
    const accountReceipt = yield* store.ingest(normalized.account)
    const positionsReceipt = yield* store.ingestPositions(normalized.positions)
    yield* Effect.forEach(normalized.orderEvents, store.ingest, { discard: true })
    yield* Effect.forEach(normalized.fillEvents, store.account, { discard: true })
    const valuation = yield* store.value({
      accountEventId: accountReceipt.eventId,
      positionSnapshotId: positionsReceipt.snapshotId,
    })
    return valuation
  })

const makeReconciliationDecision = (
  normalized: NormalizedBrokerSnapshot,
  ordersObservedAt: string,
  valuation: BrokerSnapshot['valuation'],
  reconciledAt: string,
): ReconciliationDecision => {
  const positions = normalized.positions.positions
    .map((event) => event.position)
    .sort((left, right) => compareText(left.symbol, right.symbol))
  const orders = normalized.orderEvents
    .map((event) => event.order)
    .sort((left, right) => compareText(left.brokerOrderId, right.brokerOrderId))
  return {
    snapshot: {
      account: normalized.account.account,
      positions,
      positionsObservedAt: normalized.positions.observedAt,
      orders,
      ordersObservedAt,
      fills: normalized.fillEvents.map((event) => event.fill),
      valuation,
      reconciledAt,
    },
    unknownOrderCount: orders.filter((order) => order.intentId === undefined).length,
    orderCount: normalized.orderEvents.length,
    fillCount: normalized.fillEvents.length,
  }
}

const makePassResult = (
  decision: ReconciliationDecision,
  persisted: ReconciliationWriteResult,
): ReconciliationPassResult => {
  const report: ReconciliationReport = {
    reconciliation: persisted.reconciliation,
    metrics: persisted.metrics,
  }
  return {
    report,
    brokerState: {
      account: decision.snapshot.account,
      positions: decision.snapshot.positions,
      positionsObservedAt: decision.snapshot.positionsObservedAt,
      orders: decision.snapshot.orders,
      ordersObservedAt: decision.snapshot.ordersObservedAt,
      accountingHash: persisted.accountingHash,
      reconciliation: persisted.reconciliation,
      unknownOrderCount: decision.unknownOrderCount,
    },
    riskContext: persisted.riskContext,
  }
}

const logCompletedPass = (result: ReconciliationPassResult, decision: ReconciliationDecision): Effect.Effect<void> =>
  Effect.logInfo('Paper account reconciliation completed').pipe(
    Effect.annotateLogs({
      accountId: result.report.reconciliation.accountId,
      status: result.report.reconciliation.status,
      reconciliationId: result.report.reconciliation.reconciliationId,
      orderCount: decision.orderCount,
      fillCount: decision.fillCount,
      discrepancyCount: result.report.metrics.discrepancyCount,
      brokerPollAgeMs: result.report.metrics.brokerPollAgeMs,
      oldestUnknownMutationAgeMs: result.report.metrics.oldestUnknownMutationAgeMs,
      accountingExact: result.report.metrics.accountingExact,
    }),
  )

const writeReconciliation = (
  store: PaperStoreShape,
  normalized: NormalizedBrokerSnapshot,
  ordersObservedAt: string,
): Effect.Effect<ReconciliationPassResult, PaperStoreError> =>
  Effect.gen(function* () {
    const valuation = yield* ingestBrokerEvents(store, normalized)
    const reconciledAt = yield* currentInstant
    const decision = makeReconciliationDecision(normalized, ordersObservedAt, valuation, reconciledAt)
    const persisted = yield* store.reconcile(decision.snapshot)
    const result = makePassResult(decision, persisted)
    yield* logCompletedPass(result, decision)
    return result
  })

const persistStableSnapshot = (
  store: PaperStoreShape,
  fence: WriterFenceService,
  snapshot: StableBrokerSnapshot,
): Effect.Effect<ReconciliationPassResult, PaperStoreError | ReconciliationError | WriterFenceError> =>
  fence.transaction(
    prepareNormalizedSnapshot(store, snapshot).pipe(
      Effect.flatMap((normalized) => writeReconciliation(store, normalized, snapshot.history.orders.observedAt)),
    ),
  )

const run = (
  read: BrokerReadShape,
  store: PaperStoreShape,
  fence: WriterFenceService,
): Effect.Effect<ReconciliationPassResult, ReconciliationPassError> =>
  readStableBrokerSnapshot(read).pipe(
    Effect.flatMap((snapshot) => persistStableSnapshot(store, fence, snapshot)),
    Effect.withLogSpan('reconciliation'),
  )

type ContainmentDecision =
  | { readonly _tag: 'PreserveInterruption' }
  | { readonly _tag: 'RestrictAuthority'; readonly reason: typeof incompletePassReason }

const decideContainment = <E>(cause: Cause.Cause<E>): ContainmentDecision =>
  Cause.hasInterruptsOnly(cause)
    ? { _tag: 'PreserveInterruption' }
    : { _tag: 'RestrictAuthority', reason: incompletePassReason }

const restrictAuthority = (
  store: PaperStoreShape,
  fence: WriterFenceService,
  decision: Extract<ContainmentDecision, { readonly _tag: 'RestrictAuthority' }>,
): Effect.Effect<void, PaperStoreError | WriterFenceError> =>
  currentInstant.pipe(
    Effect.flatMap((failedAt) => fence.transaction(store.restrictAuthority(decision.reason, failedAt))),
  )

const hasDefectOrInterruption = <E>(cause: Cause.Cause<E>): boolean =>
  cause.reasons.some((reason) => Cause.isDieReason(reason) || Cause.isInterruptReason(reason))

const authorityRestrictionFailure = (
  reconciliationCause: Cause.Cause<ReconciliationPassError>,
  restrictionCause: Cause.Cause<PaperStoreError | WriterFenceError>,
): ReconciliationError =>
  new ReconciliationError({
    operation: 'containment',
    message: 'authority restriction failed after reconciliation failure',
    failure: {
      _tag: 'AuthorityRestrictionFailed',
      reconciliationCause,
      restrictionCause,
    },
  })

const preserveFailureAfterContainment = (
  cause: Cause.Cause<ReconciliationPassError>,
  containmentExit: Exit.Exit<void, PaperStoreError | WriterFenceError>,
): Effect.Effect<never, ReconciliationPassError> => {
  if (Exit.isSuccess(containmentExit)) return Effect.failCause(cause)
  if (hasDefectOrInterruption(containmentExit.cause)) {
    return Effect.failCause(Cause.combine(cause, containmentExit.cause))
  }
  const containmentError = authorityRestrictionFailure(cause, containmentExit.cause)
  return hasDefectOrInterruption(cause)
    ? Effect.failCause(Cause.combine(cause, Cause.fail(containmentError)))
    : Effect.fail(containmentError)
}

const containRuntimeFailure = <A, R>(
  effect: Effect.Effect<A, ReconciliationPassError, R>,
  store: PaperStoreShape,
  fence: WriterFenceService,
): Effect.Effect<A, ReconciliationPassError, R> =>
  Effect.matchCauseEffect(effect, {
    onFailure: (cause) => {
      const decision = decideContainment(cause)
      if (decision._tag === 'PreserveInterruption') return Effect.failCause(cause)
      return Effect.exit(restrictAuthority(store, fence, decision)).pipe(
        Effect.flatMap((containmentExit) => preserveFailureAfterContainment(cause, containmentExit)),
      )
    },
    onSuccess: (value) => Effect.succeed(value),
  })

export const runOnce: Effect.Effect<
  ReconciliationPassResult,
  ReconciliationPassError,
  BrokerRead | PaperStore | WriterFence
> = Effect.gen(function* () {
  const read = yield* BrokerRead
  const store = yield* PaperStore
  const fence = yield* WriterFence
  return yield* containRuntimeFailure(run(read, store, fence), store, fence)
})
