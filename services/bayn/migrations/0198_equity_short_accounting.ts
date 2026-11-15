import { Effect } from 'effect'
import { SqlClient } from 'effect/sql'

/** Admit explicit short-inventory evidence without rewriting any retained long transaction. */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  yield* sql`ALTER TABLE accounting_transactions
    DROP CONSTRAINT accounting_transactions_schema_version_check,
    DROP CONSTRAINT accounting_transactions_check,
    ADD CONSTRAINT accounting_transactions_schema_version_check CHECK (
      schema_version IN ('bayn.accounting-transaction.v2','bayn.equity-short-accounting-transaction.v1')),
    ADD CONSTRAINT accounting_transactions_check CHECK (
      (schema_version = 'bayn.accounting-transaction.v2' AND (
        (side = 'BUY' AND quantity_delta_atoms = quantity_atoms AND cost_basis_micros = notional_micros
          AND cost_basis_delta_micros = notional_micros AND realized_pnl_micros = 0
          AND cash_delta_micros = -(notional_micros + fee_micros))
        OR
        (side = 'SELL' AND quantity_delta_atoms = -quantity_atoms AND cost_basis_delta_micros = -cost_basis_micros
          AND realized_pnl_micros = notional_micros - cost_basis_micros
          AND cash_delta_micros = notional_micros - fee_micros)))
      OR
      (schema_version = 'bayn.equity-short-accounting-transaction.v1' AND symbol NOT LIKE '%/%' AND (
        (side = 'SELL' AND quantity_delta_atoms = -quantity_atoms AND cost_basis_micros = notional_micros
          AND cost_basis_delta_micros = -notional_micros AND realized_pnl_micros = 0
          AND cash_delta_micros = notional_micros - fee_micros)
        OR
        (side = 'BUY' AND quantity_delta_atoms = quantity_atoms AND cost_basis_delta_micros = cost_basis_micros
          AND realized_pnl_micros = cost_basis_micros - notional_micros
          AND cash_delta_micros = -(notional_micros + fee_micros)))))
  `
})
