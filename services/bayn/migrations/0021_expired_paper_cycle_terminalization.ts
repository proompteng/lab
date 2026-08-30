import { Effect } from 'effect'
import { SqlClient } from 'effect/unstable/sql'

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient

  yield* sql`
    ALTER TABLE autonomous_cycle_shadow_decisions
      DROP CONSTRAINT IF EXISTS autonomous_cycle_shadow_decisions_schema_version_check,
      DROP CONSTRAINT IF EXISTS autonomous_cycle_shadow_decisions_check,
      DROP CONSTRAINT IF EXISTS autonomous_cycle_decisions_schema_version_check,
      DROP CONSTRAINT IF EXISTS autonomous_cycle_decisions_document_check,
      ADD CONSTRAINT autonomous_cycle_decisions_schema_version_check
        CHECK (schema_version IN ('bayn.observe-shadow-decision.v1', 'bayn.paper-cycle-decision.v1')),
      ADD CONSTRAINT autonomous_cycle_decisions_document_check
        CHECK (
          document ->> 'schemaVersion' = schema_version
          AND (
            (
              schema_version = 'bayn.observe-shadow-decision.v1'
              AND document ->> 'mode' = 'OBSERVE'
              AND document ->> 'dispatchable' = 'false'
            )
            OR (
              schema_version = 'bayn.paper-cycle-decision.v1'
              AND document ->> 'mode' = 'PAPER'
              AND (
                document ->> 'dispatchable' = 'true'
                OR (
                  document ->> 'dispatchable' = 'false'
                  AND jsonb_typeof(document -> 'riskBlock') = 'object'
                )
              )
            )
          )
          AND document #>> '{bindings,cycleId}' = cycle_id
          AND (document ->> 'createdAt')::timestamptz = created_at
        )
  `

  yield* sql`
    CREATE OR REPLACE FUNCTION paper_cycle_generation_is_superseded(
      bound_cycle_id text,
      bound_decision_hash text
    )
    RETURNS boolean
    LANGUAGE sql
    STABLE
    AS $function$
      WITH RECURSIVE bound_decision AS (
        SELECT
          decision.document #>> '{bindings,authorityGenerationHash}' AS generation_hash,
          decision.document #>> '{bindings,accountId}' AS account_id,
          decision.document #>> '{bindings,cycleId}' AS cycle_id,
          decision.document #>> '{bindings,strategyDecisionHash}' AS strategy_decision_hash,
          CASE
            WHEN jsonb_typeof(decision.document -> 'orderedIntentIds') = 'array'
              THEN decision.document -> 'orderedIntentIds'
            ELSE '[]'::jsonb
          END AS ordered_intent_ids
        FROM autonomous_cycle_shadow_decisions AS decision
        WHERE decision.cycle_id = bound_cycle_id
          AND decision.decision_hash = bound_decision_hash
          AND decision.document ->> 'schemaVersion' = 'bayn.paper-cycle-decision.v1'
          AND decision.document ->> 'mode' = 'PAPER'
      ), bound_generation AS (
        SELECT generation_hash, account_id
        FROM bound_decision
      ), generation_lineage AS (
        SELECT generation.generation_hash, generation.previous_generation_hash, 0 AS depth
        FROM authority_generations AS generation
        JOIN bound_generation AS bound
          ON bound.generation_hash = generation.generation_hash
        WHERE generation.maximum = 'PAPER'
          AND generation.account_id = bound.account_id

        UNION ALL

        SELECT successor.generation_hash, successor.previous_generation_hash, lineage.depth + 1
        FROM authority_generations AS successor
        JOIN generation_lineage AS lineage
          ON successor.previous_generation_hash = lineage.generation_hash
      ), planned_intents AS (
        SELECT
          decision.account_id,
          decision.cycle_id,
          decision.strategy_decision_hash,
          planned.intent_id
        FROM bound_decision AS decision
        CROSS JOIN LATERAL jsonb_array_elements_text(decision.ordered_intent_ids) AS planned(intent_id)
      ), durable_intents AS (
        SELECT
          planned.intent_id,
          intent.state
        FROM planned_intents AS planned
        LEFT JOIN intents AS intent
          ON intent.intent_id = planned.intent_id
          AND intent.account_id = planned.account_id
          AND intent.cycle_id = planned.cycle_id
          AND intent.decision_hash = planned.strategy_decision_hash
      ), latest_mutations AS (
        SELECT DISTINCT ON (event.intent_id)
          event.intent_id,
          event.operation,
          event.event_type
        FROM mutation_events AS event
        JOIN planned_intents AS planned
          ON planned.intent_id = event.intent_id
        ORDER BY
          event.intent_id,
          CASE event.operation WHEN 'CANCEL' THEN 1 ELSE 0 END DESC,
          event.sequence DESC
      )
      SELECT
        EXISTS (
          SELECT 1
          FROM generation_lineage
          WHERE depth > 0
        )
        AND NOT EXISTS (
          SELECT 1
          FROM latest_mutations AS mutation
          JOIN durable_intents AS intent
            ON intent.intent_id = mutation.intent_id
          WHERE intent.state IS DISTINCT FROM 'TERMINAL'
            OR (
              mutation.operation = 'SUBMIT'
              AND mutation.event_type NOT IN (
                'SUBMIT_ACCEPTED',
                'SUBMIT_REJECTED',
                'SUBMIT_DENIED',
                'RECOVERY_FOUND'
              )
            )
            OR (
              mutation.operation = 'CANCEL'
              AND mutation.event_type <> 'RECOVERY_FOUND'
            )
        )
    $function$
  `

  yield* sql`
    CREATE OR REPLACE FUNCTION paper_account_has_unresolved_mutation(
      bound_account_id text,
      mutation_observed_at timestamptz
    )
    RETURNS boolean
    LANGUAGE sql
    STABLE
    AS $function$
      SELECT EXISTS (
        SELECT 1
        FROM intents AS account_intent
        JOIN LATERAL (
          SELECT
            event.operation,
            event.event_type
          FROM mutation_events AS event
          WHERE event.intent_id = account_intent.intent_id
            AND event.occurred_at <= mutation_observed_at
          ORDER BY
            CASE event.operation WHEN 'CANCEL' THEN 1 ELSE 0 END DESC,
            event.sequence DESC
          LIMIT 1
        ) AS latest ON true
        WHERE account_intent.account_id = bound_account_id
          AND (
            account_intent.state <> 'TERMINAL'
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
      )
    $function$
  `

  yield* sql`
    CREATE OR REPLACE FUNCTION paper_cycle_completion_evidence_matches(
      bound_cycle_id text,
      bound_decision_hash text,
      completion_observed_at timestamptz
    )
    RETURNS boolean
    LANGUAGE sql
    STABLE
    AS $function$
      SELECT EXISTS (
        SELECT 1
        FROM autonomous_cycles AS cycle
        JOIN autonomous_cycle_shadow_decisions AS decision
          ON decision.cycle_id = cycle.cycle_id
          AND decision.decision_hash = cycle.decision_hash
        CROSS JOIN LATERAL (
          SELECT
            CASE
              WHEN jsonb_typeof(decision.document -> 'orderedIntentIds') = 'array'
                THEN decision.document -> 'orderedIntentIds'
              ELSE '[]'::jsonb
            END AS ordered_intent_ids,
            CASE
              WHEN jsonb_typeof(decision.document -> 'deltaRisk') = 'array'
                THEN decision.document -> 'deltaRisk'
              ELSE '[]'::jsonb
            END AS delta_risk
        ) AS paper
        WHERE cycle.cycle_id = bound_cycle_id
          AND decision.decision_hash = bound_decision_hash
          AND completion_observed_at >= cycle.updated_at
          AND decision.document ->> 'schemaVersion' = 'bayn.paper-cycle-decision.v1'
          AND decision.document ->> 'mode' = 'PAPER'
          AND decision.document -> 'dispatchable' = 'true'::jsonb
          AND decision.document -> 'riskBlock' IS NULL
          AND decision.document #>> '{targetPlan,status}' = 'PLANNED'
          AND jsonb_array_length(paper.ordered_intent_ids) > 0
          AND jsonb_array_length(paper.ordered_intent_ids) = jsonb_array_length(paper.delta_risk)
          AND NOT EXISTS (
            SELECT 1
            FROM jsonb_array_elements_text(paper.ordered_intent_ids) WITH ORDINALITY
              AS planned(intent_id, intent_ordinal)
            JOIN jsonb_array_elements(paper.delta_risk) WITH ORDINALITY
              AS risk(entry, risk_ordinal)
              ON risk.risk_ordinal = planned.intent_ordinal
            LEFT JOIN intents AS intent
              ON intent.intent_id = planned.intent_id
            WHERE risk.entry #>> '{evaluation,input,intentId}' IS DISTINCT FROM planned.intent_id
              OR risk.entry #>> '{evaluation,decision,outcome}' IS DISTINCT FROM 'APPROVED'
              OR intent.intent_id IS NULL
              OR intent.account_id IS DISTINCT FROM cycle.account_id
              OR intent.cycle_id IS DISTINCT FROM cycle.cycle_id
              OR intent.strategy_name IS DISTINCT FROM decision.document #>> '{bindings,strategyName}'
              OR intent.decision_hash IS DISTINCT FROM decision.document #>> '{bindings,strategyDecisionHash}'
              OR intent.policy_hash IS DISTINCT FROM decision.document #>> '{bindings,policyHash}'
              OR intent.authority_generation_hash IS DISTINCT FROM
                decision.document #>> '{bindings,authorityGenerationHash}'
              OR intent.risk_decision_id IS DISTINCT FROM
                risk.entry #>> '{evaluation,decision,decisionId}'
              OR intent.state IS DISTINCT FROM 'TERMINAL'
              OR intent.terminal_outcome IS DISTINCT FROM 'FILLED'
          )
          AND NOT EXISTS (
            SELECT 1
            FROM intents AS extra
            WHERE extra.cycle_id = cycle.cycle_id
              AND extra.decision_hash = decision.document #>> '{bindings,strategyDecisionHash}'
              AND NOT (paper.ordered_intent_ids ? extra.intent_id)
          )
          AND NOT paper_account_has_unresolved_mutation(cycle.account_id, completion_observed_at)
          AND NOT EXISTS (
            SELECT 1
            FROM orders AS unknown_order
            WHERE unknown_order.account_id = cycle.account_id
              AND unknown_order.intent_id IS NULL
          )
          AND EXISTS (
            SELECT 1
            FROM reconciliations AS reconciliation
            CROSS JOIN LATERAL (
              SELECT CASE
                WHEN jsonb_typeof(reconciliation.discrepancies) = 'array'
                  THEN reconciliation.discrepancies
                ELSE '[]'::jsonb
              END AS discrepancies
            ) AS exact
            WHERE reconciliation.account_id = cycle.account_id
              AND reconciliation.status = 'EXACT'
              AND reconciliation.expected_hash = reconciliation.observed_hash
              AND jsonb_array_length(exact.discrepancies) = 0
              AND reconciliation.reconciled_at > GREATEST(
                (decision.document ->> 'createdAt')::timestamptz,
                COALESCE(
                  (
                    SELECT max(intent.updated_at)
                    FROM intents AS intent
                    WHERE paper.ordered_intent_ids ? intent.intent_id
                  ),
                  (decision.document ->> 'createdAt')::timestamptz
                ),
                COALESCE(
                  (
                    SELECT max(event.occurred_at)
                    FROM mutation_events AS event
                    WHERE paper.ordered_intent_ids ? event.intent_id
                  ),
                  (decision.document ->> 'createdAt')::timestamptz
                )
              )
              AND reconciliation.reconciled_at <= completion_observed_at
          )
      )
    $function$
  `

  yield* sql`
    CREATE OR REPLACE FUNCTION enforce_autonomous_cycle_lifecycle()
    RETURNS trigger
    LANGUAGE plpgsql
    AS $function$
    DECLARE
      mutable_columns text[] := ARRAY[
        'state',
        'snapshot_id',
        'decision_hash',
        'terminal_reason',
        'state_version',
        'updated_at',
        'terminal_at'
      ];
      expected_target_status text;
    BEGIN
      IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'autonomous cycles cannot be deleted' USING ERRCODE = '55000';
      END IF;

      IF TG_OP = 'INSERT' THEN
        IF NEW.state_version <> 1 OR NEW.created_at <> NEW.updated_at OR NOT (
          (NEW.state = 'PENDING' AND NEW.snapshot_id IS NULL AND NEW.decision_hash IS NULL)
          OR (
            NEW.state = 'BLOCKED'
            AND NEW.snapshot_id IS NULL
            AND NEW.decision_hash IS NULL
            AND NEW.terminal_reason = 'BLOCKED_MISSED_PUBLICATION_DEADLINE'
            AND NEW.updated_at >= NEW.publication_deadline_at
          )
        ) THEN
          RAISE EXCEPTION 'invalid initial autonomous cycle state' USING ERRCODE = '23514';
        END IF;
        RETURN NEW;
      END IF;

      IF OLD.state IN ('COMPLETED', 'NO_TRADE', 'BLOCKED') THEN
        RAISE EXCEPTION 'terminal autonomous cycle history cannot change' USING ERRCODE = '55000';
      END IF;

      IF (OLD.state, NEW.state) NOT IN (
        ('PENDING', 'PENDING'),
        ('PENDING', 'ACTIVE'),
        ('PENDING', 'BLOCKED'),
        ('ACTIVE', 'ACTIVE'),
        ('ACTIVE', 'COMPLETED'),
        ('ACTIVE', 'NO_TRADE'),
        ('ACTIVE', 'BLOCKED')
      ) THEN
        RAISE EXCEPTION 'invalid autonomous cycle state transition' USING ERRCODE = '23514';
      END IF;
      IF OLD.state = NEW.state AND NOT (
        (
          OLD.state = 'PENDING'
          AND OLD.snapshot_id IS NULL
          AND NEW.snapshot_id IS NOT NULL
          AND NEW.decision_hash IS NOT DISTINCT FROM OLD.decision_hash
        )
        OR (
          OLD.state = 'ACTIVE'
          AND NEW.snapshot_id IS NOT DISTINCT FROM OLD.snapshot_id
          AND OLD.decision_hash IS NULL
          AND NEW.decision_hash IS NOT NULL
        )
      ) THEN
        RAISE EXCEPTION 'invalid autonomous cycle binding transition' USING ERRCODE = '23514';
      END IF;
      IF OLD.state <> NEW.state AND (
        NEW.snapshot_id IS DISTINCT FROM OLD.snapshot_id
        OR NEW.decision_hash IS DISTINCT FROM OLD.decision_hash
      ) THEN
        RAISE EXCEPTION 'autonomous cycle state transitions cannot change bindings' USING ERRCODE = '23514';
      END IF;
      IF to_jsonb(OLD) - mutable_columns <> to_jsonb(NEW) - mutable_columns THEN
        RAISE EXCEPTION 'autonomous cycle identity and deadlines cannot change' USING ERRCODE = '55000';
      END IF;
      IF NEW.state_version <> OLD.state_version + 1 OR NEW.updated_at < OLD.updated_at THEN
        RAISE EXCEPTION 'autonomous cycle version and time must advance monotonically' USING ERRCODE = '23514';
      END IF;
      IF OLD.snapshot_id IS NULL AND NEW.snapshot_id IS NOT NULL THEN
        IF NEW.updated_at < NEW.signal_close_at THEN
          RAISE EXCEPTION 'autonomous cycle snapshot cannot bind before signal close' USING ERRCODE = '23514';
        END IF;
        IF NEW.updated_at >= NEW.publication_deadline_at THEN
          RAISE EXCEPTION 'autonomous cycle snapshot missed publication deadline' USING ERRCODE = '23514';
        END IF;
        IF NOT EXISTS (
          SELECT 1
          FROM snapshot_references
          WHERE snapshot_id = NEW.snapshot_id
            AND last_session = NEW.signal_session_date
            AND manifest->>'calendarVersion' = NEW.signal_calendar_version
        ) THEN
          RAISE EXCEPTION 'autonomous cycle snapshot does not match signal session and calendar'
            USING ERRCODE = '23514';
        END IF;
      END IF;
      IF NEW.state = 'ACTIVE' AND NEW.updated_at >= NEW.submission_cutoff_at THEN
        RAISE EXCEPTION 'autonomous cycle activation or decision missed submission cutoff' USING ERRCODE = '23514';
      END IF;
      IF NEW.state IN ('COMPLETED', 'NO_TRADE') THEN
        expected_target_status := CASE NEW.state
          WHEN 'COMPLETED' THEN 'PLANNED'
          ELSE 'NO_TRADE'
        END;
        IF NOT EXISTS (
          SELECT 1
          FROM autonomous_cycle_shadow_decisions
          WHERE cycle_id = NEW.cycle_id
            AND decision_hash = NEW.decision_hash
            AND document #>> '{targetPlan,status}' = expected_target_status
            AND NOT paper_account_has_unresolved_mutation(NEW.account_id, NEW.updated_at)
            AND NOT (
              document ->> 'mode' = 'PAPER'
              AND document ->> 'dispatchable' = 'false'
              AND jsonb_typeof(document -> 'riskBlock') = 'object'
            )
            AND (
              document ->> 'mode' <> 'PAPER'
              OR NEW.state = 'NO_TRADE'
              OR paper_cycle_completion_evidence_matches(
                NEW.cycle_id,
                NEW.decision_hash,
                NEW.updated_at
              )
            )
        ) THEN
          RAISE EXCEPTION 'autonomous cycle terminal state does not match its shadow decision'
            USING ERRCODE = '23514';
        END IF;
      END IF;
      IF NEW.state = 'BLOCKED' AND OLD.state = 'ACTIVE' AND OLD.decision_hash IS NOT NULL THEN
        IF NOT EXISTS (
          SELECT 1
          FROM autonomous_cycle_shadow_decisions AS decision
          CROSS JOIN LATERAL (
            SELECT
              CASE
                WHEN jsonb_typeof(decision.document -> 'orderedIntentIds') = 'array'
                  THEN decision.document -> 'orderedIntentIds'
                ELSE '[]'::jsonb
              END AS ordered_intent_ids,
              CASE
                WHEN jsonb_typeof(decision.document -> 'deltaRisk') = 'array'
                  THEN decision.document -> 'deltaRisk'
                ELSE '[]'::jsonb
              END AS delta_risk,
              CASE
                WHEN jsonb_typeof(decision.document #> '{riskBlock,reasonCodes}') = 'array'
                  THEN decision.document #> '{riskBlock,reasonCodes}'
                ELSE '[]'::jsonb
              END AS risk_block_reason_codes
          ) AS paper
          WHERE decision.cycle_id = NEW.cycle_id
            AND decision.decision_hash = NEW.decision_hash
            AND NOT paper_account_has_unresolved_mutation(NEW.account_id, NEW.updated_at)
            AND (
              (
                decision.document #>> '{targetPlan,status}' = 'BLOCKED'
                AND NEW.terminal_reason = CASE decision.document #>> '{targetPlan,reason}'
                  WHEN 'SUBMISSION_CUTOFF_REACHED' THEN 'BLOCKED_MISSED_SUBMISSION_DEADLINE'
                  WHEN 'IDENTITY_MISMATCH' THEN 'BLOCKED_PROVENANCE_MISMATCH'
                  WHEN 'INPUT_MISMATCH' THEN 'BLOCKED_DATA_INVALID'
                  WHEN 'INPUT_STALE' THEN 'BLOCKED_DATA_STALE'
                  WHEN 'RECONCILIATION_NOT_EXACT' THEN 'BLOCKED_RECONCILIATION'
                  WHEN 'ACCOUNT_NOT_ACTIVE' THEN 'BLOCKED_BROKER_DISABLED'
                  WHEN 'UNKNOWN_ORDER' THEN 'BLOCKED_UNRESOLVED_MUTATION'
                  WHEN 'UNRESOLVED_ORDER' THEN 'BLOCKED_UNRESOLVED_MUTATION'
                  WHEN 'BELOW_MINIMUM_BUY_NOTIONAL' THEN 'BLOCKED_RISK'
                  WHEN 'INSUFFICIENT_BUYING_POWER' THEN 'BLOCKED_RISK'
                  WHEN 'NON_POSITIVE_EQUITY' THEN 'BLOCKED_RISK'
                  WHEN 'SHORT_POSITION_NOT_ALLOWED' THEN 'BLOCKED_RISK'
                  ELSE NULL
                END
              )
              OR (
                decision.document ->> 'schemaVersion' = 'bayn.paper-cycle-decision.v1'
                AND decision.document ->> 'mode' = 'PAPER'
                AND decision.document #>> '{targetPlan,status}' = 'PLANNED'
                AND decision.document #>> '{bindings,cycleId}' = NEW.cycle_id
                AND decision.document #>> '{bindings,qualificationRunId}' = NEW.qualification_run_id
                AND decision.document #>> '{bindings,accountId}' = NEW.account_id
                AND (decision.document ->> 'submissionCutoffAt')::timestamptz = NEW.submission_cutoff_at
                AND (decision.document ->> 'expiresAt')::timestamptz = NEW.submission_cutoff_at
                AND (
                  (
                    NEW.terminal_reason = 'BLOCKED_PROVENANCE_MISMATCH'
                    AND paper_cycle_generation_is_superseded(
                      NEW.cycle_id,
                      NEW.decision_hash
                    )
                  )
                  OR (
                    decision.document -> 'dispatchable' = 'false'::jsonb
                    AND NEW.terminal_reason = 'BLOCKED_RISK'
                    AND NEW.updated_at >= (decision.document ->> 'createdAt')::timestamptz
                    AND jsonb_typeof(decision.document -> 'riskBlock') = 'object'
                    AND jsonb_array_length(paper.ordered_intent_ids) > 0
                    AND jsonb_array_length(paper.ordered_intent_ids) = jsonb_array_length(paper.delta_risk)
                    AND decision.document #>> '{riskBlock,intentId}' =
                      paper.ordered_intent_ids ->> (jsonb_array_length(paper.ordered_intent_ids) - 1)
                    AND decision.document #>> '{riskBlock,decisionId}' =
                      paper.delta_risk #>> ARRAY[
                        (jsonb_array_length(paper.delta_risk) - 1)::text,
                        'evaluation',
                        'decision',
                        'decisionId'
                      ]
                    AND decision.document #> '{riskBlock,reasonCodes}' =
                      paper.delta_risk #> ARRAY[
                        (jsonb_array_length(paper.delta_risk) - 1)::text,
                        'evaluation',
                        'decision',
                        'reasonCodes'
                      ]
                    AND paper.delta_risk #>> ARRAY[
                      (jsonb_array_length(paper.delta_risk) - 1)::text,
                      'evaluation',
                      'decision',
                      'outcome'
                    ] = 'BLOCKED'
                    AND jsonb_array_length(paper.risk_block_reason_codes) > 0
                    AND NOT (paper.risk_block_reason_codes ? 'AUTHORITY_NOT_PAPER')
                    AND NOT EXISTS (
                      SELECT 1
                      FROM jsonb_array_elements_text(paper.ordered_intent_ids) WITH ORDINALITY
                        AS blocked(intent_id, intent_ordinal)
                      JOIN jsonb_array_elements(paper.delta_risk) WITH ORDINALITY
                        AS risk(entry, risk_ordinal)
                        ON risk.risk_ordinal = blocked.intent_ordinal
                      WHERE risk.entry #>> '{evaluation,input,intentId}' IS DISTINCT FROM blocked.intent_id
                        OR (
                          blocked.intent_ordinal < jsonb_array_length(paper.ordered_intent_ids)
                          AND risk.entry #>> '{evaluation,decision,outcome}' <> 'APPROVED'
                        )
                        OR (
                          blocked.intent_ordinal = jsonb_array_length(paper.ordered_intent_ids)
                          AND risk.entry #>> '{evaluation,decision,outcome}' <> 'BLOCKED'
                        )
                    )
                    AND NOT EXISTS (
                      SELECT 1
                      FROM jsonb_array_elements_text(paper.ordered_intent_ids) AS blocked(intent_id)
                      WHERE EXISTS (SELECT 1 FROM intents WHERE intent_id = blocked.intent_id)
                        OR EXISTS (SELECT 1 FROM mutation_events WHERE intent_id = blocked.intent_id)
                        OR EXISTS (SELECT 1 FROM orders WHERE intent_id = blocked.intent_id)
                    )
                  )
                  OR (
                    decision.document -> 'dispatchable' = 'true'::jsonb
                    AND jsonb_array_length(paper.ordered_intent_ids) > 0
                    AND jsonb_array_length(paper.ordered_intent_ids) = jsonb_array_length(paper.delta_risk)
                    AND (
                      (
                        NOT EXISTS (
                          SELECT 1
                          FROM jsonb_array_elements_text(paper.ordered_intent_ids) AS planned(intent_id)
                          WHERE EXISTS (
                            SELECT 1
                            FROM mutation_events AS event
                            WHERE event.intent_id = planned.intent_id
                          )
                            AND NOT EXISTS (
                              SELECT 1
                              FROM intents AS intent
                              WHERE intent.intent_id = planned.intent_id
                                AND intent.state = 'TERMINAL'
                                AND intent.terminal_outcome = 'FILLED'
                            )
                        )
                        AND EXISTS (
                          SELECT 1
                          FROM jsonb_array_elements_text(paper.ordered_intent_ids) WITH ORDINALITY
                            AS planned(intent_id, intent_ordinal)
                          JOIN jsonb_array_elements(paper.delta_risk) WITH ORDINALITY
                            AS risk(entry, risk_ordinal)
                            ON risk.risk_ordinal = planned.intent_ordinal
                          WHERE risk.entry #>> '{evaluation,decision,outcome}' = 'APPROVED'
                            AND risk.entry #>> '{evaluation,input,intentId}' = planned.intent_id
                            AND NOT EXISTS (
                              SELECT 1
                              FROM intents AS candidate
                              WHERE candidate.intent_id = planned.intent_id
                                AND (
                                  candidate.state <> 'APPROVED'
                                  OR candidate.terminal_outcome IS NOT NULL
                                )
                            )
                            AND NOT EXISTS (
                              SELECT 1
                              FROM mutation_events AS event
                              WHERE event.intent_id = planned.intent_id
                            )
                            AND NOT EXISTS (
                              SELECT 1
                              FROM orders AS broker_order
                              WHERE broker_order.intent_id = planned.intent_id
                            )
                            AND NOT EXISTS (
                              SELECT 1
                              FROM jsonb_array_elements_text(paper.ordered_intent_ids) WITH ORDINALITY
                                AS predecessor(intent_id, intent_ordinal)
                              WHERE predecessor.intent_ordinal < planned.intent_ordinal
                                AND NOT EXISTS (
                                  SELECT 1
                                  FROM intents AS settled
                                  WHERE settled.intent_id = predecessor.intent_id
                                    AND settled.state = 'TERMINAL'
                                    AND settled.terminal_outcome = 'FILLED'
                                )
                            )
                            AND (
                              (
                                NEW.terminal_reason = 'BLOCKED_MISSED_SUBMISSION_DEADLINE'
                                AND NEW.updated_at >= NEW.submission_cutoff_at
                              )
                              OR (
                                NEW.terminal_reason = 'BLOCKED_RISK'
                                AND NEW.updated_at < NEW.submission_cutoff_at
                                AND (risk.entry #>> '{evaluation,decision,expiresAt}')::timestamptz <= NEW.updated_at
                              )
                            )
                        )
                      )
                      OR (
                        NEW.terminal_reason = 'BLOCKED_RISK'
                        AND EXISTS (
                          SELECT 1
                          FROM jsonb_array_elements_text(paper.ordered_intent_ids) WITH ORDINALITY
                            AS failed(intent_id, intent_ordinal)
                          JOIN jsonb_array_elements(paper.delta_risk) WITH ORDINALITY
                            AS risk(entry, risk_ordinal)
                            ON risk.risk_ordinal = failed.intent_ordinal
                          JOIN intents AS failed_intent
                            ON failed_intent.intent_id = failed.intent_id
                          WHERE risk.entry #>> '{evaluation,decision,outcome}' = 'APPROVED'
                            AND risk.entry #>> '{evaluation,input,intentId}' = failed.intent_id
                            AND risk.entry #>> '{evaluation,decision,decisionId}' = failed_intent.risk_decision_id
                            AND failed_intent.account_id = NEW.account_id
                            AND failed_intent.cycle_id = NEW.cycle_id
                            AND failed_intent.decision_hash = decision.document #>> '{bindings,strategyDecisionHash}'
                            AND failed_intent.strategy_name = decision.document #>> '{bindings,strategyName}'
                            AND failed_intent.policy_hash = decision.document #>> '{bindings,policyHash}'
                            AND failed_intent.authority_generation_hash =
                              decision.document #>> '{bindings,authorityGenerationHash}'
                            AND failed_intent.state = 'TERMINAL'
                            AND failed_intent.terminal_outcome IN ('CANCELED', 'EXPIRED', 'REJECTED', 'BLOCKED')
                            AND failed_intent.updated_at <= NEW.updated_at
                            AND EXISTS (
                              SELECT 1
                              FROM LATERAL (
                                SELECT event.operation, event.event_type
                                FROM mutation_events AS event
                                WHERE event.intent_id = failed.intent_id
                                  AND event.occurred_at <= NEW.updated_at
                                ORDER BY
                                  CASE event.operation WHEN 'CANCEL' THEN 1 ELSE 0 END DESC,
                                  event.sequence DESC
                                LIMIT 1
                              ) AS terminal_event
                              WHERE (
                                terminal_event.operation = 'SUBMIT'
                                AND terminal_event.event_type IN (
                                  'SUBMIT_ACCEPTED',
                                  'SUBMIT_REJECTED',
                                  'SUBMIT_DENIED',
                                  'RECOVERY_FOUND'
                                )
                              ) OR (
                                terminal_event.operation = 'CANCEL'
                                AND terminal_event.event_type = 'RECOVERY_FOUND'
                              )
                            )
                            AND NOT EXISTS (
                              SELECT 1
                              FROM jsonb_array_elements_text(paper.ordered_intent_ids) WITH ORDINALITY
                                AS predecessor(intent_id, intent_ordinal)
                              WHERE predecessor.intent_ordinal < failed.intent_ordinal
                                AND NOT EXISTS (
                                  SELECT 1
                                  FROM intents AS settled
                                  WHERE settled.intent_id = predecessor.intent_id
                                    AND settled.account_id = NEW.account_id
                                    AND settled.cycle_id = NEW.cycle_id
                                    AND settled.decision_hash = decision.document #>> '{bindings,strategyDecisionHash}'
                                    AND settled.state = 'TERMINAL'
                                    AND settled.terminal_outcome = 'FILLED'
                                )
                            )
                            AND NOT EXISTS (
                              SELECT 1
                              FROM jsonb_array_elements_text(paper.ordered_intent_ids) AS other(intent_id)
                              WHERE other.intent_id <> failed.intent_id
                                AND EXISTS (
                                  SELECT 1
                                  FROM mutation_events AS other_event
                                  WHERE other_event.intent_id = other.intent_id
                                )
                                AND NOT EXISTS (
                                  SELECT 1
                                  FROM intents AS settled
                                  WHERE settled.intent_id = other.intent_id
                                    AND settled.state = 'TERMINAL'
                                    AND settled.terminal_outcome = 'FILLED'
                                )
                            )
                        )
                      )
                    )
                  )
                )
              )
            )
        ) THEN
          RAISE EXCEPTION 'autonomous cycle blocked reason does not match its blocked, expired, or terminal-failed PAPER decision'
            USING ERRCODE = '23514';
        END IF;
      END IF;
      IF (
        NEW.state = 'BLOCKED'
        AND NEW.terminal_reason = 'BLOCKED_MISSED_PUBLICATION_DEADLINE'
        AND (
          OLD.state <> 'PENDING'
          OR OLD.snapshot_id IS NOT NULL
          OR NEW.updated_at < NEW.publication_deadline_at
        )
      ) THEN
        RAISE EXCEPTION 'invalid missed-publication transition' USING ERRCODE = '23514';
      END IF;
      IF (
        NEW.state = 'BLOCKED'
        AND NEW.terminal_reason = 'BLOCKED_MISSED_SUBMISSION_DEADLINE'
        AND NEW.updated_at < NEW.submission_cutoff_at
      ) THEN
        RAISE EXCEPTION 'invalid missed-submission transition' USING ERRCODE = '23514';
      END IF;

      RETURN NEW;
    END
    $function$
  `
})
