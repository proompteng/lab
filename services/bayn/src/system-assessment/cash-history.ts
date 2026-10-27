import { Result, Schema } from 'effect'

import type { ForwardPerformanceEvidenceInput } from '../forward-performance/model'
import { brokerFeeCashDeltaMicros } from '../accounting/broker-fees'
import { canonicalHashV1Result } from '../hash'
import { Sha256Schema, SignedMicrosSchema, UtcInstantSchema } from '../schemas'
import { cashFlowTotals, type CashFlowEvidenceSchema } from './cash-flows'
import type { AccountMarkSchema } from './valuation'
import { cashSettlementMatches } from './cash-settlements'

export const CashHistorySchema = Schema.Struct({
  sourceHash: Sha256Schema,
  completeFrom: UtcInstantSchema,
  completeThrough: UtcInstantSchema,
  changes: Schema.Array(
    Schema.Struct({
      sourceHash: Sha256Schema,
      earliestAt: UtcInstantSchema,
      latestAt: UtcInstantSchema,
      amountMicros: SignedMicrosSchema,
    }),
  ),
})
type CashHistory = typeof CashHistorySchema.Type

/** Preserve the interval in which a receipt proves a cash change; an observation is not its event time. */
export const captureCashHistory = (forward: ForwardPerformanceEvidenceInput, completeFrom: string) =>
  Result.gen(function* () {
    const history = forward.accountTransactions
    const settlements = forward.accountCashSettlements
    const fees = forward.accountBrokerFees
    const accruals = forward.accountFeeAccruals
    const cut = forward.accountPositionCounts
    if (
      history === undefined ||
      settlements === undefined ||
      fees === undefined ||
      accruals === undefined ||
      cut?.exact !== true ||
      cut.reconciledAt < completeFrom ||
      !forward.ledgerExact ||
      !forward.accountingReceiptsExact ||
      forward.missingLedgerAccountCount !== 0 ||
      forward.unresolvedMutationCount !== 0
    )
      return null
    const changes: CashHistory['changes'][number][] = []
    const tradesById = new Map(history.map((trade) => [trade.transactionId, trade]))
    const settlementsById = new Map(settlements.map((settlement) => [settlement.data.transactionId, settlement]))
    if (
      tradesById.size !== history.length ||
      new Set(accruals.map((a) => a.accrual_id)).size !== accruals.length ||
      new Set(fees.map((fee) => fee.data.activityId)).size !== fees.length
    )
      return null
    if (
      settlementsById.size !== settlements.length ||
      settlements.some((settlement) => !tradesById.has(settlement.data.transactionId))
    )
      return null
    for (const trade of history) {
      const settlement = settlementsById.get(trade.transactionId)
      if (!cashSettlementMatches(trade, settlement, forward.account.accountId, cut.reconciledAt)) return null
      changes.push({
        sourceHash: yield* canonicalHashV1Result({ trade, settlement: settlement ?? null }),
        earliestAt: trade.occurredAt,
        latestAt: trade.occurredAt,
        amountMicros: (BigInt(trade.cashDeltaMicros) + BigInt(settlement?.rounding_delta_micros ?? '0')).toString(),
      })
    }
    for (const accrual of accruals) {
      if (accrual.data.kind !== 'CASH') continue
      const sources = accrual.data.sourceTrades.map((source) => tradesById.get(source.transactionId))
      if (
        !accrual.posted ||
        accrual.data.accountId !== forward.account.accountId ||
        accrual.cash_debit_micros === null ||
        sources.length === 0 ||
        sources.some((s) => s === undefined)
      )
        return null
      const earliest = sources.flatMap((source) => (source === undefined ? [] : [source.occurredAt])).sort()[0]
      if (earliest === undefined) return null
      changes.push({
        sourceHash: accrual.content_hash,
        earliestAt: earliest,
        latestAt: accrual.data.observedAt,
        amountMicros: (-BigInt(accrual.cash_debit_micros)).toString(),
      })
    }
    for (const fee of fees) {
      if (
        !fee.posted ||
        fee.data.accountId !== forward.account.accountId ||
        fee.cash_match_corrections.some((c) => !c.posted)
      )
        return null
      const amount = brokerFeeCashDeltaMicros(fee)
      if (amount === '0') continue
      const latest = [
        fee.read_evidence.observedAt,
        ...fee.cash_match_corrections.map((c) => c.data.readEvidence.observedAt),
      ]
        .sort()
        .at(-1)
      if (latest === undefined) return null
      changes.push({
        sourceHash: yield* canonicalHashV1Result(fee),
        // An activity date can be a posting date. It does not bound the physical debit within this window.
        earliestAt: latest < completeFrom ? latest : completeFrom,
        latestAt: latest,
        amountMicros: amount,
      })
    }
    if (changes.some((change) => change.earliestAt > change.latestAt || change.latestAt > cut.reconciledAt)) return null
    return {
      sourceHash: yield* canonicalHashV1Result({ account: forward.account, completeFrom, cut, changes }),
      completeFrom,
      completeThrough: cut.reconciledAt,
      changes,
    }
  })

/** Validate once and retain cumulative totals and unresolved interval counts at each change. */
export const indexCashHistory = (history: CashHistory) => {
  if (
    new Set(history.changes.map((change) => change.sourceHash)).size !== history.changes.length ||
    history.changes.some(
      (change) => change.earliestAt > change.latestAt || change.latestAt > history.completeThrough,
    ) ||
    history.completeFrom > history.completeThrough
  )
    return (_at: string): bigint | null => null
  const events = history.changes
    .flatMap((change) => [
      { at: change.earliestAt, amount: 0n, uncertain: change.earliestAt < change.latestAt ? 1 : 0 },
      {
        at: change.latestAt,
        amount: BigInt(change.amountMicros),
        uncertain: change.earliestAt < change.latestAt ? -1 : 0,
      },
    ])
    .sort((a, b) => a.at.localeCompare(b.at))
  const totals: { at: string; amount: bigint; uncertain: number }[] = []
  let amount = 0n
  let uncertain = 0
  for (const event of events) {
    amount += event.amount
    uncertain += event.uncertain
    const point = { at: event.at, amount, uncertain }
    if (totals.at(-1)?.at === event.at) totals[totals.length - 1] = point
    else totals.push(point)
  }
  return (at: string): bigint | null => {
    if (at < history.completeFrom || at > history.completeThrough) return null
    let lo = 0
    let hi = totals.length
    while (lo < hi) {
      const mid = Math.floor((lo + hi) / 2)
      const point = totals[mid]
      if (point !== undefined && point.at <= at) lo = mid + 1
      else hi = mid
    }
    const point = totals[lo - 1]
    return point === undefined ? 0n : point.uncertain > 0 ? null : point.amount
  }
}

/** Reconstruct cash from exact movements, then check every usable broker observation independently. */
export const projectSessionCash = (
  marks: readonly (typeof AccountMarkSchema.Type)[],
  history: CashHistory | null,
  flows: typeof CashFlowEvidenceSchema.Type | null,
  closeAt: string,
) =>
  Result.gen(function* () {
    if (history === null || flows === null || history.completeThrough < closeAt) return marks
    const changesAt = indexCashHistory(history)
    const cumulative = (at: string) => {
      const cash = changesAt(at)
      if (cash === null) return null
      const flow = cashFlowTotals(flows, at)
      return cash + flow.external + flow.yieldAmount - flow.paidOperating
    }
    const anchor = marks.find((mark) => mark.cashMicros !== null && cumulative(mark.at) !== null)
    if (anchor === undefined || anchor.cashMicros === null) return marks
    const anchorDelta = cumulative(anchor.at)
    if (anchorDelta === null) return marks
    const baseline = BigInt(anchor.cashMicros) - anchorDelta
    if (
      marks.some((mark) => {
        const delta = cumulative(mark.at)
        return mark.cashMicros !== null && delta !== null && BigInt(mark.cashMicros) !== baseline + delta
      })
    )
      return marks.map((mark) => ({ ...mark, cashMicros: null }))
    const projected = []
    for (const mark of marks) {
      const delta = cumulative(mark.at)
      if (mark.cashMicros !== null || delta === null) {
        projected.push(mark)
        continue
      }
      const cashMicros = (baseline + delta).toString()
      projected.push({
        ...mark,
        cashMicros,
        sourceHash: yield* canonicalHashV1Result({
          anchor,
          history: history.sourceHash,
          flows,
          at: mark.at,
          cashMicros,
          valuation: mark.sourceHash,
        }),
      })
    }
    return projected
  })
