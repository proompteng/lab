import { Result, Schema } from 'effect'

import { NonNegativeIntegerSchema, PositiveIntegerSchema, UtcInstantSchema } from '../../schemas'
import { MarketFeatureDefinition } from '../features/contract'

export enum InputReadinessReason {
  AllCandidatesExcluded = 'ALL_CANDIDATES_EXCLUDED',
}

/** Fixed-size evidence about the rejected observation, not current consumer health or upstream receipt. */
export const InputReadinessSchema = Schema.Struct({
  reason: Schema.Enum(InputReadinessReason),
  observedAt: UtcInstantSchema,
  windowStartAt: UtcInstantSchema,
  windowEndAt: UtcInstantSchema,
  requiredFeatureDefinition: Schema.optionalKey(Schema.Literal(MarketFeatureDefinition.ObservedPriceWindow)),
  candidateCount: PositiveIntegerSchema.check(Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER)),
  matchingFeatureCandidateCount: NonNegativeIntegerSchema,
  completedBarCandidateCount: NonNegativeIntegerSchema,
}).check(
  Schema.makeFilter(
    (value) =>
      value.matchingFeatureCandidateCount <= value.candidateCount &&
      value.completedBarCandidateCount <= value.candidateCount &&
      Date.parse(value.windowStartAt) < Date.parse(value.windowEndAt) &&
      Date.parse(value.windowEndAt) <= Date.parse(value.observedAt),
    { expected: 'counts bounded by the candidate cohort and a completed observed window' },
  ),
)

export const decodeInputReadiness = (value: unknown) => {
  const decoded = Schema.decodeUnknownResult(InputReadinessSchema)(value)
  return Result.isSuccess(decoded) ? decoded.success : undefined
}
