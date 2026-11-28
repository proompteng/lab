import { Effect } from 'effect'
import { SqlClient } from 'effect/sql'

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  // CNPG owns the login; disposable databases intentionally do not have it.
  yield* sql`DO $migration$
    BEGIN
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'bayn_audit_ro') THEN
        GRANT USAGE ON SCHEMA public TO bayn_audit_ro;
        GRANT SELECT ON TABLE public.broker_fee_accounting_evidence TO bayn_audit_ro;
      END IF;
    END $migration$`
})
