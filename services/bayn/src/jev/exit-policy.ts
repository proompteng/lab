import { Schema } from 'effect'

import { PositiveIntegerSchema, SymbolSchema } from '../schemas'
import type { JevProtocol } from './protocol'
import { JevFundedExitPlanSchema, type JevFundedExitPlan } from './strategy-exit-plan'

export const positionProtectionIntervalMs = 5_000 as const

export const JevPositionExitPolicySchema = Schema.Struct({
  schemaVersion: Schema.Literal('bayn.position-exit-policy.v4'),
  maximumPriceCheckIntervalMs: Schema.Literal(positionProtectionIntervalMs),
  maximumHoldingMinutes: PositiveIntegerSchema.check(Schema.isLessThanOrEqualTo(60)),
  plans: Schema.Record(SymbolSchema, JevFundedExitPlanSchema),
})

export const jevPositionExitPolicy = (
  protocol: JevProtocol,
  plans: Readonly<Record<string, JevFundedExitPlan>>,
): typeof JevPositionExitPolicySchema.Type => ({
  schemaVersion: 'bayn.position-exit-policy.v4',
  maximumPriceCheckIntervalMs: positionProtectionIntervalMs,
  maximumHoldingMinutes: protocol.maximumHoldingMinutes,
  plans,
})
