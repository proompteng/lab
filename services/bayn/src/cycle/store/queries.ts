import { PgClient } from '@effect/sql-pg'
import { Effect, Schema } from 'effect'
import { postgresWallClock, type DatabaseClock } from '../../db/clock'

import { legacyExecutionAuthorityToken } from '../../execution/legacy-wire'
import {
  CycleDecisionDocumentSchema,
  type CycleDecisionDocument,
  type ExecutionDecisionDocument,
} from '../../shadow-decision-contract'
import { strictParseOptions } from '../../schemas'
import { canonicalJsonV1Result } from '../../hash'
import { CycleState, type AutonomousCycle } from '../model'
import { attachCycleDecisionStoreEvidence } from './decision-contract'
import {
  DecisionEvidenceMismatch,
  cycleStoreError,
  type CycleAuthoritySlot,
  type CycleRecoveryScope,
  type CycleStoreInternalError,
} from './model'
import {
  decodeDecisionEvidenceMatch,
  decodeDecisionEvidenceMismatch,
  decodeStoredCycles,
  decodeStoredDecisionDocumentRows,
} from './rows'

export interface CycleQueries {
  /** Accepts only the complete document already validated by the binding program. */
  readonly retainValidatedDecision: (document: CycleDecisionDocument) => Effect.Effect<void, CycleStoreInternalError>
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
  readonly decisionEvidenceMismatch: (
    document: CycleDecisionDocument,
  ) => Effect.Effect<DecisionEvidenceMismatch | null, CycleStoreInternalError>
  readonly executionCompletionEvidenceMatches: (
    document: ExecutionDecisionDocument,
    observedAt: string,
  ) => Effect.Effect<boolean, CycleStoreInternalError>
  readonly executionGenerationIsSuperseded: (
    document: ExecutionDecisionDocument,
  ) => Effect.Effect<boolean, CycleStoreInternalError>
}

export const makeCycleQueries = (
  sql: PgClient.PgClient,
  clock: DatabaseClock = postgresWallClock(sql),
): CycleQueries => {
  // This is a pure decoding receipt, never proof that a decision committed. Every
  // reuse still needs a fresh row and PostgreSQL equality against its whole JSON.
  let retainedDocument: CycleDecisionDocument | undefined
  const retainValidatedDecision: CycleQueries['retainValidatedDecision'] = (document) =>
    Effect.gen(function* () {
      const json = yield* Effect.fromResult(canonicalJsonV1Result(document))
      yield* Effect.try(() => {
        // Retain one bounded wire document, detached from all caller-owned objects.
        // JSON round-tripping matches PostgreSQL's wire values (including -0).
        retainedDocument =
          Buffer.byteLength(json, 'utf8') <= 8 * 1024 * 1024 ? (JSON.parse(json) as CycleDecisionDocument) : undefined
      })
    }).pipe(
      Effect.mapError((cause) =>
        cycleStoreError({
          operation: 'bind-decision',
          failure: 'decode',
          message: 'validated decision could not be retained as wire JSON',
          cause,
        }),
      ),
    )

  const selectCycle: CycleQueries['selectCycle'] = (cycleId, locked) => {
    const rows = locked
      ? sql<Record<string, unknown>>`
          SELECT
            cycle_id, schema_version, identity_schema_version, strategy_name,
            qualification_run_id, strategy_protocol_hash, account_id, entry_attempt_ordinal,
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
            qualification_run_id, strategy_protocol_hash, account_id, entry_attempt_ordinal,
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
            qualification_run_id, strategy_protocol_hash, account_id, entry_attempt_ordinal,
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
            AND schema_version IN ('bayn.autonomous-cycle.v2', 'bayn.autonomous-cycle.v3', 'bayn.autonomous-cycle.v4')
            AND execution_session_date = ${slot.executionSessionDate}
          ORDER BY entry_attempt_ordinal DESC
          LIMIT 1
        `
        : sql<Record<string, unknown>>`
      SELECT
        cycle_id, schema_version, identity_schema_version, strategy_name,
        qualification_run_id, strategy_protocol_hash, account_id, entry_attempt_ordinal,
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
    Effect.gen(function* () {
      // Capture once: another fiber may replace the slot while this query waits.
      const retained = retainedDocument
      const rows = yield* sql<Record<string, unknown>>`
      SELECT
        document,
        COALESCE(document = ${sql.json(retained ?? null)}::jsonb, false) AS matches_retained_document,
        paper_cycle_completion_evidence_matches(
          cycle_id,
          decision_hash,
          ${clock.now}
        ) AS execution_completion_evidence_matches,
        paper_cycle_generation_is_superseded(
          cycle_id,
          decision_hash
        ) AS execution_generation_is_superseded
      FROM autonomous_cycle_shadow_decisions
      WHERE cycle_id = ${cycleId}
      `.pipe(Effect.flatMap(decodeStoredDecisionDocumentRows))
      return yield* Effect.forEach(rows, (row) =>
        Effect.gen(function* () {
          const document =
            retained !== undefined && row.matches_retained_document
              ? structuredClone(retained)
              : yield* Schema.decodeUnknownEffect(CycleDecisionDocumentSchema, strictParseOptions)(row.document)
          return attachCycleDecisionStoreEvidence(document, {
            executionCompletionEvidenceMatches: row.execution_completion_evidence_matches,
            executionGenerationIsSuperseded: row.execution_generation_is_superseded,
          })
        }),
      )
    })

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
        LEFT JOIN LATERAL (
          SELECT stored.document
          FROM autonomous_cycle_shadow_decisions AS stored
          WHERE stored.cycle_id = cycle.cycle_id
            AND stored.decision_hash = cycle.decision_hash
            AND stored.document ->> 'schemaVersion' = 'bayn.paper-cycle-decision.v1'
            AND stored.document ->> 'mode' = 'PAPER'
            AND stored.document #>> '{targetPlan,status}' = 'PLANNED'
          LIMIT 1
        ) AS decision ON true
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
        cycle.qualification_run_id, cycle.strategy_protocol_hash, cycle.account_id, cycle.entry_attempt_ordinal,
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

  const decisionEvidenceMismatch: CycleQueries['decisionEvidenceMismatch'] = (document) => {
    const executionMarketData = document.bindings.executionMarketData
    const decisionMarketData = document.bindings.decisionMarketData ?? executionMarketData
    const riskContext = document.mode === legacyExecutionAuthorityToken ? document.bindings.riskContext : undefined
    const riskState = document.mode === legacyExecutionAuthorityToken ? document.deltaRisk[0]?.facts?.state : undefined
    const riskContextEvidence =
      riskContext === undefined
        ? sql`${document.mode !== legacyExecutionAuthorityToken}`
        : sql`
            ${
              riskState === undefined
                ? sql`${document.targetPlan.intentTargets.length === 0 && document.deltaRisk.length === 0}`
                : sql`reconciliation.reconciled_at = ${riskState.reconciliation.reconciledAt}::timestamptz`
            }
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
                AND transaction.occurred_at <= reconciliation.reconciled_at
                AND (transaction.occurred_at AT TIME ZONE 'America/New_York')::date =
                  (reconciliation.reconciled_at AT TIME ZONE 'America/New_York')::date
            ), '0') = ${riskContext.dailyTradedNotionalMicros}
            AND (
              SELECT valuation.equity_micros::text
              FROM valuations AS valuation
              WHERE valuation.account_id = ${document.bindings.accountId}
                AND valuation.as_of <= reconciliation.reconciled_at
                AND (valuation.as_of AT TIME ZONE 'America/New_York')::date =
                  (reconciliation.reconciled_at AT TIME ZONE 'America/New_York')::date
              ORDER BY valuation.as_of, valuation.valuation_id COLLATE "C"
              LIMIT 1
            ) = ${riskContext.dayStartEquityMicros}
            AND (
              SELECT max(valuation.equity_micros)::text
              FROM valuations AS valuation
              WHERE valuation.account_id = ${document.bindings.accountId}
                AND valuation.as_of <= reconciliation.reconciled_at
            ) = ${riskContext.peakEquityMicros}
            AND (
              SELECT count(*)::integer
              FROM intents AS intent
              JOIN LATERAL (
                SELECT event.operation, event.event_type
                FROM mutation_events AS event
                WHERE event.intent_id = intent.intent_id
                  AND event.occurred_at <= reconciliation.reconciled_at
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
                      OR intent.updated_at > reconciliation.reconciled_at
                    )
                  )
                )
            ) = ${riskContext.unknownMutationCount}
          `
    const snapshotEvidence =
      decisionMarketData === undefined
        ? sql`
            EXISTS (
              SELECT 1
              FROM snapshot_references AS snapshot
              WHERE snapshot.snapshot_id = ${document.bindings.snapshotId}
                AND snapshot.content_hash = ${document.bindings.snapshotContentHash}
                AND snapshot.manifest ->> 'finalizedAt' = ${document.bindings.snapshotFinalizedAt}
            )
          `
        : decisionMarketData.schemaVersion === 'bayn.execution-market-data-binding.v3' ||
            decisionMarketData.schemaVersion === 'bayn.execution-market-data-binding.v4'
          ? sql`
              ${document.bindings.snapshotId} = ${decisionMarketData.snapshotId}
              AND ${document.bindings.snapshotContentHash} = ${decisionMarketData.contentHash}
              AND ${document.bindings.snapshotFinalizedAt} = ${decisionMarketData.observedAt}
              AND EXISTS (
                SELECT 1
                FROM ${sql(decisionMarketData.schemaVersion === 'bayn.execution-market-data-binding.v4' ? 'simulated_snapshot_references' : 'streaming_snapshot_references')} AS snapshot
                WHERE snapshot.snapshot_id = ${decisionMarketData.snapshotId}
                  AND snapshot.content_hash = ${decisionMarketData.contentHash}
                  AND snapshot.observed_at = ${decisionMarketData.observedAt}::timestamptz
              )
            `
          : sql`
              ${document.bindings.snapshotId} = ${decisionMarketData.snapshotId}
              AND ${document.bindings.snapshotContentHash} = ${decisionMarketData.contentHash}
              AND ${document.bindings.snapshotFinalizedAt} = ${decisionMarketData.observedAt}
            `
    const pricing = document.bindings.executionMarketData
    const pricingEvidence =
      pricing?.schemaVersion === 'bayn.execution-market-data-binding.v3' ||
      pricing?.schemaVersion === 'bayn.execution-market-data-binding.v4'
        ? sql`EXISTS (SELECT 1 FROM ${sql(pricing.schemaVersion === 'bayn.execution-market-data-binding.v4' ? 'simulated_snapshot_references' : 'streaming_snapshot_references')} AS snapshot
          WHERE snapshot.snapshot_id = ${pricing.snapshotId}
            AND snapshot.content_hash = ${pricing.contentHash}
            AND snapshot.observed_at = ${pricing.observedAt}::timestamptz)`
        : sql`true`
    const jev =
      document.mode === legacyExecutionAuthorityToken &&
      document.strategyDecision?.schemaVersion === 'bayn.jev-entry-target.v1'
        ? document.strategyDecision.evidence
        : undefined
    const jevEvidence =
      jev === undefined
        ? sql`true`
        : sql`EXISTS (
      SELECT 1 FROM jev_batch_plans AS plan
      JOIN jev_batch_results AS result USING (batch_id)
      JOIN intraday_candidate_observations AS observation ON observation.content_hash = plan.observation_hash
      WHERE plan.batch_id = ${jev.batchPlan.batchId} AND plan.payload = ${sql.json(jev.batchPlan)}
        AND result.result_hash = ${jev.batchResult.resultHash} AND result.payload = ${sql.json(jev.batchResult)}
        AND observation.payload = ${sql.json(jev.observation)}
        AND plan.cycle_id = ${document.bindings.cycleId}
    )`
    return sql<Record<string, unknown>>`
      SELECT CASE
        WHEN reconciliation.reconciliation_id IS NULL THEN ${DecisionEvidenceMismatch.Reconciliation}::text
        WHEN NOT coalesce(${snapshotEvidence}, false) THEN ${DecisionEvidenceMismatch.DecisionMarketData}::text
        WHEN NOT coalesce(${pricingEvidence}, false) THEN ${DecisionEvidenceMismatch.ExecutionMarketData}::text
        WHEN NOT coalesce(${jevEvidence}, false) THEN ${DecisionEvidenceMismatch.Jev}::text
        WHEN NOT coalesce(${riskContextEvidence}, false) THEN ${DecisionEvidenceMismatch.RiskContext}::text
        ELSE NULL
      END AS mismatch
      FROM (VALUES (1)) AS scope(singleton)
      LEFT JOIN reconciliations AS reconciliation
        ON reconciliation.reconciliation_id = ${document.bindings.reconciliationId}
        AND reconciliation.account_id = ${document.bindings.accountId}
        AND reconciliation.expected_hash = ${document.bindings.planningBrokerStateHash}
        AND reconciliation.observed_hash = ${document.bindings.planningBrokerStateHash}
        AND reconciliation.content_hash = ${document.bindings.reconciliationHash}
        AND reconciliation.status = 'EXACT'
        AND reconciliation.reconciled_at <= ${document.createdAt}
    `.pipe(
      Effect.flatMap(decodeDecisionEvidenceMismatch),
      Effect.map(([match]) => match.mismatch),
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
    retainValidatedDecision,
    selectCycle,
    selectCycleByAuthoritySlot,
    selectDecisionDocuments,
    selectOldestUnfinishedCycle,
    decisionEvidenceMismatch,
    executionCompletionEvidenceMatches,
    executionGenerationIsSuperseded,
  }
}
