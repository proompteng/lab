import { PgClient } from '@effect/sql-pg'
import { Context, Data, Effect, Layer, Option, Schema } from 'effect'
import { isSqlError } from 'effect/unstable/sql/SqlError'

import {
  CycleDraftSchema,
  CycleState,
  CycleTerminalReason,
  cycleTerminalReasonForTargetPlanBlock,
  cycleDraftMatches,
  cycleDraftOf,
  decodeAutonomousCycle,
  isCycleStateTransitionAllowed,
  type AutonomousCycle,
  type CycleCompletionState,
  type CycleDraft,
} from '../cycle'
import { decodeInputManifestArtifact } from '../evidence-contracts'
import {
  IsoDateSchema,
  PositiveIntegerSchema,
  Sha256Schema,
  StrictNonEmptyStringSchema,
  UtcInstantSchema,
  strictParseOptions,
} from '../schemas'
import { ObserveShadowDecisionDocumentSchema, type ObserveShadowDecisionDocument } from '../shadow-decision-contract'
import { TargetPlanStatus } from '../target-planner'
import type { InputManifest, IsoDate } from '../types'
import { ensureSnapshotReference } from './snapshot-reference'

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
  signal_close_at: Schema.DateValid,
  publication_deadline_at: Schema.DateValid,
  submission_open_at: Schema.DateValid,
  execution_open_at: Schema.DateValid,
  execution_close_at: Schema.DateValid,
  submission_cutoff_at: Schema.DateValid,
  state: Schema.Enum(CycleState),
  snapshot_id: Schema.NullOr(Sha256Schema),
  decision_hash: Schema.NullOr(Sha256Schema),
  terminal_reason: Schema.NullOr(Schema.Enum(CycleTerminalReason)),
  state_version: PositiveIntegerSchema,
  created_at: Schema.DateValid,
  updated_at: Schema.DateValid,
  terminal_at: Schema.NullOr(Schema.DateValid),
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
const shadowDecisionEquivalent = Schema.toEquivalence(ObserveShadowDecisionDocumentSchema)

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
): Effect.Effect<readonly AutonomousCycle[], unknown> => {
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
): Effect.Effect<readonly AutonomousCycle[], unknown> =>
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
): Effect.Effect<readonly { readonly document: ObserveShadowDecisionDocument }[], unknown> =>
  sql<Record<string, unknown>>`
    SELECT document
    FROM autonomous_cycle_shadow_decisions
    WHERE cycle_id = ${cycleId}
  `.pipe(Effect.flatMap(decodeStoredDecisionDocumentRows))

const selectOldestUnfinishedCycle = (
  sql: PgClient.PgClient,
  scope: CycleRecoveryScope,
): Effect.Effect<readonly AutonomousCycle[], unknown> =>
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

const initialCycle = (draft: CycleDraft, observedAt: string): Effect.Effect<AutonomousCycle, Schema.SchemaError> => {
  const missed = observedAt >= draft.window.publicationDeadlineAt
  return decodeAutonomousCycle({
    ...draft,
    state: missed ? CycleState.Blocked : CycleState.Pending,
    bindings: {},
    ...(missed ? { terminalReason: CycleTerminalReason.MissedPublication, terminalAt: observedAt } : {}),
    stateVersion: 1,
    createdAt: observedAt,
    updatedAt: observedAt,
  })
}

const makeCycleStore = Effect.gen(function* () {
  const sql = yield* PgClient.PgClient

  const readLocked = (operation: CycleStoreError['operation'], cycleId: string) =>
    selectCycle(sql, cycleId, true).pipe(Effect.flatMap((rows) => exactlyOne(operation, rows)))

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

  const decisionEvidenceMatches = (document: ObserveShadowDecisionDocument): Effect.Effect<boolean, unknown> =>
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

  const verifyDecisionBoundBlock = (
    cycle: AutonomousCycle,
    reason: CycleTerminalReason,
  ): Effect.Effect<void, unknown> =>
    Effect.gen(function* () {
      const storedRows = yield* selectDecisionDocument(sql, cycle.identity.cycleId)
      const storedDocument = storedRows[0]?.document
      const targetReason = storedDocument?.targetPlan.reason
      if (
        storedRows.length !== 1 ||
        storedDocument === undefined ||
        storedDocument.contentHash !== cycle.bindings.decisionHash ||
        storedDocument.targetPlan.status !== TargetPlanStatus.Blocked ||
        targetReason === null ||
        targetReason === undefined
      ) {
        return yield* fail(
          'block',
          'invariant',
          'decision-bound cycle may block only from its exact blocked shadow decision',
        )
      }
      const expectedReason = yield* Effect.try({
        try: () => cycleTerminalReasonForTargetPlanBlock(targetReason),
        catch: () =>
          storeError('block', 'invariant', 'decision-bound cycle shadow decision has an invalid blocked reason'),
      })
      if (reason !== expectedReason) {
        return yield* fail('block', 'invariant', 'cycle blocked reason must match its exact durable shadow decision')
      }
    })

  const blockCycle = (
    operation: CycleStoreError['operation'],
    cycle: AutonomousCycle,
    reason: CycleTerminalReason,
    observedAt: string,
  ): Effect.Effect<CycleMutationReceipt, unknown> => {
    if (cycle.state === CycleState.Blocked && cycle.terminalReason === reason) {
      return Effect.succeed({ cycle, changed: false })
    }
    if (!isCycleStateTransitionAllowed(cycle.state, CycleState.Blocked)) {
      return fail(operation, 'conflict', `terminal cycle ${cycle.identity.cycleId} cannot be blocked again`)
    }
    if (
      reason === CycleTerminalReason.MissedPublication &&
      (cycle.state !== CycleState.Pending ||
        cycle.bindings.snapshotId !== undefined ||
        observedAt < cycle.window.publicationDeadlineAt)
    ) {
      return fail(
        operation,
        'invariant',
        'missed-publication transition requires an unbound pending cycle at or after its publication deadline',
      )
    }
    if (reason === CycleTerminalReason.MissedSubmission && observedAt < cycle.window.submissionCutoffAt) {
      return fail(operation, 'invariant', 'missed-submission transition cannot precede the broker submission cutoff')
    }
    if (observedAt < cycle.updatedAt) {
      return fail(operation, 'conflict', 'cycle update time cannot move backward')
    }
    const verifyDecision =
      cycle.state === CycleState.Active && cycle.bindings.decisionHash !== undefined
        ? verifyDecisionBoundBlock(cycle, reason)
        : Effect.void
    return verifyDecision.pipe(
      Effect.andThen(sql<Record<string, unknown>>`
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
      `),
      Effect.flatMap((rows) => requireApplied(operation, rows)),
      Effect.flatMap(() => readLocked(operation, cycle.identity.cycleId)),
      Effect.map((updated) => ({ cycle: updated, changed: true })),
    )
  }

  const acquire = (draft: CycleDraft, observedAt: string): Effect.Effect<CycleAcquireReceipt, CycleStoreError> =>
    run(
      'acquire',
      Effect.gen(function* () {
        const decodedDraft = yield* decodeCycleDraft(draft)
        const decodedTime = yield* Schema.decodeUnknownEffect(UtcInstantSchema, strictParseOptions)(observedAt)
        const candidate = yield* initialCycle(decodedDraft, decodedTime)
        return yield* sql.withTransaction(
          Effect.gen(function* () {
            const inserted = yield* sql<Record<string, unknown>>`
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
            const slot = yield* sql<Record<string, unknown>>`
              SELECT cycle_id
              FROM autonomous_cycles
              WHERE qualification_run_id = ${candidate.identity.qualificationRunId}
                AND account_id = ${candidate.identity.accountId}
                AND signal_session_date = ${candidate.identity.signalSessionDate}
              FOR UPDATE
            `.pipe(Effect.flatMap(decodeMutationRows))
            const storedCycleId = slot[0]?.cycle_id
            if (slot.length !== 1 || storedCycleId === undefined) {
              return yield* fail('acquire', 'invariant', 'autonomous cycle authority slot was not found exactly once')
            }
            let stored = yield* readLocked('acquire', storedCycleId)
            if (!cycleDraftMatches(cycleDraftOf(stored), decodedDraft)) {
              return yield* fail('acquire', 'conflict', 'stored cycle differs from deterministic acquisition input')
            }
            if (stored.state === CycleState.Pending && decodedTime >= stored.window.publicationDeadlineAt) {
              stored = (yield* blockCycle('acquire', stored, CycleTerminalReason.MissedPublication, decodedTime)).cycle
            }
            return { cycle: stored, created: inserted.length === 1 }
          }),
        )
      }),
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
        Effect.flatMap((decodedId) => selectDecisionDocument(sql, decodedId)),
        Effect.flatMap((rows) => {
          if (rows.length > 1) {
            return fail('read-decision-document', 'invariant', 'cycle decision document returned multiple rows')
          }
          return Effect.succeed(rows[0] === undefined ? Option.none() : Option.some(rows[0].document))
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

  const persistSnapshotReference = (inputManifest: InputManifest): Effect.Effect<void, unknown> =>
    ensureSnapshotReference(sql, inputManifest).pipe(
      Effect.flatMap((matches) =>
        matches
          ? Effect.void
          : fail(
              'bind-snapshot',
              'conflict',
              'stored snapshot reference diverged from the finalized Signal publication',
            ),
      ),
    )

  const bindSnapshot = (
    cycleId: string,
    inputManifest: InputManifest,
    observedAt: string,
  ): Effect.Effect<CycleMutationReceipt, CycleStoreError> =>
    run(
      'bind-snapshot',
      decodeSnapshotInput({ cycleId, observedAt }).pipe(
        Effect.flatMap((input) =>
          sql.withTransaction(
            Effect.gen(function* () {
              const decodedManifest = yield* decodeInputManifestArtifact(inputManifest)
              const cycle = yield* readLocked('bind-snapshot', input.cycleId)
              const snapshot = decodedManifest.finalizedSnapshot
              if (input.observedAt < cycle.window.signalCloseAt) {
                return yield* fail(
                  'bind-snapshot',
                  'invariant',
                  'snapshot binding cannot precede the Signal session close',
                )
              }
              if (
                snapshot.asOfSession !== cycle.identity.signalSessionDate ||
                snapshot.lastSession !== cycle.identity.signalSessionDate ||
                snapshot.calendarVersion !== cycle.identity.signalCalendarVersion
              ) {
                return yield* fail(
                  'bind-snapshot',
                  'invariant',
                  'finalized Signal publication does not match the cycle signal session and calendar',
                )
              }
              if (cycle.bindings.snapshotId !== undefined) {
                if (cycle.bindings.snapshotId !== snapshot.snapshotId) {
                  return yield* fail('bind-snapshot', 'conflict', 'cycle snapshot binding cannot be replaced')
                }
                yield* persistSnapshotReference(decodedManifest)
                return { cycle, changed: false }
              }
              if (cycle.state !== CycleState.Pending) {
                return yield* fail('bind-snapshot', 'conflict', 'snapshot may bind only while a cycle is pending')
              }
              if (input.observedAt >= cycle.window.publicationDeadlineAt) {
                return yield* blockCycle(
                  'bind-snapshot',
                  cycle,
                  CycleTerminalReason.MissedPublication,
                  input.observedAt,
                )
              }
              if (input.observedAt < cycle.updatedAt) {
                return yield* fail('bind-snapshot', 'conflict', 'cycle update time cannot move backward')
              }
              yield* persistSnapshotReference(decodedManifest)
              const updatedRows = yield* sql<Record<string, unknown>>`
                UPDATE autonomous_cycles
                SET
                  snapshot_id = ${snapshot.snapshotId},
                  state_version = ${cycle.stateVersion + 1},
                  updated_at = ${input.observedAt}
                WHERE cycle_id = ${input.cycleId}
                  AND state = ${CycleState.Pending}
                  AND state_version = ${cycle.stateVersion}
                  AND snapshot_id IS NULL
                RETURNING cycle_id
              `
              yield* requireApplied('bind-snapshot', updatedRows)
              const updated = yield* readLocked('bind-snapshot', input.cycleId)
              return { cycle: updated, changed: true }
            }),
          ),
        ),
      ),
    )

  const activate = (cycleId: string, observedAt: string): Effect.Effect<CycleMutationReceipt, CycleStoreError> =>
    run(
      'activate',
      decodeCycleIdInput({ cycleId, observedAt }).pipe(
        Effect.flatMap((input) =>
          sql.withTransaction(
            Effect.gen(function* () {
              const cycle = yield* readLocked('activate', input.cycleId)
              if (cycle.state === CycleState.Active) return { cycle, changed: false }
              if (!isCycleStateTransitionAllowed(cycle.state, CycleState.Active)) {
                return yield* fail('activate', 'conflict', 'only a pending cycle may become active')
              }
              if (cycle.bindings.snapshotId === undefined) {
                return yield* fail('activate', 'invariant', 'cycle activation requires a bound snapshot')
              }
              if (input.observedAt >= cycle.window.submissionCutoffAt) {
                return yield* blockCycle('activate', cycle, CycleTerminalReason.MissedSubmission, input.observedAt)
              }
              if (input.observedAt < cycle.updatedAt) {
                return yield* fail('activate', 'conflict', 'cycle update time cannot move backward')
              }
              const updatedRows = yield* sql<Record<string, unknown>>`
                UPDATE autonomous_cycles
                SET
                  state = ${CycleState.Active},
                  state_version = ${cycle.stateVersion + 1},
                  updated_at = ${input.observedAt}
                WHERE cycle_id = ${input.cycleId}
                  AND state = ${CycleState.Pending}
                  AND state_version = ${cycle.stateVersion}
                  AND snapshot_id IS NOT NULL
                RETURNING cycle_id
              `
              yield* requireApplied('activate', updatedRows)
              const updated = yield* readLocked('activate', input.cycleId)
              return { cycle: updated, changed: true }
            }),
          ),
        ),
      ),
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
            Effect.gen(function* () {
              const cycle = yield* readLocked('bind-decision', input.cycleId)
              if (cycle.bindings.decisionHash !== undefined) {
                const storedRows = yield* selectDecisionDocument(sql, input.cycleId)
                const storedDocument = storedRows[0]?.document
                if (
                  cycle.bindings.decisionHash !== input.document.contentHash ||
                  storedRows.length !== 1 ||
                  storedDocument === undefined ||
                  !shadowDecisionEquivalent(storedDocument, input.document)
                ) {
                  return yield* fail('bind-decision', 'conflict', 'cycle decision binding cannot be replaced')
                }
                return { cycle, changed: false }
              }
              if (cycle.state !== CycleState.Active) {
                return yield* fail('bind-decision', 'conflict', 'decision may bind only while a cycle is active')
              }
              if (input.observedAt >= cycle.window.submissionCutoffAt) {
                return yield* blockCycle('bind-decision', cycle, CycleTerminalReason.MissedSubmission, input.observedAt)
              }
              if (
                input.document.bindings.cycleId !== cycle.identity.cycleId ||
                input.document.bindings.strategyName !== cycle.identity.strategyName ||
                input.document.bindings.strategyProtocolHash !== cycle.identity.strategyProtocolHash ||
                input.document.bindings.snapshotId !== cycle.bindings.snapshotId ||
                input.document.bindings.accountId !== cycle.identity.accountId ||
                input.document.submissionCutoffAt !== cycle.window.submissionCutoffAt ||
                input.document.createdAt > input.observedAt ||
                input.document.createdAt < cycle.updatedAt
              ) {
                return yield* fail(
                  'bind-decision',
                  'invariant',
                  'shadow decision does not match the active autonomous cycle',
                )
              }
              if (input.observedAt < cycle.updatedAt) {
                return yield* fail('bind-decision', 'conflict', 'cycle update time cannot move backward')
              }
              if (!(yield* decisionEvidenceMatches(input.document))) {
                return yield* fail(
                  'bind-decision',
                  'invariant',
                  'shadow decision does not match the durable snapshot and exact reconciliation evidence',
                )
              }
              yield* sql`
                INSERT INTO autonomous_cycle_shadow_decisions (
                  cycle_id,
                  schema_version,
                  document,
                  created_at
                ) VALUES (
                  ${input.cycleId},
                  ${input.document.schemaVersion},
                  ${sql.json(input.document)},
                  ${input.document.createdAt}
                )
              `
              const updatedRows = yield* sql<Record<string, unknown>>`
                UPDATE autonomous_cycles
                SET
                  decision_hash = ${input.document.contentHash},
                  state_version = ${cycle.stateVersion + 1},
                  updated_at = ${input.observedAt}
                WHERE cycle_id = ${input.cycleId}
                  AND state = ${CycleState.Active}
                  AND state_version = ${cycle.stateVersion}
                  AND decision_hash IS NULL
                RETURNING cycle_id
              `
              yield* requireApplied('bind-decision', updatedRows)
              const updated = yield* readLocked('bind-decision', input.cycleId)
              return { cycle: updated, changed: true }
            }),
          ),
        ),
      ),
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
            Effect.gen(function* () {
              const cycle = yield* readLocked('finish', input.cycleId)
              if (cycle.state === input.state) return { cycle, changed: false }
              if (!isCycleStateTransitionAllowed(cycle.state, input.state)) {
                return yield* fail('finish', 'conflict', 'only an active cycle may finish from its bound decision')
              }
              if (input.observedAt < cycle.updatedAt) {
                return yield* fail('finish', 'conflict', 'cycle update time cannot move backward')
              }
              const decisionHash = cycle.bindings.decisionHash
              if (decisionHash === undefined) {
                return yield* fail('finish', 'invariant', 'cycle completion requires a bound shadow decision')
              }
              const storedRows = yield* selectDecisionDocument(sql, input.cycleId)
              const storedDocument = storedRows[0]?.document
              const expectedStatus =
                input.state === CycleState.Completed ? TargetPlanStatus.Planned : TargetPlanStatus.NoTrade
              if (
                storedRows.length !== 1 ||
                storedDocument === undefined ||
                storedDocument.contentHash !== decisionHash ||
                storedDocument.targetPlan.status !== expectedStatus
              ) {
                return yield* fail(
                  'finish',
                  'invariant',
                  'cycle terminal state must match its exact durable shadow decision',
                )
              }
              const updatedRows = yield* sql<Record<string, unknown>>`
                UPDATE autonomous_cycles
                SET
                  state = ${input.state},
                  state_version = ${cycle.stateVersion + 1},
                  updated_at = ${input.observedAt},
                  terminal_at = ${input.observedAt}
                WHERE cycle_id = ${input.cycleId}
                  AND state = ${CycleState.Active}
                  AND state_version = ${cycle.stateVersion}
                  AND decision_hash = ${decisionHash}
                RETURNING cycle_id
              `
              yield* requireApplied('finish', updatedRows)
              const updated = yield* readLocked('finish', input.cycleId)
              return { cycle: updated, changed: true }
            }),
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
