import { Schema } from 'effect'

import { JevBatchResultSchema } from '../jev/batch'
import { JevStudyBatchPlanSchema, JevStudyObservationSchema } from '../jev/study-evidence'
import {
  ExecutionDecisionDocumentSchema,
  RetainedJevV38ExecutionDecisionDocumentSchema,
} from '../shadow-decision-contract'
import { IsoDateSchema } from '../schemas'
import { SystemSourceCutSchema } from './source-cut'

// Only historical operational reads use this schema. Current source persistence keeps SystemSourceCutSchema.
export const RecordedSystemSourceCutSchema = Schema.Struct({
  ...SystemSourceCutSchema.fields,
  decisions: Schema.Array(
    Schema.Struct({
      sessionDate: IsoDateSchema,
      document: Schema.Union([ExecutionDecisionDocumentSchema, RetainedJevV38ExecutionDecisionDocumentSchema]),
    }),
  ),
  batches: Schema.Array(
    Schema.Struct({
      plan: JevStudyBatchPlanSchema,
      observation: Schema.NullOr(JevStudyObservationSchema),
      result: Schema.NullOr(JevBatchResultSchema),
    }),
  ),
})
export type RecordedSystemSourceCut = typeof RecordedSystemSourceCutSchema.Type
