import { Result } from 'effect'

import { JevContractError } from './contract'
import { jevProtectiveQuoteIsFresh, reproducePositionQuote } from './exit'
import { isShortExitPlan } from '../strategy/funded-exit-plan'
import type { ProtectedEntryTarget } from '../strategy/runtime-decision'
import { jevEntryQuoteExclusion } from './trading-signals'
import type { IntradayQuote } from '../market-data/intraday/model'
import { priceNumberToMicros } from '../strategy/execution-model/fixed-point'
import { compareIntradayInstants } from '../market-data/intraday/time'

export const jevEligibleEntryBoundaryCrossed = (
  levels: { readonly short: boolean; readonly stopPriceMicros: string; readonly profitLimitPriceMicros: string },
  quote: IntradayQuote,
) =>
  Result.gen(function* () {
    // A one-sided IEX widening is not an actionable entry quote, even when its near side touches a boundary.
    if ((yield* jevEntryQuoteExclusion(quote)) !== null) return false
    const price = yield* priceNumberToMicros(
      levels.short ? quote.askPrice : quote.bidPrice,
      levels.short ? 'ask' : 'bid',
      levels.short ? 'UP' : 'DOWN',
    )
    return levels.short
      ? price >= BigInt(levels.stopPriceMicros) || price <= BigInt(levels.profitLimitPriceMicros)
      : price <= BigInt(levels.stopPriceMicros) || price >= BigInt(levels.profitLimitPriceMicros)
  })

/** Cancellation only: reuse the entry's original closing-side stop and target boundaries. */
export const jevPendingEntryBoundaryCrossed = (
  target: ProtectedEntryTarget,
  symbol: string,
  observedAt: string,
  evaluatedAt: string,
  source: Parameters<typeof reproducePositionQuote>[1],
) =>
  Result.gen(function* () {
    const plan = target.exitPolicy.plans[symbol]
    if (plan === undefined || !target.selectedSymbols.includes(symbol))
      return yield* Result.fail(new JevContractError({ message: 'Pending entry requires its selected funded plan' }))
    const protocol = target.evidence.observation.protocol
    const short = isShortExitPlan(plan)
    const { quote } = yield* reproducePositionQuote(
      {
        protocol,
        sessionDate: target.sessionDate,
        observedAt,
        symbol,
        ...(short ? { positionSide: 'SHORT' as const } : {}),
      },
      source,
    )
    if (
      observedAt < target.evidence.decidedAt ||
      evaluatedAt < observedAt ||
      compareIntradayInstants(quote.eventAt, observedAt) > 0
    )
      return yield* Result.fail(
        new JevContractError({ message: 'Pending entry cancellation evidence cannot precede its decision or quote' }),
      )
    if (!jevProtectiveQuoteIsFresh(quote, evaluatedAt, protocol.maximumQuoteAgeMs)) return false
    return yield* jevEligibleEntryBoundaryCrossed({ ...plan.levels, short }, quote)
  })
