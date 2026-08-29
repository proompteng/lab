import { PgClient } from '@effect/sql-pg'
import { Effect } from 'effect'

import { legacyExecutionAuthorityToken } from '../../execution/legacy-wire'
import type { CycleDecisionDocument, ExecutionDecisionDocument } from '../../shadow-decision-contract'
import { CycleState, type AutonomousCycle } from '../model'
import { attachCycleDecisionStoreEvidence } from './decision-contract'
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
  ) => Effect.Effect<readonly CycleDecisionDocument[], CycleStoreInternalError>
  readonly selectOldestUnfinishedCycle: (
    scope: CycleRecoveryScope,
  ) => Effect.Effect<readonly AutonomousCycle[], CycleStoreInternalError>
  readonly decisionEvidenceMatches: (document: CycleDecisionDocument) => Effect.Effect<boolean, CycleStoreInternalError>
  readonly executionCompletionEvidenceMatches: (
    document: ExecutionDecisionDocument,
    observedAt: string,
  ) => Effect.Effect<boolean, CycleStoreInternalError>
  readonly executionGenerationIsSuperseded: (
    document: ExecutionDecisionDocument,
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
            submission_cutoff_after_open_ms, warmup_after_open_ms, submission_cutoff_before_close_ms,
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
            submission_cutoff_after_open_ms, warmup_after_open_ms, submission_cutoff_before_close_ms,
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

  const selectCycleByAuthoritySlot: CycleQueries['selectCycleByAuthoritySlot'] = (slot) => {
    const query =
      'executionSessionDate' in slot
        ? sql<Record<string, unknown>>`
          SELECT
            cycle_id, schema_version, identity_schema_version, strategy_name,
            qualification_run_id, strategy_protocol_hash, account_id,
            signal_session_date::text AS signal_session_date, signal_calendar_version,
            execution_policy_schema_version, execution_policy_hash,
            strategy_execution_model_hash, submission_window_ms, submission_cutoff_before_open_ms,
            submission_cutoff_after_open_ms, warmup_after_open_ms, submission_cutoff_before_close_ms,
            window_schema_version, execution_calendar_schema_version,
            execution_calendar_source, execution_calendar_hash,
            execution_session_date::text AS execution_session_date,
            signal_close_at, publication_deadline_at, submission_open_at,
            execution_open_at, execution_close_at, submission_cutoff_at, state, snapshot_id,
            decision_hash, terminal_reason, state_version, created_at, updated_at, terminal_at
          FROM autonomous_cycles
          WHERE qualification_run_id = ${slot.qualificationRunId}
            AND account_id = ${slot.accountId}
            AND schema_version IN ('bayn.autonomous-cycle.v2', 'bayn.autonomous-cycle.v3')
            AND execution_session_date = ${slot.executionSessionDate}
        `
        : sql<Record<string, unknown>>`
      SELECT
        cycle_id, schema_version, identity_schema_version, strategy_name,
        qualification_run_id, strategy_protocol_hash, account_id,
        signal_session_date::text AS signal_session_date, signal_calendar_version,
        execution_policy_schema_version, execution_policy_hash,
        strategy_execution_model_hash, submission_window_ms, submission_cutoff_before_open_ms,
        submission_cutoff_after_open_ms, warmup_after_open_ms, submission_cutoff_before_close_ms,
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
    `
    return query.pipe(Effect.flatMap(decodeStoredCycles))
  }

  const selectDecisionDocuments: CycleQueries['selectDecisionDocuments'] = (cycleId) =>
    sql<Record<string, unknown>>`
      SELECT
        document,
        paper_cycle_completion_evidence_matches(
          cycle_id,
          decision_hash,
          clock_timestamp()
        ) AS execution_completion_evidence_matches,
        paper_cycle_generation_is_superseded(
          cycle_id,
          decision_hash
        ) AS execution_generation_is_superseded
      FROM autonomous_cycle_shadow_decisions
      WHERE cycle_id = ${cycleId}
    `.pipe(
      Effect.flatMap(decodeStoredDecisionDocumentRows),
      Effect.map((rows) =>
        rows.map(({ document, execution_completion_evidence_matches, execution_generation_is_superseded }) =>
          attachCycleDecisionStoreEvidence(document, {
            executionCompletionEvidenceMatches: execution_completion_evidence_matches,
            executionGenerationIsSuperseded: execution_generation_is_superseded,
          }),
        ),
      ),
    )

  const selectOldestUnfinishedCycle: CycleQueries['selectOldestUnfinishedCycle'] = (scope) =>
    sql<Record<string, unknown>>`
      WITH cycle_candidates AS (
        SELECT
          cycle.*,
          decision.document IS NOT NULL AS is_planned_execution,
          CASE
            WHEN decision.document IS NULL THEN false
            ELSE paper_cycle_generation_is_superseded(cycle.cycle_id, cycle.decision_hash)
          END AS generation_is_superseded,
          CASE
            WHEN decision.document IS NULL THEN false
            ELSE EXISTS (
              SELECT 1
              FROM jsonb_array_elements_text(
                CASE
                  WHEN jsonb_typeof(decision.document -> 'orderedIntentIds') = 'array'
                    THEN decision.document -> 'orderedIntentIds'
                  ELSE '[]'::jsonb
                END
              ) AS planned(intent_id)
              JOIN intents AS intent
                ON intent.intent_id = planned.intent_id
                AND intent.account_id = cycle.account_id
                AND intent.cycle_id = cycle.cycle_id
                AND intent.decision_hash = decision.document #>> '{bindings,strategyDecisionHash}'
              JOIN LATERAL (
                SELECT
                  event.operation,
                  event.event_type
                FROM mutation_events AS event
                WHERE event.intent_id = intent.intent_id
                ORDER BY
                  CASE event.operation WHEN 'CANCEL' THEN 1 ELSE 0 END DESC,
                  event.sequence DESC
                LIMIT 1
              ) AS latest ON true
              WHERE intent.state <> 'TERMINAL'
                OR (
                  intent.state = 'TERMINAL'
                  AND intent.terminal_outcome = 'FILLED'
                )
                OR (
                  intent.state = 'TERMINAL'
                  AND intent.terminal_outcome <> 'FILLED'
                  AND EXISTS (
                    SELECT 1
                    FROM orders AS partial_order
                    WHERE partial_order.account_id = intent.account_id
                      AND partial_order.intent_id = intent.intent_id
                      AND partial_order.filled_quantity_micros > 0
                  )
                )
                OR (
                  latest.operation = 'SUBMIT'
                  AND latest.event_type NOT IN (
                    'SUBMIT_ACCEPTED',
                    'SUBMIT_REJECTED',
                    'SUBMIT_DENIED',
                    'RECOVERY_FOUND'
                  )
                )
                OR (
                  latest.operation = 'CANCEL'
                  AND latest.event_type <> 'RECOVERY_FOUND'
                )
            )
          END AS has_mutation_work
        FROM autonomous_cycles AS cycle
        LEFT JOIN autonomous_cycle_shadow_decisions AS decision
          ON decision.cycle_id = cycle.cycle_id
          AND decision.decision_hash = cycle.decision_hash
          AND decision.document ->> 'schemaVersion' = 'bayn.paper-cycle-decision.v1'
          AND decision.document ->> 'mode' = 'PAPER'
          AND decision.document #>> '{targetPlan,status}' = 'PLANNED'
        WHERE cycle.account_id = ${scope.accountId}
          AND cycle.state IN (${CycleState.Pending}, ${CycleState.Active})
      ), eligible_cycles AS (
        SELECT *
        FROM cycle_candidates
        WHERE qualification_run_id = ${scope.qualificationRunId}
          OR (
            state = ${CycleState.Active}
            AND is_planned_execution
            AND (has_mutation_work OR generation_is_superseded)
          )
      )
      SELECT
        cycle.cycle_id, cycle.schema_version, cycle.identity_schema_version, cycle.strategy_name,
        cycle.qualification_run_id, cycle.strategy_protocol_hash, cycle.account_id,
        cycle.signal_session_date::text AS signal_session_date, cycle.signal_calendar_version,
        cycle.execution_policy_schema_version, cycle.execution_policy_hash,
        cycle.strategy_execution_model_hash, cycle.submission_window_ms, cycle.submission_cutoff_before_open_ms,
        cycle.submission_cutoff_after_open_ms, cycle.warmup_after_open_ms, cycle.submission_cutoff_before_close_ms,
        cycle.window_schema_version, cycle.execution_calendar_schema_version,
        cycle.execution_calendar_source, cycle.execution_calendar_hash,
        cycle.execution_session_date::text AS execution_session_date,
        cycle.signal_close_at, cycle.publication_deadline_at, cycle.submission_open_at,
        cycle.execution_open_at, cycle.execution_close_at, cycle.submission_cutoff_at, cycle.state, cycle.snapshot_id,
        cycle.decision_hash, cycle.terminal_reason, cycle.state_version, cycle.created_at, cycle.updated_at, cycle.terminal_at
      FROM eligible_cycles AS cycle
      ORDER BY
        CASE
          WHEN cycle.has_mutation_work THEN 0
          WHEN cycle.is_planned_execution THEN 1
          ELSE 2
        END ASC,
        cycle.execution_session_date ASC,
        cycle.cycle_id ASC
      LIMIT 1
    `.pipe(Effect.flatMap(decodeStoredCycles))

  const decisionEvidenceMatches: CycleQueries['decisionEvidenceMatches'] = (document) => {
    const executionMarketData = document.bindings.executionMarketData
    const riskContext = document.mode === legacyExecutionAuthorityToken ? document.bindings.riskContext : undefined
    const riskState = document.mode === legacyExecutionAuthorityToken ? document.deltaRisk[0]?.facts?.state : undefined
    const riskContextEvidence =
      riskContext === undefined || riskState === undefined
        ? sql`${riskContext === undefined}`
        : sql`
            reconciliation.reconciled_at = ${riskState.reconciliation.reconciledAt}::timestamptz
            AND EXISTS (
              SELECT 1
              FROM authority_state AS authority
              JOIN authority_generations AS generation
                ON generation.generation_hash = authority.generation_hash
              WHERE authority.singleton
                AND authority.schema_version = ${riskContext.authority.schemaVersion}
                AND authority.generation_hash = ${riskContext.authority.generationHash}
                AND authority.maximum = ${riskContext.authority.maximum}
                AND authority.effective = ${riskContext.authority.effective}
                AND authority.kill_state = ${riskContext.authority.kill}
                AND authority.reason IS NOT DISTINCT FROM ${riskContext.authority.reason ?? null}::text
                AND authority.version = ${riskContext.authority.version}
                AND authority.updated_at = ${riskContext.authority.updatedAt}::timestamptz
                AND generation.risk_policy_hash = ${document.bindings.policyHash}
            )
            AND ${riskContext.authorityObservedAt}::timestamptz <= ${document.createdAt}::timestamptz
            AND coalesce((
              SELECT sum(transaction.notional_micros)::text
              FROM accounting_transactions AS transaction
              WHERE transaction.account_id = ${document.bindings.accountId}
                AND transaction.occurred_at <= ${riskState.reconciliation.reconciledAt}::timestamptz
                AND (transaction.occurred_at AT TIME ZONE 'America/New_York')::date =
                  (${riskState.reconciliation.reconciledAt}::timestamptz AT TIME ZONE 'America/New_York')::date
            ), '0') = ${riskContext.dailyTradedNotionalMicros}
            AND (
              SELECT valuation.equity_micros::text
              FROM valuations AS valuation
              WHERE valuation.account_id = ${document.bindings.accountId}
                AND valuation.as_of <= ${riskState.reconciliation.reconciledAt}::timestamptz
                AND (valuation.as_of AT TIME ZONE 'America/New_York')::date =
                  (${riskState.reconciliation.reconciledAt}::timestamptz AT TIME ZONE 'America/New_York')::date
              ORDER BY valuation.as_of, valuation.valuation_id COLLATE "C"
              LIMIT 1
            ) = ${riskContext.dayStartEquityMicros}
            AND (
              SELECT max(valuation.equity_micros)::text
              FROM valuations AS valuation
              WHERE valuation.account_id = ${document.bindings.accountId}
                AND valuation.as_of <= ${riskState.reconciliation.reconciledAt}::timestamptz
            ) = ${riskContext.peakEquityMicros}
            AND (
              SELECT count(*)::integer
              FROM intents AS intent
              JOIN LATERAL (
                SELECT event.operation, event.event_type
                FROM mutation_events AS event
                WHERE event.intent_id = intent.intent_id
                  AND event.occurred_at <= ${riskState.reconciliation.reconciledAt}::timestamptz
                ORDER BY
                  CASE event.operation WHEN 'CANCEL' THEN 1 ELSE 0 END DESC,
                  event.sequence DESC
                LIMIT 1
              ) AS latest ON true
              WHERE intent.account_id = ${document.bindings.accountId}
                AND (
                  latest.event_type IN (
                    'SUBMIT_STARTED', 'SUBMIT_UNKNOWN', 'RECOVERY_NOT_FOUND', 'RECOVERY_UNKNOWN',
                    'CANCEL_STARTED', 'CANCEL_ACCEPTED', 'CANCEL_UNKNOWN'
                  )
                  OR (
                    latest.operation = 'CANCEL'
                    AND latest.event_type = 'RECOVERY_FOUND'
                    AND (
                      intent.state <> 'TERMINAL'
                      OR intent.updated_at > ${riskState.reconciliation.reconciledAt}::timestamptz
                    )
                  )
                )
            ) = ${riskContext.unknownMutationCount}
          `
    const snapshotEvidence =
      executionMarketData === undefined
        ? sql`
            EXISTS (
              SELECT 1
              FROM snapshot_references AS snapshot
              WHERE snapshot.snapshot_id = ${document.bindings.snapshotId}
                AND snapshot.content_hash = ${document.bindings.snapshotContentHash}
                AND snapshot.manifest ->> 'finalizedAt' = ${document.bindings.snapshotFinalizedAt}
            )
          `
        : executionMarketData.schemaVersion === 'bayn.execution-market-data-binding.v2'
          ? sql`
              ${document.bindings.snapshotId} = ${executionMarketData.snapshotId}
              AND ${document.bindings.snapshotContentHash} = ${executionMarketData.contentHash}
              AND ${document.bindings.snapshotFinalizedAt} = ${executionMarketData.observedAt}
              AND EXISTS (
                SELECT 1
                FROM intraday_snapshot_references AS snapshot
                WHERE snapshot.snapshot_id = ${executionMarketData.snapshotId}
                  AND snapshot.content_hash = ${executionMarketData.contentHash}
                  AND snapshot.observed_at = ${executionMarketData.observedAt}::timestamptz
              )
            `
          : sql`
              ${document.bindings.snapshotId} = ${executionMarketData.snapshotId}
              AND ${document.bindings.snapshotContentHash} = ${executionMarketData.contentHash}
              AND ${document.bindings.snapshotFinalizedAt} = ${executionMarketData.observedAt}
            `
    return sql<Record<string, unknown>>`
      SELECT EXISTS (
        SELECT 1
        FROM reconciliations AS reconciliation
        WHERE ${snapshotEvidence}
          AND ${riskContextEvidence}
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
  }

  const executionCompletionEvidenceMatches: CycleQueries['executionCompletionEvidenceMatches'] = (
    document,
    observedAt,
  ) =>
    sql<Record<string, unknown>>`
      SELECT paper_cycle_completion_evidence_matches(
        ${document.bindings.cycleId},
        ${document.contentHash},
        ${observedAt}::timestamptz
      ) AS matches
    `.pipe(
      Effect.flatMap(decodeDecisionEvidenceMatch),
      Effect.map(([match]) => match.matches),
    )

  const executionGenerationIsSuperseded: CycleQueries['executionGenerationIsSuperseded'] = (document) =>
    sql<Record<string, unknown>>`
      SELECT paper_cycle_generation_is_superseded(
        ${document.bindings.cycleId},
        ${document.contentHash}
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
    executionCompletionEvidenceMatches,
    executionGenerationIsSuperseded,
  }
}
