import { Effect, Result } from 'effect'

import {
  AccountStatus,
  OrderCollection,
  OrderSide as BrokerOrderSide,
  type Account,
  type BrokerReadShape,
  type Order,
  type Position,
} from '../broker/alpaca'
import { MutationOperation, invalidRequest, type BrokerMutationShape } from '../broker/alpaca-mutations'
import type { LiveCapitalGrantStoreShape } from '../db/live-capital-grant'
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

type LiveMutationExecutionAuthority = Extract<
  ExecutionAuthority,
  { readonly brokerIdentity: { readonly environment: BrokerEnvironment.Live } }
>

const isLiveMutationExecutionAuthority = (
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

export interface LiveCapitalSnapshot {
  readonly account: Account
  readonly positions: readonly Position[]
  readonly openOrders: readonly Order[]
}

export interface MutationAuthorityDependencies {
  readonly brokerRead: BrokerReadShape
  readonly brokerMutation: BrokerMutationShape
  readonly liveCapitalGrants: Pick<LiveCapitalGrantStoreShape, 'read'>
  readonly currentUtcInstant: Effect.Effect<string>
}

const absolute = (value: bigint): bigint => (value < 0n ? -value : value)

const expectedAuthorityGeneration = (authority: MutationExecutionAuthority): string =>
  authority.capitalAuthority._tag === CapitalAuthorityKind.Sandbox
    ? authority.capitalAuthority.authorityGenerationHash
    : authority.capitalAuthority.grant.authorityGenerationHash

export const validateIntentAuthorityBinding = (
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

const signedIntentNotional = (intent: Intent): bigint => {
  const notional = BigInt(intent.notionalLimitMicros)
  return intent.side === IntentOrderSide.Buy ? notional : -notional
}

const signedOrderNotional = (
  order: Order,
): Result.Result<bigint, Extract<LiveCapitalLimitFailure, { readonly _tag: 'OpenOrderNotionalUnavailable' }>> => {
  if (order.notionalMicros !== undefined) {
    const notional = absolute(BigInt(order.notionalMicros))
    return Result.succeed(order.side === BrokerOrderSide.Buy ? notional : -notional)
  }
  if (order.quantityMicros === undefined) {
    return Result.fail({
      _tag: 'OpenOrderNotionalUnavailable',
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
  const conservativePrice = prices.reduce((maximum, price) => (price > maximum ? price : maximum), 0n)
  const numerator = absolute(BigInt(order.quantityMicros)) * conservativePrice
  const notional = (numerator + 999_999n) / 1_000_000n
  return Result.succeed(order.side === BrokerOrderSide.Buy ? notional : -notional)
}

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

export const validateLiveCapitalLimits = (
  authority: LiveMutationExecutionAuthority,
  intent: Intent,
  snapshot: LiveCapitalSnapshot,
): Result.Result<void, LiveCapitalLimitFailure> => {
  const binding = validateIntentAuthorityBinding(authority, intent)
  if (Result.isFailure(binding)) return Result.fail(binding.failure)
  const snapshotBinding = validateSnapshotBindings(authority, snapshot)
  if (Result.isFailure(snapshotBinding)) return Result.fail(snapshotBinding.failure)

  const limits = authority.capitalAuthority.grant.limits
  const proposedNotional = absolute(BigInt(intent.notionalLimitMicros))
  if (proposedNotional > BigInt(limits.maxOrderNotionalMicros)) {
    return Result.fail({
      _tag: 'LiveOrderNotionalLimitExceeded',
      limitMicros: limits.maxOrderNotionalMicros,
      proposedMicros: proposedNotional.toString(),
    })
  }
  if (snapshot.openOrders.length >= limits.maxOpenOrders) {
    return Result.fail({
      _tag: 'LiveOpenOrderLimitExceeded',
      limit: limits.maxOpenOrders,
      observed: snapshot.openOrders.length,
    })
  }

  const pendingBySymbol = new Map<string, bigint>()
  let pendingGross = 0n
  for (const order of snapshot.openOrders) {
    const notional = signedOrderNotional(order)
    if (Result.isFailure(notional)) return Result.fail(notional.failure)
    pendingBySymbol.set(order.symbol, (pendingBySymbol.get(order.symbol) ?? 0n) + notional.success)
    pendingGross += absolute(notional.success)
  }

  let currentGross = 0n
  let currentSymbol = 0n
  for (const position of snapshot.positions) {
    const marketValue = BigInt(position.marketValueMicros)
    currentGross += absolute(marketValue)
    if (position.symbol === intent.symbol) currentSymbol += marketValue
  }
  const projectedSymbol = currentSymbol + (pendingBySymbol.get(intent.symbol) ?? 0n) + signedIntentNotional(intent)
  if (absolute(projectedSymbol) > BigInt(limits.maxPositionNotionalMicros)) {
    return Result.fail({
      _tag: 'LivePositionNotionalLimitExceeded',
      symbol: intent.symbol,
      limitMicros: limits.maxPositionNotionalMicros,
      projectedMicros: absolute(projectedSymbol).toString(),
    })
  }

  const projectedGross = currentGross + pendingGross + proposedNotional
  if (projectedGross > BigInt(limits.maxGrossNotionalMicros)) {
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

const mutationAuthorizationError = (message: string, cause: unknown) =>
  invalidRequest(MutationOperation.Submit, message, cause)

type LiveGrantRefreshFailure =
  | ExecutionAuthorityConstructionFailure
  | {
      readonly _tag: 'LiveGrantHashMismatch'
      readonly expected: string
      readonly observed: string
    }
  | {
      readonly _tag: 'FreshAuthorityCapabilityMismatch'
    }

const freshLiveAuthority = (
  captured: LiveMutationExecutionAuthority,
  persisted: LiveCapitalAuthority,
  observedAt: string,
): Result.Result<LiveMutationExecutionAuthority, LiveGrantRefreshFailure> => {
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

export const makeAuthorityGuardedBrokerMutation = (
  authority: MutationExecutionAuthority,
  dependencies: MutationAuthorityDependencies,
): BrokerMutationShape => {
  const submit = (intent: Intent) => {
    const binding = validateIntentAuthorityBinding(authority, intent)
    if (Result.isFailure(binding)) {
      return Effect.fail(
        mutationAuthorizationError('intent is not bound to the active execution authority', binding.failure),
      )
    }
    if (!isLiveMutationExecutionAuthority(authority)) {
      return dependencies.brokerMutation.submit(intent)
    }
    const liveAuthority = authority

    return Effect.gen(function* () {
      const snapshot = yield* Effect.all({
        account: dependencies.brokerRead.account,
        positions: dependencies.brokerRead.positions,
        openOrders: dependencies.brokerRead.orders({
          status: OrderCollection.Open,
          limit: liveAuthority.capitalAuthority.grant.limits.maxOpenOrders,
        }),
      }).pipe(
        Effect.mapError((cause) =>
          mutationAuthorizationError('live broker exposure snapshot could not be refreshed', cause),
        ),
      )
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
      const fresh = freshLiveAuthority(liveAuthority, persisted, observedAt)
      if (Result.isFailure(fresh)) {
        return yield* Effect.fail(
          mutationAuthorizationError('live capital grant is no longer valid before submit', fresh.failure),
        )
      }
      const limits = validateLiveCapitalLimits(fresh.success, intent, {
        account: snapshot.account.value,
        positions: snapshot.positions.value,
        openOrders: snapshot.openOrders.value,
      })
      if (Result.isFailure(limits)) {
        return yield* Effect.fail(
          mutationAuthorizationError('live capital limit rejected the broker submit', limits.failure),
        )
      }
      return yield* dependencies.brokerMutation.submit(intent)
    })
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
