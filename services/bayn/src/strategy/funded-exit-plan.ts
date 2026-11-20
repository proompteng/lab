import { Schema } from 'effect'

import { JevFundedExitPlanSchema } from '../jev/strategy-exit-plan'
import { MomentumFundedExitPlanSchema } from './repeated-momentum/exit-plan'
import { ShortFundedExitPlanSchema, type ShortFundedExitPlan } from '../jev/short-exit-plan'

/** Both entry policies fund the same executable protection and position-management lifecycle. */
export const FundedEntryExitPlanSchema = Schema.Union([
  JevFundedExitPlanSchema,
  MomentumFundedExitPlanSchema,
  ShortFundedExitPlanSchema,
])
export type FundedEntryExitPlan = typeof FundedEntryExitPlanSchema.Type

export const isShortExitPlan = (plan: FundedEntryExitPlan): plan is ShortFundedExitPlan =>
  plan.schemaVersion === 'bayn.jev-short-funded-exit-plan.v1'
export const entryPlanPriceMicros = (plan: FundedEntryExitPlan): bigint =>
  isShortExitPlan(plan) ? BigInt(plan.levels.minimumEntryPriceMicros) : BigInt(plan.levels.maximumEntryPriceMicros)
