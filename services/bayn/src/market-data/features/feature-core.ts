import { Data, Schema } from 'effect'

export const marketFeatureClockSkewAllowanceMs = 5000

export const FeatureIntegerSchema = Schema.String.check(Schema.isPattern(/^(?:0|[1-9][0-9]*)$/))
export const FeatureHashSchema = Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/))
export const FeatureSafeIntegerSchema = Schema.Int.check(
  Schema.isBetween({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
)
export const FeatureIdentitySchema = Schema.String.check(Schema.isPattern(/^[a-z0-9]+(?:[.-][a-z0-9]+)*$/))

export const MarketFeatureInputSchema = Schema.Struct({
  eventTimeNanos: FeatureIntegerSchema,
  ingestionTimeNanos: FeatureIntegerSchema,
  sourceTopic: FeatureIdentitySchema,
  sourcePartition: FeatureSafeIntegerSchema,
  sourceOffset: FeatureIntegerSchema,
  contentHash: FeatureHashSchema,
})

export class MarketFeatureFailure extends Data.TaggedError('MarketFeatureFailure')<{
  readonly reason: 'schema' | 'identity' | 'window' | 'hash' | 'input'
  readonly message: string
  readonly cause?: unknown
}> {}

export enum TechnicalReadiness {
  Ready = 'READY',
  Warming = 'WARMING',
  Gap = 'GAP',
  SourceMissing = 'SOURCE_MISSING',
  ZeroVolume = 'ZERO_VOLUME',
}

export const TechnicalFeatureValueSchema = Schema.Struct({
  status: Schema.Enum(TechnicalReadiness),
  value: Schema.NullOr(Schema.String.check(Schema.isPattern(/^(?:0|-?[1-9][0-9]*)$/))),
})
