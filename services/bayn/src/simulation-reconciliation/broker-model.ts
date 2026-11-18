import { HashMap, Result, pipe } from 'effect'
import { types } from 'node:util'

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

export interface IntentExpectation {
  readonly intentId: string
  readonly clientOrderId: string
  readonly symbol: string
  readonly side: Order['side']
  readonly orderType: Order['orderType']
  readonly submittedOrderType: Order['orderType']
  readonly submittedQuantityAtoms?: string
  readonly submittedNotionalMicros?: string
  readonly submittedLimitPriceMicros?: string
  readonly submittedStopPriceMicros?: string
  readonly parentBrokerOrderId?: string
  readonly timeInForce: Order['timeInForce']
  readonly quantityAtoms: string
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
  readonly quantityAtoms: string
  readonly costBasisMicros: string
  readonly costBasisAnchor: { readonly priceAtomsNumerator: string; readonly priceAtomsDenominator: string } | null
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
  | 'position-cost-basis'
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

export interface ReconciliationCanonicalHashInput {
  readonly operation: ReconciliationHashOperation
  readonly value: unknown
  readonly identity?: string
}

export const canonicalHash = (input: ReconciliationCanonicalHashInput): ReconciliationDecision<string> =>
  Result.mapError(
    canonicalHashV1Result(input.value),
    (cause): ReconciliationDecisionError => ({
      _tag: 'CanonicalizationFailed',
      operation: input.operation,
      ...(input.identity === undefined ? {} : { identity: input.identity }),
      cause,
    }),
  )

export const absolute = (value: bigint): bigint => (value < 0n ? -value : value)
const canonicalIntegerPattern = /^(?:0|-?[1-9][0-9]*)$/

export const integer = (
  source: ReconciliationIntegerSource,
  identity: string,
  value: string,
): ReconciliationDecision<bigint> =>
  canonicalIntegerPattern.test(value)
    ? Result.succeed(BigInt(value))
    : fail({ _tag: 'InvalidInteger', source, identity, value })

const evidenceState = (state: ReconciledStateMaterial): ReconciledStateMaterial => ({
  account: state.account,
  positions: state.positions,
  positionsObservedAt: state.positionsObservedAt,
  orders: state.orders,
  ordersObservedAt: state.ordersObservedAt,
  accountingHash: state.accountingHash,
})

// The right side is our private, already canonicalized data. Inspect the left
// without invoking getters/proxy traps, sorting keys, or allocating JSON strings.
const equalVerifiedData = (value: unknown, expected: unknown): boolean => {
  if (value === expected) return true
  if (value === null || expected === null || typeof value !== 'object' || typeof expected !== 'object') return false
  if (types.isProxy(value)) return false
  const array = Array.isArray(expected)
  if (Array.isArray(value) !== array) return false
  const prototype = Object.getPrototypeOf(value)
  if (!array && prototype !== Object.prototype && prototype !== null) return false
  const keys = Reflect.ownKeys(value)
  const expectedKeys = Object.keys(expected)
  if (keys.length !== expectedKeys.length + (array ? 1 : 0)) return false
  for (const key of expectedKeys) {
    const property = Object.getOwnPropertyDescriptor(value, key)
    if (property === undefined || property.enumerable !== true || !('value' in property)) return false
    if (!equalVerifiedData(property.value, (expected as Record<string, unknown>)[key])) return false
  }
  return !array || (value as unknown[]).length === (expected as unknown[]).length
}

const matchingEvidenceState = (state: ReconciledStateMaterial, expected: ReconciledStateMaterial): boolean => {
  if (types.isProxy(state)) return false
  for (const key of Object.keys(expected)) {
    const property = Object.getOwnPropertyDescriptor(state, key)
    if (property === undefined || property.enumerable !== true || !('value' in property)) return false
    if (!equalVerifiedData(property.value, (expected as unknown as Record<string, unknown>)[key])) return false
  }
  return true
}

export interface ReconciledStateEvidence {
  readonly kind: 'invocation-owned-reconciled-state'
}

const verifiedEvidence = new WeakMap<
  ReconciledStateEvidence,
  {
    readonly state: ReconciledStateMaterial
    readonly hash: string
    materialHash?: string
  }
>()

// This receipt never carries authority. Consumers must still decode their own
// inputs and prove complete decoded-data equality, including accounting identity.
export const makeReconciledStateEvidence = (
  state: ReconciledStateMaterial,
): ReconciliationDecision<ReconciledStateEvidence> => {
  const owned = structuredClone(evidenceState(state))
  const freeze = (value: unknown): void => {
    if (value === null || typeof value !== 'object' || Object.isFrozen(value)) return
    for (const child of Object.values(value)) freeze(child)
    Object.freeze(value)
  }
  freeze(owned)
  return Result.map(reconciledStateHash(owned), (hash) => {
    const receipt: ReconciledStateEvidence = Object.freeze({ kind: 'invocation-owned-reconciled-state' })
    verifiedEvidence.set(receipt, { state: owned, hash })
    return receipt
  })
}

export const brokerMaterialHashFromDecoded = (
  state: ReconciledStateMaterial,
  evidence?: ReconciledStateEvidence,
): Result.Result<string, CanonicalHashFailure> => {
  const verified = evidence === undefined ? undefined : verifiedEvidence.get(evidence)
  if (verified !== undefined && matchingEvidenceState(state, verified.state)) {
    if (verified.materialHash !== undefined) return Result.succeed(verified.materialHash)
    return Result.map(canonicalHashV1Result(verified.state), (hash) => {
      verified.materialHash = hash
      return hash
    })
  }
  return canonicalHashV1Result(evidenceState(state))
}

// Only call after the full domain decoder. Unknown objects must use reconciledStateHash.
export const reconciledStateHashFromDecoded = (
  state: ReconciledStateMaterial,
  evidence?: ReconciledStateEvidence,
): ReconciliationDecision<string> => {
  const verified = evidence === undefined ? undefined : verifiedEvidence.get(evidence)
  if (verified !== undefined && matchingEvidenceState(state, verified.state)) {
    return Result.succeed(verified.hash)
  }
  return reconciledStateHash(state)
}

export const reconciledStateHash = (state: ReconciledStateMaterial): ReconciliationDecision<string> =>
  pipe(
    canonicalHash({
      operation: 'broker-state-hash',
      value: {
        schemaVersion: 'bayn.paper-risk-broker-state.v1',
        account: state.account,
        positions: state.positions,
        positionsObservedAt: state.positionsObservedAt,
        orders: state.orders,
        ordersObservedAt: state.ordersObservedAt,
      },
    }),
    Result.flatMap((brokerStateHash) =>
      canonicalHash({
        operation: 'reconciled-state-hash',
        value: {
          schemaVersion: 'bayn.paper-risk-reconciled-state.v1',
          brokerStateHash,
          accountingHash: state.accountingHash,
        },
      }),
    ),
  )

export const instant = (
  field: ReconciliationInstantField,
  identity: string,
  value: string,
): ReconciliationDecision<number> => {
  const milliseconds = Date.parse(value)
  return Number.isFinite(milliseconds)
    ? Result.succeed(milliseconds)
    : fail({ _tag: 'InvalidInstant', field, identity, value })
}

export const indexUnique = <A>(
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
        canonicalHash({
          operation: 'discrepancy-id',
          value: { schemaVersion: 'bayn.paper-discrepancy-id.v1', accountId, kind, identity },
          identity,
        }),
        Result.flatMap((discrepancyId) =>
          pipe(
            canonicalHash({
              operation: 'discrepancy-evidence',
              value: { schemaVersion: 'bayn.paper-discrepancy-evidence.v1', discrepancyId, expected, observed },
              identity,
            }),
            Result.map((evidenceHash) => ({ discrepancyId, kind, identity, expected, observed, evidenceHash })),
          ),
        ),
      )

export const compareValue = (
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

export const renderReconciliationDecisionError = (error: ReconciliationDecisionError): string => {
  switch (error._tag) {
    case 'CanonicalizationFailed':
      return `reconciliation ${error.operation} canonicalization failed${error.identity === undefined ? '' : ` for ${error.identity}`}`
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
