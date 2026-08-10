import { Effect, Result, Semaphore } from 'effect'

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
  orderPriceBoundaryMicros,
  type BrokerMutationShape,
} from '../broker/alpaca-mutations'
import type { LiveCapitalGrantStoreShape } from '../db/live-capital-grant'
import type { OperationalError } from '../errors'
import { canonicalHashV1Result } from '../hash'
import { OrderSide as IntentOrderSide, type Intent } from '../paper'
import {
  BrokerAccess,
  BrokerEnvironment,
  CapitalAuthorityKind,
  makeExecutionAuthority,
  type ExecutionAuthority,
  type ExecutionAuthorityConstructionFailure,
  type LiveCapitalAuthority,
  type MutationExecutionAuthority,
} from './authority'
import { Pipeable } from '../pipeable'

export type LiveMutationExecutionAuthority = Extract<
  ExecutionAuthority,
  { readonly brokerIdentity: { readonly environment: BrokerEnvironment.Live } }
>

export const isLiveMutationExecutionAuthority = (
  authority: MutationExecutionAuthority | ExecutionAuthority,
): authority is LiveMutationExecutionAuthority =>
  authority.brokerAccess === BrokerAccess.Mutation &&
  authority.brokerIdentity.environment === BrokerEnvironment.Live &&
  authority.capitalAuthority._tag === CapitalAuthorityKind.LiveGrant

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

export type LiveCapitalLimitFailure =
  | IntentAuthorityBindingFailure
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
      readonly _tag: 'LiveOrderNotionalLimitExceeded'
      readonly limitMicros: string
      readonly proposedMicros: string
    }
  | {
      readonly _tag: 'LivePositionNotionalLimitExceeded'
      readonly symbol: string
      readonly limitMicros: string
      readonly projectedMicros: string
    }
  | {
      readonly _tag: 'LiveGrossNotionalLimitExceeded'
      readonly limitMicros: string
      readonly projectedMicros: string
    }
  | {
      readonly _tag: 'LiveDailyLossLimitExceeded'
      readonly limitMicros: string
      readonly observedMicros: string
    }
  | {
      readonly _tag: 'LiveOpenOrderLimitExceeded'
      readonly limit: number
      readonly observed: number
    }
  | {
      readonly _tag: 'LiveBrokerPositionSnapshotChanged'
      readonly beforeHash: string
      readonly afterHash: string
    }
  | {
      readonly _tag: 'LiveBrokerPositionSnapshotInvalid'
      readonly cause: unknown
    }
  | {
      readonly _tag: 'FreshBrokerPriceInvalid'
      readonly symbol: string
      readonly priceMicros: string
      readonly quotedAt: string
      readonly observedAt: string
    }
  | {
      readonly _tag: 'FreshBrokerPriceStale'
      readonly symbol: string
      readonly quotedAt: string
      readonly observedAt: string
      readonly maximumAgeMs: number
    }
  | {
      readonly _tag: 'FreshBrokerPriceGap'
      readonly symbol: string
      readonly side: IntentOrderSide
      readonly boundaryMicros: string
      readonly observedMicros: string
    }
  | {
      readonly _tag: 'LiveIncreasingSellUnsupported'
      readonly symbol: string
      readonly currentQuantityMicros: string
      readonly projectedQuantityMicros: string
    }
  | {
      readonly _tag: 'LivePendingSellUncovered'
      readonly symbol: string
      readonly currentQuantityMicros: string
      readonly pendingSellQuantityMicros: string
    }
  | {
      readonly _tag: 'BoundedBrokerOrderInvalid'
      readonly symbol: string
    }

export interface LiveCapitalSnapshot {
  readonly account: Account
  readonly positions: readonly Position[]
  readonly openOrders: readonly Order[]
}

export interface FreshBrokerQuote {
  readonly symbol: string
  readonly bidPriceMicros: string
  readonly askPriceMicros: string
  readonly quotedAt: string
  readonly observedAt: string
}

export interface FinalSubmitAuthorizationFailure {
  readonly _tag: string
}

export interface FinalSubmitAuthorization {
  <A, E, R>(intent: Intent, transmit: Effect.Effect<A, E, R>): Effect.Effect<A, E | FinalSubmitAuthorizationFailure, R>
}

export interface MutationAuthorityDependencies {
  readonly brokerRead: BrokerReadShape
  readonly brokerMutation: BrokerMutationShape
  readonly liveCapitalGrants: Pick<LiveCapitalGrantStoreShape, 'read'>
  readonly freshBrokerPrice: (symbol: string) => Effect.Effect<FreshBrokerQuote, OperationalError>
  readonly currentUtcInstant: Effect.Effect<string>
  readonly finalSubmitAuthorization: FinalSubmitAuthorization
}

export interface LiveBrokerSubmitSnapshot extends LiveCapitalSnapshot {
  readonly quotes: ReadonlyMap<string, FreshBrokerQuote>
}

export type LiveBrokerSubmitRefreshDependencies = Pick<MutationAuthorityDependencies, 'brokerRead' | 'freshBrokerPrice'>

const absolute = (value: bigint): bigint => (value < 0n ? -value : value)
const freshBrokerPriceMaximumAgeMs = 5_000
const microsPerUnit = 1_000_000n

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

const validateStableLivePositionSnapshotDataFirst = (
  before: readonly Position[],
  after: readonly Position[],
): Result.Result<readonly Position[], LiveCapitalLimitFailure> => {
  const beforeHash = canonicalHashV1Result(positionExposureIdentity(before))
  if (Result.isFailure(beforeHash)) {
    return Result.fail({ _tag: 'LiveBrokerPositionSnapshotInvalid', cause: beforeHash.failure })
  }
  const afterHash = canonicalHashV1Result(positionExposureIdentity(after))
  if (Result.isFailure(afterHash)) {
    return Result.fail({ _tag: 'LiveBrokerPositionSnapshotInvalid', cause: afterHash.failure })
  }
  return beforeHash.success === afterHash.success
    ? Result.succeed(after)
    : Result.fail({
        _tag: 'LiveBrokerPositionSnapshotChanged',
        beforeHash: beforeHash.success,
        afterHash: afterHash.success,
      })
}

export const validateStableLivePositionSnapshot = Pipeable.dual(2, validateStableLivePositionSnapshotDataFirst)

const expectedAuthorityGeneration = (authority: MutationExecutionAuthority): string =>
  authority.capitalAuthority._tag === CapitalAuthorityKind.Sandbox
    ? authority.capitalAuthority.authorityGenerationHash
    : authority.capitalAuthority.grant.authorityGenerationHash

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

const freshSidePrice = (
  symbol: string,
  side: IntentOrderSide | BrokerOrderSide,
  quote: FreshBrokerQuote,
  observedAt: string,
): Result.Result<bigint, LiveCapitalLimitFailure> => {
  const priceText =
    side === IntentOrderSide.Buy || side === BrokerOrderSide.Buy ? quote.askPriceMicros : quote.bidPriceMicros
  const priceMicros = parseCanonicalPositiveMicros(priceText)
  const quotedAtMs = Date.parse(quote.quotedAt)
  const priceObservedAtMs = Date.parse(quote.observedAt)
  const observedAtMs = Date.parse(observedAt)
  if (
    quote.symbol !== symbol ||
    priceMicros === undefined ||
    !Number.isFinite(quotedAtMs) ||
    !Number.isFinite(priceObservedAtMs) ||
    !Number.isFinite(observedAtMs) ||
    quotedAtMs > priceObservedAtMs ||
    priceObservedAtMs > observedAtMs
  ) {
    return Result.fail({
      _tag: 'FreshBrokerPriceInvalid',
      symbol: quote.symbol,
      priceMicros: priceText,
      quotedAt: quote.quotedAt,
      observedAt: quote.observedAt,
    })
  }
  if (observedAtMs - quotedAtMs > freshBrokerPriceMaximumAgeMs) {
    return Result.fail({
      _tag: 'FreshBrokerPriceStale',
      symbol: quote.symbol,
      quotedAt: quote.quotedAt,
      observedAt,
      maximumAgeMs: freshBrokerPriceMaximumAgeMs,
    })
  }
  return Result.succeed(priceMicros)
}

export const boundedBrokerOrderNotional = (intent: Intent): Result.Result<bigint, LiveCapitalLimitFailure> => {
  const quantityMicros = parseCanonicalPositiveMicros(intent.quantityMicros)
  const priceBoundary = orderPriceBoundaryMicros(intent)
  if (quantityMicros === undefined || Result.isFailure(priceBoundary)) {
    return Result.fail({
      _tag: 'BoundedBrokerOrderInvalid',
      symbol: intent.symbol,
    })
  }
  return Result.succeed((quantityMicros * priceBoundary.success + microsPerUnit - 1n) / microsPerUnit)
}

const liveOrderCapNotionalDataFirst = (
  intent: Intent,
  quote: FreshBrokerQuote,
  observedAt: string,
): Result.Result<bigint, LiveCapitalLimitFailure> => {
  if (intent.side === IntentOrderSide.Buy) return boundedBrokerOrderNotional(intent)
  const quantityMicros = parseCanonicalPositiveMicros(intent.quantityMicros)
  const freshBid = freshSidePrice(intent.symbol, intent.side, quote, observedAt)
  if (quantityMicros === undefined || Result.isFailure(freshBid)) {
    return Result.isFailure(freshBid)
      ? Result.fail(freshBid.failure)
      : Result.fail({
          _tag: 'BoundedBrokerOrderInvalid',
          symbol: intent.symbol,
        })
  }
  return Result.succeed((quantityMicros * freshBid.success + microsPerUnit - 1n) / microsPerUnit)
}

export const liveOrderCapNotional = Pipeable.dual(3, liveOrderCapNotionalDataFirst)

const validateBrokerPriceBoundaryDataFirst = (
  intent: Intent,
  quote: FreshBrokerQuote,
  observedAt: string,
): Result.Result<void, LiveCapitalLimitFailure> => {
  const observedPrice = freshSidePrice(intent.symbol, intent.side, quote, observedAt)
  if (Result.isFailure(observedPrice)) return Result.fail(observedPrice.failure)
  const boundary = orderPriceBoundaryMicros(intent)
  if (Result.isFailure(boundary)) {
    return Result.fail({
      _tag: 'BoundedBrokerOrderInvalid',
      symbol: intent.symbol,
    })
  }
  const marketable =
    intent.side === IntentOrderSide.Buy
      ? observedPrice.success <= boundary.success
      : observedPrice.success >= boundary.success
  return marketable
    ? Result.succeed(undefined)
    : Result.fail({
        _tag: 'FreshBrokerPriceGap',
        symbol: intent.symbol,
        side: intent.side,
        boundaryMicros: boundary.success.toString(),
        observedMicros: observedPrice.success.toString(),
      })
}

export const validateBrokerPriceBoundary = Pipeable.dual(3, validateBrokerPriceBoundaryDataFirst)

const orderHasUnboundedExecutionPrice = (order: Order): boolean =>
  order.notionalMicros === undefined &&
  order.quantityMicros !== undefined &&
  order.limitPriceMicros === undefined &&
  (order.orderType === BrokerOrderType.Stop || order.orderType === BrokerOrderType.TrailingStop)

const quoteSymbolsForLiveExposureDataFirst = (intent: Intent, _openOrders: readonly Order[]): readonly string[] => [
  intent.symbol,
]

export const quoteSymbolsForLiveExposure = Pipeable.dual(2, quoteSymbolsForLiveExposureDataFirst)

const signedOrderNotional = (order: Order): Result.Result<bigint, LiveCapitalLimitFailure> => {
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
  Extract<LiveCapitalLimitFailure, { readonly _tag: 'OpenOrderQuantityUnavailable' | 'OpenOrderQuantityInvalid' }>
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
): Result.Result<ReadonlyMap<string, bigint>, LiveCapitalLimitFailure> => {
  const notionals = new Map<string, bigint>()
  for (const order of openOrders) {
    const notional = signedOrderNotional(order)
    if (Result.isFailure(notional)) return Result.fail(notional.failure)
    notionals.set(order.brokerOrderId, notional.success)
  }
  return Result.succeed(notionals)
}

const minimumSymbolQuantityAfterPendingSells = (
  intent: Intent,
  snapshot: LiveCapitalSnapshot,
): Result.Result<
  { readonly beforeIntentMicros: bigint; readonly afterIntentMicros: bigint },
  Extract<LiveCapitalLimitFailure, { readonly _tag: 'OpenOrderQuantityUnavailable' | 'OpenOrderQuantityInvalid' }>
> => {
  let beforeIntentMicros = snapshot.positions
    .filter((position) => position.symbol === intent.symbol)
    .reduce((total, position) => total + BigInt(position.quantityMicros), 0n)
  for (const order of snapshot.openOrders.filter(
    (candidate) => candidate.symbol === intent.symbol && candidate.side === BrokerOrderSide.Sell,
  )) {
    const remaining = unfilledOrderQuantity(order)
    if (Result.isFailure(remaining)) return Result.fail(remaining.failure)
    if (remaining.success === undefined) {
      return Result.fail({
        _tag: 'OpenOrderQuantityUnavailable',
        brokerOrderId: order.brokerOrderId,
        symbol: order.symbol,
      })
    }

    beforeIntentMicros -= remaining.success
  }
  const intentQuantity = BigInt(intent.quantityMicros)
  return Result.succeed({
    beforeIntentMicros,
    afterIntentMicros: beforeIntentMicros + (intent.side === IntentOrderSide.Buy ? intentQuantity : -intentQuantity),
  })
}

export const validatePendingSellCoverage = (
  snapshot: LiveCapitalSnapshot,
): Result.Result<
  void,
  Extract<
    LiveCapitalLimitFailure,
    | { readonly _tag: 'OpenOrderQuantityUnavailable' }
    | { readonly _tag: 'OpenOrderQuantityInvalid' }
    | { readonly _tag: 'LivePendingSellUncovered' }
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
        _tag: 'LivePendingSellUncovered',
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
  authority: LiveMutationExecutionAuthority,
  snapshot: LiveCapitalSnapshot,
): Result.Result<void, LiveCapitalLimitFailure> => {
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

const validateLiveCapitalLimitsDataFirst = (
  authority: LiveMutationExecutionAuthority,
  intent: Intent,
  snapshot: LiveCapitalSnapshot,
  proposedExposureNotional: bigint,
  proposedOrderNotional: bigint,
  openOrderNotionals: ReadonlyMap<string, bigint>,
): Result.Result<void, LiveCapitalLimitFailure> => {
  const binding = validateIntentAuthorityBinding(authority, intent)
  if (Result.isFailure(binding)) return Result.fail(binding.failure)
  const snapshotBinding = validateSnapshotBindings(authority, snapshot)
  if (Result.isFailure(snapshotBinding)) return Result.fail(snapshotBinding.failure)
  const pendingSellCoverage = validatePendingSellCoverage(snapshot)
  if (Result.isFailure(pendingSellCoverage)) return Result.fail(pendingSellCoverage.failure)

  const limits = authority.capitalAuthority.grant.limits
  const orderLimit = BigInt(limits.maxOrderNotionalMicros)
  if (snapshot.openOrders.length >= limits.maxOpenOrders) {
    return Result.fail({
      _tag: 'LiveOpenOrderLimitExceeded',
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
  const projectedQuantity = minimumSymbolQuantityAfterPendingSells(intent, snapshot)
  if (Result.isFailure(projectedQuantity)) return Result.fail(projectedQuantity.failure)

  if (proposedOrderNotional > orderLimit) {
    return Result.fail({
      _tag: 'LiveOrderNotionalLimitExceeded',
      limitMicros: limits.maxOrderNotionalMicros,
      proposedMicros: proposedOrderNotional.toString(),
    })
  }
  if (intent.side === IntentOrderSide.Sell && projectedQuantity.success.afterIntentMicros < 0n) {
    return Result.fail({
      _tag: 'LiveIncreasingSellUnsupported',
      symbol: intent.symbol,
      currentQuantityMicros: projectedQuantity.success.beforeIntentMicros.toString(),
      projectedQuantityMicros: projectedQuantity.success.afterIntentMicros.toString(),
    })
  }

  if (projectedSymbol > BigInt(limits.maxPositionNotionalMicros) && projectedSymbol >= currentSymbol) {
    return Result.fail({
      _tag: 'LivePositionNotionalLimitExceeded',
      symbol: intent.symbol,
      limitMicros: limits.maxPositionNotionalMicros,
      projectedMicros: projectedSymbol.toString(),
    })
  }

  if (projectedGross > BigInt(limits.maxGrossNotionalMicros) && projectedGross >= currentGross) {
    return Result.fail({
      _tag: 'LiveGrossNotionalLimitExceeded',
      limitMicros: limits.maxGrossNotionalMicros,
      projectedMicros: projectedGross.toString(),
    })
  }

  const dailyLoss = BigInt(snapshot.account.lastEquityMicros) - BigInt(snapshot.account.equityMicros)
  const observedLoss = dailyLoss > 0n ? dailyLoss : 0n
  if (observedLoss > BigInt(limits.maxDailyLossMicros)) {
    return Result.fail({
      _tag: 'LiveDailyLossLimitExceeded',
      limitMicros: limits.maxDailyLossMicros,
      observedMicros: observedLoss.toString(),
    })
  }
  return Result.succeed(undefined)
}

export const validateLiveCapitalLimits = Pipeable.dual(6, validateLiveCapitalLimitsDataFirst)

const mutationAuthorizationError = (message: string, cause: unknown) =>
  invalidRequest({ operation: MutationOperation.Submit, message, cause })

const refreshLiveBrokerSubmitSnapshotDataFirst = (
  authority: LiveMutationExecutionAuthority,
  intent: Intent,
  dependencies: LiveBrokerSubmitRefreshDependencies,
): Effect.Effect<LiveBrokerSubmitSnapshot, BrokerMutationError> =>
  Effect.gen(function* () {
    const account = yield* dependencies.brokerRead.account.pipe(
      Effect.mapError((cause) =>
        mutationAuthorizationError('live broker account could not be refreshed before submit', cause),
      ),
    )
    const positionsBefore = yield* dependencies.brokerRead.positions.pipe(
      Effect.mapError((cause) =>
        mutationAuthorizationError('live broker positions could not be refreshed before submit', cause),
      ),
    )
    const openOrders = yield* dependencies.brokerRead
      .orders({
        status: OrderCollection.Open,
        limit: authority.capitalAuthority.grant.limits.maxOpenOrders,
      })
      .pipe(
        Effect.mapError((cause) =>
          mutationAuthorizationError('live broker open orders could not be refreshed before submit', cause),
        ),
      )
    const positionsAfter = yield* dependencies.brokerRead.positions.pipe(
      Effect.mapError((cause) =>
        mutationAuthorizationError('live broker positions could not be confirmed after open-order refresh', cause),
      ),
    )
    const stablePositions = validateStableLivePositionSnapshot(positionsBefore.value, positionsAfter.value)
    if (Result.isFailure(stablePositions)) {
      return yield* mutationAuthorizationError(
        'live broker position snapshot changed during exposure refresh',
        stablePositions.failure,
      )
    }
    const quoteSymbols = quoteSymbolsForLiveExposure(intent, openOrders.value)
    const quoteEntries = yield* Effect.forEach(quoteSymbols, (symbol) =>
      dependencies.freshBrokerPrice(symbol).pipe(
        Effect.map((quote) => [symbol, quote] as const),
        Effect.mapError((cause) =>
          mutationAuthorizationError('fresh broker price could not be refreshed before submit', cause),
        ),
      ),
    )
    return {
      account: account.value,
      positions: stablePositions.success,
      openOrders: openOrders.value,
      quotes: new Map(quoteEntries),
    }
  })

export const refreshLiveBrokerSubmitSnapshot = Pipeable.dual(3, refreshLiveBrokerSubmitSnapshotDataFirst)

export type LiveGrantRefreshFailure =
  | ExecutionAuthorityConstructionFailure
  | {
      readonly _tag: 'LiveGrantHashMismatch'
      readonly expected: string
      readonly observed: string
    }
  | {
      readonly _tag: 'FreshAuthorityCapabilityMismatch'
    }

const validateLiveGrantForSubmitDataFirst = (
  captured: MutationExecutionAuthority,
  persisted: LiveCapitalAuthority,
  observedAt: string,
): Result.Result<LiveMutationExecutionAuthority, LiveGrantRefreshFailure> => {
  if (!isLiveMutationExecutionAuthority(captured)) {
    return Result.fail({ _tag: 'FreshAuthorityCapabilityMismatch' })
  }
  if (persisted.grant.grantHash !== captured.capitalAuthority.grant.grantHash) {
    return Result.fail({
      _tag: 'LiveGrantHashMismatch' as const,
      expected: captured.capitalAuthority.grant.grantHash,
      observed: persisted.grant.grantHash,
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
  return isLiveMutationExecutionAuthority(constructed.success)
    ? Result.succeed(constructed.success)
    : Result.fail({ _tag: 'FreshAuthorityCapabilityMismatch' })
}

export const validateLiveGrantForSubmit = Pipeable.dual(3, validateLiveGrantForSubmitDataFirst)

export type LiveBrokerSubmitValidationFailure =
  | LiveGrantRefreshFailure
  | LiveCapitalLimitFailure
  | {
      readonly _tag: 'FreshBrokerPriceMissing'
      readonly symbol: string
    }

const validateLiveBrokerSubmitSnapshotDataFirst = (
  captured: LiveMutationExecutionAuthority,
  persisted: LiveCapitalAuthority,
  intent: Intent,
  snapshot: LiveBrokerSubmitSnapshot,
  observedAt: string,
): Result.Result<void, LiveBrokerSubmitValidationFailure> => {
  const fresh = validateLiveGrantForSubmit(captured, persisted, observedAt)
  if (Result.isFailure(fresh)) return Result.fail(fresh.failure)
  const intentQuote = snapshot.quotes.get(intent.symbol)
  if (intentQuote === undefined) {
    return Result.fail({
      _tag: 'FreshBrokerPriceMissing',
      symbol: intent.symbol,
    })
  }
  const priceBoundary = validateBrokerPriceBoundary(intent, intentQuote, observedAt)
  if (Result.isFailure(priceBoundary)) return Result.fail(priceBoundary.failure)
  const requestedNotional = boundedBrokerOrderNotional(intent)
  if (Result.isFailure(requestedNotional)) return Result.fail(requestedNotional.failure)
  const orderCapNotional = liveOrderCapNotional(intent, intentQuote, observedAt)
  if (Result.isFailure(orderCapNotional)) return Result.fail(orderCapNotional.failure)
  const openOrderNotionals = priceOpenOrders(snapshot.openOrders)
  if (Result.isFailure(openOrderNotionals)) return Result.fail(openOrderNotionals.failure)
  return validateLiveCapitalLimits(
    fresh.success,
    intent,
    snapshot,
    requestedNotional.success,
    orderCapNotional.success,
    openOrderNotionals.success,
  )
}

export const validateLiveBrokerSubmitSnapshot = Pipeable.dual(5, validateLiveBrokerSubmitSnapshotDataFirst)

const makeAuthorityGuardedBrokerMutationDataFirst = (
  authority: MutationExecutionAuthority,
  dependencies: MutationAuthorityDependencies,
): BrokerMutationShape => {
  const liveSubmitPermit = Semaphore.makeUnsafe(1)
  const transmit = (intent: Intent) =>
    dependencies
      .finalSubmitAuthorization(intent, dependencies.brokerMutation.submit(intent))
      .pipe(
        Effect.mapError((cause) =>
          cause instanceof BrokerMutationError
            ? cause
            : mutationAuthorizationError('final submit authorization failed after broker preflight', cause),
        ),
      )
  const submit = (intent: Intent) => {
    const binding = validateIntentAuthorityBinding(authority, intent)
    if (Result.isFailure(binding)) {
      return Effect.fail(
        mutationAuthorizationError('intent is not bound to the active execution authority', binding.failure),
      )
    }
    if (!isLiveMutationExecutionAuthority(authority)) {
      return transmit(intent)
    }
    const liveAuthority = authority

    return liveSubmitPermit.withPermit(
      Effect.gen(function* () {
        const snapshot = yield* refreshLiveBrokerSubmitSnapshot(liveAuthority, intent, dependencies)
        const grantHash = liveAuthority.capitalAuthority.grant.grantHash
        const persisted = yield* dependencies.liveCapitalGrants.read(grantHash).pipe(
          Effect.mapError((cause) =>
            mutationAuthorizationError('live capital grant could not be refreshed before submit', cause),
          ),
          Effect.flatMap((grant) =>
            grant === undefined
              ? Effect.fail(
                  mutationAuthorizationError('live capital grant is missing before submit', {
                    _tag: 'LiveCapitalGrantMissing',
                    grantHash,
                  }),
                )
              : Effect.succeed(grant),
          ),
        )
        const observedAt = yield* dependencies.currentUtcInstant
        const validation = validateLiveBrokerSubmitSnapshot(liveAuthority, persisted, intent, snapshot, observedAt)
        if (Result.isFailure(validation)) {
          return yield* mutationAuthorizationError(
            'live broker submit preflight rejected the broker submit',
            validation.failure,
          )
        }
        return yield* transmit(intent)
      }),
    )
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
