import { Chunk, Effect, HashSet, Result, Schedule, pipe } from 'effect'

import {
  OrderCollection,
  SortDirection,
  type BrokerReadShape,
  type FillActivity,
  type FeeActivity,
  type Order as BrokerOrder,
  type ReadResult,
} from '../broker/alpaca/model'
import { type BrokerReadError } from '../broker/alpaca/failures'
import { canonicalHashV1Result } from '../hash'
import {
  fillsPageSize,
  historyHashFailure,
  maximumRows,
  normalizeTimestamp,
  ordersPageSize,
  paginationFailure,
  snapshotFailure,
  type BrokerHistory,
  type HistoryHashFailure,
  type Observed,
  type OrderRead,
  ReconciliationError,
  type StableBrokerSnapshot,
} from './broker-reconciler-model'

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
  readonly oldestGroupStart: number
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

const initialFillPaginationState = (): FillPaginationState => ({ rows: [], ids: HashSet.empty(), cursor: undefined })

export const decideOrderPage = (
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
    return Result.succeed({ _tag: 'Complete', read: { rows: state.rows, observedAt: state.observedAt ?? observedAt } })
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
      const normalizedSubmittedAt = normalizeTimestamp('order-timestamp', order.brokerOrderId, submittedAt)
      if (Result.isFailure(normalizedSubmittedAt)) return Result.fail(normalizedSubmittedAt.failure)
      const normalizedPrevious =
        previousSubmittedAt === undefined
          ? undefined
          : normalizeTimestamp('order-timestamp', order.brokerOrderId, previousSubmittedAt)
      if (normalizedPrevious !== undefined && Result.isFailure(normalizedPrevious)) {
        return Result.fail(normalizedPrevious.failure)
      }
      const normalizedCursor =
        state.cursor === undefined
          ? undefined
          : normalizeTimestamp('order-timestamp', order.brokerOrderId, state.cursor)
      if (normalizedCursor !== undefined && Result.isFailure(normalizedCursor)) {
        return Result.fail(normalizedCursor.failure)
      }
      if (
        normalizedPrevious !== undefined &&
        Result.isSuccess(normalizedPrevious) &&
        normalizedSubmittedAt.success > normalizedPrevious.success
      ) {
        return Result.fail(paginationFailure('OrderHistoryNotDescending', 'Alpaca order history is not descending'))
      }
      if (
        normalizedCursor !== undefined &&
        Result.isSuccess(normalizedCursor) &&
        normalizedSubmittedAt.success >= normalizedCursor.success
      ) {
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
        oldestGroupStart:
          normalizedPrevious !== undefined &&
          Result.isSuccess(normalizedPrevious) &&
          normalizedSubmittedAt.success === normalizedPrevious.success
            ? result.success.oldestGroupStart
            : Chunk.size(result.success.rows),
      })
    },
    Result.succeed({
      rows: Chunk.empty(),
      ids: state.ids,
      previousSubmittedAt: state.previousSubmittedAt,
      oldestGroupStart: 0,
    }),
  )
  if (Result.isFailure(pageResult)) return Result.fail(pageResult.failure)
  const pageRows = Chunk.toReadonlyArray(pageResult.success.rows)
  const pageOrderCount = page.value.reduce((count, order) => count + 1 + (order.legs?.length ?? 0), 0)
  if (pageOrderCount < limit)
    return Result.succeed({ _tag: 'Complete', read: { rows: [...state.rows, ...pageRows], observedAt } })
  // Alpaca orders pages descend by submission time; exclusive `until` excludes every sibling at its timestamp.
  // Defer the entire oldest group so the next page can enumerate hidden siblings before retaining that group.
  // Unique timestamps reread one boundary row per full page. A full one-timestamp page cannot prove completeness.
  const retained = pageRows.slice(0, pageResult.success.oldestGroupStart)
  const next = retained.at(-1)?.value.submittedAt
  if (next === undefined || next === state.cursor) {
    return Result.fail(
      paginationFailure(
        'OrderCursorDidNotAdvance',
        'Alpaca order page has no complete submission-time group for a safe cursor',
      ),
    )
  }
  let ids = pageResult.success.ids
  for (const deferred of pageRows.slice(pageResult.success.oldestGroupStart))
    ids = HashSet.remove(ids, deferred.value.brokerOrderId)
  return Result.succeed({
    _tag: 'Continue',
    state: {
      rows: [...state.rows, ...retained],
      ids,
      cursor: next,
      previousSubmittedAt: next,
      observedAt,
    },
  })
}

export const decideFillPage = (
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
      return Result.succeed({ rows, ids: HashSet.add(result.success.ids, fill.activityId) })
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
    state: { rows, ids: pageResult.success.ids, cursor: next },
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
      direction: SortDirection.Descending,
      limit,
      until: state.cursor ?? until,
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

const readFeePages = (
  read: BrokerReadShape,
): Effect.Effect<readonly Observed<FeeActivity>[], BrokerReadError | ReconciliationError> =>
  Effect.gen(function* () {
    const rows: Observed<FeeActivity>[] = []
    const ids = new Set<string>()
    let cursor: string | undefined
    while (true) {
      const page = yield* read.feeActivities({
        direction: SortDirection.Ascending,
        pageSize: fillsPageSize,
        ...(cursor === undefined ? {} : { pageToken: cursor }),
      })
      if (page.value.items.length > fillsPageSize || rows.length + page.value.items.length > maximumRows)
        return yield* paginationFailure('InvalidFeeHistory', 'fee history exceeded its bounded row budget')
      for (const fee of page.value.items) {
        if (fee.date > page.evidence.observedAt.slice(0, 10))
          return yield* paginationFailure('InvalidFeeHistory', 'fee history contains a date after its UTC capture cut')
        if (ids.has(fee.activityId))
          return yield* paginationFailure('InvalidFeeHistory', 'fee history repeated an activity identity')
        ids.add(fee.activityId)
        rows.push({ value: fee, evidence: page.evidence })
      }
      const next = page.value.nextPageToken
      if (next === undefined) return rows
      if (next === cursor || next !== page.value.items.at(-1)?.activityId)
        return yield* paginationFailure('InvalidFeeHistory', 'fee history cursor did not advance')
      cursor = next
    }
  })

const readHistory = (
  read: BrokerReadShape,
  until: string,
): Effect.Effect<BrokerHistory, BrokerReadError | ReconciliationError> =>
  Effect.all(
    {
      orders: readOrderPages(read, until, initialOrderPaginationState()),
      fills: readFillPages(read, until, initialFillPaginationState()),
      fees: readFeePages(read),
    },
    { concurrency: 3 },
  )

const historyHashResult = (history: BrokerHistory): Result.Result<string, HistoryHashFailure> =>
  pipe(
    Result.try({
      try: () => ({
        schemaVersion: 'bayn.paper-broker-history.v2',
        fees: history.fees
          .map(({ value }) => value)
          .sort((left, right) => left.activityId.localeCompare(right.activityId)),
        orders: history.orders.rows
          .map(({ value }) => {
            const { observedAt: _observedAt, legs, ...material } = value
            return {
              ...material,
              ...(legs === undefined ? {} : { legs: legs.map(({ observedAt: _legObservedAt, ...leg }) => leg) }),
            }
          })
          .sort((left, right) => left.brokerOrderId.localeCompare(right.brokerOrderId)),
        fills: history.fills
          .map(({ value }) => value)
          .sort((left, right) => left.activityId.localeCompare(right.activityId)),
      }),
      catch: (cause): HistoryHashFailure => ({ _tag: 'HistoryMaterializationFailed', cause }),
    }),
    Result.flatMap((material) =>
      pipe(
        canonicalHashV1Result(material),
        Result.mapError((cause): HistoryHashFailure => ({ _tag: 'HistoryCanonicalizationFailed', cause })),
      ),
    ),
  )

export const decideStableHistory = (
  before: BrokerHistory,
  after: BrokerHistory,
): Result.Result<BrokerHistory, ReconciliationError> =>
  Result.gen(function* () {
    const beforeHash = yield* pipe(
      historyHashResult(before),
      Result.mapError((error) => historyHashFailure('before', error)),
    )
    const afterHash = yield* pipe(
      historyHashResult(after),
      Result.mapError((error) => historyHashFailure('after', error)),
    )
    if (beforeHash !== afterHash) {
      return yield* Result.fail(snapshotFailure('HistoryChanged', 'broker history changed during reconciliation'))
    }
    const filledByOrder = new Map<string, bigint>()
    for (const { value: fill } of after.fills) {
      filledByOrder.set(fill.brokerOrderId, (filledByOrder.get(fill.brokerOrderId) ?? 0n) + BigInt(fill.quantityAtoms))
    }
    if (
      after.orders.rows.some(
        ({ value: order }) => BigInt(order.filledQuantityAtoms) !== (filledByOrder.get(order.brokerOrderId) ?? 0n),
      )
    ) {
      return yield* Result.fail(
        snapshotFailure('FillActivitiesPending', 'broker order quantities and fill activities have not converged'),
      )
    }
    return after
  })

export const readStableBrokerSnapshot = (
  read: BrokerReadShape,
  now: Effect.Effect<string, ReconciliationError>,
): Effect.Effect<StableBrokerSnapshot, BrokerReadError | ReconciliationError> =>
  read.projection?.snapshot ??
  Effect.gen(function* () {
    const beforeUntil = yield* now
    const before = yield* readHistory(read, beforeUntil)
    const [account, positions] = yield* Effect.all([read.account, read.positions], { concurrency: 2 })
    const afterUntil = yield* now
    const after = yield* readHistory(read, afterUntil)
    const history = yield* Effect.fromResult(decideStableHistory(before, after))
    return { account, positions, history }
  }).pipe(
    Effect.retry({
      times: 2,
      schedule: Schedule.spaced(500),
      while: (cause) =>
        cause instanceof ReconciliationError &&
        cause.failure?._tag === 'Snapshot' &&
        (cause.failure.reason === 'HistoryChanged' || cause.failure.reason === 'FillActivitiesPending'),
    }),
  )
