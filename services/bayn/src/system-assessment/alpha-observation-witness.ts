import { Schema } from 'effect'

import { Sha256Schema, UtcInstantSchema } from '../schemas'
import { IntradayAlphaObservationSchema } from '../strategy/intraday-alpha/observation'

export const AlphaObservationWitnessSchema = Schema.Struct({
  registrationHash: Sha256Schema,
  kind: Schema.Literal('ALPHA_OBSERVATION'),
  sourceHash: Sha256Schema,
  sourceAt: UtcInstantSchema,
  witnessedAt: UtcInstantSchema,
  correct: Schema.Boolean,
})
export type AlphaObservationWitness = typeof AlphaObservationWitnessSchema.Type

export const AlphaBaselineSourceSchema = Schema.Struct({
  observationHash: Sha256Schema,
  payload: IntradayAlphaObservationSchema,
  availableAt: UtcInstantSchema,
  witnessSourceHash: Sha256Schema,
})
export type AlphaBaselineSource = typeof AlphaBaselineSourceSchema.Type
