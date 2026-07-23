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

const absolute = (value: bigint): bigint => (value < 0n ? -value : value)
const roundMicrosProduct = (left: bigint, right: bigint): bigint => (left * right + 500_000n) / 1_000_000n

export const reconciledStateHash = (state: ReconciledStateMaterial): string => {
  const brokerStateHash = canonicalHashV1({
    schemaVersion: 'bayn.paper-risk-broker-state.v1',
    account: state.account,
    positions: state.positions,
    positionsObservedAt: state.positionsObservedAt,
    orders: state.orders,
    ordersObservedAt: state.ordersObservedAt,
  })
  return canonicalHashV1({
    schemaVersion: 'bayn.paper-risk-reconciled-state.v1',
    brokerStateHash,
    accountingHash: state.accountingHash,
  })
}

const instant = (value: string): number => {
  const milliseconds = Date.parse(value)
  if (!Number.isFinite(milliseconds)) throw new Error(`invalid reconciliation instant ${value}`)
  return milliseconds
}

const indexUnique = <A>(values: readonly A[], identity: (value: A) => string, label: string): Map<string, A> => {
  const indexed = new Map<string, A>()
  for (const value of values) {
    const key = identity(value)
    if (indexed.has(key)) throw new Error(`duplicate ${label} ${key}`)
    indexed.set(key, value)
  }
  return indexed
}

const discrepancy = (
  accountId: string,
  kind: DiscrepancyKind,
  identity: string,
  expected: string,
  observed: string,
): DiscrepancyInput => {
  if (expected === observed) throw new Error(`discrepancy ${kind}:${identity} does not differ`)
  const discrepancyId = canonicalHashV1({
    schemaVersion: 'bayn.paper-discrepancy-id.v1',
    accountId,
    kind,
    identity,
  })
  return {
    discrepancyId,
    kind,
    identity,
    expected,
    observed,
    evidenceHash: canonicalHashV1({
      schemaVersion: 'bayn.paper-discrepancy-evidence.v1',
      discrepancyId,
      expected,
      observed,
    }),
  }
}

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

const compareOrders = (snapshot: ReconciliationSnapshot, discrepancies: DiscrepancyInput[]): void => {
  const intents = indexUnique(snapshot.intents, (intent) => intent.clientOrderId, 'intent client order ID')
  const ordersByClient = indexUnique(snapshot.orders, (order) => order.clientOrderId, 'broker client order ID')
  indexUnique(snapshot.orders, (order) => order.brokerOrderId, 'broker order ID')

  for (const intent of snapshot.intents) {
    if ((intent.state === IntentState.Terminal) !== (intent.terminalOutcome !== undefined)) {
      throw new Error(`intent ${intent.intentId} terminal state and outcome disagree`)
    }
    if (intent.expectsBrokerOrder !== (intent.brokerOrderId !== undefined)) {
      throw new Error(`intent ${intent.intentId} broker order expectation and identity disagree`)
    }
  }

  for (const order of snapshot.orders) {
    const intent = intents.get(order.clientOrderId)
    if (intent === undefined) {
      discrepancies.push(
        discrepancy(
          snapshot.accountId,
          DiscrepancyKind.Order,
          `${order.clientOrderId}:presence`,
          absent,
          order.brokerOrderId,
        ),
      )
      continue
    }
    if (!intent.expectsBrokerOrder) {
      discrepancies.push(
        discrepancy(
          snapshot.accountId,
          DiscrepancyKind.Order,
          `${intent.clientOrderId}:presence`,
          absent,
          order.brokerOrderId,
        ),
      )
      continue
    }
    const expectedBrokerOrderId = intent.brokerOrderId
    if (expectedBrokerOrderId === undefined) throw new Error(`intent ${intent.intentId} has no broker order identity`)
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
    if (expectedOrder !== observedOrder) {
      discrepancies.push(
        discrepancy(
          snapshot.accountId,
          DiscrepancyKind.Order,
          `${intent.clientOrderId}:content`,
          expectedOrder,
          observedOrder,
        ),
      )
    }
    const expectedOutcome = intent.terminalOutcome ?? openOrder
    const observedOutcome = terminalOutcome(order.status) ?? openOrder
    if (expectedOutcome !== observedOutcome) {
      discrepancies.push(
        discrepancy(
          snapshot.accountId,
          DiscrepancyKind.Order,
          `${intent.clientOrderId}:lifecycle`,
          expectedOutcome,
          observedOutcome,
        ),
      )
    }
  }

  for (const intent of snapshot.intents) {
    if (intent.expectsBrokerOrder && !ordersByClient.has(intent.clientOrderId)) {
      const expectedBrokerOrderId = intent.brokerOrderId
      if (expectedBrokerOrderId === undefined) throw new Error(`intent ${intent.intentId} has no broker order identity`)
      discrepancies.push(
        discrepancy(
          snapshot.accountId,
          DiscrepancyKind.Order,
          `${intent.clientOrderId}:presence`,
          expectedBrokerOrderId,
          absent,
        ),
      )
    }
    if (intent.unknownSince !== undefined) {
      discrepancies.push(
        discrepancy(
          snapshot.accountId,
          DiscrepancyKind.Mutation,
          intent.intentId,
          expectedResolution,
          `UNKNOWN:${intent.unknownSince}`,
        ),
      )
    }
  }
}

const compareFills = (snapshot: ReconciliationSnapshot, discrepancies: DiscrepancyInput[]): void => {
  const observed = indexUnique(snapshot.fills, (fill) => fill.fillId, 'broker fill ID')
  const durable = indexUnique(snapshot.durableFills, (fill) => fill.fillId, 'durable fill ID')
  const filledByOrder = new Map<string, bigint>()
  for (const fill of snapshot.fills) {
    filledByOrder.set(fill.brokerOrderId, (filledByOrder.get(fill.brokerOrderId) ?? 0n) + BigInt(fill.quantityMicros))
    const stored = durable.get(fill.fillId)
    if (stored === undefined) {
      discrepancies.push(discrepancy(snapshot.accountId, DiscrepancyKind.Fill, fill.fillId, 'durable', absent))
      continue
    }
    if (stored.brokerOrderId !== fill.brokerOrderId) {
      discrepancies.push(
        discrepancy(snapshot.accountId, DiscrepancyKind.Fill, fill.fillId, stored.brokerOrderId, fill.brokerOrderId),
      )
    }
    if (!stored.accounted) {
      discrepancies.push(discrepancy(snapshot.accountId, DiscrepancyKind.Accounting, fill.fillId, 'POSTED', 'MISSING'))
    }
  }
  for (const fill of snapshot.durableFills) {
    if (!observed.has(fill.fillId)) {
      discrepancies.push(discrepancy(snapshot.accountId, DiscrepancyKind.Fill, fill.fillId, 'broker', absent))
    }
  }
  for (const order of snapshot.orders) {
    const expected = order.filledQuantityMicros
    const actual = (filledByOrder.get(order.brokerOrderId) ?? 0n).toString()
    if (expected !== actual) {
      discrepancies.push(
        discrepancy(snapshot.accountId, DiscrepancyKind.Fill, `${order.brokerOrderId}:quantity`, expected, actual),
      )
    }
  }
}

const comparePositions = (snapshot: ReconciliationSnapshot, discrepancies: DiscrepancyInput[]): bigint => {
  const observed = indexUnique(snapshot.positions, (position) => position.symbol, 'broker position symbol')
  const projected = indexUnique(snapshot.projectedPositions, (position) => position.symbol, 'projected position symbol')
  let difference = 0n
  for (const symbol of [...new Set([...observed.keys(), ...projected.keys()])].sort()) {
    const expectedPosition = projected.get(symbol)
    const observedPosition = observed.get(symbol)
    const expectedQuantity = expectedPosition?.quantityMicros ?? '0'
    const observedQuantity = observedPosition?.quantityMicros ?? '0'
    difference += absolute(BigInt(expectedQuantity) - BigInt(observedQuantity))
    if (expectedQuantity !== observedQuantity) {
      discrepancies.push(
        discrepancy(
          snapshot.accountId,
          DiscrepancyKind.Position,
          `${symbol}:quantity`,
          expectedQuantity,
          observedQuantity,
        ),
      )
    }
    const expectedCost = expectedPosition?.costBasisMicros ?? '0'
    const observedCost =
      observedPosition === undefined
        ? '0'
        : roundMicrosProduct(
            absolute(BigInt(observedPosition.quantityMicros)),
            BigInt(observedPosition.averageEntryPriceMicros),
          ).toString()
    if (expectedCost !== observedCost) {
      discrepancies.push(
        discrepancy(snapshot.accountId, DiscrepancyKind.Position, `${symbol}:cost`, expectedCost, observedCost),
      )
    }
  }
  return difference
}

export const compareReconciliation = (snapshot: ReconciliationSnapshot): ReconciliationComparison => {
  if (snapshot.account.accountId !== snapshot.accountId || snapshot.valuation.accountId !== snapshot.accountId) {
    throw new Error('reconciliation snapshot contains another account')
  }
  if (snapshot.positions.some((position) => position.accountId !== snapshot.accountId)) {
    throw new Error('reconciliation positions contain another account')
  }
  if (snapshot.orders.some((order) => order.accountId !== snapshot.accountId)) {
    throw new Error('reconciliation orders contain another account')
  }
  if (snapshot.fills.some((fill) => fill.accountId !== snapshot.accountId)) {
    throw new Error('reconciliation fills contain another account')
  }

  const discrepancies: DiscrepancyInput[] = []
  if (snapshot.account.status !== AccountStatus.Active) {
    discrepancies.push(
      discrepancy(
        snapshot.accountId,
        DiscrepancyKind.Account,
        snapshot.accountId,
        AccountStatus.Active,
        snapshot.account.status,
      ),
    )
  }
  compareOrders(snapshot, discrepancies)
  compareFills(snapshot, discrepancies)
  const positionDifference = comparePositions(snapshot, discrepancies)

  const cashDifference = BigInt(snapshot.account.cashMicros) - BigInt(snapshot.expectedCashMicros)
  if (cashDifference !== 0n) {
    discrepancies.push(
      discrepancy(
        snapshot.accountId,
        DiscrepancyKind.Cash,
        snapshot.accountId,
        snapshot.expectedCashMicros,
        snapshot.account.cashMicros,
      ),
    )
  }

  const equityDifference = BigInt(snapshot.account.equityMicros) - BigInt(snapshot.valuation.equityMicros)
  if (equityDifference !== 0n) {
    discrepancies.push(
      discrepancy(
        snapshot.accountId,
        DiscrepancyKind.Valuation,
        snapshot.accountId,
        snapshot.valuation.equityMicros,
        snapshot.account.equityMicros,
      ),
    )
  }
  if (!snapshot.ledgerExact) {
    discrepancies.push(
      discrepancy(
        snapshot.accountId,
        DiscrepancyKind.Accounting,
        `${snapshot.accountId}:ledger`,
        'EXACT',
        `MISMATCH:${snapshot.accountingHash}`,
      ),
    )
  }

  const ordered = [...discrepancies].sort((left, right) =>
    left.discrepancyId < right.discrepancyId ? -1 : left.discrepancyId > right.discrepancyId ? 1 : 0,
  )
  if (new Set(ordered.map((value) => value.discrepancyId)).size !== ordered.length) {
    throw new Error('reconciliation produced duplicate discrepancy identities')
  }
  const observedHash =
    ordered.length === 0
      ? snapshot.stateHash
      : canonicalHashV1({
          schemaVersion: 'bayn.paper-reconciliation-observed.v1',
          stateHash: snapshot.stateHash,
          discrepancies: ordered.map((value) => value.evidenceHash),
        })

  const reconciledAt = instant(snapshot.reconciledAt)
  const brokerTimes = [
    snapshot.account.observedAt,
    snapshot.valuation.asOf,
    ...snapshot.positions.map((position) => position.observedAt),
    ...snapshot.orders.map((order) => order.observedAt),
  ].map(instant)
  const oldestBrokerTime = brokerTimes.length === 0 ? reconciledAt : Math.min(...brokerTimes)
  const unknownTimes = snapshot.intents.flatMap((intent) =>
    intent.unknownSince === undefined ? [] : [instant(intent.unknownSince)],
  )

  return {
    expectedHash: snapshot.stateHash,
    observedHash,
    discrepancies: ordered,
    metrics: {
      brokerPollAgeMs: Math.max(0, reconciledAt - oldestBrokerTime),
      oldestUnknownMutationAgeMs: unknownTimes.length === 0 ? 0 : Math.max(0, reconciledAt - Math.min(...unknownTimes)),
      cashDifferenceMicros: cashDifference.toString(),
      positionDifferenceMicros: positionDifference.toString(),
      equityDifferenceMicros: equityDifference.toString(),
      accountingExact: snapshot.ledgerExact,
      discrepancyCount: ordered.length,
    },
  }
}
