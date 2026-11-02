import { Result } from 'effect'

import { jevManagedExitPlan, type JevManagedPortfolio } from './portfolio'

export const jevProfitTargetCrossed = (portfolio: JevManagedPortfolio, bidMicros: bigint) =>
  jevProfitTargetBid(portfolio).pipe(Result.map((target) => bidMicros >= target))

export const jevProfitTargetBid = (portfolio: JevManagedPortfolio) =>
  jevManagedExitPlan(portfolio).pipe(Result.map((plan) => BigInt(plan.levels.profitLimitPriceMicros)))
