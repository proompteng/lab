import { Effect } from 'effect'
import { SqlClient } from 'effect/sql'

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  yield* sql`ALTER TABLE broker_fee_match_corrections DROP CONSTRAINT broker_fee_match_corrections_check`
  yield* sql`ALTER TABLE broker_fee_match_corrections ADD CONSTRAINT broker_fee_match_corrections_check CHECK(
    data->>'schemaVersion' IN('bayn.fee-match-correction.v1','bayn.fee-match-correction.v2')
    AND data->>'accountId' IS NOT DISTINCT FROM account_id AND data->>'activityId' IS NOT DISTINCT FROM activity_id
    AND data->>'accrualId' IS NOT DISTINCT FROM accrual_id
    AND cash_debit_micros IS NOT DISTINCT FROM (data->>'accrualCashMicros')::numeric
      -CASE WHEN data->>'schemaVersion'='bayn.fee-match-correction.v2' THEN (data->>'activityCashMicros')::numeric ELSE 0 END)`
  yield* sql`CREATE OR REPLACE FUNCTION bayn_fee_match_correction_guard() RETURNS trigger LANGUAGE plpgsql AS $$
  BEGIN
    IF NOT EXISTS(SELECT 1 FROM broker_fee_accrual_matches m
      JOIN broker_fee_accounting f ON f.account_id=m.account_id AND f.activity_id=m.activity_id
      JOIN broker_fee_accruals a ON a.accrual_id=m.accrual_id AND a.account_id=m.account_id
      WHERE m.accrual_id=NEW.accrual_id AND m.account_id=NEW.account_id AND m.activity_id=NEW.activity_id
        AND a.kind='CASH' AND m.coin_quantity_atoms IS NULL AND f.posted_at IS NOT NULL
        AND NOT(f.data ? 'coinDebit') AND (
          (NEW.data->>'schemaVersion'='bayn.fee-match-correction.v1' AND NOT(f.data ? 'cryptoCashFee')
            AND NEW.cash_debit_micros=m.accrual_cash_micros)
          OR(NEW.data->>'schemaVersion'='bayn.fee-match-correction.v2' AND f.data->>'cryptoCashFee'='true'
            AND NEW.cash_debit_micros=m.accrual_cash_micros-m.activity_cash_micros
            AND NEW.cash_debit_micros<=(a.data->>'cashReportingQuantumMicros')::numeric))
        AND f.content_hash IS NOT DISTINCT FROM NEW.data->>'feeContentHash'
        AND m.activity_cash_micros IS NOT DISTINCT FROM (NEW.data->>'activityCashMicros')::numeric
        AND m.accrual_cash_micros IS NOT DISTINCT FROM (NEW.data->>'accrualCashMicros')::numeric
        AND NEW.data->'readEvidence'->>'status'='200'
        AND (NEW.data->'readEvidence'->>'observedAt')::timestamptz >= f.first_observed_at)
      THEN RAISE EXCEPTION 'fee correction must bind its observed fee and exact original posted match'; END IF;
    RETURN NEW;
  END $$`
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
        AND NEW.accrual_cash_micros=NEW.activity_cash_micros
        AND (COALESCE((SELECT sum(m.accrual_cash_micros) FROM broker_fee_accrual_matches m WHERE m.accrual_id=a.accrual_id),0)
          -COALESCE((SELECT sum(c.cash_debit_micros) FROM broker_fee_match_corrections c WHERE c.accrual_id=a.accrual_id),0))<=a.cash_debit_micros
        AND (SELECT sum(m.activity_cash_micros) FROM broker_fee_accrual_matches m WHERE m.account_id=f.account_id AND m.activity_id=f.activity_id)<=-f.net_amount_micros)
    )) THEN RAISE EXCEPTION 'fee receipt match exceeds or differs from its exact source UTC cohort'; END IF;
    RETURN NEW;
  END $$`
})
