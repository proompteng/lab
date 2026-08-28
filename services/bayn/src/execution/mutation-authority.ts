import { Effect, Result } from 'effect'

import {
  AccountStatus,
  OrderCollection,
  OrderSide as BrokerOrderSide,
  OrderType as BrokerOrderType,
  type Account,
  type BrokerReadShape,
  type Order,
  type Position,
} from '../broker/alpaca'
import {
  BrokerMutationError,
  MutationOperation,
  invalidRequest,
  type BrokerMutationShape,
} from '../broker/alpaca-mutations'
import { canonicalHashV1Result } from '../hash'
import { OrderSide as IntentOrderSide, type Intent } from './contracts'
import type { Policy } from '../risk'
import {
  BrokerAccess,
  makeExecutionAuthority,
  type ExecutionCapitalLimits,
  type ExecutionAuthority,
  type ExecutionAuthorityConstructionFailure,
  type GrantedCapitalAuthority,
  type PersistedCapitalGrant,
  type MutationExecutionAuthority,
} from './authority'
import { Pipeable } from '../pipeable'

export type PersistedGrantExecutionAuthority = MutationExecutionAuthority & {
  readonly capitalAuthority: GrantedCapitalAuthority & { readonly persistedGrant: PersistedCapitalGrant }
}

export const isPersistedGrantExecutionAuthority = (
  authority: MutationExecutionAuthority | ExecutionAuthority,
): authority is PersistedGrantExecutionAuthority =>
  authority.brokerAccess === BrokerAccess.Mutation && authority.capitalAuthority.persistedGrant !== undefined

export type IntentAuthorityBindingFailure =
  | {
      readonly _tag: 'IntentAccountMismatch'
      readonly expected: string
      readonly observed: string
    }
  | {
      readonly _tag: 'IntentStrategyMismatch'
      readonly expected: string
      readonly observed: string
    }
  | {
      readonly _tag: 'IntentAuthorityGenerationMismatch'
      readonly expected: string
      readonly observed: string
    }

export type ExecutionCapitalLimitFailure =
  | IntentAuthorityBindingFailure
  | {
      readonly _tag: 'BrokerStateObservationInvalid'
      readonly observedAt: string
    }
  | {
      readonly _tag: 'BrokerStateObservationInFuture'
      readonly observedAt: string
      readonly evaluatedAt: string
    }
  | {
      readonly _tag: 'BrokerStateStale'
      readonly oldestObservedAt: string
      readonly evaluatedAt: string
      readonly maxAgeMs: number
    }
  | {
      readonly _tag: 'BrokerAccountMismatch'
      readonly expected: string
      readonly observed: string
    }
  | {
      readonly _tag: 'BrokerAccountUnavailable'
      readonly status: AccountStatus
      readonly accountBlocked: boolean
      readonly tradingBlocked: boolean
      readonly tradeSuspendedByUser: boolean
    }
  | {
      readonly _tag: 'BrokerPositionAccountMismatch'
      readonly expected: string
      readonly observed: string
      readonly symbol: string
    }
  | {
      readonly _tag: 'BrokerOrderAccountMismatch'
      readonly expected: string
      readonly observed: string
      readonly brokerOrderId: string
    }
  | {
      readonly _tag: 'OpenOrderNotionalUnavailable'
      readonly brokerOrderId: string
      readonly symbol: string
    }
  | {
      readonly _tag: 'OpenOrderMarketPriceUnbounded'
      readonly brokerOrderId: string
      readonly symbol: string
    }
  | {
      readonly _tag: 'OpenOrderQuantityUnavailable'
      readonly brokerOrderId: string
      readonly symbol: string
    }
  | {
      readonly _tag: 'OpenOrderQuantityInvalid'
      readonly brokerOrderId: string
      readonly symbol: string
      readonly quantityMicros: string
      readonly filledQuantityMicros: string
    }
  | {
      readonly _tag: 'OrderNotionalLimitExceeded'
      readonly limitMicros: string
      readonly proposedMicros: string
    }
  | {
      readonly _tag: 'BuyingPowerExceeded'
      readonly availableMicros: string
      readonly proposedMicros: string
    }
  | {
      readonly _tag: 'PositionNotionalLimitExceeded'
      readonly symbol: string
      readonly limitMicros: string
      readonly projectedMicros: string
    }
  | {
      readonly _tag: 'GrossNotionalLimitExceeded'
      readonly limitMicros: string
      readonly projectedMicros: string
    }
  | {
      readonly _tag: 'NetExposureLimitExceeded'
      readonly limitMicros: string
      readonly projectedMicros: string
    }
  | {
      readonly _tag: 'DailyTradedNotionalLimitExceeded'
      readonly limitMicros: string
      readonly projectedMicros: string
    }
  | {
      readonly _tag: 'DailyLossLimitExceeded'
      readonly limitMicros: string
      readonly observedMicros: string
    }
  | {
      readonly _tag: 'DrawdownLimitExceeded'
      readonly limitMicros: string
      readonly observedMicros: string
    }
  | {
      readonly _tag: 'OpenOrderLimitExceeded'
      readonly limit: number
      readonly observed: number
    }
  | {
      readonly _tag: 'BrokerPositionSnapshotChanged'
      readonly beforeHash: string
      readonly afterHash: string
    }
  | {
      readonly _tag: 'BrokerPositionSnapshotInvalid'
      readonly cause: unknown
    }
  | {
      readonly _tag: 'BrokerOpenOrderSnapshotChanged'
      readonly beforeHash: string
      readonly afterHash: string
    }
  | {
      readonly _tag: 'BrokerOpenOrderSnapshotInvalid'
      readonly cause: unknown
    }
  | {
      readonly _tag: 'IncreasingSellUnsupported'
      readonly symbol: string
      readonly currentQuantityMicros: string
      readonly projectedQuantityMicros: string
    }
  | {
      readonly _tag: 'CloseOnlyOrderNotReducing'
      readonly symbol: string
      readonly side: IntentOrderSide
      readonly currentQuantityMicros: string
      readonly projectedQuantityMicros: string
    }
  | {
      readonly _tag: 'PendingSellUncovered'
      readonly symbol: string
      readonly currentQuantityMicros: string
      readonly pendingSellQuantityMicros: string
    }
  | {
      readonly _tag: 'BoundedBrokerOrderInvalid'
      readonly symbol: string
    }

export interface ExecutionCapitalSnapshot {
  readonly account: Account
  readonly positions: readonly Position[]
  readonly openOrders: readonly Order[]
}

export interface FinalSubmitAuthorizationFailure {
  readonly _tag: string
}

export interface FinalSubmitAuthorization {
  <A, E, R>(intent: Intent, transmit: Effect.Effect<A, E, R>): Effect.Effect<A, E | FinalSubmitAuthorizationFailure, R>
}

export interface MutationAuthorityDependencies {
  readonly brokerMutation: BrokerMutationShape
  readonly finalSubmitAuthorization: FinalSubmitAuthorization
}

export interface ExecutionBrokerSubmitSnapshot extends ExecutionCapitalSnapshot {
  readonly accountObservedAt: string
  readonly positionsObservedAt: string
  readonly ordersObservedAt: string
}

export interface BrokerSubmitRefreshDependencies {
  readonly brokerRead: BrokerReadShape
}

export interface ExecutionCapitalLimitContext {
  readonly closeOnly: boolean
  readonly maxBrokerStateAgeMs: number
  readonly maxNetExposureMicros: string
  readonly currentDailyTradedNotionalMicros: string
  readonly maxDailyTradedNotionalMicros: string
  readonly peakEquityMicros: string
  readonly maxDrawdownMicros: string
  readonly hardCloseLimits?: Pick<ExecutionCapitalLimits, 'maxOrderNotionalMicros' | 'maxDailyLossMicros'>
}

const absolute = (value: bigint): bigint => (value < 0n ? -value : value)
const microsPerUnit = 1_000_000n

export const executionCapitalLimitsFromPolicy = (policy: Policy): ExecutionCapitalLimits => ({
  maxGrossNotionalMicros: policy.maxGrossExposureMicros,
  maxOrderNotionalMicros: policy.maxOrderNotionalMicros,
  maxPositionNotionalMicros: policy.maxSymbolExposureMicros,
  maxDailyLossMicros: policy.maxDailyLossMicros,
  maxOpenOrders: policy.maxOpenOrders,
})

const minimumMicros = (left: string, right: string): string => {
  const leftMicros = BigInt(left)
  const rightMicros = BigInt(right)
  return (leftMicros < rightMicros ? leftMicros : rightMicros).toString()
}

export const constrainExecutionCapitalLimits = (
  policyLimits: ExecutionCapitalLimits,
  grantLimits: ExecutionCapitalLimits,
): ExecutionCapitalLimits => ({
  maxGrossNotionalMicros: minimumMicros(policyLimits.maxGrossNotionalMicros, grantLimits.maxGrossNotionalMicros),
  maxOrderNotionalMicros: minimumMicros(policyLimits.maxOrderNotionalMicros, grantLimits.maxOrderNotionalMicros),
  maxPositionNotionalMicros: minimumMicros(
    policyLimits.maxPositionNotionalMicros,
    grantLimits.maxPositionNotionalMicros,
  ),
  maxDailyLossMicros: minimumMicros(policyLimits.maxDailyLossMicros, grantLimits.maxDailyLossMicros),
  maxOpenOrders: Math.min(policyLimits.maxOpenOrders, grantLimits.maxOpenOrders),
})

const positionExposureIdentity = (positions: readonly Position[]) =>
  positions
    .map((position) => ({
      accountId: position.accountId,
      assetId: position.assetId,
      symbol: position.symbol,
      side: position.side,
      quantityMicros: position.quantityMicros,
      averageEntryPriceMicros: position.averageEntryPriceMicros,
    }))
    .sort((left, right) =>
      left.assetId < right.assetId ? -1 : left.assetId > right.assetId ? 1 : left.symbol.localeCompare(right.symbol),
    )

const validateStablePositionSnapshotDataFirst = (
  before: readonly Position[],
  after: readonly Position[],
): Result.Result<readonly Position[], ExecutionCapitalLimitFailure> => {
  const beforeHash = canonicalHashV1Result(positionExposureIdentity(before))
  if (Result.isFailure(beforeHash)) {
    return Result.fail({ _tag: 'BrokerPositionSnapshotInvalid', cause: beforeHash.failure })
  }
  const afterHash = canonicalHashV1Result(positionExposureIdentity(after))
  if (Result.isFailure(afterHash)) {
    return Result.fail({ _tag: 'BrokerPositionSnapshotInvalid', cause: afterHash.failure })
  }
  return beforeHash.success === afterHash.success
    ? Result.succeed(after)
    : Result.fail({
        _tag: 'BrokerPositionSnapshotChanged',
        beforeHash: beforeHash.success,
        afterHash: afterHash.success,
      })
}

export const validateStablePositionSnapshot = Pipeable.dual(2, validateStablePositionSnapshotDataFirst)

const openOrderExposureIdentity = (orders: readonly Order[]) =>
  orders
    .map((order) => ({
      accountId: order.accountId,
      brokerOrderId: order.brokerOrderId,
      symbol: order.symbol,
      side: order.side,
      orderType: order.orderType,
      quantityMicros: order.quantityMicros ?? null,
      notionalMicros: order.notionalMicros ?? null,
      filledQuantityMicros: order.filledQuantityMicros,
      filledAveragePriceMicros: order.filledAveragePriceMicros ?? null,
      limitPriceMicros: order.limitPriceMicros ?? null,
      stopPriceMicros: order.stopPriceMicros ?? null,
      status: order.status,
    }))
    .sort((left, right) =>
      left.brokerOrderId < right.brokerOrderId ? -1 : left.brokerOrderId > right.brokerOrderId ? 1 : 0,
    )

const validateStableOpenOrderSnapshotDataFirst = (
  before: readonly Order[],
  after: readonly Order[],
): Result.Result<readonly Order[], ExecutionCapitalLimitFailure> => {
  const beforeHash = canonicalHashV1Result(openOrderExposureIdentity(before))
  if (Result.isFailure(beforeHash)) {
    return Result.fail({ _tag: 'BrokerOpenOrderSnapshotInvalid', cause: beforeHash.failure })
  }
  const afterHash = canonicalHashV1Result(openOrderExposureIdentity(after))
  if (Result.isFailure(afterHash)) {
    return Result.fail({ _tag: 'BrokerOpenOrderSnapshotInvalid', cause: afterHash.failure })
  }
  return beforeHash.success === afterHash.success
    ? Result.succeed(after)
    : Result.fail({
        _tag: 'BrokerOpenOrderSnapshotChanged',
        beforeHash: beforeHash.success,
        afterHash: afterHash.success,
      })
}

const validateStableOpenOrderSnapshot = Pipeable.dual(2, validateStableOpenOrderSnapshotDataFirst)

const expectedAuthorityGeneration = (authority: MutationExecutionAuthority): string =>
  authority.capitalAuthority.authorityGenerationHash

const validateIntentAuthorityBindingDataFirst = (
  authority: MutationExecutionAuthority,
  intent: Intent,
): Result.Result<void, IntentAuthorityBindingFailure> => {
  if (intent.accountId !== authority.brokerIdentity.accountId) {
    return Result.fail({
      _tag: 'IntentAccountMismatch',
      expected: authority.brokerIdentity.accountId,
      observed: intent.accountId,
    })
  }
  if (intent.strategyName !== authority.strategy.name) {
    return Result.fail({
      _tag: 'IntentStrategyMismatch',
      expected: authority.strategy.name,
      observed: intent.strategyName,
    })
  }
  const expectedGeneration = expectedAuthorityGeneration(authority)
  if (intent.authorityGenerationHash !== expectedGeneration) {
    return Result.fail({
      _tag: 'IntentAuthorityGenerationMismatch',
      expected: expectedGeneration,
      observed: intent.authorityGenerationHash,
    })
  }
  return Result.succeed(undefined)
}

export const validateIntentAuthorityBinding = Pipeable.dual(2, validateIntentAuthorityBindingDataFirst)

const signedIntentNotional = (intent: Intent, notional: bigint): bigint =>
  intent.side === IntentOrderSide.Buy ? notional : -notional

const parseCanonicalPositiveMicros = (value: string): bigint | undefined =>
  /^[1-9][0-9]*$/.test(value) ? BigInt(value) : undefined

export const boundedBrokerOrderNotional = (intent: Intent): Result.Result<bigint, ExecutionCapitalLimitFailure> => {
  const notionalLimitMicros = parseCanonicalPositiveMicros(intent.notionalLimitMicros)
  if (notionalLimitMicros === undefined) {
    return Result.fail({
      _tag: 'BoundedBrokerOrderInvalid',
      symbol: intent.symbol,
    })
  }
  return Result.succeed(notionalLimitMicros)
}

const orderHasUnboundedExecutionPrice = (order: Order): boolean =>
  order.notionalMicros === undefined &&
  order.quantityMicros !== undefined &&
  order.limitPriceMicros === undefined &&
  (order.orderType === BrokerOrderType.Stop || order.orderType === BrokerOrderType.TrailingStop)

const signedOrderNotional = (order: Order): Result.Result<bigint, ExecutionCapitalLimitFailure> => {
  const remainingQuantity = unfilledOrderQuantity(order)
  if (Result.isFailure(remainingQuantity)) return Result.fail(remainingQuantity.failure)
  if (orderHasUnboundedExecutionPrice(order)) {
    return Result.fail({
      _tag: 'OpenOrderNotionalUnavailable',
      brokerOrderId: order.brokerOrderId,
      symbol: order.symbol,
    })
  }
  if (remainingQuantity.success === undefined) {
    if (order.notionalMicros !== undefined) {
      const notional = absolute(BigInt(order.notionalMicros))
      return Result.succeed(order.side === BrokerOrderSide.Buy ? notional : -notional)
    }
    return Result.fail({
      _tag: 'OpenOrderNotionalUnavailable',
      brokerOrderId: order.brokerOrderId,
      symbol: order.symbol,
    })
  }
  if (order.notionalMicros !== undefined && order.quantityMicros !== undefined) {
    const originalNotional = absolute(BigInt(order.notionalMicros))
    const originalQuantity = BigInt(order.quantityMicros)
    const notional = (originalNotional * remainingQuantity.success + originalQuantity - 1n) / originalQuantity
    return Result.succeed(order.side === BrokerOrderSide.Buy ? notional : -notional)
  }
  const quantityMarketRemainder =
    order.orderType === BrokerOrderType.Market &&
    order.notionalMicros === undefined &&
    order.limitPriceMicros === undefined &&
    order.stopPriceMicros === undefined
  if (quantityMarketRemainder) {
    // A quantity-based market sell cannot increase long-only exposure. Give it no exposure-reduction credit until
    // it fills; pending-sell quantity coverage is verified separately against the broker position snapshot.
    if (order.side === BrokerOrderSide.Sell) return Result.succeed(0n)
    return Result.fail({
      _tag: 'OpenOrderMarketPriceUnbounded',
      brokerOrderId: order.brokerOrderId,
      symbol: order.symbol,
    })
  }
  const prices = [order.limitPriceMicros, order.stopPriceMicros, order.filledAveragePriceMicros]
    .filter((price): price is string => price !== undefined)
    .map((price) => absolute(BigInt(price)))
  if (prices.length === 0) {
    return Result.fail({
      _tag: 'OpenOrderNotionalUnavailable',
      brokerOrderId: order.brokerOrderId,
      symbol: order.symbol,
    })
  }
  const conservativePrice =
    order.side === BrokerOrderSide.Buy
      ? prices.reduce((maximum, price) => (price > maximum ? price : maximum))
      : prices.reduce((minimum, price) => (price < minimum ? price : minimum))
  const numerator = remainingQuantity.success * conservativePrice
  const notional = (numerator + microsPerUnit - 1n) / microsPerUnit
  return Result.succeed(order.side === BrokerOrderSide.Buy ? notional : -notional)
}

const unfilledOrderQuantity = (
  order: Order,
): Result.Result<
  bigint | undefined,
  Extract<ExecutionCapitalLimitFailure, { readonly _tag: 'OpenOrderQuantityUnavailable' | 'OpenOrderQuantityInvalid' }>
> => {
  if (order.quantityMicros === undefined) return Result.succeed(undefined)
  const quantity = BigInt(order.quantityMicros)
  const filled = BigInt(order.filledQuantityMicros)
  if (quantity <= 0n || filled < 0n || filled > quantity) {
    return Result.fail({
      _tag: 'OpenOrderQuantityInvalid',
      brokerOrderId: order.brokerOrderId,
      symbol: order.symbol,
      quantityMicros: order.quantityMicros,
      filledQuantityMicros: order.filledQuantityMicros,
    })
  }
  return Result.succeed(quantity - filled)
}

export const priceOpenOrders = (
  openOrders: readonly Order[],
): Result.Result<ReadonlyMap<string, bigint>, ExecutionCapitalLimitFailure> => {
  const notionals = new Map<string, bigint>()
  for (const order of openOrders) {
    const notional = signedOrderNotional(order)
    if (Result.isFailure(notional)) return Result.fail(notional.failure)
    notionals.set(order.brokerOrderId, notional.success)
  }
  return Result.succeed(notionals)
}

const symbolQuantityEnvelopeAfterPendingOrders = (
  intent: Intent,
  snapshot: ExecutionCapitalSnapshot,
): Result.Result<
  {
    readonly beforeIntentMinimumMicros: bigint
    readonly beforeIntentMaximumMicros: bigint
    readonly afterIntentMinimumMicros: bigint
    readonly afterIntentMaximumMicros: bigint
  },
  Extract<ExecutionCapitalLimitFailure, { readonly _tag: 'OpenOrderQuantityUnavailable' | 'OpenOrderQuantityInvalid' }>
> => {
  const currentQuantityMicros = snapshot.positions
    .filter((position) => position.symbol === intent.symbol)
    .reduce((total, position) => total + BigInt(position.quantityMicros), 0n)
  let beforeIntentMinimumMicros = currentQuantityMicros
  let beforeIntentMaximumMicros = currentQuantityMicros
  for (const order of snapshot.openOrders.filter((candidate) => candidate.symbol === intent.symbol)) {
    const remaining = unfilledOrderQuantity(order)
    if (Result.isFailure(remaining)) return Result.fail(remaining.failure)
    if (remaining.success === undefined) {
      return Result.fail({
        _tag: 'OpenOrderQuantityUnavailable',
        brokerOrderId: order.brokerOrderId,
        symbol: order.symbol,
      })
    }

    if (order.side === BrokerOrderSide.Buy) {
      beforeIntentMaximumMicros += remaining.success
    } else {
      beforeIntentMinimumMicros -= remaining.success
    }
  }
  const signedIntentQuantityMicros =
    intent.side === IntentOrderSide.Buy ? BigInt(intent.quantityMicros) : -BigInt(intent.quantityMicros)
  return Result.succeed({
    beforeIntentMinimumMicros,
    beforeIntentMaximumMicros,
    afterIntentMinimumMicros: beforeIntentMinimumMicros + signedIntentQuantityMicros,
    afterIntentMaximumMicros: beforeIntentMaximumMicros + signedIntentQuantityMicros,
  })
}

export const validatePendingSellCoverage = (
  snapshot: ExecutionCapitalSnapshot,
): Result.Result<
  void,
  Extract<
    ExecutionCapitalLimitFailure,
    | { readonly _tag: 'OpenOrderQuantityUnavailable' }
    | { readonly _tag: 'OpenOrderQuantityInvalid' }
    | { readonly _tag: 'PendingSellUncovered' }
  >
> => {
  const currentBySymbol = new Map<string, bigint>()
  for (const position of snapshot.positions) {
    currentBySymbol.set(position.symbol, (currentBySymbol.get(position.symbol) ?? 0n) + BigInt(position.quantityMicros))
  }
  const pendingSellsBySymbol = new Map<string, bigint>()
  for (const order of snapshot.openOrders.filter((candidate) => candidate.side === BrokerOrderSide.Sell)) {
    const remaining = unfilledOrderQuantity(order)
    if (Result.isFailure(remaining)) return Result.fail(remaining.failure)
    if (remaining.success === undefined) {
      return Result.fail({
        _tag: 'OpenOrderQuantityUnavailable',
        brokerOrderId: order.brokerOrderId,
        symbol: order.symbol,
      })
    }
    pendingSellsBySymbol.set(order.symbol, (pendingSellsBySymbol.get(order.symbol) ?? 0n) + remaining.success)
  }
  for (const [symbol, pendingSellQuantity] of pendingSellsBySymbol) {
    const currentQuantity = currentBySymbol.get(symbol) ?? 0n
    if (pendingSellQuantity > currentQuantity) {
      return Result.fail({
        _tag: 'PendingSellUncovered',
        symbol,
        currentQuantityMicros: currentQuantity.toString(),
        pendingSellQuantityMicros: pendingSellQuantity.toString(),
      })
    }
  }
  return Result.succeed(undefined)
}

interface PendingSymbolExposure {
  readonly buyMicros: bigint
  readonly sellMicros: bigint
}

const emptyPendingSymbolExposure: PendingSymbolExposure = { buyMicros: 0n, sellMicros: 0n }

const maximumAbsoluteExposureAcrossPendingFillsDataFirst = (
  currentMicros: bigint,
  pending: PendingSymbolExposure,
  proposedMicros: bigint,
): bigint => {
  const lowerBound = currentMicros + proposedMicros - pending.sellMicros
  const upperBound = currentMicros + proposedMicros + pending.buyMicros
  return absolute(lowerBound) > absolute(upperBound) ? absolute(lowerBound) : absolute(upperBound)
}

export const maximumAbsoluteExposureAcrossPendingFills = Pipeable.dual(
  3,
  maximumAbsoluteExposureAcrossPendingFillsDataFirst,
)

const validateSnapshotBindings = (
  authority: MutationExecutionAuthority,
  snapshot: ExecutionCapitalSnapshot,
): Result.Result<void, ExecutionCapitalLimitFailure> => {
  const expectedAccountId = authority.brokerIdentity.accountId
  if (snapshot.account.id !== expectedAccountId) {
    return Result.fail({
      _tag: 'BrokerAccountMismatch',
      expected: expectedAccountId,
      observed: snapshot.account.id,
    })
  }
  if (
    snapshot.account.status !== AccountStatus.Active ||
    snapshot.account.accountBlocked ||
    snapshot.account.tradingBlocked ||
    snapshot.account.tradeSuspendedByUser
  ) {
    return Result.fail({
      _tag: 'BrokerAccountUnavailable',
      status: snapshot.account.status,
      accountBlocked: snapshot.account.accountBlocked,
      tradingBlocked: snapshot.account.tradingBlocked,
      tradeSuspendedByUser: snapshot.account.tradeSuspendedByUser,
    })
  }
  for (const position of snapshot.positions) {
    if (position.accountId !== expectedAccountId) {
      return Result.fail({
        _tag: 'BrokerPositionAccountMismatch',
        expected: expectedAccountId,
        observed: position.accountId,
        symbol: position.symbol,
      })
    }
  }
  for (const order of snapshot.openOrders) {
    if (order.accountId !== expectedAccountId) {
      return Result.fail({
        _tag: 'BrokerOrderAccountMismatch',
        expected: expectedAccountId,
        observed: order.accountId,
        brokerOrderId: order.brokerOrderId,
      })
    }
  }
  return Result.succeed(undefined)
}

const validateBrokerStateFreshness = (
  snapshot: ExecutionBrokerSubmitSnapshot,
  evaluatedAt: string,
  maxAgeMs: number,
): Result.Result<void, ExecutionCapitalLimitFailure> => {
  const evaluatedAtMs = Date.parse(evaluatedAt)
  if (!Number.isFinite(evaluatedAtMs)) {
    return Result.fail({ _tag: 'BrokerStateObservationInvalid', observedAt: evaluatedAt })
  }

  const observations = [
    snapshot.accountObservedAt,
    snapshot.positionsObservedAt,
    snapshot.ordersObservedAt,
    ...snapshot.positions.map((position) => position.observedAt),
    ...snapshot.openOrders.map((order) => order.observedAt),
  ]
  let oldestObservedAt = snapshot.account.observedAt
  let oldestObservedAtMs = Date.parse(oldestObservedAt)
  if (!Number.isFinite(oldestObservedAtMs)) {
    return Result.fail({ _tag: 'BrokerStateObservationInvalid', observedAt: oldestObservedAt })
  }

  for (const observedAt of [snapshot.account.observedAt, ...observations]) {
    const observedAtMs = Date.parse(observedAt)
    if (!Number.isFinite(observedAtMs)) {
      return Result.fail({ _tag: 'BrokerStateObservationInvalid', observedAt })
    }
    if (observedAtMs > evaluatedAtMs) {
      return Result.fail({ _tag: 'BrokerStateObservationInFuture', observedAt, evaluatedAt })
    }
    if (observedAtMs < oldestObservedAtMs) {
      oldestObservedAt = observedAt
      oldestObservedAtMs = observedAtMs
    }
  }

  return evaluatedAtMs < oldestObservedAtMs + maxAgeMs
    ? Result.succeed(undefined)
    : Result.fail({
        _tag: 'BrokerStateStale',
        oldestObservedAt,
        evaluatedAt,
        maxAgeMs,
      })
}

const validateExecutionCapitalLimitsDataFirst = (
  authority: MutationExecutionAuthority,
  limits: ExecutionCapitalLimits,
  intent: Intent,
  snapshot: ExecutionCapitalSnapshot,
  proposedExposureNotional: bigint,
  proposedOrderNotional: bigint,
  openOrderNotionals: ReadonlyMap<string, bigint>,
  context: ExecutionCapitalLimitContext,
): Result.Result<void, ExecutionCapitalLimitFailure> => {
  const binding = validateIntentAuthorityBinding(authority, intent)
  if (Result.isFailure(binding)) return Result.fail(binding.failure)
  const snapshotBinding = validateSnapshotBindings(authority, snapshot)
  if (Result.isFailure(snapshotBinding)) return Result.fail(snapshotBinding.failure)
  const pendingSellCoverage = validatePendingSellCoverage(snapshot)
  if (Result.isFailure(pendingSellCoverage)) return Result.fail(pendingSellCoverage.failure)

  if (snapshot.openOrders.length >= limits.maxOpenOrders) {
    return Result.fail({
      _tag: 'OpenOrderLimitExceeded',
      limit: limits.maxOpenOrders,
      observed: snapshot.openOrders.length,
    })
  }

  const currentBySymbol = new Map<string, bigint>()
  for (const position of snapshot.positions) {
    currentBySymbol.set(
      position.symbol,
      (currentBySymbol.get(position.symbol) ?? 0n) + BigInt(position.marketValueMicros),
    )
  }
  const pendingBySymbol = new Map<string, PendingSymbolExposure>()
  for (const order of snapshot.openOrders) {
    const notional = openOrderNotionals.get(order.brokerOrderId)
    if (notional === undefined) {
      return Result.fail({
        _tag: 'OpenOrderNotionalUnavailable',
        brokerOrderId: order.brokerOrderId,
        symbol: order.symbol,
      })
    }
    const pending = pendingBySymbol.get(order.symbol) ?? emptyPendingSymbolExposure
    pendingBySymbol.set(
      order.symbol,
      notional > 0n
        ? { ...pending, buyMicros: pending.buyMicros + notional }
        : { ...pending, sellMicros: pending.sellMicros + absolute(notional) },
    )
  }

  const symbols = new Set([...currentBySymbol.keys(), ...pendingBySymbol.keys(), intent.symbol])
  const proposedSignedNotional = signedIntentNotional(intent, proposedExposureNotional)
  const worstCaseGross = (includeProposed: boolean): bigint => {
    let gross = 0n
    for (const symbol of symbols) {
      gross += maximumAbsoluteExposureAcrossPendingFills(
        currentBySymbol.get(symbol) ?? 0n,
        pendingBySymbol.get(symbol) ?? emptyPendingSymbolExposure,
        includeProposed && symbol === intent.symbol ? proposedSignedNotional : 0n,
      )
    }
    return gross
  }
  const pendingForIntent = pendingBySymbol.get(intent.symbol) ?? emptyPendingSymbolExposure
  const currentSymbol = maximumAbsoluteExposureAcrossPendingFills(
    currentBySymbol.get(intent.symbol) ?? 0n,
    pendingForIntent,
    0n,
  )
  const projectedSymbol = maximumAbsoluteExposureAcrossPendingFills(
    currentBySymbol.get(intent.symbol) ?? 0n,
    pendingForIntent,
    proposedSignedNotional,
  )
  const currentGross = worstCaseGross(false)
  const projectedGross = worstCaseGross(true)
  const currentNet = [...currentBySymbol.values()].reduce((total, notional) => total + notional, 0n)
  const pendingNetExposure = [...pendingBySymbol.values()].reduce(
    (total, pending) => ({
      buyMicros: total.buyMicros + pending.buyMicros,
      sellMicros: total.sellMicros + pending.sellMicros,
    }),
    emptyPendingSymbolExposure,
  )
  const currentNetExposure = maximumAbsoluteExposureAcrossPendingFills(currentNet, pendingNetExposure, 0n)
  const projectedNetExposure = maximumAbsoluteExposureAcrossPendingFills(
    currentNet,
    pendingNetExposure,
    proposedSignedNotional,
  )
  const quantityEnvelope = symbolQuantityEnvelopeAfterPendingOrders(intent, snapshot)
  if (Result.isFailure(quantityEnvelope)) return Result.fail(quantityEnvelope.failure)
  const currentQuantityMicros = snapshot.positions
    .filter((position) => position.symbol === intent.symbol)
    .reduce((total, position) => total + BigInt(position.quantityMicros), 0n)
  const projectedQuantityMicros =
    currentQuantityMicros +
    (intent.side === IntentOrderSide.Buy ? BigInt(intent.quantityMicros) : -BigInt(intent.quantityMicros))
  const strictlyReducingClose =
    context.closeOnly &&
    (intent.side === IntentOrderSide.Sell
      ? quantityEnvelope.success.beforeIntentMinimumMicros > 0n &&
        quantityEnvelope.success.afterIntentMinimumMicros >= 0n &&
        quantityEnvelope.success.afterIntentMaximumMicros < quantityEnvelope.success.beforeIntentMaximumMicros
      : quantityEnvelope.success.beforeIntentMaximumMicros < 0n &&
        quantityEnvelope.success.afterIntentMaximumMicros <= 0n &&
        quantityEnvelope.success.afterIntentMinimumMicros > quantityEnvelope.success.beforeIntentMinimumMicros) &&
    projectedSymbol < currentSymbol
  const exposureReducingClose =
    strictlyReducingClose &&
    snapshot.positions.every((position) =>
      intent.side === IntentOrderSide.Sell
        ? BigInt(position.quantityMicros) >= 0n
        : BigInt(position.quantityMicros) <= 0n,
    ) &&
    projectedGross <= currentGross &&
    projectedNetExposure <= currentNetExposure

  if (context.closeOnly && !strictlyReducingClose) {
    return Result.fail({
      _tag: 'CloseOnlyOrderNotReducing',
      symbol: intent.symbol,
      side: intent.side,
      currentQuantityMicros: currentQuantityMicros.toString(),
      projectedQuantityMicros: projectedQuantityMicros.toString(),
    })
  }

  const enforcedOrderLimit = exposureReducingClose
    ? context.hardCloseLimits?.maxOrderNotionalMicros
    : limits.maxOrderNotionalMicros
  if (enforcedOrderLimit !== undefined && proposedOrderNotional > BigInt(enforcedOrderLimit)) {
    return Result.fail({
      _tag: 'OrderNotionalLimitExceeded',
      limitMicros: enforcedOrderLimit,
      proposedMicros: proposedOrderNotional.toString(),
    })
  }
  if (
    !strictlyReducingClose &&
    intent.side === IntentOrderSide.Buy &&
    proposedOrderNotional > BigInt(snapshot.account.buyingPowerMicros)
  ) {
    return Result.fail({
      _tag: 'BuyingPowerExceeded',
      availableMicros: snapshot.account.buyingPowerMicros,
      proposedMicros: proposedOrderNotional.toString(),
    })
  }
  if (intent.side === IntentOrderSide.Sell && quantityEnvelope.success.afterIntentMinimumMicros < 0n) {
    return Result.fail({
      _tag: 'IncreasingSellUnsupported',
      symbol: intent.symbol,
      currentQuantityMicros: quantityEnvelope.success.beforeIntentMinimumMicros.toString(),
      projectedQuantityMicros: quantityEnvelope.success.afterIntentMinimumMicros.toString(),
    })
  }

  if (projectedSymbol > BigInt(limits.maxPositionNotionalMicros) && projectedSymbol >= currentSymbol) {
    return Result.fail({
      _tag: 'PositionNotionalLimitExceeded',
      symbol: intent.symbol,
      limitMicros: limits.maxPositionNotionalMicros,
      projectedMicros: projectedSymbol.toString(),
    })
  }

  if (projectedGross > BigInt(limits.maxGrossNotionalMicros) && projectedGross >= currentGross) {
    return Result.fail({
      _tag: 'GrossNotionalLimitExceeded',
      limitMicros: limits.maxGrossNotionalMicros,
      projectedMicros: projectedGross.toString(),
    })
  }

  if (projectedNetExposure > BigInt(context.maxNetExposureMicros) && projectedNetExposure >= currentNetExposure) {
    return Result.fail({
      _tag: 'NetExposureLimitExceeded',
      limitMicros: context.maxNetExposureMicros,
      projectedMicros: projectedNetExposure.toString(),
    })
  }

  const projectedDailyTradedNotional = BigInt(context.currentDailyTradedNotionalMicros) + proposedOrderNotional
  if (!exposureReducingClose && projectedDailyTradedNotional > BigInt(context.maxDailyTradedNotionalMicros)) {
    return Result.fail({
      _tag: 'DailyTradedNotionalLimitExceeded',
      limitMicros: context.maxDailyTradedNotionalMicros,
      projectedMicros: projectedDailyTradedNotional.toString(),
    })
  }

  const dailyLoss = BigInt(snapshot.account.lastEquityMicros) - BigInt(snapshot.account.equityMicros)
  const observedLoss = dailyLoss > 0n ? dailyLoss : 0n
  const enforcedDailyLossLimit = exposureReducingClose
    ? context.hardCloseLimits?.maxDailyLossMicros
    : limits.maxDailyLossMicros
  if (enforcedDailyLossLimit !== undefined && observedLoss > BigInt(enforcedDailyLossLimit)) {
    return Result.fail({
      _tag: 'DailyLossLimitExceeded',
      limitMicros: enforcedDailyLossLimit,
      observedMicros: observedLoss.toString(),
    })
  }
  const drawdown = BigInt(context.peakEquityMicros) - BigInt(snapshot.account.equityMicros)
  const observedDrawdown = drawdown > 0n ? drawdown : 0n
  if (!exposureReducingClose && observedDrawdown > BigInt(context.maxDrawdownMicros)) {
    return Result.fail({
      _tag: 'DrawdownLimitExceeded',
      limitMicros: context.maxDrawdownMicros,
      observedMicros: observedDrawdown.toString(),
    })
  }
  return Result.succeed(undefined)
}

export const validateExecutionCapitalLimits = Pipeable.dual(8, validateExecutionCapitalLimitsDataFirst)

const mutationAuthorizationError = (message: string, cause: unknown) =>
  invalidRequest({ operation: MutationOperation.Submit, message, cause })

const refreshExecutionBrokerSubmitSnapshotDataFirst = (
  limits: ExecutionCapitalLimits,
  _intent: Intent,
  dependencies: BrokerSubmitRefreshDependencies,
): Effect.Effect<ExecutionBrokerSubmitSnapshot, BrokerMutationError> =>
  Effect.gen(function* () {
    const positionsBefore = yield* dependencies.brokerRead.positions.pipe(
      Effect.mapError((cause) =>
        mutationAuthorizationError('broker positions could not be refreshed before submit', cause),
      ),
    )
    const openOrdersBefore = yield* dependencies.brokerRead
      .orders({
        status: OrderCollection.Open,
        limit: limits.maxOpenOrders,
      })
      .pipe(
        Effect.mapError((cause) =>
          mutationAuthorizationError('broker open orders could not be refreshed before submit', cause),
        ),
      )
    const positionsAfter = yield* dependencies.brokerRead.positions.pipe(
      Effect.mapError((cause) =>
        mutationAuthorizationError('broker positions could not be confirmed after open-order refresh', cause),
      ),
    )
    const stablePositions = validateStablePositionSnapshot(positionsBefore.value, positionsAfter.value)
    if (Result.isFailure(stablePositions)) {
      return yield* mutationAuthorizationError(
        'broker position snapshot changed during exposure refresh',
        stablePositions.failure,
      )
    }
    const openOrdersAfter = yield* dependencies.brokerRead
      .orders({
        status: OrderCollection.Open,
        limit: limits.maxOpenOrders,
      })
      .pipe(
        Effect.mapError((cause) =>
          mutationAuthorizationError('broker open orders could not be confirmed after position refresh', cause),
        ),
      )
    const stableOpenOrders = validateStableOpenOrderSnapshot(openOrdersBefore.value, openOrdersAfter.value)
    if (Result.isFailure(stableOpenOrders)) {
      return yield* mutationAuthorizationError(
        'broker open-order snapshot changed during exposure refresh',
        stableOpenOrders.failure,
      )
    }
    const positionsConfirmed = yield* dependencies.brokerRead.positions.pipe(
      Effect.mapError((cause) =>
        mutationAuthorizationError('broker positions could not be confirmed after exposure refresh', cause),
      ),
    )
    const confirmedPositions = validateStablePositionSnapshot(stablePositions.success, positionsConfirmed.value)
    if (Result.isFailure(confirmedPositions)) {
      return yield* mutationAuthorizationError(
        'broker position snapshot changed during final exposure confirmation',
        confirmedPositions.failure,
      )
    }
    const openOrdersConfirmed = yield* dependencies.brokerRead
      .orders({
        status: OrderCollection.Open,
        limit: limits.maxOpenOrders,
      })
      .pipe(
        Effect.mapError((cause) =>
          mutationAuthorizationError('broker open orders could not be confirmed after exposure refresh', cause),
        ),
      )
    const confirmedOpenOrders = validateStableOpenOrderSnapshot(stableOpenOrders.success, openOrdersConfirmed.value)
    if (Result.isFailure(confirmedOpenOrders)) {
      return yield* mutationAuthorizationError(
        'broker open-order snapshot changed during final exposure confirmation',
        confirmedOpenOrders.failure,
      )
    }
    const accountConfirmed = yield* dependencies.brokerRead.account.pipe(
      Effect.mapError((cause) =>
        mutationAuthorizationError('broker account could not be refreshed after final exposure confirmation', cause),
      ),
    )
    return {
      account: accountConfirmed.value,
      positions: confirmedPositions.success,
      openOrders: confirmedOpenOrders.success,
      accountObservedAt: accountConfirmed.evidence.observedAt,
      positionsObservedAt: positionsConfirmed.evidence.observedAt,
      ordersObservedAt: openOrdersConfirmed.evidence.observedAt,
    }
  })

export const refreshExecutionBrokerSubmitSnapshot = Pipeable.dual(3, refreshExecutionBrokerSubmitSnapshotDataFirst)

export type PersistedCapitalGrantRefreshFailure =
  | ExecutionAuthorityConstructionFailure
  | {
      readonly _tag: 'PersistedCapitalGrantHashMismatch'
      readonly expected: string
      readonly observed: string
    }
  | {
      readonly _tag: 'FreshAuthorityCapabilityMismatch'
    }

const validatePersistedCapitalGrantForSubmitDataFirst = (
  captured: MutationExecutionAuthority,
  persisted: GrantedCapitalAuthority,
  observedAt: string,
): Result.Result<PersistedGrantExecutionAuthority, PersistedCapitalGrantRefreshFailure> => {
  if (!isPersistedGrantExecutionAuthority(captured)) {
    return Result.fail({ _tag: 'FreshAuthorityCapabilityMismatch' })
  }
  if (persisted.persistedGrant === undefined) {
    return Result.fail({ _tag: 'FreshAuthorityCapabilityMismatch' })
  }
  if (persisted.persistedGrant.grant.grantHash !== captured.capitalAuthority.persistedGrant.grant.grantHash) {
    return Result.fail({
      _tag: 'PersistedCapitalGrantHashMismatch' as const,
      expected: captured.capitalAuthority.persistedGrant.grant.grantHash,
      observed: persisted.persistedGrant.grant.grantHash,
    })
  }
  const constructed = makeExecutionAuthority({
    brokerIdentity: captured.brokerIdentity,
    brokerAccess: BrokerAccess.Mutation,
    capitalAuthority: persisted,
    strategy: captured.strategy,
    observedAt,
  })
  if (Result.isFailure(constructed)) return Result.fail(constructed.failure)
  return isPersistedGrantExecutionAuthority(constructed.success)
    ? Result.succeed(constructed.success)
    : Result.fail({ _tag: 'FreshAuthorityCapabilityMismatch' })
}

export const validatePersistedCapitalGrantForSubmit = Pipeable.dual(3, validatePersistedCapitalGrantForSubmitDataFirst)

export type BrokerSubmitValidationFailure = ExecutionCapitalLimitFailure

const validateExecutionBrokerSubmitSnapshotDataFirst = (
  authority: MutationExecutionAuthority,
  limits: ExecutionCapitalLimits,
  intent: Intent,
  snapshot: ExecutionBrokerSubmitSnapshot,
  observedAt: string,
  context: ExecutionCapitalLimitContext,
): Result.Result<void, BrokerSubmitValidationFailure> => {
  const snapshotFreshness = validateBrokerStateFreshness(snapshot, observedAt, context.maxBrokerStateAgeMs)
  if (Result.isFailure(snapshotFreshness)) return Result.fail(snapshotFreshness.failure)
  const requestedNotional = boundedBrokerOrderNotional(intent)
  if (Result.isFailure(requestedNotional)) return Result.fail(requestedNotional.failure)
  const openOrderNotionals = priceOpenOrders(snapshot.openOrders)
  if (Result.isFailure(openOrderNotionals)) return Result.fail(openOrderNotionals.failure)
  return validateExecutionCapitalLimits(
    authority,
    limits,
    intent,
    snapshot,
    requestedNotional.success,
    requestedNotional.success,
    openOrderNotionals.success,
    context,
  )
}

export const validateExecutionBrokerSubmitSnapshot = Pipeable.dual(6, validateExecutionBrokerSubmitSnapshotDataFirst)

const makeAuthorityGuardedBrokerMutationDataFirst = (
  authority: MutationExecutionAuthority,
  dependencies: MutationAuthorityDependencies,
): BrokerMutationShape => {
  const transmit = (intent: Intent) =>
    dependencies
      .finalSubmitAuthorization(intent, dependencies.brokerMutation.submit(intent))
      .pipe(
        Effect.mapError((cause) =>
          cause instanceof BrokerMutationError
            ? cause
            : mutationAuthorizationError('final broker submit authorization failed', cause),
        ),
      )
  const submit = (intent: Intent) => {
    const binding = validateIntentAuthorityBinding(authority, intent)
    if (Result.isFailure(binding)) {
      return Effect.fail(
        mutationAuthorizationError('intent is not bound to the active execution authority', binding.failure),
      )
    }
    return transmit(intent)
  }

  return {
    submit,
    cancel: dependencies.brokerMutation.cancel,
    ...(dependencies.brokerMutation.orderById === undefined
      ? {}
      : { orderById: dependencies.brokerMutation.orderById }),
    ...(dependencies.brokerMutation.orderByClientId === undefined
      ? {}
      : { orderByClientId: dependencies.brokerMutation.orderByClientId }),
  }
}

export const makeAuthorityGuardedBrokerMutation = Pipeable.dual(2, makeAuthorityGuardedBrokerMutationDataFirst)
