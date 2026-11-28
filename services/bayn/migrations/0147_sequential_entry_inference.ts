import { SqlClient } from 'effect/sql'
import { Effect } from 'effect'

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  yield* sql`SELECT pg_advisory_xact_lock(1111578958, 1)`
  yield* sql`LOCK TABLE intents, mutation_events, autonomous_cycles, authority_state,
    broker_events, account_snapshots, fills, orders, positions, position_snapshots, accounting_transactions,
    accounting_receipts, broker_fee_accounting, broker_fee_accruals, broker_fee_accrual_matches,
    reconciliations, jev_evaluation_requests, jev_evaluation_receipts,
    jev_evaluation_resolutions, jev_batch_plans, jev_batch_results IN ACCESS EXCLUSIVE MODE`
  yield* sql`DO $cutover$ BEGIN
    IF EXISTS (SELECT 1 FROM intents WHERE state <> 'TERMINAL')
      OR EXISTS (
        SELECT 1 FROM (
          SELECT account_id, symbol, quantity_delta_atoms AS quantity, cost_basis_delta_micros AS cost
            FROM accounting_transactions
          UNION ALL SELECT account_id, symbol, -quantity_atoms, -cost_basis_micros
            FROM broker_inventory_debits WHERE posted
        ) inventory GROUP BY account_id, symbol HAVING sum(quantity) <> 0 OR sum(cost) <> 0
      )
      OR EXISTS (
        SELECT 1 FROM (SELECT DISTINCT ON (account_id) position_count FROM position_snapshots ORDER BY account_id, observed_at DESC, snapshot_id DESC) latest WHERE position_count <> 0
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
      OR EXISTS (SELECT 1 FROM autonomous_cycles c WHERE state IN ('PENDING', 'ACTIVE') AND (snapshot_id IS NOT NULL OR decision_hash IS NOT NULL OR EXISTS (SELECT 1 FROM intents i WHERE i.cycle_id = c.cycle_id)))
    OR EXISTS (
      SELECT 1 FROM jev_evaluation_requests request
      LEFT JOIN jev_evaluation_resolutions resolution USING (request_id)
      WHERE resolution.request_id IS NULL AND (request.payload->>'expiresAt')::timestamptz > clock_timestamp()
    )
    THEN RAISE EXCEPTION 'sequential-entry-inference cutover requires terminal mutation cycles, flat positions, settled orders, fresh exact reconciliation complete accounting and no unexpired inference claims' USING ERRCODE = '55000'; END IF;
  END $cutover$`
  yield* sql`WITH cutover AS MATERIALIZED (SELECT clock_timestamp() AS at)
    UPDATE autonomous_cycles SET state = 'BLOCKED', terminal_reason = 'BLOCKED_AUTHORITY',
      state_version = state_version + 1, updated_at = greatest(cutover.at, updated_at), terminal_at = greatest(cutover.at, updated_at)
    FROM cutover WHERE state IN ('PENDING', 'ACTIVE') AND snapshot_id IS NULL AND decision_hash IS NULL`
  yield* sql`UPDATE authority_state SET effective = 'OBSERVE', kill_state = 'ACTIVE',
    reason = 'BLOCKED_STRATEGY_PROTOCOL_CUTOVER', version = version + 1,
    updated_at = greatest(clock_timestamp(), updated_at + interval '1 millisecond') WHERE maximum = 'PAPER'
      AND (effective = 'PAPER' OR reason = 'BLOCKED_STRATEGY_PROTOCOL_CUTOVER')`
  yield* sql`ALTER TABLE authority_generations
    DROP CONSTRAINT authority_generations_strategy_parameter_schema_version_check,
    DROP CONSTRAINT authority_generations_strategy_contract_check,
    ADD CONSTRAINT authority_generations_strategy_parameter_schema_version_check CHECK (
      strategy_parameter_schema_version = 'bayn.jev.protocol.v24'
    ) NOT VALID,
    ADD CONSTRAINT authority_generations_strategy_contract_check CHECK (
      ((maximum = 'OBSERVE' AND strategy_name IS NULL AND strategy_parameter_schema_version IS NULL)
      OR (maximum = 'PAPER' AND strategy_name = 'jev'
        AND strategy_parameter_schema_version = 'bayn.jev.protocol.v24')) IS TRUE
    ) NOT VALID`
  yield* sql`ALTER TABLE jev_evaluation_requests DROP CONSTRAINT jev_evaluation_requests_check,
    ADD CONSTRAINT jev_evaluation_requests_check CHECK (
      jsonb_typeof(payload) = 'object'
      AND payload->>'schemaVersion' IS NOT DISTINCT FROM 'bayn.jev-evaluation-request.v2'
      AND payload->>'requestId' IS NOT DISTINCT FROM request_id
      AND payload->>'cycleId' IS NOT DISTINCT FROM cycle_id
      AND payload->>'authorityGenerationHash' IS NOT DISTINCT FROM authority_generation_hash
      AND payload #>> '{request,schemaVersion}' IS NOT DISTINCT FROM 'bayn.entry-inference-input.v1'
      AND payload #>> '{request,protocol,schemaVersion}' IS NOT DISTINCT FROM 'bayn.jev.protocol.v24'
    ) NOT VALID`
  yield* sql`ALTER TABLE jev_evaluation_receipts DROP CONSTRAINT jev_evaluation_receipts_check,
    ADD CONSTRAINT jev_evaluation_receipts_check CHECK (
      jsonb_typeof(payload) = 'object'
      AND payload->>'schemaVersion' IS NOT DISTINCT FROM 'bayn.jev-evaluation-receipt.v2'
      AND payload->>'requestId' IS NOT DISTINCT FROM request_id
      AND payload->>'receiptHash' IS NOT DISTINCT FROM receipt_hash
    ) NOT VALID`
  yield* sql`ALTER TABLE jev_batch_plans DROP CONSTRAINT jev_batch_plans_check,
    ADD CONSTRAINT jev_batch_plans_check CHECK (
      jsonb_typeof(payload) = 'object'
      AND payload->>'schemaVersion' IS NOT DISTINCT FROM 'bayn.jev-batch-plan.v7'
      AND payload->>'batchId' IS NOT DISTINCT FROM batch_id
      AND payload->>'cycleId' IS NOT DISTINCT FROM cycle_id
      AND payload->>'authorityGenerationHash' IS NOT DISTINCT FROM authority_generation_hash
      AND payload->>'observationHash' IS NOT DISTINCT FROM observation_hash
    ) NOT VALID`
  yield* sql`CREATE TABLE jev_inference_handoffs (
    request_id text PRIMARY KEY REFERENCES jev_evaluation_requests (request_id),
    handoff_hash text NOT NULL UNIQUE CHECK (handoff_hash ~ '^[0-9a-f]{64}$'),
    payload jsonb NOT NULL CHECK (
      jsonb_typeof(payload) = 'object'
      AND payload->>'schemaVersion' IS NOT DISTINCT FROM 'bayn.entry-handoff.v1'
      AND payload->>'requestId' IS NOT DISTINCT FROM request_id
      AND payload->>'handoffHash' IS NOT DISTINCT FROM handoff_hash
    )
  )`
  yield* sql`CREATE TRIGGER jev_inference_handoffs_immutable
    BEFORE UPDATE OR DELETE ON jev_inference_handoffs
    FOR EACH ROW EXECUTE FUNCTION reject_evidence_mutation()`
  yield* sql`CREATE TRIGGER jev_inference_handoffs_no_truncate
    BEFORE TRUNCATE ON jev_inference_handoffs
    FOR EACH STATEMENT EXECUTE FUNCTION reject_evidence_mutation()`
  yield* sql`ALTER TABLE jev_inference_handoffs ADD UNIQUE (request_id, handoff_hash)`
  yield* sql`ALTER TABLE inference_expense_quotes
    DROP CONSTRAINT inference_expense_quotes_check,
    DROP CONSTRAINT inference_expense_quotes_request_id_receipt_hash_key,
    ADD COLUMN provider_stage text GENERATED ALWAYS AS (COALESCE(payload #>> '{line,stage}', 'JEV')) STORED,
    ADD COLUMN handoff_hash text GENERATED ALWAYS AS (payload #>> '{line,handoffHash}') STORED,
    ADD CONSTRAINT inference_expense_quotes_check CHECK (
      jsonb_typeof(payload) = 'object'
      AND (payload->>'schemaVersion' IN ('bayn.inference-expense-quote.v1','bayn.inference-expense-quote.v2')) IS TRUE
      AND payload->>'quoteHash' IS NOT DISTINCT FROM quote_hash
      AND payload->>'sessionDate' IS NOT DISTINCT FROM session_date::text
    ),
    ADD UNIQUE NULLS NOT DISTINCT (request_id, provider_stage, receipt_hash, handoff_hash),
    ADD FOREIGN KEY (request_id, handoff_hash) REFERENCES jev_inference_handoffs (request_id, handoff_hash)`
  yield* sql`CREATE FUNCTION enforce_inference_expense_stage() RETURNS trigger LANGUAGE plpgsql AS $function$
    DECLARE source_version text;
    BEGIN
      SELECT payload->>'schemaVersion' INTO source_version FROM jev_evaluation_requests WHERE request_id=NEW.payload #>> '{line,requestId}';
      IF NOT COALESCE(
        (source_version='bayn.jev-evaluation-request.v1' AND NEW.payload->>'schemaVersion'='bayn.inference-expense-quote.v1')
        OR (source_version='bayn.jev-evaluation-request.v2' AND NEW.payload->>'schemaVersion'='bayn.inference-expense-quote.v2'
          AND NEW.payload #>> '{line,stage}' IN ('CHART','JEV')), false)
      THEN RAISE EXCEPTION 'inference expense must identify the actual provider stage and source contract' USING ERRCODE='23514'; END IF;
      RETURN NEW;
    END $function$`
  yield* sql`CREATE TRIGGER inference_expense_quotes_stage BEFORE INSERT ON inference_expense_quotes
    FOR EACH ROW EXECUTE FUNCTION enforce_inference_expense_stage()`
  yield* sql`CREATE FUNCTION enforce_entry_inference_handoff() RETURNS trigger LANGUAGE plpgsql AS $function$
    DECLARE source jsonb;
    BEGIN
      SELECT payload INTO source FROM jev_evaluation_requests WHERE request_id = NEW.request_id FOR UPDATE;
      IF source->>'schemaVersion' IS DISTINCT FROM 'bayn.jev-evaluation-request.v2'
        OR source->>'requestHash' IS DISTINCT FROM NEW.payload->>'inputHash'
        OR (NEW.payload->>'recordedAt')::timestamptz < (source->>'observedAt')::timestamptz
        OR NEW.payload->>'recordedAt' IS NULL
      THEN RAISE EXCEPTION 'entry inference handoff differs from its original source' USING ERRCODE = '23514'; END IF;
      RETURN NEW;
    END $function$`
  yield* sql`CREATE TRIGGER jev_inference_handoffs_source
    BEFORE INSERT ON jev_inference_handoffs
    FOR EACH ROW EXECUTE FUNCTION enforce_entry_inference_handoff()`
  yield* sql`CREATE FUNCTION enforce_entry_inference_receipt() RETURNS trigger LANGUAGE plpgsql AS $function$
    DECLARE source jsonb; handoff jsonb;
    BEGIN
      SELECT payload INTO source FROM jev_evaluation_requests WHERE request_id = NEW.request_id FOR UPDATE;
      IF source->>'schemaVersion' IS DISTINCT FROM 'bayn.jev-evaluation-request.v2'
      THEN RAISE EXCEPTION 'retired entry inference request cannot receive new evidence' USING ERRCODE = '23514'; END IF;
      SELECT payload INTO handoff FROM jev_inference_handoffs WHERE request_id = NEW.request_id;
      IF NEW.payload #>> '{outcome,status}' = 'COMPLETED' AND (
        handoff IS NULL OR handoff IS DISTINCT FROM NEW.payload #> '{outcome,completion,handoff}'
      ) THEN RAISE EXCEPTION 'entry inference receipt has no matching committed provider handoff' USING ERRCODE = '23514'; END IF;
      IF NEW.payload #>> '{outcome,failure}' = 'NOT_DISPATCHED' AND handoff IS NOT NULL
      THEN RAISE EXCEPTION 'undispatched receipt cannot omit a committed provider handoff' USING ERRCODE = '23514'; END IF;
      RETURN NEW;
    END $function$`
  yield* sql`CREATE TRIGGER jev_evaluation_receipts_handoff
    BEFORE INSERT ON jev_evaluation_receipts
    FOR EACH ROW EXECUTE FUNCTION enforce_entry_inference_receipt()`
  yield* sql`DO $protection$ DECLARE definition text; BEGIN
    definition := pg_get_functiondef('enforce_strategy_protection_plan()'::regprocedure);
    IF position('bayn.jev-entry-target.v6' in definition) = 0 THEN
      RAISE EXCEPTION 'expected the previous entry protection guard' USING ERRCODE = '55000';
    END IF;
    EXECUTE replace(definition, 'bayn.jev-entry-target.v6', 'bayn.jev-entry-target.v7');
  END $protection$`
})
