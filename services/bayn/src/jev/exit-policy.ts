import { Schema } from 'effect'

import { PositiveIntegerSchema, SymbolSchema } from '../schemas'
import type { JevProtocol } from './protocol'
import { FundedEntryExitPlanSchema, type FundedEntryExitPlan } from '../strategy/funded-exit-plan'

export const positionProtectionIntervalMs = 5_000 as const

export const JevPositionExitPolicySchema = Schema.Struct({
  schemaVersion: Schema.Literal('bayn.position-exit-policy.v5'),
  maximumPriceCheckIntervalMs: Schema.Literal(positionProtectionIntervalMs),
  maximumHoldingMinutes: PositiveIntegerSchema.check(Schema.isLessThanOrEqualTo(60)),
  plans: Schema.Record(SymbolSchema, FundedEntryExitPlanSchema),
})

export const jevPositionExitPolicy = <Plans extends Readonly<Record<string, FundedEntryExitPlan>>>(
  protocol: JevProtocol,
  plans: Plans,
) => ({
  schemaVersion: 'bayn.position-exit-policy.v5' as const,
  maximumPriceCheckIntervalMs: positionProtectionIntervalMs,
  maximumHoldingMinutes: protocol.maximumHoldingMinutes,
  plans,
})
