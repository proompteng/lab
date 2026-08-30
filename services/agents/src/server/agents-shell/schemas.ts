import * as Schema from 'effect/Schema'

const NonEmptyString = Schema.String.pipe(Schema.minLength(1))
const NonNegativeNumber = Schema.Number.pipe(Schema.int(), Schema.greaterThanOrEqualTo(0))
const PositiveNumber = Schema.Number.pipe(Schema.int(), Schema.greaterThanOrEqualTo(1))
const OutputBytes = Schema.Number.pipe(Schema.int(), Schema.greaterThanOrEqualTo(1024)).annotations({
  description: 'Per-stream output tail cap in bytes. Default: 20000. Server cap: 200000.',
})
const TimeoutSeconds = Schema.Number.pipe(Schema.int(), Schema.greaterThanOrEqualTo(1)).annotations({
  description: 'Timeout in seconds. Default: 60. Server cap: 1800.',
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
  command: Schema.String,
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
})

export const ShellJobSchema = Schema.extend(
  CommandResultSchema,
  Schema.Struct({
    jobId: Schema.String,
    status: Schema.Literal('running', 'exited', 'killed', 'timed_out'),
    startedAt: Schema.String,
    finishedAt: Schema.NullOr(Schema.String),
    stdoutRetentionStartByte: Schema.Number.pipe(Schema.int()),
    stderrRetentionStartByte: Schema.Number.pipe(Schema.int()),
    stdoutNextOffset: Schema.Number.pipe(Schema.int()),
    stderrNextOffset: Schema.Number.pipe(Schema.int()),
  }),
)

export const ShellInputSchema = Schema.Struct({
  command: NonEmptyString.annotations({
    description:
      'User-requested terminal command line executed inside the private agents-shell workspace container. The tool returns output only.',
  }),
  cwd: Schema.optional(
    Schema.String.annotations({ description: 'Working directory under /workspace. Defaults to /workspace.' }),
  ),
  timeoutSeconds: Schema.optional(TimeoutSeconds),
  maxOutputBytes: Schema.optional(OutputBytes),
})

export const SearchInputSchema = Schema.Struct({
  query: NonEmptyString,
  path: Schema.optional(Schema.String),
  fixedStrings: Schema.optional(Schema.Boolean),
  caseSensitive: Schema.optional(Schema.Boolean),
  maxOutputBytes: Schema.optional(OutputBytes),
})

export const ReadFileInputSchema = Schema.Struct({
  path: NonEmptyString,
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
    Schema.String.annotations({ description: 'Working directory under /workspace. Defaults to /workspace/lab.' }),
  ),
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

export const ShellReadInputSchema = Schema.Struct({
  jobId: NonEmptyString.annotations({ description: 'Job id returned by shell_start.' }),
  stdoutOffset: Schema.optional(NonNegativeNumber),
  stderrOffset: Schema.optional(NonNegativeNumber),
  maxOutputBytes: Schema.optional(OutputBytes),
})

export const ShellKillInputSchema = Schema.Struct({
  jobId: NonEmptyString.annotations({ description: 'Job id returned by shell_start.' }),
  signal: Schema.optional(Schema.String),
})

export const ShellStatusInputSchema = Schema.Struct({
  jobId: Schema.optional(Schema.String),
  limit: Schema.optional(PositiveNumber.pipe(Schema.lessThanOrEqualTo(100))),
})

export const ShellStatusOutputSchema = Schema.Struct({
  jobs: Schema.Array(ShellJobSchema),
})

export const CliInputSchema = Schema.Struct({
  args: Schema.Array(NonEmptyString).pipe(Schema.minItems(1)).annotations({
    description: 'Arguments passed to the executable, excluding the executable name.',
  }),
  cwd: Schema.optional(Schema.String),
  timeoutSeconds: Schema.optional(TimeoutSeconds),
  maxOutputBytes: Schema.optional(OutputBytes),
})

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
export type ShellInput = typeof ShellInputSchema.Type
export type ShellReadInput = typeof ShellReadInputSchema.Type
export type ShellKillInput = typeof ShellKillInputSchema.Type
export type ShellStatusInput = typeof ShellStatusInputSchema.Type
export type CliInput = typeof CliInputSchema.Type
export type AgentStartInput = typeof AgentStartInputSchema.Type
export type AgentNameInput = typeof AgentNameInputSchema.Type
export type AgentReadInput = typeof AgentReadInputSchema.Type
