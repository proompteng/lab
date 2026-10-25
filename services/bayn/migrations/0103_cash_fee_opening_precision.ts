import { Effect } from 'effect'
import { SqlClient } from 'effect/sql'

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  yield* sql`ALTER TABLE broker_fee_accruals DROP CONSTRAINT broker_fee_accruals_check1`
  yield* sql`ALTER TABLE broker_fee_accruals ADD CONSTRAINT broker_fee_accruals_bound_version CHECK(
    data->>'schemaVersion' IS NOT DISTINCT FROM CASE WHEN kind='COIN' THEN 'bayn.broker-fee-accrual.v1' ELSE 'bayn.broker-fee-accrual.v2' END
    AND data->>'accountId' IS NOT DISTINCT FROM account_id AND data->>'kind' IS NOT DISTINCT FROM kind
    AND data->>'symbol' IS NOT DISTINCT FROM symbol AND data->>'cycleId' IS NOT DISTINCT FROM cycle_id
    AND data->>'date' IS NOT DISTINCT FROM fee_date::text AND (data->>'observedAt')::timestamptz IS NOT DISTINCT FROM observed_at
    AND (kind<>'CASH' OR (data ? 'openingAccountEventId' AND data->>'openingAccountEventId' ~ '^[0-9a-f]{64}$'
      AND data ? 'openingCashReportingQuantumMicros' AND data->>'openingCashReportingQuantumMicros' IN('1','10','100','1000','10000'))))`
  yield* sql`CREATE FUNCTION bayn_cash_fee_opening_guard() RETURNS trigger LANGUAGE plpgsql AS $$
  DECLARE opening_id text; opening_quantum integer; first_fill timestamptz;
  BEGIN
    IF NEW.kind<>'CASH' THEN RETURN NEW; END IF;
    SELECT min(t.occurred_at) INTO first_fill FROM accounting_transactions t
      JOIN LATERAL jsonb_array_elements(NEW.data->'sourceTrades') trade ON trade->>'transactionId'=t.transaction_id
      WHERE t.account_id=NEW.account_id AND t.side='SELL';
    SELECT a.event_id,r.quantum_micros INTO opening_id,opening_quantum
      FROM account_snapshots a JOIN broker_events e USING(event_id) LEFT JOIN account_cash_reporting r ON r.account_event_id=a.event_id
      WHERE a.account_id=NEW.account_id AND e.account_id=NEW.account_id AND e.event_kind='ACCOUNT' AND e.observed_at<first_fill
      ORDER BY e.observed_at DESC,e.source_sequence DESC LIMIT 1;
    IF opening_id IS NULL OR opening_id IS DISTINCT FROM NEW.data->>'openingAccountEventId'
      OR opening_quantum::text IS DISTINCT FROM NEW.data->>'openingCashReportingQuantumMicros'
      OR NOT EXISTS(SELECT 1 FROM account_cash_reporting r JOIN account_snapshots a ON a.event_id=r.account_event_id
        WHERE a.event_id=NEW.account_event_id AND a.account_id=NEW.account_id
          AND r.quantum_micros::text=NEW.data->>'cashReportingQuantumMicros')
      THEN RAISE EXCEPTION 'cash fee accrual must bind its retained opening and closing precision'; END IF;
    RETURN NEW;
  END $$`
  yield* sql`CREATE TRIGGER broker_cash_fee_opening_guard BEFORE INSERT ON broker_fee_accruals FOR EACH ROW EXECUTE FUNCTION bayn_cash_fee_opening_guard()`
})
