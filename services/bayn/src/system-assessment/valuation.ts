import { Result, Schema } from 'effect'

import { canonicalHashV1Result } from '../hash'
import type { ForwardPerformanceEvidenceInput } from '../forward-performance/model'
import { measurePositionEpisodes } from '../forward-performance/position-episodes'
import { quantityScale } from '../quantity'
import { Sha256Schema, SignedMicrosSchema, SymbolSchema, UnsignedMicrosSchema, UtcInstantSchema } from '../schemas'

export const AccountValuationSchema = Schema.Struct({
  inventorySourceHash: Sha256Schema,
  positions: Schema.Array(
    Schema.Struct({
      symbol: SymbolSchema,
      quantityAtoms: UnsignedMicrosSchema,
      bidPriceMicros: UnsignedMicrosSchema,
      costBasisMicros: UnsignedMicrosSchema,
      quoteSourceHash: Sha256Schema,
    }),
  ),
})

export const AccountMarkSchema = Schema.Struct({
  accountBindingHash: Sha256Schema,
  sourceHash: Sha256Schema,
  at: UtcInstantSchema,
  availableAt: UtcInstantSchema,
  cashMicros: Schema.NullOr(SignedMicrosSchema),
  valuation: Schema.NullOr(AccountValuationSchema),
})

/** Cash is observed or reconstructed from reconciled movements; inventory is independently reconciled. No broker mark enters this sum. */
export const accountMarkValue = (mark: typeof AccountMarkSchema.Type) => {
  if (mark.valuation === null || mark.cashMicros === null) return null
  let inventoryValue = 0n
  let costBasis = 0n
  const symbols = new Set<string>()
  for (const position of mark.valuation.positions) {
    const quantity = BigInt(position.quantityAtoms)
    const bid = BigInt(position.bidPriceMicros)
    const cost = BigInt(position.costBasisMicros)
    if (symbols.has(position.symbol) || quantity <= 0n || bid <= 0n || cost < 0n) return null
    symbols.add(position.symbol)
    // Liquidation marks round down; rounding cannot create an additional microdollar of equity.
    inventoryValue += (quantity * bid) / quantityScale
    costBasis += cost
  }
  return {
    equityMicros: (BigInt(mark.cashMicros) + inventoryValue).toString(),
    unrealizedPnlMicros: (inventoryValue - costBasis).toString(),
    positionCount: symbols.size,
  }
}

export const requiredValuationTimes = (sessions: readonly { readonly openAt: string; readonly closeAt: string }[]) => {
  const times: string[] = []
  for (const session of sessions) {
    for (let at = Date.parse(session.openAt); at < Date.parse(session.closeAt); at += 60_000)
      times.push(new Date(at).toISOString())
    times.push(session.closeAt)
  }
  return times
}

export const prepareValuationInventory = (forward: ForwardPerformanceEvidenceInput) =>
  Result.gen(function* () {
    const episodes = yield* measurePositionEpisodes(forward)
    const history = forward.accountTransactions
    const cut = forward.accountPositionCounts?.reconciledAt
    const sourceHash = yield* canonicalHashV1Result({
      episodes,
      account: forward.account,
      history: history ?? null,
      accruals: forward.accountFeeAccruals ?? null,
      cut: cut ?? null,
    })
    return {
      sourceHash,
      episodes,
      at: (
        at: string,
      ):
        | readonly { readonly symbol: string; readonly quantityAtoms: string; readonly costBasisMicros: string }[]
        | null => {
        if (episodes.status !== 'MEASURED' || history === undefined || cut === undefined || at > cut) return null
        const quantities = new Map<string, bigint>()
        const costs = new Map<string, bigint>()
        for (const transaction of history) {
          if (transaction.occurredAt > at) continue
          quantities.set(
            transaction.symbol,
            (quantities.get(transaction.symbol) ?? 0n) + BigInt(transaction.quantityDeltaAtoms),
          )
          costs.set(
            transaction.symbol,
            (costs.get(transaction.symbol) ?? 0n) + BigInt(transaction.costBasisDeltaMicros),
          )
        }
        for (const accrual of forward.accountFeeAccruals ?? []) {
          if (accrual.data.kind !== 'COIN' || accrual.coin_quantity_atoms === null) continue
          if (accrual.data.observedAt > at) {
            // A daily settlement does not supply the instant of a coin debit. Do not invent it.
            if (
              accrual.data.sourceTrades.some((source) =>
                history.some((trade) => trade.transactionId === source.transactionId && trade.occurredAt <= at),
              )
            )
              return null
            continue
          }
          quantities.set(
            accrual.data.symbol,
            (quantities.get(accrual.data.symbol) ?? 0n) - BigInt(accrual.coin_quantity_atoms),
          )
          costs.set(accrual.data.symbol, (costs.get(accrual.data.symbol) ?? 0n) - BigInt(accrual.expense_micros))
        }
        const positions = []
        for (const [symbol, quantity] of quantities) {
          const cost = costs.get(symbol)
          if (quantity < 0n || cost === undefined || cost < 0n || (quantity === 0n && cost !== 0n)) return null
          if (quantity > 0n)
            positions.push({ symbol, quantityAtoms: quantity.toString(), costBasisMicros: cost.toString() })
        }
        return positions.sort((a, b) => a.symbol.localeCompare(b.symbol))
      },
    }
  })
