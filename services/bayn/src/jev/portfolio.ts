import { JevPositionExitPolicySchema } from './exit-policy'
import { Context, Effect, Result, Schema } from 'effect'

import type { OperationalError } from '../errors'
import { freezeEvidence } from '../immutable-evidence'
import type { ReconciledBrokerState } from '../simulation-reconciliation/broker-model'

import {
  AccountSnapshotSchema,
  UnsignedMicrosSchema,
  FillSchema,
  OrderSchema,
  OrderSide,
  OrderStatus,
  OrderType,
  PositionSchema,
  ReconciliationSchema,
  ReconciliationStatus,
} from '../execution/contracts'
import { reconciledStateHash } from '../simulation-reconciliation/broker-model'
import { actualAlphaProtectionPrices } from '../strategy/intraday-alpha/exit-plan'
import { Sha256Schema, SymbolSchema, UtcInstantSchema, strictParseOptions } from '../schemas'
import { JevContractError } from './contract'
import {
  isIntradayAlphaExitPlan,
  isShortExitPlan,
  entryPlanPriceMicros,
  type FundedEntryExitPlan,
} from '../strategy/funded-exit-plan'

export enum JevPurpose {
  Entry = 'ENTRY',
  Manage = 'MANAGE',
}

export const currentProtectionEvidenceVersion = 'bayn.jev-protection-evidence.v2' as const

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
  Schema.Struct({
    purpose: Schema.Literal(JevPurpose.Entry),
    brokerState: ReconciledStateSchema,
    concurrentDisjointPositions: Schema.optionalKey(Schema.Literal(true)),
  }),
  Schema.Struct({
    purpose: Schema.Literal(JevPurpose.Manage),
    protectionEvidenceVersion: Schema.optionalKey(Schema.Literal(currentProtectionEvidenceVersion)),
    managedSymbol: Schema.optionalKey(SymbolSchema),
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

const isKnownProtectionOrderForHeldPosition = (
  order: typeof OrderSchema.Type,
  heldBySymbol: ReadonlyMap<string, bigint>,
): boolean => {
  if (order.intentId === undefined) return false
  const heldQty = heldBySymbol.get(order.symbol) ?? 0n
  if (heldQty === 0n) return false
  const expectedExitSide = heldQty < 0n ? OrderSide.Buy : OrderSide.Sell
  return (
    order.side === expectedExitSide && (order.orderType === OrderType.StopLimit || order.orderType === OrderType.Limit)
  )
}

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
    const held = state.positions.filter((position) => BigInt(position.quantityAtoms) !== 0n)
    const heldBySymbol = new Map(held.map((position) => [position.symbol, BigInt(position.quantityAtoms)] as const))
    const planEntries = context.purpose === JevPurpose.Manage ? Object.entries(context.exitPolicy.plans) : []
    const isMultiLegManage =
      context.purpose === JevPurpose.Manage &&
      (planEntries.length > 1 || planEntries.some(([, plan]) => isIntradayAlphaExitPlan(plan)))
    if (
      state.orders.some((order) => {
        if (
          [OrderStatus.Filled, OrderStatus.Canceled, OrderStatus.Expired, OrderStatus.Rejected].includes(order.status)
        )
          return false
        if (order.intentId === undefined) return true
        if (context.purpose === JevPurpose.Entry) {
          return context.concurrentDisjointPositions === true
            ? !isKnownProtectionOrderForHeldPosition(order, heldBySymbol)
            : true
        }
        const protectionPlan = context.exitPolicy.plans[order.symbol]
        if (protectionPlan === undefined) {
          return isMultiLegManage ? !isKnownProtectionOrderForHeldPosition(order, heldBySymbol) : true
        }
        if (
          order.side !== (isShortExitPlan(protectionPlan) ? OrderSide.Buy : OrderSide.Sell) ||
          !context.protectionIntentIds.includes(order.intentId)
        )
          return true
        const matches = (
          prices: Pick<
            typeof protectionPlan.levels,
            'profitLimitPriceMicros' | 'stopPriceMicros' | 'stopLimitPriceMicros'
          >,
        ) =>
          (order.orderType === OrderType.Limit && order.limitPriceMicros === prices.profitLimitPriceMicros) ||
          (order.orderType === OrderType.StopLimit &&
            order.stopPriceMicros === prices.stopPriceMicros &&
            order.limitPriceMicros === prices.stopLimitPriceMicros)
        if (matches(protectionPlan.levels)) return false
        if (!isIntradayAlphaExitPlan(protectionPlan) || protectionPlan.levels.fillAnchored === undefined) return true
        const anchored = actualAlphaProtectionPrices(protectionPlan, context.entryFills)
        return Result.isFailure(anchored) || !matches(anchored.success)
      })
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
    if (context.purpose === JevPurpose.Entry) {
      if (context.concurrentDisjointPositions !== true) {
        if (held.length !== 0) issues.push({ path: ['purpose'], issue: 'entry requires a reconciled flat account' })
      } else if (
        held.some(
          (position) =>
            BigInt(position.costBasisMicros) === 0n ||
            BigInt(position.quantityAtoms) < 0n !== BigInt(position.costBasisMicros) < 0n,
        )
      ) {
        issues.push({
          path: ['brokerState', 'positions'],
          issue: 'concurrent disjoint entry requires coherent signed held positions',
        })
      }
      return issues
    }
    const scopedPlan = context.managedSymbol === undefined ? undefined : context.exitPolicy.plans[context.managedSymbol]
    if (
      context.managedSymbol !== undefined &&
      (scopedPlan === undefined ||
        !isIntradayAlphaExitPlan(scopedPlan) ||
        scopedPlan.levels.fillAnchored === undefined ||
        context.protectionEvidenceVersion !== currentProtectionEvidenceVersion ||
        !heldBySymbol.has(context.managedSymbol))
    )
      issues.push({ path: ['managedSymbol'], issue: 'per-leg management requires a held fill-anchored ETF plan' })
    const isMultiLeg = isMultiLegManage
    const plannedSymbols = new Set(Object.keys(context.exitPolicy.plans))
    const ownedHeld = isMultiLeg ? held.filter((position) => plannedSymbols.has(position.symbol)) : held
    if (
      ownedHeld.length === 0 ||
      (!isMultiLeg && ownedHeld.length !== 1) ||
      ownedHeld.length > planEntries.length ||
      ownedHeld.some(
        (position) =>
          BigInt(position.quantityAtoms) === 0n ||
          BigInt(position.costBasisMicros) === 0n ||
          BigInt(position.quantityAtoms) < 0n !== BigInt(position.costBasisMicros) < 0n,
      )
    ) {
      issues.push({
        path: ['brokerState', 'positions'],
        issue: 'management requires reconciled signed position(s) with matching cost basis',
      })
      return issues
    }
    const fills = context.entryFills
    if (context.profitExitRequested && context.exitRequestedAt === null)
      issues.push({ path: ['profitExitRequested'], issue: 'requires a durable protection cancellation request' })
    let planInvalid =
      (!isMultiLeg && planEntries.length !== 1) || ownedHeld.some((pos) => !plannedSymbols.has(pos.symbol))
    for (const [symbol, plan] of planEntries) {
      const symbolFills = fills.filter((fill) => fill.symbol === symbol)
      const heldPosition = ownedHeld.find((pos) => pos.symbol === symbol)
      if (
        plan.levels.symbol !== symbol ||
        (isIntradayAlphaExitPlan(plan)
          ? plan.levels.maximumHoldingMinutes > context.exitPolicy.maximumHoldingMinutes
          : plan.levels.maximumHoldingMinutes !== context.exitPolicy.maximumHoldingMinutes) ||
        (heldPosition !== undefined && isShortExitPlan(plan) !== BigInt(heldPosition.quantityAtoms) < 0n) ||
        symbolFills.some(
          (fill) =>
            fill.occurredAt < plan.levels.sourceEndAt ||
            (isShortExitPlan(plan)
              ? BigInt(fill.priceAtoms) < entryPlanPriceMicros(plan) * 1000n
              : BigInt(fill.priceAtoms) > entryPlanPriceMicros(plan) * 1000n),
        ) ||
        symbolFills.reduce((sum, fill) => sum + BigInt(fill.quantityAtoms), 0n) > BigInt(plan.maximumQuantityAtoms)
      ) {
        planInvalid = true
        break
      }
    }
    if (planInvalid)
      issues.push({ path: ['exitPolicy'], issue: 'actual entry fills must remain within the immutable pre-entry plan' })
    const fillIds = new Set(fills.map((fill) => fill.fillId))
    const totalHeldAbsAtoms = ownedHeld.reduce((sum, pos) => {
      const qty = BigInt(pos.quantityAtoms)
      return sum + (qty < 0n ? -qty : qty)
    }, 0n)
    if (
      fillIds.size !== fills.length ||
      fills.some((fill, index) => {
        const fillPlan = context.exitPolicy.plans[fill.symbol]
        return (
          fillPlan === undefined ||
          fill.accountId !== state.account.accountId ||
          fill.side !== (isShortExitPlan(fillPlan) ? OrderSide.Sell : OrderSide.Buy) ||
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
          )
        )
      }) ||
      fills.reduce((sum, fill) => sum + BigInt(fill.quantityAtoms), 0n) -
        BigInt(context.entryInventoryDebit.quantityAtoms) -
        BigInt(context.protectionDisposals.quantityAtoms) !==
        totalHeldAbsAtoms
    )
      issues.push({
        path: ['entryFills'],
        issue:
          'complete canonical entry fills minus posted inventory debits must explain the held quantity and match reconciled orders',
      })
    for (const order of state.orders.filter((order) => {
      const orderPlan = context.exitPolicy.plans[order.symbol]
      return (
        orderPlan !== undefined &&
        order.side === (isShortExitPlan(orderPlan) ? OrderSide.Sell : OrderSide.Buy) &&
        order.intentId !== undefined &&
        context.entryIntentIds.includes(order.intentId)
      )
    })) {
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
  symbol?: string,
): Result.Result<FundedEntryExitPlan, JevContractError> => {
  const targetSymbol =
    symbol ??
    portfolio.brokerState.positions.find(
      ({ symbol: heldSymbol, quantityAtoms }) =>
        BigInt(quantityAtoms) !== 0n && portfolio.exitPolicy.plans[heldSymbol] !== undefined,
    )?.symbol
  const plan = targetSymbol === undefined ? undefined : portfolio.exitPolicy.plans[targetSymbol]
  return plan === undefined
    ? Result.fail(new JevContractError({ message: 'Held position has no immutable strategy exit plan' }))
    : Result.succeed(plan)
}

export interface JevPositionStoreShape {
  readonly read: (input: {
    readonly cycleId: string
    readonly entryDecisionHash: string
    readonly brokerState: ReconciledBrokerState
    readonly managedSymbol?: string
  }) => Effect.Effect<JevManagedPortfolio, OperationalError>
}

export class JevPositionStore extends Context.Service<JevPositionStore, JevPositionStoreShape>()(
  '@proompteng/bayn/jev/PositionStore',
) {}

const ownedPortfolios = new WeakSet<JevPortfolio>()

export const isOwnedJevPortfolio = (portfolio: JevPortfolio) => ownedPortfolios.has(portfolio)

export const decodeJevPortfolio = (input: unknown) =>
  Schema.decodeUnknownResult(
    JevPortfolioSchema,
    strictParseOptions,
  )(input).pipe(
    Result.mapError((cause) => new JevContractError({ message: 'Jev position context is invalid', cause })),
    Result.map((portfolio) => {
      freezeEvidence(portfolio)
      ownedPortfolios.add(portfolio)
      return portfolio
    }),
  )

export const jevPortfolioCandidates = (portfolio: JevPortfolio, candidates: readonly string[]): readonly string[] =>
  portfolio.purpose === JevPurpose.Entry
    ? candidates
    : portfolio.brokerState.positions
        .filter(
          (position) =>
            BigInt(position.quantityAtoms) !== 0n && portfolio.exitPolicy.plans[position.symbol] !== undefined,
        )
        .map((position) => position.symbol)
        .sort()
