import { Effect } from 'effect'
import { SqlClient } from 'effect/sql'

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  // Cohort each order by its first retained broker update, not once per status observation.
  yield* sql`CREATE OR REPLACE VIEW public.execution_order_churn_daily AS
    WITH latest_orders AS (
      SELECT DISTINCT ON (o.account_id, o.broker_order_id)
        o.account_id, o.broker_order_id, o.parent_broker_order_id, o.intent_id, o.symbol,
        o.status, o.filled_quantity_atoms,
        (min(e.occurred_at) OVER (PARTITION BY o.account_id, o.broker_order_id)
          AT TIME ZONE 'America/New_York')::date AS session_date
      FROM public.orders AS o
      JOIN public.broker_events AS e USING (event_id)
      ORDER BY o.account_id, o.broker_order_id, o.broker_updated_at COLLATE "C" DESC, e.source_sequence DESC
    ), counts AS (
      SELECT o.account_id, o.session_date, o.symbol, i.strategy_name, g.strategy_parameter_schema_version,
        count(*) AS order_count,
        count(*) FILTER (WHERE o.status = 'NEW') AS new_orders,
        count(*) FILTER (WHERE o.status = 'PENDING') AS pending_orders,
        count(*) FILTER (WHERE o.status = 'PARTIALLY_FILLED') AS partially_filled_orders,
        count(*) FILTER (WHERE o.status = 'FILLED') AS filled_orders,
        count(*) FILTER (WHERE o.status = 'CANCELED') AS canceled_orders,
        count(*) FILTER (WHERE o.status = 'EXPIRED') AS expired_orders,
        count(*) FILTER (WHERE o.status = 'REJECTED') AS rejected_orders,
        count(*) FILTER (WHERE o.filled_quantity_atoms > 0 AND o.status <> 'FILLED') AS partially_executed_orders,
        count(i.intent_id) AS intent_order_count,
        count(DISTINCT i.intent_id) FILTER (WHERE o.filled_quantity_atoms > 0) AS filled_intents
      FROM latest_orders AS o
      LEFT JOIN latest_orders AS parent ON parent.account_id = o.account_id
        AND parent.broker_order_id = o.parent_broker_order_id AND parent.symbol = o.symbol
      LEFT JOIN public.intents AS i ON i.account_id = o.account_id AND i.symbol = o.symbol
        AND i.intent_id = coalesce(o.intent_id, parent.intent_id)
      LEFT JOIN public.authority_generations AS g ON g.generation_hash = i.authority_generation_hash
        AND g.account_id = i.account_id
      GROUP BY o.account_id, o.session_date, o.symbol, i.strategy_name, g.strategy_parameter_schema_version
    )
    SELECT account_id, session_date, symbol, strategy_name, strategy_parameter_schema_version,
      order_count, new_orders, pending_orders, partially_filled_orders, filled_orders, canceled_orders,
      expired_orders, rejected_orders, partially_executed_orders, intent_order_count, filled_intents,
      canceled_orders::numeric / nullif(filled_orders + canceled_orders, 0) AS cancel_ratio,
      partially_executed_orders::numeric / nullif(order_count, 0) AS partial_fill_rate,
      intent_order_count::numeric / nullif(filled_intents, 0) AS orders_per_filled_intent
    FROM counts`

  // Use the first retained matching broker limit, like the live audit. The admitted decision reference is
  // a separate benchmark, not a submit-time quote or the parent order's reference for a protective child.
  // Price and quantity both use nine decimal places, so their product scales by 10^-12 to USD micros.
  yield* sql`CREATE OR REPLACE VIEW public.execution_fill_slippage_daily AS
    WITH benchmarks AS (
      SELECT f.account_id, (e.occurred_at AT TIME ZONE 'America/New_York')::date AS session_date, f.symbol, f.side,
        i.strategy_name, g.strategy_parameter_schema_version, f.quantity_atoms, f.price_atoms, f.fee_micros,
        f.quantity_atoms * f.price_atoms * 0.000000000001 AS notional_micros,
        CASE WHEN f.side = 'BUY' THEN 1 ELSE -1 END AS side_sign,
        o.limit_price_micros * 1000 AS limit_atoms, reference.price_micros * 1000 AS reference_atoms
      FROM public.fills AS f
      JOIN public.broker_events AS e USING (event_id)
      LEFT JOIN LATERAL (
        SELECT o.intent_id, o.parent_broker_order_id,
          first_value(o.limit_price_micros) OVER (
            ORDER BY o.broker_updated_at COLLATE "C", version.source_sequence
          ) AS limit_price_micros
        FROM public.orders AS o
        JOIN public.broker_events AS version USING (event_id)
        WHERE o.account_id = f.account_id AND o.broker_order_id = f.broker_order_id
          AND o.client_order_id = f.client_order_id AND o.symbol = f.symbol AND o.side = f.side
        ORDER BY o.broker_updated_at COLLATE "C" DESC, version.source_sequence DESC
        LIMIT 1
      ) AS o ON true
      LEFT JOIN LATERAL (
        SELECT parent.intent_id FROM public.orders AS parent
        JOIN public.broker_events AS version USING (event_id)
        WHERE f.intent_id IS NULL AND o.intent_id IS NULL AND parent.account_id = f.account_id
          AND parent.broker_order_id = o.parent_broker_order_id AND parent.symbol = f.symbol
        ORDER BY parent.broker_updated_at COLLATE "C" DESC, version.source_sequence DESC
        LIMIT 1
      ) AS parent ON true
      LEFT JOIN public.intents AS i ON i.account_id = f.account_id AND i.symbol = f.symbol
        AND i.intent_id = coalesce(f.intent_id, o.intent_id, parent.intent_id)
      LEFT JOIN public.authority_generations AS g ON g.generation_hash = i.authority_generation_hash
        AND g.account_id = i.account_id
      LEFT JOIN LATERAL (
        SELECT CASE WHEN min(target->>'referencePriceMicros') = max(target->>'referencePriceMicros')
          THEN min(target->>'referencePriceMicros')::numeric END AS price_micros
        FROM public.mutation_events AS m
        JOIN public.execution_decision_admissions AS a USING (event_id)
        CROSS JOIN LATERAL (
          SELECT d.document FROM public.autonomous_cycle_shadow_decisions AS d
          WHERE d.cycle_id = i.cycle_id AND d.decision_hash = a.decision_id
          UNION ALL
          SELECT c.document->'document' FROM public.autonomous_cycle_paper_closures AS c
          WHERE c.cycle_id = i.cycle_id AND c.close_decision_hash = a.decision_id
          UNION ALL
          SELECT r.document->'document' FROM public.autonomous_cycle_paper_close_replans AS r
          WHERE r.cycle_id = i.cycle_id AND r.close_decision_hash = a.decision_id
        ) AS decision
        CROSS JOIN LATERAL jsonb_array_elements(
          CASE WHEN jsonb_typeof(decision.document #> '{targetPlan,targets}') = 'array'
            THEN decision.document #> '{targetPlan,targets}' ELSE '[]'::jsonb END
        ) AS targets(target)
        WHERE m.intent_id = i.intent_id AND m.event_type = 'SUBMIT_STARTED' AND m.occurred_at <= e.occurred_at
          AND o.parent_broker_order_id IS NULL AND i.client_order_id = f.client_order_id AND i.side = f.side
          AND decision.document->'orderedIntentIds' ? i.intent_id
          AND target->>'symbol' = f.symbol AND target->>'referencePriceMicros' ~ '^[1-9][0-9]{0,38}$'
      ) AS reference ON true
    )
    SELECT account_id, session_date, symbol, side, strategy_name, strategy_parameter_schema_version,
      count(*) AS fill_count, sum(notional_micros) AS total_notional_micros, sum(fee_micros) AS total_fill_fee_micros,
      count(limit_atoms) AS limit_benchmark_fill_count,
      10000 * sum(side_sign * (limit_atoms - price_atoms) * quantity_atoms)
        / nullif(sum(limit_atoms * quantity_atoms), 0) AS limit_price_improvement_bps,
      count(reference_atoms) AS reference_benchmark_fill_count,
      10000 * sum(side_sign * (price_atoms - reference_atoms) * quantity_atoms)
        / nullif(sum(reference_atoms * quantity_atoms), 0) AS reference_slippage_bps,
      10000 * sum(fee_micros) / nullif(sum(notional_micros), 0) AS fill_fee_bps
    FROM benchmarks
    GROUP BY account_id, session_date, symbol, side, strategy_name, strategy_parameter_schema_version`

  // CNPG owns the login; disposable databases intentionally do not have it.
  yield* sql`DO $migration$
    BEGIN
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'bayn_audit_ro') THEN
        GRANT USAGE ON SCHEMA public TO bayn_audit_ro;
        GRANT SELECT ON TABLE public.execution_order_churn_daily, public.execution_fill_slippage_daily TO bayn_audit_ro;
      END IF;
    END $migration$`
})
