import { PgClient } from '@effect/sql-pg'
import { Context, Data, Effect, Layer, Schema } from 'effect'
import { isSqlError } from 'effect/unstable/sql/SqlError'

import {
  type CycleOperationsProjection,
  type CycleOperationsSnapshot,
  type DurableAuthorityObservation,
  type ReconciliationObservation,
} from '../cycle-observability'
import { CycleState, CycleTerminalReason } from '../cycle'
import { Authority, KillState, ReconciliationStatus } from '../paper'
import {
  IsoDateSchema,
  NonNegativeIntegerSchema,
  Sha256Schema,
  StrictNonEmptyStringSchema,
  strictParseOptions,
} from '../schemas'

export class CycleObservabilityError extends Data.TaggedError('CycleObservabilityError')<{
  readonly operation: 'read'
  readonly failure: 'decode' | 'invariant' | 'query'
  readonly message: string
  readonly cause?: unknown
}> {}

export interface CycleObservabilityShape {
  readonly read: (
    qualificationRunId: string,
    accountId?: string,
  ) => Effect.Effect<CycleOperationsProjection, CycleObservabilityError>
}

export class CycleObservability extends Context.Service<CycleObservability, CycleObservabilityShape>()(
  'bayn/CycleObservability',
) {}

const NullableDate = Schema.NullOr(Schema.DateValid)
const NullableString = Schema.NullOr(Schema.String)
const NullableSha256 = Schema.NullOr(Sha256Schema)
const NullableInstant = Schema.NullOr(Schema.DateValid)
const NullableCycleState = Schema.NullOr(Schema.Enum(CycleState))
const NullableTerminalReason = Schema.NullOr(Schema.Enum(CycleTerminalReason))

const ProjectionRowSchema = Schema.Struct({
  current_cycle_id: NullableSha256,
  current_account_id: Schema.NullOr(StrictNonEmptyStringSchema),
  current_signal_session_date: Schema.NullOr(IsoDateSchema),
  current_execution_session_date: Schema.NullOr(IsoDateSchema),
  current_state: NullableCycleState,
  current_snapshot_id: NullableSha256,
  current_decision_hash: NullableSha256,
  current_terminal_reason: NullableTerminalReason,
  current_submission_open_at: NullableDate,
  current_submission_cutoff_at: NullableDate,
  current_execution_open_at: NullableDate,
  current_execution_close_at: NullableDate,
  current_created_at: NullableDate,
  current_updated_at: NullableDate,
  current_terminal_at: NullableInstant,
  last_cycle_id: NullableSha256,
  last_account_id: Schema.NullOr(StrictNonEmptyStringSchema),
  last_signal_session_date: Schema.NullOr(IsoDateSchema),
  last_execution_session_date: Schema.NullOr(IsoDateSchema),
  last_state: NullableCycleState,
  last_snapshot_id: NullableSha256,
  last_decision_hash: NullableSha256,
  last_terminal_reason: NullableTerminalReason,
  last_submission_open_at: NullableDate,
  last_submission_cutoff_at: NullableDate,
  last_execution_open_at: NullableDate,
  last_execution_close_at: NullableDate,
  last_created_at: NullableDate,
  last_updated_at: NullableDate,
  last_terminal_at: NullableInstant,
  selected_account_id: Schema.NullOr(StrictNonEmptyStringSchema),
  account_mismatch: Schema.Boolean,
  unfinished_cycle_count: NonNegativeIntegerSchema,
  authority_maximum: Schema.NullOr(Schema.Enum(Authority)),
  authority_effective: Schema.NullOr(Schema.Enum(Authority)),
  authority_kill: Schema.NullOr(Schema.Enum(KillState)),
  authority_reason: NullableString,
  authority_updated_at: NullableDate,
  reconciliation_id: NullableSha256,
  reconciliation_account_id: Schema.NullOr(StrictNonEmptyStringSchema),
  reconciliation_status: Schema.NullOr(Schema.Enum(ReconciliationStatus)),
  reconciliation_discrepancy_count: Schema.NullOr(NonNegativeIntegerSchema),
  reconciled_at: NullableDate,
  reconciliation_covers_latest_mutation: Schema.NullOr(Schema.Boolean),
  mutation_event_count: NonNegativeIntegerSchema,
  unresolved_mutation_count: NonNegativeIntegerSchema,
  oldest_unresolved_mutation_at: NullableDate,
  latest_mutation_at: NullableDate,
})
type ProjectionRow = typeof ProjectionRowSchema.Type

const ProjectionRowsSchema = Schema.Tuple([ProjectionRowSchema])
const decodeRunId = Schema.decodeUnknownEffect(Sha256Schema, strictParseOptions)
const decodeAccountId = Schema.decodeUnknownEffect(StrictNonEmptyStringSchema, strictParseOptions)
const decodeProjectionRows = Schema.decodeUnknownEffect(ProjectionRowsSchema, strictParseOptions)

const messageOf = (cause: unknown): string => (cause instanceof Error ? cause.message : String(cause))

const readError = (
  failure: CycleObservabilityError['failure'],
  message: string,
  cause?: unknown,
): CycleObservabilityError =>
  new CycleObservabilityError({
    operation: 'read',
    failure,
    message: cause === undefined ? message : `${message}: ${messageOf(cause)}`,
    cause,
  })

const snapshotFromRow = (row: ProjectionRow, prefix: 'current' | 'last'): CycleOperationsSnapshot | null => {
  const cycleId = row[`${prefix}_cycle_id`]
  if (cycleId === null) return null
  const accountId = row[`${prefix}_account_id`]
  const signalSessionDate = row[`${prefix}_signal_session_date`]
  const executionSessionDate = row[`${prefix}_execution_session_date`]
  const phase = row[`${prefix}_state`]
  const submissionOpenAt = row[`${prefix}_submission_open_at`]
  const submissionCutoffAt = row[`${prefix}_submission_cutoff_at`]
  const executionOpenAt = row[`${prefix}_execution_open_at`]
  const executionCloseAt = row[`${prefix}_execution_close_at`]
  const createdAt = row[`${prefix}_created_at`]
  const updatedAt = row[`${prefix}_updated_at`]
  if (
    accountId === null ||
    signalSessionDate === null ||
    executionSessionDate === null ||
    phase === null ||
    submissionOpenAt === null ||
    submissionCutoffAt === null ||
    executionOpenAt === null ||
    executionCloseAt === null ||
    createdAt === null ||
    updatedAt === null
  ) {
    throw readError('invariant', `${prefix} cycle projection is incomplete`)
  }
  return {
    cycleId,
    accountId,
    signalSessionDate,
    executionSessionDate,
    phase,
    snapshotId: row[`${prefix}_snapshot_id`],
    decisionHash: row[`${prefix}_decision_hash`],
    terminalReason: row[`${prefix}_terminal_reason`],
    submissionOpenAt: submissionOpenAt.toISOString(),
    submissionCutoffAt: submissionCutoffAt.toISOString(),
    executionOpenAt: executionOpenAt.toISOString(),
    executionCloseAt: executionCloseAt.toISOString(),
    createdAt: createdAt.toISOString(),
    updatedAt: updatedAt.toISOString(),
    terminalAt: row[`${prefix}_terminal_at`]?.toISOString() ?? null,
  }
}

const authorityFromRow = (row: ProjectionRow): DurableAuthorityObservation | null => {
  if (row.authority_maximum === null) return null
  if (row.authority_effective === null || row.authority_kill === null || row.authority_updated_at === null) {
    throw readError('invariant', 'durable authority projection is incomplete')
  }
  return {
    maximum: row.authority_maximum,
    effective: row.authority_effective,
    kill: row.authority_kill,
    reason: row.authority_reason,
    updatedAt: row.authority_updated_at.toISOString(),
  }
}

const reconciliationFromRow = (row: ProjectionRow): ReconciliationObservation | null => {
  if (row.reconciliation_id === null) return null
  if (
    row.reconciliation_account_id === null ||
    row.reconciliation_status === null ||
    row.reconciliation_discrepancy_count === null ||
    row.reconciled_at === null ||
    row.reconciliation_covers_latest_mutation === null
  ) {
    throw readError('invariant', 'reconciliation projection is incomplete')
  }
  return {
    reconciliationId: row.reconciliation_id,
    accountId: row.reconciliation_account_id,
    status: row.reconciliation_status,
    discrepancyCount: row.reconciliation_discrepancy_count,
    reconciledAt: row.reconciled_at.toISOString(),
    coversLatestMutation: row.reconciliation_covers_latest_mutation,
  }
}

const projectionFromRow = (row: ProjectionRow): CycleOperationsProjection => {
  if (row.account_mismatch) {
    throw readError(
      'invariant',
      `configured account ${row.selected_account_id ?? 'unknown'} differs from the projected current or last cycle`,
    )
  }
  return {
    current: snapshotFromRow(row, 'current'),
    last: snapshotFromRow(row, 'last'),
    unfinishedCycleCount: row.unfinished_cycle_count,
    authority: authorityFromRow(row),
    reconciliation: reconciliationFromRow(row),
    mutations: {
      eventCount: row.mutation_event_count,
      unresolvedCount: row.unresolved_mutation_count,
      oldestUnresolvedAt: row.oldest_unresolved_mutation_at?.toISOString() ?? null,
      latestOccurredAt: row.latest_mutation_at?.toISOString() ?? null,
    },
  }
}

const makeCycleObservability = Effect.gen(function* () {
  const sql = yield* PgClient.PgClient

  const read = (
    qualificationRunId: string,
    accountId?: string,
  ): Effect.Effect<CycleOperationsProjection, CycleObservabilityError> =>
    Effect.all([
      decodeRunId(qualificationRunId).pipe(
        Effect.mapError((cause) => readError('decode', 'invalid qualification run identity', cause)),
      ),
      accountId === undefined
        ? Effect.succeed(undefined)
        : decodeAccountId(accountId).pipe(
            Effect.mapError((cause) => readError('decode', 'invalid cycle observability account identity', cause)),
          ),
    ]).pipe(
      Effect.flatMap(([runId, expectedAccountId]) =>
        sql<Record<string, unknown>>`
          WITH scoped_cycles AS (
            SELECT *
            FROM autonomous_cycles
            WHERE qualification_run_id = ${runId}
          ),
          current_cycle AS (
            SELECT *
            FROM scoped_cycles
            WHERE state IN ('PENDING', 'ACTIVE')
            ORDER BY execution_session_date DESC, created_at DESC, cycle_id
            LIMIT 1
          ),
          last_cycle AS (
            SELECT *
            FROM scoped_cycles
            WHERE state IN ('COMPLETED', 'NO_TRADE', 'BLOCKED')
            ORDER BY execution_session_date DESC, terminal_at DESC, cycle_id
            LIMIT 1
          ),
          requested_account AS (
            SELECT ${expectedAccountId ?? null}::text AS account_id
          ),
          selected_account AS (
            SELECT coalesce(
              (SELECT account_id FROM requested_account),
              (SELECT account_id FROM current_cycle),
              (SELECT account_id FROM last_cycle)
            ) AS account_id
          ),
          latest_reconciliation AS (
            SELECT *
            FROM reconciliations
            WHERE account_id = (SELECT account_id FROM selected_account)
            ORDER BY reconciled_at DESC, reconciliation_id
            LIMIT 1
          ),
          account_mutation_events AS (
            SELECT
              events.*,
              intents.state
            FROM mutation_events AS events
            JOIN intents ON intents.intent_id = events.intent_id
            WHERE intents.account_id = (SELECT account_id FROM selected_account)
          ),
          latest_mutations AS (
            SELECT DISTINCT ON (events.mutation_id)
              events.event_type,
              events.occurred_at,
              events.operation,
              events.state
            FROM account_mutation_events AS events
            ORDER BY events.mutation_id, events.sequence DESC
          ),
          unresolved_mutations AS (
            SELECT occurred_at
            FROM latest_mutations
            WHERE
              event_type IN (
                'SUBMIT_STARTED',
                'SUBMIT_UNKNOWN',
                'RECOVERY_NOT_FOUND',
                'RECOVERY_UNKNOWN',
                'CANCEL_STARTED',
                'CANCEL_ACCEPTED',
                'CANCEL_UNKNOWN'
              )
              OR (
                operation = 'CANCEL'
                AND event_type = 'RECOVERY_FOUND'
                AND state <> 'TERMINAL'
              )
          )
          SELECT
            current.cycle_id AS current_cycle_id,
            current.account_id AS current_account_id,
            current.signal_session_date::text AS current_signal_session_date,
            current.execution_session_date::text AS current_execution_session_date,
            current.state AS current_state,
            current.snapshot_id AS current_snapshot_id,
            current.decision_hash AS current_decision_hash,
            current.terminal_reason AS current_terminal_reason,
            current.submission_open_at AS current_submission_open_at,
            current.submission_cutoff_at AS current_submission_cutoff_at,
            current.execution_open_at AS current_execution_open_at,
            current.execution_close_at AS current_execution_close_at,
            current.created_at AS current_created_at,
            current.updated_at AS current_updated_at,
            current.terminal_at AS current_terminal_at,
            last.cycle_id AS last_cycle_id,
            last.account_id AS last_account_id,
            last.signal_session_date::text AS last_signal_session_date,
            last.execution_session_date::text AS last_execution_session_date,
            last.state AS last_state,
            last.snapshot_id AS last_snapshot_id,
            last.decision_hash AS last_decision_hash,
            last.terminal_reason AS last_terminal_reason,
            last.submission_open_at AS last_submission_open_at,
            last.submission_cutoff_at AS last_submission_cutoff_at,
            last.execution_open_at AS last_execution_open_at,
            last.execution_close_at AS last_execution_close_at,
            last.created_at AS last_created_at,
            last.updated_at AS last_updated_at,
            last.terminal_at AS last_terminal_at,
            (SELECT account_id FROM selected_account) AS selected_account_id,
            (
              (SELECT account_id FROM requested_account) IS NOT NULL
              AND (
                (
                  current.account_id IS NOT NULL
                  AND current.account_id <> (SELECT account_id FROM requested_account)
                )
                OR
                (
                  last.account_id IS NOT NULL
                  AND last.account_id <> (SELECT account_id FROM requested_account)
                )
              )
            ) AS account_mismatch,
            (
              SELECT count(*)::integer
              FROM scoped_cycles
              WHERE state IN ('PENDING', 'ACTIVE')
            ) AS unfinished_cycle_count,
            authority.maximum AS authority_maximum,
            authority.effective AS authority_effective,
            authority.kill_state AS authority_kill,
            authority.reason AS authority_reason,
            authority.updated_at AS authority_updated_at,
            reconciliation.reconciliation_id,
            reconciliation.account_id AS reconciliation_account_id,
            reconciliation.status AS reconciliation_status,
            jsonb_array_length(reconciliation.discrepancies) AS reconciliation_discrepancy_count,
            reconciliation.reconciled_at,
            CASE
              WHEN reconciliation.reconciliation_id IS NULL THEN NULL
              WHEN NOT EXISTS (SELECT 1 FROM account_mutation_events) THEN true
              ELSE reconciliation.reconciled_at >= (SELECT max(occurred_at) FROM account_mutation_events)
            END AS reconciliation_covers_latest_mutation,
            (SELECT count(*)::integer FROM account_mutation_events) AS mutation_event_count,
            (SELECT count(*)::integer FROM unresolved_mutations) AS unresolved_mutation_count,
            (SELECT min(occurred_at) FROM unresolved_mutations) AS oldest_unresolved_mutation_at,
            (SELECT max(occurred_at) FROM account_mutation_events) AS latest_mutation_at
          FROM (VALUES (true)) AS singleton(seed)
          LEFT JOIN current_cycle AS current ON true
          LEFT JOIN last_cycle AS last ON true
          LEFT JOIN authority_state AS authority ON authority.singleton
          LEFT JOIN latest_reconciliation AS reconciliation ON true
        `.pipe(
          Effect.mapError((cause) =>
            isSqlError(cause)
              ? readError('query', 'autonomous cycle observability query failed', cause)
              : readError('query', 'autonomous cycle observability failed unexpectedly', cause),
          ),
        ),
      ),
      Effect.flatMap((rows) =>
        decodeProjectionRows(rows).pipe(
          Effect.mapError((cause) => readError('decode', 'autonomous cycle observability decoding failed', cause)),
        ),
      ),
      Effect.flatMap(([row]) =>
        Effect.try({
          try: () => projectionFromRow(row),
          catch: (cause) =>
            cause instanceof CycleObservabilityError
              ? cause
              : readError('invariant', 'autonomous cycle observability projection failed', cause),
        }),
      ),
    )

  return { read } satisfies CycleObservabilityShape
})

export const CycleObservabilityLive = Layer.effect(CycleObservability, makeCycleObservability)
