import { Schema } from 'effect'

import { UnsignedMicrosSchema } from '../schemas'

export enum EntryAllocationReason {
  TurnoverBudgetExhausted = 'TURNOVER_BUDGET_EXHAUSTED',
  ZeroAllocation = 'ZERO_ALLOCATION',
}

export const EntryAllocationFactsSchema = Schema.Struct({
  noTrade: Schema.Boolean,
  positiveTarget: Schema.Boolean,
  flat: Schema.Boolean,
  allocationCapitalMicros: Schema.NullOr(UnsignedMicrosSchema),
  priorRecordedTurnoverMicros: Schema.NullOr(UnsignedMicrosSchema),
  maximumTurnoverMicros: Schema.NullOr(UnsignedMicrosSchema),
})

/** Read-only explanation of a retained decision, not an order-risk gate or a new allocation policy. */
export const describeEntryAllocation = (
  facts: typeof EntryAllocationFactsSchema.Type | null | undefined,
): EntryAllocationReason | null => {
  if (facts == null || !facts.noTrade || !facts.positiveTarget || !facts.flat || facts.allocationCapitalMicros !== '0')
    return null
  if (
    facts.priorRecordedTurnoverMicros !== null &&
    facts.maximumTurnoverMicros !== null &&
    BigInt(facts.priorRecordedTurnoverMicros) >= BigInt(facts.maximumTurnoverMicros)
  )
    return EntryAllocationReason.TurnoverBudgetExhausted
  return EntryAllocationReason.ZeroAllocation
}
