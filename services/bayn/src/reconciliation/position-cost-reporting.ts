import type { FeeAccrual } from '../accounting/fee-accrual'
import type { AccountingTransaction } from '../accounting/schema'
import { OrderSide } from '../execution/contracts'
import type { ProjectedPosition } from '../simulation-reconciliation/broker-model'

type CoinAccrual = Extract<FeeAccrual, { readonly kind: 'COIN' }>
interface WeightedPosition {
  readonly quantity: bigint
  readonly nativeCost: bigint
  readonly numerator: bigint
  readonly denominator: bigint
}

export const reportedPositionBasis = (numerator: bigint, denominator: bigint, quantity: bigint) => {
  const averageAtoms = (numerator * 2n + denominator) / (denominator * 2n)
  const averageMicros = (numerator * 2n + denominator * 1000n) / (denominator * 2000n)
  const divisor = denominator * 1_000_000_000_000n
  return {
    averageMicros,
    atomAverageMicros: (averageAtoms + 500n) / 1000n,
    weightedCost: (numerator * quantity * 2n + divisor) / (divisor * 2n),
    atomAverageCost: (averageAtoms * quantity + 500_000_000_000n) / 1_000_000_000_000n,
    microAverageCost: (averageMicros * quantity + 500_000_000n) / 1_000_000_000n,
  }
}

const greatestCommonDivisor = (left: bigint, right: bigint): bigint => {
  while (right !== 0n) [left, right] = [right, left % right]
  return left
}

const applyTrade = (state: WeightedPosition, trade: AccountingTransaction): WeightedPosition | null => {
  const quantity = state.quantity + BigInt(trade.quantityDeltaAtoms)
  const nativeCost = state.nativeCost + BigInt(trade.costBasisDeltaMicros)
  if (quantity < 0n || nativeCost < 0n || (quantity === 0n && nativeCost !== 0n)) return null
  if (quantity === 0n) return { quantity, nativeCost, numerator: 0n, denominator: 1n }
  if (trade.side === OrderSide.Sell) return { ...state, quantity, nativeCost }
  const numerator =
    state.numerator * state.quantity + BigInt(trade.quantityAtoms) * BigInt(trade.priceAtoms) * state.denominator
  const denominator = state.denominator * quantity
  const divisor = greatestCommonDivisor(numerator, denominator)
  return { quantity, nativeCost, numerator: numerator / divisor, denominator: denominator / divisor }
}

const cohortSources = (
  accrual: CoinAccrual,
  trades: ReadonlyMap<string, AccountingTransaction>,
): readonly AccountingTransaction[] | null => {
  const sources: AccountingTransaction[] = []
  for (const source of accrual.sourceTrades) {
    const trade = trades.get(source.transactionId)
    if (
      trade === undefined ||
      trade.side !== OrderSide.Buy ||
      trade.accountId !== accrual.accountId ||
      trade.symbol !== accrual.symbol ||
      trade.occurredAt > accrual.observedAt ||
      trade.quantityAtoms !== source.quantityAtoms ||
      trade.priceAtoms !== source.priceAtoms
    )
      return null
    sources.push(trade)
  }
  return sources
}

export const positionCostAnchor = (
  accountId: string,
  position: Omit<ProjectedPosition, 'costBasisAnchor'>,
  transactions: readonly AccountingTransaction[],
  accruals: readonly FeeAccrual[],
): ProjectedPosition['costBasisAnchor'] => {
  const native = transactions
    .filter((t) => t.accountId === accountId && t.symbol === position.symbol)
    .toSorted((a, b) => a.occurredAt.localeCompare(b.occurredAt) || a.transactionId.localeCompare(b.transactionId))
  const byId = new Map(native.map((trade) => [trade.transactionId, trade]))
  const cohorts = accruals
    .filter((a): a is CoinAccrual => a.kind === 'COIN' && a.accountId === accountId && a.symbol === position.symbol)
    .toSorted((a, b) => a.observedAt.localeCompare(b.observedAt))
  const initial = cohorts.findLast((cohort) => {
    const sources = cohortSources(cohort, byId)
    return (
      sources !== null &&
      sources.reduce((sum, t) => sum + BigInt(t.quantityAtoms), 0n).toString() === cohort.projectedQuantityAtoms &&
      sources.reduce((sum, t) => sum + BigInt(t.costBasisDeltaMicros), 0n).toString() === cohort.projectedCostMicros
    )
  })
  if (initial === undefined) return null
  const initialIds = new Set(initial.sourceTrades.map((t) => t.transactionId))
  const firstSourceAt = native
    .filter((t) => initialIds.has(t.transactionId))
    .reduce((first, t) => (t.occurredAt < first ? t.occurredAt : first), initial.observedAt)
  const relevant = native.filter((t) => t.occurredAt >= firstSourceAt)
  const applied = new Set<string>()
  let state: WeightedPosition = { quantity: 0n, nativeCost: 0n, numerator: 0n, denominator: 1n }
  for (const cohort of cohorts.slice(cohorts.indexOf(initial))) {
    const sources = cohortSources(cohort, byId)
    if (sources === null || sources.some((t) => applied.has(t.transactionId))) return null
    const sourceIds = new Set(sources.map((t) => t.transactionId))
    for (const trade of relevant) {
      if (
        applied.has(trade.transactionId) ||
        (!sourceIds.has(trade.transactionId) &&
          !(trade.side === OrderSide.Sell && trade.occurredAt <= cohort.observedAt))
      )
        continue
      const next = applyTrade(state, trade)
      if (next === null) return null
      state = next
      applied.add(trade.transactionId)
    }
    if (
      state.quantity.toString() !== cohort.projectedQuantityAtoms ||
      state.nativeCost.toString() !== cohort.projectedCostMicros
    )
      return null
    const quantity = BigInt(cohort.observedQuantityAtoms)
    const nativeCost = BigInt(cohort.observedCostMicros)
    const reporting = reportedPositionBasis(state.numerator, state.denominator, quantity)
    if (
      quantity >= state.quantity ||
      nativeCost > state.nativeCost ||
      (nativeCost !== reporting.weightedCost && nativeCost !== reporting.atomAverageCost)
    )
      return null
    state = { ...state, quantity, nativeCost }
  }
  for (const trade of relevant) {
    if (applied.has(trade.transactionId)) continue
    const next = applyTrade(state, trade)
    if (next === null) return null
    state = next
  }
  if (
    state.quantity <= 0n ||
    state.quantity.toString() !== position.quantityAtoms ||
    state.nativeCost.toString() !== position.costBasisMicros
  )
    return null
  return { priceAtomsNumerator: state.numerator.toString(), priceAtomsDenominator: state.denominator.toString() }
}
