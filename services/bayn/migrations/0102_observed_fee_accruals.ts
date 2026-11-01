import { Effect } from 'effect'
import { SqlClient } from 'effect/sql'

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  yield* sql`CREATE TABLE account_cash_reporting (
    account_event_id text PRIMARY KEY REFERENCES account_snapshots(event_id),
    quantum_micros integer NOT NULL CHECK(quantum_micros IN(1,10,100,1000,10000))
  )`
  yield* sql`CREATE TRIGGER account_cash_reporting_immutable BEFORE UPDATE OR DELETE ON account_cash_reporting FOR EACH ROW EXECUTE FUNCTION reject_evidence_mutation()`
  yield* sql`CREATE TRIGGER account_cash_reporting_no_truncate BEFORE TRUNCATE ON account_cash_reporting FOR EACH STATEMENT EXECUTE FUNCTION reject_evidence_mutation()`
  yield* sql`CREATE TABLE broker_fee_accruals (
    accrual_id text PRIMARY KEY CHECK(accrual_id ~ '^[0-9a-f]{64}$'),account_id text NOT NULL,
    kind text NOT NULL CHECK(kind IN('COIN','CASH')),symbol text NOT NULL,cycle_id text NOT NULL REFERENCES autonomous_cycles(cycle_id),fee_date date NOT NULL,
    position_snapshot_id text,account_event_id text REFERENCES account_snapshots(event_id),observed_at timestamptz NOT NULL,
    coin_quantity_atoms numeric(39,0),cash_debit_micros numeric(39,0),expense_micros numeric(39,0) NOT NULL CHECK(expense_micros>=0),
    data jsonb NOT NULL,content_hash text NOT NULL CHECK(content_hash ~ '^[0-9a-f]{64}$'),ledger_plan_hash text NOT NULL CHECK(ledger_plan_hash ~ '^[0-9a-f]{64}$'),
    tigerbeetle_cluster_id numeric(39,0) NOT NULL,tigerbeetle_ledger bigint NOT NULL,posted_at timestamptz,
    FOREIGN KEY(position_snapshot_id,account_id) REFERENCES position_snapshots(snapshot_id,account_id),
    CHECK((kind='COIN' AND symbol IN('BTC/USD','ETH/USD','SOL/USD') AND position_snapshot_id IS NOT NULL AND account_event_id IS NULL
      AND coin_quantity_atoms IS NOT NULL AND coin_quantity_atoms>0 AND cash_debit_micros IS NULL
      AND data->>'positionSnapshotId' IS NOT DISTINCT FROM position_snapshot_id
      AND (data->>'projectedQuantityAtoms')::numeric-(data->>'observedQuantityAtoms')::numeric IS NOT DISTINCT FROM coin_quantity_atoms
      AND (data->>'projectedCostMicros')::numeric-(data->>'observedCostMicros')::numeric IS NOT DISTINCT FROM expense_micros) OR
      (kind='CASH' AND symbol='USD' AND account_event_id IS NOT NULL AND position_snapshot_id IS NULL
      AND cash_debit_micros IS NOT NULL AND cash_debit_micros>0 AND coin_quantity_atoms IS NULL AND expense_micros=cash_debit_micros
      AND data->>'accountEventId' IS NOT DISTINCT FROM account_event_id
      AND data->>'cashReportingQuantumMicros' IN('1','10','100','1000','10000')
      AND round((data->>'projectedCashMicros')::numeric/(data->>'cashReportingQuantumMicros')::numeric)*(data->>'cashReportingQuantumMicros')::numeric
        -(data->>'observedCashMicros')::numeric IS NOT DISTINCT FROM cash_debit_micros)),
    CHECK(data->>'schemaVersion' IS NOT DISTINCT FROM 'bayn.broker-fee-accrual.v1'
      AND data->>'accountId' IS NOT DISTINCT FROM account_id AND data->>'kind' IS NOT DISTINCT FROM kind
      AND data->>'symbol' IS NOT DISTINCT FROM symbol AND data->>'cycleId' IS NOT DISTINCT FROM cycle_id
      AND data->>'date' IS NOT DISTINCT FROM fee_date::text AND (data->>'observedAt')::timestamptz IS NOT DISTINCT FROM observed_at)
  )`
  yield* sql`CREATE INDEX broker_fee_accruals_cycle ON broker_fee_accruals(account_id,cycle_id)`
  yield* sql`CREATE INDEX broker_fee_accruals_date ON broker_fee_accruals(account_id,symbol,fee_date)`
  yield* sql`CREATE TABLE broker_fee_accrual_matches (
    accrual_id text NOT NULL REFERENCES broker_fee_accruals(accrual_id),account_id text NOT NULL,activity_id text NOT NULL,
    coin_quantity_atoms numeric(39,0),activity_cash_micros numeric(39,0),accrual_cash_micros numeric(39,0),
    PRIMARY KEY(accrual_id,account_id,activity_id),FOREIGN KEY(account_id,activity_id) REFERENCES broker_fee_accounting(account_id,activity_id),
    CHECK((coin_quantity_atoms IS NOT NULL AND coin_quantity_atoms>0 AND activity_cash_micros IS NULL AND accrual_cash_micros IS NULL)
      OR(coin_quantity_atoms IS NULL AND activity_cash_micros IS NOT NULL AND accrual_cash_micros IS NOT NULL AND activity_cash_micros>0 AND accrual_cash_micros>0))
  )`
  yield* sql`CREATE FUNCTION bayn_fee_accrual_match_guard() RETURNS trigger LANGUAGE plpgsql AS $$
  BEGIN
    IF NOT EXISTS(SELECT 1 FROM broker_fee_accruals a JOIN broker_fee_accounting f ON f.account_id=a.account_id
      WHERE a.accrual_id=NEW.accrual_id AND a.account_id=NEW.account_id AND f.activity_id=NEW.activity_id AND a.fee_date=f.fee_date AND (
      (a.kind='COIN' AND NEW.coin_quantity_atoms IS NOT NULL AND a.symbol=f.data->'coinDebit'->>'symbol'
        AND (SELECT sum(m.coin_quantity_atoms) FROM broker_fee_accrual_matches m WHERE m.accrual_id=a.accrual_id)<=a.coin_quantity_atoms
        AND (SELECT sum(m.coin_quantity_atoms) FROM broker_fee_accrual_matches m WHERE m.account_id=f.account_id AND m.activity_id=f.activity_id)<=(f.data->'coinDebit'->>'quantityAtoms')::numeric)
      OR(a.kind='CASH' AND NEW.activity_cash_micros IS NOT NULL AND NOT(f.data ? 'coinDebit') AND f.net_amount_micros<0
        AND (SELECT sum(m.accrual_cash_micros) FROM broker_fee_accrual_matches m WHERE m.accrual_id=a.accrual_id)<=a.cash_debit_micros
        AND abs((SELECT sum(m.accrual_cash_micros-m.activity_cash_micros) FROM broker_fee_accrual_matches m WHERE m.accrual_id=a.accrual_id))<=(a.data->>'cashReportingQuantumMicros')::numeric
        AND (SELECT sum(m.activity_cash_micros) FROM broker_fee_accrual_matches m WHERE m.account_id=f.account_id AND m.activity_id=f.activity_id)<=-f.net_amount_micros)
    )) THEN RAISE EXCEPTION 'fee receipt match exceeds or differs from its accrual evidence'; END IF;
    RETURN NEW;
  END $$`
  yield* sql`CREATE CONSTRAINT TRIGGER broker_fee_accrual_match_guard AFTER INSERT ON broker_fee_accrual_matches
    DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION bayn_fee_accrual_match_guard()`
  yield* sql`CREATE FUNCTION bayn_open_fee_plan_match_guard() RETURNS trigger LANGUAGE plpgsql AS $$
  BEGIN
    IF EXISTS(SELECT 1 FROM broker_fee_accounting WHERE account_id=NEW.account_id AND activity_id=NEW.activity_id AND posted_at IS NOT NULL)
      THEN RAISE EXCEPTION 'posted fee plans cannot acquire new receipt matches'; END IF;
    RETURN NEW;
  END $$`
  yield* sql`CREATE TRIGGER broker_fee_accrual_match_open_plan BEFORE INSERT ON broker_fee_accrual_matches
    FOR EACH ROW EXECUTE FUNCTION bayn_open_fee_plan_match_guard()`
  yield* sql`CREATE FUNCTION bayn_prepared_fee_guard() RETURNS trigger LANGUAGE plpgsql AS $$
  BEGIN
    IF TG_OP='UPDATE' AND OLD.posted_at IS NULL AND NEW.posted_at IS NOT NULL
      AND (to_jsonb(OLD)-'posted_at') IS NOT DISTINCT FROM (to_jsonb(NEW)-'posted_at') THEN RETURN NEW; END IF;
    RAISE EXCEPTION 'prepared fee evidence is immutable';
  END $$`
  for (const table of ['broker_fee_accruals', 'broker_fee_accounting'])
    yield* sql.unsafe(
      `CREATE TRIGGER ${table}_prepared_guard BEFORE UPDATE OR DELETE ON ${table} FOR EACH ROW EXECUTE FUNCTION bayn_prepared_fee_guard()`,
    )
  yield* sql`CREATE TRIGGER broker_fee_accruals_no_truncate BEFORE TRUNCATE ON broker_fee_accruals FOR EACH STATEMENT EXECUTE FUNCTION reject_evidence_mutation()`
  yield* sql`CREATE TRIGGER broker_fee_accrual_matches_immutable BEFORE UPDATE OR DELETE ON broker_fee_accrual_matches FOR EACH ROW EXECUTE FUNCTION reject_evidence_mutation()`
  yield* sql`CREATE TRIGGER broker_fee_accrual_matches_no_truncate BEFORE TRUNCATE ON broker_fee_accrual_matches FOR EACH STATEMENT EXECUTE FUNCTION reject_evidence_mutation()`
  yield* sql`CREATE VIEW broker_inventory_debits AS
    SELECT f.account_id,f.data->'coinDebit'->>'symbol' AS symbol,
      (f.data->'coinDebit'->>'quantityAtoms')::numeric-COALESCE((SELECT sum(m.coin_quantity_atoms) FROM broker_fee_accrual_matches m WHERE m.account_id=f.account_id AND m.activity_id=f.activity_id),0) AS quantity_atoms,
      f.coin_cost_basis_micros AS cost_basis_micros,f.first_observed_at AS effective_at,f.posted_at IS NOT NULL AS posted
    FROM broker_fee_accounting f WHERE f.data ? 'coinDebit'
    UNION ALL SELECT account_id,symbol,coin_quantity_atoms,expense_micros,observed_at,posted_at IS NOT NULL FROM broker_fee_accruals WHERE kind='COIN'`
  yield* sql`CREATE VIEW broker_cash_fee_deltas AS
    SELECT f.account_id,f.net_amount_micros+COALESCE((SELECT sum(m.accrual_cash_micros) FROM broker_fee_accrual_matches m WHERE m.account_id=f.account_id AND m.activity_id=f.activity_id),0) AS cash_delta_micros,
      f.first_observed_at AS effective_at,f.posted_at FROM broker_fee_accounting f
    UNION ALL SELECT account_id,-cash_debit_micros,observed_at,posted_at FROM broker_fee_accruals WHERE kind='CASH'`
})
