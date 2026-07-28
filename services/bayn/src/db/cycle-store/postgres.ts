import { PgClient } from '@effect/sql-pg'
import { Context, Data, Effect, Layer, Match, Option, Result, Schema } from 'effect'
import { isSqlError, type SqlError } from 'effect/unstable/sql/SqlError'

import {
  CycleDraftSchema,
  CycleState,
  CycleTerminalReason,
  decodeAutonomousCycle,
  type AutonomousCycle,
  type CycleCompletionState,
  type CycleDraft,
} from '../../cycle'
import { decodeInputManifestArtifact } from '../../evidence-contracts'
import {
  IsoDateSchema,
  PositiveIntegerSchema,
  Sha256Schema,
  StrictNonEmptyStringSchema,
  UtcInstantSchema,
  strictParseOptions,
} from '../../schemas'
import { ObserveShadowDecisionDocumentSchema, type ObserveShadowDecisionDocument } from '../../shadow-decision-contract'
import type { InputManifest, IsoDate } from '../../types'
import {
  ensureSnapshotReference,
  renderSnapshotReferenceIssue,
  snapshotReferenceIssueTags,
} from '../snapshot-reference'
import {
  decideAcquire,
  decideActivation,
  decideBlock,
  decideCompletion,
  decideDecisionBinding,
  decideSnapshotBinding,
  makeInitialCycle,
  validateBlockedDecision,
  validateCompletionDocument,
  type AcquireDecision,
  type ActivationDecision,
  type BlockDecision,
  type CompletionDecision,
  type CycleStoreDecisionFailure,
  type DecisionBindingDecision,
  type SnapshotDecision,
} from './decisions'

type CycleStoreInternalError = CycleStoreError | Schema.SchemaError | SqlError

export interface CycleAcquireReceipt {
  readonly cycle: AutonomousCycle
  readonly created: boolean
}

export interface CycleMutationReceipt {
  readonly cycle: AutonomousCycle
  readonly changed: boolean
}

export interface CycleAuthoritySlot {
  readonly qualificationRunId: string
  readonly accountId: string
  readonly signalSessionDate: IsoDate
}

export interface CycleRecoveryScope {
  readonly qualificationRunId: string
  readonly accountId: string
}

export class CycleStoreError extends Data.TaggedError('CycleStoreError')<{
  readonly operation:
    | 'acquire'
    | 'activate'
    | 'bind-decision'
    | 'bind-snapshot'
    | 'block'
    | 'finish'
    | 'read'
    | 'read-authority-slot'
    | 'read-decision-document'
    | 'read-oldest-unfinished'
  readonly failure: 'conflict' | 'decode' | 'invariant' | 'not-found' | 'query'
  readonly message: string
  readonly cause?: unknown
}> {}

export interface CycleStoreShape {
  readonly acquire: (draft: CycleDraft, observedAt: string) => Effect.Effect<CycleAcquireReceipt, CycleStoreError>
  readonly read: (cycleId: string) => Effect.Effect<Option.Option<AutonomousCycle>, CycleStoreError>
  readonly readAuthoritySlot: (
    slot: CycleAuthoritySlot,
  ) => Effect.Effect<Option.Option<AutonomousCycle>, CycleStoreError>
  readonly readDecisionDocument: (
    cycleId: string,
  ) => Effect.Effect<Option.Option<ObserveShadowDecisionDocument>, CycleStoreError>
  readonly readOldestUnfinished: (
    scope: CycleRecoveryScope,
  ) => Effect.Effect<Option.Option<AutonomousCycle>, CycleStoreError>
  readonly bindSnapshot: (
    cycleId: string,
    inputManifest: InputManifest,
    observedAt: string,
  ) => Effect.Effect<CycleMutationReceipt, CycleStoreError>
  readonly activate: (cycleId: string, observedAt: string) => Effect.Effect<CycleMutationReceipt, CycleStoreError>
  readonly bindDecision: (
    cycleId: string,
    document: ObserveShadowDecisionDocument,
    observedAt: string,
  ) => Effect.Effect<CycleMutationReceipt, CycleStoreError>
  readonly finish: (
    cycleId: string,
    state: CycleCompletionState,
    observedAt: string,
  ) => Effect.Effect<CycleMutationReceipt, CycleStoreError>
  readonly block: (
    cycleId: string,
    reason: CycleTerminalReason,
    observedAt: string,
  ) => Effect.Effect<CycleMutationReceipt, CycleStoreError>
}

export class CycleStore extends Context.Service<CycleStore, CycleStoreShape>()('bayn/CycleStore') {}

const StoredCycleRowSchema = Schema.Struct({
  cycle_id: Sha256Schema,
  schema_version: Schema.Literal('bayn.autonomous-cycle.v1'),
  identity_schema_version: Schema.Literal('bayn.autonomous-cycle-identity.v1'),
  strategy_name: Schema.Literal('risk-balanced-trend'),
  qualification_run_id: Sha256Schema,
  strategy_protocol_hash: Sha256Schema,
  account_id: StrictNonEmptyStringSchema,
  signal_session_date: IsoDateSchema,
  signal_calendar_version: StrictNonEmptyStringSchema,
  execution_policy_schema_version: Schema.Literal('bayn.autonomous-cycle-execution-policy.v1'),
  execution_policy_hash: Sha256Schema,
  strategy_execution_model_hash: Sha256Schema,
  submission_window_ms: PositiveIntegerSchema,
  submission_cutoff_before_open_ms: PositiveIntegerSchema,
  window_schema_version: Schema.Literal('bayn.autonomous-cycle-window.v1'),
  execution_calendar_schema_version: Schema.Literal('bayn.alpaca-market-calendar-observation.v1'),
  execution_calendar_source: Schema.Literal('alpaca-v2-calendar'),
  execution_calendar_hash: Sha256Schema,
  execution_session_date: IsoDateSchema,
  signal_close_at: Schema.Date,
  publication_deadline_at: Schema.Date,
  submission_open_at: Schema.Date,
  execution_open_at: Schema.Date,
  execution_close_at: Schema.Date,
  submission_cutoff_at: Schema.Date,
  state: Schema.Enum(CycleState),
  snapshot_id: Schema.NullOr(Sha256Schema),
  decision_hash: Schema.NullOr(Sha256Schema),
  terminal_reason: Schema.NullOr(Schema.Enum(CycleTerminalReason)),
  state_version: PositiveIntegerSchema,
  created_at: Schema.Date,
  updated_at: Schema.Date,
  terminal_at: Schema.NullOr(Schema.Date),
})
type StoredCycleRow = typeof StoredCycleRowSchema.Type

const CycleIdInputSchema = Schema.Struct({ cycleId: Sha256Schema, observedAt: UtcInstantSchema })
const CycleAuthoritySlotSchema = Schema.Struct({
  qualificationRunId: Sha256Schema,
  accountId: StrictNonEmptyStringSchema,
  signalSessionDate: IsoDateSchema,
})
const CycleRecoveryScopeSchema = Schema.Struct({
  qualificationRunId: Sha256Schema,
  accountId: StrictNonEmptyStringSchema,
})
const SnapshotInputSchema = Schema.Struct({
  cycleId: Sha256Schema,
  observedAt: UtcInstantSchema,
})
const DecisionInputSchema = Schema.Struct({
  cycleId: Sha256Schema,
  document: ObserveShadowDecisionDocumentSchema,
  observedAt: UtcInstantSchema,
})
const BlockInputSchema = Schema.Struct({
  cycleId: Sha256Schema,
  reason: Schema.Enum(CycleTerminalReason),
  observedAt: UtcInstantSchema,
})
const FinishInputSchema = Schema.Struct({
  cycleId: Sha256Schema,
  state: Schema.Literals([CycleState.Completed, CycleState.NoTrade]),
  observedAt: UtcInstantSchema,
})
const MutationRowsSchema = Schema.Array(Schema.Struct({ cycle_id: Sha256Schema })).check(Schema.isMaxLength(1))
const DecisionEvidenceMatchSchema = Schema.Tuple([Schema.Struct({ matches: Schema.Boolean })])
const StoredDecisionDocumentRowsSchema = Schema.Array(Schema.Struct({ document: ObserveShadowDecisionDocumentSchema }))

const decodeStoredCycleRows = Schema.decodeUnknownEffect(Schema.Array(StoredCycleRowSchema), strictParseOptions)
const decodeCycleIdInput = Schema.decodeUnknownEffect(CycleIdInputSchema, strictParseOptions)
const decodeCycleAuthoritySlot = Schema.decodeUnknownEffect(CycleAuthoritySlotSchema, strictParseOptions)
const decodeCycleRecoveryScope = Schema.decodeUnknownEffect(CycleRecoveryScopeSchema, strictParseOptions)
const decodeSnapshotInput = Schema.decodeUnknownEffect(SnapshotInputSchema, strictParseOptions)
const decodeDecisionInput = Schema.decodeUnknownEffect(DecisionInputSchema, strictParseOptions)
const decodeBlockInput = Schema.decodeUnknownEffect(BlockInputSchema, strictParseOptions)
const decodeFinishInput = Schema.decodeUnknownEffect(FinishInputSchema, strictParseOptions)
const decodeCycleDraft = Schema.decodeUnknownEffect(CycleDraftSchema, strictParseOptions)
const decodeMutationRows = Schema.decodeUnknownEffect(MutationRowsSchema, strictParseOptions)
const decodeDecisionEvidenceMatch = Schema.decodeUnknownEffect(DecisionEvidenceMatchSchema, strictParseOptions)
const decodeStoredDecisionDocumentRows = Schema.decodeUnknownEffect(
  StoredDecisionDocumentRowsSchema,
  strictParseOptions,
)
const messageOf = (cause: unknown): string => (cause instanceof Error ? cause.message : String(cause))

const storeError = (
  operation: CycleStoreError['operation'],
  failure: CycleStoreError['failure'],
  message: string,
  cause?: unknown,
): CycleStoreError =>
  new CycleStoreError({
    operation,
    failure,
    message: cause === undefined ? message : `${message}: ${messageOf(cause)}`,
    cause,
  })

const run = <A, E, R>(
  operation: CycleStoreError['operation'],
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<A, CycleStoreError, R> =>
  effect.pipe(
    Effect.mapError((cause) => {
      if (cause instanceof CycleStoreError) return cause
      if (Schema.isSchemaError(cause)) {
        return storeError(operation, 'decode', 'autonomous cycle contract decoding failed', cause)
      }
      if (isSqlError(cause)) {
        const failure =
          cause.reason._tag === 'ConstraintError' || cause.reason._tag === 'UniqueViolation' ? 'conflict' : 'query'
        return storeError(operation, failure, 'autonomous cycle PostgreSQL operation failed', cause)
      }
      return storeError(operation, 'invariant', 'autonomous cycle operation failed unexpectedly', cause)
    }),
  )

const fail = (
  operation: CycleStoreError['operation'],
  failure: CycleStoreError['failure'],
  message: string,
): Effect.Effect<never, CycleStoreError> => Effect.fail(storeError(operation, failure, message))

const liftDecision = <A>(
  operation: CycleStoreError['operation'],
  decision: Result.Result<A, CycleStoreDecisionFailure>,
): Effect.Effect<A, CycleStoreError> =>
  Effect.fromResult(decision).pipe(Effect.mapError(({ failure, message }) => storeError(operation, failure, message)))

const rowToCycle = (row: StoredCycleRow): Effect.Effect<AutonomousCycle, Schema.SchemaError> =>
  decodeAutonomousCycle({
    schemaVersion: row.schema_version,
    identity: {
      schemaVersion: row.identity_schema_version,
      strategyName: row.strategy_name,
      qualificationRunId: row.qualification_run_id,
      strategyProtocolHash: row.strategy_protocol_hash,
      accountId: row.account_id,
      signalSessionDate: row.signal_session_date,
      signalCalendarVersion: row.signal_calendar_version,
      executionSessionDate: row.execution_session_date,
      executionCalendarSchemaVersion: row.execution_calendar_schema_version,
      executionCalendarSource: row.execution_calendar_source,
      executionCalendarHash: row.execution_calendar_hash,
      executionPolicy: {
        schemaVersion: row.execution_policy_schema_version,
        strategyExecutionModelHash: row.strategy_execution_model_hash,
        submissionWindowMs: row.submission_window_ms,
        submissionCutoffBeforeOpenMs: row.submission_cutoff_before_open_ms,
        executionPolicyHash: row.execution_policy_hash,
      },
      cycleId: row.cycle_id,
    },
    window: {
      schemaVersion: row.window_schema_version,
      signalCalendarVersion: row.signal_calendar_version,
      signalSessionDate: row.signal_session_date,
      executionCalendarSchemaVersion: row.execution_calendar_schema_version,
      executionCalendarSource: row.execution_calendar_source,
      executionCalendarHash: row.execution_calendar_hash,
      executionSessionDate: row.execution_session_date,
      signalCloseAt: row.signal_close_at.toISOString(),
      publicationDeadlineAt: row.publication_deadline_at.toISOString(),
      submissionOpenAt: row.submission_open_at.toISOString(),
      executionOpenAt: row.execution_open_at.toISOString(),
      executionCloseAt: row.execution_close_at.toISOString(),
      submissionCutoffAt: row.submission_cutoff_at.toISOString(),
    },
    state: row.state,
    bindings: {
      ...(row.snapshot_id === null ? {} : { snapshotId: row.snapshot_id }),
      ...(row.decision_hash === null ? {} : { decisionHash: row.decision_hash }),
    },
    ...(row.terminal_reason === null ? {} : { terminalReason: row.terminal_reason }),
    stateVersion: row.state_version,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
    ...(row.terminal_at === null ? {} : { terminalAt: row.terminal_at.toISOString() }),
  })

const decodeRows = (rows: readonly Record<string, unknown>[]) =>
  decodeStoredCycleRows(rows).pipe(Effect.flatMap((decoded) => Effect.all(decoded.map(rowToCycle))))

const selectCycle = (
  sql: PgClient.PgClient,
  cycleId: string,
  locked: boolean,
): Effect.Effect<readonly AutonomousCycle[], SqlError | Schema.SchemaError> => {
  const rows = locked
    ? sql<Record<string, unknown>>`
        SELECT
          cycle_id, schema_version, identity_schema_version, strategy_name,
          qualification_run_id, strategy_protocol_hash, account_id,
          signal_session_date::text AS signal_session_date, signal_calendar_version,
          execution_policy_schema_version, execution_policy_hash,
          strategy_execution_model_hash, submission_window_ms, submission_cutoff_before_open_ms,
          window_schema_version, execution_calendar_schema_version,
          execution_calendar_source, execution_calendar_hash,
          execution_session_date::text AS execution_session_date,
          signal_close_at, publication_deadline_at, submission_open_at,
          execution_open_at, execution_close_at, submission_cutoff_at, state, snapshot_id,
          decision_hash, terminal_reason, state_version, created_at, updated_at, terminal_at
        FROM autonomous_cycles
        WHERE cycle_id = ${cycleId}
        FOR UPDATE
      `
    : sql<Record<string, unknown>>`
        SELECT
          cycle_id, schema_version, identity_schema_version, strategy_name,
          qualification_run_id, strategy_protocol_hash, account_id,
          signal_session_date::text AS signal_session_date, signal_calendar_version,
          execution_policy_schema_version, execution_policy_hash,
          strategy_execution_model_hash, submission_window_ms, submission_cutoff_before_open_ms,
          window_schema_version, execution_calendar_schema_version,
          execution_calendar_source, execution_calendar_hash,
          execution_session_date::text AS execution_session_date,
          signal_close_at, publication_deadline_at, submission_open_at,
          execution_open_at, execution_close_at, submission_cutoff_at, state, snapshot_id,
          decision_hash, terminal_reason, state_version, created_at, updated_at, terminal_at
        FROM autonomous_cycles
        WHERE cycle_id = ${cycleId}
      `
  return rows.pipe(Effect.flatMap(decodeRows))
}

const selectCycleByAuthoritySlot = (
  sql: PgClient.PgClient,
  slot: CycleAuthoritySlot,
): Effect.Effect<readonly AutonomousCycle[], SqlError | Schema.SchemaError> =>
  sql<Record<string, unknown>>`
    SELECT
      cycle_id, schema_version, identity_schema_version, strategy_name,
      qualification_run_id, strategy_protocol_hash, account_id,
      signal_session_date::text AS signal_session_date, signal_calendar_version,
      execution_policy_schema_version, execution_policy_hash,
      strategy_execution_model_hash, submission_window_ms, submission_cutoff_before_open_ms,
      window_schema_version, execution_calendar_schema_version,
      execution_calendar_source, execution_calendar_hash,
      execution_session_date::text AS execution_session_date,
      signal_close_at, publication_deadline_at, submission_open_at,
      execution_open_at, execution_close_at, submission_cutoff_at, state, snapshot_id,
      decision_hash, terminal_reason, state_version, created_at, updated_at, terminal_at
    FROM autonomous_cycles
    WHERE qualification_run_id = ${slot.qualificationRunId}
      AND account_id = ${slot.accountId}
      AND signal_session_date = ${slot.signalSessionDate}
  `.pipe(Effect.flatMap(decodeRows))

const selectDecisionDocument = (
  sql: PgClient.PgClient,
  cycleId: string,
): Effect.Effect<readonly { readonly document: ObserveShadowDecisionDocument }[], SqlError | Schema.SchemaError> =>
  sql<Record<string, unknown>>`
    SELECT document
    FROM autonomous_cycle_shadow_decisions
    WHERE cycle_id = ${cycleId}
  `.pipe(Effect.flatMap(decodeStoredDecisionDocumentRows))

const selectOldestUnfinishedCycle = (
  sql: PgClient.PgClient,
  scope: CycleRecoveryScope,
): Effect.Effect<readonly AutonomousCycle[], SqlError | Schema.SchemaError> =>
  sql<Record<string, unknown>>`
    SELECT
      cycle_id, schema_version, identity_schema_version, strategy_name,
      qualification_run_id, strategy_protocol_hash, account_id,
      signal_session_date::text AS signal_session_date, signal_calendar_version,
      execution_policy_schema_version, execution_policy_hash,
      strategy_execution_model_hash, submission_window_ms, submission_cutoff_before_open_ms,
      window_schema_version, execution_calendar_schema_version,
      execution_calendar_source, execution_calendar_hash,
      execution_session_date::text AS execution_session_date,
      signal_close_at, publication_deadline_at, submission_open_at,
      execution_open_at, execution_close_at, submission_cutoff_at, state, snapshot_id,
      decision_hash, terminal_reason, state_version, created_at, updated_at, terminal_at
    FROM autonomous_cycles
    WHERE qualification_run_id = ${scope.qualificationRunId}
      AND account_id = ${scope.accountId}
      AND state IN (${CycleState.Pending}, ${CycleState.Active})
    ORDER BY signal_session_date ASC, cycle_id ASC
    LIMIT 1
  `.pipe(Effect.flatMap(decodeRows))

const exactlyOne = (
  operation: CycleStoreError['operation'],
  rows: readonly AutonomousCycle[],
): Effect.Effect<AutonomousCycle, CycleStoreError> => {
  const cycle = rows[0]
  if (rows.length !== 1 || cycle === undefined) {
    return fail(operation, rows.length === 0 ? 'not-found' : 'invariant', 'autonomous cycle was not found exactly once')
  }
  return Effect.succeed(cycle)
}

const makeCycleStore = Effect.map(PgClient.PgClient, (sql) => {
  const readLocked = (operation: CycleStoreError['operation'], cycleId: string) =>
    selectCycle(sql, cycleId, true).pipe(Effect.flatMap((rows) => exactlyOne(operation, rows)))

  const readDocuments = (cycleId: string) =>
    selectDecisionDocument(sql, cycleId).pipe(Effect.map((rows) => rows.map(({ document }) => document)))

  const requireApplied = (
    operation: CycleStoreError['operation'],
    rows: readonly Record<string, unknown>[],
  ): Effect.Effect<void, CycleStoreError | Schema.SchemaError> =>
    decodeMutationRows(rows).pipe(
      Effect.flatMap((decoded) =>
        decoded.length === 1
          ? Effect.void
          : fail(operation, 'conflict', 'cycle changed concurrently before the conditional update'),
      ),
    )

  const decisionEvidenceMatches = (
    document: ObserveShadowDecisionDocument,
  ): Effect.Effect<boolean, SqlError | Schema.SchemaError> =>
    sql<Record<string, unknown>>`
      SELECT EXISTS (
        SELECT 1
        FROM snapshot_references AS snapshot
        CROSS JOIN reconciliations AS reconciliation
        WHERE snapshot.snapshot_id = ${document.bindings.snapshotId}
          AND snapshot.content_hash = ${document.bindings.snapshotContentHash}
          AND snapshot.manifest ->> 'finalizedAt' = ${document.bindings.snapshotFinalizedAt}
          AND reconciliation.reconciliation_id = ${document.bindings.reconciliationId}
          AND reconciliation.account_id = ${document.bindings.accountId}
          AND reconciliation.expected_hash = ${document.bindings.planningBrokerStateHash}
          AND reconciliation.observed_hash = ${document.bindings.planningBrokerStateHash}
          AND reconciliation.content_hash = ${document.bindings.reconciliationHash}
          AND reconciliation.status = 'EXACT'
          AND reconciliation.reconciled_at <= ${document.createdAt}
      ) AS matches
    `.pipe(
      Effect.flatMap(decodeDecisionEvidenceMatch),
      Effect.map(([match]) => match.matches),
    )

  const persistSnapshotReference = (inputManifest: InputManifest): Effect.Effect<void, CycleStoreInternalError> =>
    ensureSnapshotReference(sql, inputManifest).pipe(
      Effect.catchTag(snapshotReferenceIssueTags, (cause) =>
        Effect.fail(
          storeError(
            'bind-snapshot',
            'conflict',
            `stored snapshot reference diverged from the finalized Signal publication: ${renderSnapshotReferenceIssue(cause)}`,
            cause,
          ),
        ),
      ),
    )

  const persistBlockedCycle = (
    operation: CycleStoreError['operation'],
    cycle: AutonomousCycle,
    reason: CycleTerminalReason,
    observedAt: string,
  ): Effect.Effect<CycleMutationReceipt, CycleStoreInternalError> =>
    sql<Record<string, unknown>>`
      UPDATE autonomous_cycles
      SET
        state = ${CycleState.Blocked},
        terminal_reason = ${reason},
        state_version = ${cycle.stateVersion + 1},
        updated_at = ${observedAt},
        terminal_at = ${observedAt}
      WHERE cycle_id = ${cycle.identity.cycleId}
        AND state = ${cycle.state}
        AND state_version = ${cycle.stateVersion}
      RETURNING cycle_id
    `.pipe(
      Effect.flatMap((rows) => requireApplied(operation, rows)),
      Effect.flatMap(() => readLocked(operation, cycle.identity.cycleId)),
      Effect.map((updated) => ({ cycle: updated, changed: true })),
    )

  const interpretBlockDecision = (
    operation: CycleStoreError['operation'],
    observedAt: string,
    decision: BlockDecision,
  ): Effect.Effect<CycleMutationReceipt, CycleStoreInternalError> =>
    Match.value(decision).pipe(
      Match.tagsExhaustive({
        Replay: ({ cycle }) => Effect.succeed({ cycle, changed: false }),
        Persist: ({ cycle, reason }) => persistBlockedCycle(operation, cycle, reason, observedAt),
        VerifyDecision: (verification) =>
          readDocuments(verification.cycle.identity.cycleId).pipe(
            Effect.flatMap((documents) => liftDecision(operation, validateBlockedDecision(verification, documents))),
            Effect.andThen(persistBlockedCycle(operation, verification.cycle, verification.reason, observedAt)),
          ),
      }),
    )

  const blockCycle = (
    operation: CycleStoreError['operation'],
    cycle: AutonomousCycle,
    reason: CycleTerminalReason,
    observedAt: string,
  ): Effect.Effect<CycleMutationReceipt, CycleStoreInternalError> =>
    liftDecision(operation, decideBlock(cycle, reason, observedAt)).pipe(
      Effect.flatMap((decision) => interpretBlockDecision(operation, observedAt, decision)),
    )

  const insertCycle = (candidate: AutonomousCycle) =>
    sql<Record<string, unknown>>`
      INSERT INTO autonomous_cycles (
        cycle_id, schema_version, identity_schema_version, strategy_name,
        qualification_run_id, strategy_protocol_hash, account_id,
        signal_session_date, signal_calendar_version,
        execution_policy_schema_version, execution_policy_hash,
        strategy_execution_model_hash, submission_window_ms, submission_cutoff_before_open_ms,
        window_schema_version, execution_calendar_schema_version,
        execution_calendar_source, execution_calendar_hash, execution_session_date,
        signal_close_at, publication_deadline_at, submission_open_at,
        execution_open_at, execution_close_at, submission_cutoff_at, state, snapshot_id,
        decision_hash, terminal_reason, state_version,
        created_at, updated_at, terminal_at
      ) VALUES (
        ${candidate.identity.cycleId}, ${candidate.schemaVersion},
        ${candidate.identity.schemaVersion}, ${candidate.identity.strategyName},
        ${candidate.identity.qualificationRunId}, ${candidate.identity.strategyProtocolHash},
        ${candidate.identity.accountId}, ${candidate.identity.signalSessionDate},
        ${candidate.identity.signalCalendarVersion},
        ${candidate.identity.executionPolicy.schemaVersion},
        ${candidate.identity.executionPolicy.executionPolicyHash},
        ${candidate.identity.executionPolicy.strategyExecutionModelHash},
        ${candidate.identity.executionPolicy.submissionWindowMs},
        ${candidate.identity.executionPolicy.submissionCutoffBeforeOpenMs},
        ${candidate.window.schemaVersion}, ${candidate.window.executionCalendarSchemaVersion},
        ${candidate.window.executionCalendarSource}, ${candidate.window.executionCalendarHash},
        ${candidate.window.executionSessionDate},
        ${candidate.window.signalCloseAt}, ${candidate.window.publicationDeadlineAt},
        ${candidate.window.submissionOpenAt}, ${candidate.window.executionOpenAt},
        ${candidate.window.executionCloseAt},
        ${candidate.window.submissionCutoffAt}, ${candidate.state}, NULL, NULL,
        ${candidate.terminalReason ?? null}, ${candidate.stateVersion},
        ${candidate.createdAt}, ${candidate.updatedAt}, ${candidate.terminalAt ?? null}
      )
      ON CONFLICT DO NOTHING
      RETURNING cycle_id
    `.pipe(Effect.flatMap(decodeMutationRows))

  const lockAuthoritySlot = (candidate: AutonomousCycle): Effect.Effect<string, CycleStoreInternalError> =>
    sql<Record<string, unknown>>`
      SELECT cycle_id
      FROM autonomous_cycles
      WHERE qualification_run_id = ${candidate.identity.qualificationRunId}
        AND account_id = ${candidate.identity.accountId}
        AND signal_session_date = ${candidate.identity.signalSessionDate}
      FOR UPDATE
    `.pipe(
      Effect.flatMap(decodeMutationRows),
      Effect.flatMap((rows) => {
        const cycleId = rows[0]?.cycle_id
        return rows.length === 1 && cycleId !== undefined
          ? Effect.succeed(cycleId)
          : fail('acquire', 'invariant', 'autonomous cycle authority slot was not found exactly once')
      }),
    )

  const interpretAcquireDecision = (
    observedAt: string,
    decision: AcquireDecision,
  ): Effect.Effect<CycleAcquireReceipt, CycleStoreInternalError> =>
    Match.value(decision).pipe(
      Match.tagsExhaustive({
        Return: ({ cycle, created }) => Effect.succeed({ cycle, created }),
        Block: ({ cycle, created, reason }) =>
          blockCycle('acquire', cycle, reason, observedAt).pipe(
            Effect.map((receipt) => ({ cycle: receipt.cycle, created })),
          ),
      }),
    )

  const acquire = (draft: CycleDraft, observedAt: string): Effect.Effect<CycleAcquireReceipt, CycleStoreError> =>
    run(
      'acquire',
      decodeCycleDraft(draft).pipe(
        Effect.bindTo('draft'),
        Effect.bind('observedAt', () => Schema.decodeUnknownEffect(UtcInstantSchema, strictParseOptions)(observedAt)),
        Effect.map(({ draft: decodedDraft, observedAt: decodedTime }) => ({
          draft: decodedDraft,
          observedAt: decodedTime,
          candidate: makeInitialCycle(decodedDraft, decodedTime),
        })),
        Effect.flatMap(({ draft: decodedDraft, observedAt: decodedTime, candidate }) =>
          sql.withTransaction(
            insertCycle(candidate).pipe(
              Effect.bindTo('inserted'),
              Effect.bind('storedCycleId', () => lockAuthoritySlot(candidate)),
              Effect.bind('stored', ({ storedCycleId }) => readLocked('acquire', storedCycleId)),
              Effect.flatMap(({ inserted, stored }) =>
                liftDecision('acquire', decideAcquire(stored, decodedDraft, decodedTime, inserted.length === 1)),
              ),
              Effect.flatMap((decision) => interpretAcquireDecision(decodedTime, decision)),
            ),
          ),
        ),
      ),
    )

  const read = (cycleId: string): Effect.Effect<Option.Option<AutonomousCycle>, CycleStoreError> =>
    run(
      'read',
      Schema.decodeUnknownEffect(
        Sha256Schema,
        strictParseOptions,
      )(cycleId).pipe(
        Effect.flatMap((decodedId) => selectCycle(sql, decodedId, false)),
        Effect.flatMap((rows) => {
          if (rows.length > 1) return fail('read', 'invariant', 'cycle identity returned multiple rows')
          return Effect.succeed(rows[0] === undefined ? Option.none() : Option.some(rows[0]))
        }),
      ),
    )

  const readAuthoritySlot = (
    slot: CycleAuthoritySlot,
  ): Effect.Effect<Option.Option<AutonomousCycle>, CycleStoreError> =>
    run(
      'read-authority-slot',
      decodeCycleAuthoritySlot(slot).pipe(
        Effect.flatMap((decoded) => selectCycleByAuthoritySlot(sql, decoded)),
        Effect.flatMap((rows) => {
          if (rows.length > 1) {
            return fail('read-authority-slot', 'invariant', 'cycle authority slot returned multiple rows')
          }
          return Effect.succeed(rows[0] === undefined ? Option.none() : Option.some(rows[0]))
        }),
      ),
    )

  const readDecisionDocument = (
    cycleId: string,
  ): Effect.Effect<Option.Option<ObserveShadowDecisionDocument>, CycleStoreError> =>
    run(
      'read-decision-document',
      Schema.decodeUnknownEffect(
        Sha256Schema,
        strictParseOptions,
      )(cycleId).pipe(
        Effect.flatMap(readDocuments),
        Effect.flatMap((documents) => {
          if (documents.length > 1) {
            return fail('read-decision-document', 'invariant', 'cycle decision document returned multiple rows')
          }
          return Effect.succeed(documents[0] === undefined ? Option.none() : Option.some(documents[0]))
        }),
      ),
    )

  const readOldestUnfinished = (
    scope: CycleRecoveryScope,
  ): Effect.Effect<Option.Option<AutonomousCycle>, CycleStoreError> =>
    run(
      'read-oldest-unfinished',
      decodeCycleRecoveryScope(scope).pipe(
        Effect.flatMap((decoded) => selectOldestUnfinishedCycle(sql, decoded)),
        Effect.map((rows) => (rows[0] === undefined ? Option.none() : Option.some(rows[0]))),
      ),
    )

  const persistSnapshot = (
    manifest: InputManifest,
    observedAt: string,
    decision: Extract<SnapshotDecision, { readonly _tag: 'Persist' }>,
  ): Effect.Effect<CycleMutationReceipt, CycleStoreInternalError> =>
    persistSnapshotReference(manifest).pipe(
      Effect.andThen(sql<Record<string, unknown>>`
        UPDATE autonomous_cycles
        SET
          snapshot_id = ${decision.snapshotId},
          state_version = ${decision.cycle.stateVersion + 1},
          updated_at = ${observedAt}
        WHERE cycle_id = ${decision.cycle.identity.cycleId}
          AND state = ${CycleState.Pending}
          AND state_version = ${decision.cycle.stateVersion}
          AND snapshot_id IS NULL
        RETURNING cycle_id
      `),
      Effect.flatMap((rows) => requireApplied('bind-snapshot', rows)),
      Effect.flatMap(() => readLocked('bind-snapshot', decision.cycle.identity.cycleId)),
      Effect.map((cycle) => ({ cycle, changed: true })),
    )

  const interpretSnapshotDecision = (
    manifest: InputManifest,
    observedAt: string,
    decision: SnapshotDecision,
  ): Effect.Effect<CycleMutationReceipt, CycleStoreInternalError> =>
    Match.value(decision).pipe(
      Match.tagsExhaustive({
        Replay: ({ cycle }) => persistSnapshotReference(manifest).pipe(Effect.as({ cycle, changed: false })),
        Persist: (persist) => persistSnapshot(manifest, observedAt, persist),
        Block: ({ cycle, reason }) => blockCycle('bind-snapshot', cycle, reason, observedAt),
      }),
    )

  const bindSnapshot = (
    cycleId: string,
    inputManifest: InputManifest,
    observedAt: string,
  ): Effect.Effect<CycleMutationReceipt, CycleStoreError> =>
    run(
      'bind-snapshot',
      decodeSnapshotInput({ cycleId, observedAt }).pipe(
        Effect.bindTo('input'),
        Effect.bind('manifest', () => decodeInputManifestArtifact(inputManifest)),
        Effect.flatMap(({ input, manifest }) =>
          sql.withTransaction(
            readLocked('bind-snapshot', input.cycleId).pipe(
              Effect.flatMap((cycle) =>
                liftDecision(
                  'bind-snapshot',
                  decideSnapshotBinding(cycle, manifest.finalizedSnapshot, input.observedAt),
                ),
              ),
              Effect.flatMap((decision) => interpretSnapshotDecision(manifest, input.observedAt, decision)),
            ),
          ),
        ),
      ),
    )

  const persistActivation = (
    observedAt: string,
    decision: Extract<ActivationDecision, { readonly _tag: 'Persist' }>,
  ): Effect.Effect<CycleMutationReceipt, CycleStoreInternalError> =>
    sql<Record<string, unknown>>`
      UPDATE autonomous_cycles
      SET
        state = ${CycleState.Active},
        state_version = ${decision.cycle.stateVersion + 1},
        updated_at = ${observedAt}
      WHERE cycle_id = ${decision.cycle.identity.cycleId}
        AND state = ${CycleState.Pending}
        AND state_version = ${decision.cycle.stateVersion}
        AND snapshot_id IS NOT NULL
      RETURNING cycle_id
    `.pipe(
      Effect.flatMap((rows) => requireApplied('activate', rows)),
      Effect.flatMap(() => readLocked('activate', decision.cycle.identity.cycleId)),
      Effect.map((cycle) => ({ cycle, changed: true })),
    )

  const interpretActivationDecision = (
    observedAt: string,
    decision: ActivationDecision,
  ): Effect.Effect<CycleMutationReceipt, CycleStoreInternalError> =>
    Match.value(decision).pipe(
      Match.tagsExhaustive({
        Replay: ({ cycle }) => Effect.succeed({ cycle, changed: false }),
        Persist: (persist) => persistActivation(observedAt, persist),
        Block: ({ cycle, reason }) => blockCycle('activate', cycle, reason, observedAt),
      }),
    )

  const activate = (cycleId: string, observedAt: string): Effect.Effect<CycleMutationReceipt, CycleStoreError> =>
    run(
      'activate',
      decodeCycleIdInput({ cycleId, observedAt }).pipe(
        Effect.flatMap((input) =>
          sql.withTransaction(
            readLocked('activate', input.cycleId).pipe(
              Effect.flatMap((cycle) => liftDecision('activate', decideActivation(cycle, input.observedAt))),
              Effect.flatMap((decision) => interpretActivationDecision(input.observedAt, decision)),
            ),
          ),
        ),
      ),
    )

  const persistDecisionBinding = (
    observedAt: string,
    decision: Extract<DecisionBindingDecision, { readonly _tag: 'Persist' }>,
  ): Effect.Effect<CycleMutationReceipt, CycleStoreInternalError> =>
    decisionEvidenceMatches(decision.document).pipe(
      Effect.flatMap((matches) =>
        matches
          ? Effect.void
          : fail(
              'bind-decision',
              'invariant',
              'shadow decision does not match the durable snapshot and exact reconciliation evidence',
            ),
      ),
      Effect.andThen(sql`
        INSERT INTO autonomous_cycle_shadow_decisions (
          cycle_id,
          schema_version,
          document,
          created_at
        ) VALUES (
          ${decision.cycle.identity.cycleId},
          ${decision.document.schemaVersion},
          ${sql.json(decision.document)},
          ${decision.document.createdAt}
        )
      `),
      Effect.andThen(sql<Record<string, unknown>>`
        UPDATE autonomous_cycles
        SET
          decision_hash = ${decision.document.contentHash},
          state_version = ${decision.cycle.stateVersion + 1},
          updated_at = ${observedAt}
        WHERE cycle_id = ${decision.cycle.identity.cycleId}
          AND state = ${CycleState.Active}
          AND state_version = ${decision.cycle.stateVersion}
          AND decision_hash IS NULL
        RETURNING cycle_id
      `),
      Effect.flatMap((rows) => requireApplied('bind-decision', rows)),
      Effect.flatMap(() => readLocked('bind-decision', decision.cycle.identity.cycleId)),
      Effect.map((cycle) => ({ cycle, changed: true })),
    )

  const interpretDecisionBinding = (
    observedAt: string,
    decision: DecisionBindingDecision,
  ): Effect.Effect<CycleMutationReceipt, CycleStoreInternalError> =>
    Match.value(decision).pipe(
      Match.tagsExhaustive({
        Replay: ({ cycle }) => Effect.succeed({ cycle, changed: false }),
        Persist: (persist) => persistDecisionBinding(observedAt, persist),
        Block: ({ cycle, reason }) => blockCycle('bind-decision', cycle, reason, observedAt),
      }),
    )

  const bindDecision = (
    cycleId: string,
    document: ObserveShadowDecisionDocument,
    observedAt: string,
  ): Effect.Effect<CycleMutationReceipt, CycleStoreError> =>
    run(
      'bind-decision',
      decodeDecisionInput({ cycleId, document, observedAt }).pipe(
        Effect.flatMap((input) =>
          sql.withTransaction(
            readLocked('bind-decision', input.cycleId).pipe(
              Effect.bindTo('cycle'),
              Effect.bind('documents', ({ cycle }) =>
                cycle.bindings.decisionHash === undefined ? Effect.succeed([]) : readDocuments(input.cycleId),
              ),
              Effect.flatMap(({ cycle, documents }) =>
                liftDecision(
                  'bind-decision',
                  decideDecisionBinding(cycle, input.document, input.observedAt, documents),
                ),
              ),
              Effect.flatMap((decision) => interpretDecisionBinding(input.observedAt, decision)),
            ),
          ),
        ),
      ),
    )

  const persistCompletion = (
    observedAt: string,
    decision: Extract<CompletionDecision, { readonly _tag: 'VerifyDecision' }>,
  ): Effect.Effect<CycleMutationReceipt, CycleStoreInternalError> =>
    sql<Record<string, unknown>>`
      UPDATE autonomous_cycles
      SET
        state = ${decision.state},
        state_version = ${decision.cycle.stateVersion + 1},
        updated_at = ${observedAt},
        terminal_at = ${observedAt}
      WHERE cycle_id = ${decision.cycle.identity.cycleId}
        AND state = ${CycleState.Active}
        AND state_version = ${decision.cycle.stateVersion}
        AND decision_hash = ${decision.decisionHash}
      RETURNING cycle_id
    `.pipe(
      Effect.flatMap((rows) => requireApplied('finish', rows)),
      Effect.flatMap(() => readLocked('finish', decision.cycle.identity.cycleId)),
      Effect.map((cycle) => ({ cycle, changed: true })),
    )

  const interpretCompletionDecision = (
    observedAt: string,
    decision: CompletionDecision,
  ): Effect.Effect<CycleMutationReceipt, CycleStoreInternalError> =>
    Match.value(decision).pipe(
      Match.tagsExhaustive({
        Replay: ({ cycle }) => Effect.succeed({ cycle, changed: false }),
        VerifyDecision: (verification) =>
          readDocuments(verification.cycle.identity.cycleId).pipe(
            Effect.flatMap((documents) => liftDecision('finish', validateCompletionDocument(verification, documents))),
            Effect.andThen(persistCompletion(observedAt, verification)),
          ),
      }),
    )

  const finish = (
    cycleId: string,
    state: CycleCompletionState,
    observedAt: string,
  ): Effect.Effect<CycleMutationReceipt, CycleStoreError> =>
    run(
      'finish',
      decodeFinishInput({ cycleId, state, observedAt }).pipe(
        Effect.flatMap((input) =>
          sql.withTransaction(
            readLocked('finish', input.cycleId).pipe(
              Effect.flatMap((cycle) => liftDecision('finish', decideCompletion(cycle, input.state, input.observedAt))),
              Effect.flatMap((decision) => interpretCompletionDecision(input.observedAt, decision)),
            ),
          ),
        ),
      ),
    )

  const block = (
    cycleId: string,
    reason: CycleTerminalReason,
    observedAt: string,
  ): Effect.Effect<CycleMutationReceipt, CycleStoreError> =>
    run(
      'block',
      decodeBlockInput({ cycleId, reason, observedAt }).pipe(
        Effect.flatMap((input) =>
          sql.withTransaction(
            readLocked('block', input.cycleId).pipe(
              Effect.flatMap((cycle) => blockCycle('block', cycle, input.reason, input.observedAt)),
            ),
          ),
        ),
      ),
    )

  return {
    acquire,
    read,
    readAuthoritySlot,
    readDecisionDocument,
    readOldestUnfinished,
    bindSnapshot,
    activate,
    bindDecision,
    finish,
    block,
  } satisfies CycleStoreShape
})

export const CycleStoreLive = Layer.effect(CycleStore, makeCycleStore)
