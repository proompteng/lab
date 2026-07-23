import type { IntentPlan } from './execution/intents'
import { desiredQuantityMicros, MICROS } from './execution-model'
import { canonicalHashV1 } from './hash'
import {
  AccountStatus,
  OrderSide,
  OrderStatus,
  OrderType,
  ReconciliationStatus,
  TimeInForce,
  type Reconciliation,
} from './paper'
import type { ExecutionModel } from './protocol'
import { reconciledStateHash, type ReconciledStateMaterial } from './reconciliation'
import type { IsoDate } from './schemas'
import type { SignalDecision } from './types'

const WEIGHT_SUM_TOLERANCE = 1e-12

export interface SignalSessionReferencePrices {
  readonly schemaVersion: 'bayn.signal-session-reference-prices.v1'
  readonly signalDate: IsoDate
  readonly observedAt: string
  readonly contentHash: string
  readonly priceMicros: Readonly<Record<string, string>>
}

export interface TargetPlannerBrokerState extends ReconciledStateMaterial {
  readonly reconciliation: Reconciliation
  readonly unknownOrderCount: number
}

export interface TargetPlannerInput {
  readonly schemaVersion: 'bayn.paper-target-planner-input.v1'
  readonly strategyName: IntentPlan['strategyName']
  readonly cycleId: IntentPlan['cycleId']
  readonly decisionHash: IntentPlan['decisionHash']
  readonly policyHash: IntentPlan['policyHash']
  readonly accountId: IntentPlan['accountId']
  readonly signalDate: IsoDate
  readonly targetWeights: SignalDecision['targetWeights']
  readonly referencePrices: SignalSessionReferencePrices
  readonly brokerState: TargetPlannerBrokerState
  readonly precision: ExecutionModel['precision']
  readonly maximumInputAgeMs: number
  readonly submissionCutoffAt: string
  readonly observedAt: string
}

export interface PlannedTargetQuantity {
  readonly symbol: string
  readonly targetWeight: number
  readonly referencePriceMicros: string
  readonly currentQuantityMicros: string
  readonly targetQuantityMicros: string
}

export type ReferenceTargetIntent = Omit<IntentPlan, 'schemaVersion' | 'notionalLimitMicros'>

export enum TargetPlanStatus {
  Planned = 'PLANNED',
  NoTrade = 'NO_TRADE',
  Blocked = 'BLOCKED',
}

export enum TargetPlanReason {
  AccountNotActive = 'ACCOUNT_NOT_ACTIVE',
  BelowMinimumBuyNotional = 'BELOW_MINIMUM_BUY_NOTIONAL',
  IdentityMismatch = 'IDENTITY_MISMATCH',
  InputMismatch = 'INPUT_MISMATCH',
  InputStale = 'INPUT_STALE',
  InsufficientBuyingPower = 'INSUFFICIENT_BUYING_POWER',
  NonPositiveEquity = 'NON_POSITIVE_EQUITY',
  ReconciliationNotExact = 'RECONCILIATION_NOT_EXACT',
  ShortPositionNotAllowed = 'SHORT_POSITION_NOT_ALLOWED',
  SubmissionCutoffReached = 'SUBMISSION_CUTOFF_REACHED',
  TargetsSatisfied = 'TARGETS_SATISFIED',
  UnknownOrder = 'UNKNOWN_ORDER',
  UnresolvedOrder = 'UNRESOLVED_ORDER',
}

export interface TargetPlanResult {
  readonly schemaVersion: 'bayn.paper-reference-target-plan.v1'
  readonly inputHash: string
  readonly outputHash: string
  readonly status: TargetPlanStatus
  readonly reason: TargetPlanReason | null
  readonly targets: readonly PlannedTargetQuantity[]
  readonly intentTargets: readonly ReferenceTargetIntent[]
  readonly requiredReferenceBuyNotionalMicros: string
  readonly availableBuyingPowerMicros: string
  readonly residualBuyingPowerMicros: string
}

type OutputMaterial = Omit<TargetPlanResult, 'outputHash'>

const compareText = (left: string, right: string): number => (left < right ? -1 : left > right ? 1 : 0)

const finish = (material: OutputMaterial): TargetPlanResult => ({
  ...material,
  outputHash: canonicalHashV1(material),
})

const blocked = (
  inputHash: string,
  reason: Exclude<TargetPlanReason, TargetPlanReason.TargetsSatisfied>,
  availableBuyingPowerMicros: string,
  targets: readonly PlannedTargetQuantity[] = [],
  requiredReferenceBuyNotionalMicros = '0',
): TargetPlanResult =>
  finish({
    schemaVersion: 'bayn.paper-reference-target-plan.v1',
    inputHash,
    status: TargetPlanStatus.Blocked,
    reason,
    targets,
    intentTargets: [],
    requiredReferenceBuyNotionalMicros,
    availableBuyingPowerMicros,
    residualBuyingPowerMicros: availableBuyingPowerMicros,
  })

const sameStrings = (left: readonly string[], right: readonly string[]): boolean =>
  left.length === right.length && left.every((value, index) => value === right[index])

const isUnresolved = (status: OrderStatus): boolean =>
  status === OrderStatus.New || status === OrderStatus.PartiallyFilled || status === OrderStatus.Pending

const referencePriceHash = (referencePrices: SignalSessionReferencePrices): string =>
  canonicalHashV1({
    schemaVersion: referencePrices.schemaVersion,
    signalDate: referencePrices.signalDate,
    observedAt: referencePrices.observedAt,
    priceMicros: referencePrices.priceMicros,
  })

const identityAndSessionMatch = (input: TargetPlannerInput): boolean => {
  const targetSymbols = Object.keys(input.targetWeights).sort(compareText)
  const priceSymbols = Object.keys(input.referencePrices.priceMicros).sort(compareText)
  const accountId = input.accountId
  return (
    targetSymbols.length > 0 &&
    sameStrings(targetSymbols, priceSymbols) &&
    input.referencePrices.signalDate === input.signalDate &&
    input.signalDate <= input.referencePrices.observedAt.slice(0, 10) &&
    input.brokerState.account.accountId === accountId &&
    input.brokerState.reconciliation.accountId === accountId &&
    input.brokerState.positions.every(
      (position) => position.accountId === accountId && targetSymbols.includes(position.symbol),
    ) &&
    input.brokerState.orders.every((order) => order.accountId === accountId)
  )
}

const brokerStateIsCurrent = (input: TargetPlannerInput): boolean => {
  const state = input.brokerState
  const reconciliation = state.reconciliation
  const stateHash = reconciledStateHash(state)
  return (
    reconciliation.status === ReconciliationStatus.Exact &&
    reconciliation.discrepancies.length === 0 &&
    reconciliation.expectedHash === stateHash &&
    reconciliation.observedHash === stateHash &&
    reconciliation.reconciledAt >= state.account.observedAt &&
    reconciliation.reconciledAt >= state.positionsObservedAt &&
    reconciliation.reconciledAt >= state.ordersObservedAt
  )
}

const sourceTimes = (input: TargetPlannerInput): readonly number[] =>
  [
    input.referencePrices.observedAt,
    input.brokerState.account.observedAt,
    input.brokerState.positionsObservedAt,
    input.brokerState.ordersObservedAt,
    input.brokerState.reconciliation.reconciledAt,
    ...input.brokerState.orders.map((order) => order.observedAt),
  ].map((value) => Date.parse(value))

const referenceInputsMatch = (input: TargetPlannerInput): boolean => {
  const priceIncrement = BigInt(input.precision.priceIncrementMicros)
  const quantityIncrement = BigInt(input.precision.quantityIncrementMicros)
  const totalWeight = Object.values(input.targetWeights).reduce((total, weight) => total + weight, 0)
  return (
    input.referencePrices.contentHash === referencePriceHash(input.referencePrices) &&
    totalWeight <= 1 + WEIGHT_SUM_TOLERANCE &&
    Object.values(input.referencePrices.priceMicros).every(
      (price) => BigInt(price) > 0n && BigInt(price) % priceIncrement === 0n,
    ) &&
    input.brokerState.positions.every((position) => BigInt(position.quantityMicros) % quantityIncrement === 0n)
  )
}

const referenceNotional = (quantityMicros: bigint, priceMicros: bigint): bigint =>
  (quantityMicros * priceMicros + MICROS - 1n) / MICROS

export const planTargets = (input: TargetPlannerInput): TargetPlanResult => {
  const inputHash = canonicalHashV1(input)
  const availableBuyingPowerMicros = input.brokerState.account.buyingPowerMicros
  const observedAt = Date.parse(input.observedAt)
  if (observedAt >= Date.parse(input.submissionCutoffAt)) {
    return blocked(inputHash, TargetPlanReason.SubmissionCutoffReached, availableBuyingPowerMicros)
  }
  if (!identityAndSessionMatch(input)) {
    return blocked(inputHash, TargetPlanReason.IdentityMismatch, availableBuyingPowerMicros)
  }
  if (!referenceInputsMatch(input)) {
    return blocked(inputHash, TargetPlanReason.InputMismatch, availableBuyingPowerMicros)
  }

  const observations = sourceTimes(input)
  if (observations.some((source) => source > observedAt)) {
    return blocked(inputHash, TargetPlanReason.InputMismatch, availableBuyingPowerMicros)
  }
  if (observations.some((source) => observedAt - source >= input.maximumInputAgeMs)) {
    return blocked(inputHash, TargetPlanReason.InputStale, availableBuyingPowerMicros)
  }
  if (!brokerStateIsCurrent(input)) {
    return blocked(inputHash, TargetPlanReason.ReconciliationNotExact, availableBuyingPowerMicros)
  }
  if (input.brokerState.account.status !== AccountStatus.Active) {
    return blocked(inputHash, TargetPlanReason.AccountNotActive, availableBuyingPowerMicros)
  }
  if (input.brokerState.unknownOrderCount > 0) {
    return blocked(inputHash, TargetPlanReason.UnknownOrder, availableBuyingPowerMicros)
  }
  if (input.brokerState.orders.some((order) => isUnresolved(order.status))) {
    return blocked(inputHash, TargetPlanReason.UnresolvedOrder, availableBuyingPowerMicros)
  }
  if (input.brokerState.positions.some((position) => BigInt(position.quantityMicros) < 0n)) {
    return blocked(inputHash, TargetPlanReason.ShortPositionNotAllowed, availableBuyingPowerMicros)
  }

  const equityMicros = BigInt(input.brokerState.account.equityMicros)
  if (equityMicros <= 0n) {
    return blocked(inputHash, TargetPlanReason.NonPositiveEquity, availableBuyingPowerMicros)
  }

  const minimumBuyNotionalMicros = BigInt(input.precision.minimumBuyNotionalMicros)
  const positions = new Map(
    input.brokerState.positions.map((position) => [position.symbol, BigInt(position.quantityMicros)]),
  )
  const targets = Object.keys(input.targetWeights)
    .sort(compareText)
    .map((symbol): PlannedTargetQuantity => {
      const referencePriceMicros = BigInt(input.referencePrices.priceMicros[symbol])
      return {
        symbol,
        targetWeight: input.targetWeights[symbol],
        referencePriceMicros: referencePriceMicros.toString(),
        currentQuantityMicros: (positions.get(symbol) ?? 0n).toString(),
        targetQuantityMicros: desiredQuantityMicros(equityMicros, input.targetWeights[symbol], referencePriceMicros, {
          precision: input.precision,
        }).toString(),
      }
    })

  const intents = targets
    .flatMap((target): readonly ReferenceTargetIntent[] => {
      const delta = BigInt(target.targetQuantityMicros) - BigInt(target.currentQuantityMicros)
      if (delta === 0n) return []
      return [
        {
          strategyName: input.strategyName,
          cycleId: input.cycleId,
          decisionHash: input.decisionHash,
          policyHash: input.policyHash,
          accountId: input.accountId,
          symbol: target.symbol,
          side: delta > 0n ? OrderSide.Buy : OrderSide.Sell,
          orderType: OrderType.Market,
          timeInForce: TimeInForce.Day,
          quantityMicros: (delta < 0n ? -delta : delta).toString(),
          createdAt: input.observedAt,
        },
      ]
    })
    .sort((left, right) => {
      if (left.side !== right.side) return left.side === OrderSide.Sell ? -1 : 1
      return compareText(left.symbol, right.symbol)
    })

  const requiredReferenceBuyNotional = intents
    .filter((intent) => intent.side === OrderSide.Buy)
    .map((intent) =>
      referenceNotional(BigInt(intent.quantityMicros), BigInt(input.referencePrices.priceMicros[intent.symbol])),
    )
  if (requiredReferenceBuyNotional.some((notional) => notional < minimumBuyNotionalMicros)) {
    return blocked(inputHash, TargetPlanReason.BelowMinimumBuyNotional, availableBuyingPowerMicros, targets)
  }

  const requiredBuyingPower = requiredReferenceBuyNotional.reduce((total, value) => total + value, 0n)
  const availableBuyingPower = BigInt(availableBuyingPowerMicros)
  if (requiredBuyingPower > 0n && requiredBuyingPower > availableBuyingPower) {
    return blocked(
      inputHash,
      TargetPlanReason.InsufficientBuyingPower,
      availableBuyingPowerMicros,
      targets,
      requiredBuyingPower.toString(),
    )
  }

  return finish({
    schemaVersion: 'bayn.paper-reference-target-plan.v1',
    inputHash,
    status: intents.length === 0 ? TargetPlanStatus.NoTrade : TargetPlanStatus.Planned,
    reason: intents.length === 0 ? TargetPlanReason.TargetsSatisfied : null,
    targets,
    intentTargets: intents,
    requiredReferenceBuyNotionalMicros: requiredBuyingPower.toString(),
    availableBuyingPowerMicros,
    residualBuyingPowerMicros: (availableBuyingPower - requiredBuyingPower).toString(),
  })
}
