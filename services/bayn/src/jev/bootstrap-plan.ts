import { Result, Schema } from 'effect'

export const BootstrapPlanSchema = Schema.Struct({
  blockLengthSessions: Schema.Int.check(Schema.isGreaterThan(0)),
  replicates: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER })),
  seed: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 4_294_967_295 })),
})

export type BootstrapPlan = typeof BootstrapPlanSchema.Type

export const bootstrapResolutionSupported = (replicates: number, attempt: number, controls: number): boolean =>
  BigInt(replicates) >= 20n * BigInt(controls + 1) * BigInt(attempt) * BigInt(attempt + 1)

export const validateBootstrapPlan = (plan: BootstrapPlan, sessions: number, attempt: number, controls: number) =>
  plan.blockLengthSessions > sessions
    ? Result.fail('Bootstrap block length exceeds the registered calendar')
    : !bootstrapResolutionSupported(plan.replicates, attempt, controls)
      ? Result.fail(
          'Registered bootstrap work budget cannot resolve this attempt; register an adequate budget before evaluation',
        )
      : Result.succeed(plan)

export const NumericalAssessmentTermsSchema = Schema.Struct({
  allocationUsd: Schema.Finite.check(Schema.isGreaterThan(0)),
  maximumSessionLossUsd: Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0)),
  maximumDrawdownUsd: Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0)),
  maximumMarkGapMs: Schema.Int.check(Schema.isGreaterThan(0)),
  bootstrap: BootstrapPlanSchema,
})

export type NumericalAssessmentTerms = typeof NumericalAssessmentTermsSchema.Type
