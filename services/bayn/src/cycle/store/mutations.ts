import { PgClient } from '@effect/sql-pg'
import { Effect, Match } from 'effect'

import { Pipeable } from '../../pipeable'
import { CycleState, type AutonomousCycle, type CycleTerminalReason } from '../model'
import { decideBlock, validateBlockedDecision, type BlockDecision } from './decisions'
import {
  exactlyOneCycle,
  failCycleStore,
  liftCycleDecision,
  type CycleMutationReceipt,
  type CycleStoreError,
  type CycleStoreInternalError,
} from './model'
import type { CycleQueries } from './queries'
import { decodeMutationRows } from './rows'

export interface CycleMutationPrimitives {
  readonly readLocked: (
    operation: CycleStoreError['operation'],
    cycleId: string,
  ) => Effect.Effect<AutonomousCycle, CycleStoreInternalError>
  readonly requireApplied: (
    operation: CycleStoreError['operation'],
    rows: readonly Record<string, unknown>[],
  ) => Effect.Effect<void, CycleStoreInternalError>
  readonly blockCycle: (
    operation: CycleStoreError['operation'],
    cycle: AutonomousCycle,
    reason: CycleTerminalReason,
    observedAt: string,
  ) => Effect.Effect<CycleMutationReceipt, CycleStoreInternalError>
  readonly insertCycle: (
    candidate: AutonomousCycle,
  ) => Effect.Effect<readonly { readonly cycle_id: string }[], CycleStoreInternalError>
  readonly lockAuthoritySlot: (candidate: AutonomousCycle) => Effect.Effect<string, CycleStoreInternalError>
}

const makeCycleMutationPrimitivesDataFirst = (
  sql: PgClient.PgClient,
  queries: CycleQueries,
): CycleMutationPrimitives => {
  const readLocked: CycleMutationPrimitives['readLocked'] = (operation, cycleId) =>
    queries.selectCycle(cycleId, true).pipe(Effect.flatMap((rows) => exactlyOneCycle(operation, rows)))

  const requireApplied: CycleMutationPrimitives['requireApplied'] = (operation, rows) =>
    decodeMutationRows(rows).pipe(
      Effect.flatMap((decoded) =>
        decoded.length === 1
          ? Effect.void
          : failCycleStore(operation, 'conflict', 'cycle changed concurrently before the conditional update'),
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
          queries.selectDecisionDocuments(verification.cycle.identity.cycleId).pipe(
            Effect.flatMap((documents) =>
              liftCycleDecision(operation, validateBlockedDecision(verification, documents)),
            ),
            Effect.andThen(persistBlockedCycle(operation, verification.cycle, verification.reason, observedAt)),
          ),
      }),
    )

  const blockCycle: CycleMutationPrimitives['blockCycle'] = (operation, cycle, reason, observedAt) =>
    liftCycleDecision(operation, decideBlock(cycle, reason, observedAt)).pipe(
      Effect.flatMap((decision) => interpretBlockDecision(operation, observedAt, decision)),
    )

  const insertCycle: CycleMutationPrimitives['insertCycle'] = (candidate) =>
    sql<Record<string, unknown>>`
      INSERT INTO autonomous_cycles (
        cycle_id, schema_version, identity_schema_version, strategy_name,
        qualification_run_id, strategy_protocol_hash, account_id,
        signal_session_date, signal_calendar_version,
        execution_policy_schema_version, execution_policy_hash,
        strategy_execution_model_hash, submission_window_ms,
        submission_cutoff_before_open_ms, submission_cutoff_after_open_ms,
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
        ${candidate.identity.accountId},
        ${
          candidate.identity.schemaVersion !== 'bayn.autonomous-cycle-identity.v3'
            ? candidate.identity.signalSessionDate
            : null
        },
        ${
          candidate.identity.schemaVersion !== 'bayn.autonomous-cycle-identity.v3'
            ? candidate.identity.signalCalendarVersion
            : null
        },
        ${candidate.identity.executionPolicy.schemaVersion},
        ${candidate.identity.executionPolicy.executionPolicyHash},
        ${candidate.identity.executionPolicy.strategyExecutionModelHash},
        ${candidate.identity.executionPolicy.submissionWindowMs},
        ${
          candidate.identity.executionPolicy.schemaVersion === 'bayn.autonomous-cycle-execution-policy.v1'
            ? candidate.identity.executionPolicy.submissionCutoffBeforeOpenMs
            : candidate.schemaVersion === 'bayn.autonomous-cycle.v2'
              ? candidate.identity.executionPolicy.submissionCutoffAfterOpenMs
              : null
        },
        ${
          candidate.schemaVersion === 'bayn.autonomous-cycle.v3' &&
          candidate.identity.executionPolicy.schemaVersion === 'bayn.autonomous-cycle-execution-policy.v2'
            ? candidate.identity.executionPolicy.submissionCutoffAfterOpenMs
            : null
        },
        ${candidate.window.schemaVersion}, ${candidate.window.executionCalendarSchemaVersion},
        ${candidate.window.executionCalendarSource}, ${candidate.window.executionCalendarHash},
        ${candidate.window.executionSessionDate},
        ${candidate.window.schemaVersion !== 'bayn.autonomous-cycle-window.v3' ? candidate.window.signalCloseAt : null},
        ${
          candidate.window.schemaVersion !== 'bayn.autonomous-cycle-window.v3'
            ? candidate.window.publicationDeadlineAt
            : null
        },
        ${candidate.window.submissionOpenAt}, ${candidate.window.executionOpenAt},
        ${candidate.window.executionCloseAt}, ${candidate.window.submissionCutoffAt},
        ${candidate.state}, NULL, NULL, ${candidate.terminalReason ?? null}, ${candidate.stateVersion},
        ${candidate.createdAt}, ${candidate.updatedAt}, ${candidate.terminalAt ?? null}
      )
      ON CONFLICT DO NOTHING
      RETURNING cycle_id
    `.pipe(Effect.flatMap(decodeMutationRows))

  const lockAuthoritySlot: CycleMutationPrimitives['lockAuthoritySlot'] = (candidate) => {
    const query =
      candidate.identity.schemaVersion === 'bayn.autonomous-cycle-identity.v3'
        ? sql<Record<string, unknown>>`
            SELECT cycle_id
            FROM autonomous_cycles
            WHERE qualification_run_id = ${candidate.identity.qualificationRunId}
              AND account_id = ${candidate.identity.accountId}
              AND schema_version = 'bayn.autonomous-cycle.v3'
              AND execution_session_date = ${candidate.identity.executionSessionDate}
            FOR UPDATE
          `
        : sql<Record<string, unknown>>`
      SELECT cycle_id
      FROM autonomous_cycles
      WHERE qualification_run_id = ${candidate.identity.qualificationRunId}
        AND account_id = ${candidate.identity.accountId}
        AND signal_session_date = ${candidate.identity.signalSessionDate}
      FOR UPDATE
    `
    return query.pipe(
      Effect.flatMap(decodeMutationRows),
      Effect.flatMap((rows) => {
        const cycleId = rows[0]?.cycle_id
        return rows.length === 1 && cycleId !== undefined
          ? Effect.succeed(cycleId)
          : failCycleStore('acquire', 'invariant', 'autonomous cycle authority slot was not found exactly once')
      }),
    )
  }

  return { readLocked, requireApplied, blockCycle, insertCycle, lockAuthoritySlot }
}

export const makeCycleMutationPrimitives = Pipeable.dual(2, makeCycleMutationPrimitivesDataFirst)
