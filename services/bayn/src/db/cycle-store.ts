import { PgClient } from '@effect/sql-pg'
import { Context, Data, Effect, Layer, Option, Schema } from 'effect'
import { isSqlError } from 'effect/unstable/sql/SqlError'

import {
  CycleDraftSchema,
  CycleState,
  CycleTerminalReason,
  cycleDraftMatches,
  cycleDraftOf,
  decodeAutonomousCycle,
  isCycleStateTransitionAllowed,
  type AutonomousCycle,
  type CycleDraft,
} from '../cycle'
import {
  IsoDateSchema,
  PositiveIntegerSchema,
  Sha256Schema,
  StrictNonEmptyStringSchema,
  UtcInstantSchema,
  strictParseOptions,
} from '../schemas'

export interface CycleAcquireReceipt {
  readonly cycle: AutonomousCycle
  readonly created: boolean
}

export interface CycleMutationReceipt {
  readonly cycle: AutonomousCycle
  readonly changed: boolean
}

export class CycleStoreError extends Data.TaggedError('CycleStoreError')<{
  readonly operation: 'acquire' | 'activate' | 'bind-decision' | 'bind-snapshot' | 'block' | 'read'
  readonly failure: 'conflict' | 'decode' | 'invariant' | 'not-found' | 'query'
  readonly message: string
  readonly cause?: unknown
}> {}

export interface CycleStoreShape {
  readonly acquire: (draft: CycleDraft, observedAt: string) => Effect.Effect<CycleAcquireReceipt, CycleStoreError>
  readonly read: (cycleId: string) => Effect.Effect<Option.Option<AutonomousCycle>, CycleStoreError>
  readonly bindSnapshot: (
    cycleId: string,
    snapshotId: string,
    observedAt: string,
  ) => Effect.Effect<CycleMutationReceipt, CycleStoreError>
  readonly activate: (cycleId: string, observedAt: string) => Effect.Effect<CycleMutationReceipt, CycleStoreError>
  readonly bindDecision: (
    cycleId: string,
    decisionHash: string,
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
const SnapshotInputSchema = Schema.Struct({
  cycleId: Sha256Schema,
  snapshotId: Sha256Schema,
  observedAt: UtcInstantSchema,
})
const DecisionInputSchema = Schema.Struct({
  cycleId: Sha256Schema,
  decisionHash: Sha256Schema,
  observedAt: UtcInstantSchema,
})
const BlockInputSchema = Schema.Struct({
  cycleId: Sha256Schema,
  reason: Schema.Enum(CycleTerminalReason),
  observedAt: UtcInstantSchema,
})
const MutationRowsSchema = Schema.Array(Schema.Struct({ cycle_id: Sha256Schema })).check(Schema.isMaxLength(1))

const decodeStoredCycleRows = Schema.decodeUnknownEffect(Schema.Array(StoredCycleRowSchema), strictParseOptions)
const decodeCycleIdInput = Schema.decodeUnknownEffect(CycleIdInputSchema, strictParseOptions)
const decodeSnapshotInput = Schema.decodeUnknownEffect(SnapshotInputSchema, strictParseOptions)
const decodeDecisionInput = Schema.decodeUnknownEffect(DecisionInputSchema, strictParseOptions)
const decodeBlockInput = Schema.decodeUnknownEffect(BlockInputSchema, strictParseOptions)
const decodeCycleDraft = Schema.decodeUnknownEffect(CycleDraftSchema, strictParseOptions)
const decodeMutationRows = Schema.decodeUnknownEffect(MutationRowsSchema, strictParseOptions)

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
    return sql<Record<string, unknown>>`
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

  const bindSnapshot = (
    cycleId: string,
    snapshotId: string,
    observedAt: string,
  ): Effect.Effect<CycleMutationReceipt, CycleStoreError> =>
    run(
      'bind-snapshot',
      decodeSnapshotInput({ cycleId, snapshotId, observedAt }).pipe(
        Effect.flatMap((input) =>
          sql.withTransaction(
            Effect.gen(function* () {
              const cycle = yield* readLocked('bind-snapshot', input.cycleId)
              if (input.observedAt < cycle.window.signalCloseAt) {
                return yield* fail(
                  'bind-snapshot',
                  'invariant',
                  'snapshot binding cannot precede the Signal session close',
                )
              }
              if (cycle.bindings.snapshotId !== undefined) {
                if (cycle.bindings.snapshotId !== input.snapshotId) {
                  return yield* fail('bind-snapshot', 'conflict', 'cycle snapshot binding cannot be replaced')
                }
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
              const updatedRows = yield* sql<Record<string, unknown>>`
                UPDATE autonomous_cycles
                SET
                  snapshot_id = ${input.snapshotId},
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
    decisionHash: string,
    observedAt: string,
  ): Effect.Effect<CycleMutationReceipt, CycleStoreError> =>
    run(
      'bind-decision',
      decodeDecisionInput({ cycleId, decisionHash, observedAt }).pipe(
        Effect.flatMap((input) =>
          sql.withTransaction(
            Effect.gen(function* () {
              const cycle = yield* readLocked('bind-decision', input.cycleId)
              if (cycle.bindings.decisionHash !== undefined) {
                if (cycle.bindings.decisionHash !== input.decisionHash) {
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
              if (input.observedAt < cycle.updatedAt) {
                return yield* fail('bind-decision', 'conflict', 'cycle update time cannot move backward')
              }
              const updatedRows = yield* sql<Record<string, unknown>>`
                UPDATE autonomous_cycles
                SET
                  decision_hash = ${input.decisionHash},
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

  return { acquire, read, bindSnapshot, activate, bindDecision, block } satisfies CycleStoreShape
})

export const CycleStoreLive = Layer.effect(CycleStore, makeCycleStore)
