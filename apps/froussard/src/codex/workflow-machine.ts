import { Schema } from 'effect'

export const ImplementationCommandSchema = Schema.Struct({
  stage: Schema.Literal('implementation'),
  key: Schema.String,
  codexMessage: Schema.Unknown,
  structuredMessage: Schema.Unknown,
  topics: Schema.Struct({
    codex: Schema.String,
    codexStructured: Schema.String,
  }),
  jsonHeaders: Schema.Unknown,
  structuredHeaders: Schema.Unknown,
})

export type ImplementationCommand = Schema.Schema.Type<typeof ImplementationCommandSchema>

export const ReadyCommentCommandSchema = Schema.Struct({
  repositoryFullName: Schema.String,
  pullNumber: Schema.Number,
  issueNumber: Schema.Number,
  body: Schema.String,
  marker: Schema.String,
})

export type ReadyCommentCommand = Schema.Schema.Type<typeof ReadyCommentCommandSchema>

export const WorkflowCommandSchema = Schema.Union(
  Schema.Struct({
    type: Schema.Literal('publishImplementation'),
    data: ImplementationCommandSchema,
  }),
  Schema.Struct({
    type: Schema.Literal('postReadyComment'),
    data: ReadyCommentCommandSchema,
  }),
)

export type WorkflowCommand = Schema.Schema.Type<typeof WorkflowCommandSchema>
