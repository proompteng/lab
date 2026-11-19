import * as Schema from 'effect/Schema'

const NonEmptyString = Schema.String.pipe(Schema.check(Schema.isMinLength(1)))
const NonNegativeNumber = Schema.Number.pipe(
  Schema.check(Schema.isInt()),
  Schema.check(Schema.isGreaterThanOrEqualTo(0)),
)
const PositiveNumber = Schema.Number.pipe(Schema.check(Schema.isInt()), Schema.check(Schema.isGreaterThanOrEqualTo(1)))
const OutputBytes = Schema.Number.pipe(
  Schema.check(Schema.isInt()),
  Schema.check(Schema.isGreaterThanOrEqualTo(1024)),
).annotate({
  description: 'Per-stream reply page cap in bytes. Default: 20000. Server cap: 1048576. Retention is independent.',
})
const TimeoutSeconds = Schema.Number.pipe(
  Schema.check(Schema.isInt()),
  Schema.check(Schema.isGreaterThanOrEqualTo(1)),
).annotate({
  description: 'Timeout in seconds. Default: 60. Server cap: 1800.',
})
const SessionId = NonEmptyString.annotate({ description: 'Repo session id returned by repo_session_open.' })
const Cursor = NonEmptyString.pipe(Schema.check(Schema.isMaxLength(512)))
const WaitMs = NonNegativeNumber.pipe(Schema.check(Schema.isLessThanOrEqualTo(30_000))).annotate({
  description: 'Wait for completion or new output, up to 30000 ms. Exec defaults to 1000; read defaults to 0.',
})
const ReplyBytes = PositiveNumber.pipe(
  Schema.check(Schema.isGreaterThanOrEqualTo(4096)),
  Schema.check(Schema.isLessThanOrEqualTo(1_048_576)),
).annotate({
  description: 'Total serialized MCP reply budget, including metadata and both streams. Default: 20000.',
})

export const EmptyInputSchema = Schema.Record(Schema.String, Schema.Never)

export const CommandResultSchema = Schema.Struct({
  ok: Schema.Boolean,
  commandPreview: Schema.String,
  commandHash: Schema.String,
  jobId: Schema.String,
  taskId: Schema.String,
  sessionId: Schema.NullOr(Schema.String),
  cwd: Schema.String,
  exitCode: Schema.NullOr(Schema.Number.pipe(Schema.check(Schema.isInt()))),
  signal: Schema.NullOr(Schema.String),
  timedOut: Schema.Boolean,
  stdout: Schema.String,
  stderr: Schema.String,
  stdoutBytes: Schema.Number.pipe(Schema.check(Schema.isInt())),
  stderrBytes: Schema.Number.pipe(Schema.check(Schema.isInt())),
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
  state: Schema.Literals(['exited', 'cancelled', 'timed_out']),
  ok: Schema.Boolean,
  exitCode: Schema.NullOr(Schema.Number.pipe(Schema.check(Schema.isInt()))),
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
  outputEncoding: Schema.Literals(['utf8', 'base64']),
  maxBytes: ReplyBytes,
}
export const JobMetadataSchema = Schema.Union([
  Schema.Struct({ ...JobIdentityFields, ...RunningFields }),
  Schema.Struct({ ...JobIdentityFields, ...CompletedFields }),
])
export const ExecutionOutputSchema = Schema.Union([
  Schema.Struct({ ...JobIdentityFields, ...RunningFields, ...OutputFields }),
  Schema.Struct({ ...JobIdentityFields, ...CompletedFields, ...OutputFields }),
])

export const ExecInputSchema = Schema.Struct({
  outputEncoding: Schema.optionalKey(Schema.Literals(['utf8', 'base64'])),
  requestKey: NonEmptyString.pipe(Schema.check(Schema.isMaxLength(128))).annotate({
    description:
      'Unique key for this execution. Retry the same key and command after an uncertain response; retries return the same job for one hour after completion.',
  }),
  agentId: Schema.optionalKey(
    NonEmptyString.pipe(Schema.check(Schema.isMaxLength(128))).annotate({
      description: 'Advisory agent/task label, not an authorization identity.',
    }),
  ),
  command: NonEmptyString.annotate({
    description:
      'User-requested terminal command line executed inside the private agents-shell workspace container. The tool returns output only.',
  }),
  cwd: Schema.optionalKey(
    Schema.String.annotate({
      description: 'Working directory relative to the owned repo session.',
    }),
  ),
  sessionId: SessionId,
  timeoutSeconds: Schema.optionalKey(TimeoutSeconds),
  waitMs: Schema.optionalKey(WaitMs),
  maxBytes: Schema.optionalKey(ReplyBytes),
})

export const SearchInputSchema = Schema.Struct({
  query: NonEmptyString,
  path: Schema.optionalKey(Schema.String),
  sessionId: Schema.optionalKey(SessionId),
  fixedStrings: Schema.optionalKey(Schema.Boolean),
  caseSensitive: Schema.optionalKey(Schema.Boolean),
  maxOutputBytes: Schema.optionalKey(OutputBytes),
})

export const ReadFileInputSchema = Schema.Struct({
  path: NonEmptyString,
  sessionId: Schema.optionalKey(SessionId),
  maxBytes: Schema.optionalKey(PositiveNumber),
})

export const ReadFileOutputSchema = Schema.Struct({
  path: Schema.String,
  content: Schema.String,
  bytes: Schema.Number.pipe(Schema.check(Schema.isInt())),
  truncated: Schema.Boolean,
})

export const ApplyPatchInputSchema = Schema.Struct({
  patch: NonEmptyString,
  cwd: Schema.optionalKey(
    Schema.String.annotate({ description: 'Working directory relative to the owned repo session.' }),
  ),
  sessionId: SessionId,
  timeoutSeconds: Schema.optionalKey(TimeoutSeconds),
  maxOutputBytes: Schema.optionalKey(OutputBytes),
})

export const ApplyPatchOutputSchema = Schema.Struct({
  ...CommandResultSchema.fields,
  changedFiles: Schema.Array(Schema.String),
})

export const AgentGuideOutputSchema = Schema.Struct({
  guide: Schema.String,
})

export const ReadInputSchema = Schema.Struct({
  outputEncoding: Schema.optionalKey(Schema.Literals(['utf8', 'base64'])),
  jobId: NonEmptyString.annotate({ description: 'Job id returned by exec.' }),
  cursor: Cursor.annotate({
    description: 'Cursor from the last exec/read reply. Continue from both streams without repeating output.',
  }),
  waitMs: Schema.optionalKey(WaitMs),
  maxBytes: Schema.optionalKey(ReplyBytes),
})

export const CancelInputSchema = Schema.Struct({
  jobId: NonEmptyString.annotate({
    description:
      'Job id returned by exec. Sends SIGTERM, then SIGKILL if necessary, and returns the completion receipt.',
  }),
})

export const StatusInputSchema = Schema.Struct({
  sessionId: Schema.optionalKey(SessionId),
  agentId: Schema.optionalKey(NonEmptyString),
  jobId: Schema.optionalKey(Schema.String),
  limit: Schema.optionalKey(PositiveNumber.pipe(Schema.check(Schema.isLessThanOrEqualTo(100)))),
  cursor: Schema.optionalKey(Cursor),
})

export const StatusOutputSchema = Schema.Struct({
  jobs: Schema.Array(JobMetadataSchema),
  cursor: Schema.NullOr(Cursor),
  hasMore: Schema.Boolean,
})

export const CliInputSchema = Schema.Struct({
  args: Schema.Array(Schema.String)
    .pipe(Schema.check(Schema.isMinLength(1)))
    .annotate({
      description: 'Arguments passed to the executable, excluding the executable name.',
    }),
  cwd: Schema.optionalKey(Schema.String),
  sessionId: Schema.optionalKey(SessionId),
  timeoutSeconds: Schema.optionalKey(TimeoutSeconds),
  maxOutputBytes: Schema.optionalKey(OutputBytes),
})

export const GitWriteInputSchema = Schema.Struct({ ...CliInputSchema.fields, sessionId: SessionId })

export const RepoSessionOpenInputSchema = Schema.Struct({
  name: Schema.optionalKey(
    NonEmptyString.annotate({ description: 'Short name used in the generated branch and worktree.' }),
  ),
  baseBranch: Schema.optionalKey(NonEmptyString.annotate({ description: 'Remote base branch. Defaults to main.' })),
})

export const RepoSessionInputSchema = Schema.Struct({
  sessionId: SessionId,
})

export const RepoSessionCloseInputSchema = Schema.Struct({
  sessionId: SessionId,
  force: Schema.optionalKey(Schema.Boolean),
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
  ahead: Schema.Number.pipe(Schema.check(Schema.isInt())),
  behind: Schema.Number.pipe(Schema.check(Schema.isInt())),
})

export const RepoSessionCloseOutputSchema = Schema.Struct({
  ...RepoSessionStatusSchema.fields,
  closedAt: Schema.String,
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
