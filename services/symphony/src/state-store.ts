import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'

import type * as ParseResult from '@effect/schema/ParseResult'
import * as Schema from '@effect/schema/Schema'
import * as TreeFormatter from '@effect/schema/TreeFormatter'
import { Context, Effect, Layer } from 'effect'

import { ConfigError, OrchestratorError, WorkflowError, toLogError } from './errors'
import type { IssueRecord, PersistedSchedulerState } from './types'
import { WorkflowService } from './workflow'
import type { Logger } from './logger'

const STATE_VERSION = 1 as const
const STATE_DIRECTORY_NAME = '_symphony'
const STATE_FILE_NAME = 'state.json'

const RecentEventSchema = Schema.Struct({
  at: Schema.String,
  event: Schema.String,
  message: Schema.NullOr(Schema.String),
  issueId: Schema.optionalWith(Schema.NullOr(Schema.String), { nullable: true }),
  issueIdentifier: Schema.optionalWith(Schema.NullOr(Schema.String), { nullable: true }),
  level: Schema.optionalWith(Schema.Union(Schema.Literal('info'), Schema.Literal('warn'), Schema.Literal('error')), {
    nullable: true,
  }),
  reason: Schema.optionalWith(Schema.NullOr(Schema.String), { nullable: true }),
})

const RecentErrorSchema = Schema.Struct({
  at: Schema.String,
  code: Schema.String,
  message: Schema.String,
  issueId: Schema.NullOr(Schema.String),
  issueIdentifier: Schema.NullOr(Schema.String),
  context: Schema.String,
})

const TokenUsageTotalsSchema = Schema.Struct({
  inputTokens: Schema.Number,
  outputTokens: Schema.Number,
  totalTokens: Schema.Number,
})

const CodexTotalsSchema = Schema.extend(
  TokenUsageTotalsSchema,
  Schema.Struct({
    endedRuntimeSeconds: Schema.Number,
  }),
)

const SessionLogRefSchema = Schema.Struct({
  label: Schema.String,
  path: Schema.NullOr(Schema.String),
  url: Schema.NullOr(Schema.String),
})

const RunHistoryEntrySchema = Schema.Struct({
  at: Schema.String,
  status: Schema.String,
  attempt: Schema.NullOr(Schema.Number),
  message: Schema.NullOr(Schema.String),
  workspacePath: Schema.NullOr(Schema.String),
  sessionId: Schema.NullOr(Schema.String),
})

const RunningDetailsSchema = Schema.NullOr(
  Schema.Struct({
    sessionId: Schema.NullOr(Schema.String),
    turnCount: Schema.Number,
    state: Schema.String,
    startedAt: Schema.String,
    lastEvent: Schema.NullOr(Schema.String),
    lastMessage: Schema.NullOr(Schema.String),
    lastEventAt: Schema.NullOr(Schema.String),
    tokens: TokenUsageTotalsSchema,
  }),
)

const RetryDetailsSchema = Schema.NullOr(
  Schema.Struct({
    attempt: Schema.Number,
    dueAt: Schema.String,
    error: Schema.NullOr(Schema.String),
  }),
)

const IssueRecordSchema = Schema.Struct({
  issueIdentifier: Schema.String,
  issueId: Schema.String,
  status: Schema.String,
  workspacePath: Schema.NullOr(Schema.String),
  attempts: Schema.Struct({
    restartCount: Schema.Number,
    currentRetryAttempt: Schema.Number,
  }),
  running: RunningDetailsSchema,
  retry: RetryDetailsSchema,
  logs: Schema.Struct({
    codex_session_logs: Schema.Array(SessionLogRefSchema),
  }),
  recentEvents: Schema.Array(RecentEventSchema),
  lastError: Schema.NullOr(Schema.String),
  tracked: Schema.Record({
    key: Schema.String,
    value: Schema.Unknown,
  }),
  runHistory: Schema.Array(RunHistoryEntrySchema),
  updatedAt: Schema.String,
})

const PersistedRetryEntrySchema = Schema.Struct({
  issueId: Schema.String,
  identifier: Schema.String,
  attempt: Schema.Number,
  dueAt: Schema.String,
  error: Schema.NullOr(Schema.String),
})

const PersistedSchedulerStateSchema = Schema.Struct({
  version: Schema.Literal(STATE_VERSION),
  updatedAt: Schema.String,
  codexTotals: CodexTotalsSchema,
  rateLimits: Schema.optionalWith(Schema.Unknown, { nullable: true }),
  recentEvents: Schema.Array(RecentEventSchema),
  recentErrors: Schema.Array(RecentErrorSchema),
  retrying: Schema.Array(PersistedRetryEntrySchema),
  issues: Schema.Array(IssueRecordSchema),
})

const decodePersistedState = Schema.decodeUnknown(PersistedSchedulerStateSchema)
const formatSchemaError = (error: ParseResult.ParseError): string => TreeFormatter.formatErrorSync(error)

const normalizePersistedState = (value: typeof PersistedSchedulerStateSchema.Type): PersistedSchedulerState => ({
  version: STATE_VERSION,
  updatedAt: value.updatedAt,
  codexTotals: {
    inputTokens: value.codexTotals.inputTokens,
    outputTokens: value.codexTotals.outputTokens,
    totalTokens: value.codexTotals.totalTokens,
    endedRuntimeSeconds: value.codexTotals.endedRuntimeSeconds,
  },
  rateLimits: (value.rateLimits ?? null) as PersistedSchedulerState['rateLimits'],
  recentEvents: value.recentEvents.map((event) => ({ ...event })),
  recentErrors: value.recentErrors.map((error) => ({ ...error })),
  retrying: value.retrying.map((entry) => ({ ...entry })),
  issues: value.issues.map((issue) => ({
    ...issue,
    status:
      issue.status === 'running' || issue.status === 'retrying' || issue.status === 'tracked'
        ? issue.status
        : 'tracked',
    logs: {
      codex_session_logs: issue.logs.codex_session_logs.map((log) => ({ ...log })),
    },
    recentEvents: issue.recentEvents.map((event) => ({ ...event })),
    tracked: { ...issue.tracked },
    runHistory: issue.runHistory.map((entry) => ({
      ...entry,
      status: [
        'started',
        'workspace_ready',
        'retry_scheduled',
        'succeeded',
        'failed',
        'stalled',
        'terminal',
        'inactive',
        'leadership_lost',
        'restored',
      ].includes(entry.status)
        ? (entry.status as IssueRecord['runHistory'][number]['status'])
        : 'restored',
    })),
  })),
})

export const emptyPersistedSchedulerState = (): PersistedSchedulerState => ({
  version: STATE_VERSION,
  updatedAt: new Date().toISOString(),
  codexTotals: {
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    endedRuntimeSeconds: 0,
  },
  rateLimits: null,
  recentEvents: [],
  recentErrors: [],
  retrying: [],
  issues: [],
})

export const getDurableStateDirectory = (workspaceRoot: string) => path.join(workspaceRoot, STATE_DIRECTORY_NAME)

export const getDurableStateFilePath = (workspaceRoot: string) =>
  path.join(getDurableStateDirectory(workspaceRoot), STATE_FILE_NAME)

export interface StateStoreServiceDefinition {
  readonly load: Effect.Effect<PersistedSchedulerState, WorkflowError | ConfigError | OrchestratorError>
  readonly save: (
    state: PersistedSchedulerState,
  ) => Effect.Effect<void, WorkflowError | ConfigError | OrchestratorError>
  readonly stateFilePath: Effect.Effect<string, WorkflowError | ConfigError>
}

export class StateStoreService extends Context.Tag('symphony/StateStoreService')<
  StateStoreService,
  StateStoreServiceDefinition
>() {}

export const makeStateStoreLayer = (logger: Logger) =>
  Layer.effect(
    StateStoreService,
    Effect.gen(function* () {
      const workflow = yield* WorkflowService
      const stateLogger = logger.child({ component: 'state-store' })

      const stateFilePath = workflow.config.pipe(Effect.map((config) => getDurableStateFilePath(config.workspaceRoot)))

      return {
        stateFilePath,
        load: stateFilePath.pipe(
          Effect.flatMap((filePath) =>
            Effect.tryPromise({
              try: () => readFile(filePath, 'utf8'),
              catch: (error) => error,
            }).pipe(
              Effect.flatMap((content) =>
                Effect.try({
                  try: () => JSON.parse(content) as unknown,
                  catch: (error) =>
                    new OrchestratorError('durable_state_error', `failed to parse durable state ${filePath}`, error),
                }),
              ),
              Effect.flatMap((decoded) =>
                decodePersistedState(decoded).pipe(
                  Effect.map(normalizePersistedState),
                  Effect.mapError(
                    (error) =>
                      new OrchestratorError(
                        'durable_state_error',
                        `failed to decode durable state ${filePath}: ${formatSchemaError(error)}`,
                        error,
                      ),
                  ),
                ),
              ),
              Effect.catchAll((error) => {
                const nodeError = error instanceof Error ? (error as NodeJS.ErrnoException) : null
                if (nodeError?.code === 'ENOENT') {
                  return Effect.succeed(emptyPersistedSchedulerState())
                }

                return Effect.sync(() => {
                  stateLogger.log('warn', 'durable_state_load_failed', {
                    state_file: filePath,
                    ...toLogError(error),
                  })
                }).pipe(Effect.zipRight(Effect.succeed(emptyPersistedSchedulerState())))
              }),
            ),
          ),
        ),
        save: (state) =>
          stateFilePath.pipe(
            Effect.flatMap((filePath) =>
              Effect.tryPromise({
                try: async () => {
                  const directory = path.dirname(filePath)
                  const tempFilePath = `${filePath}.tmp`
                  await mkdir(directory, { recursive: true })
                  await writeFile(tempFilePath, JSON.stringify(state, null, 2), 'utf8')
                  await rename(tempFilePath, filePath)
                },
                catch: (error) =>
                  new OrchestratorError('durable_state_error', `failed to write durable state ${filePath}`, error),
              }).pipe(
                Effect.catchAll((error) =>
                  Effect.sync(() => {
                    stateLogger.log('warn', 'durable_state_save_failed', {
                      state_file: filePath,
                      ...toLogError(error),
                    })
                  }).pipe(Effect.zipRight(Effect.fail(error))),
                ),
              ),
            ),
          ),
      } satisfies StateStoreServiceDefinition
    }),
  )

export const clearDurableStateForTests = async (workspaceRoot: string): Promise<void> => {
  await rm(getDurableStateDirectory(workspaceRoot), { recursive: true, force: true })
}
