import { PgClient } from '@effect/sql-pg'
import { Effect } from 'effect'

import { prepareAccounting } from '../../accounting/domain'
import { renderAccountingFailure } from '../../accounting/failure'
import type { PositionCost, PreparedAccounting } from '../../accounting/model'
import type { AccountingTransaction } from '../../accounting/schema'
import type { FillEventInput } from '../../broker/observations'
import type { JournalService } from '../../ledger'
import { currentUtcInstant } from '../../time'
import type { AccountingReceipt } from '../../paper'
import { accountingReceiptFromRow, accountingTransactionFromRow } from '../accounting-rows'
import type { BrokerEventInterpreter } from './broker-events'
import type { PaperStoreError, PaperStoreRuntimeConfig } from './contract'
import {
  decideAccountingReceipt,
  decideAccountingReceiptReplay,
  decidePredecessorCoverage,
  decidePreparedAccountingReplay,
  decidePreparedTransaction,
  decideSuccessorAbsence,
  planAccountingReceipt,
} from './decisions'
import { liftPaperDecision, paperStoreError, runPaperOperation } from './errors'
import {
  decodeFillInput,
  decodePositionCost,
  decodeReceipt,
  decodeReceiptRows,
  decodeTransaction,
  decodeTransactionRows,
  decodeUnresolvedPredecessor,
} from './rows'

export interface AccountingInterpreter {
  readonly account: (input: FillEventInput) => Effect.Effect<AccountingReceipt, PaperStoreError>
}

export const makeAccountingInterpreter = (
  sql: PgClient.PgClient,
  journal: JournalService,
  config: PaperStoreRuntimeConfig,
  events: Pick<BrokerEventInterpreter, 'append'>,
): AccountingInterpreter => {
  const economicallyPrecedes = (input: FillEventInput) => sql`
    (
      candidate_fill.source_timestamp COLLATE "C" < (${input.sourceTimestamp}::text COLLATE "C")
      OR (
        candidate_fill.source_timestamp = ${input.sourceTimestamp}
        AND candidate_fill.fill_id COLLATE "C" < (${input.fill.fillId}::text COLLATE "C")
      )
    )
  `

  const economicallyFollows = (input: FillEventInput) => sql`
    (
      candidate_fill.source_timestamp COLLATE "C" > (${input.sourceTimestamp}::text COLLATE "C")
      OR (
        candidate_fill.source_timestamp = ${input.sourceTimestamp}
        AND candidate_fill.fill_id COLLATE "C" > (${input.fill.fillId}::text COLLATE "C")
      )
    )
  `

  const priorPosition = (input: FillEventInput): Effect.Effect<PositionCost, PaperStoreError> =>
    runPaperOperation(
      'account',
      sql<Record<string, unknown>>`
        SELECT
          COALESCE(sum(transaction.quantity_delta_micros), 0)::text AS quantity_micros,
          COALESCE(sum(transaction.cost_basis_delta_micros), 0)::text AS cost_micros
        FROM accounting_transactions AS transaction
        JOIN fills AS candidate_fill ON candidate_fill.event_id = transaction.broker_event_id
        WHERE transaction.account_id = ${input.accountId}
          AND transaction.symbol = ${input.fill.symbol}
          AND ${economicallyPrecedes(input)}
      `.pipe(
        Effect.flatMap(decodePositionCost),
        Effect.map(([position]) => ({
          quantityMicros: position.quantity_micros,
          costMicros: position.cost_micros,
        })),
      ),
    )

  const requirePostedPredecessors = (input: FillEventInput): Effect.Effect<void, PaperStoreError> =>
    runPaperOperation(
      'account',
      sql<Record<string, unknown>>`
        SELECT EXISTS (
          SELECT 1
          FROM broker_events AS event
          JOIN fills AS candidate_fill ON candidate_fill.event_id = event.event_id
          LEFT JOIN accounting_transactions AS transaction ON transaction.broker_event_id = event.event_id
          LEFT JOIN accounting_receipts AS receipt ON receipt.broker_event_id = transaction.broker_event_id
          WHERE event.broker = ${input.broker}
            AND event.account_id = ${input.accountId}
            AND event.event_kind = 'FILL'
            AND ${economicallyPrecedes(input)}
            AND (transaction.transaction_id IS NULL OR receipt.receipt_id IS NULL)
        ) AS unresolved
      `.pipe(
        Effect.flatMap(decodeUnresolvedPredecessor),
        Effect.flatMap(([result]) => liftPaperDecision('account', decidePredecessorCoverage(result.unresolved))),
      ),
    )

  const requireNoPreparedSuccessors = (input: FillEventInput): Effect.Effect<void, PaperStoreError> =>
    runPaperOperation(
      'account',
      sql<Record<string, unknown>>`
        SELECT EXISTS (
          SELECT 1
          FROM accounting_transactions AS transaction
          JOIN fills AS candidate_fill ON candidate_fill.event_id = transaction.broker_event_id
          WHERE transaction.account_id = ${input.accountId}
            AND transaction.symbol = ${input.fill.symbol}
            AND ${economicallyFollows(input)}
        ) AS unresolved
      `.pipe(
        Effect.flatMap(decodeUnresolvedPredecessor),
        Effect.flatMap(([result]) => liftPaperDecision('account', decideSuccessorAbsence(result.unresolved))),
      ),
    )

  const readPrepared = (brokerEventId: string): Effect.Effect<AccountingTransaction | undefined, PaperStoreError> =>
    runPaperOperation(
      'account',
      sql<Record<string, unknown>>`
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
      `.pipe(
        Effect.flatMap(decodeTransactionRows),
        Effect.flatMap((rows) => Effect.all(rows.map((row) => decodeTransaction(accountingTransactionFromRow(row))))),
        Effect.flatMap((transactions) => liftPaperDecision('account', decidePreparedTransaction(transactions))),
      ),
    )

  const insertPrepared = (prepared: PreparedAccounting): Effect.Effect<void, PaperStoreError> =>
    runPaperOperation(
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
    runPaperOperation(
      'account',
      sql.withTransaction(
        Effect.gen(function* () {
          const event = yield* events.append(input)
          const stored = yield* readPrepared(event.eventId)
          yield* requirePostedPredecessors(input)
          if (stored === undefined) yield* requireNoPreparedSuccessors(input)
          const position = yield* priorPosition(input)
          const expected = yield* prepareAccounting(
            event.eventId,
            input.fill,
            position,
            config.tigerBeetle.ledger,
          ).pipe(
            Effect.fromResult,
            Effect.mapError((cause) =>
              paperStoreError(
                'account',
                'invariant',
                `fill accounting plan is invalid: ${renderAccountingFailure(cause)}`,
                cause,
              ),
            ),
          )
          const replay = yield* liftPaperDecision('account', decidePreparedAccountingReplay(stored, expected))
          if (stored === undefined) yield* insertPrepared(replay)
          return replay
        }),
      ),
    )

  const readReceipt = (brokerEventId: string): Effect.Effect<AccountingReceipt | undefined, PaperStoreError> =>
    runPaperOperation(
      'receipt',
      sql<Record<string, unknown>>`
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
      `.pipe(
        Effect.flatMap(decodeReceiptRows),
        Effect.flatMap((rows) => Effect.all(rows.map((row) => decodeReceipt(accountingReceiptFromRow(row))))),
        Effect.flatMap((receipts) => liftPaperDecision('receipt', decideAccountingReceipt(receipts))),
      ),
    )

  const recordReceipt = (prepared: PreparedAccounting): Effect.Effect<AccountingReceipt, PaperStoreError> =>
    runPaperOperation(
      'receipt',
      liftPaperDecision(
        'receipt',
        planAccountingReceipt(prepared, config.tigerBeetle.clusterId.toString(), config.tigerBeetle.ledger),
      ).pipe(
        Effect.flatMap((planned) =>
          sql.withTransaction(
            Effect.gen(function* () {
              const recordedAt = yield* currentUtcInstant
              const candidate = yield* decodeReceipt({ ...planned, recordedAt })
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
              return yield* liftPaperDecision('receipt', decideAccountingReceiptReplay(stored, candidate))
            }),
          ),
        ),
      ),
    )

  const account = (input: FillEventInput): Effect.Effect<AccountingReceipt, PaperStoreError> =>
    runPaperOperation(
      'account',
      decodeFillInput(input).pipe(
        Effect.flatMap(prepare),
        Effect.tap((prepared) =>
          journal
            .post(prepared.ledger)
            .pipe(
              Effect.mapError((cause) =>
                paperStoreError('account', 'ledger', 'TigerBeetle accounting post failed', cause),
              ),
            ),
        ),
        Effect.flatMap(recordReceipt),
      ),
    )

  return { account }
}
