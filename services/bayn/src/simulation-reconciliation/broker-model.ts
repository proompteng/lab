import { HashMap, Result, pipe } from 'effect'

import {
  DiscrepancyKind,
  IntentState,
  type AccountSnapshot,
  type AuthorityState,
  type Fill,
  type Order,
  type Position,
  type Reconciliation,
  type TerminalOutcome,
  type Valuation,
} from '../execution/contracts'
import { canonicalHashV1Result, type CanonicalHashFailure } from '../hash'
import type { IsoDate } from '../schemas'
import { roundUnsignedHalfUp } from '../unsigned-round-half-up'
import { Pipeable } from '../pipeable'

export interface IntentExpectation {
  readonly intentId: string
  readonly clientOrderId: string
  readonly symbol: string
  readonly side: Order['side']
  readonly orderType: Order['orderType']
  readonly submittedOrderType: Order['orderType']
  readonly submittedLimitPriceMicros?: string
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
    | { readonly authority: AuthorityState; readonly authorityObservedAt: string }
    | { readonly authority: null; readonly authorityObservedAt: null }
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

export const absent = '<absent>'
export const expectedResolution = '<resolved>'
export const openOrder = '<open>'

export type ReconciliationIdentityCollection =
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

export type ReconciliationInstantField =
  | 'account.observedAt'
  | 'intent.unknownSince'
  | 'order.observedAt'
  | 'position.observedAt'
  | 'reconciledAt'
  | 'valuation.asOf'

export type ReconciliationAccountSource = 'account' | 'fill' | 'order' | 'position' | 'valuation'

export type ReconciliationIntegerSource =
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
      readonly cause: CanonicalHashFailure
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
  | { readonly _tag: 'BrokerOrderIdentityMissing'; readonly intentId: string; readonly clientOrderId: string }
  | {
      readonly _tag: 'AccountBindingMismatch'
      readonly source: ReconciliationAccountSource
      readonly identity: string
      readonly expectedAccountId: string
      readonly observedAccountId: string
    }

export type ReconciliationDecision<A> = Result.Result<A, ReconciliationDecisionError>
export const fail = <A>(error: ReconciliationDecisionError): ReconciliationDecision<A> => Result.fail(error)

export const canonicalHash = (
  operation: ReconciliationHashOperation,
  value: unknown,
  identity?: string,
): ReconciliationDecision<string> =>
  Result.mapError(
    canonicalHashV1Result(value),
    (cause): ReconciliationDecisionError => ({
      _tag: 'CanonicalizationFailed',
      operation,
      ...(identity === undefined ? {} : { identity }),
      cause,
    }),
  )

export const absolute = (value: bigint): bigint => (value < 0n ? -value : value)
const canonicalIntegerPattern = /^(?:0|-?[1-9][0-9]*)$/

const integerDataFirst = (
  source: ReconciliationIntegerSource,
  identity: string,
  value: string,
): ReconciliationDecision<bigint> =>
  canonicalIntegerPattern.test(value)
    ? Result.succeed(BigInt(value))
    : fail({ _tag: 'InvalidInteger', source, identity, value })

export const integer = Pipeable.dual(3, integerDataFirst)

const roundMicrosProductDataFirst = (
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

export const roundMicrosProduct = Pipeable.dual(3, roundMicrosProductDataFirst)

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

const instantDataFirst = (
  field: ReconciliationInstantField,
  identity: string,
  value: string,
): ReconciliationDecision<number> => {
  const milliseconds = Date.parse(value)
  return Number.isFinite(milliseconds)
    ? Result.succeed(milliseconds)
    : fail({ _tag: 'InvalidInstant', field, identity, value })
}

export const instant = Pipeable.dual(3, instantDataFirst)

const indexUniqueDataFirst = <A>(
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

export const indexUnique = Pipeable.generic<
  <A>(
    identity: (value: A) => string,
    collection: ReconciliationIdentityCollection,
  ) => (values: readonly A[]) => ReconciliationDecision<HashMap.HashMap<string, A>>,
  typeof indexUniqueDataFirst
>(3, indexUniqueDataFirst)

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
          { schemaVersion: 'bayn.paper-discrepancy-id.v1', accountId, kind, identity },
          identity,
        ),
        Result.flatMap((discrepancyId) =>
          pipe(
            canonicalHash(
              'discrepancy-evidence',
              { schemaVersion: 'bayn.paper-discrepancy-evidence.v1', discrepancyId, expected, observed },
              identity,
            ),
            Result.map((evidenceHash) => ({ discrepancyId, kind, identity, expected, observed, evidenceHash })),
          ),
        ),
      )

const compareValueDataFirst = (
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

export const compareValue = Pipeable.dual(5, compareValueDataFirst)

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
