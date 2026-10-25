import { Chunk, Effect, HashMap, HashSet, Option, Result, pipe } from 'effect'

import type { FillActivity, Order as BrokerOrder } from '../broker/alpaca/model'
import { verifyProtectionGroup } from '../broker/alpaca/protection-group'
import {
  accountObservation,
  fillObservation,
  orderObservation,
  positionSnapshot,
  type PositionSnapshotInput,
} from '../broker/observations'
import type { ReconciliationPersistence } from '../db/execution-store'
import type { IntentBinding } from '../db/reconciliation'
import {
  compareText,
  mapObservationFailure,
  normalizeTimestamp,
  snapshotFailure,
  validationFailure,
  type AccountEventInput,
  type NormalizedBrokerSnapshot,
  type Observed,
  type OrderEventInput,
  type ReconciliationError,
  type StableBrokerSnapshot,
} from './broker-reconciler-model'

const indexBindings = (
  bindings: readonly IntentBinding[],
): Result.Result<HashMap.HashMap<string, string>, ReconciliationError> =>
  bindings.reduce<Result.Result<HashMap.HashMap<string, string>, ReconciliationError>>((result, binding) => {
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
): Result.Result<OrderNormalizationState, ReconciliationError> =>
  rows.reduce<Result.Result<OrderNormalizationState, ReconciliationError>>(
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
      const normalized = mapObservationFailure(
        'order',
        observed.value.brokerOrderId,
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
) => {
  const timestamped = Result.all(
    fills.map((observed) =>
      pipe(
        normalizeTimestamp('fill-ordering', observed.value.activityId, observed.value.transactionTime),
        Result.map((timestamp) => ({ observed, timestamp })),
      ),
    ),
  )
  if (Result.isFailure(timestamped)) return Result.fail(timestamped.failure)
  const ordered = [...timestamped.success].sort((left, right) => {
    const byTime = compareText(left.timestamp, right.timestamp)
    return byTime === 0 ? compareText(left.observed.value.activityId, right.observed.value.activityId) : byTime
  })
  return Result.all(
    ordered.map(({ observed }) => {
      const order = Option.getOrUndefined(HashMap.get(orders.orderById, observed.value.brokerOrderId))
      if (order === undefined) {
        return Result.fail(
          validationFailure('FillOrderMissing', `Alpaca fill ${observed.value.activityId} references a missing order`),
        )
      }
      return mapObservationFailure(
        'fill',
        observed.value.activityId,
        fillObservation(
          observed.value,
          order,
          observed.evidence,
          Option.match(HashMap.get(intentByClient, order.clientOrderId), {
            onNone: () => ({}),
            onSome: (intentId) => ({ intentId }),
          }),
        ),
      )
    }),
  )
}

const normalizeAccount = (
  account: StableBrokerSnapshot['account'],
): Result.Result<AccountEventInput, ReconciliationError> => {
  const normalized = mapObservationFailure('account', account.value.id, accountObservation(account))
  if (Result.isFailure(normalized)) return Result.fail(normalized.failure)
  return normalized.success._tag === 'Account'
    ? Result.succeed(normalized.success)
    : Result.fail(validationFailure('UnexpectedAccountEvent', 'normalized account event is not an account'))
}

const normalizePositions = (
  accountId: string,
  positions: StableBrokerSnapshot['positions'],
): Result.Result<PositionSnapshotInput, ReconciliationError> =>
  mapObservationFailure('positions', accountId, positionSnapshot(accountId, positions))

export const normalizeSnapshot = (
  snapshot: StableBrokerSnapshot,
  bindings: readonly IntentBinding[],
): Result.Result<NormalizedBrokerSnapshot, ReconciliationError> =>
  Result.gen(function* () {
    const expandedBindings = [...bindings]
    const rows: Observed<BrokerOrder>[] = []
    for (const observed of snapshot.history.orders.rows) {
      rows.push(observed)
      const parent = observed.value
      if (parent.legs === undefined) continue
      const binding = bindings.find((item) => item.clientOrderId === parent.clientOrderId)
      if (binding?.protection === undefined || binding.symbol === undefined || binding.quantityAtoms === undefined)
        return yield* Result.fail(
          validationFailure('UnexpectedOrderEvent', 'broker children have no immutable strategy protection intent'),
        )
      const children = verifyProtectionGroup(parent, {
        symbol: binding.symbol,
        quantityAtoms: binding.quantityAtoms,
        protection: binding.protection,
      })
      if (Result.isFailure(children))
        return yield* Result.fail(validationFailure('UnexpectedOrderEvent', children.failure))
      for (const child of children.success) {
        expandedBindings.push({ intentId: binding.intentId, clientOrderId: child.clientOrderId })
        rows.push({ value: child, evidence: observed.evidence })
      }
    }
    const intentByClient = yield* indexBindings(expandedBindings)
    const orders = yield* normalizeOrders(rows, intentByClient)
    const fillEvents = yield* normalizeFills(snapshot.history.fills, orders, intentByClient)
    const account = yield* normalizeAccount(snapshot.account)
    const positions = yield* normalizePositions(snapshot.account.value.id, snapshot.positions)
    return {
      account,
      cashReportingQuantumMicros: snapshot.account.value.cashReportingQuantumMicros,
      positions,
      orderEvents: Chunk.toReadonlyArray(orders.events),
      fillEvents,
      fees: snapshot.history.fees,
    }
  })

export const decideAccountBaseline = (hasAccountBaseline: boolean): Result.Result<void, ReconciliationError> =>
  hasAccountBaseline
    ? Result.succeed(undefined)
    : Result.fail(
        snapshotFailure(
          'AccountBaselineMissing',
          'broker account has fill history before Bayn established an opening cash baseline',
        ),
      )

export const prepareNormalizedSnapshot = (store: ReconciliationPersistence, snapshot: StableBrokerSnapshot) =>
  Effect.gen(function* () {
    const bindings = yield* store.reconciliation.bindings(snapshot.account.value.id)
    if (snapshot.history.fills.length > 0 || snapshot.history.fees.length > 0) {
      const hasAccountBaseline = yield* store.valuation.hasAccountBaseline(snapshot.account.value.id)
      yield* Effect.fromResult(decideAccountBaseline(hasAccountBaseline))
    }
    return yield* Effect.fromResult(normalizeSnapshot(snapshot, bindings))
  })
