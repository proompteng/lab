import { Effect } from 'effect'
import { SqlClient } from 'effect/sql'

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  yield* sql`CREATE TABLE broker_cash_settlements (
    settlement_id text PRIMARY KEY CHECK(settlement_id ~ '^[0-9a-f]{64}$'),
    transaction_id text NOT NULL UNIQUE REFERENCES accounting_transactions(transaction_id),
    account_id text NOT NULL,
    precision_account_event_id text NOT NULL REFERENCES account_snapshots(event_id),
    rounding_delta_micros numeric(39,0) NOT NULL CHECK(rounding_delta_micros<>0),
    data jsonb NOT NULL,
    content_hash text NOT NULL CHECK(content_hash ~ '^[0-9a-f]{64}$'),
    ledger_plan_hash text NOT NULL CHECK(ledger_plan_hash ~ '^[0-9a-f]{64}$'),
    tigerbeetle_cluster_id numeric(39,0) NOT NULL,
    tigerbeetle_ledger bigint NOT NULL,
    prepared_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    posted_at timestamptz,
    CHECK(data->>'schemaVersion' IS NOT DISTINCT FROM 'bayn.broker-cash-settlement.v1'
      AND data->>'accountId' IS NOT DISTINCT FROM account_id
      AND data->>'transactionId' IS NOT DISTINCT FROM transaction_id
      AND data->>'precisionAccountEventId' IS NOT DISTINCT FROM precision_account_event_id))`
  yield* sql`CREATE INDEX broker_cash_settlements_account ON broker_cash_settlements(account_id,transaction_id)`
  yield* sql`CREATE FUNCTION bayn_cash_settlement_source_guard() RETURNS trigger LANGUAGE plpgsql AS $$
  BEGIN
    IF NEW.posted_at IS NOT NULL OR NOT EXISTS (
      SELECT 1 FROM accounting_transactions t
      JOIN accounting_receipts receipt ON receipt.broker_event_id=t.broker_event_id
      JOIN account_snapshots a ON a.event_id=NEW.precision_account_event_id AND a.account_id=t.account_id
      JOIN broker_events e ON e.event_id=a.event_id AND e.account_id=t.account_id AND e.event_kind='ACCOUNT'
      JOIN account_cash_reporting r ON r.account_event_id=a.event_id
      WHERE t.transaction_id=NEW.transaction_id AND t.account_id=NEW.account_id
        AND t.broker_event_id=NEW.data->>'brokerEventId'
        AND t.content_hash=NEW.data->>'transactionContentHash'
        AND t.cash_delta_micros=(NEW.data->>'cashDeltaMicros')::numeric
        AND t.occurred_at=(NEW.data->>'occurredAt')::timestamptz
        AND e.observed_at=(NEW.data->>'observedAt')::timestamptz
        AND t.occurred_at<=e.observed_at
        AND r.quantum_micros=(NEW.data->>'cashReportingQuantumMicros')::integer
        AND NEW.rounding_delta_micros=round(t.cash_delta_micros/r.quantum_micros)*r.quantum_micros-t.cash_delta_micros
    ) THEN RAISE EXCEPTION 'cash settlement must bind a retained fill receipt and observed broker cash precision'; END IF;
    RETURN NEW;
  END $$`
  yield* sql`CREATE TRIGGER broker_cash_settlements_source_guard BEFORE INSERT ON broker_cash_settlements
    FOR EACH ROW EXECUTE FUNCTION bayn_cash_settlement_source_guard()`
  yield* sql`CREATE FUNCTION bayn_cash_settlement_post_guard() RETURNS trigger LANGUAGE plpgsql AS $$
  BEGIN
    IF TG_OP='UPDATE' AND OLD.posted_at IS NULL AND NEW.posted_at IS NOT NULL
      AND NEW.posted_at>=statement_timestamp() AND NEW.posted_at<=clock_timestamp()
      AND (to_jsonb(OLD)-'posted_at') IS NOT DISTINCT FROM (to_jsonb(NEW)-'posted_at') THEN RETURN NEW; END IF;
    RAISE EXCEPTION 'cash settlement evidence is immutable and posting requires the current database clock';
  END $$`
  yield* sql`CREATE TRIGGER broker_cash_settlements_post_guard BEFORE UPDATE OR DELETE ON broker_cash_settlements
    FOR EACH ROW EXECUTE FUNCTION bayn_cash_settlement_post_guard()`
  yield* sql`CREATE TRIGGER broker_cash_settlements_no_truncate BEFORE TRUNCATE ON broker_cash_settlements
    FOR EACH STATEMENT EXECUTE FUNCTION reject_evidence_mutation()`
})
