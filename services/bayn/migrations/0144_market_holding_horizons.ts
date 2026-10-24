import { SqlClient } from 'effect/sql'
import { Effect } from 'effect'

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  yield* sql`SELECT pg_advisory_xact_lock(1111578958, 1)`
  yield* sql`LOCK TABLE intents, mutation_events, autonomous_cycles, authority_state,
    broker_events, fills, orders, positions, position_snapshots, accounting_transactions,
    accounting_receipts, broker_fee_accounting, broker_fee_accruals, broker_fee_accrual_matches,
    reconciliations IN ACCESS EXCLUSIVE MODE`
  yield* sql`DO $cutover$ BEGIN
    IF EXISTS (SELECT 1 FROM intents WHERE state <> 'TERMINAL')
      OR EXISTS (
        SELECT 1 FROM (
          SELECT account_id, symbol, quantity_delta_atoms AS quantity, cost_basis_delta_micros AS cost
            FROM accounting_transactions
          UNION ALL SELECT account_id, symbol, -quantity_atoms, -cost_basis_micros
            FROM broker_inventory_debits WHERE posted
        ) inventory GROUP BY account_id, symbol HAVING sum(quantity) <> 0 OR sum(cost) <> 0
      )
      OR EXISTS (
        SELECT 1 FROM (SELECT DISTINCT ON (account_id) position_count FROM position_snapshots ORDER BY account_id, observed_at DESC, snapshot_id DESC) latest WHERE position_count <> 0
      )
      OR EXISTS (SELECT 1 FROM accounting_transactions t LEFT JOIN accounting_receipts r USING (broker_event_id) WHERE r.receipt_id IS NULL)
      OR EXISTS (SELECT 1 FROM fills f LEFT JOIN accounting_transactions t ON t.broker_event_id = f.event_id WHERE t.transaction_id IS NULL)
      OR EXISTS (
        SELECT 1 FROM (
          SELECT DISTINCT ON (o.account_id, o.broker_order_id) o.status
          FROM orders o JOIN broker_events e USING (event_id)
          ORDER BY o.account_id, o.broker_order_id, e.source_sequence DESC
        ) latest WHERE status IN ('NEW', 'PENDING', 'PARTIALLY_FILLED', 'HELD')
      )
      OR EXISTS (
        SELECT 1 FROM authority_state a JOIN authority_generations g USING (generation_hash)
        LEFT JOIN LATERAL (
          SELECT status, reconciled_at FROM reconciliations r WHERE r.account_id = g.account_id
          ORDER BY reconciled_at DESC, reconciliation_id DESC LIMIT 1
        ) latest ON true
        WHERE a.maximum = 'PAPER' AND (
          latest.status IS DISTINCT FROM 'EXACT'
          OR latest.reconciled_at IS NULL
          OR latest.reconciled_at > clock_timestamp()
          OR latest.reconciled_at < clock_timestamp() - interval '60 seconds'
          OR latest.reconciled_at < (SELECT max(occurred_at) FROM mutation_events m JOIN intents i USING (intent_id) WHERE i.account_id = g.account_id)
        )
      )
      OR EXISTS (SELECT 1 FROM autonomous_cycles c WHERE state IN ('PENDING', 'ACTIVE') AND (snapshot_id IS NOT NULL OR decision_hash IS NOT NULL OR EXISTS (SELECT 1 FROM intents i WHERE i.cycle_id = c.cycle_id)))
    THEN RAISE EXCEPTION 'market-holding-horizons cutover requires terminal mutation cycles, flat positions, settled orders, fresh exact reconciliation and complete accounting' USING ERRCODE = '55000'; END IF;
  END $cutover$`
  yield* sql`WITH cutover AS MATERIALIZED (SELECT clock_timestamp() AS at)
    UPDATE autonomous_cycles SET state = 'BLOCKED', terminal_reason = 'BLOCKED_AUTHORITY',
      state_version = state_version + 1, updated_at = greatest(cutover.at, updated_at), terminal_at = greatest(cutover.at, updated_at)
    FROM cutover WHERE state IN ('PENDING', 'ACTIVE') AND snapshot_id IS NULL AND decision_hash IS NULL`
  yield* sql`UPDATE authority_state SET effective = 'OBSERVE', kill_state = 'ACTIVE',
    reason = 'BLOCKED_STRATEGY_PROTOCOL_CUTOVER', version = version + 1,
    updated_at = greatest(clock_timestamp(), updated_at + interval '1 millisecond') WHERE maximum = 'PAPER'
      AND (effective = 'PAPER' OR reason = 'BLOCKED_STRATEGY_PROTOCOL_CUTOVER')`
  yield* sql`ALTER TABLE autonomous_cycles DROP CONSTRAINT autonomous_cycles_market_hours_check,
    ADD CONSTRAINT autonomous_cycles_market_hours_check CHECK (
      (execution_calendar_schema_version = 'bayn.alpaca-market-calendar-observation.v1'
        AND execution_calendar_source = 'alpaca-v2-calendar' AND state NOT IN ('PENDING','ACTIVE')) OR
      (execution_calendar_schema_version = 'bayn.alpaca-market-calendar-observation.v2'
        AND execution_calendar_source = 'alpaca-v2-calendar') OR
      (execution_calendar_schema_version = 'bayn.continuous-market-hours.v1'
        AND execution_calendar_source = 'alpaca-crypto-us'
        AND execution_close_at - execution_open_at = interval '64 minutes'
        AND submission_cutoff_at - submission_open_at = interval '1 minute')) NOT VALID`
  yield* sql`ALTER TABLE authority_generations
    DROP CONSTRAINT authority_generations_strategy_parameter_schema_version_check,
    DROP CONSTRAINT authority_generations_strategy_contract_check`
  yield* sql`ALTER TABLE authority_generations
    ADD CONSTRAINT authority_generations_strategy_parameter_schema_version_check CHECK (
      strategy_parameter_schema_version = 'bayn.jev.protocol.v21'
    ) NOT VALID,
    ADD CONSTRAINT authority_generations_strategy_contract_check CHECK (
      ((maximum = 'OBSERVE' AND strategy_name IS NULL AND strategy_parameter_schema_version IS NULL)
      OR (maximum = 'PAPER' AND strategy_name = 'jev'
        AND strategy_parameter_schema_version = 'bayn.jev.protocol.v21')) IS TRUE
    ) NOT VALID`
  yield* sql`ALTER TABLE native_protection_cancel_commands
    DROP CONSTRAINT native_protection_cancel_commands_exit_target_check,
    ADD CONSTRAINT native_protection_cancel_commands_exit_target_check
      CHECK (exit_target IS NULL OR (jsonb_typeof(exit_target) = 'object'
        AND exit_target ->> 'schemaVersion' = 'bayn.jev-exit-target.v6')) NOT VALID`
  yield* sql`DO $market_horizons$ DECLARE definition text; BEGIN
    definition := pg_get_functiondef('enforce_strategy_protection_plan()'::regprocedure);
    IF position('bayn.jev-entry-target.v6' in definition) = 0 THEN
      RAISE EXCEPTION 'expected the previous entry-bound protection guard' USING ERRCODE = '55000';
    END IF;
    EXECUTE replace(definition, 'bayn.jev-entry-target.v6', 'bayn.jev-entry-target.v7');
    definition := pg_get_functiondef('enforce_jev_exit_commit_deadline()'::regprocedure);
    IF position('= ''bayn.jev-exit-target.v5''' in definition) = 0 THEN
      RAISE EXCEPTION 'expected the previous exit commitment guard' USING ERRCODE = '55000';
    END IF;
    definition := replace(definition, '''bayn.jev-exit-target.v4''', '''bayn.jev-exit-target.v4'', ''bayn.jev-exit-target.v5''');
    EXECUTE replace(definition, '= ''bayn.jev-exit-target.v5''', '= ''bayn.jev-exit-target.v6''');
  END $market_horizons$`
})
