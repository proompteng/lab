import { Effect } from 'effect'
import { SqlClient } from 'effect/unstable/sql'

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient

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
              OR (
                intent.terminal_outcome IS DISTINCT FROM 'FILLED'
                AND NOT (
                  intent.terminal_outcome = 'CANCELED'
                  AND intent.order_type = 'LIMIT'
                  AND intent.time_in_force = 'IOC'
                  AND EXISTS (
                    SELECT 1
                    FROM LATERAL (
                      SELECT event.broker_order_id, event.event_type
                      FROM mutation_events AS event
                      WHERE event.intent_id = intent.intent_id
                        AND event.operation = 'SUBMIT'
                      ORDER BY event.sequence DESC
                      LIMIT 1
                    ) AS accepted
                    JOIN LATERAL (
                      SELECT
                        broker_order.account_id,
                        broker_order.broker_order_id,
                        broker_order.client_order_id,
                        broker_order.intent_id,
                        broker_order.symbol,
                        broker_order.side,
                        broker_order.order_type,
                        broker_order.time_in_force,
                        broker_order.quantity_micros,
                        broker_order.filled_quantity_micros,
                        broker_order.status
                      FROM orders AS broker_order
                      JOIN broker_events AS event ON event.event_id = broker_order.event_id
                      WHERE broker_order.account_id = intent.account_id
                        AND broker_order.broker_order_id = accepted.broker_order_id
                      ORDER BY event.source_sequence DESC
                      LIMIT 1
                    ) AS latest_order ON true
                    WHERE accepted.broker_order_id IS NOT NULL
                      AND accepted.event_type IN ('SUBMIT_ACCEPTED', 'RECOVERY_FOUND')
                      AND latest_order.account_id = intent.account_id
                      AND latest_order.client_order_id = intent.client_order_id
                      AND latest_order.intent_id = intent.intent_id
                      AND latest_order.symbol = intent.symbol
                      AND latest_order.side = intent.side
                      AND latest_order.order_type = intent.order_type
                      AND latest_order.time_in_force = intent.time_in_force
                      AND latest_order.quantity_micros = intent.quantity_micros
                      AND latest_order.status = 'CANCELED'
                      AND latest_order.filled_quantity_micros = 0
                      AND NOT EXISTS (
                        SELECT 1
                        FROM orders AS observed_order
                        WHERE observed_order.account_id = intent.account_id
                          AND observed_order.broker_order_id = accepted.broker_order_id
                          AND observed_order.filled_quantity_micros > 0
                      )
                      AND NOT EXISTS (
                        SELECT 1
                        FROM fills AS observed_fill
                        WHERE observed_fill.account_id = intent.account_id
                          AND observed_fill.broker_order_id = accepted.broker_order_id
                      )
                  )
                )
              )
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
                ),
                COALESCE(
                  (
                    SELECT max(event.observed_at)
                    FROM orders AS broker_order
                    JOIN broker_events AS event ON event.event_id = broker_order.event_id
                    WHERE paper.ordered_intent_ids ? broker_order.intent_id
                  ),
                  (decision.document ->> 'createdAt')::timestamptz
                )
              )
              AND reconciliation.reconciled_at <= completion_observed_at
          )
      )
    $function$
  `
})
