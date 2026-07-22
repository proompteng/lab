import { PgClient } from '@effect/sql-pg'
import { Clock, Context, Data, Effect, Layer, Schema } from 'effect'

import {
  AccountingTransactionSchema,
  prepareAccounting,
  type AccountingTransaction,
  type PositionCost,
  type PreparedAccounting,
} from '../accounting'
import {
  BrokerEventInputSchema,
  FillEventInputSchema,
  ValuationInputSchema,
  type BrokerEventInput,
  type FillEventInput,
  type ValuationInput,
} from '../broker/observations'
import type { RuntimeConfig } from '../config'
import { canonicalHashV1 } from '../hash'
import { Journal } from '../ledger'
import {
  AccountingReceiptSchema,
  BrokerEventSchema,
  OrderSide,
  ValuationSchema,
  type AccountingReceipt,
  type Valuation,
} from '../paper'
import { Sha256Schema as Sha256, StrictNonEmptyStringSchema as NonEmptyString, strictParseOptions } from '../schemas'

export const VALUATION_SNAPSHOT_MAX_SKEW_MS = 30_000

export interface EventReceipt {
  readonly eventId: string
  readonly sourceSequence: string
  readonly deduplicated: boolean
}

export class PaperStoreError extends Data.TaggedError('PaperStoreError')<{
  readonly operation: 'ingest' | 'account' | 'receipt' | 'valuation'
  readonly failure: 'conflict' | 'decode' | 'invariant' | 'ledger' | 'query'
  readonly message: string
  readonly cause?: unknown
}> {}

export interface PaperStoreShape {
  readonly ingest: (input: BrokerEventInput) => Effect.Effect<EventReceipt, PaperStoreError>
  readonly account: (input: FillEventInput) => Effect.Effect<AccountingReceipt, PaperStoreError>
  readonly value: (input: ValuationInput) => Effect.Effect<Valuation, PaperStoreError>
}

export class PaperStore extends Context.Service<PaperStore, PaperStoreShape>()('bayn/PaperStore') {}

const EventKind = Schema.Literals(['ACCOUNT', 'POSITION', 'ORDER', 'FILL'])
const EventRow = Schema.Struct({
  event_id: Sha256,
  event_kind: EventKind,
  content_hash: Sha256,
  source_sequence: Schema.String,
})
const LastSequenceRow = Schema.Tuple([Schema.Struct({ last_sequence: Schema.String })])
const PositionCostRow = Schema.Tuple([Schema.Struct({ quantity_micros: Schema.String, cost_micros: Schema.String })])
const UnresolvedPredecessorRow = Schema.Tuple([Schema.Struct({ unresolved: Schema.Boolean })])
const TransactionRow = Schema.Struct({
  schema_version: Schema.Literal('bayn.paper-accounting-transaction.v1'),
  transaction_id: Sha256,
  broker_event_id: Sha256,
  intent_id: Schema.NullOr(Sha256),
  account_id: NonEmptyString,
  symbol: Schema.String,
  side: Schema.Enum(OrderSide),
  quantity_micros: Schema.String,
  price_micros: Schema.String,
  notional_micros: Schema.String,
  fee_micros: Schema.String,
  cost_basis_micros: Schema.String,
  realized_pnl_micros: Schema.String,
  quantity_delta_micros: Schema.String,
  cost_basis_delta_micros: Schema.String,
  cash_delta_micros: Schema.String,
  ledger_plan_hash: Sha256,
  content_hash: Sha256,
  occurred_at: Schema.DateValid,
})
const ReceiptRow = Schema.Struct({
  schema_version: Schema.Literal('bayn.paper-accounting-receipt.v1'),
  receipt_id: Sha256,
  intent_id: Schema.NullOr(Sha256),
  broker_event_id: Sha256,
  tigerbeetle_cluster_id: Schema.String,
  tigerbeetle_ledger: Schema.Int,
  account_ids: Schema.Array(Schema.String),
  transfer_ids: Schema.Array(Schema.String),
  debit_micros: Schema.String,
  credit_micros: Schema.String,
  content_hash: Sha256,
  recorded_at: Schema.DateValid,
})
const AccountRow = Schema.Tuple([
  Schema.Struct({
    event_id: Sha256,
    account_id: NonEmptyString,
    cash_micros: Schema.String,
    observed_at: Schema.DateValid,
  }),
])
const PositionRow = Schema.Struct({
  event_id: Sha256,
  account_id: NonEmptyString,
  source_event_id: NonEmptyString,
  symbol: Schema.String,
  market_value_micros: Schema.String,
  observed_at: Schema.DateValid,
})
const ValuationRow = Schema.Struct({
  schema_version: Schema.Literal('bayn.paper-valuation.v1'),
  valuation_id: Sha256,
  account_id: NonEmptyString,
  source_hash: Sha256,
  cash_micros: Schema.String,
  long_market_value_micros: Schema.String,
  short_market_value_micros: Schema.String,
  equity_micros: Schema.String,
  as_of: Schema.DateValid,
})

const decodeEventInput = Schema.decodeUnknownEffect(BrokerEventInputSchema, strictParseOptions)
const decodeFillInput = Schema.decodeUnknownEffect(FillEventInputSchema, strictParseOptions)
const decodeValuationInput = Schema.decodeUnknownEffect(ValuationInputSchema, strictParseOptions)
const decodeEventRows = Schema.decodeUnknownEffect(Schema.Array(EventRow), strictParseOptions)
const decodeLastSequence = Schema.decodeUnknownEffect(LastSequenceRow, strictParseOptions)
const decodePositionCost = Schema.decodeUnknownEffect(PositionCostRow, strictParseOptions)
const decodeUnresolvedPredecessor = Schema.decodeUnknownEffect(UnresolvedPredecessorRow, strictParseOptions)
const decodeTransactionRows = Schema.decodeUnknownEffect(Schema.Array(TransactionRow), strictParseOptions)
const decodeReceiptRows = Schema.decodeUnknownEffect(Schema.Array(ReceiptRow), strictParseOptions)
const decodeAccountRows = Schema.decodeUnknownEffect(AccountRow, strictParseOptions)
const decodePositionRows = Schema.decodeUnknownEffect(Schema.Array(PositionRow), strictParseOptions)
const decodeValuationRows = Schema.decodeUnknownEffect(Schema.Array(ValuationRow), strictParseOptions)
const decodeBrokerEvent = Schema.decodeUnknownEffect(BrokerEventSchema, strictParseOptions)
const decodeReceipt = Schema.decodeUnknownEffect(AccountingReceiptSchema, strictParseOptions)
const decodeValuation = Schema.decodeUnknownEffect(ValuationSchema, strictParseOptions)
const decodeTransaction = Schema.decodeUnknownEffect(AccountingTransactionSchema, strictParseOptions)

const messageOf = (cause: unknown): string => (cause instanceof Error ? cause.message : String(cause))

const error = (
  operation: PaperStoreError['operation'],
  failure: PaperStoreError['failure'],
  message: string,
  cause?: unknown,
): PaperStoreError =>
  new PaperStoreError({
    operation,
    failure,
    message: cause === undefined ? message : `${message}: ${messageOf(cause)}`,
    cause,
  })

const run = <A, E, R>(
  operation: PaperStoreError['operation'],
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<A, PaperStoreError, R> =>
  effect.pipe(
    Effect.mapError((cause) =>
      cause instanceof PaperStoreError
        ? cause
        : error(operation, Schema.isSchemaError(cause) ? 'decode' : 'query', 'paper evidence operation failed', cause),
    ),
  )

const fail = (
  operation: PaperStoreError['operation'],
  failure: PaperStoreError['failure'],
  message: string,
): Effect.Effect<never, PaperStoreError> => Effect.fail(error(operation, failure, message))

const kindOf = (input: BrokerEventInput): typeof EventKind.Type => {
  switch (input._tag) {
    case 'Account':
      return 'ACCOUNT'
    case 'Position':
      return 'POSITION'
    case 'Order':
      return 'ORDER'
    case 'Fill':
      return 'FILL'
  }
}

const eventIdOf = (input: BrokerEventInput): string =>
  canonicalHashV1({
    schemaVersion: 'bayn.paper-broker-event-id.v1',
    broker: input.broker,
    accountId: input.accountId,
    sourceEventId: input.sourceEventId,
    contentHash: input.contentHash,
  })

const transactionFromRow = (row: typeof TransactionRow.Type): AccountingTransaction => ({
  schemaVersion: row.schema_version,
  transactionId: row.transaction_id,
  brokerEventId: row.broker_event_id,
  ...(row.intent_id === null ? {} : { intentId: row.intent_id }),
  accountId: row.account_id,
  symbol: row.symbol,
  side: row.side,
  quantityMicros: row.quantity_micros,
  priceMicros: row.price_micros,
  notionalMicros: row.notional_micros,
  feeMicros: row.fee_micros,
  costBasisMicros: row.cost_basis_micros,
  realizedPnlMicros: row.realized_pnl_micros,
  quantityDeltaMicros: row.quantity_delta_micros,
  costBasisDeltaMicros: row.cost_basis_delta_micros,
  cashDeltaMicros: row.cash_delta_micros,
  ledgerPlanHash: row.ledger_plan_hash,
  contentHash: row.content_hash,
  occurredAt: row.occurred_at.toISOString(),
})

const receiptFromRow = (row: typeof ReceiptRow.Type): AccountingReceipt => ({
  schemaVersion: row.schema_version,
  receiptId: row.receipt_id,
  ...(row.intent_id === null ? {} : { intentId: row.intent_id }),
  brokerEventId: row.broker_event_id,
  tigerBeetleClusterId: row.tigerbeetle_cluster_id,
  tigerBeetleLedger: row.tigerbeetle_ledger,
  accountIds: row.account_ids,
  transferIds: row.transfer_ids,
  debitMicros: row.debit_micros,
  creditMicros: row.credit_micros,
  contentHash: row.content_hash,
  recordedAt: row.recorded_at.toISOString(),
})

const valuationFromRow = (row: typeof ValuationRow.Type): Valuation => ({
  schemaVersion: row.schema_version,
  valuationId: row.valuation_id,
  accountId: row.account_id,
  sourceHash: row.source_hash,
  cashMicros: row.cash_micros,
  longMarketValueMicros: row.long_market_value_micros,
  shortMarketValueMicros: row.short_market_value_micros,
  equityMicros: row.equity_micros,
  asOf: row.as_of.toISOString(),
})

const stableReceipt = (receipt: AccountingReceipt) => ({
  schemaVersion: receipt.schemaVersion,
  receiptId: receipt.receiptId,
  ...(receipt.intentId === undefined ? {} : { intentId: receipt.intentId }),
  brokerEventId: receipt.brokerEventId,
  tigerBeetleClusterId: receipt.tigerBeetleClusterId,
  tigerBeetleLedger: receipt.tigerBeetleLedger,
  accountIds: receipt.accountIds,
  transferIds: receipt.transferIds,
  debitMicros: receipt.debitMicros,
  creditMicros: receipt.creditMicros,
  contentHash: receipt.contentHash,
})

const makeStore = (config: Pick<RuntimeConfig, 'tigerBeetle'>) =>
  Effect.gen(function* () {
    const sql = yield* PgClient.PgClient
    const journal = yield* Journal

    const insertPayload = (eventId: string, input: BrokerEventInput) => {
      switch (input._tag) {
        case 'Account':
          return sql`
            INSERT INTO account_snapshots (
              event_id, account_id, schema_version, status, currency,
              cash_micros, equity_micros, buying_power_micros
            ) VALUES (
              ${eventId}, ${input.account.accountId}, ${input.account.schemaVersion}, ${input.account.status},
              ${input.account.currency}, ${input.account.cashMicros}, ${input.account.equityMicros},
              ${input.account.buyingPowerMicros}
            )
          `.pipe(Effect.asVoid)
        case 'Position':
          return sql`
            INSERT INTO positions (
              event_id, account_id, schema_version, symbol, quantity_micros,
              average_entry_price_micros, market_price_micros, market_value_micros, unrealized_pnl_micros
            ) VALUES (
              ${eventId}, ${input.position.accountId}, ${input.position.schemaVersion}, ${input.position.symbol},
              ${input.position.quantityMicros}, ${input.position.averageEntryPriceMicros},
              ${input.position.marketPriceMicros}, ${input.position.marketValueMicros},
              ${input.position.unrealizedPnlMicros}
            )
          `.pipe(Effect.asVoid)
        case 'Order':
          return sql`
            INSERT INTO orders (
              event_id, account_id, schema_version, broker_order_id, client_order_id, intent_id, symbol,
              side, order_type, time_in_force, quantity_micros, filled_quantity_micros, limit_price_micros, status
            ) VALUES (
              ${eventId}, ${input.order.accountId}, ${input.order.schemaVersion}, ${input.order.brokerOrderId},
              ${input.order.clientOrderId}, ${input.order.intentId ?? null}, ${input.order.symbol}, ${input.order.side},
              ${input.order.orderType}, ${input.order.timeInForce}, ${input.order.quantityMicros},
              ${input.order.filledQuantityMicros}, ${input.order.limitPriceMicros ?? null}, ${input.order.status}
            )
          `.pipe(Effect.asVoid)
        case 'Fill':
          return sql`
            INSERT INTO fills (
              event_id, account_id, schema_version, fill_id, broker_order_id, client_order_id, intent_id,
              symbol, side, quantity_micros, price_micros, fee_micros
            ) VALUES (
              ${eventId}, ${input.fill.accountId}, ${input.fill.schemaVersion}, ${input.fill.fillId},
              ${input.fill.brokerOrderId}, ${input.fill.clientOrderId}, ${input.fill.intentId ?? null},
              ${input.fill.symbol}, ${input.fill.side}, ${input.fill.quantityMicros}, ${input.fill.priceMicros},
              ${input.fill.feeMicros}
            )
          `.pipe(Effect.asVoid)
      }
    }

    const append = (input: BrokerEventInput): Effect.Effect<EventReceipt, PaperStoreError> =>
      run(
        'ingest',
        Effect.gen(function* () {
          const eventKind = kindOf(input)
          yield* sql`SELECT pg_advisory_xact_lock(hashtextextended(${`${input.broker}:${input.accountId}`}, 0))`
          const existing = yield* sql<Record<string, unknown>>`
            SELECT event_id, event_kind, content_hash, source_sequence::text AS source_sequence
            FROM broker_events
            WHERE broker = ${input.broker}
              AND account_id = ${input.accountId}
              AND source_event_id = ${input.sourceEventId}
          `.pipe(Effect.flatMap(decodeEventRows))
          if (existing.length > 1) return yield* fail('ingest', 'invariant', 'broker source identity is not unique')
          const found = existing[0]
          if (found !== undefined) {
            if (found.event_kind !== eventKind || found.content_hash !== input.contentHash) {
              return yield* fail('ingest', 'conflict', 'broker source identity was reused with different content')
            }
            return { eventId: found.event_id, sourceSequence: found.source_sequence, deduplicated: true }
          }

          const [last] = yield* sql<Record<string, unknown>>`
            SELECT COALESCE(max(source_sequence), -1)::text AS last_sequence
            FROM broker_events
            WHERE broker = ${input.broker} AND account_id = ${input.accountId}
          `.pipe(Effect.flatMap(decodeLastSequence))
          const sourceSequence = (BigInt(last.last_sequence) + 1n).toString()
          const eventId = eventIdOf(input)
          yield* decodeBrokerEvent({
            ...input,
            schemaVersion: 'bayn.paper-broker-event.v1',
            eventId,
            sourceSequence,
          })
          yield* sql`
            INSERT INTO broker_events (
              event_id, schema_version, content_hash, event_kind, broker, account_id,
              source_event_id, source_sequence, occurred_at, observed_at
            ) VALUES (
              ${eventId}, 'bayn.paper-broker-event.v1', ${input.contentHash}, ${eventKind}, ${input.broker},
              ${input.accountId}, ${input.sourceEventId}, ${sourceSequence}, ${input.occurredAt}, ${input.observedAt}
            )
          `
          yield* insertPayload(eventId, input)
          return { eventId, sourceSequence, deduplicated: false }
        }),
      )

    const priorPosition = (
      input: FillEventInput,
      sourceSequence: string,
    ): Effect.Effect<PositionCost, PaperStoreError> =>
      run(
        'account',
        sql<Record<string, unknown>>`
          SELECT
            COALESCE(sum(transaction.quantity_delta_micros), 0)::text AS quantity_micros,
            COALESCE(sum(transaction.cost_basis_delta_micros), 0)::text AS cost_micros
          FROM accounting_transactions AS transaction
          JOIN broker_events AS event ON event.event_id = transaction.broker_event_id
          WHERE transaction.account_id = ${input.accountId}
            AND transaction.symbol = ${input.fill.symbol}
            AND event.source_sequence < ${sourceSequence}
        `.pipe(
          Effect.flatMap(decodePositionCost),
          Effect.map(([position]) => ({
            quantityMicros: position.quantity_micros,
            costMicros: position.cost_micros,
          })),
        ),
      )

    const requirePostedPredecessors = (
      input: FillEventInput,
      sourceSequence: string,
    ): Effect.Effect<void, PaperStoreError> =>
      run(
        'account',
        sql<Record<string, unknown>>`
          SELECT EXISTS (
            SELECT 1
            FROM accounting_transactions AS transaction
            JOIN broker_events AS event ON event.event_id = transaction.broker_event_id
            LEFT JOIN accounting_receipts AS receipt ON receipt.broker_event_id = transaction.broker_event_id
            WHERE transaction.account_id = ${input.accountId}
              AND event.source_sequence < ${sourceSequence}
              AND receipt.receipt_id IS NULL
          ) AS unresolved
        `.pipe(
          Effect.flatMap(decodeUnresolvedPredecessor),
          Effect.flatMap(([result]) =>
            result.unresolved
              ? fail('account', 'conflict', 'an earlier fill has not been posted to TigerBeetle')
              : Effect.void,
          ),
        ),
      )

    const readPrepared = (brokerEventId: string): Effect.Effect<AccountingTransaction | undefined, PaperStoreError> =>
      run(
        'account',
        Effect.gen(function* () {
          const rows = yield* sql<Record<string, unknown>>`
            SELECT
              schema_version, transaction_id, broker_event_id, intent_id, account_id, symbol, side,
              quantity_micros::text AS quantity_micros, price_micros::text AS price_micros,
              notional_micros::text AS notional_micros, fee_micros::text AS fee_micros,
              cost_basis_micros::text AS cost_basis_micros, realized_pnl_micros::text AS realized_pnl_micros,
              quantity_delta_micros::text AS quantity_delta_micros,
              cost_basis_delta_micros::text AS cost_basis_delta_micros,
              cash_delta_micros::text AS cash_delta_micros, ledger_plan_hash, content_hash, occurred_at
            FROM accounting_transactions
            WHERE broker_event_id = ${brokerEventId}
          `.pipe(Effect.flatMap(decodeTransactionRows))
          if (rows.length === 0) return undefined
          if (rows.length !== 1) return yield* fail('account', 'invariant', 'fill has multiple accounting transactions')
          return yield* decodeTransaction(transactionFromRow(rows[0]))
        }),
      )

    const insertPrepared = (prepared: PreparedAccounting): Effect.Effect<void, PaperStoreError> =>
      run(
        'account',
        sql`
            INSERT INTO accounting_transactions (
              transaction_id, schema_version, broker_event_id, intent_id, account_id, symbol, side,
              quantity_micros, price_micros, notional_micros, fee_micros, cost_basis_micros,
              realized_pnl_micros, quantity_delta_micros, cost_basis_delta_micros, cash_delta_micros,
              ledger_plan_hash, content_hash, occurred_at
            ) VALUES (
              ${prepared.transaction.transactionId}, ${prepared.transaction.schemaVersion},
              ${prepared.transaction.brokerEventId}, ${prepared.transaction.intentId ?? null},
              ${prepared.transaction.accountId}, ${prepared.transaction.symbol}, ${prepared.transaction.side},
              ${prepared.transaction.quantityMicros}, ${prepared.transaction.priceMicros},
              ${prepared.transaction.notionalMicros}, ${prepared.transaction.feeMicros},
              ${prepared.transaction.costBasisMicros}, ${prepared.transaction.realizedPnlMicros},
              ${prepared.transaction.quantityDeltaMicros}, ${prepared.transaction.costBasisDeltaMicros},
              ${prepared.transaction.cashDeltaMicros}, ${prepared.transaction.ledgerPlanHash},
              ${prepared.transaction.contentHash}, ${prepared.transaction.occurredAt}
            )
          `.pipe(Effect.asVoid),
      )

    const prepare = (input: FillEventInput): Effect.Effect<PreparedAccounting, PaperStoreError> =>
      run(
        'account',
        sql.withTransaction(
          Effect.gen(function* () {
            const event = yield* append(input)
            yield* requirePostedPredecessors(input, event.sourceSequence)
            const position = yield* priorPosition(input, event.sourceSequence)
            const expected = yield* Effect.try({
              try: () => prepareAccounting(event.eventId, input.fill, position, config.tigerBeetle.ledger),
              catch: (cause) => error('account', 'invariant', 'fill accounting plan is invalid', cause),
            })
            const stored = yield* readPrepared(event.eventId)
            if (stored === undefined) {
              yield* insertPrepared(expected)
              return expected
            }
            if (canonicalHashV1(stored) !== canonicalHashV1(expected.transaction)) {
              return yield* fail('account', 'conflict', 'stored accounting plan differs from deterministic replay')
            }
            return expected
          }),
        ),
      )

    const readReceipt = (brokerEventId: string): Effect.Effect<AccountingReceipt | undefined, PaperStoreError> =>
      run(
        'receipt',
        Effect.gen(function* () {
          const rows = yield* sql<Record<string, unknown>>`
            SELECT
              schema_version, receipt_id, intent_id, broker_event_id,
              tigerbeetle_cluster_id::text AS tigerbeetle_cluster_id,
              tigerbeetle_ledger::integer AS tigerbeetle_ledger,
              ARRAY(
                SELECT item.value::text FROM unnest(account_ids) AS item(value) ORDER BY item.value
              ) AS account_ids,
              ARRAY(
                SELECT item.value::text FROM unnest(transfer_ids) AS item(value) ORDER BY item.value
              ) AS transfer_ids,
              debit_micros::text AS debit_micros, credit_micros::text AS credit_micros,
              content_hash, recorded_at
            FROM accounting_receipts
            WHERE broker_event_id = ${brokerEventId}
          `.pipe(Effect.flatMap(decodeReceiptRows))
          if (rows.length === 0) return undefined
          if (rows.length !== 1) return yield* fail('receipt', 'invariant', 'fill has multiple accounting receipts')
          return yield* decodeReceipt(receiptFromRow(rows[0]))
        }),
      )

    const recordReceipt = (prepared: PreparedAccounting): Effect.Effect<AccountingReceipt, PaperStoreError> =>
      run(
        'receipt',
        sql.withTransaction(
          Effect.gen(function* () {
            const accountIds = prepared.ledger.accounts.map((account) => account.id.toString())
            const transferIds = prepared.ledger.transfers.map((transfer) => transfer.id.toString())
            const postedMicros = prepared.ledger.transfers
              .reduce((sum, transfer) => sum + transfer.amount, 0n)
              .toString()
            const stable = {
              schemaVersion: 'bayn.paper-accounting-receipt.v1' as const,
              ...(prepared.transaction.intentId === undefined ? {} : { intentId: prepared.transaction.intentId }),
              brokerEventId: prepared.transaction.brokerEventId,
              tigerBeetleClusterId: config.tigerBeetle.clusterId.toString(),
              tigerBeetleLedger: config.tigerBeetle.ledger,
              accountIds,
              transferIds,
              debitMicros: postedMicros,
              creditMicros: postedMicros,
            }
            const receiptId = canonicalHashV1({
              schemaVersion: 'bayn.paper-accounting-receipt-id.v1',
              brokerEventId: prepared.transaction.brokerEventId,
              tigerBeetleClusterId: stable.tigerBeetleClusterId,
              tigerBeetleLedger: stable.tigerBeetleLedger,
            })
            const contentHash = canonicalHashV1(stable)
            const recordedAt = new Date(yield* Clock.currentTimeMillis).toISOString()
            const candidate = yield* decodeReceipt({ ...stable, receiptId, contentHash, recordedAt })
            yield* sql`
            INSERT INTO accounting_receipts (
              receipt_id, schema_version, intent_id, broker_event_id, tigerbeetle_cluster_id, tigerbeetle_ledger,
              account_ids, transfer_ids, debit_micros, credit_micros, content_hash, recorded_at
            ) VALUES (
              ${candidate.receiptId}, ${candidate.schemaVersion}, ${candidate.intentId ?? null},
              ${candidate.brokerEventId}, ${candidate.tigerBeetleClusterId}, ${candidate.tigerBeetleLedger},
              ${candidate.accountIds}, ${candidate.transferIds}, ${candidate.debitMicros}, ${candidate.creditMicros},
              ${candidate.contentHash}, ${candidate.recordedAt}
            )
            ON CONFLICT (broker_event_id) DO NOTHING
          `
            const stored = yield* readReceipt(candidate.brokerEventId)
            if (stored === undefined) return yield* fail('receipt', 'invariant', 'accounting receipt was not persisted')
            if (canonicalHashV1(stableReceipt(stored)) !== canonicalHashV1(stableReceipt(candidate))) {
              return yield* fail('receipt', 'conflict', 'stored accounting receipt differs from deterministic replay')
            }
            return stored
          }),
        ),
      )

    const ingest = (input: BrokerEventInput): Effect.Effect<EventReceipt, PaperStoreError> =>
      run('ingest', decodeEventInput(input).pipe(Effect.flatMap((decoded) => sql.withTransaction(append(decoded)))))

    const account = (input: FillEventInput): Effect.Effect<AccountingReceipt, PaperStoreError> =>
      run(
        'account',
        decodeFillInput(input).pipe(
          Effect.flatMap(prepare),
          Effect.tap((prepared) =>
            journal
              .post(prepared.ledger)
              .pipe(
                Effect.mapError((cause) => error('account', 'ledger', 'TigerBeetle accounting post failed', cause)),
              ),
          ),
          Effect.flatMap(recordReceipt),
        ),
      )

    const value = (input: ValuationInput): Effect.Effect<Valuation, PaperStoreError> =>
      run(
        'valuation',
        decodeValuationInput(input).pipe(
          Effect.flatMap((decoded) =>
            sql.withTransaction(
              Effect.gen(function* () {
                const [accountSnapshot] = yield* sql<Record<string, unknown>>`
                  SELECT
                    snapshot.event_id, snapshot.account_id, snapshot.cash_micros::text AS cash_micros,
                    event.observed_at
                  FROM account_snapshots AS snapshot
                  JOIN broker_events AS event ON event.event_id = snapshot.event_id
                  WHERE snapshot.event_id = ${decoded.accountEventId}
                `.pipe(Effect.flatMap(decodeAccountRows))
                const positionRows =
                  decoded.positionEventIds.length === 0
                    ? []
                    : yield* sql<Record<string, unknown>>`
                        SELECT
                          position.event_id, position.account_id, position.symbol, event.source_event_id,
                          position.market_value_micros::text AS market_value_micros, event.observed_at
                        FROM positions AS position
                        JOIN broker_events AS event ON event.event_id = position.event_id
                        WHERE ${sql.in('position.event_id', decoded.positionEventIds)}
                        ORDER BY position.event_id
                      `.pipe(Effect.flatMap(decodePositionRows))
                if (positionRows.length !== decoded.positionEventIds.length) {
                  return yield* fail('valuation', 'conflict', 'valuation position snapshot is incomplete')
                }
                const positionSourcePrefix = `position:${decoded.positionsSourceHash}:`
                if (
                  positionRows.some(
                    (position) =>
                      position.account_id !== accountSnapshot.account_id ||
                      position.observed_at.toISOString() !== decoded.positionsObservedAt ||
                      !position.source_event_id.startsWith(positionSourcePrefix) ||
                      position.source_event_id.length === positionSourcePrefix.length,
                  )
                ) {
                  return yield* fail(
                    'valuation',
                    'conflict',
                    'valuation snapshots disagree on source, account, or time',
                  )
                }
                if (new Set(positionRows.map((position) => position.symbol)).size !== positionRows.length) {
                  return yield* fail('valuation', 'conflict', 'valuation position symbols are not unique')
                }
                const accountObservedAt = accountSnapshot.observed_at.toISOString()
                const accountTime = accountSnapshot.observed_at.getTime()
                const positionTime = Date.parse(decoded.positionsObservedAt)
                if (Math.abs(accountTime - positionTime) > VALUATION_SNAPSHOT_MAX_SKEW_MS) {
                  return yield* fail('valuation', 'conflict', 'valuation snapshots exceed the maximum observation skew')
                }
                const cash = BigInt(accountSnapshot.cash_micros)
                let longMarketValue = 0n
                let shortMarketValue = 0n
                for (const position of positionRows) {
                  const marketValue = BigInt(position.market_value_micros)
                  if (marketValue >= 0n) longMarketValue += marketValue
                  else shortMarketValue += marketValue
                }
                const source = {
                  schemaVersion: 'bayn.paper-valuation-source.v1' as const,
                  accountEventId: decoded.accountEventId,
                  positionEventIds: [...decoded.positionEventIds].sort(),
                  positionsSourceHash: decoded.positionsSourceHash,
                  accountObservedAt,
                  positionsObservedAt: decoded.positionsObservedAt,
                }
                const sourceHash = canonicalHashV1(source)
                const valuationId = canonicalHashV1({
                  schemaVersion: 'bayn.paper-valuation-id.v1',
                  accountId: accountSnapshot.account_id,
                  sourceHash,
                })
                const candidate = yield* decodeValuation({
                  schemaVersion: 'bayn.paper-valuation.v1',
                  valuationId,
                  accountId: accountSnapshot.account_id,
                  sourceHash,
                  cashMicros: cash.toString(),
                  longMarketValueMicros: longMarketValue.toString(),
                  shortMarketValueMicros: shortMarketValue.toString(),
                  equityMicros: (cash + longMarketValue + shortMarketValue).toString(),
                  asOf: new Date(Math.max(accountTime, positionTime)).toISOString(),
                })
                yield* sql`
                  INSERT INTO valuations (
                    valuation_id, schema_version, account_id, source_hash, cash_micros,
                    long_market_value_micros, short_market_value_micros, equity_micros, as_of
                  ) VALUES (
                    ${candidate.valuationId}, ${candidate.schemaVersion}, ${candidate.accountId},
                    ${candidate.sourceHash}, ${candidate.cashMicros}, ${candidate.longMarketValueMicros},
                    ${candidate.shortMarketValueMicros}, ${candidate.equityMicros}, ${candidate.asOf}
                  )
                  ON CONFLICT (account_id, source_hash) DO NOTHING
                `
                const rows = yield* sql<Record<string, unknown>>`
                  SELECT
                    schema_version, valuation_id, account_id, source_hash,
                    cash_micros::text AS cash_micros,
                    long_market_value_micros::text AS long_market_value_micros,
                    short_market_value_micros::text AS short_market_value_micros,
                    equity_micros::text AS equity_micros, as_of
                  FROM valuations
                  WHERE account_id = ${candidate.accountId} AND source_hash = ${candidate.sourceHash}
                `.pipe(Effect.flatMap(decodeValuationRows))
                if (rows.length !== 1) return yield* fail('valuation', 'invariant', 'valuation was not persisted')
                const stored = yield* decodeValuation(valuationFromRow(rows[0]))
                if (canonicalHashV1(stored) !== canonicalHashV1(candidate)) {
                  return yield* fail('valuation', 'conflict', 'stored valuation differs from deterministic replay')
                }
                return stored
              }),
            ),
          ),
        ),
      )

    return { ingest, account, value } satisfies PaperStoreShape
  })

export const PaperStoreLive = (config: Pick<RuntimeConfig, 'tigerBeetle'>) =>
  Layer.effect(PaperStore, makeStore(config))
