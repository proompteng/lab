import { equityClockSession } from '../equity-hours'
import { instrumentMarket, MarketKind } from '../instruments'
import type { JevFundedExitPlan } from '../jev/strategy-exit-plan'
import { quantityScale } from '../quantity'

export type BrokerProtectionMethod = 'BRACKET' | 'OCO' | 'STOP_LIMIT' | 'APPLICATION'

export const alpacaEntryProtectionMethod = (
  symbol: string,
  quantityAtoms: bigint,
  observedAt: string,
): Exclude<BrokerProtectionMethod, 'OCO'> => {
  if (instrumentMarket(symbol) === MarketKind.Crypto) return 'STOP_LIMIT'
  if (equityClockSession(observedAt) !== 'regular') return 'APPLICATION'
  return quantityAtoms % quantityScale === 0n ? 'BRACKET' : 'STOP_LIMIT'
}

export type ProtectionOrderState =
  | { readonly _tag: 'Absent' }
  | { readonly _tag: 'Unknown'; readonly intentId: string }
  | { readonly _tag: 'Canceling'; readonly intentId: string }
  | {
      readonly _tag: 'Armed'
      readonly intentId: string
      readonly method: Exclude<BrokerProtectionMethod, 'APPLICATION'>
      readonly quantityAtoms: bigint
      readonly stopPriceMicros: bigint
      readonly stopLimitPriceMicros: bigint
      readonly profitLimitPriceMicros: bigint | null
    }

export type ProtectedEntryState = { readonly _tag: 'Working'; readonly intentId: string } | { readonly _tag: 'Settled' }

export type PositionProtectionAction =
  | { readonly _tag: 'Wait'; readonly reason: 'ENTRY_UNFILLED' | 'CANCEL_PENDING' | 'PROTECTED' | 'APPLICATION_ONLY' }
  | { readonly _tag: 'Recover'; readonly intentId: string }
  | { readonly _tag: 'CancelEntry'; readonly intentId: string }
  | { readonly _tag: 'CancelProtection'; readonly intentId: string }
  | { readonly _tag: 'Arm'; readonly method: 'OCO' | 'STOP_LIMIT'; readonly quantityAtoms: bigint }
  | { readonly _tag: 'Liquidate'; readonly quantityAtoms: bigint }
  | { readonly _tag: 'Block'; readonly reason: 'NEGATIVE_POSITION' | 'UNBOUND_POSITION' }
  | { readonly _tag: 'Complete' }

export const decidePositionProtection = (input: {
  readonly plan: JevFundedExitPlan
  readonly entry: ProtectedEntryState
  readonly quantityAtoms: bigint
  readonly protection: ProtectionOrderState
  readonly exitDue: boolean
  readonly observedAt: string
}): PositionProtectionAction => {
  const { plan, entry, quantityAtoms, protection } = input
  if (protection._tag === 'Unknown') return { _tag: 'Recover', intentId: protection.intentId }
  if (protection._tag === 'Canceling') return { _tag: 'Wait', reason: 'CANCEL_PENDING' }
  if (entry._tag === 'Working')
    return quantityAtoms > 0n || input.exitDue
      ? { _tag: 'CancelEntry', intentId: entry.intentId }
      : { _tag: 'Wait', reason: 'ENTRY_UNFILLED' }
  if (quantityAtoms <= 0n)
    return protection._tag === 'Armed'
      ? { _tag: 'CancelProtection', intentId: protection.intentId }
      : quantityAtoms < 0n
        ? { _tag: 'Block', reason: 'NEGATIVE_POSITION' }
        : { _tag: 'Complete' }
  if (quantityAtoms > BigInt(plan.maximumQuantityAtoms)) return { _tag: 'Block', reason: 'UNBOUND_POSITION' }
  const available = alpacaEntryProtectionMethod(plan.levels.symbol, quantityAtoms, input.observedAt)
  if (protection._tag === 'Armed') {
    const targetMatches =
      protection.method === 'STOP_LIMIT'
        ? protection.profitLimitPriceMicros === null
        : protection.profitLimitPriceMicros === BigInt(plan.levels.profitLimitPriceMicros)
    const exact =
      (available === 'BRACKET' ? protection.method !== 'STOP_LIMIT' : protection.method === 'STOP_LIMIT') &&
      protection.quantityAtoms === quantityAtoms &&
      protection.stopPriceMicros === BigInt(plan.levels.stopPriceMicros) &&
      protection.stopLimitPriceMicros === BigInt(plan.levels.stopLimitPriceMicros) &&
      targetMatches
    if (input.exitDue || !exact || available === 'APPLICATION')
      return { _tag: 'CancelProtection', intentId: protection.intentId }
    return { _tag: 'Wait', reason: 'PROTECTED' }
  }
  if (input.exitDue) return { _tag: 'Liquidate', quantityAtoms }
  if (available === 'APPLICATION') return { _tag: 'Wait', reason: 'APPLICATION_ONLY' }
  return { _tag: 'Arm', method: available === 'BRACKET' ? 'OCO' : 'STOP_LIMIT', quantityAtoms }
}

export const entryBracketProtection = (
  symbol: string,
  quantityAtoms: string,
  observedAt: string,
  plan: JevFundedExitPlan | undefined,
) => {
  if (plan === undefined || alpacaEntryProtectionMethod(symbol, BigInt(quantityAtoms), observedAt) !== 'BRACKET')
    return undefined
  return {
    _tag: 'Bracket' as const,
    stopPriceMicros: plan.levels.stopPriceMicros,
    stopLimitPriceMicros: plan.levels.stopLimitPriceMicros,
    profitLimitPriceMicros: plan.levels.profitLimitPriceMicros,
  }
}
