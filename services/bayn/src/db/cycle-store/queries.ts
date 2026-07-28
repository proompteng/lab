import { PgClient } from '@effect/sql-pg'
import { Effect } from 'effect'

import { CycleState, type AutonomousCycle } from '../../cycle'
import type { ObserveShadowDecisionDocument } from '../../shadow-decision-contract'
import type { CycleAuthoritySlot, CycleRecoveryScope, CycleStoreInternalError } from './model'
import { decodeDecisionEvidenceMatch, decodeStoredCycles, decodeStoredDecisionDocumentRows } from './rows'

export interface CycleQueries {
  readonly selectCycle: (
    cycleId: string,
    locked: boolean,
  ) => Effect.Effect<readonly AutonomousCycle[], CycleStoreInternalError>
  readonly selectCycleByAuthoritySlot: (
    slot: CycleAuthoritySlot,
  ) => Effect.Effect<readonly AutonomousCycle[], CycleStoreInternalError>
  readonly selectDecisionDocuments: (
    cycleId: string,
  ) => Effect.Effect<readonly ObserveShadowDecisionDocument[], CycleStoreInternalError>
  readonly selectOldestUnfinishedCycle: (
    scope: CycleRecoveryScope,
  ) => Effect.Effect<readonly AutonomousCycle[], CycleStoreInternalError>
  readonly decisionEvidenceMatches: (
    document: ObserveShadowDecisionDocument,
  ) => Effect.Effect<boolean, CycleStoreInternalError>
}

export const makeCycleQueries = (sql: PgClient.PgClient): CycleQueries => {
  const selectCycle: CycleQueries['selectCycle'] = (cycleId, locked) => {
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
    return rows.pipe(Effect.flatMap(decodeStoredCycles))
  }

  const selectCycleByAuthoritySlot: CycleQueries['selectCycleByAuthoritySlot'] = (slot) =>
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
    `.pipe(Effect.flatMap(decodeStoredCycles))

  const selectDecisionDocuments: CycleQueries['selectDecisionDocuments'] = (cycleId) =>
    sql<Record<string, unknown>>`
      SELECT document
      FROM autonomous_cycle_shadow_decisions
      WHERE cycle_id = ${cycleId}
    `.pipe(
      Effect.flatMap(decodeStoredDecisionDocumentRows),
      Effect.map((rows) => rows.map(({ document }) => document)),
    )

  const selectOldestUnfinishedCycle: CycleQueries['selectOldestUnfinishedCycle'] = (scope) =>
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
    `.pipe(Effect.flatMap(decodeStoredCycles))

  const decisionEvidenceMatches: CycleQueries['decisionEvidenceMatches'] = (document) =>
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

  return {
    selectCycle,
    selectCycleByAuthoritySlot,
    selectDecisionDocuments,
    selectOldestUnfinishedCycle,
    decisionEvidenceMatches,
  }
}
