import * as Schema from 'effect/Schema'

const NonEmptyString = Schema.String.pipe(Schema.minLength(1))
const NonNegativeNumber = Schema.Number.pipe(Schema.int(), Schema.greaterThanOrEqualTo(0))
const PositiveNumber = Schema.Number.pipe(Schema.int(), Schema.greaterThanOrEqualTo(1))
const OutputBytes = Schema.Number.pipe(Schema.int(), Schema.greaterThanOrEqualTo(1024)).annotations({
  description: 'Per-stream reply page cap in bytes. Default: 20000. Server cap: 1048576. Retention is independent.',
})
const TimeoutSeconds = Schema.Number.pipe(Schema.int(), Schema.greaterThanOrEqualTo(1)).annotations({
  description: 'Timeout in seconds. Default: 60. Server cap: 1800.',
})
const SessionId = NonEmptyString.annotations({ description: 'Repo session id returned by repo_session_open.' })
const Cursor = NonEmptyString.pipe(Schema.maxLength(512))
const WaitMs = NonNegativeNumber.pipe(Schema.lessThanOrEqualTo(30_000)).annotations({
  description: 'Wait for completion or new output, up to 30000 ms. Exec defaults to 1000; read defaults to 0.',
})
const ReplyBytes = PositiveNumber.pipe(
  Schema.greaterThanOrEqualTo(4096),
  Schema.lessThanOrEqualTo(1_048_576),
).annotations({
  description: 'Total serialized MCP reply budget, including metadata and both streams. Default: 20000.',
})

export const EmptyInputSchema = Schema.Struct({}).annotations({
  jsonSchema: {
    type: 'object',
    properties: {},
    additionalProperties: false,
  },
})

export const CommandResultSchema = Schema.Struct({
  ok: Schema.Boolean,
  commandPreview: Schema.String,
  commandHash: Schema.String,
  jobId: Schema.String,
  taskId: Schema.String,
  sessionId: Schema.NullOr(Schema.String),
  cwd: Schema.String,
  exitCode: Schema.NullOr(Schema.Number.pipe(Schema.int())),
  signal: Schema.NullOr(Schema.String),
  timedOut: Schema.Boolean,
  stdout: Schema.String,
  stderr: Schema.String,
  stdoutBytes: Schema.Number.pipe(Schema.int()),
  stderrBytes: Schema.Number.pipe(Schema.int()),
  stdoutTruncated: Schema.Boolean,
  stderrTruncated: Schema.Boolean,
  outputCaptureError: Schema.NullOr(Schema.String),
  auditErrors: NonNegativeNumber,
  captureIncomplete: Schema.Boolean,
})

const JobIdentityFields = {
  jobId: Schema.String,
  sessionId: Schema.NullOr(Schema.String),
  taskId: Schema.String,
  agentId: Schema.NullOr(Schema.String),
  requestKey: Schema.String,
  requestId: Schema.NullOr(Schema.String),
  toolCallId: Schema.NullOr(Schema.String),
  commandPreview: Schema.String,
  commandHash: Schema.String,
  cwd: Schema.String,
  startedAt: Schema.String,
  stdoutBytes: NonNegativeNumber,
  stderrBytes: NonNegativeNumber,
  stdoutRetentionStartByte: NonNegativeNumber,
  stderrRetentionStartByte: NonNegativeNumber,
  outputCaptureError: Schema.NullOr(Schema.String),
  auditErrors: NonNegativeNumber,
  captureIncomplete: Schema.Boolean,
}
const RunningFields = {
  state: Schema.Literal('running'),
  ok: Schema.Null,
  exitCode: Schema.Null,
  signal: Schema.Null,
  finishedAt: Schema.Null,
  expiresAt: Schema.Null,
}
const CompletedFields = {
  state: Schema.Literal('exited', 'cancelled', 'timed_out'),
  ok: Schema.Boolean,
  exitCode: Schema.NullOr(Schema.Number.pipe(Schema.int())),
  signal: Schema.NullOr(Schema.String),
  finishedAt: Schema.String,
  expiresAt: Schema.String,
}
const OutputFields = {
  stdout: Schema.String,
  stderr: Schema.String,
  stdoutStartOffset: NonNegativeNumber,
  stderrStartOffset: NonNegativeNumber,
  stdoutNextOffset: NonNegativeNumber,
  stderrNextOffset: NonNegativeNumber,
  stdoutHasMore: Schema.Boolean,
  stderrHasMore: Schema.Boolean,
  stdoutTruncated: Schema.Boolean,
  stderrTruncated: Schema.Boolean,
  cursor: Cursor,
  outputEncoding: Schema.Literal('utf8', 'base64'),
  maxBytes: ReplyBytes,
}
export const JobMetadataSchema = Schema.Union(
  Schema.Struct({ ...JobIdentityFields, ...RunningFields }),
  Schema.Struct({ ...JobIdentityFields, ...CompletedFields }),
)
export const ExecutionOutputSchema = Schema.Union(
  Schema.Struct({ ...JobIdentityFields, ...RunningFields, ...OutputFields }),
  Schema.Struct({ ...JobIdentityFields, ...CompletedFields, ...OutputFields }),
)

export const ExecInputSchema = Schema.Struct({
  outputEncoding: Schema.optional(Schema.Literal('utf8', 'base64')),
  requestKey: NonEmptyString.pipe(Schema.maxLength(128)).annotations({
    description:
      'Unique key for this execution. Retry the same key and command after an uncertain response; retries return the same job for one hour after completion.',
  }),
  agentId: Schema.optional(
    NonEmptyString.pipe(Schema.maxLength(128)).annotations({
      description: 'Advisory agent/task label, not an authorization identity.',
    }),
  ),
  command: NonEmptyString.annotations({
    description:
      'User-requested terminal command line executed inside the private agents-shell workspace container. The tool returns output only.',
  }),
  cwd: Schema.optional(
    Schema.String.annotations({
      description: 'Working directory; relative to the repo session when sessionId is set.',
    }),
  ),
  sessionId: Schema.optional(SessionId),
  timeoutSeconds: Schema.optional(TimeoutSeconds),
  waitMs: Schema.optional(WaitMs),
  maxBytes: Schema.optional(ReplyBytes),
})

export const SearchInputSchema = Schema.Struct({
  query: NonEmptyString,
  path: Schema.optional(Schema.String),
  sessionId: Schema.optional(SessionId),
  fixedStrings: Schema.optional(Schema.Boolean),
  caseSensitive: Schema.optional(Schema.Boolean),
  maxOutputBytes: Schema.optional(OutputBytes),
})

export const ReadFileInputSchema = Schema.Struct({
  path: NonEmptyString,
  sessionId: Schema.optional(SessionId),
  maxBytes: Schema.optional(PositiveNumber),
})

export const ReadFileOutputSchema = Schema.Struct({
  path: Schema.String,
  content: Schema.String,
  bytes: Schema.Number.pipe(Schema.int()),
  truncated: Schema.Boolean,
})

export const ApplyPatchInputSchema = Schema.Struct({
  patch: NonEmptyString,
  cwd: Schema.optional(
    Schema.String.annotations({ description: 'Working directory relative to the owned repo session.' }),
  ),
  sessionId: SessionId,
  timeoutSeconds: Schema.optional(TimeoutSeconds),
  maxOutputBytes: Schema.optional(OutputBytes),
})

export const ApplyPatchOutputSchema = Schema.extend(
  CommandResultSchema,
  Schema.Struct({
    changedFiles: Schema.Array(Schema.String),
  }),
)

export const AgentGuideOutputSchema = Schema.Struct({
  guide: Schema.String,
})

export const ReadInputSchema = Schema.Struct({
  outputEncoding: Schema.optional(Schema.Literal('utf8', 'base64')),
  jobId: NonEmptyString.annotations({ description: 'Job id returned by exec.' }),
  cursor: Cursor.annotations({
    description: 'Cursor from the last exec/read reply. Continue from both streams without repeating output.',
  }),
  waitMs: Schema.optional(WaitMs),
  maxBytes: Schema.optional(ReplyBytes),
})

export const CancelInputSchema = Schema.Struct({
  jobId: NonEmptyString.annotations({
    description:
      'Job id returned by exec. Sends SIGTERM, then SIGKILL if necessary, and returns the completion receipt.',
  }),
})

export const StatusInputSchema = Schema.Struct({
  sessionId: Schema.optional(SessionId),
  agentId: Schema.optional(NonEmptyString),
  jobId: Schema.optional(Schema.String),
  limit: Schema.optional(PositiveNumber.pipe(Schema.lessThanOrEqualTo(100))),
  cursor: Schema.optional(Cursor),
})

export const StatusOutputSchema = Schema.Struct({
  jobs: Schema.Array(JobMetadataSchema),
  cursor: Schema.NullOr(Cursor),
  hasMore: Schema.Boolean,
})

export const CliInputSchema = Schema.Struct({
  args: Schema.Array(Schema.String).pipe(Schema.minItems(1)).annotations({
    description: 'Arguments passed to the executable, excluding the executable name.',
  }),
  cwd: Schema.optional(Schema.String),
  sessionId: Schema.optional(SessionId),
  timeoutSeconds: Schema.optional(TimeoutSeconds),
  maxOutputBytes: Schema.optional(OutputBytes),
})

export const GitWriteInputSchema = Schema.Struct({ ...CliInputSchema.fields, sessionId: SessionId })

export const RepoSessionOpenInputSchema = Schema.Struct({
  name: Schema.optional(
    NonEmptyString.annotations({ description: 'Short name used in the generated branch and worktree.' }),
  ),
  baseBranch: Schema.optional(NonEmptyString.annotations({ description: 'Remote base branch. Defaults to main.' })),
})

export const RepoSessionInputSchema = Schema.Struct({
  sessionId: SessionId,
})

export const RepoSessionCloseInputSchema = Schema.Struct({
  sessionId: SessionId,
  force: Schema.optional(Schema.Boolean),
})

export const RepoSessionStatusSchema = Schema.Struct({
  sessionId: Schema.String,
  taskId: Schema.String,
  branch: Schema.String,
  baseBranch: Schema.String,
  baseSha: Schema.String,
  headSha: Schema.String,
  worktree: Schema.String,
  createdAt: Schema.String,
  dirty: Schema.Boolean,
  ahead: Schema.Number.pipe(Schema.int()),
  behind: Schema.Number.pipe(Schema.int()),
})

export const RepoSessionCloseOutputSchema = Schema.extend(
  RepoSessionStatusSchema,
  Schema.Struct({ closedAt: Schema.String }),
)

export const AgentStartInputSchema = Schema.Struct({
  task: NonEmptyString.annotations({ description: 'Complete task prompt for the delegated coding agent.' }),
  headBranch: Schema.optional(
    NonEmptyString.annotations({ description: 'Optional branch name. Defaults to codex/<generated-name>.' }),
  ),
  baseBranch: Schema.optional(NonEmptyString.annotations({ description: 'Base branch. Defaults to main.' })),
  repository: Schema.optional(
    NonEmptyString.annotations({ description: 'Repository in owner/name form. Defaults to proompteng/lab.' }),
  ),
  agentName: Schema.optional(
    NonEmptyString.annotations({ description: 'Agent resource name. Defaults to codex-agent.' }),
  ),
  tokenBudget: Schema.optional(PositiveNumber),
  ttlSecondsAfterFinished: Schema.optional(NonNegativeNumber),
  acceptanceCriteria: Schema.optional(Schema.Array(NonEmptyString).pipe(Schema.maxItems(50))),
  timeoutSeconds: Schema.optional(TimeoutSeconds),
  maxOutputBytes: Schema.optional(OutputBytes),
})

export const AgentStartOutputSchema = Schema.Struct({
  ok: Schema.Boolean,
  agentRunName: Schema.String,
  namespace: Schema.String,
  repository: Schema.String,
  baseBranch: Schema.String,
  headBranch: Schema.String,
  apply: CommandResultSchema,
})

export const AgentNameInputSchema = Schema.Struct({
  agentRunName: NonEmptyString,
  namespace: Schema.optional(NonEmptyString),
  timeoutSeconds: Schema.optional(TimeoutSeconds),
  maxOutputBytes: Schema.optional(OutputBytes),
})

export const AgentStatusOutputSchema = Schema.Struct({
  ok: Schema.Boolean,
  agentRunName: Schema.String,
  namespace: Schema.String,
  agentRun: Schema.NullOr(Schema.Unknown),
  jobs: Schema.NullOr(Schema.Unknown),
  getAgentRun: CommandResultSchema,
  getJobs: CommandResultSchema,
})

export const AgentReadInputSchema = Schema.Struct({
  agentRunName: NonEmptyString,
  namespace: Schema.optional(NonEmptyString),
  tailLines: Schema.optional(PositiveNumber.pipe(Schema.lessThanOrEqualTo(5000))),
  timeoutSeconds: Schema.optional(TimeoutSeconds),
  maxOutputBytes: Schema.optional(OutputBytes),
})

export type SearchInput = typeof SearchInputSchema.Type
export type ReadFileInput = typeof ReadFileInputSchema.Type
export type ApplyPatchInput = typeof ApplyPatchInputSchema.Type
export type ExecInput = typeof ExecInputSchema.Type
export type ReadInput = typeof ReadInputSchema.Type
export type CancelInput = typeof CancelInputSchema.Type
export type StatusInput = typeof StatusInputSchema.Type
export type CliInput = typeof CliInputSchema.Type
export type GitWriteInput = typeof GitWriteInputSchema.Type
export type RepoSessionOpenInput = typeof RepoSessionOpenInputSchema.Type
export type RepoSessionInput = typeof RepoSessionInputSchema.Type
export type RepoSessionCloseInput = typeof RepoSessionCloseInputSchema.Type
export type AgentStartInput = typeof AgentStartInputSchema.Type
export type AgentNameInput = typeof AgentNameInputSchema.Type
export type AgentReadInput = typeof AgentReadInputSchema.Type
