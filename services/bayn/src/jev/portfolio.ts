import { Context, Effect, Result, Schema } from 'effect'

import type { OperationalError } from '../errors'
import type { ReconciledBrokerState } from '../reconciliation'

import {
  AccountSnapshotSchema,
  FillSchema,
  OrderSchema,
  OrderSide,
  OrderStatus,
  PositionSchema,
  ReconciliationSchema,
  ReconciliationStatus,
} from '../execution/contracts'
import { reconciledStateHash } from '../reconciliation'
import { Sha256Schema, UtcInstantSchema, strictParseOptions } from '../schemas'
import { JevContractError } from './contract'

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

const Base = Schema.Union([
  Schema.Struct({ purpose: Schema.Literal(JevPurpose.Entry), brokerState: ReconciledStateSchema }),
  Schema.Struct({
    purpose: Schema.Literal(JevPurpose.Manage),
    brokerState: ReconciledStateSchema,
    entryDecisionHash: Sha256Schema,
    entryIntentIds: Schema.Array(Sha256Schema).check(Schema.isMinLength(1), Schema.isUnique()),
    entryFills: Schema.Array(FillSchema).check(Schema.isMinLength(1)),
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
          ![OrderStatus.Filled, OrderStatus.Canceled, OrderStatus.Expired, OrderStatus.Rejected].includes(order.status),
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
    const held = state.positions.filter((position) => BigInt(position.quantityMicros) !== 0n)
    if (context.purpose === JevPurpose.Entry) {
      if (held.length !== 0) issues.push({ path: ['purpose'], issue: 'entry requires a reconciled flat account' })
      return issues
    }
    const position = held[0]
    if (
      held.length !== 1 ||
      position === undefined ||
      BigInt(position.quantityMicros) <= 0n ||
      position.schemaVersion !== 'bayn.position.v2' ||
      BigInt(position.costBasisMicros) <= 0n
    ) {
      issues.push({
        path: ['brokerState', 'positions'],
        issue: 'management requires one reconciled long with cost basis',
      })
      return issues
    }
    const fills = context.entryFills
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
      fills.reduce((sum, fill) => sum + BigInt(fill.quantityMicros), 0n) !== BigInt(position.quantityMicros)
    )
      issues.push({
        path: ['entryFills'],
        issue: 'complete canonical entry fills must explain the entire held quantity and match the reconciled orders',
      })
    for (const order of state.orders.filter(
      (order) => order.intentId !== undefined && context.entryIntentIds.includes(order.intentId),
    )) {
      const filled = fills
        .filter((fill) => fill.brokerOrderId === order.brokerOrderId)
        .reduce((sum, fill) => sum + BigInt(fill.quantityMicros), 0n)
      if (filled !== BigInt(order.filledQuantityMicros))
        issues.push({ path: ['entryFills'], issue: 'fill quantities must equal the reconciled entry orders' })
    }
    return issues
  }),
)

export type JevPortfolio = typeof JevPortfolioSchema.Type
export type JevManagedPortfolio = Extract<JevPortfolio, { readonly purpose: JevPurpose.Manage }>

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
        .filter((position) => BigInt(position.quantityMicros) > 0n)
        .map((position) => position.symbol)
        .sort()
