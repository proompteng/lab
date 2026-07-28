import { HashMap, Option, Result, pipe } from 'effect'

import {
  DiscrepancyKind,
  IntentState,
  OrderStatus,
  TerminalOutcome,
  type Fill,
  type Order,
} from '../execution/contracts'
import {
  absent,
  compareValue,
  expectedResolution,
  fail,
  indexUnique,
  integer,
  openOrder,
  type DiscrepancyInput,
  type DurableFill,
  type IntentExpectation,
  type ReconciliationDecision,
  type ReconciliationSnapshot,
} from './broker-model'

const terminalOutcome = (status: OrderStatus): TerminalOutcome | undefined => {
  switch (status) {
    case OrderStatus.Filled:
      return TerminalOutcome.Filled
    case OrderStatus.Canceled:
      return TerminalOutcome.Canceled
    case OrderStatus.Expired:
      return TerminalOutcome.Expired
    case OrderStatus.Rejected:
      return TerminalOutcome.Rejected
    default:
      return undefined
  }
}

const validateIntent = (intent: IntentExpectation): ReconciliationDecision<void> => {
  if ((intent.state === IntentState.Terminal) !== (intent.terminalOutcome !== undefined)) {
    return fail({
      _tag: 'IntentTerminalStateMismatch',
      intentId: intent.intentId,
      state: intent.state,
      terminalOutcome: intent.terminalOutcome ?? null,
    })
  }
  return intent.expectsBrokerOrder === (intent.brokerOrderId !== undefined)
    ? Result.succeed(undefined)
    : fail({
        _tag: 'IntentBrokerOrderBindingMismatch',
        intentId: intent.intentId,
        expectsBrokerOrder: intent.expectsBrokerOrder,
        brokerOrderId: intent.brokerOrderId ?? null,
      })
}

const brokerOrderIdentity = (intent: IntentExpectation): ReconciliationDecision<string> =>
  intent.brokerOrderId === undefined
    ? fail({
        _tag: 'BrokerOrderIdentityMissing',
        intentId: intent.intentId,
        clientOrderId: intent.clientOrderId,
      })
    : Result.succeed(intent.brokerOrderId)

const compareObservedOrder = (
  snapshot: ReconciliationSnapshot,
  intents: HashMap.HashMap<string, IntentExpectation>,
  order: Order,
): ReconciliationDecision<readonly DiscrepancyInput[]> => {
  const intent = Option.getOrUndefined(HashMap.get(intents, order.clientOrderId))
  if (intent === undefined || !intent.expectsBrokerOrder) {
    return compareValue(
      snapshot.accountId,
      DiscrepancyKind.Order,
      `${order.clientOrderId}:presence`,
      absent,
      order.brokerOrderId,
    )
  }
  return pipe(
    brokerOrderIdentity(intent),
    Result.flatMap((expectedBrokerOrderId) => {
      const expectedOrder = [
        expectedBrokerOrderId,
        intent.symbol,
        intent.side,
        intent.orderType,
        intent.timeInForce,
        intent.quantityMicros,
      ].join(':')
      const observedOrder = [
        order.brokerOrderId,
        order.symbol,
        order.side,
        order.orderType,
        order.timeInForce,
        order.quantityMicros,
      ].join(':')
      return pipe(
        Result.all({
          content: compareValue(
            snapshot.accountId,
            DiscrepancyKind.Order,
            `${intent.clientOrderId}:content`,
            expectedOrder,
            observedOrder,
          ),
          lifecycle: compareValue(
            snapshot.accountId,
            DiscrepancyKind.Order,
            `${intent.clientOrderId}:lifecycle`,
            intent.terminalOutcome ?? openOrder,
            terminalOutcome(order.status) ?? openOrder,
          ),
        }),
        Result.map(({ content, lifecycle }) => [...content, ...lifecycle]),
      )
    }),
  )
}

const compareExpectedIntent = (
  snapshot: ReconciliationSnapshot,
  ordersByClient: HashMap.HashMap<string, Order>,
  intent: IntentExpectation,
): ReconciliationDecision<readonly DiscrepancyInput[]> => {
  const missingOrder = intent.expectsBrokerOrder && !HashMap.has(ordersByClient, intent.clientOrderId)
  const presence = missingOrder
    ? pipe(
        brokerOrderIdentity(intent),
        Result.flatMap((brokerOrderId) =>
          compareValue(
            snapshot.accountId,
            DiscrepancyKind.Order,
            `${intent.clientOrderId}:presence`,
            brokerOrderId,
            absent,
          ),
        ),
      )
    : Result.succeed<readonly DiscrepancyInput[]>([])
  const mutation =
    intent.unknownSince === undefined
      ? Result.succeed<readonly DiscrepancyInput[]>([])
      : compareValue(
          snapshot.accountId,
          DiscrepancyKind.Mutation,
          intent.intentId,
          expectedResolution,
          `UNKNOWN:${intent.unknownSince}`,
        )
  return pipe(
    Result.all({ mutation, presence }),
    Result.map(({ mutation, presence }) => [...presence, ...mutation]),
  )
}

export const compareOrders = (snapshot: ReconciliationSnapshot): ReconciliationDecision<readonly DiscrepancyInput[]> =>
  pipe(
    Result.all({
      intents: indexUnique(snapshot.intents, (intent) => intent.clientOrderId, 'intent-client-order'),
      ordersByClient: indexUnique(snapshot.orders, (order) => order.clientOrderId, 'broker-client-order'),
      brokerOrders: indexUnique(snapshot.orders, (order) => order.brokerOrderId, 'broker-order'),
      validIntents: Result.all(snapshot.intents.map(validateIntent)),
    }),
    Result.flatMap(({ intents, ordersByClient }) =>
      pipe(
        Result.all({
          observed: Result.all(snapshot.orders.map((order) => compareObservedOrder(snapshot, intents, order))),
          expected: Result.all(
            snapshot.intents.map((intent) => compareExpectedIntent(snapshot, ordersByClient, intent)),
          ),
        }),
        Result.map(({ expected, observed }) => [...observed.flat(), ...expected.flat()]),
      ),
    ),
  )

const fillQuantities = (fills: readonly Fill[]): ReconciliationDecision<HashMap.HashMap<string, bigint>> =>
  fills.reduce<ReconciliationDecision<HashMap.HashMap<string, bigint>>>(
    (totals, fill) =>
      pipe(
        Result.all({ totals, quantity: integer('fill-quantity', fill.fillId, fill.quantityMicros) }),
        Result.map(({ quantity, totals }) =>
          HashMap.set(
            totals,
            fill.brokerOrderId,
            Option.getOrElse(HashMap.get(totals, fill.brokerOrderId), () => 0n) + quantity,
          ),
        ),
      ),
    Result.succeed(HashMap.empty()),
  )

const compareObservedFill = (
  snapshot: ReconciliationSnapshot,
  durable: HashMap.HashMap<string, DurableFill>,
  fill: Fill,
): ReconciliationDecision<readonly DiscrepancyInput[]> => {
  const stored = Option.getOrUndefined(HashMap.get(durable, fill.fillId))
  if (stored === undefined) {
    return compareValue(snapshot.accountId, DiscrepancyKind.Fill, fill.fillId, 'durable', absent)
  }
  return pipe(
    Result.all({
      order: compareValue(
        snapshot.accountId,
        DiscrepancyKind.Fill,
        fill.fillId,
        stored.brokerOrderId,
        fill.brokerOrderId,
      ),
      accounting: stored.accounted
        ? Result.succeed<readonly DiscrepancyInput[]>([])
        : compareValue(snapshot.accountId, DiscrepancyKind.Accounting, fill.fillId, 'POSTED', 'MISSING'),
    }),
    Result.map(({ accounting, order }) => [...order, ...accounting]),
  )
}

const compareDurableFill = (
  snapshot: ReconciliationSnapshot,
  observed: HashMap.HashMap<string, Fill>,
  fill: DurableFill,
): ReconciliationDecision<readonly DiscrepancyInput[]> =>
  HashMap.has(observed, fill.fillId)
    ? Result.succeed([])
    : compareValue(snapshot.accountId, DiscrepancyKind.Fill, fill.fillId, 'broker', absent)

const compareOrderFillQuantity = (
  snapshot: ReconciliationSnapshot,
  filledByOrder: HashMap.HashMap<string, bigint>,
  order: Order,
): ReconciliationDecision<readonly DiscrepancyInput[]> =>
  pipe(
    integer('order-filled-quantity', order.brokerOrderId, order.filledQuantityMicros),
    Result.flatMap((expected) =>
      compareValue(
        snapshot.accountId,
        DiscrepancyKind.Fill,
        `${order.brokerOrderId}:quantity`,
        expected.toString(),
        Option.getOrElse(HashMap.get(filledByOrder, order.brokerOrderId), () => 0n).toString(),
      ),
    ),
  )

export const compareFills = (snapshot: ReconciliationSnapshot): ReconciliationDecision<readonly DiscrepancyInput[]> =>
  pipe(
    Result.all({
      observed: indexUnique(snapshot.fills, (fill) => fill.fillId, 'broker-fill'),
      durable: indexUnique(snapshot.durableFills, (fill) => fill.fillId, 'durable-fill'),
      filledByOrder: fillQuantities(snapshot.fills),
    }),
    Result.flatMap(({ durable, filledByOrder, observed }) =>
      pipe(
        Result.all({
          observedFills: Result.all(snapshot.fills.map((fill) => compareObservedFill(snapshot, durable, fill))),
          durableFills: Result.all(snapshot.durableFills.map((fill) => compareDurableFill(snapshot, observed, fill))),
          orders: Result.all(snapshot.orders.map((order) => compareOrderFillQuantity(snapshot, filledByOrder, order))),
        }),
        Result.map(({ durableFills, observedFills, orders }) => [
          ...observedFills.flat(),
          ...durableFills.flat(),
          ...orders.flat(),
        ]),
      ),
    ),
  )
