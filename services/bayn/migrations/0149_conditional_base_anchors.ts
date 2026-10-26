import { Effect } from 'effect'
import { SqlClient } from 'effect/sql'

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  yield* sql`SELECT pg_advisory_xact_lock(1111578958, 1)`
  yield* sql`LOCK TABLE intents, mutation_events, autonomous_cycles, authority_state,
    broker_events, fills, orders, position_snapshots, accounting_transactions,
    accounting_receipts, broker_inventory_debits, reconciliations,
    jev_evaluation_requests, jev_evaluation_receipts, jev_inference_handoffs,
    jev_evaluation_resolutions IN ACCESS EXCLUSIVE MODE`
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
        WHERE a.maximum = 'PAPER' AND (
          latest.status IS DISTINCT FROM 'EXACT'
          OR latest.reconciled_at IS NULL
          OR latest.reconciled_at > clock_timestamp()
          OR latest.reconciled_at < clock_timestamp() - interval '60 seconds'
          OR latest.reconciled_at < (SELECT max(occurred_at) FROM mutation_events m JOIN intents i USING (intent_id) WHERE i.account_id = g.account_id)
        )
      )
      OR EXISTS (
        WITH unresolved AS MATERIALIZED (
          SELECT request.payload FROM jev_evaluation_requests request
          LEFT JOIN jev_evaluation_resolutions resolution USING (request_id)
          WHERE resolution.request_id IS NULL
        )
        SELECT 1 FROM unresolved WHERE (payload->>'expiresAt')::timestamptz > clock_timestamp()
      )
    THEN RAISE EXCEPTION 'conditional-base-anchor cutover requires terminal cycles, flat positions, settled orders, fresh exact reconciliation, complete accounting and no unexpired inference claims' USING ERRCODE = '55000'; END IF;
  END $cutover$`
  yield* sql`UPDATE authority_state SET effective='OBSERVE', kill_state='ACTIVE',
    reason='BLOCKED_STRATEGY_PROTOCOL_CUTOVER', version=version+1,
    updated_at=greatest(clock_timestamp(), updated_at + interval '1 millisecond')
    WHERE maximum='PAPER' AND (
      (effective='PAPER' AND kill_state='CLEAR') OR reason='BLOCKED_STRATEGY_PROTOCOL_CUTOVER'
    )`
  yield* sql`ALTER TABLE jev_evaluation_requests DROP CONSTRAINT jev_evaluation_requests_check,
    ADD CONSTRAINT jev_evaluation_requests_check CHECK (
      jsonb_typeof(payload) = 'object'
      AND payload->>'schemaVersion' IS NOT DISTINCT FROM 'bayn.jev-evaluation-request.v2'
      AND payload->>'requestId' IS NOT DISTINCT FROM request_id
      AND payload->>'cycleId' IS NOT DISTINCT FROM cycle_id
      AND payload->>'authorityGenerationHash' IS NOT DISTINCT FROM authority_generation_hash
      AND payload #>> '{request,schemaVersion}' IS NOT DISTINCT FROM 'bayn.entry-inference-input.v3'
      AND payload #>> '{request,protocol,schemaVersion}' IS NOT DISTINCT FROM 'bayn.jev.protocol.v24'
    ) NOT VALID`
  yield* sql`ALTER TABLE jev_inference_handoffs DROP CONSTRAINT jev_inference_handoffs_check,
    ADD CONSTRAINT jev_inference_handoffs_check CHECK (
      jsonb_typeof(payload) = 'object'
      AND (payload->>'schemaVersion' IN ('bayn.entry-handoff.v1', 'bayn.entry-handoff.v2')) IS TRUE
      AND payload->>'requestId' IS NOT DISTINCT FROM request_id
      AND payload->>'handoffHash' IS NOT DISTINCT FROM handoff_hash
      AND (
        payload #>> '{disposition,status}' IN ('SOURCE_INFEASIBLE', 'VISUAL_FAILED', 'PREPARATION_FAILED')
        OR (payload #>> '{disposition,status}' IN ('NO_FUNDED_PROPOSALS', 'READY')
          AND payload #>> '{disposition,assessments,schemaVersion}' = CASE payload->>'schemaVersion'
            WHEN 'bayn.entry-handoff.v1' THEN 'bayn.chart-assessments.v1' ELSE 'bayn.chart-assessments.v2' END)
      ) IS TRUE
    ) NOT VALID`
  yield* sql`ALTER TABLE jev_evaluation_receipts DROP CONSTRAINT jev_evaluation_receipts_check,
    ADD CONSTRAINT jev_evaluation_receipts_check CHECK (
      jsonb_typeof(payload) = 'object'
      AND payload->>'schemaVersion' IS NOT DISTINCT FROM 'bayn.jev-evaluation-receipt.v2'
      AND payload->>'requestId' IS NOT DISTINCT FROM request_id
      AND payload->>'receiptHash' IS NOT DISTINCT FROM receipt_hash
      AND (
        payload #>> '{outcome,status}' = 'FAILED'
        OR (payload #>> '{outcome,status}' = 'COMPLETED'
          AND payload #>> '{outcome,completion,handoff,schemaVersion}' IN ('bayn.entry-handoff.v1', 'bayn.entry-handoff.v2'))
      ) IS TRUE
    ) NOT VALID`
  yield* sql`CREATE OR REPLACE FUNCTION enforce_entry_inference_handoff() RETURNS trigger LANGUAGE plpgsql AS $function$
    DECLARE source jsonb;
    BEGIN
      SELECT payload INTO source FROM jev_evaluation_requests WHERE request_id = NEW.request_id FOR UPDATE;
      IF source->>'schemaVersion' IS DISTINCT FROM 'bayn.jev-evaluation-request.v2'
        OR NOT COALESCE(
          (source #>> '{request,schemaVersion}' = 'bayn.entry-inference-input.v3'
            AND NEW.payload->>'schemaVersion' = 'bayn.entry-handoff.v2')
          OR (source #>> '{request,schemaVersion}' IN ('bayn.entry-inference-input.v1', 'bayn.entry-inference-input.v2')
            AND NEW.payload->>'schemaVersion' = 'bayn.entry-handoff.v1'
            AND (source->>'expiresAt')::timestamptz <= clock_timestamp()), false)
        OR source->>'requestHash' IS DISTINCT FROM NEW.payload->>'inputHash'
        OR (NEW.payload->>'recordedAt')::timestamptz < (source->>'observedAt')::timestamptz
        OR NEW.payload->>'recordedAt' IS NULL
      THEN RAISE EXCEPTION 'entry inference handoff differs from its current original source' USING ERRCODE = '23514'; END IF;
      RETURN NEW;
    END $function$`
})
