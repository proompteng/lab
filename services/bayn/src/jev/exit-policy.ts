import { Schema } from 'effect'

import { SymbolSchema } from '../schemas'
import { JevFundedExitPlanSchema, type JevFundedExitPlan } from './strategy-exit-plan'

export const positionProtectionIntervalMs = 5_000 as const

export const JevPositionExitPolicySchema = Schema.Struct({
  schemaVersion: Schema.Literal('bayn.position-exit-policy.v5'),
  maximumPriceCheckIntervalMs: Schema.Literal(positionProtectionIntervalMs),
  plans: Schema.Record(SymbolSchema, JevFundedExitPlanSchema),
})

export const jevPositionExitPolicy = (
  plans: Readonly<Record<string, JevFundedExitPlan>>,
): typeof JevPositionExitPolicySchema.Type => ({
  schemaVersion: 'bayn.position-exit-policy.v5',
  maximumPriceCheckIntervalMs: positionProtectionIntervalMs,
  plans,
})
