import { Result } from 'effect'

import { jevManagedExitPlan, type JevManagedPortfolio } from './portfolio'
import { isShortExitPlan } from '../strategy/funded-exit-plan'

export const jevProfitTargetCrossed = (portfolio: JevManagedPortfolio, bidMicros: bigint) =>
  jevManagedExitPlan(portfolio).pipe(
    Result.map((plan) =>
      isShortExitPlan(plan)
        ? bidMicros <= BigInt(plan.levels.profitLimitPriceMicros)
        : bidMicros >= BigInt(plan.levels.profitLimitPriceMicros),
    ),
  )

export const jevProfitTargetBid = (portfolio: JevManagedPortfolio) =>
  jevManagedExitPlan(portfolio).pipe(Result.map((plan) => BigInt(plan.levels.profitLimitPriceMicros)))
