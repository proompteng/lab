import { Result, Schema } from 'effect'

import type { AccountingTransaction } from '../accounting/schema'
import { prepareFeeAccrual } from '../accounting/fee-accrual'
import { OrderSide, SignedMicrosSchema, UnsignedMicrosSchema } from '../execution/contracts'
import { instrumentMarket, MarketKind } from '../instruments'
import { NonNegativeIntegerSchema, Sha256Schema, SymbolSchema, UtcInstantSchema } from '../schemas'
import type { ForwardPerformanceEvidenceInput } from './model'

export enum EpisodeCostReason {
  NonCryptoAllocationUnavailable = 'NON_CRYPTO_ALLOCATION_UNAVAILABLE',
  FeeHistoryUnavailable = 'FEE_HISTORY_UNAVAILABLE',
  InvalidFeeHistory = 'INVALID_FEE_HISTORY',
  MissingSourceAccrual = 'MISSING_SOURCE_ACCRUAL',
  SharedSourceAccrual = 'SHARED_SOURCE_ACCRUAL',
}

const attributedCostScope = 'FILL_FEES_AND_SOURCE_LINKED_ACCRUALS'
const CostEvidenceSchema = Schema.Union([
  Schema.Struct({
    status: Schema.Literal('ATTRIBUTED_ACCRUALS'),
    scope: Schema.Literal(attributedCostScope),
    attributedCostMicros: UnsignedMicrosSchema,
    netPnlAfterAttributedCostsMicros: SignedMicrosSchema,
    finalExecutionCostCoverage: Schema.Literal('UNDETERMINED'),
    brokerActivityAdjustmentsIncluded: Schema.Literal(false),
    allInProfitMicros: Schema.Null,
  }),
  Schema.Struct({
    status: Schema.Literal('UNDETERMINED'),
    reason: Schema.Enum(EpisodeCostReason),
    attributedCostMicros: Schema.Null,
    netPnlAfterAttributedCostsMicros: Schema.Null,
    allInProfitMicros: Schema.Null,
  }),
])

export const PositionOutcomeSchema = Schema.Struct({
  openingTransactionId: Sha256Schema,
  closingTransactionId: Sha256Schema,
  symbol: SymbolSchema,
  openedAt: UtcInstantSchema,
  closedAt: UtcInstantSchema,
  holdingDurationMs: NonNegativeIntegerSchema,
  buyFillCount: NonNegativeIntegerSchema,
  sellFillCount: NonNegativeIntegerSchema,
  buyNotionalMicros: UnsignedMicrosSchema,
  turnoverMicros: UnsignedMicrosSchema,
  grossRealizedPnlMicros: SignedMicrosSchema,
  costs: CostEvidenceSchema,
})
export type PositionOutcome = typeof PositionOutcomeSchema.Type

export const PositionSymbolOutcomesSchema = Schema.Struct({
  symbol: SymbolSchema,
  completedCount: NonNegativeIntegerSchema,
  grossWinningCount: NonNegativeIntegerSchema,
  grossLosingCount: NonNegativeIntegerSchema,
  grossFlatCount: NonNegativeIntegerSchema,
  buyNotionalMicros: UnsignedMicrosSchema,
  turnoverMicros: UnsignedMicrosSchema,
  grossRealizedPnlMicros: SignedMicrosSchema,
  worstGrossRealizedPnlMicros: SignedMicrosSchema,
  medianHoldingDurationMs: Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0)),
  maximumHoldingDurationMs: NonNegativeIntegerSchema,
  attributedCostEpisodeCount: NonNegativeIntegerSchema,
  netPnlAfterAttributedCostsMicros: Schema.NullOr(SignedMicrosSchema),
  allInProfitMicros: Schema.Null,
})

type Accrual = NonNullable<ForwardPerformanceEvidenceInput['accountFeeAccruals']>[number]

const unknownCost = (reason: EpisodeCostReason): typeof CostEvidenceSchema.Type => ({
  status: 'UNDETERMINED',
  reason,
  attributedCostMicros: null,
  netPnlAfterAttributedCostsMicros: null,
  allInProfitMicros: null,
})

/** The enclosing episode measurement already verified cumulative fills and the account reconciliation cut. */
const sourceAccruals = (input: ForwardPerformanceEvidenceInput) => {
  const history = new Map(input.accountTransactions?.map((transaction) => [transaction.transactionId, transaction]))
  const byTransaction = new Map<string, Accrual>()
  const ids = new Set<string>()
  for (const accrual of input.accountFeeAccruals ?? []) {
    const data = accrual.data
    const prepared = prepareFeeAccrual(data, accrual.tigerbeetle_ledger)
    if (
      ids.has(accrual.accrual_id) ||
      data.accountId !== input.account.accountId ||
      !accrual.posted ||
      data.observedAt > (input.accountPositionCounts?.reconciledAt ?? '') ||
      Result.isFailure(prepared) ||
      prepared.success.accrualId !== accrual.accrual_id ||
      prepared.success.contentHash !== accrual.content_hash ||
      prepared.success.expenseMicros !== accrual.expense_micros ||
      prepared.success.coinQuantityAtoms !== accrual.coin_quantity_atoms ||
      prepared.success.cashDebitMicros !== accrual.cash_debit_micros
    )
      return null
    ids.add(accrual.accrual_id)
    for (const source of data.sourceTrades) {
      const trade = history.get(source.transactionId)
      if (
        trade === undefined ||
        byTransaction.has(source.transactionId) ||
        trade.quantityAtoms !== source.quantityAtoms ||
        trade.priceAtoms !== source.priceAtoms ||
        trade.occurredAt > data.observedAt ||
        instrumentMarket(trade.symbol) !== MarketKind.Crypto ||
        trade.side !== (data.kind === 'COIN' ? OrderSide.Buy : OrderSide.Sell) ||
        (data.kind === 'COIN' && trade.symbol !== data.symbol)
      )
        return null
      byTransaction.set(source.transactionId, accrual)
    }
  }
  return byTransaction
}

const episodeCosts = (
  trades: readonly AccountingTransaction[],
  grossPnl: bigint,
  input: ForwardPerformanceEvidenceInput,
  sources: ReturnType<typeof sourceAccruals>,
): typeof CostEvidenceSchema.Type => {
  if (trades.some((trade) => instrumentMarket(trade.symbol) !== MarketKind.Crypto))
    return unknownCost(EpisodeCostReason.NonCryptoAllocationUnavailable)
  if (input.accountFeeAccruals === undefined || input.accountBrokerFees === undefined)
    return unknownCost(EpisodeCostReason.FeeHistoryUnavailable)
  if (sources === null) return unknownCost(EpisodeCostReason.InvalidFeeHistory)
  const ids = new Set(trades.map((trade) => trade.transactionId))
  const accruals = new Map<string, Accrual>()
  for (const trade of trades) {
    const accrual = sources.get(trade.transactionId)
    if (accrual === undefined) return unknownCost(EpisodeCostReason.MissingSourceAccrual)
    if (accrual.data.sourceTrades.some((source) => !ids.has(source.transactionId)))
      return unknownCost(EpisodeCostReason.SharedSourceAccrual)
    accruals.set(accrual.accrual_id, accrual)
  }
  const cost =
    trades.reduce((sum, trade) => sum + BigInt(trade.feeMicros), 0n) +
    [...accruals.values()].reduce((sum, accrual) => sum + BigInt(accrual.expense_micros), 0n)
  return {
    status: 'ATTRIBUTED_ACCRUALS',
    scope: attributedCostScope,
    attributedCostMicros: cost.toString(),
    netPnlAfterAttributedCostsMicros: (grossPnl - cost).toString(),
    finalExecutionCostCoverage: 'UNDETERMINED',
    brokerActivityAdjustmentsIncluded: false,
    allInProfitMicros: null,
  }
}

export const summarizePositionOutcomes = (
  completed: readonly (readonly AccountingTransaction[])[],
  input: ForwardPerformanceEvidenceInput,
) => {
  const sources = sourceAccruals(input)
  const outcomes: PositionOutcome[] = []
  for (const trades of completed) {
    const first = trades[0]
    const last = trades.at(-1)
    if (first === undefined || last === undefined) continue
    const grossPnl = trades.reduce((sum, trade) => sum + BigInt(trade.realizedPnlMicros), 0n)
    const buys = trades.filter((trade) => trade.side === OrderSide.Buy)
    outcomes.push({
      openingTransactionId: first.transactionId,
      closingTransactionId: last.transactionId,
      symbol: first.symbol,
      openedAt: first.occurredAt,
      closedAt: last.occurredAt,
      holdingDurationMs: Date.parse(last.occurredAt) - Date.parse(first.occurredAt),
      buyFillCount: buys.length,
      sellFillCount: trades.length - buys.length,
      buyNotionalMicros: buys.reduce((sum, trade) => sum + BigInt(trade.notionalMicros), 0n).toString(),
      turnoverMicros: trades.reduce((sum, trade) => sum + BigInt(trade.notionalMicros), 0n).toString(),
      grossRealizedPnlMicros: grossPnl.toString(),
      costs: episodeCosts(trades, grossPnl, input, sources),
    })
  }
  const bySymbol: (typeof PositionSymbolOutcomesSchema.Type)[] = []
  for (const symbol of [...new Set(outcomes.map((outcome) => outcome.symbol))].sort()) {
    const rows = outcomes.filter((outcome) => outcome.symbol === symbol)
    const durations = rows.map((row) => row.holdingDurationMs).sort((a, b) => a - b)
    const pnls = rows.map((row) => BigInt(row.grossRealizedPnlMicros))
    const costs = rows.flatMap((row) => (row.costs.status === 'ATTRIBUTED_ACCRUALS' ? [row.costs] : []))
    const middle = Math.floor(durations.length / 2)
    const upper = durations[middle] ?? 0
    bySymbol.push({
      symbol,
      completedCount: rows.length,
      grossWinningCount: pnls.filter((pnl) => pnl > 0n).length,
      grossLosingCount: pnls.filter((pnl) => pnl < 0n).length,
      grossFlatCount: pnls.filter((pnl) => pnl === 0n).length,
      buyNotionalMicros: rows.reduce((sum, row) => sum + BigInt(row.buyNotionalMicros), 0n).toString(),
      turnoverMicros: rows.reduce((sum, row) => sum + BigInt(row.turnoverMicros), 0n).toString(),
      grossRealizedPnlMicros: pnls.reduce((sum, pnl) => sum + pnl, 0n).toString(),
      worstGrossRealizedPnlMicros: pnls.reduce((minimum, pnl) => (pnl < minimum ? pnl : minimum)).toString(),
      medianHoldingDurationMs: durations.length % 2 === 0 ? ((durations[middle - 1] ?? upper) + upper) / 2 : upper,
      maximumHoldingDurationMs: durations.at(-1) ?? 0,
      attributedCostEpisodeCount: costs.length,
      netPnlAfterAttributedCostsMicros:
        costs.length === rows.length
          ? costs.reduce((sum, row) => sum + BigInt(row.netPnlAfterAttributedCostsMicros), 0n).toString()
          : null,
      allInProfitMicros: null,
    })
  }
  return { completed: outcomes, bySymbol }
}
