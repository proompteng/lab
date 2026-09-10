import { Effect } from 'effect'
import { SqlClient } from 'effect/unstable/sql'

const immutableTables = [
  'broker_events',
  'account_snapshots',
  'positions',
  'orders',
  'fills',
  'broker_errors',
  'rate_limits',
  'risk_decisions',
  'accounting_receipts',
  'valuations',
  'reconciliations',
] as const

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient

  yield* sql`
    CREATE TABLE intents (
      intent_id text PRIMARY KEY CHECK (intent_id ~ '^[0-9a-f]{64}$'),
      schema_version text NOT NULL CHECK (schema_version = 'bayn.paper-intent.v1'),
      risk_decision_id text CHECK (risk_decision_id ~ '^[0-9a-f]{64}$'),
      account_id text NOT NULL CHECK (length(account_id) > 0 AND account_id = btrim(account_id)),
      client_order_id text NOT NULL CHECK (length(client_order_id) > 0 AND client_order_id = btrim(client_order_id)),
      symbol text NOT NULL CHECK (symbol ~ '^[A-Z][A-Z0-9.-]{0,15}$'),
      side text NOT NULL CHECK (side IN ('BUY', 'SELL')),
      order_type text NOT NULL CHECK (order_type IN ('MARKET', 'LIMIT')),
      time_in_force text NOT NULL CHECK (time_in_force IN ('DAY', 'GTC', 'IOC', 'FOK')),
      quantity_micros numeric(39, 0) NOT NULL CHECK (
        quantity_micros > 0
        AND quantity_micros <= 340282366920938463463374607431768211455
      ),
      notional_limit_micros numeric(39, 0) NOT NULL CHECK (
        notional_limit_micros > 0
        AND notional_limit_micros <= 340282366920938463463374607431768211455
      ),
      state text NOT NULL CHECK (
        state IN ('PLANNED', 'APPROVED', 'IO_STARTED', 'ACKNOWLEDGED', 'UNKNOWN', 'TERMINAL', 'RECOVERED')
      ),
      terminal_outcome text CHECK (
        terminal_outcome IN ('FILLED', 'CANCELED', 'EXPIRED', 'REJECTED', 'BLOCKED')
      ),
      state_version bigint NOT NULL DEFAULT 1 CHECK (state_version > 0),
      created_at timestamptz NOT NULL,
      updated_at timestamptz NOT NULL,
      UNIQUE (intent_id, account_id),
      UNIQUE (account_id, client_order_id),
      CHECK (updated_at >= created_at),
      CHECK (
        (state = 'PLANNED' AND risk_decision_id IS NULL)
        OR (state <> 'PLANNED' AND risk_decision_id IS NOT NULL)
      ),
      CHECK (
        (state = 'TERMINAL' AND terminal_outcome IS NOT NULL)
        OR (state <> 'TERMINAL' AND terminal_outcome IS NULL)
      )
    )
  `

  yield* sql`
    CREATE TABLE broker_events (
      event_id text PRIMARY KEY CHECK (event_id ~ '^[0-9a-f]{64}$'),
      schema_version text NOT NULL CHECK (schema_version = 'bayn.paper-broker-event.v1'),
      content_hash text NOT NULL CHECK (content_hash ~ '^[0-9a-f]{64}$'),
      event_kind text NOT NULL CHECK (event_kind IN ('ACCOUNT', 'POSITION', 'ORDER', 'FILL', 'ERROR', 'RATE_LIMIT')),
      broker text NOT NULL CHECK (broker = 'ALPACA'),
      account_id text NOT NULL CHECK (length(account_id) > 0 AND account_id = btrim(account_id)),
      source_event_id text NOT NULL CHECK (
        length(source_event_id) > 0 AND source_event_id = btrim(source_event_id)
      ),
      source_sequence numeric(20, 0) NOT NULL CHECK (
        source_sequence >= 0 AND source_sequence <= 18446744073709551615
      ),
      occurred_at timestamptz NOT NULL,
      observed_at timestamptz NOT NULL,
      UNIQUE (broker, account_id, source_event_id),
      UNIQUE (broker, account_id, source_sequence),
      UNIQUE (event_id, account_id, event_kind),
      CHECK (observed_at >= occurred_at)
    )
  `

  yield* sql`
    CREATE TABLE account_snapshots (
      event_id text PRIMARY KEY,
      account_id text NOT NULL,
      event_kind text GENERATED ALWAYS AS ('ACCOUNT') STORED,
      schema_version text NOT NULL CHECK (schema_version = 'bayn.paper-account-snapshot.v1'),
      status text NOT NULL CHECK (status IN ('ACTIVE', 'RESTRICTED', 'CLOSED')),
      currency text NOT NULL CHECK (currency = 'USD'),
      cash_micros numeric(39, 0) NOT NULL CHECK (
        cash_micros BETWEEN -170141183460469231731687303715884105728
        AND 170141183460469231731687303715884105727
      ),
      equity_micros numeric(39, 0) NOT NULL CHECK (
        equity_micros BETWEEN -170141183460469231731687303715884105728
        AND 170141183460469231731687303715884105727
      ),
      buying_power_micros numeric(39, 0) NOT NULL CHECK (
        buying_power_micros BETWEEN -170141183460469231731687303715884105728
        AND 170141183460469231731687303715884105727
      ),
      FOREIGN KEY (event_id, account_id, event_kind)
        REFERENCES broker_events(event_id, account_id, event_kind) ON DELETE RESTRICT
    )
  `

  yield* sql`
    CREATE TABLE positions (
      event_id text PRIMARY KEY,
      account_id text NOT NULL,
      event_kind text GENERATED ALWAYS AS ('POSITION') STORED,
      schema_version text NOT NULL CHECK (schema_version = 'bayn.paper-position.v1'),
      symbol text NOT NULL CHECK (symbol ~ '^[A-Z][A-Z0-9.-]{0,15}$'),
      quantity_micros numeric(39, 0) NOT NULL CHECK (
        quantity_micros BETWEEN -170141183460469231731687303715884105728
        AND 170141183460469231731687303715884105727
      ),
      average_entry_price_micros numeric(39, 0) NOT NULL CHECK (
        average_entry_price_micros >= 0
        AND average_entry_price_micros <= 340282366920938463463374607431768211455
      ),
      market_price_micros numeric(39, 0) NOT NULL CHECK (
        market_price_micros >= 0
        AND market_price_micros <= 340282366920938463463374607431768211455
      ),
      market_value_micros numeric(39, 0) NOT NULL CHECK (
        market_value_micros BETWEEN -170141183460469231731687303715884105728
        AND 170141183460469231731687303715884105727
      ),
      unrealized_pnl_micros numeric(39, 0) NOT NULL CHECK (
        unrealized_pnl_micros BETWEEN -170141183460469231731687303715884105728
        AND 170141183460469231731687303715884105727
      ),
      FOREIGN KEY (event_id, account_id, event_kind)
        REFERENCES broker_events(event_id, account_id, event_kind) ON DELETE RESTRICT
    )
  `

  yield* sql`
    CREATE TABLE orders (
      event_id text PRIMARY KEY,
      account_id text NOT NULL,
      event_kind text GENERATED ALWAYS AS ('ORDER') STORED,
      schema_version text NOT NULL CHECK (schema_version = 'bayn.paper-order.v1'),
      broker_order_id text NOT NULL CHECK (
        length(broker_order_id) > 0 AND broker_order_id = btrim(broker_order_id)
      ),
      client_order_id text NOT NULL CHECK (
        length(client_order_id) > 0 AND client_order_id = btrim(client_order_id)
      ),
      intent_id text,
      symbol text NOT NULL CHECK (symbol ~ '^[A-Z][A-Z0-9.-]{0,15}$'),
      side text NOT NULL CHECK (side IN ('BUY', 'SELL')),
      order_type text NOT NULL CHECK (order_type IN ('MARKET', 'LIMIT')),
      time_in_force text NOT NULL CHECK (time_in_force IN ('DAY', 'GTC', 'IOC', 'FOK')),
      quantity_micros numeric(39, 0) NOT NULL CHECK (
        quantity_micros > 0
        AND quantity_micros <= 340282366920938463463374607431768211455
      ),
      filled_quantity_micros numeric(39, 0) NOT NULL CHECK (
        filled_quantity_micros >= 0
        AND filled_quantity_micros <= quantity_micros
      ),
      limit_price_micros numeric(39, 0) CHECK (
        limit_price_micros > 0
        AND limit_price_micros <= 340282366920938463463374607431768211455
      ),
      status text NOT NULL CHECK (
        status IN ('NEW', 'PARTIALLY_FILLED', 'FILLED', 'CANCELED', 'EXPIRED', 'REJECTED', 'PENDING')
      ),
      CHECK (
        (order_type = 'LIMIT' AND limit_price_micros IS NOT NULL)
        OR (order_type = 'MARKET' AND limit_price_micros IS NULL)
      ),
      CHECK (
        (status = 'FILLED' AND filled_quantity_micros = quantity_micros)
        OR (status = 'PARTIALLY_FILLED' AND filled_quantity_micros > 0 AND filled_quantity_micros < quantity_micros)
        OR (status IN ('NEW', 'PENDING') AND filled_quantity_micros = 0)
        OR (status IN ('CANCELED', 'EXPIRED', 'REJECTED') AND filled_quantity_micros < quantity_micros)
      ),
      FOREIGN KEY (event_id, account_id, event_kind)
        REFERENCES broker_events(event_id, account_id, event_kind) ON DELETE RESTRICT,
      FOREIGN KEY (intent_id, account_id)
        REFERENCES intents(intent_id, account_id) ON DELETE RESTRICT
    )
  `

  yield* sql`CREATE INDEX orders_account_broker_order_idx ON orders(account_id, broker_order_id)`
  yield* sql`CREATE INDEX orders_account_client_order_idx ON orders(account_id, client_order_id)`

  yield* sql`
    CREATE TABLE fills (
      event_id text PRIMARY KEY,
      account_id text NOT NULL,
      event_kind text GENERATED ALWAYS AS ('FILL') STORED,
      schema_version text NOT NULL CHECK (schema_version = 'bayn.paper-fill.v1'),
      fill_id text NOT NULL UNIQUE CHECK (length(fill_id) > 0 AND fill_id = btrim(fill_id)),
      broker_order_id text NOT NULL CHECK (
        length(broker_order_id) > 0 AND broker_order_id = btrim(broker_order_id)
      ),
      client_order_id text NOT NULL CHECK (
        length(client_order_id) > 0 AND client_order_id = btrim(client_order_id)
      ),
      intent_id text,
      symbol text NOT NULL CHECK (symbol ~ '^[A-Z][A-Z0-9.-]{0,15}$'),
      side text NOT NULL CHECK (side IN ('BUY', 'SELL')),
      quantity_micros numeric(39, 0) NOT NULL CHECK (
        quantity_micros > 0
        AND quantity_micros <= 340282366920938463463374607431768211455
      ),
      price_micros numeric(39, 0) NOT NULL CHECK (
        price_micros > 0
        AND price_micros <= 340282366920938463463374607431768211455
      ),
      fee_micros numeric(39, 0) NOT NULL CHECK (
        fee_micros >= 0
        AND fee_micros <= 340282366920938463463374607431768211455
      ),
      FOREIGN KEY (event_id, account_id, event_kind)
        REFERENCES broker_events(event_id, account_id, event_kind) ON DELETE RESTRICT,
      FOREIGN KEY (intent_id, account_id)
        REFERENCES intents(intent_id, account_id) ON DELETE RESTRICT
    )
  `

  yield* sql`
    CREATE TABLE broker_errors (
      event_id text PRIMARY KEY,
      account_id text NOT NULL,
      event_kind text GENERATED ALWAYS AS ('ERROR') STORED,
      schema_version text NOT NULL CHECK (schema_version = 'bayn.paper-broker-error.v1'),
      request_id text NOT NULL CHECK (length(request_id) > 0 AND request_id = btrim(request_id)),
      code text NOT NULL CHECK (length(code) > 0 AND code = btrim(code)),
      message text NOT NULL CHECK (length(message) > 0 AND message = btrim(message)),
      retryable boolean NOT NULL,
      mutation_outcome text NOT NULL CHECK (mutation_outcome IN ('KNOWN', 'UNKNOWN')),
      FOREIGN KEY (event_id, account_id, event_kind)
        REFERENCES broker_events(event_id, account_id, event_kind) ON DELETE RESTRICT
    )
  `

  yield* sql`
    CREATE TABLE rate_limits (
      event_id text PRIMARY KEY,
      account_id text NOT NULL,
      event_kind text GENERATED ALWAYS AS ('RATE_LIMIT') STORED,
      schema_version text NOT NULL CHECK (schema_version = 'bayn.paper-rate-limit.v1'),
      request_limit numeric(20, 0) NOT NULL CHECK (
        request_limit >= 0 AND request_limit <= 18446744073709551615
      ),
      remaining numeric(20, 0) NOT NULL CHECK (remaining >= 0 AND remaining <= request_limit),
      resets_at timestamptz NOT NULL,
      FOREIGN KEY (event_id, account_id, event_kind)
        REFERENCES broker_events(event_id, account_id, event_kind) ON DELETE RESTRICT
    )
  `

  yield* sql`
    CREATE FUNCTION text_array_is_unique(items text[])
    RETURNS boolean
    LANGUAGE sql
    IMMUTABLE
    STRICT
    AS $function$
      SELECT cardinality(items) = count(DISTINCT item)
      FROM unnest(items) AS item
    $function$
  `

  yield* sql`
    CREATE TABLE risk_decisions (
      decision_id text PRIMARY KEY CHECK (decision_id ~ '^[0-9a-f]{64}$'),
      schema_version text NOT NULL CHECK (schema_version = 'bayn.paper-risk-decision.v1'),
      input_hash text NOT NULL CHECK (input_hash ~ '^[0-9a-f]{64}$'),
      intent_id text NOT NULL UNIQUE REFERENCES intents(intent_id) ON DELETE RESTRICT,
      policy_hash text NOT NULL CHECK (policy_hash ~ '^[0-9a-f]{64}$'),
      outcome text NOT NULL CHECK (outcome IN ('APPROVED', 'BLOCKED')),
      reason_codes text[] NOT NULL CHECK (
        array_ndims(reason_codes) = 1
        AND array_position(reason_codes, '') IS NULL
        AND array_position(reason_codes, NULL) IS NULL
      ),
      decided_at timestamptz NOT NULL,
      expires_at timestamptz NOT NULL,
      UNIQUE (decision_id, intent_id),
      CHECK (expires_at > decided_at),
      CHECK (
        (outcome = 'APPROVED' AND cardinality(reason_codes) = 0)
        OR (outcome = 'BLOCKED' AND cardinality(reason_codes) > 0)
      ),
      CHECK (text_array_is_unique(reason_codes))
    )
  `

  yield* sql`
    ALTER TABLE intents
    ADD CONSTRAINT intents_risk_decision_fk
    FOREIGN KEY (risk_decision_id, intent_id) REFERENCES risk_decisions(decision_id, intent_id)
    ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED
  `

  yield* sql`
    CREATE FUNCTION numeric_array_is_strictly_ascending(items numeric[])
    RETURNS boolean
    LANGUAGE sql
    IMMUTABLE
    STRICT
    AS $function$
      SELECT COALESCE(bool_and(items[index] < items[index + 1]), true)
      FROM generate_subscripts(items, 1) AS index
      WHERE index < array_upper(items, 1)
    $function$
  `

  yield* sql`
    CREATE TABLE accounting_receipts (
      receipt_id text PRIMARY KEY CHECK (receipt_id ~ '^[0-9a-f]{64}$'),
      schema_version text NOT NULL CHECK (schema_version = 'bayn.paper-accounting-receipt.v1'),
      intent_id text REFERENCES intents(intent_id) ON DELETE RESTRICT,
      broker_event_id text NOT NULL REFERENCES broker_events(event_id) ON DELETE RESTRICT,
      tigerbeetle_cluster_id numeric(39, 0) NOT NULL CHECK (
        tigerbeetle_cluster_id > 0
        AND tigerbeetle_cluster_id <= 340282366920938463463374607431768211455
      ),
      tigerbeetle_ledger bigint NOT NULL CHECK (tigerbeetle_ledger BETWEEN 1 AND 4294967295),
      account_ids numeric(39, 0)[] NOT NULL CHECK (
        array_ndims(account_ids) = 1
        AND array_lower(account_ids, 1) = 1
        AND cardinality(account_ids) >= 2
        AND array_position(account_ids, NULL) IS NULL
        AND numeric_array_is_strictly_ascending(account_ids)
        AND account_ids[1] > 0
        AND account_ids[cardinality(account_ids)] <= 340282366920938463463374607431768211455
      ),
      transfer_ids numeric(39, 0)[] NOT NULL CHECK (
        array_ndims(transfer_ids) = 1
        AND array_lower(transfer_ids, 1) = 1
        AND cardinality(transfer_ids) >= 1
        AND array_position(transfer_ids, NULL) IS NULL
        AND numeric_array_is_strictly_ascending(transfer_ids)
        AND transfer_ids[1] > 0
        AND transfer_ids[cardinality(transfer_ids)] <= 340282366920938463463374607431768211455
      ),
      debit_micros numeric(39, 0) NOT NULL CHECK (
        debit_micros > 0
        AND debit_micros <= 340282366920938463463374607431768211455
      ),
      credit_micros numeric(39, 0) NOT NULL CHECK (
        credit_micros > 0
        AND credit_micros <= 340282366920938463463374607431768211455
      ),
      content_hash text NOT NULL CHECK (content_hash ~ '^[0-9a-f]{64}$'),
      recorded_at timestamptz NOT NULL,
      CHECK (debit_micros = credit_micros)
    )
  `

  yield* sql`
    CREATE TABLE valuations (
      valuation_id text PRIMARY KEY CHECK (valuation_id ~ '^[0-9a-f]{64}$'),
      schema_version text NOT NULL CHECK (schema_version = 'bayn.paper-valuation.v1'),
      account_id text NOT NULL CHECK (length(account_id) > 0 AND account_id = btrim(account_id)),
      source_hash text NOT NULL CHECK (source_hash ~ '^[0-9a-f]{64}$'),
      cash_micros numeric(39, 0) NOT NULL CHECK (
        cash_micros BETWEEN -170141183460469231731687303715884105728
        AND 170141183460469231731687303715884105727
      ),
      long_market_value_micros numeric(39, 0) NOT NULL CHECK (
        long_market_value_micros >= 0
        AND long_market_value_micros <= 340282366920938463463374607431768211455
      ),
      short_market_value_micros numeric(39, 0) NOT NULL CHECK (
        short_market_value_micros BETWEEN -170141183460469231731687303715884105728
        AND 0
      ),
      equity_micros numeric(39, 0) NOT NULL CHECK (
        equity_micros BETWEEN -170141183460469231731687303715884105728
        AND 170141183460469231731687303715884105727
      ),
      as_of timestamptz NOT NULL,
      CHECK (equity_micros = cash_micros + long_market_value_micros + short_market_value_micros)
    )
  `

  yield* sql`
    CREATE TABLE reconciliations (
      reconciliation_id text PRIMARY KEY CHECK (reconciliation_id ~ '^[0-9a-f]{64}$'),
      schema_version text NOT NULL CHECK (schema_version = 'bayn.paper-reconciliation.v1'),
      account_id text NOT NULL CHECK (length(account_id) > 0 AND account_id = btrim(account_id)),
      expected_hash text NOT NULL CHECK (expected_hash ~ '^[0-9a-f]{64}$'),
      observed_hash text NOT NULL CHECK (observed_hash ~ '^[0-9a-f]{64}$'),
      content_hash text NOT NULL CHECK (content_hash ~ '^[0-9a-f]{64}$'),
      status text NOT NULL CHECK (status IN ('EXACT', 'DISCREPANCY')),
      discrepancies jsonb NOT NULL CHECK (jsonb_typeof(discrepancies) = 'array'),
      reconciled_at timestamptz NOT NULL,
      CHECK (
        (
          status = 'EXACT'
          AND expected_hash = observed_hash
          AND jsonb_array_length(discrepancies) = 0
        )
        OR (
          status = 'DISCREPANCY'
          AND expected_hash <> observed_hash
          AND jsonb_array_length(discrepancies) > 0
        )
      )
    )
  `

  yield* sql`
    CREATE TABLE authority_state (
      singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
      schema_version text NOT NULL CHECK (schema_version = 'bayn.paper-authority.v1'),
      generation_hash text NOT NULL CHECK (generation_hash ~ '^[0-9a-f]{64}$'),
      maximum text NOT NULL CHECK (maximum IN ('OBSERVE', 'PAPER')),
      effective text NOT NULL CHECK (effective IN ('OBSERVE', 'PAPER')),
      kill_state text NOT NULL CHECK (kill_state IN ('CLEAR', 'ACTIVE')),
      reason text CHECK (length(reason) > 0 AND reason = btrim(reason)),
      version bigint NOT NULL CHECK (version > 0),
      updated_at timestamptz NOT NULL,
      CHECK (maximum = 'PAPER' OR effective = 'OBSERVE'),
      CHECK (kill_state = 'CLEAR' OR effective = 'OBSERVE'),
      CHECK (
        (kill_state = 'ACTIVE' AND reason IS NOT NULL)
        OR (kill_state = 'CLEAR' AND reason IS NULL)
      )
    )
  `

  yield* sql`
    CREATE FUNCTION enforce_intent_transition()
    RETURNS trigger
    LANGUAGE plpgsql
    AS $function$
    DECLARE
      decision_outcome text;
      decision_decided_at timestamptz;
      decision_expires_at timestamptz;
    BEGIN
      IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'intents cannot be deleted' USING ERRCODE = '55000';
      END IF;

      IF TG_OP = 'INSERT' THEN
        IF NEW.state <> 'PLANNED'
          OR NEW.risk_decision_id IS NOT NULL
          OR NEW.terminal_outcome IS NOT NULL
          OR NEW.state_version <> 1
          OR NEW.updated_at <> NEW.created_at
        THEN
          RAISE EXCEPTION 'new intents must begin in PLANNED state' USING ERRCODE = '23514';
        END IF;
        RETURN NEW;
      END IF;

      IF (to_jsonb(OLD) - ARRAY['state', 'risk_decision_id', 'terminal_outcome', 'state_version', 'updated_at'])
        <> (to_jsonb(NEW) - ARRAY['state', 'risk_decision_id', 'terminal_outcome', 'state_version', 'updated_at'])
      THEN
        RAISE EXCEPTION 'intent immutable fields cannot change' USING ERRCODE = '55000';
      END IF;

      IF NEW.state_version <> OLD.state_version + 1 OR NEW.updated_at <= OLD.updated_at THEN
        RAISE EXCEPTION 'intent state version and time must advance' USING ERRCODE = '23514';
      END IF;

      IF OLD.state <> 'PLANNED' AND NEW.risk_decision_id IS DISTINCT FROM OLD.risk_decision_id THEN
        RAISE EXCEPTION 'intent risk decision cannot change after planning' USING ERRCODE = '55000';
      END IF;

      IF NOT (CASE OLD.state
        WHEN 'PLANNED' THEN NEW.state IN ('APPROVED', 'TERMINAL')
        WHEN 'APPROVED' THEN NEW.state IN ('IO_STARTED', 'TERMINAL')
        WHEN 'IO_STARTED' THEN NEW.state IN ('ACKNOWLEDGED', 'UNKNOWN', 'TERMINAL')
        WHEN 'ACKNOWLEDGED' THEN NEW.state = 'TERMINAL'
        WHEN 'UNKNOWN' THEN NEW.state = 'RECOVERED'
        WHEN 'RECOVERED' THEN NEW.state IN ('ACKNOWLEDGED', 'TERMINAL')
        WHEN 'TERMINAL' THEN false
        ELSE false
      END) THEN
        RAISE EXCEPTION 'invalid intent transition from % to %', OLD.state, NEW.state USING ERRCODE = '23514';
      END IF;

      IF NEW.state = 'TERMINAL' AND NOT (CASE OLD.state
        WHEN 'PLANNED' THEN NEW.terminal_outcome = 'BLOCKED'
        WHEN 'APPROVED' THEN NEW.terminal_outcome IN ('BLOCKED', 'CANCELED')
        WHEN 'IO_STARTED' THEN NEW.terminal_outcome IN ('FILLED', 'CANCELED', 'EXPIRED', 'REJECTED')
        WHEN 'ACKNOWLEDGED' THEN NEW.terminal_outcome IN ('FILLED', 'CANCELED', 'EXPIRED', 'REJECTED')
        WHEN 'RECOVERED' THEN NEW.terminal_outcome IN ('FILLED', 'CANCELED', 'EXPIRED', 'REJECTED')
        ELSE false
      END) THEN
        RAISE EXCEPTION 'invalid terminal outcome % from %', NEW.terminal_outcome, OLD.state USING ERRCODE = '23514';
      END IF;

      IF OLD.state = 'PLANNED' OR NEW.state = 'IO_STARTED' THEN
        SELECT outcome, decided_at, expires_at
        INTO decision_outcome, decision_decided_at, decision_expires_at
        FROM risk_decisions
        WHERE decision_id = NEW.risk_decision_id AND intent_id = NEW.intent_id;

        IF NOT FOUND THEN
          RAISE EXCEPTION 'intent transition requires its bound risk decision' USING ERRCODE = '23503';
        END IF;

        IF decision_decided_at > NEW.updated_at OR decision_expires_at <= NEW.updated_at THEN
          RAISE EXCEPTION 'intent transition requires a current risk decision' USING ERRCODE = '23514';
        END IF;

        IF NEW.state = 'TERMINAL' AND decision_outcome <> 'BLOCKED' THEN
          RAISE EXCEPTION 'blocked terminal intent requires a blocked risk decision' USING ERRCODE = '23514';
        END IF;

        IF NEW.state <> 'TERMINAL' AND decision_outcome <> 'APPROVED' THEN
          RAISE EXCEPTION 'broker I/O requires an approved risk decision' USING ERRCODE = '23514';
        END IF;
      END IF;

      RETURN NEW;
    END
    $function$
  `

  yield* sql`
    CREATE TRIGGER intents_transition_only
    BEFORE INSERT OR UPDATE OR DELETE ON intents
    FOR EACH ROW EXECUTE FUNCTION enforce_intent_transition()
  `
  yield* sql`
    CREATE TRIGGER intents_reject_truncate
    BEFORE TRUNCATE ON intents
    FOR EACH STATEMENT EXECUTE FUNCTION reject_evidence_mutation()
  `

  yield* sql`
    CREATE FUNCTION enforce_risk_decision_binding()
    RETURNS trigger
    LANGUAGE plpgsql
    AS $function$
    BEGIN
      IF NOT EXISTS (
        SELECT 1
        FROM intents
        WHERE intent_id = NEW.intent_id AND risk_decision_id = NEW.decision_id
      ) THEN
        RAISE EXCEPTION 'risk decision is not bound to its intent' USING ERRCODE = '23514';
      END IF;
      RETURN NEW;
    END
    $function$
  `

  yield* sql`
    CREATE CONSTRAINT TRIGGER risk_decision_binding
    AFTER INSERT ON risk_decisions
    DEFERRABLE INITIALLY DEFERRED
    FOR EACH ROW EXECUTE FUNCTION enforce_risk_decision_binding()
  `

  yield* sql`
    CREATE FUNCTION enforce_broker_event_payload()
    RETURNS trigger
    LANGUAGE plpgsql
    AS $function$
    DECLARE
      payload_count integer;
    BEGIN
      SELECT count(*) INTO payload_count
      FROM (
        SELECT event_id FROM account_snapshots WHERE event_id = NEW.event_id
        UNION ALL SELECT event_id FROM positions WHERE event_id = NEW.event_id
        UNION ALL SELECT event_id FROM orders WHERE event_id = NEW.event_id
        UNION ALL SELECT event_id FROM fills WHERE event_id = NEW.event_id
        UNION ALL SELECT event_id FROM broker_errors WHERE event_id = NEW.event_id
        UNION ALL SELECT event_id FROM rate_limits WHERE event_id = NEW.event_id
      ) AS payloads;

      IF payload_count <> 1 THEN
        RAISE EXCEPTION 'broker event % must have exactly one typed payload', NEW.event_id USING ERRCODE = '23514';
      END IF;
      RETURN NEW;
    END
    $function$
  `

  yield* sql`
    CREATE CONSTRAINT TRIGGER broker_event_payload
    AFTER INSERT ON broker_events
    DEFERRABLE INITIALLY DEFERRED
    FOR EACH ROW EXECUTE FUNCTION enforce_broker_event_payload()
  `

  yield* sql`
    CREATE FUNCTION enforce_authority_transition()
    RETURNS trigger
    LANGUAGE plpgsql
    AS $function$
    BEGIN
      IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'authority state cannot be deleted' USING ERRCODE = '55000';
      END IF;

      IF TG_OP = 'INSERT' THEN
        IF NEW.version <> 1 THEN
          RAISE EXCEPTION 'authority state must begin at version 1' USING ERRCODE = '23514';
        END IF;
        RETURN NEW;
      END IF;

      IF NEW.singleton <> OLD.singleton
        OR NEW.schema_version <> OLD.schema_version
        OR NEW.version <> OLD.version + 1
        OR NEW.updated_at <= OLD.updated_at
      THEN
        RAISE EXCEPTION 'invalid authority state version' USING ERRCODE = '23514';
      END IF;

      IF NEW.generation_hash = OLD.generation_hash THEN
        IF NEW.maximum <> OLD.maximum
          OR (OLD.effective = 'OBSERVE' AND NEW.effective = 'PAPER')
          OR (OLD.kill_state = 'ACTIVE' AND NEW.kill_state = 'CLEAR')
        THEN
          RAISE EXCEPTION 'authority can only decrease within a GitOps generation' USING ERRCODE = '23514';
        END IF;
      END IF;

      RETURN NEW;
    END
    $function$
  `

  yield* sql`
    CREATE TRIGGER authority_transition_only
    BEFORE INSERT OR UPDATE OR DELETE ON authority_state
    FOR EACH ROW EXECUTE FUNCTION enforce_authority_transition()
  `
  yield* sql`
    CREATE TRIGGER authority_reject_truncate
    BEFORE TRUNCATE ON authority_state
    FOR EACH STATEMENT EXECUTE FUNCTION reject_evidence_mutation()
  `

  for (const table of immutableTables) {
    yield* sql`
      CREATE TRIGGER ${sql(`${table}_append_only`)}
      BEFORE UPDATE OR DELETE ON ${sql(table)}
      FOR EACH ROW EXECUTE FUNCTION reject_evidence_mutation()
    `
    yield* sql`
      CREATE TRIGGER ${sql(`${table}_reject_truncate`)}
      BEFORE TRUNCATE ON ${sql(table)}
      FOR EACH STATEMENT EXECUTE FUNCTION reject_evidence_mutation()
    `
  }
})
