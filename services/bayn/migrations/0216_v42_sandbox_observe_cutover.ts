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
  // Restrict only the reviewed v42 sandbox grant. Native recovery creates its clear OBSERVE
  // successor after a fresh exact reconciliation.
  yield* sql`DO $cutover$
    DECLARE target_generation_hash text;
    BEGIN
      SELECT state.generation_hash INTO target_generation_hash
      FROM authority_state state JOIN authority_generations generation USING (generation_hash)
      WHERE generation.generation_hash='66d0718b5500dfc3424087d8d3500c693779169281f7630eed666391ccbbb4f0'
        AND generation.broker_environment='sandbox'
        AND generation.activation_schema_version='bayn.paper-authority-generation.v3'
        AND generation.strategy_name='jev'
        AND generation.strategy_parameter_schema_version='bayn.jev.protocol.v42'
        AND generation.strategy_behavior_hash='76f0e134e622ada19cb1b087d83da60b54a36d33c86c6c0eee2642ee3fbd3e67'
        AND generation.strategy_parameter_hash='c78a10a127b6d4fbfd2fa3d2a433744f02295aa9a2b47b20bacfbd9804ba8ed5'
        AND generation.strategy_protocol_hash='825c8806ba7d16783fcb96fc0d12f49b1e35f03ee81d82f6990bc7b11174d339'
        AND state.maximum='PAPER' AND state.effective='PAPER' AND state.kill_state='CLEAR'
        AND state.reason IS NULL;
      -- A no-op migration must not prevent an OBSERVE worker from starting to refresh its own evidence.
      IF target_generation_hash IS NULL THEN RETURN; END IF;
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
      OR EXISTS (SELECT 1 FROM accounting_transactions t LEFT JOIN accounting_receipts r USING (broker_event_id) WHERE r.receipt_id IS NULL)
      OR EXISTS (SELECT 1 FROM fills f LEFT JOIN accounting_transactions t ON t.broker_event_id = f.event_id WHERE t.transaction_id IS NULL)
      OR EXISTS (
        SELECT 1 FROM (
          SELECT DISTINCT ON (o.account_id, o.broker_order_id) o.status
          FROM orders o JOIN broker_events e USING (event_id)
          ORDER BY o.account_id, o.broker_order_id, o.broker_updated_at COLLATE "C" DESC,
            e.source_sequence DESC, e.event_id COLLATE "C" DESC
        ) latest WHERE status IN ('NEW', 'PENDING', 'PARTIALLY_FILLED', 'HELD')
      )
      OR EXISTS (
        SELECT 1 FROM authority_state a JOIN authority_generations g USING (generation_hash)
        LEFT JOIN LATERAL (
          SELECT status, expected_hash, observed_hash, discrepancies, reconciled_at,
            account_event_id, position_snapshot_id
          FROM reconciliations r WHERE r.account_id = g.account_id
          ORDER BY reconciled_at DESC, reconciliation_id COLLATE "C" DESC LIMIT 1
        ) latest ON true
        LEFT JOIN LATERAL (
          SELECT snapshot_id, position_count, observed_at, ingestion_order_trusted
          FROM position_snapshots p WHERE p.account_id = g.account_id
          ORDER BY ingestion_sequence DESC LIMIT 1
        ) position ON true
        WHERE latest.status IS DISTINCT FROM 'EXACT'
          OR latest.expected_hash IS DISTINCT FROM latest.observed_hash
          OR jsonb_array_length(latest.discrepancies) <> 0
          OR latest.account_event_id IS NULL
          OR latest.position_snapshot_id IS NULL
          OR position.snapshot_id IS DISTINCT FROM latest.position_snapshot_id
          OR position.ingestion_order_trusted IS DISTINCT FROM true
          OR position.position_count IS DISTINCT FROM 0
          OR position.observed_at > latest.reconciled_at
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
      RAISE EXCEPTION 'v42 sandbox OBSERVE cutover requires terminal cycles, flat positions, settled orders, fresh exact reconciliation, complete accounting and no unexpired inference claims'
        USING ERRCODE = '55000';
    END IF;
    UPDATE authority_state state
    SET effective='OBSERVE', kill_state='ACTIVE', reason='BLOCKED_STRATEGY_PROTOCOL_CUTOVER',
      version=state.version+1,
      updated_at=greatest(clock_timestamp(), state.updated_at + interval '1 millisecond')
    WHERE state.generation_hash=target_generation_hash;
  END $cutover$`
})
