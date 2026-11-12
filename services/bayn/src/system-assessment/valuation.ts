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

export const requiredValuationTimes = (
  sessions: readonly { readonly openAt: string; readonly closeAt: string }[],
  intervalMs: number,
) => {
  const times: string[] = []
  for (const session of sessions) {
    for (let at = Date.parse(session.openAt); at < Date.parse(session.closeAt); at += intervalMs)
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
    type Change =
      | {
          readonly at: string
          readonly kind: 'INVENTORY'
          readonly symbol: string
          readonly quantity: bigint
          readonly cost: bigint
        }
      | { readonly at: string; readonly kind: 'UNCERTAINTY'; readonly delta: number }
    const changes: Change[] = (history ?? []).map((trade) => ({
      at: trade.occurredAt,
      kind: 'INVENTORY',
      symbol: trade.symbol,
      quantity: BigInt(trade.quantityDeltaAtoms),
      cost: BigInt(trade.costBasisDeltaMicros),
    }))
    const tradesById = new Map(history?.map((trade) => [trade.transactionId, trade]))
    for (const accrual of forward.accountFeeAccruals ?? []) {
      if (accrual.data.kind !== 'COIN' || accrual.coin_quantity_atoms === null) continue
      const earliest = accrual.data.sourceTrades
        .flatMap((source) => {
          const trade = tradesById.get(source.transactionId)
          return trade === undefined ? [] : [trade.occurredAt]
        })
        .sort()[0]
      if (earliest !== undefined && earliest < accrual.data.observedAt) {
        changes.push({ at: earliest, kind: 'UNCERTAINTY', delta: 1 })
        changes.push({ at: accrual.data.observedAt, kind: 'UNCERTAINTY', delta: -1 })
      }
      changes.push({
        at: accrual.data.observedAt,
        kind: 'INVENTORY',
        symbol: accrual.data.symbol,
        quantity: -BigInt(accrual.coin_quantity_atoms),
        cost: -BigInt(accrual.expense_micros),
      })
    }
    changes.sort((a, b) => a.at.localeCompare(b.at))
    const holdings = new Map<string, { quantity: bigint; cost: bigint }>()
    let cursor = 0
    let uncertain = 0
    let previousAt: string | undefined
    return {
      sourceHash,
      episodes,
      at: (
        at: string,
      ):
        | readonly { readonly symbol: string; readonly quantityAtoms: string; readonly costBasisMicros: string }[]
        | null => {
        if (episodes.status !== 'MEASURED' || history === undefined || cut === undefined || at > cut) return null
        // Capture walks sorted observations. A caller may also request an earlier independent endpoint.
        if (previousAt !== undefined && at < previousAt) {
          holdings.clear()
          cursor = 0
          uncertain = 0
        }
        previousAt = at
        while (cursor < changes.length) {
          const change = changes[cursor]
          if (change === undefined || change.at > at) break
          cursor++
          if (change.kind === 'UNCERTAINTY') {
            uncertain += change.delta
            continue
          }
          const held = holdings.get(change.symbol)
          const quantity = (held?.quantity ?? 0n) + change.quantity
          const cost = (held?.cost ?? 0n) + change.cost
          if (quantity === 0n && cost === 0n) holdings.delete(change.symbol)
          else holdings.set(change.symbol, { quantity, cost })
        }
        if (uncertain > 0) return null
        const positions = []
        for (const [symbol, { quantity, cost }] of holdings) {
          if (quantity < 0n || cost < 0n || (quantity === 0n && cost !== 0n)) return null
          if (quantity > 0n)
            positions.push({ symbol, quantityAtoms: quantity.toString(), costBasisMicros: cost.toString() })
        }
        return positions.sort((a, b) => a.symbol.localeCompare(b.symbol))
      },
    }
  })
