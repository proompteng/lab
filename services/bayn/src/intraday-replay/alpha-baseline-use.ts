import { Context, Effect, Schema } from 'effect'

import { IsoDateSchema, Sha256Schema, UtcInstantSchema } from '../schemas'
import type { OperationalError } from '../errors'
import type { CandidateObservation } from '../observe-composition/candidate-observation'

/** Scoped only to the current research entry; invoked after commit and before a latency release can fail. */
export class ReplayAlphaObservationCommit extends Context.Service<
  ReplayAlphaObservationCommit,
  {
    readonly record: (observation: CandidateObservation) => Effect.Effect<void, OperationalError>
  }
>()('@proompteng/bayn/intraday-replay/ReplayAlphaObservationCommit') {}

/** Captured by the research owner after the exact observation's durable write succeeds. */
export const ReplayAlphaBaselineUseSchema = Schema.Struct({
  schemaVersion: Schema.Literal('bayn.replay-alpha-baseline-use.v1'),
  observationHash: Sha256Schema,
  cycleId: Sha256Schema,
  authorityGenerationHash: Sha256Schema,
  sessionDate: IsoDateSchema,
  windowEndAt: UtcInstantSchema,
  commandIssuedAt: UtcInstantSchema,
  admissionObservedAt: UtcInstantSchema,
  admissionExpiresAt: UtcInstantSchema,
  sourceObservationHash: Sha256Schema,
  sourceWitnessHash: Sha256Schema,
  baselineHash: Sha256Schema,
})

export type ReplayAlphaBaselineUse = typeof ReplayAlphaBaselineUseSchema.Type
export type ReplayAlphaBaselineAdmissionUse = Omit<ReplayAlphaBaselineUse, 'commandIssuedAt'>

const {
  schemaVersion: _version,
  sourceObservationHash: _observation,
  ...preparedUseFields
} = ReplayAlphaBaselineUseSchema.fields
export const PreparedReplayAlphaBaselineUseSchema = Schema.Struct({
  ...preparedUseFields,
  schemaVersion: Schema.Literal('bayn.replay-alpha-baseline-use.v2'),
  sourcePreparationHash: Sha256Schema,
})
export type PreparedReplayAlphaBaselineUse = typeof PreparedReplayAlphaBaselineUseSchema.Type
export const AnyReplayAlphaBaselineUseSchema = Schema.Union([
  ReplayAlphaBaselineUseSchema,
  PreparedReplayAlphaBaselineUseSchema,
])
export type AnyReplayAlphaBaselineUse = typeof AnyReplayAlphaBaselineUseSchema.Type
export type AnyReplayAlphaBaselineAdmissionUse =
  | ReplayAlphaBaselineAdmissionUse
  | Omit<PreparedReplayAlphaBaselineUse, 'commandIssuedAt'>
