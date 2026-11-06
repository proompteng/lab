import { Effect } from 'effect'
import { SqlClient } from 'effect/sql'

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  yield* sql`SELECT pg_advisory_xact_lock(1111578958, 1)`
  yield* sql`LOCK TABLE intents, mutation_events, autonomous_cycles, authority_state, authority_generations,
    broker_events, fills, orders, position_snapshots, accounting_transactions,
    accounting_receipts, broker_inventory_debits, reconciliations,
    jev_evaluation_requests, jev_evaluation_receipts, jev_inference_handoffs,
    jev_evaluation_resolutions, jev_chart_dispatch_claims, jev_chart_terminal_receipts,
    inference_expense_quotes, jev_staged_dispatch_claims, jev_staged_terminal_receipts,
    jev_staged_skip_receipts IN ACCESS EXCLUSIVE MODE`
  // Removing a mandate cannot change durable authority. Prove settlement before restricting the
  // exact reviewed v38 identity; native recovery owns the subsequent clear OBSERVE generation.
  yield* sql`DO $cutover$ BEGIN
    IF EXISTS (SELECT 1 FROM intents WHERE state <> 'TERMINAL')
      OR EXISTS (SELECT 1 FROM autonomous_cycles WHERE state IN ('PENDING', 'ACTIVE'))
      OR EXISTS (
        SELECT 1 FROM (
          SELECT account_id, symbol, quantity_delta_atoms AS quantity, cost_basis_delta_micros AS cost
            FROM accounting_transactions
          UNION ALL SELECT account_id, symbol, -quantity_atoms, -cost_basis_micros
            FROM broker_inventory_debits WHERE posted
        ) inventory GROUP BY account_id, symbol HAVING sum(quantity) <> 0 OR sum(cost) <> 0
      )
      OR EXISTS (
        SELECT 1 FROM (SELECT DISTINCT account_id FROM position_snapshots) accounts
        CROSS JOIN LATERAL (
          SELECT position_count FROM position_snapshots p WHERE p.account_id = accounts.account_id
          ORDER BY observed_at DESC, snapshot_id DESC LIMIT 1
        ) latest WHERE position_count <> 0
      )
      OR EXISTS (SELECT 1 FROM accounting_transactions t LEFT JOIN accounting_receipts r USING (broker_event_id) WHERE r.receipt_id IS NULL)
      OR EXISTS (SELECT 1 FROM fills f LEFT JOIN accounting_transactions t ON t.broker_event_id = f.event_id WHERE t.transaction_id IS NULL)
      OR EXISTS (
        SELECT 1 FROM (
          SELECT DISTINCT ON (o.account_id, o.broker_order_id) o.status
          FROM orders o JOIN broker_events e USING (event_id)
          ORDER BY o.account_id, o.broker_order_id, e.source_sequence DESC
        ) latest WHERE status IN ('NEW', 'PENDING', 'PARTIALLY_FILLED', 'HELD')
      )
      OR EXISTS (
        SELECT 1 FROM authority_state a JOIN authority_generations g USING (generation_hash)
        LEFT JOIN LATERAL (
          SELECT status, reconciled_at FROM reconciliations r WHERE r.account_id = g.account_id
          ORDER BY reconciled_at DESC, reconciliation_id DESC LIMIT 1
        ) latest ON true
        WHERE latest.status IS DISTINCT FROM 'EXACT'
          OR latest.reconciled_at IS NULL
          OR latest.reconciled_at > clock_timestamp()
          OR latest.reconciled_at < clock_timestamp() - interval '60 seconds'
          OR latest.reconciled_at < (SELECT max(occurred_at) FROM mutation_events m JOIN intents i USING (intent_id) WHERE i.account_id = g.account_id)
      )
      OR EXISTS (
        WITH unresolved AS MATERIALIZED (
          SELECT request.payload FROM jev_evaluation_requests request
          LEFT JOIN jev_evaluation_resolutions resolution USING (request_id)
          WHERE resolution.request_id IS NULL
        )
        SELECT 1 FROM unresolved WHERE (payload->>'expiresAt')::timestamptz > clock_timestamp()
      )
    THEN
      RAISE EXCEPTION 'effective-entry OBSERVE cutover requires terminal cycles, flat positions, settled orders, fresh exact reconciliation, complete accounting and no unexpired inference claims'
        USING ERRCODE = '55000';
    END IF;
  END $cutover$`
  yield* sql`UPDATE authority_state state
    SET effective='OBSERVE', kill_state='ACTIVE', reason='BLOCKED_STRATEGY_PROTOCOL_CUTOVER',
      version=state.version+1,
      updated_at=greatest(clock_timestamp(), state.updated_at + interval '1 millisecond')
    FROM authority_generations generation
    WHERE state.generation_hash=generation.generation_hash
      AND generation.strategy_name='jev'
      AND generation.strategy_parameter_schema_version='bayn.jev.protocol.v38'
      AND generation.strategy_behavior_hash='76f0e134e622ada19cb1b087d83da60b54a36d33c86c6c0eee2642ee3fbd3e67'
      AND generation.strategy_parameter_hash='fa21a9d606eed0332637937d4d46035ba649d3fef968ab39480af796f13f419b'
      AND generation.strategy_protocol_hash='489e704106e73592eb03dd8daf0750cbbb157e4d257bf53b948da1449b0c2d3c'
      AND state.maximum='PAPER' AND state.effective='PAPER' AND state.kill_state='CLEAR'
      AND state.reason IS NULL`
})
