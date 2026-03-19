import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'

import type * as ParseResult from '@effect/schema/ParseResult'
import * as Schema from '@effect/schema/Schema'
import * as TreeFormatter from '@effect/schema/TreeFormatter'
import { Context, Effect, Layer } from 'effect'

import { ConfigError, OrchestratorError, WorkflowError, toLogError } from './errors'
import type { DeliveryTransaction, IssueRecord, PersistedSchedulerState } from './types'
import { WorkflowService } from './workflow'
import type { Logger } from './logger'

const LEGACY_STATE_VERSION = 1 as const
const STATE_VERSION = 2 as const
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

const DeliveryPullRequestRefSchema = Schema.Struct({
  number: Schema.Number,
  url: Schema.String,
  branch: Schema.String,
  state: Schema.Union(Schema.Literal('open'), Schema.Literal('merged'), Schema.Literal('closed')),
  title: Schema.NullOr(Schema.String),
  createdAt: Schema.NullOr(Schema.String),
  updatedAt: Schema.NullOr(Schema.String),
  mergedAt: Schema.NullOr(Schema.String),
  mergedCommitSha: Schema.NullOr(Schema.String),
})

const DeliveryChecksSummarySchema = Schema.Struct({
  state: Schema.Union(
    Schema.Literal('pending'),
    Schema.Literal('success'),
    Schema.Literal('failure'),
    Schema.Literal('not_found'),
  ),
  headSha: Schema.String,
  requiredCount: Schema.Number,
  passingCount: Schema.Number,
  failingCount: Schema.Number,
  pendingCount: Schema.Number,
  url: Schema.NullOr(Schema.String),
})

const DeliveryWorkflowRunRefSchema = Schema.Struct({
  id: Schema.Number,
  url: Schema.String,
  name: Schema.String,
  state: Schema.Union(
    Schema.Literal('queued'),
    Schema.Literal('in_progress'),
    Schema.Literal('success'),
    Schema.Literal('failure'),
    Schema.Literal('cancelled'),
    Schema.Literal('skipped'),
    Schema.Literal('neutral'),
    Schema.Literal('not_found'),
  ),
  status: Schema.NullOr(Schema.String),
  conclusion: Schema.NullOr(Schema.String),
  event: Schema.NullOr(Schema.String),
  headSha: Schema.String,
  headBranch: Schema.NullOr(Schema.String),
  createdAt: Schema.NullOr(Schema.String),
  updatedAt: Schema.NullOr(Schema.String),
})

const DeliveryReleaseContractSchema = Schema.Struct({
  sourceSha: Schema.NullOr(Schema.String),
  tag: Schema.NullOr(Schema.String),
  digest: Schema.NullOr(Schema.String),
  image: Schema.NullOr(Schema.String),
  reason: Schema.NullOr(Schema.String),
  resolvedAt: Schema.NullOr(Schema.String),
})

const DeliveryArgoObservationSchema = Schema.Struct({
  application: Schema.NullOr(Schema.String),
  namespace: Schema.NullOr(Schema.String),
  revision: Schema.NullOr(Schema.String),
  health: Schema.NullOr(Schema.String),
  sync: Schema.NullOr(Schema.String),
  checkedAt: Schema.NullOr(Schema.String),
})

const DeliveryTransactionSchema = Schema.Struct({
  stage: Schema.Union(
    Schema.Literal('coding'),
    Schema.Literal('code_pr_open'),
    Schema.Literal('checks_pending'),
    Schema.Literal('checks_green'),
    Schema.Literal('merged_to_main'),
    Schema.Literal('build_running'),
    Schema.Literal('release_contract_resolved'),
    Schema.Literal('promotion_pr_open'),
    Schema.Literal('promotion_merged'),
    Schema.Literal('argo_rollout_pending'),
    Schema.Literal('post_deploy_verify_running'),
    Schema.Literal('completed'),
    Schema.Literal('rollback_open'),
    Schema.Literal('rolled_back'),
    Schema.Literal('handoff_required'),
    Schema.Literal('failed'),
  ),
  updatedAt: Schema.String,
  codePr: Schema.NullOr(DeliveryPullRequestRefSchema),
  requiredChecks: Schema.NullOr(DeliveryChecksSummarySchema),
  mergedCommitSha: Schema.NullOr(Schema.String),
  build: Schema.NullOr(DeliveryWorkflowRunRefSchema),
  releaseContract: Schema.NullOr(DeliveryReleaseContractSchema),
  promotionPr: Schema.NullOr(DeliveryPullRequestRefSchema),
  argo: Schema.NullOr(DeliveryArgoObservationSchema),
  postDeploy: Schema.NullOr(DeliveryWorkflowRunRefSchema),
  rollbackPr: Schema.NullOr(DeliveryPullRequestRefSchema),
  lastError: Schema.NullOr(Schema.String),
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
  delivery: Schema.optionalWith(Schema.NullOr(DeliveryTransactionSchema), { nullable: true }),
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
  version: Schema.Union(Schema.Literal(LEGACY_STATE_VERSION), Schema.Literal(STATE_VERSION)),
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

const cloneDeliveryTransaction = (delivery: DeliveryTransaction | null): DeliveryTransaction | null =>
  delivery
    ? {
        ...delivery,
        codePr: delivery.codePr ? { ...delivery.codePr } : null,
        requiredChecks: delivery.requiredChecks ? { ...delivery.requiredChecks } : null,
        build: delivery.build ? { ...delivery.build } : null,
        releaseContract: delivery.releaseContract ? { ...delivery.releaseContract } : null,
        promotionPr: delivery.promotionPr ? { ...delivery.promotionPr } : null,
        argo: delivery.argo ? { ...delivery.argo } : null,
        postDeploy: delivery.postDeploy ? { ...delivery.postDeploy } : null,
        rollbackPr: delivery.rollbackPr ? { ...delivery.rollbackPr } : null,
      }
    : null

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
    delivery: cloneDeliveryTransaction((issue.delivery ?? null) as DeliveryTransaction | null),
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
