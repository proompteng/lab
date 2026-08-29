import { Result, pipe } from 'effect'

import { AccountStatus, OrderStatus, ReconciliationStatus } from '../execution/contracts'
import { legacyTargetPlannerInputV1SchemaVersion } from '../execution/legacy-wire'
import { desiredQuantityMicros } from '../execution-model'
import { canonicalHashV1Result } from '../hash'
import { reconciledStateHash } from '../reconciliation'
import {
  TargetPlanReason,
  canonicalizePlannerInputFailure,
  deriveTargetsFailure,
  quoteBoundTargetPlannerInputSchemaVersion,
  type BlockedTargetPlanReason,
  type PlannedTargetQuantity,
  type TargetPlannerFailure,
  type TargetPlannerInput,
} from './model'
import { Pipeable } from '../pipeable'

const WEIGHT_SUM_TOLERANCE = 1e-12

const compareTextDataFirst = (left: string, right: string): number => (left < right ? -1 : left > right ? 1 : 0)

export const compareText = Pipeable.dual(2, compareTextDataFirst)

const isStrictlySorted = (values: readonly string[]): boolean =>
  values.every((value, index) => {
    if (index === 0) return true
    const previous = values[index - 1]
    return previous !== undefined && previous < value
  })

const sameStrings = (left: readonly string[], right: readonly string[]): boolean =>
  left.length === right.length && left.every((value, index) => value === right[index])

const isUnresolved = (status: OrderStatus): boolean =>
  status === OrderStatus.New || status === OrderStatus.PartiallyFilled || status === OrderStatus.Pending

const referencePriceMaterial = (referencePrices: TargetPlannerInput['referencePrices']) => {
  const { contentHash: _contentHash, ...material } = referencePrices
  return material
}

export interface TargetPlannerHashes {
  readonly inputHash: string
  readonly referencePriceHash: string
  readonly reconciledBrokerStateHash: string
}

export interface TargetPlannerFacts {
  readonly input: TargetPlannerInput
  readonly inputHash: string
  readonly referencePriceHash: string
  readonly reconciledBrokerStateHash: string
  readonly targetSymbols: readonly string[]
  readonly priceSymbols: readonly string[]
  readonly prices: ReadonlyMap<string, bigint>
  readonly bidPrices: ReadonlyMap<string, bigint>
  readonly askPrices: ReadonlyMap<string, bigint>
  readonly maximumBuyQuantities: ReadonlyMap<string, bigint>
  readonly positions: ReadonlyMap<string, bigint>
  readonly positionQuantities: readonly bigint[]
  readonly positionMarketValues: readonly bigint[]
  readonly observedAt: number
  readonly submissionCutoffAt: number
  readonly sourceTimes: readonly number[]
  readonly priceIncrement: bigint
  readonly quantityIncrement: bigint
  readonly minimumBuyNotional: bigint
  readonly equity: bigint
  readonly allocationCapital: bigint
  readonly availableBuyingPower: bigint
}

export interface PlannedTargetFact {
  readonly target: PlannedTargetQuantity
  readonly referencePrice: bigint
  readonly delta: bigint
}

const plannerInputHash = (
  input: TargetPlannerInput,
  operation: 'input' | 'reference-price',
  value: unknown,
): Result.Result<string, TargetPlannerFailure> =>
  pipe(
    canonicalHashV1Result(value),
    Result.mapError((cause) =>
      canonicalizePlannerInputFailure({
        reason: 'hash',
        message: `validated target-planner ${operation} evidence is not canonicalizable`,
        facts: { cycleId: input.cycleId },
        cause,
      }),
    ),
  )

export const deriveTargetPlannerHashes = (
  input: TargetPlannerInput,
): Result.Result<TargetPlannerHashes, TargetPlannerFailure> =>
  Result.all({
    inputHash: plannerInputHash(input, 'input', input),
    referencePriceHash: plannerInputHash(input, 'reference-price', referencePriceMaterial(input.referencePrices)),
    reconciledBrokerStateHash: pipe(
      reconciledStateHash(input.brokerState),
      Result.mapError((cause) =>
        canonicalizePlannerInputFailure({
          reason: 'hash',
          message: 'validated target-planner reconciled broker state is not canonicalizable',
          facts: { cycleId: input.cycleId },
          cause,
        }),
      ),
    ),
  })

const parseTargetPlannerFactsDataFirst = (
  input: TargetPlannerInput,
  hashes: TargetPlannerHashes,
): TargetPlannerFacts => {
  const targetSymbols = Object.keys(input.targetWeights).sort(compareText)
  const priceSymbols = Object.keys(input.referencePrices.priceMicros).sort(compareText)
  const prices = new Map(
    Object.entries(input.referencePrices.priceMicros).map(([symbol, price]) => [symbol, BigInt(price)]),
  )
  const bidPrices = new Map(
    input.schemaVersion === quoteBoundTargetPlannerInputSchemaVersion
      ? Object.entries(input.referencePrices.bidPriceMicros).map(([symbol, price]) => [symbol, BigInt(price)] as const)
      : [],
  )
  const askPrices = new Map(
    input.schemaVersion === quoteBoundTargetPlannerInputSchemaVersion
      ? Object.entries(input.referencePrices.askPriceMicros).map(([symbol, price]) => [symbol, BigInt(price)] as const)
      : [],
  )
  const maximumBuyQuantities = new Map(
    input.schemaVersion === quoteBoundTargetPlannerInputSchemaVersion
      ? Object.entries(input.executionTerms.maximumBuyQuantityMicros).map(
          ([symbol, quantity]) => [symbol, BigInt(quantity)] as const,
        )
      : [],
  )
  const positionQuantities = input.brokerState.positions.map((position) => BigInt(position.quantityMicros))
  const positionMarketValues = input.brokerState.positions.map((position) => BigInt(position.marketValueMicros))
  const positions = new Map(
    input.brokerState.positions.map((position) => [position.symbol, BigInt(position.quantityMicros)] as const),
  )
  const equity = BigInt(input.brokerState.account.equityMicros)
  return {
    input,
    ...hashes,
    targetSymbols,
    priceSymbols,
    prices,
    bidPrices,
    askPrices,
    maximumBuyQuantities,
    positions,
    positionQuantities,
    positionMarketValues,
    observedAt: Date.parse(input.observedAt),
    submissionCutoffAt: Date.parse(input.submissionCutoffAt),
    sourceTimes: [
      input.referencePrices.observedAt,
      input.brokerState.account.observedAt,
      input.brokerState.positionsObservedAt,
      input.brokerState.ordersObservedAt,
      input.brokerState.reconciliation.reconciledAt,
      ...input.brokerState.positions.map((position) => position.observedAt),
      ...input.brokerState.orders.map((order) => order.observedAt),
    ].map(Date.parse),
    priceIncrement: BigInt(input.precision.priceIncrementMicros),
    quantityIncrement: BigInt(input.precision.quantityIncrementMicros),
    minimumBuyNotional: BigInt(input.precision.minimumBuyNotionalMicros),
    equity,
    allocationCapital:
      input.schemaVersion === legacyTargetPlannerInputV1SchemaVersion ? equity : BigInt(input.allocationCapitalMicros),
    availableBuyingPower: BigInt(input.brokerState.account.buyingPowerMicros),
  }
}

export const parseTargetPlannerFacts = Pipeable.dual(2, parseTargetPlannerFactsDataFirst)

const identityAndSessionMatch = (facts: TargetPlannerFacts): boolean => {
  const { input, priceSymbols, targetSymbols } = facts
  const accountId = input.accountId
  const partialClose =
    input.schemaVersion === quoteBoundTargetPlannerInputSchemaVersion &&
    input.executionTerms.executionPurpose !== undefined
  return (
    targetSymbols.length > 0 &&
    sameStrings(targetSymbols, priceSymbols) &&
    input.referencePrices.signalDate === input.signalDate &&
    input.signalDate <= input.referencePrices.observedAt.slice(0, 10) &&
    input.brokerState.account.accountId === accountId &&
    input.brokerState.reconciliation.accountId === accountId &&
    input.brokerState.positions.every(
      (position) => position.accountId === accountId && (partialClose || targetSymbols.includes(position.symbol)),
    ) &&
    input.brokerState.orders.every((order) => order.accountId === accountId)
  )
}

const brokerStateIsCoherent = (facts: TargetPlannerFacts): boolean => {
  const {
    input,
    positionMarketValues,
    positionQuantities,
    priceIncrement,
    prices,
    bidPrices,
    askPrices,
    quantityIncrement,
  } = facts
  const state = input.brokerState
  const positionSymbols = state.positions.map((position) => position.symbol)
  const brokerOrderIds = state.orders.map((order) => order.brokerOrderId)
  const clientOrderIds = state.orders.map((order) => order.clientOrderId)
  const latestOrderObservation = state.orders.reduce(
    (latest, order) => (order.observedAt > latest ? order.observedAt : latest),
    '',
  )
  const unknownOrderCount = state.orders.filter((order) => order.intentId === undefined).length
  return (
    new Set(positionSymbols).size === positionSymbols.length &&
    isStrictlySorted(positionSymbols) &&
    state.positions.every((position) => position.observedAt === state.positionsObservedAt) &&
    positionQuantities.every((quantity, index) => {
      const marketValue = positionMarketValues[index]
      return (
        marketValue !== undefined &&
        (quantity === 0n) === (marketValue === 0n) &&
        (quantity <= 0n || marketValue > 0n) &&
        (quantity >= 0n || marketValue < 0n)
      )
    }) &&
    new Set(brokerOrderIds).size === brokerOrderIds.length &&
    isStrictlySorted(brokerOrderIds) &&
    new Set(clientOrderIds).size === clientOrderIds.length &&
    state.orders.every((order) => order.observedAt <= state.ordersObservedAt) &&
    (state.orders.length === 0 || latestOrderObservation === state.ordersObservedAt) &&
    state.unknownOrderCount === unknownOrderCount &&
    facts.allocationCapital <= facts.equity &&
    input.referencePrices.contentHash === facts.referencePriceHash &&
    Object.values(input.targetWeights).reduce((total, weight) => total + weight, 0) <= 1 + WEIGHT_SUM_TOLERANCE &&
    [...prices.values(), ...bidPrices.values(), ...askPrices.values()].every(
      (price) => price % priceIncrement === 0n,
    ) &&
    positionQuantities.every((quantity) => quantity % quantityIncrement === 0n)
  )
}

const brokerStateIsCurrent = (facts: TargetPlannerFacts): boolean => {
  const { input } = facts
  const state = input.brokerState
  const reconciliation = state.reconciliation
  const stateHash = facts.reconciledBrokerStateHash
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

const referenceNotionalDataFirst = (quantityMicros: bigint, priceMicros: bigint): bigint =>
  (quantityMicros * priceMicros + 1_000_000n - 1n) / 1_000_000n

export const referenceNotional = Pipeable.dual(2, referenceNotionalDataFirst)

export const derivePlannedTargetFacts = (
  facts: TargetPlannerFacts,
): Result.Result<ReadonlyArray<PlannedTargetFact>, TargetPlannerFailure> =>
  [...facts.prices.entries()]
    .sort(([left], [right]) => compareText(left, right))
    .reduce<Result.Result<ReadonlyArray<PlannedTargetFact>, TargetPlannerFailure>>(
      (result, [symbol, referencePrice]) =>
        Result.flatMap(result, (targetFacts) => {
          const currentQuantity = facts.positions.get(symbol) ?? 0n
          const targetWeight = facts.input.targetWeights[symbol]
          if (targetWeight === undefined) {
            return Result.fail(
              deriveTargetsFailure({
                reason: 'precision',
                message: 'reference-price symbol has no corresponding target weight',
                facts: {
                  cycleId: facts.input.cycleId,
                  symbol,
                },
              }),
            )
          }
          const desiredAt = (price: bigint) =>
            Result.mapError(
              desiredQuantityMicros(facts.allocationCapital, targetWeight, price, {
                precision: {
                  ...facts.input.precision,
                  quantityIncrementMicros: facts.quantityIncrement.toString(),
                },
              }),
              (cause) =>
                deriveTargetsFailure({
                  reason: 'precision',
                  message: 'target quantity could not be represented at the declared precision',
                  facts: {
                    cycleId: facts.input.cycleId,
                    symbol,
                    targetWeight,
                  },
                  cause,
                }),
            )
          const bidPrice = facts.bidPrices.get(symbol)
          const askPrice = facts.askPrices.get(symbol)
          const selectedTarget = (() => {
            if (facts.input.schemaVersion !== quoteBoundTargetPlannerInputSchemaVersion) {
              return Result.map(desiredAt(referencePrice), (quantity) => ({ referencePrice, quantity }))
            }
            if (bidPrice === undefined || askPrice === undefined) {
              return Result.fail(
                deriveTargetsFailure({
                  reason: 'precision',
                  message: 'quote-bound target has no complete verified bid/ask pair',
                  facts: { cycleId: facts.input.cycleId, symbol },
                }),
              )
            }
            return Result.map(Result.all({ bid: desiredAt(bidPrice), ask: desiredAt(askPrice) }), ({ bid, ask }) => {
              if (currentQuantity < ask) return { referencePrice: askPrice, quantity: ask }
              if (currentQuantity > bid) return { referencePrice: bidPrice, quantity: bid }
              return { referencePrice: askPrice, quantity: currentQuantity }
            })
          })()
          return Result.map(selectedTarget, (selected) => {
            const desiredDelta = selected.quantity - currentQuantity
            const maximumBuyQuantity = facts.maximumBuyQuantities.get(symbol)
            const targetQuantity =
              desiredDelta > 0n && maximumBuyQuantity !== undefined && desiredDelta > maximumBuyQuantity
                ? currentQuantity + maximumBuyQuantity
                : selected.quantity
            return [
              ...targetFacts,
              {
                referencePrice: selected.referencePrice,
                delta: targetQuantity - currentQuantity,
                target: {
                  symbol,
                  targetWeight,
                  referencePriceMicros: selected.referencePrice.toString(),
                  currentQuantityMicros: currentQuantity.toString(),
                  targetQuantityMicros: targetQuantity.toString(),
                },
              },
            ]
          })
        }),
      Result.succeed([]),
    )

export const selectTargetPlannerPreflightReason = (facts: TargetPlannerFacts): BlockedTargetPlanReason | undefined => {
  const { input } = facts
  if (facts.observedAt >= facts.submissionCutoffAt) return TargetPlanReason.SubmissionCutoffReached
  if (!identityAndSessionMatch(facts)) return TargetPlanReason.IdentityMismatch
  if (!brokerStateIsCoherent(facts)) return TargetPlanReason.InputMismatch
  if (facts.sourceTimes.some((source) => source > facts.observedAt)) return TargetPlanReason.InputMismatch
  if (facts.sourceTimes.some((source) => facts.observedAt - source >= input.maximumInputAgeMs)) {
    return TargetPlanReason.InputStale
  }
  if (!brokerStateIsCurrent(facts)) return TargetPlanReason.ReconciliationNotExact
  if (input.brokerState.account.status !== AccountStatus.Active) return TargetPlanReason.AccountNotActive
  if (input.brokerState.unknownOrderCount > 0) return TargetPlanReason.UnknownOrder
  if (input.brokerState.orders.some((order) => isUnresolved(order.status))) return TargetPlanReason.UnresolvedOrder
  const forcedClose =
    input.schemaVersion === quoteBoundTargetPlannerInputSchemaVersion &&
    input.executionTerms.executionPurpose !== undefined
  if (!forcedClose && facts.positionQuantities.some((quantity) => quantity < 0n)) {
    return TargetPlanReason.ShortPositionNotAllowed
  }
  if (facts.equity <= 0n) return TargetPlanReason.NonPositiveEquity
  return undefined
}
