import { Schema } from 'effect'

export const ImplementationCommandSchema = Schema.Struct({
  stage: Schema.Literal('implementation'),
  key: Schema.String,
  agentRun: Schema.Unknown,
})

export type ImplementationCommand = Schema.Schema.Type<typeof ImplementationCommandSchema>

export const ReadyApprovalCommandSchema = Schema.Struct({
  repositoryFullName: Schema.String,
  pullNumber: Schema.Number,
  headSha: Schema.String,
  body: Schema.String,
})

export type ReadyApprovalCommand = Schema.Schema.Type<typeof ReadyApprovalCommandSchema>

export const WorkflowCommandSchema = Schema.Union(
  Schema.Struct({
    type: Schema.Literal('submitImplementation'),
    data: ImplementationCommandSchema,
  }),
  Schema.Struct({
    type: Schema.Literal('approveReadyPullRequest'),
    data: ReadyApprovalCommandSchema,
  }),
)

export type WorkflowCommand = Schema.Schema.Type<typeof WorkflowCommandSchema>
