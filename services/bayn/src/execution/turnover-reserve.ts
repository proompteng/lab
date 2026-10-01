import { Result } from 'effect'

export enum EntryTurnoverPolicy {
  ImmediateAdjustment = 'IMMEDIATE_ADJUSTMENT',
  EntryAndExpectedExit = 'ENTRY_AND_EXPECTED_EXIT',
}

export interface EntryTurnoverReserveInput {
  readonly filledTurnoverMicros: bigint
  readonly maximumTurnoverMicros: bigint
  /** Other unresolved commitments must stay reserved until their outcome is known. */
  readonly otherReservedMicros: bigint
  readonly quantityMicros: bigint
  readonly entryLimitPriceMicros: bigint
  readonly exitReferencePriceMicros: bigint
  readonly exitAllowanceBps: bigint
}

/** Prospective admission calculation, never an exit gate. Future prices can exceed this explicit estimate. */
export const assessEntryTurnoverReserve = (input: EntryTurnoverReserveInput) => {
  if (
    Object.values(input).some((value) => value < 0n) ||
    input.entryLimitPriceMicros === 0n ||
    input.exitReferencePriceMicros === 0n ||
    input.exitAllowanceBps > 10_000n
  )
    return Result.fail({ _tag: 'InvalidEntryTurnoverReserve' as const })
  const ceil = (numerator: bigint, denominator: bigint) => (numerator + denominator - 1n) / denominator
  const entryMicros = ceil(input.quantityMicros * input.entryLimitPriceMicros, 1_000_000n)
  const exitPriceMicros = ceil(input.exitReferencePriceMicros * (10_000n + input.exitAllowanceBps), 10_000n)
  const expectedExitMicros = ceil(input.quantityMicros * exitPriceMicros, 1_000_000n)
  const projected = input.filledTurnoverMicros + input.otherReservedMicros + entryMicros + expectedExitMicros
  return Result.succeed({
    schemaVersion: 'bayn.entry-turnover-reserve.v1' as const,
    admitted: projected <= input.maximumTurnoverMicros,
    entryMicros,
    expectedExitMicros,
    projectedTurnoverMicros: projected,
    remainingMicros: projected <= input.maximumTurnoverMicros ? input.maximumTurnoverMicros - projected : 0n,
  })
}
