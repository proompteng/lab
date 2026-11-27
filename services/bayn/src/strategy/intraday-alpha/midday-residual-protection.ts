import { Result } from 'effect'

import { JevContractError } from '../../jev/contract'

interface MiddayBasketLeg {
  readonly symbol: string
  readonly direction: 'LONG' | 'SHORT'
  readonly intendedShares: bigint
  readonly filledShares: bigint
  readonly openShares: bigint
  readonly workingEntry: boolean
  readonly markPriceMicros: bigint | null
}

export const evaluateMiddayResidualProtection = (legs: readonly MiddayBasketLeg[]) =>
  Result.gen(function* () {
    if (
      legs.length !== 4 ||
      new Set(legs.map((leg) => leg.symbol)).size !== 4 ||
      legs.filter((leg) => leg.direction === 'LONG').length !== 2 ||
      legs.filter((leg) => leg.direction === 'SHORT').length !== 2 ||
      legs.some(
        (leg) =>
          leg.intendedShares <= 0n ||
          leg.filledShares > leg.intendedShares ||
          leg.openShares < 0n ||
          leg.openShares > leg.filledShares ||
          (leg.workingEntry && leg.filledShares === leg.intendedShares),
      )
    )
      return yield* Result.fail(
        new JevContractError({
          message: 'Midday protection requires a 2L+2S basket with exact fill and open quantities',
        }),
      )

    const ordered = legs.toSorted((a, b) => a.symbol.localeCompare(b.symbol, 'en'))
    let longNotionalMicros = 0n
    let shortNotionalMicros = 0n
    let missingMark = false
    for (const leg of ordered) {
      if (leg.openShares === 0n) continue
      if (leg.markPriceMicros === null || leg.markPriceMicros <= 0n) {
        missingMark = true
        break
      }
      if (leg.direction === 'LONG') longNotionalMicros += leg.openShares * leg.markPriceMicros
      else shortNotionalMicros += leg.openShares * leg.markPriceMicros
    }
    const signedNotionalMicros = longNotionalMicros - shortNotionalMicros
    const exposure = missingMark ? null : { longNotionalMicros, shortNotionalMicros, signedNotionalMicros }

    const cancelSymbols = ordered.filter((leg) => leg.workingEntry).map((leg) => leg.symbol)
    if (cancelSymbols.length > 0) return { action: 'CANCEL_AND_RECONCILE' as const, cancelSymbols, exposure }
    if (exposure === null)
      return yield* Result.fail(
        new JevContractError({ message: 'Midday residual evaluation requires positive open marks' }),
      )
    if (ordered.every((leg) => leg.filledShares === leg.intendedShares))
      return { action: 'KEEP_COMPLETE' as const, exposure }

    const excessDirection = signedNotionalMicros >= 0n ? 'LONG' : 'SHORT'
    let excess = signedNotionalMicros >= 0n ? signedNotionalMicros : -signedNotionalMicros
    const trims = []
    for (const leg of ordered) {
      if (leg.direction !== excessDirection || leg.openShares === 0n || leg.markPriceMicros === null) continue
      // Only reduce the heavier side, never cross zero. Whole-share rounding is left explicit.
      const shares = excess / leg.markPriceMicros
      const quantity = shares < leg.openShares ? shares : leg.openShares
      if (quantity === 0n) continue
      trims.push({
        symbol: leg.symbol,
        side: excessDirection === 'LONG' ? ('SELL' as const) : ('BUY' as const),
        shares: quantity,
      })
      excess -= quantity * leg.markPriceMicros
    }
    return {
      action: trims.length > 0 ? ('TRIM_REDUCE_ONLY' as const) : ('NO_TRIM' as const),
      exposure,
      trims,
      modeledSignedNotionalAfterTrimMicros: excessDirection === 'LONG' ? excess : -excess,
    }
  })
