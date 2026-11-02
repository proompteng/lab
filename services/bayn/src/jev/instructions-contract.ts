import { Schema } from 'effect'

import { StrictNonEmptyStringSchema } from '../schemas'

export const JevInstructionsSchema = Schema.Struct({
  entry: StrictNonEmptyStringSchema.check(Schema.isMaxLength(2000)),
})
export type JevInstructions = typeof JevInstructionsSchema.Type
