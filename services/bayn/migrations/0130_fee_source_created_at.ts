import { Effect } from 'effect'
import { SqlClient } from 'effect/sql'

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  yield* sql`ALTER TABLE broker_fee_accounting ADD CONSTRAINT broker_fee_source_created_at_check CHECK (
    (NOT(read_evidence ? 'sourceCreatedAt') OR (
      (data ? 'coinDebit' OR data->>'cryptoCashFee'='true')
      AND jsonb_typeof(read_evidence->'sourceCreatedAt')='string'
      AND read_evidence->>'sourceCreatedAt' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}[.][0-9]{9}Z$'
      AND read_evidence->>'observedAt' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}[.][0-9]{3}Z$'
      AND (read_evidence->>'sourceCreatedAt')::timestamptz <= (read_evidence->>'observedAt')::timestamptz
      AND read_evidence->>'sourceCreatedAt' <= replace(read_evidence->>'observedAt','Z','000000Z')
    )) IS TRUE
  )`
  yield* sql`CREATE OR REPLACE FUNCTION bayn_fee_accrual_match_guard() RETURNS trigger LANGUAGE plpgsql AS $$
  BEGIN
    IF NOT EXISTS(SELECT 1 FROM broker_fee_accruals a
      JOIN broker_fee_accrual_cohorts cohort USING(accrual_id)
      JOIN broker_fee_accounting f ON f.account_id=a.account_id
      WHERE a.accrual_id=NEW.accrual_id AND a.account_id=NEW.account_id AND f.activity_id=NEW.activity_id
        AND cohort.settlement_date=COALESCE(left(f.read_evidence->>'sourceCreatedAt',10),f.fee_date::text) AND (
      (a.kind='COIN' AND NEW.coin_quantity_atoms IS NOT NULL AND a.symbol=f.data->'coinDebit'->>'symbol'
        AND (SELECT sum(m.coin_quantity_atoms) FROM broker_fee_accrual_matches m WHERE m.accrual_id=a.accrual_id)<=a.coin_quantity_atoms
        AND (SELECT sum(m.coin_quantity_atoms) FROM broker_fee_accrual_matches m WHERE m.account_id=f.account_id AND m.activity_id=f.activity_id)<=(f.data->'coinDebit'->>'quantityAtoms')::numeric)
      OR(a.kind='CASH' AND NEW.activity_cash_micros IS NOT NULL AND f.data->>'cryptoCashFee'='true' AND f.net_amount_micros<0
        AND NEW.accrual_cash_micros=NEW.activity_cash_micros
        AND (COALESCE((SELECT sum(m.accrual_cash_micros) FROM broker_fee_accrual_matches m WHERE m.accrual_id=a.accrual_id),0)
          -COALESCE((SELECT sum(c.cash_debit_micros) FROM broker_fee_match_corrections c WHERE c.accrual_id=a.accrual_id),0))<=a.cash_debit_micros
        AND (SELECT sum(m.activity_cash_micros) FROM broker_fee_accrual_matches m WHERE m.account_id=f.account_id AND m.activity_id=f.activity_id)<=-f.net_amount_micros)
    )) THEN RAISE EXCEPTION 'fee receipt match exceeds or differs from its source UTC cohort'; END IF;
    RETURN NEW;
  END $$`
})
