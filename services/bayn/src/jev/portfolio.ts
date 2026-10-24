import { JevPositionExitPolicySchema } from './exit-policy'
import { Context, Effect, Result, Schema } from 'effect'

import type { OperationalError } from '../errors'
import type { ReconciledBrokerState } from '../simulation-reconciliation/broker-model'

import {
  AccountSnapshotSchema,
  UnsignedMicrosSchema,
  FillSchema,
  OrderSchema,
  OrderSide,
  OrderStatus,
  PositionSchema,
  ReconciliationSchema,
  ReconciliationStatus,
} from '../execution/contracts'
import { reconciledStateHash } from '../simulation-reconciliation/broker-model'
import { Sha256Schema, UtcInstantSchema, strictParseOptions } from '../schemas'
import { JevContractError } from './contract'
import type { JevFundedExitPlan } from './strategy-exit-plan'

export enum JevPurpose {
  Entry = 'ENTRY',
  Manage = 'MANAGE',
}

const ReconciledStateSchema = Schema.Struct({
  account: AccountSnapshotSchema,
  positions: Schema.Array(PositionSchema),
  positionsObservedAt: UtcInstantSchema,
  orders: Schema.Array(OrderSchema),
  ordersObservedAt: UtcInstantSchema,
  accountingHash: Sha256Schema,
  reconciliation: ReconciliationSchema,
  unknownOrderCount: Schema.Literal(0),
})

export const JevInventoryDebitSchema = Schema.Struct({
  quantityAtoms: UnsignedMicrosSchema,
  costBasisMicros: UnsignedMicrosSchema,
})

const Base = Schema.Union([
  Schema.Struct({ purpose: Schema.Literal(JevPurpose.Entry), brokerState: ReconciledStateSchema }),
  Schema.Struct({
    purpose: Schema.Literal(JevPurpose.Manage),
    brokerState: ReconciledStateSchema,
    entryDecisionHash: Sha256Schema,
    exitPolicy: JevPositionExitPolicySchema,
    protectionIntentIds: Schema.Array(Sha256Schema).check(Schema.isUnique()),
    exitRequestedAt: Schema.NullOr(UtcInstantSchema),
    profitExitRequested: Schema.Boolean,
    entryIntentIds: Schema.Array(Sha256Schema).check(Schema.isMinLength(1), Schema.isUnique()),
    entryFills: Schema.Array(FillSchema).check(Schema.isMinLength(1)),
    entryInventoryDebit: JevInventoryDebitSchema,
    protectionDisposals: JevInventoryDebitSchema,
  }),
])

export const JevPortfolioSchema = Base.check(
  Schema.makeFilter((context) => {
    const issues: Schema.FilterIssue[] = []
    const state = context.brokerState
    const hash = reconciledStateHash(state)
    if (
      state.reconciliation.status !== ReconciliationStatus.Exact ||
      Result.isFailure(hash) ||
      hash.success !== state.reconciliation.expectedHash ||
      state.reconciliation.accountId !== state.account.accountId
    )
      issues.push({ path: ['brokerState'], issue: 'requires an exact reconciliation of these broker-state bytes' })
    if (
      state.orders.some(
        (order) =>
          ![OrderStatus.Filled, OrderStatus.Canceled, OrderStatus.Expired, OrderStatus.Rejected].includes(
            order.status,
          ) &&
          !(
            context.purpose === JevPurpose.Manage &&
            order.side === OrderSide.Sell &&
            order.intentId !== undefined &&
            context.protectionIntentIds.includes(order.intentId) &&
            (order.limitPriceMicros === context.exitPolicy.plans[order.symbol]?.levels.profitLimitPriceMicros ||
              (order.stopPriceMicros === context.exitPolicy.plans[order.symbol]?.levels.stopPriceMicros &&
                order.limitPriceMicros === context.exitPolicy.plans[order.symbol]?.levels.stopLimitPriceMicros))
          ),
      )
    )
      issues.push({ path: ['brokerState', 'orders'], issue: 'unsettled orders prevent a new model decision' })
    if (
      [state.account.observedAt, state.positionsObservedAt, state.ordersObservedAt].some(
        (at) => at > state.reconciliation.reconciledAt,
      ) ||
      state.positions.some(
        (position) => position.accountId !== state.account.accountId || position.observedAt > state.positionsObservedAt,
      ) ||
      state.orders.some(
        (order) => order.accountId !== state.account.accountId || order.observedAt > state.ordersObservedAt,
      ) ||
      new Set(state.positions.map((position) => position.symbol)).size !== state.positions.length ||
      new Set(state.orders.map((order) => order.brokerOrderId)).size !== state.orders.length
    )
      issues.push({
        path: ['brokerState'],
        issue: 'reconciliation requires unique account-bound positions and orders observed before their snapshot',
      })
    const held = state.positions.filter((position) => BigInt(position.quantityAtoms) !== 0n)
    if (context.purpose === JevPurpose.Entry) {
      if (held.length !== 0) issues.push({ path: ['purpose'], issue: 'entry requires a reconciled flat account' })
      return issues
    }
    const position = held[0]
    if (
      held.length !== 1 ||
      position === undefined ||
      BigInt(position.quantityAtoms) <= 0n ||
      BigInt(position.costBasisMicros) <= 0n
    ) {
      issues.push({
        path: ['brokerState', 'positions'],
        issue: 'management requires one reconciled long with cost basis',
      })
      return issues
    }
    const fills = context.entryFills
    if (context.profitExitRequested && context.exitRequestedAt === null)
      issues.push({ path: ['profitExitRequested'], issue: 'requires a durable protection cancellation request' })
    const plan = context.exitPolicy.plans[position.symbol]
    if (
      plan === undefined ||
      Object.keys(context.exitPolicy.plans).length !== 1 ||
      plan.levels.symbol !== position.symbol ||
      fills.some(
        (fill) =>
          fill.occurredAt < plan.levels.sourceEndAt ||
          BigInt(fill.priceAtoms) > BigInt(plan.levels.maximumEntryPriceMicros) * 1000n,
      ) ||
      fills.reduce((sum, fill) => sum + BigInt(fill.quantityAtoms), 0n) > BigInt(plan.maximumQuantityAtoms)
    )
      issues.push({ path: ['exitPolicy'], issue: 'actual entry fills must remain within the immutable pre-entry plan' })
    const fillIds = new Set(fills.map((fill) => fill.fillId))
    if (
      fillIds.size !== fills.length ||
      fills.some(
        (fill, index) =>
          fill.accountId !== state.account.accountId ||
          fill.symbol !== position.symbol ||
          fill.side !== OrderSide.Buy ||
          fill.intentId === undefined ||
          !context.entryIntentIds.includes(fill.intentId) ||
          fill.occurredAt > state.positionsObservedAt ||
          (index > 0 &&
            `${fills[index - 1]?.occurredAt}|${fills[index - 1]?.fillId}` >= `${fill.occurredAt}|${fill.fillId}`) ||
          !state.orders.some(
            (order) =>
              order.intentId === fill.intentId &&
              order.brokerOrderId === fill.brokerOrderId &&
              order.clientOrderId === fill.clientOrderId &&
              order.symbol === fill.symbol &&
              order.side === fill.side,
          ),
      ) ||
      fills.reduce((sum, fill) => sum + BigInt(fill.quantityAtoms), 0n) -
        BigInt(context.entryInventoryDebit.quantityAtoms) -
        BigInt(context.protectionDisposals.quantityAtoms) !==
        BigInt(position.quantityAtoms)
    )
      issues.push({
        path: ['entryFills'],
        issue:
          'complete canonical entry fills minus posted inventory debits must explain the held quantity and match reconciled orders',
      })
    for (const order of state.orders.filter(
      (order) =>
        order.side === OrderSide.Buy && order.intentId !== undefined && context.entryIntentIds.includes(order.intentId),
    )) {
      const filled = fills
        .filter((fill) => fill.brokerOrderId === order.brokerOrderId)
        .reduce((sum, fill) => sum + BigInt(fill.quantityAtoms), 0n)
      if (filled !== BigInt(order.filledQuantityAtoms))
        issues.push({ path: ['entryFills'], issue: 'fill quantities must equal the reconciled entry orders' })
    }
    return issues
  }),
)

export type JevPortfolio = typeof JevPortfolioSchema.Type
export type JevManagedPortfolio = Extract<JevPortfolio, { readonly purpose: JevPurpose.Manage }>

export const jevManagedExitPlan = (
  portfolio: JevManagedPortfolio,
): Result.Result<JevFundedExitPlan, JevContractError> => {
  const position = portfolio.brokerState.positions.find(({ quantityAtoms }) => BigInt(quantityAtoms) > 0n)
  const plan = position === undefined ? undefined : portfolio.exitPolicy.plans[position.symbol]
  return plan === undefined
    ? Result.fail(new JevContractError({ message: 'Held position has no immutable strategy exit plan' }))
    : Result.succeed(plan)
}

export interface JevPositionStoreShape {
  readonly read: (input: {
    readonly cycleId: string
    readonly entryDecisionHash: string
    readonly brokerState: ReconciledBrokerState
  }) => Effect.Effect<JevManagedPortfolio, OperationalError>
}

export class JevPositionStore extends Context.Service<JevPositionStore, JevPositionStoreShape>()(
  '@proompteng/bayn/jev/PositionStore',
) {}

export const decodeJevPortfolio = (input: unknown) =>
  Schema.decodeUnknownResult(
    JevPortfolioSchema,
    strictParseOptions,
  )(input).pipe(Result.mapError((cause) => new JevContractError({ message: 'Jev position context is invalid', cause })))

export const jevPortfolioCandidates = (portfolio: JevPortfolio, candidates: readonly string[]): readonly string[] =>
  portfolio.purpose === JevPurpose.Entry
    ? candidates
    : portfolio.brokerState.positions
        .filter((position) => BigInt(position.quantityAtoms) > 0n)
        .map((position) => position.symbol)
        .sort()
