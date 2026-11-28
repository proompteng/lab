import { Effect } from 'effect'
import { SqlClient } from 'effect/sql'

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  yield* sql`CREATE TABLE broker_fee_posting_acknowledgements (
    account_id text NOT NULL,source_kind text NOT NULL CHECK(source_kind IN('ACCRUAL','ACTIVITY')),
    source_id text NOT NULL,ledger_plan_hash text NOT NULL CHECK(ledger_plan_hash ~ '^[0-9a-f]{64}$'),
    acknowledged_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    PRIMARY KEY(account_id,source_kind,source_id))`
  yield* sql`CREATE FUNCTION bayn_fee_posting_acknowledgement_guard() RETURNS trigger LANGUAGE plpgsql AS $$
  BEGIN
    IF NEW.acknowledged_at<statement_timestamp() OR NEW.acknowledged_at>clock_timestamp()
      OR NOT EXISTS(
        SELECT 1 FROM broker_fee_accruals a WHERE NEW.source_kind='ACCRUAL'
          AND a.account_id=NEW.account_id AND a.accrual_id=NEW.source_id
          AND a.ledger_plan_hash=NEW.ledger_plan_hash AND a.posted_at IS NOT NULL
        UNION ALL
        SELECT 1 FROM broker_fee_accounting f WHERE NEW.source_kind='ACTIVITY'
          AND f.account_id=NEW.account_id AND f.activity_id=NEW.source_id
          AND f.ledger_plan_hash=NEW.ledger_plan_hash AND f.posted_at IS NOT NULL)
      THEN RAISE EXCEPTION 'fee posting acknowledgement must bind a posted plan at the current database clock'; END IF;
    RETURN NEW;
  END $$`
  yield* sql`CREATE TRIGGER broker_fee_posting_acknowledgement_guard BEFORE INSERT ON broker_fee_posting_acknowledgements
    FOR EACH ROW EXECUTE FUNCTION bayn_fee_posting_acknowledgement_guard()`
  yield* sql`CREATE TRIGGER broker_fee_posting_acknowledgements_immutable BEFORE UPDATE OR DELETE ON broker_fee_posting_acknowledgements
    FOR EACH ROW EXECUTE FUNCTION reject_evidence_mutation()`
  yield* sql`CREATE TRIGGER broker_fee_posting_acknowledgements_no_truncate BEFORE TRUNCATE ON broker_fee_posting_acknowledgements
    FOR EACH STATEMENT EXECUTE FUNCTION reject_evidence_mutation()`
})
