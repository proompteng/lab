import { Effect } from 'effect'
import { SqlClient } from 'effect/sql'

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  // CNPG owns the login; disposable databases intentionally do not have it.
  yield* sql`DO $migration$
    BEGIN
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'bayn_audit_ro') THEN
        GRANT USAGE ON SCHEMA public TO bayn_audit_ro;
        GRANT SELECT ON TABLE
          public.account_snapshots,
          public.accounting_receipts,
          public.accounting_transactions,
          public.authority_generations,
          public.autonomous_cycle_paper_close_replans,
          public.autonomous_cycle_paper_closures,
          public.autonomous_cycle_shadow_decisions,
          public.autonomous_cycles,
          public.broker_events,
          public.broker_fee_accounting,
          public.broker_inventory_debits,
          public.execution_controller_observations,
          public.fills,
          public.intents,
          public.intraday_alpha_baseline_preparations,
          public.intraday_candidate_observations,
          public.live_capital_grants,
          public.mutation_events,
          public.orders,
          public.position_snapshots,
          public.positions,
          public.reconciliations,
          -- Core retained observation and audit receipts.
          public.autonomous_forward_performance_receipts,
          public.broker_observations,
          public.system_durable_observations
        TO bayn_audit_ro;
      END IF;
    END $migration$`
})
