import { Effect } from 'effect'
import { SqlClient } from 'effect/sql'

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  yield* sql`CREATE VIEW broker_fee_accrual_cohorts AS
    SELECT a.accrual_id,
      CASE WHEN count(t.transaction_id)=jsonb_array_length(a.data->'sourceTrades')
        AND count(i.intent_id)=jsonb_array_length(a.data->'sourceTrades')
        AND count(DISTINCT (t.occurred_at AT TIME ZONE 'UTC')::date)=1
        THEN min((t.occurred_at AT TIME ZONE 'UTC')::date)::text END AS settlement_date
    FROM broker_fee_accruals a LEFT JOIN LATERAL jsonb_array_elements(a.data->'sourceTrades') trade ON true
    LEFT JOIN accounting_transactions t ON t.transaction_id=trade->>'transactionId' AND t.account_id=a.account_id
      AND t.quantity_atoms=(trade->>'quantityAtoms')::numeric AND t.price_atoms=(trade->>'priceAtoms')::numeric
      AND t.symbol IN('BTC/USD','ETH/USD','SOL/USD') AND t.side=CASE WHEN a.kind='COIN' THEN 'BUY' ELSE 'SELL' END
    LEFT JOIN intents i ON i.intent_id=t.intent_id AND i.account_id=a.account_id AND i.cycle_id=a.cycle_id
    GROUP BY a.accrual_id`
  yield* sql`CREATE TABLE broker_fee_match_corrections (
    correction_id text PRIMARY KEY CHECK(correction_id ~ '^[0-9a-f]{64}$'),
    account_id text NOT NULL,activity_id text NOT NULL,accrual_id text NOT NULL,
    cash_debit_micros numeric(39,0) NOT NULL CHECK(cash_debit_micros>0),
    data jsonb NOT NULL,content_hash text NOT NULL CHECK(content_hash ~ '^[0-9a-f]{64}$'),
    ledger_plan_hash text NOT NULL CHECK(ledger_plan_hash ~ '^[0-9a-f]{64}$'),
    tigerbeetle_cluster_id numeric(39,0) NOT NULL,tigerbeetle_ledger bigint NOT NULL,posted_at timestamptz,
    UNIQUE(accrual_id,account_id,activity_id),
    FOREIGN KEY(accrual_id,account_id,activity_id) REFERENCES broker_fee_accrual_matches(accrual_id,account_id,activity_id),
    CHECK(data->>'schemaVersion' IS NOT DISTINCT FROM 'bayn.fee-match-correction.v1'
      AND data->>'accountId' IS NOT DISTINCT FROM account_id AND data->>'activityId' IS NOT DISTINCT FROM activity_id
      AND data->>'accrualId' IS NOT DISTINCT FROM accrual_id AND data->>'accrualCashMicros' IS NOT DISTINCT FROM cash_debit_micros::text)
  )`
  yield* sql`CREATE VIEW broker_fee_accounting_evidence AS SELECT f.*,
    COALESCE((SELECT jsonb_agg(jsonb_build_object(
      'correction_id',c.correction_id,'data',c.data,'content_hash',c.content_hash,'ledger_plan_hash',c.ledger_plan_hash,
      'tigerbeetle_cluster_id',c.tigerbeetle_cluster_id::text,'tigerbeetle_ledger',c.tigerbeetle_ledger::integer,
      'posted',c.posted_at IS NOT NULL) ORDER BY c.correction_id)
      FROM broker_fee_match_corrections c WHERE c.account_id=f.account_id AND c.activity_id=f.activity_id),'[]'::jsonb) AS cash_match_corrections
    FROM broker_fee_accounting f`
  yield* sql`CREATE FUNCTION bayn_fee_match_correction_guard() RETURNS trigger LANGUAGE plpgsql AS $$
  BEGIN
    IF NOT EXISTS(SELECT 1 FROM broker_fee_accrual_matches m
      JOIN broker_fee_accounting f ON f.account_id=m.account_id AND f.activity_id=m.activity_id
      JOIN broker_fee_accruals a ON a.accrual_id=m.accrual_id AND a.account_id=m.account_id
      WHERE m.accrual_id=NEW.accrual_id AND m.account_id=NEW.account_id AND m.activity_id=NEW.activity_id
        AND a.kind='CASH' AND m.coin_quantity_atoms IS NULL AND f.posted_at IS NOT NULL
        AND NOT(f.data ? 'coinDebit') AND NOT(f.data ? 'cryptoCashFee')
        AND f.content_hash IS NOT DISTINCT FROM NEW.data->>'feeContentHash'
        AND m.activity_cash_micros IS NOT DISTINCT FROM (NEW.data->>'activityCashMicros')::numeric
        AND m.accrual_cash_micros IS NOT DISTINCT FROM NEW.cash_debit_micros
        AND NEW.data->'readEvidence'->>'status'='200'
        AND (NEW.data->'readEvidence'->>'observedAt')::timestamptz >= f.first_observed_at)
      THEN RAISE EXCEPTION 'fee correction must bind an observed non-crypto cash fee and its original posted match'; END IF;
    RETURN NEW;
  END $$`
  yield* sql`CREATE TRIGGER broker_fee_match_correction_guard BEFORE INSERT ON broker_fee_match_corrections FOR EACH ROW EXECUTE FUNCTION bayn_fee_match_correction_guard()`
  yield* sql`CREATE TRIGGER broker_fee_match_corrections_prepared_guard BEFORE UPDATE OR DELETE ON broker_fee_match_corrections FOR EACH ROW EXECUTE FUNCTION bayn_prepared_fee_guard()`
  yield* sql`CREATE TRIGGER broker_fee_match_corrections_no_truncate BEFORE TRUNCATE ON broker_fee_match_corrections FOR EACH STATEMENT EXECUTE FUNCTION reject_evidence_mutation()`
  yield* sql`CREATE OR REPLACE FUNCTION bayn_fee_accrual_match_guard() RETURNS trigger LANGUAGE plpgsql AS $$
  BEGIN
    IF NOT EXISTS(SELECT 1 FROM broker_fee_accruals a
      JOIN broker_fee_accrual_cohorts cohort USING(accrual_id)
      JOIN broker_fee_accounting f ON f.account_id=a.account_id
      WHERE a.accrual_id=NEW.accrual_id AND a.account_id=NEW.account_id AND f.activity_id=NEW.activity_id
        AND cohort.settlement_date=f.fee_date::text AND (
      (a.kind='COIN' AND NEW.coin_quantity_atoms IS NOT NULL AND a.symbol=f.data->'coinDebit'->>'symbol'
        AND (SELECT sum(m.coin_quantity_atoms) FROM broker_fee_accrual_matches m WHERE m.accrual_id=a.accrual_id)<=a.coin_quantity_atoms
        AND (SELECT sum(m.coin_quantity_atoms) FROM broker_fee_accrual_matches m WHERE m.account_id=f.account_id AND m.activity_id=f.activity_id)<=(f.data->'coinDebit'->>'quantityAtoms')::numeric)
      OR(a.kind='CASH' AND NEW.activity_cash_micros IS NOT NULL AND f.data->>'cryptoCashFee'='true' AND f.net_amount_micros<0
        AND (COALESCE((SELECT sum(m.accrual_cash_micros) FROM broker_fee_accrual_matches m WHERE m.accrual_id=a.accrual_id),0)
          -COALESCE((SELECT sum(c.cash_debit_micros) FROM broker_fee_match_corrections c WHERE c.accrual_id=a.accrual_id),0))<=a.cash_debit_micros
        AND abs(COALESCE((SELECT sum(m.accrual_cash_micros-m.activity_cash_micros) FROM broker_fee_accrual_matches m WHERE m.accrual_id=a.accrual_id),0)
          -COALESCE((SELECT sum(c.cash_debit_micros-(c.data->>'activityCashMicros')::numeric) FROM broker_fee_match_corrections c WHERE c.accrual_id=a.accrual_id),0))<=(a.data->>'cashReportingQuantumMicros')::numeric
        AND (SELECT sum(m.activity_cash_micros) FROM broker_fee_accrual_matches m WHERE m.account_id=f.account_id AND m.activity_id=f.activity_id)<=-f.net_amount_micros)
    )) THEN RAISE EXCEPTION 'fee receipt match exceeds or differs from its source UTC cohort'; END IF;
    RETURN NEW;
  END $$`
  yield* sql`CREATE OR REPLACE VIEW broker_cash_fee_deltas AS
    SELECT f.account_id,f.net_amount_micros+COALESCE((SELECT sum(m.accrual_cash_micros) FROM broker_fee_accrual_matches m WHERE m.account_id=f.account_id AND m.activity_id=f.activity_id),0) AS cash_delta_micros,
      f.first_observed_at AS effective_at,f.posted_at FROM broker_fee_accounting f
    UNION ALL SELECT account_id,-cash_debit_micros,observed_at,posted_at FROM broker_fee_accruals WHERE kind='CASH'
    UNION ALL SELECT account_id,-cash_debit_micros,(data->'readEvidence'->>'observedAt')::timestamptz,posted_at FROM broker_fee_match_corrections`
})
