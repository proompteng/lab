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
        ) latest WHERE status IN ('NEW', 'PENDING', 'PARTIALLY_FILLED')
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
    THEN RAISE EXCEPTION 'strategy-native-protection cutover requires terminal mutation cycles, flat positions, settled orders, fresh exact reconciliation and complete accounting' USING ERRCODE = '55000'; END IF;
  END $cutover$`
  yield* sql`WITH cutover AS MATERIALIZED (SELECT clock_timestamp() AS at)
    UPDATE autonomous_cycles SET state = 'BLOCKED', terminal_reason = 'BLOCKED_AUTHORITY',
      state_version = state_version + 1, updated_at = greatest(cutover.at, updated_at), terminal_at = greatest(cutover.at, updated_at)
    FROM cutover WHERE state IN ('PENDING', 'ACTIVE') AND snapshot_id IS NULL AND decision_hash IS NULL`
  yield* sql`UPDATE authority_state SET effective = 'OBSERVE', kill_state = 'ACTIVE',
    reason = 'BLOCKED_STRATEGY_PROTOCOL_CUTOVER', version = version + 1,
    updated_at = greatest(clock_timestamp(), updated_at + interval '1 millisecond') WHERE maximum = 'PAPER'
      AND (effective = 'PAPER' OR reason = 'BLOCKED_STRATEGY_PROTOCOL_CUTOVER')`
  yield* sql`ALTER TABLE authority_generations
    DROP CONSTRAINT authority_generations_strategy_parameter_schema_version_check,
    DROP CONSTRAINT authority_generations_strategy_contract_check`
  yield* sql`ALTER TABLE authority_generations
    ADD CONSTRAINT authority_generations_strategy_parameter_schema_version_check CHECK (
      strategy_parameter_schema_version IN (
        'bayn.risk-balanced-trend.protocol.v3', 'bayn.risk-balanced-trend.protocol.v4', 'bayn.opening-drive.protocol.v2',
        'bayn.intraday-momentum.protocol.v1', 'bayn.intraday-momentum.protocol.v2', 'bayn.intraday-momentum.protocol.v3', 'bayn.jev.protocol.v14'
      )
    ) NOT VALID,
    ADD CONSTRAINT authority_generations_strategy_contract_check CHECK (
      (strategy_name IS NULL AND strategy_parameter_schema_version IS NULL)
      OR (strategy_name = 'risk-balanced-trend' AND strategy_parameter_schema_version IN ('bayn.risk-balanced-trend.protocol.v3', 'bayn.risk-balanced-trend.protocol.v4'))
      OR (strategy_name = 'opening-drive-momentum' AND strategy_parameter_schema_version = 'bayn.opening-drive.protocol.v2')
      OR (strategy_name = 'intraday-momentum' AND strategy_parameter_schema_version IN ('bayn.intraday-momentum.protocol.v1', 'bayn.intraday-momentum.protocol.v2', 'bayn.intraday-momentum.protocol.v3'))
      OR (strategy_name = 'jev' AND strategy_parameter_schema_version = 'bayn.jev.protocol.v14')
    ) NOT VALID`
  yield* sql`
    CREATE OR REPLACE FUNCTION enforce_jev_exit_commit_deadline() RETURNS trigger LANGUAGE plpgsql AS $function$
    DECLARE checked_at timestamptz; deadline_at timestamptz;
    BEGIN
      IF NEW.document #>> '{document,strategyDecision,schemaVersion}' IN ('bayn.jev-exit-target.v1', 'bayn.jev-exit-target.v2') THEN
        RAISE EXCEPTION 'retired Jev exit-target contract' USING ERRCODE = '23514';
      ELSIF NEW.document #>> '{document,strategyDecision,schemaVersion}' = 'bayn.jev-exit-target.v3' THEN
        checked_at := execution_account_commit_now(NEW.document #>> '{document,bindings,accountId}');
        deadline_at := (NEW.document #>> '{document,strategyDecision,commitDeadlineAt}')::timestamptz;
        IF deadline_at IS NULL OR checked_at < NEW.created_at OR checked_at >= deadline_at THEN
          RAISE EXCEPTION 'initial Jev exit evidence expired before transaction commitment' USING ERRCODE = '23514';
        END IF;
      END IF;
      RETURN NEW;
    END
    $function$
  `
  yield* sql`ALTER TABLE intents ADD COLUMN protection jsonb,
    DROP CONSTRAINT intents_schema_version_check,
    DROP CONSTRAINT intents_order_type_check,
    DROP CONSTRAINT intents_explicit_limit_terms_check,
    ADD CONSTRAINT intents_schema_version_check CHECK (schema_version = 'bayn.execution-intent.v5') NOT VALID,
    ADD CONSTRAINT intents_order_type_check CHECK (order_type IN ('LIMIT','STOP_LIMIT')) NOT VALID,
    ADD CONSTRAINT intents_explicit_limit_terms_check CHECK (COALESCE(
      limit_price_micros > 0 AND limit_price_micros <= 340282366920938463463374607431768211455
      AND notional_limit_micros = CASE WHEN side = 'BUY' THEN ceil(quantity_atoms * limit_price_micros / 1000000000)
        ELSE floor(quantity_atoms * limit_price_micros / 1000000000) END
      AND (order_type = 'STOP_LIMIT') = COALESCE(protection ->> '_tag' = 'StopLimit', false)
      AND time_in_force = CASE WHEN order_type = 'STOP_LIMIT' AND position('/' IN symbol) > 0 THEN 'GTC'
        WHEN position('/' IN symbol) > 0 THEN 'IOC' ELSE 'DAY' END
      AND (protection IS NULL OR jsonb_typeof(protection) = 'object'), false
    )) NOT VALID`
  yield* sql`ALTER TABLE orders ADD COLUMN stop_price_micros numeric(39,0), ADD COLUMN parent_broker_order_id text,
    DROP CONSTRAINT orders_order_type_check, DROP CONSTRAINT orders_type_price_check,
    ADD CONSTRAINT orders_order_type_check CHECK (order_type IN ('MARKET','LIMIT','STOP_LIMIT')),
    ADD CONSTRAINT orders_type_price_check CHECK (
      (order_type = 'MARKET' AND limit_price_micros IS NULL AND stop_price_micros IS NULL)
      OR (order_type = 'LIMIT' AND limit_price_micros IS NOT NULL AND stop_price_micros IS NULL AND notional_micros IS NULL)
      OR (order_type = 'STOP_LIMIT' AND limit_price_micros IS NOT NULL AND stop_price_micros > 0 AND notional_micros IS NULL)
    )`
  yield* sql`DO $completion$
    DECLARE
      definition text := pg_get_functiondef('paper_cycle_completion_evidence_matches(text,text,timestamptz)'::regprocedure);
      needle constant text := 'AND NOT (paper.ordered_intent_ids ? extra.intent_id)';
    BEGIN
      IF (length(definition) - length(replace(definition, needle, ''))) <> length(needle) THEN
        RAISE EXCEPTION 'expected one extra-intent completion guard' USING ERRCODE = '55000';
      END IF;
      IF (length(definition) - length(replace(definition, 'WHERE bound.ordered_intent_ids ?', ''))) <> 3 * length('WHERE bound.ordered_intent_ids ?') THEN
        RAISE EXCEPTION 'expected three cycle effect cutoffs' USING ERRCODE = '55000';
      END IF;
      definition := replace(definition, 'WHERE bound.ordered_intent_ids ? intent.intent_id',
        'WHERE intent.cycle_id = bound.cycle_id');
      definition := replace(definition, 'WHERE bound.ordered_intent_ids ? event.intent_id',
        'WHERE EXISTS (SELECT 1 FROM intents effect WHERE effect.intent_id = event.intent_id AND effect.cycle_id = bound.cycle_id)');
      definition := replace(definition, 'WHERE bound.ordered_intent_ids ? broker_order.intent_id',
        'WHERE EXISTS (SELECT 1 FROM intents effect WHERE effect.intent_id = broker_order.intent_id AND effect.cycle_id = bound.cycle_id)');
      EXECUTE replace(definition, needle, needle || $guard$
        AND NOT COALESCE(extra.state = 'TERMINAL' AND extra.protection ->> '_tag' IN ('Oco','StopLimit')
          AND extra.protection ->> 'entryDecisionHash' = decision.document ->> 'contentHash', false)
      $guard$);
    END $completion$`
  yield* sql`CREATE TABLE native_protection_cancel_commands (
    intent_id text NOT NULL, account_id text NOT NULL, broker_order_id text NOT NULL, requested_at timestamptz NOT NULL,
    PRIMARY KEY (intent_id, broker_order_id, requested_at),
    FOREIGN KEY (intent_id, account_id) REFERENCES intents(intent_id, account_id) ON DELETE RESTRICT
  )`
  yield* sql`CREATE TRIGGER native_protection_cancel_commands_append_only BEFORE UPDATE OR DELETE ON native_protection_cancel_commands
    FOR EACH ROW EXECUTE FUNCTION reject_evidence_mutation()`
  yield* sql`CREATE TRIGGER native_protection_cancel_commands_no_truncate BEFORE TRUNCATE ON native_protection_cancel_commands
    FOR EACH STATEMENT EXECUTE FUNCTION reject_evidence_mutation()`
  yield* sql`CREATE FUNCTION enforce_strategy_protection_plan() RETURNS trigger LANGUAGE plpgsql AS $function$
    DECLARE root jsonb; plan jsonb; tag text;
    BEGIN
      IF NEW.protection IS NULL THEN RETURN NEW; END IF;
      tag := NEW.protection ->> '_tag';
      SELECT d.document INTO root FROM autonomous_cycle_shadow_decisions d
        WHERE d.cycle_id = NEW.cycle_id AND (
          (tag = 'Bracket' AND d.document -> 'orderedIntentIds' ? NEW.intent_id)
          OR (tag IN ('Oco','StopLimit') AND d.decision_hash = NEW.protection ->> 'entryDecisionHash')
        );
      plan := root #> ARRAY['strategyDecision','exitPolicy','plans',NEW.symbol];
      IF NOT COALESCE(
        root #>> '{strategyDecision,schemaVersion}' = 'bayn.jev-entry-target.v3'
        AND root #>> '{bindings,accountId}' = NEW.account_id AND NEW.strategy_name = 'jev'
        AND root #>> '{bindings,strategyDecisionHash}' = NEW.decision_hash
        AND root #>> '{bindings,policyHash}' = NEW.policy_hash
        AND NEW.quantity_atoms <= (plan ->> 'maximumQuantityAtoms')::numeric
        AND (root ->> 'createdAt')::timestamptz <= NEW.created_at
        AND NEW.protection ->> 'stopPriceMicros' = plan #>> '{levels,stopPriceMicros}'
        AND CASE WHEN tag = 'StopLimit' THEN
          NEW.side = 'SELL' AND NEW.order_type = 'STOP_LIMIT' AND NEW.limit_price_micros = (plan #>> '{levels,stopLimitPriceMicros}')::numeric
        ELSE
          tag IN ('Bracket','Oco') AND position('/' IN NEW.symbol) = 0 AND mod(NEW.quantity_atoms,1000000000) = 0
          AND NEW.order_type = 'LIMIT' AND NEW.time_in_force = 'DAY'
          AND NEW.protection ->> 'stopLimitPriceMicros' = plan #>> '{levels,stopLimitPriceMicros}'
          AND NEW.protection ->> 'profitLimitPriceMicros' = plan #>> '{levels,profitLimitPriceMicros}'
          AND CASE WHEN tag = 'Bracket' THEN NEW.side = 'BUY' AND NEW.limit_price_micros <= (plan #>> '{levels,maximumEntryPriceMicros}')::numeric
            ELSE NEW.side = 'SELL' AND NEW.limit_price_micros = (plan #>> '{levels,profitLimitPriceMicros}')::numeric END
        END, false
      ) THEN RAISE EXCEPTION 'native protection must bind the immutable pre-entry strategy plan' USING ERRCODE = '23514'; END IF;
      RETURN NEW;
    END $function$`
  yield* sql`CREATE TRIGGER intents_strategy_protection_plan BEFORE INSERT ON intents
    FOR EACH ROW EXECUTE FUNCTION enforce_strategy_protection_plan()`
})
