import { HashMap, HashSet, Option, Result, pipe } from 'effect'

import { canonicalHashV1 } from './hash'
import {
  AccountStatus,
  DiscrepancyKind,
  IntentState,
  OrderStatus,
  TerminalOutcome,
  type AccountSnapshot,
  type AuthorityState,
  type Fill,
  type Order,
  type Position,
  type Reconciliation,
  type Valuation,
} from './paper'
import type { IsoDate } from './schemas'
import { roundUnsignedHalfUp } from './unsigned-round-half-up'

export interface IntentExpectation {
  readonly intentId: string
  readonly clientOrderId: string
  readonly symbol: string
  readonly side: Order['side']
  readonly orderType: Order['orderType']
  readonly timeInForce: Order['timeInForce']
  readonly quantityMicros: string
  readonly state: IntentState
  readonly terminalOutcome?: TerminalOutcome
  readonly expectsBrokerOrder: boolean
  readonly brokerOrderId?: string
  readonly unknownSince?: string
}

export interface DurableFill {
  readonly fillId: string
  readonly brokerOrderId: string
  readonly accounted: boolean
}

export interface ProjectedPosition {
  readonly symbol: string
  readonly quantityMicros: string
  readonly costBasisMicros: string
}

export interface ReconciliationSnapshot {
  readonly accountId: string
  readonly stateHash: string
  readonly account: AccountSnapshot
  readonly positions: readonly Position[]
  readonly orders: readonly Order[]
  readonly fills: readonly Fill[]
  readonly intents: readonly IntentExpectation[]
  readonly durableFills: readonly DurableFill[]
  readonly projectedPositions: readonly ProjectedPosition[]
  readonly expectedCashMicros: string
  readonly valuation: Valuation
  readonly accountingHash: string
  readonly ledgerExact: boolean
  readonly reconciledAt: string
}

export interface ReconciledStateMaterial {
  readonly account: AccountSnapshot
  readonly positions: readonly Position[]
  readonly positionsObservedAt: string
  readonly orders: readonly Order[]
  readonly ordersObservedAt: string
  readonly accountingHash: string
}

export interface ReconciledBrokerState extends ReconciledStateMaterial {
  readonly reconciliation: Reconciliation
  readonly unknownOrderCount: number
}

interface ReconciliationRiskMaterial {
  readonly tradingDate: IsoDate
  readonly unknownMutationCount: number
  readonly dailyTradedNotionalMicros: string
  readonly dayStartEquityMicros: string
  readonly peakEquityMicros: string
}

export type ReconciliationRiskContext = ReconciliationRiskMaterial &
  (
    | {
        readonly authority: AuthorityState
        readonly authorityObservedAt: string
      }
    | {
        readonly authority: null
        readonly authorityObservedAt: null
      }
  )

export interface DiscrepancyInput {
  readonly discrepancyId: string
  readonly kind: DiscrepancyKind
  readonly identity: string
  readonly expected: string
  readonly observed: string
  readonly evidenceHash: string
}

export interface ReconciliationMetrics {
  readonly brokerPollAgeMs: number
  readonly oldestUnknownMutationAgeMs: number
  readonly cashDifferenceMicros: string
  readonly positionDifferenceMicros: string
  readonly equityDifferenceMicros: string
  readonly accountingExact: boolean
  readonly discrepancyCount: number
}

export interface ReconciliationComparison {
  readonly expectedHash: string
  readonly observedHash: string
  readonly discrepancies: readonly DiscrepancyInput[]
  readonly metrics: ReconciliationMetrics
}

const absent = '<absent>'
const expectedResolution = '<resolved>'
const openOrder = '<open>'

type ReconciliationIdentityCollection =
  | 'broker-client-order'
  | 'broker-fill'
  | 'broker-order'
  | 'broker-position'
  | 'discrepancy'
  | 'durable-fill'
  | 'intent-client-order'
  | 'projected-position'

type ReconciliationHashOperation =
  | 'broker-state-hash'
  | 'discrepancy-evidence'
  | 'discrepancy-id'
  | 'observed-hash'
  | 'reconciled-state-hash'

type ReconciliationInstantField =
  | 'account.observedAt'
  | 'intent.unknownSince'
  | 'order.observedAt'
  | 'position.observedAt'
  | 'reconciledAt'
  | 'valuation.asOf'

type ReconciliationAccountSource = 'account' | 'fill' | 'order' | 'position' | 'valuation'

type ReconciliationIntegerSource =
  | 'account-cash'
  | 'account-equity'
  | 'expected-cash'
  | 'fill-quantity'
  | 'order-filled-quantity'
  | 'position-average-price'
  | 'position-quantity'
  | 'projected-position-cost'
  | 'projected-position-quantity'
  | 'valuation-equity'

export type ReconciliationDecisionError =
  | {
      readonly _tag: 'CanonicalizationFailed'
      readonly operation: ReconciliationHashOperation
      readonly identity?: string
      readonly cause: unknown
    }
  | {
      readonly _tag: 'FixedPointRoundingFailed'
      readonly symbol: string
      readonly quantityMicros: string
      readonly averageEntryPriceMicros: string
      readonly cause: unknown
    }
  | {
      readonly _tag: 'InvalidInstant'
      readonly field: ReconciliationInstantField
      readonly identity: string
      readonly value: string
    }
  | {
      readonly _tag: 'InvalidInteger'
      readonly source: ReconciliationIntegerSource
      readonly identity: string
      readonly value: string
      readonly cause: unknown
    }
  | {
      readonly _tag: 'DuplicateIdentity'
      readonly collection: ReconciliationIdentityCollection
      readonly identity: string
    }
  | {
      readonly _tag: 'DiscrepancyWithoutDifference'
      readonly kind: DiscrepancyKind
      readonly identity: string
      readonly value: string
    }
  | {
      readonly _tag: 'IntentTerminalStateMismatch'
      readonly intentId: string
      readonly state: IntentState
      readonly terminalOutcome: TerminalOutcome | null
    }
  | {
      readonly _tag: 'IntentBrokerOrderBindingMismatch'
      readonly intentId: string
      readonly expectsBrokerOrder: boolean
      readonly brokerOrderId: string | null
    }
  | {
      readonly _tag: 'BrokerOrderIdentityMissing'
      readonly intentId: string
      readonly clientOrderId: string
    }
  | {
      readonly _tag: 'AccountBindingMismatch'
      readonly source: ReconciliationAccountSource
      readonly identity: string
      readonly expectedAccountId: string
      readonly observedAccountId: string
    }

type ReconciliationDecision<A> = Result.Result<A, ReconciliationDecisionError>

const fail = <A>(error: ReconciliationDecisionError): ReconciliationDecision<A> => Result.fail(error)

const canonicalHash = (
  operation: ReconciliationHashOperation,
  value: unknown,
  identity?: string,
): ReconciliationDecision<string> =>
  pipe(
    Result.try(() => canonicalHashV1(value)),
    Result.mapError(
      (cause): ReconciliationDecisionError => ({
        _tag: 'CanonicalizationFailed',
        operation,
        ...(identity === undefined ? {} : { identity }),
        cause,
      }),
    ),
  )

const absolute = (value: bigint): bigint => (value < 0n ? -value : value)

const integer = (
  source: ReconciliationIntegerSource,
  identity: string,
  value: string,
): ReconciliationDecision<bigint> =>
  pipe(
    Result.try(() => BigInt(value)),
    Result.mapError(
      (cause): ReconciliationDecisionError => ({
        _tag: 'InvalidInteger',
        source,
        identity,
        value,
        cause,
      }),
    ),
  )

const roundMicrosProduct = (
  symbol: string,
  quantityMicros: string,
  averageEntryPriceMicros: string,
): ReconciliationDecision<bigint> =>
  pipe(
    Result.all({
      quantity: integer('position-quantity', symbol, quantityMicros),
      averageEntryPrice: integer('position-average-price', symbol, averageEntryPriceMicros),
    }),
    Result.flatMap(({ averageEntryPrice, quantity }) =>
      pipe(
        roundUnsignedHalfUp(absolute(quantity) * averageEntryPrice, 1_000_000n),
        Result.mapError(
          (cause): ReconciliationDecisionError => ({
            _tag: 'FixedPointRoundingFailed',
            symbol,
            quantityMicros,
            averageEntryPriceMicros,
            cause,
          }),
        ),
      ),
    ),
  )

export const reconciledStateHash = (state: ReconciledStateMaterial): ReconciliationDecision<string> =>
  pipe(
    canonicalHash('broker-state-hash', {
      schemaVersion: 'bayn.paper-risk-broker-state.v1',
      account: state.account,
      positions: state.positions,
      positionsObservedAt: state.positionsObservedAt,
      orders: state.orders,
      ordersObservedAt: state.ordersObservedAt,
    }),
    Result.flatMap((brokerStateHash) =>
      canonicalHash('reconciled-state-hash', {
        schemaVersion: 'bayn.paper-risk-reconciled-state.v1',
        brokerStateHash,
        accountingHash: state.accountingHash,
      }),
    ),
  )

const instant = (
  field: ReconciliationInstantField,
  identity: string,
  value: string,
): ReconciliationDecision<number> => {
  const milliseconds = Date.parse(value)
  return Number.isFinite(milliseconds)
    ? Result.succeed(milliseconds)
    : fail({ _tag: 'InvalidInstant', field, identity, value })
}

const indexUnique = <A>(
  values: readonly A[],
  identity: (value: A) => string,
  collection: ReconciliationIdentityCollection,
): ReconciliationDecision<HashMap.HashMap<string, A>> =>
  values.reduce<ReconciliationDecision<HashMap.HashMap<string, A>>>(
    (indexed, value) =>
      pipe(
        indexed,
        Result.flatMap((current) => {
          const key = identity(value)
          return HashMap.has(current, key)
            ? fail({ _tag: 'DuplicateIdentity', collection, identity: key })
            : Result.succeed(HashMap.set(current, key, value))
        }),
      ),
    Result.succeed(HashMap.empty()),
  )

const discrepancy = (
  accountId: string,
  kind: DiscrepancyKind,
  identity: string,
  expected: string,
  observed: string,
): ReconciliationDecision<DiscrepancyInput> =>
  expected === observed
    ? fail({ _tag: 'DiscrepancyWithoutDifference', kind, identity, value: expected })
    : pipe(
        canonicalHash(
          'discrepancy-id',
          {
            schemaVersion: 'bayn.paper-discrepancy-id.v1',
            accountId,
            kind,
            identity,
          },
          identity,
        ),
        Result.flatMap((discrepancyId) =>
          pipe(
            canonicalHash(
              'discrepancy-evidence',
              {
                schemaVersion: 'bayn.paper-discrepancy-evidence.v1',
                discrepancyId,
                expected,
                observed,
              },
              identity,
            ),
            Result.map((evidenceHash) => ({
              discrepancyId,
              kind,
              identity,
              expected,
              observed,
              evidenceHash,
            })),
          ),
        ),
      )

const compareValue = (
  accountId: string,
  kind: DiscrepancyKind,
  identity: string,
  expected: string,
  observed: string,
): ReconciliationDecision<readonly DiscrepancyInput[]> =>
  expected === observed
    ? Result.succeed([])
    : pipe(
        discrepancy(accountId, kind, identity, expected, observed),
        Result.map((value) => [value]),
      )

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

const compareOrders = (snapshot: ReconciliationSnapshot): ReconciliationDecision<readonly DiscrepancyInput[]> =>
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
        Result.all({
          totals,
          quantity: integer('fill-quantity', fill.fillId, fill.quantityMicros),
        }),
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

const compareFills = (snapshot: ReconciliationSnapshot): ReconciliationDecision<readonly DiscrepancyInput[]> =>
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

interface PositionComparison {
  readonly difference: bigint
  readonly discrepancies: readonly DiscrepancyInput[]
}

const comparePosition = (
  snapshot: ReconciliationSnapshot,
  observed: HashMap.HashMap<string, Position>,
  projected: HashMap.HashMap<string, ProjectedPosition>,
  symbol: string,
): ReconciliationDecision<PositionComparison> => {
  const expectedPosition = Option.getOrUndefined(HashMap.get(projected, symbol))
  const observedPosition = Option.getOrUndefined(HashMap.get(observed, symbol))
  const expectedQuantityText = expectedPosition?.quantityMicros ?? '0'
  const observedQuantityText = observedPosition?.quantityMicros ?? '0'
  const expectedCostText = expectedPosition?.costBasisMicros ?? '0'
  return pipe(
    Result.all({
      expectedQuantity: integer('projected-position-quantity', symbol, expectedQuantityText),
      observedQuantity: integer('position-quantity', symbol, observedQuantityText),
      expectedCost: integer('projected-position-cost', symbol, expectedCostText),
      observedCost:
        observedPosition === undefined
          ? Result.succeed(0n)
          : roundMicrosProduct(symbol, observedPosition.quantityMicros, observedPosition.averageEntryPriceMicros),
    }),
    Result.flatMap(({ expectedCost, expectedQuantity, observedCost, observedQuantity }) =>
      pipe(
        Result.all({
          quantity: compareValue(
            snapshot.accountId,
            DiscrepancyKind.Position,
            `${symbol}:quantity`,
            expectedQuantity.toString(),
            observedQuantity.toString(),
          ),
          cost: compareValue(
            snapshot.accountId,
            DiscrepancyKind.Position,
            `${symbol}:cost`,
            expectedCost.toString(),
            observedCost.toString(),
          ),
        }),
        Result.map(({ cost, quantity }) => ({
          difference: absolute(expectedQuantity - observedQuantity),
          discrepancies: [...quantity, ...cost],
        })),
      ),
    ),
  )
}

const comparePositions = (snapshot: ReconciliationSnapshot): ReconciliationDecision<PositionComparison> =>
  pipe(
    Result.all({
      observed: indexUnique(snapshot.positions, (position) => position.symbol, 'broker-position'),
      projected: indexUnique(snapshot.projectedPositions, (position) => position.symbol, 'projected-position'),
    }),
    Result.flatMap(({ observed, projected }) => {
      const symbols = [
        ...HashSet.union(HashSet.fromIterable(HashMap.keys(observed)), HashSet.fromIterable(HashMap.keys(projected))),
      ].sort()
      return pipe(
        Result.all(symbols.map((symbol) => comparePosition(snapshot, observed, projected, symbol))),
        Result.map((comparisons) => ({
          difference: comparisons.reduce((total, comparison) => total + comparison.difference, 0n),
          discrepancies: comparisons.flatMap((comparison) => comparison.discrepancies),
        })),
      )
    }),
  )

const accountBinding = (
  source: ReconciliationAccountSource,
  identity: string,
  expectedAccountId: string,
  observedAccountId: string,
): ReconciliationDecision<void> =>
  observedAccountId === expectedAccountId
    ? Result.succeed(undefined)
    : fail({
        _tag: 'AccountBindingMismatch',
        source,
        identity,
        expectedAccountId,
        observedAccountId,
      })

const validateAccountBindings = (snapshot: ReconciliationSnapshot): ReconciliationDecision<void> =>
  pipe(
    Result.all([
      accountBinding('account', snapshot.account.accountId, snapshot.accountId, snapshot.account.accountId),
      accountBinding('valuation', snapshot.valuation.valuationId, snapshot.accountId, snapshot.valuation.accountId),
      ...snapshot.positions.map((position) =>
        accountBinding('position', position.symbol, snapshot.accountId, position.accountId),
      ),
      ...snapshot.orders.map((order) =>
        accountBinding('order', order.brokerOrderId, snapshot.accountId, order.accountId),
      ),
      ...snapshot.fills.map((fill) => accountBinding('fill', fill.fillId, snapshot.accountId, fill.accountId)),
    ]),
    Result.map(() => undefined),
  )

interface ScalarComparison {
  readonly difference: bigint
  readonly discrepancies: readonly DiscrepancyInput[]
}

const compareCash = (snapshot: ReconciliationSnapshot): ReconciliationDecision<ScalarComparison> =>
  pipe(
    Result.all({
      expected: integer('expected-cash', snapshot.accountId, snapshot.expectedCashMicros),
      observed: integer('account-cash', snapshot.accountId, snapshot.account.cashMicros),
    }),
    Result.flatMap(({ expected, observed }) =>
      pipe(
        compareValue(
          snapshot.accountId,
          DiscrepancyKind.Cash,
          snapshot.accountId,
          expected.toString(),
          observed.toString(),
        ),
        Result.map((discrepancies) => ({ difference: observed - expected, discrepancies })),
      ),
    ),
  )

const compareEquity = (snapshot: ReconciliationSnapshot): ReconciliationDecision<ScalarComparison> =>
  pipe(
    Result.all({
      expected: integer('valuation-equity', snapshot.accountId, snapshot.valuation.equityMicros),
      observed: integer('account-equity', snapshot.accountId, snapshot.account.equityMicros),
    }),
    Result.flatMap(({ expected, observed }) =>
      pipe(
        compareValue(
          snapshot.accountId,
          DiscrepancyKind.Valuation,
          snapshot.accountId,
          expected.toString(),
          observed.toString(),
        ),
        Result.map((discrepancies) => ({ difference: observed - expected, discrepancies })),
      ),
    ),
  )

const compareAccountStatus = (snapshot: ReconciliationSnapshot): ReconciliationDecision<readonly DiscrepancyInput[]> =>
  compareValue(
    snapshot.accountId,
    DiscrepancyKind.Account,
    snapshot.accountId,
    AccountStatus.Active,
    snapshot.account.status,
  )

const compareLedger = (snapshot: ReconciliationSnapshot): ReconciliationDecision<readonly DiscrepancyInput[]> =>
  snapshot.ledgerExact
    ? Result.succeed([])
    : compareValue(
        snapshot.accountId,
        DiscrepancyKind.Accounting,
        `${snapshot.accountId}:ledger`,
        'EXACT',
        `MISMATCH:${snapshot.accountingHash}`,
      )

interface TemporalMetrics {
  readonly brokerPollAgeMs: number
  readonly oldestUnknownMutationAgeMs: number
}

const temporalMetrics = (snapshot: ReconciliationSnapshot): ReconciliationDecision<TemporalMetrics> =>
  pipe(
    Result.all({
      reconciledAt: instant('reconciledAt', snapshot.accountId, snapshot.reconciledAt),
      brokerTimes: Result.all([
        instant('account.observedAt', snapshot.account.accountId, snapshot.account.observedAt),
        instant('valuation.asOf', snapshot.valuation.valuationId, snapshot.valuation.asOf),
        ...snapshot.positions.map((position) => instant('position.observedAt', position.symbol, position.observedAt)),
        ...snapshot.orders.map((order) => instant('order.observedAt', order.brokerOrderId, order.observedAt)),
      ]),
      unknownTimes: Result.all(
        snapshot.intents.flatMap((intent) =>
          intent.unknownSince === undefined
            ? []
            : [instant('intent.unknownSince', intent.intentId, intent.unknownSince)],
        ),
      ),
    }),
    Result.map(({ brokerTimes, reconciledAt, unknownTimes }) => ({
      brokerPollAgeMs: Math.max(0, reconciledAt - (brokerTimes.length === 0 ? reconciledAt : Math.min(...brokerTimes))),
      oldestUnknownMutationAgeMs: unknownTimes.length === 0 ? 0 : Math.max(0, reconciledAt - Math.min(...unknownTimes)),
    })),
  )

export const compareReconciliation = (
  snapshot: ReconciliationSnapshot,
): ReconciliationDecision<ReconciliationComparison> =>
  pipe(
    Result.all({
      bindings: validateAccountBindings(snapshot),
      account: compareAccountStatus(snapshot),
      orders: compareOrders(snapshot),
      fills: compareFills(snapshot),
      positions: comparePositions(snapshot),
      cash: compareCash(snapshot),
      equity: compareEquity(snapshot),
      ledger: compareLedger(snapshot),
      temporal: temporalMetrics(snapshot),
    }),
    Result.flatMap(({ account, cash, equity, fills, ledger, orders, positions, temporal }) => {
      const ordered = [
        ...account,
        ...orders,
        ...fills,
        ...positions.discrepancies,
        ...cash.discrepancies,
        ...equity.discrepancies,
        ...ledger,
      ].sort((left, right) =>
        left.discrepancyId < right.discrepancyId ? -1 : left.discrepancyId > right.discrepancyId ? 1 : 0,
      )
      return pipe(
        indexUnique(ordered, (value) => value.discrepancyId, 'discrepancy'),
        Result.flatMap(() =>
          ordered.length === 0
            ? Result.succeed(snapshot.stateHash)
            : canonicalHash('observed-hash', {
                schemaVersion: 'bayn.paper-reconciliation-observed.v1',
                stateHash: snapshot.stateHash,
                discrepancies: ordered.map((value) => value.evidenceHash),
              }),
        ),
        Result.map((observedHash) => ({
          expectedHash: snapshot.stateHash,
          observedHash,
          discrepancies: ordered,
          metrics: {
            ...temporal,
            cashDifferenceMicros: cash.difference.toString(),
            positionDifferenceMicros: positions.difference.toString(),
            equityDifferenceMicros: equity.difference.toString(),
            accountingExact: snapshot.ledgerExact,
            discrepancyCount: ordered.length,
          },
        })),
      )
    }),
  )

export const renderReconciliationDecisionError = (error: ReconciliationDecisionError): string => {
  switch (error._tag) {
    case 'CanonicalizationFailed':
      return `reconciliation ${error.operation} canonicalization failed${error.identity === undefined ? '' : ` for ${error.identity}`}`
    case 'FixedPointRoundingFailed':
      return `position ${error.symbol} cost could not be rounded from quantity ${error.quantityMicros} and price ${error.averageEntryPriceMicros}`
    case 'InvalidInstant':
      return `reconciliation ${error.field} for ${error.identity} is invalid: ${error.value}`
    case 'InvalidInteger':
      return `reconciliation ${error.source} for ${error.identity} is invalid: ${error.value}`
    case 'DuplicateIdentity':
      return `duplicate ${error.collection} identity ${error.identity}`
    case 'DiscrepancyWithoutDifference':
      return `reconciliation discrepancy ${error.kind}:${error.identity} has equal value ${error.value}`
    case 'IntentTerminalStateMismatch':
      return `intent ${error.intentId} terminal state ${error.state} and outcome ${error.terminalOutcome ?? '<absent>'} disagree`
    case 'IntentBrokerOrderBindingMismatch':
      return `intent ${error.intentId} broker-order expectation ${error.expectsBrokerOrder} and identity ${error.brokerOrderId ?? '<absent>'} disagree`
    case 'BrokerOrderIdentityMissing':
      return `intent ${error.intentId} for client order ${error.clientOrderId} has no broker order identity`
    case 'AccountBindingMismatch':
      return `${error.source} ${error.identity} account ${error.observedAccountId} does not match ${error.expectedAccountId}`
  }
}
