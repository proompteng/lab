import { Schema } from 'effect'

import { Sha256Schema, UtcInstantSchema } from '../schemas'
import { JevPortfolioSchema } from './portfolio'
import { JevProtocolSchema } from './protocol'

export const JevObservationSchema = Schema.Struct({
  schemaVersion: Schema.Literal('bayn.jev-observation.v1'),
  cycleId: Sha256Schema,
  authorityGenerationHash: Sha256Schema,
  observedAt: UtcInstantSchema,
  protocol: JevProtocolSchema,
  portfolio: JevPortfolioSchema,
  manifest: Schema.Record(Schema.String, Schema.Unknown),
  rows: Schema.Struct({
    bars: Schema.Array(Schema.Unknown),
    quotes: Schema.Array(Schema.Unknown),
    trades: Schema.Array(Schema.Unknown),
  }),
})

export type JevObservation = typeof JevObservationSchema.Type
