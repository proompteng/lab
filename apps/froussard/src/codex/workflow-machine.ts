import { Schema } from 'effect'

export const ImplementationCommandSchema = Schema.Struct({
  stage: Schema.Literal('implementation'),
  key: Schema.String,
  agentRun: Schema.Unknown,
})

export type ImplementationCommand = typeof ImplementationCommandSchema.Type

export const WorkflowCommandSchema = Schema.Struct({
  type: Schema.Literal('submitImplementation'),
  data: ImplementationCommandSchema,
})

export type WorkflowCommand = typeof WorkflowCommandSchema.Type
