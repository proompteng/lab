import { Effect } from 'effect'
import { SqlClient } from 'effect/unstable/sql'

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient

  yield* sql`
    CREATE TABLE accounting_transactions (
      transaction_id text PRIMARY KEY CHECK (transaction_id ~ '^[0-9a-f]{64}$'),
      schema_version text NOT NULL CHECK (schema_version = 'bayn.paper-accounting-transaction.v1'),
      broker_event_id text NOT NULL UNIQUE REFERENCES fills(event_id) ON DELETE RESTRICT,
      intent_id text REFERENCES intents(intent_id) ON DELETE RESTRICT,
      account_id text NOT NULL CHECK (length(account_id) > 0 AND account_id = btrim(account_id)),
      symbol text NOT NULL CHECK (symbol ~ '^[A-Z][A-Z0-9.-]{0,15}$'),
      side text NOT NULL CHECK (side IN ('BUY', 'SELL')),
      quantity_micros numeric(39, 0) NOT NULL CHECK (
        quantity_micros > 0 AND quantity_micros <= 340282366920938463463374607431768211455
      ),
      price_micros numeric(39, 0) NOT NULL CHECK (
        price_micros > 0 AND price_micros <= 340282366920938463463374607431768211455
      ),
      notional_micros numeric(39, 0) NOT NULL CHECK (
        notional_micros > 0 AND notional_micros <= 340282366920938463463374607431768211455
      ),
      fee_micros numeric(39, 0) NOT NULL CHECK (
        fee_micros >= 0 AND fee_micros <= 340282366920938463463374607431768211455
      ),
      cost_basis_micros numeric(39, 0) NOT NULL CHECK (
        cost_basis_micros >= 0 AND cost_basis_micros <= 340282366920938463463374607431768211455
      ),
      realized_pnl_micros numeric(39, 0) NOT NULL CHECK (
        realized_pnl_micros BETWEEN -170141183460469231731687303715884105728
        AND 170141183460469231731687303715884105727
      ),
      quantity_delta_micros numeric(39, 0) NOT NULL CHECK (
        quantity_delta_micros BETWEEN -170141183460469231731687303715884105728
        AND 170141183460469231731687303715884105727
      ),
      cost_basis_delta_micros numeric(39, 0) NOT NULL CHECK (
        cost_basis_delta_micros BETWEEN -170141183460469231731687303715884105728
        AND 170141183460469231731687303715884105727
      ),
      cash_delta_micros numeric(39, 0) NOT NULL CHECK (
        cash_delta_micros BETWEEN -170141183460469231731687303715884105728
        AND 170141183460469231731687303715884105727
      ),
      ledger_plan_hash text NOT NULL CHECK (ledger_plan_hash ~ '^[0-9a-f]{64}$'),
      content_hash text NOT NULL CHECK (content_hash ~ '^[0-9a-f]{64}$'),
      occurred_at timestamptz NOT NULL,
      CHECK (
        (
          side = 'BUY'
          AND quantity_delta_micros = quantity_micros
          AND cost_basis_micros = notional_micros
          AND cost_basis_delta_micros = notional_micros
          AND realized_pnl_micros = 0
          AND cash_delta_micros = -(notional_micros + fee_micros)
        )
        OR (
          side = 'SELL'
          AND quantity_delta_micros = -quantity_micros
          AND cost_basis_delta_micros = -cost_basis_micros
          AND realized_pnl_micros = notional_micros - cost_basis_micros
          AND cash_delta_micros = notional_micros - fee_micros
        )
      )
    )
  `

  yield* sql`CREATE INDEX accounting_transactions_position_idx ON accounting_transactions(account_id, symbol)`

  yield* sql`
    CREATE TRIGGER accounting_transactions_append_only
    BEFORE UPDATE OR DELETE ON accounting_transactions
    FOR EACH ROW EXECUTE FUNCTION reject_evidence_mutation()
  `
  yield* sql`
    CREATE TRIGGER accounting_transactions_reject_truncate
    BEFORE TRUNCATE ON accounting_transactions
    FOR EACH STATEMENT EXECUTE FUNCTION reject_evidence_mutation()
  `

  yield* sql`
    ALTER TABLE accounting_receipts
    ADD CONSTRAINT accounting_receipts_broker_event_unique UNIQUE (broker_event_id),
    ADD CONSTRAINT accounting_receipts_transaction_fk
      FOREIGN KEY (broker_event_id) REFERENCES accounting_transactions(broker_event_id) ON DELETE RESTRICT
  `

  yield* sql`
    ALTER TABLE valuations
    ADD CONSTRAINT valuations_account_source_unique UNIQUE (account_id, source_hash)
  `
})
