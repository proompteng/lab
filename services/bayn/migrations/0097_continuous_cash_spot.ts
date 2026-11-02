import { Data, Effect, Schema } from 'effect'
import { SqlClient } from 'effect/sql'
import { quantityToDecimal } from '../src/quantity'
import { canonicalHashV1Result } from '../src/hash'
import { AccountingTransactionRowSchema, accountingTransactionFromRow } from '../src/db/accounting-rows'

class CashSpotCutoverError extends Data.TaggedError('CashSpotCutoverError')<{ readonly message: string }> {}

const projectionTables = [
  ['intents', 'intent_id'],
  ['positions', 'event_id'],
  ['orders', 'event_id'],
  ['fills', 'event_id'],
  ['accounting_transactions', 'transaction_id'],
  ['broker_events', 'event_id'],
  ['autonomous_cycles', 'cycle_id'],
  ['mutation_events', 'event_id'],
] as const
const quantityColumns = [
  ['intents', 'quantity_micros'],
  ['positions', 'quantity_micros'],
  ['orders', 'quantity_micros'],
  ['orders', 'filled_quantity_micros'],
  ['fills', 'quantity_micros'],
  ['accounting_transactions', 'quantity_micros'],
  ['accounting_transactions', 'quantity_delta_micros'],
] as const

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  // Share the execution writer fence. A transmitted but unsettled order prevents the cutover.
  yield* sql`SELECT pg_advisory_xact_lock(1111578958, 1)`
  yield* sql`LOCK TABLE intents, mutation_events, autonomous_cycles, authority_state, broker_events, fills, orders, positions, accounting_transactions IN ACCESS EXCLUSIVE MODE`
  yield* sql`
    DO $cutover$ BEGIN
      IF EXISTS (SELECT 1 FROM autonomous_cycles AS c WHERE state IN ('PENDING', 'ACTIVE') AND (snapshot_id IS NOT NULL OR decision_hash IS NOT NULL OR EXISTS (SELECT 1 FROM intents AS i WHERE i.cycle_id = c.cycle_id)))
        OR EXISTS (SELECT 1 FROM intents WHERE state <> 'TERMINAL')
        OR EXISTS (SELECT 1 FROM accounting_transactions AS t LEFT JOIN accounting_receipts AS r USING (broker_event_id) WHERE r.receipt_id IS NULL)
        OR EXISTS (SELECT 1 FROM fills AS f LEFT JOIN accounting_transactions AS t ON t.broker_event_id = f.event_id WHERE t.transaction_id IS NULL)
        OR EXISTS (SELECT 1 FROM accounting_transactions GROUP BY account_id, symbol HAVING sum(quantity_delta_micros) <> 0)
        OR EXISTS (
          SELECT 1 FROM (SELECT DISTINCT ON (account_id) position_count FROM position_snapshots ORDER BY account_id, observed_at DESC, snapshot_id DESC) AS latest WHERE position_count <> 0
        )
        OR EXISTS (
          SELECT 1 FROM (SELECT DISTINCT ON (o.account_id, o.broker_order_id) o.status FROM orders AS o JOIN broker_events AS e USING (event_id) ORDER BY o.account_id, o.broker_order_id, e.source_sequence DESC) AS latest WHERE status IN ('NEW', 'PENDING', 'PARTIALLY_FILLED')
        )
      THEN RAISE EXCEPTION 'continuous cash-spot migration requires terminal cycles, flat reconciled positions, settled orders and complete accounting' USING ERRCODE = '55000'; END IF;
    END $cutover$
  `
  yield* sql`
    CREATE TABLE execution_unit_cutover_archive (
      table_name text NOT NULL, row_id text NOT NULL, original_record jsonb NOT NULL,
      original_record_hash text NOT NULL CHECK (original_record_hash ~ '^[0-9a-f]{64}$'),
      PRIMARY KEY (table_name, row_id)
    )
  `
  for (const [table, key] of projectionTables) {
    yield* sql.unsafe(
      `INSERT INTO execution_unit_cutover_archive SELECT '${table}', ${key}, to_jsonb(original), encode(sha256(convert_to(to_jsonb(original)::text, 'UTF8')), 'hex') FROM ${table} AS original`,
    )
    yield* sql.unsafe(`ALTER TABLE ${table} DISABLE TRIGGER USER`)
  }
  yield* sql`WITH cutover AS MATERIALIZED (SELECT clock_timestamp() AS at) UPDATE autonomous_cycles SET state = 'BLOCKED', terminal_reason = 'BLOCKED_AUTHORITY',
    state_version = state_version + 1, updated_at = greatest(cutover.at, updated_at), terminal_at = greatest(cutover.at, updated_at)
    FROM cutover WHERE state IN ('PENDING', 'ACTIVE') AND snapshot_id IS NULL AND decision_hash IS NULL`
  yield* sql`CREATE TRIGGER execution_unit_cutover_archive_append_only BEFORE UPDATE OR DELETE ON execution_unit_cutover_archive FOR EACH ROW EXECUTE FUNCTION reject_evidence_mutation()`
  yield* sql`CREATE TRIGGER execution_unit_cutover_archive_reject_truncate BEFORE TRUNCATE ON execution_unit_cutover_archive FOR EACH STATEMENT EXECUTE FUNCTION reject_evidence_mutation()`
  for (const [table, original] of quantityColumns) {
    const current = original.replace('micros', 'atoms')
    yield* sql.unsafe(`ALTER TABLE ${table} RENAME COLUMN ${original} TO ${current}`)
  }
  for (const table of [...new Set(quantityColumns.map(([table]) => table))]) {
    const assignments = quantityColumns
      .filter(([owner]) => owner === table)
      .map(([, original]) => {
        const current = original.replace('micros', 'atoms')
        return `${current} = ${current} * 1000`
      })
      .join(', ')
    yield* sql.unsafe(`UPDATE ${table} SET ${assignments}`)
  }
  for (const table of ['intents', 'positions', 'orders', 'fills', 'accounting_transactions']) {
    yield* sql.unsafe(
      `ALTER TABLE ${table} DROP CONSTRAINT ${table}_symbol_check, ADD CONSTRAINT ${table}_symbol_check CHECK (symbol ~ '^([A-Z][A-Z0-9.-]{0,15}|(BTC|ETH|SOL)/USD)$' AND symbol NOT IN ('BTCUSD','ETHUSD','SOLUSD'))`,
    )
  }
  for (const table of ['fills', 'accounting_transactions']) {
    yield* sql.unsafe(`ALTER TABLE ${table} RENAME COLUMN price_micros TO price_atoms`)
    yield* sql.unsafe(`UPDATE ${table} SET price_atoms = price_atoms * 1000`)
  }
  yield* sql`ALTER TABLE fills DROP CONSTRAINT fills_schema_version_check`
  yield* sql`UPDATE fills SET schema_version = 'bayn.fill.v2'`
  yield* sql`ALTER TABLE fills ADD CONSTRAINT fills_schema_version_check CHECK (schema_version = 'bayn.fill.v2')`
  yield* sql`ALTER TABLE accounting_transactions DROP CONSTRAINT accounting_transactions_schema_version_check`
  yield* sql`UPDATE accounting_transactions SET schema_version = 'bayn.accounting-transaction.v2'`
  yield* sql`ALTER TABLE accounting_transactions ADD CONSTRAINT accounting_transactions_schema_version_check CHECK (schema_version = 'bayn.accounting-transaction.v2')`
  // The legacy representation check also binds the schema version. Replace it before
  // converting retained orders, while keeping the quantity/notional invariant enforced.
  yield* sql`ALTER TABLE orders DROP CONSTRAINT orders_request_representation_check, ADD CONSTRAINT orders_request_representation_check CHECK (
    (quantity_atoms IS NOT NULL AND notional_micros IS NULL) OR (quantity_atoms IS NULL AND notional_micros IS NOT NULL AND order_type = 'MARKET'))`
  yield* sql`ALTER TABLE orders DROP CONSTRAINT orders_schema_version_check`
  yield* sql`UPDATE orders SET schema_version = 'bayn.order.v3'`
  yield* sql`ALTER TABLE orders ADD CONSTRAINT orders_schema_version_check CHECK (schema_version = 'bayn.order.v3')`
  yield* sql`ALTER TABLE broker_events ADD COLUMN normalized_content_hash text CHECK (normalized_content_hash ~ '^[0-9a-f]{64}$')`
  yield* sql`UPDATE broker_events SET normalized_content_hash = content_hash`

  const transactionRows = yield* sql<Record<string, unknown>>`
    SELECT schema_version, transaction_id, broker_event_id, intent_id, account_id, symbol, side,
      quantity_atoms::text, price_atoms::text, notional_micros::text, fee_micros::text, cost_basis_micros::text,
      realized_pnl_micros::text, quantity_delta_atoms::text, cost_basis_delta_micros::text, cash_delta_micros::text,
      ledger_plan_hash, content_hash, occurred_at FROM accounting_transactions
  `
  const transactions = yield* Schema.decodeUnknownEffect(Schema.Array(AccountingTransactionRowSchema))(transactionRows)
  for (const row of transactions) {
    const { contentHash: _original, ...material } = accountingTransactionFromRow(row)
    yield* sql`UPDATE accounting_transactions SET content_hash = ${yield* Effect.fromResult(canonicalHashV1Result(material))} WHERE transaction_id = ${row.transaction_id}`
  }
  const fillRows = yield* sql<Record<string, unknown>>`
    SELECT f.event_id, f.account_id, f.fill_id, f.broker_order_id, f.client_order_id, f.intent_id, f.symbol, f.side,
      f.quantity_atoms::text, f.price_atoms::text, f.fee_micros::text, f.source_timestamp,
      to_char(e.occurred_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS occurred_at
    FROM fills AS f JOIN broker_events AS e USING (event_id)
  `
  const fills = yield* Schema.decodeUnknownEffect(
    Schema.Array(
      Schema.Struct({
        event_id: Schema.String,
        account_id: Schema.String,
        fill_id: Schema.String,
        broker_order_id: Schema.String,
        client_order_id: Schema.String,
        intent_id: Schema.NullOr(Schema.String),
        symbol: Schema.String,
        side: Schema.String,
        quantity_atoms: Schema.String,
        price_atoms: Schema.String,
        fee_micros: Schema.String,
        source_timestamp: Schema.String,
        occurred_at: Schema.String,
      }),
    ),
  )(fillRows)
  for (const row of fills) {
    const fill = {
      schemaVersion: 'bayn.fill.v2',
      accountId: row.account_id,
      fillId: row.fill_id,
      brokerOrderId: row.broker_order_id,
      clientOrderId: row.client_order_id,
      ...(row.intent_id === null ? {} : { intentId: row.intent_id }),
      symbol: row.symbol,
      side: row.side,
      quantityAtoms: row.quantity_atoms,
      priceAtoms: row.price_atoms,
      feeMicros: row.fee_micros,
      occurredAt: row.occurred_at,
    }
    const hash = yield* Effect.fromResult(
      canonicalHashV1Result({
        schemaVersion: 'bayn.fill-source.v2',
        fill,
        brokerTransactionTime: row.source_timestamp,
      }),
    )
    yield* sql`UPDATE broker_events SET normalized_content_hash = ${hash} WHERE event_id = ${row.event_id}`
  }
  yield* sql`ALTER TABLE mutation_events ADD COLUMN request_body jsonb`
  const orderRows = yield* sql<Record<string, unknown>>`
    SELECT o.event_id, o.account_id, o.broker_order_id, o.client_order_id, o.intent_id, o.symbol, o.side,
      o.order_type, o.time_in_force, o.quantity_atoms::text, o.notional_micros::text, o.filled_quantity_atoms::text,
      o.limit_price_micros::text, o.status, e.source_event_id FROM orders AS o JOIN broker_events AS e USING (event_id)
  `
  const orders = yield* Schema.decodeUnknownEffect(
    Schema.Array(
      Schema.Struct({
        event_id: Schema.String,
        account_id: Schema.String,
        broker_order_id: Schema.String,
        client_order_id: Schema.String,
        intent_id: Schema.NullOr(Schema.String),
        symbol: Schema.String,
        side: Schema.String,
        order_type: Schema.String,
        time_in_force: Schema.String,
        quantity_atoms: Schema.NullOr(Schema.String),
        notional_micros: Schema.NullOr(Schema.String),
        filled_quantity_atoms: Schema.String,
        limit_price_micros: Schema.NullOr(Schema.String),
        status: Schema.String,
        source_event_id: Schema.String,
      }),
    ),
  )(orderRows)
  for (const row of orders) {
    const order = {
      schemaVersion: 'bayn.order.v3',
      accountId: row.account_id,
      brokerOrderId: row.broker_order_id,
      clientOrderId: row.client_order_id,
      ...(row.intent_id === null ? {} : { intentId: row.intent_id }),
      symbol: row.symbol,
      side: row.side,
      orderType: row.order_type,
      timeInForce: row.time_in_force,
      ...(row.quantity_atoms === null ? {} : { quantityAtoms: row.quantity_atoms }),
      ...(row.notional_micros === null ? {} : { notionalMicros: row.notional_micros }),
      filledQuantityAtoms: row.filled_quantity_atoms,
      ...(row.limit_price_micros === null ? {} : { limitPriceMicros: row.limit_price_micros }),
      status: row.status,
    }
    const hash = yield* Effect.fromResult(
      canonicalHashV1Result({
        schemaVersion: 'bayn.order-source.v3',
        order,
        brokerUpdatedAt: row.source_event_id.slice(`order:${row.broker_order_id}:`.length),
      }),
    )
    yield* sql`UPDATE broker_events SET normalized_content_hash = ${hash} WHERE event_id = ${row.event_id}`
    if (row.intent_id !== null) {
      const requestBody = {
        symbol: row.symbol,
        side: row.side.toLowerCase(),
        type: row.order_type.toLowerCase(),
        time_in_force: row.time_in_force.toLowerCase(),
        client_order_id: row.client_order_id,
        extended_hours: false,
        ...(row.quantity_atoms === null ? {} : { qty: quantityToDecimal(BigInt(row.quantity_atoms)) }),
        ...(row.notional_micros === null ? {} : { notional: quantityToDecimal(BigInt(row.notional_micros) * 1000n) }),
        ...(row.limit_price_micros === null
          ? {}
          : { limit_price: quantityToDecimal(BigInt(row.limit_price_micros) * 1000n) }),
      }
      const requestHash = yield* Effect.fromResult(canonicalHashV1Result(requestBody))
      const recorded = yield* sql<{
        request_hash: string
      }>`SELECT request_hash FROM mutation_events WHERE intent_id = ${row.intent_id} AND event_type = 'SUBMIT_STARTED'`
      if (recorded.length !== 1 || recorded[0]?.request_hash !== requestHash)
        return yield* new CashSpotCutoverError({ message: 'cutover cannot reproduce the original broker submit body' })
      yield* sql`UPDATE mutation_events SET request_body = ${JSON.stringify(requestBody)}::jsonb WHERE intent_id = ${row.intent_id} AND event_type = 'SUBMIT_STARTED'`
    }
  }
  yield* sql`CREATE FUNCTION initialize_broker_event_projection_hash() RETURNS trigger LANGUAGE plpgsql AS $hash$ BEGIN
    NEW.normalized_content_hash := NEW.content_hash; RETURN NEW;
  END $hash$`
  yield* sql`CREATE TRIGGER broker_event_projection_hash BEFORE INSERT ON broker_events FOR EACH ROW EXECUTE FUNCTION initialize_broker_event_projection_hash()`
  yield* sql`ALTER TABLE broker_events ALTER COLUMN normalized_content_hash SET NOT NULL`
  yield* sql`ALTER TABLE broker_fee_accounting ADD COLUMN coin_cost_basis_micros numeric(39,0) CHECK (coin_cost_basis_micros >= 0)`
  // Replace stored SQL function bodies once; the runtime only sees the new columns.
  yield* sql`
    DO $functions$ DECLARE f record; BEGIN
      FOR f IN SELECT pg_get_functiondef(p.oid) AS definition FROM pg_proc AS p JOIN pg_namespace AS n ON n.oid = p.pronamespace
        WHERE n.nspname = current_schema() AND p.prokind = 'f' AND pg_get_functiondef(p.oid) LIKE '%quantity_micros%'
      LOOP EXECUTE replace(f.definition, 'quantity_micros', 'quantity_atoms'); END LOOP;
    END $functions$
  `
  yield* sql`ALTER TABLE autonomous_cycles DROP CONSTRAINT autonomous_cycles_check7, ADD CONSTRAINT autonomous_cycles_execution_close_date_check CHECK (execution_calendar_schema_version = 'bayn.continuous-market-hours.v1' OR (execution_close_at AT TIME ZONE 'UTC')::date = execution_session_date)`
  yield* sql`
    ALTER TABLE autonomous_cycles DROP CONSTRAINT autonomous_cycles_execution_calendar_schema_version_check,
      DROP CONSTRAINT autonomous_cycles_execution_calendar_source_check,
      ADD CONSTRAINT autonomous_cycles_market_hours_check CHECK (
        (execution_calendar_schema_version = 'bayn.alpaca-market-calendar-observation.v1' AND execution_calendar_source = 'alpaca-v2-calendar') OR
        (execution_calendar_schema_version = 'bayn.continuous-market-hours.v1' AND execution_calendar_source = 'alpaca-crypto-us'
          AND execution_close_at - execution_open_at = interval '19 minutes' AND submission_cutoff_at - submission_open_at = interval '1 minute')
      )
  `
  yield* sql`
    DO $cutoff$ DECLARE original text; BEGIN
      SELECT pg_get_constraintdef(oid) INTO STRICT original FROM pg_constraint
        WHERE conrelid = 'autonomous_cycles'::regclass AND conname = 'autonomous_cycles_submission_cutoff_offset_check';
      ALTER TABLE autonomous_cycles DROP CONSTRAINT autonomous_cycles_submission_cutoff_offset_check;
      EXECUTE 'ALTER TABLE autonomous_cycles ADD CONSTRAINT autonomous_cycles_submission_cutoff_offset_check CHECK (
        (execution_calendar_schema_version = ''bayn.continuous-market-hours.v1'' AND schema_version = ''bayn.autonomous-cycle.v4''
          AND submission_open_at = execution_open_at AND submission_cutoff_at = execution_open_at + interval ''1 minute'')
        OR (execution_calendar_schema_version <> ''bayn.continuous-market-hours.v1'' AND ' || substring(original FROM 7) || '))';
    END $cutoff$
  `
  yield* sql`ALTER TABLE authority_generations DROP CONSTRAINT authority_generations_strategy_parameter_schema_version_check, DROP CONSTRAINT authority_generations_strategy_contract_check`
  yield* sql`ALTER TABLE authority_generations ADD CONSTRAINT authority_generations_strategy_parameter_schema_version_check CHECK (
        strategy_parameter_schema_version IN ('bayn.risk-balanced-trend.protocol.v3', 'bayn.risk-balanced-trend.protocol.v4',
          'bayn.opening-drive.protocol.v2', 'bayn.intraday-momentum.protocol.v1', 'bayn.intraday-momentum.protocol.v2',
          'bayn.intraday-momentum.protocol.v3', 'bayn.jev.protocol.v1', 'bayn.jev.protocol.v2', 'bayn.jev.protocol.v3')
      ),
      ADD CONSTRAINT authority_generations_strategy_contract_check CHECK (
        (strategy_name IS NULL AND strategy_parameter_schema_version IS NULL)
        OR (strategy_name = 'risk-balanced-trend' AND strategy_parameter_schema_version IN ('bayn.risk-balanced-trend.protocol.v3', 'bayn.risk-balanced-trend.protocol.v4'))
        OR (strategy_name = 'opening-drive-momentum' AND strategy_parameter_schema_version = 'bayn.opening-drive.protocol.v2')
        OR (strategy_name = 'intraday-momentum' AND strategy_parameter_schema_version IN ('bayn.intraday-momentum.protocol.v1', 'bayn.intraday-momentum.protocol.v2', 'bayn.intraday-momentum.protocol.v3'))
        OR (strategy_name = 'jev' AND strategy_parameter_schema_version IN ('bayn.jev.protocol.v1', 'bayn.jev.protocol.v2', 'bayn.jev.protocol.v3'))
      )`
  yield* sql`UPDATE authority_state SET effective = 'OBSERVE', kill_state = 'ACTIVE', reason = 'BLOCKED_CONTINUOUS_CASH_SPOT_CUTOVER', version = version + 1, updated_at = greatest(clock_timestamp(), updated_at + interval '1 millisecond') WHERE effective = 'PAPER'`
  for (const [table] of projectionTables) yield* sql.unsafe(`ALTER TABLE ${table} ENABLE TRIGGER USER`)
})
