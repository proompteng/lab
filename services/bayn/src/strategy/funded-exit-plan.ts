import { Schema } from 'effect'

import { JevFundedExitPlanSchema } from '../jev/strategy-exit-plan'
import { MomentumFundedExitPlanSchema } from './repeated-momentum/exit-plan'

/** Both entry policies fund the same executable protection and position-management lifecycle. */
export const FundedEntryExitPlanSchema = Schema.Union([JevFundedExitPlanSchema, MomentumFundedExitPlanSchema])
export type FundedEntryExitPlan = typeof FundedEntryExitPlanSchema.Type
