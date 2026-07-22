import { PgClient } from '@effect/sql-pg'
import { Effect, Schema } from 'effect'

import { rebuildAccountingLedger, type AccountingTransaction } from '../accounting'
import { MutationOperation } from '../broker/alpaca-mutations'
import type { RuntimeConfig } from '../config'
import { canonicalHashV1 } from '../hash'
import type { JournalService } from '../ledger'
import {
  DiscrepancySchema,
  IntentState,
  OrderSide,
  OrderType,
  ReconciliationStatus,
  TerminalOutcome,
  TimeInForce,
  decodeAccountingReceipt,
  decodeReconciliation,
  type AccountSnapshot,
  type AccountingReceipt,
  type Discrepancy,
  type Fill,
  type Order,
  type Position,
  type Reconciliation,
  type Valuation,
} from '../paper'
import {
  compareReconciliation,
  reconciledStateHash,
  type IntentExpectation,
  type ReconciliationMetrics,
} from '../reconciliation'
import {
  Sha256Schema as Sha256,
  StrictNonEmptyStringSchema as NonEmptyString,
  UtcInstantSchema as UtcInstant,
  strictParseOptions,
} from '../schemas'
import { MutationEventType } from '../execution/mutations'
import {
  AccountingReceiptRowSchema,
  AccountingTransactionRowSchema,
  accountingReceiptFromRow,
  accountingTransactionFromRow,
} from './accounting-rows'

export interface IntentBinding {
  readonly intentId: string
  readonly clientOrderId: string
}

export interface BrokerSnapshot {
  readonly account: AccountSnapshot
  readonly positions: readonly Position[]
  readonly positionsObservedAt: string
  readonly orders: readonly Order[]
  readonly ordersObservedAt: string
  readonly fills: readonly Fill[]
  readonly valuation: Valuation
  readonly reconciledAt: string
}

export interface ReconciliationReport {
  readonly reconciliation: Reconciliation
  readonly metrics: ReconciliationMetrics
}

const IntentBindingRow = Schema.Struct({ intent_id: Sha256, client_order_id: NonEmptyString })
const IntentRow = Schema.Struct({
  intent_id: Sha256,
  client_order_id: NonEmptyString,
  symbol: Schema.String,
  side: Schema.Enum(OrderSide),
  order_type: Schema.Enum(OrderType),
  time_in_force: Schema.Enum(TimeInForce),
  quantity_micros: Schema.String,
  state: Schema.Enum(IntentState),
  terminal_outcome: Schema.NullOr(Schema.Enum(TerminalOutcome)),
  broker_order_id: Schema.NullOr(NonEmptyString),
  mutation_operation: Schema.NullOr(Schema.Enum(MutationOperation)),
  mutation_event_type: Schema.NullOr(Schema.Enum(MutationEventType)),
  mutation_occurred_at: Schema.NullOr(UtcInstant),
})
const DurableFillRow = Schema.Struct({
  fill_id: NonEmptyString,
  broker_order_id: NonEmptyString,
  broker_event_id: Sha256,
  transaction_id: Schema.NullOr(Sha256),
  receipt_id: Schema.NullOr(Sha256),
})
const ProjectedPositionRow = Schema.Struct({
  symbol: Schema.String,
  quantity_micros: Schema.String,
  cost_basis_micros: Schema.String,
})
const OpeningCashRow = Schema.Tuple([Schema.Struct({ cash_micros: Schema.String, observed_at: UtcInstant })])
const PreviousReconciliationRows = Schema.Array(
  Schema.Struct({ discrepancies: Schema.Array(DiscrepancySchema) }),
).check(Schema.isMaxLength(1))
const ReconciliationContentRow = Schema.Tuple([Schema.Struct({ content_hash: Sha256 })])

const decodeBindings = Schema.decodeUnknownEffect(Schema.Array(IntentBindingRow), strictParseOptions)
const decodeIntents = Schema.decodeUnknownEffect(Schema.Array(IntentRow), strictParseOptions)
const decodeDurableFills = Schema.decodeUnknownEffect(Schema.Array(DurableFillRow), strictParseOptions)
const decodeProjectedPositions = Schema.decodeUnknownEffect(Schema.Array(ProjectedPositionRow), strictParseOptions)
const decodeOpeningCash = Schema.decodeUnknownEffect(OpeningCashRow, strictParseOptions)
const decodeTransactions = Schema.decodeUnknownEffect(Schema.Array(AccountingTransactionRowSchema), strictParseOptions)
const decodeReceipts = Schema.decodeUnknownEffect(Schema.Array(AccountingReceiptRowSchema), strictParseOptions)
const decodePreviousReconciliation = Schema.decodeUnknownEffect(PreviousReconciliationRows, strictParseOptions)
const decodeContent = Schema.decodeUnknownEffect(ReconciliationContentRow, strictParseOptions)
const encodeDiscrepancies = Schema.encodeSync(Schema.fromJsonString(Schema.Array(DiscrepancySchema)))

const attempt = <A>(evaluate: () => A): Effect.Effect<A, unknown> =>
  Effect.try({ try: evaluate, catch: (cause) => cause })

const unresolvedEvents = new Set<MutationEventType>([
  MutationEventType.SubmitStarted,
  MutationEventType.SubmitUnknown,
  MutationEventType.RecoveryNotFound,
  MutationEventType.RecoveryUnknown,
  MutationEventType.CancelStarted,
  MutationEventType.CancelAccepted,
  MutationEventType.CancelUnknown,
])

const receiptMaterial = (receipt: AccountingReceipt) => ({
  schemaVersion: receipt.schemaVersion,
  ...(receipt.intentId === undefined ? {} : { intentId: receipt.intentId }),
  brokerEventId: receipt.brokerEventId,
  tigerBeetleClusterId: receipt.tigerBeetleClusterId,
  tigerBeetleLedger: receipt.tigerBeetleLedger,
  accountIds: receipt.accountIds,
  transferIds: receipt.transferIds,
  debitMicros: receipt.debitMicros,
  creditMicros: receipt.creditMicros,
})

const receiptIsExact = (
  transaction: AccountingTransaction,
  receipt: AccountingReceipt | undefined,
  plan: ReturnType<typeof rebuildAccountingLedger>,
  config: Pick<RuntimeConfig, 'tigerBeetle'>,
): boolean => {
  if (receipt === undefined) return false
  const accountIds = plan.accounts.map((account) => account.id.toString())
  const transferIds = plan.transfers.map((transfer) => transfer.id.toString())
  const posted = plan.transfers.reduce((sum, transfer) => sum + transfer.amount, 0n).toString()
  return (
    receipt.brokerEventId === transaction.brokerEventId &&
    receipt.intentId === transaction.intentId &&
    receipt.tigerBeetleClusterId === config.tigerBeetle.clusterId.toString() &&
    receipt.tigerBeetleLedger === config.tigerBeetle.ledger &&
    receipt.debitMicros === posted &&
    receipt.creditMicros === posted &&
    receipt.accountIds.length === accountIds.length &&
    receipt.accountIds.every((value, index) => value === accountIds[index]) &&
    receipt.transferIds.length === transferIds.length &&
    receipt.transferIds.every((value, index) => value === transferIds[index]) &&
    canonicalHashV1(receiptMaterial(receipt)) === receipt.contentHash
  )
}

export const restrictAuthority = (
  sql: PgClient.PgClient,
  reason: string,
  updatedAt: string,
): Effect.Effect<void, unknown> =>
  sql`
    UPDATE authority_state
    SET
      effective = 'OBSERVE',
      kill_state = 'ACTIVE',
      reason = ${reason},
      version = version + 1,
      updated_at = ${updatedAt}
    WHERE singleton
      AND (effective <> 'OBSERVE' OR kill_state <> 'ACTIVE')
  `.pipe(Effect.asVoid)

export const makeReconciliation = (
  sql: PgClient.PgClient,
  journal: JournalService,
  config: Pick<RuntimeConfig, 'tigerBeetle'>,
) => {
  const bindings = (accountId: string): Effect.Effect<readonly IntentBinding[], unknown> =>
    sql<Record<string, unknown>>`
      SELECT intent_id, client_order_id
      FROM intents
      WHERE account_id = ${accountId}
      ORDER BY client_order_id
    `.pipe(
      Effect.flatMap(decodeBindings),
      Effect.map((rows) => rows.map((row) => ({ intentId: row.intent_id, clientOrderId: row.client_order_id }))),
    )

  const reconcile = (snapshot: BrokerSnapshot): Effect.Effect<ReconciliationReport, unknown> =>
    sql.withTransaction(
      Effect.gen(function* () {
        const accountId = snapshot.account.accountId
        yield* sql`SELECT pg_advisory_xact_lock(hashtextextended(${`ALPACA:${accountId}`}, 0))`

        const intentRows = yield* sql<Record<string, unknown>>`
          SELECT
            intent.intent_id,
            intent.client_order_id,
            intent.symbol,
            intent.side,
            intent.order_type,
            intent.time_in_force,
            intent.quantity_micros::text AS quantity_micros,
            intent.state,
            intent.terminal_outcome,
            accepted.broker_order_id,
            latest.operation AS mutation_operation,
            latest.event_type AS mutation_event_type,
            to_char(latest.occurred_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS mutation_occurred_at
          FROM intents AS intent
          LEFT JOIN LATERAL (
            SELECT operation, event_type, occurred_at
            FROM mutation_events
            WHERE intent_id = intent.intent_id
            ORDER BY
              CASE operation WHEN 'CANCEL' THEN 1 ELSE 0 END DESC,
              sequence DESC
            LIMIT 1
          ) AS latest ON true
          LEFT JOIN LATERAL (
            SELECT broker_order_id
            FROM mutation_events
            WHERE intent_id = intent.intent_id AND broker_order_id IS NOT NULL
            ORDER BY
              CASE operation WHEN 'CANCEL' THEN 1 ELSE 0 END DESC,
              sequence DESC
            LIMIT 1
          ) AS accepted ON true
          WHERE intent.account_id = ${accountId}
          ORDER BY intent.client_order_id
        `.pipe(Effect.flatMap(decodeIntents))
        const intents: IntentExpectation[] = intentRows.map((row) => ({
          intentId: row.intent_id,
          clientOrderId: row.client_order_id,
          symbol: row.symbol,
          side: row.side,
          orderType: row.order_type,
          timeInForce: row.time_in_force,
          quantityMicros: row.quantity_micros,
          state: row.state,
          ...(row.terminal_outcome === null ? {} : { terminalOutcome: row.terminal_outcome }),
          expectsBrokerOrder: row.broker_order_id !== null,
          ...(row.broker_order_id === null ? {} : { brokerOrderId: row.broker_order_id }),
          ...(row.mutation_event_type !== null &&
          (unresolvedEvents.has(row.mutation_event_type) ||
            (row.mutation_operation === MutationOperation.Cancel &&
              row.mutation_event_type === MutationEventType.RecoveryFound &&
              row.state !== IntentState.Terminal)) &&
          row.mutation_occurred_at !== null
            ? { unknownSince: row.mutation_occurred_at }
            : {}),
        }))

        const transactionRows = yield* sql<Record<string, unknown>>`
          SELECT
            schema_version, transaction_id, broker_event_id, intent_id, account_id, symbol, side,
            quantity_micros::text AS quantity_micros, price_micros::text AS price_micros,
            notional_micros::text AS notional_micros, fee_micros::text AS fee_micros,
            cost_basis_micros::text AS cost_basis_micros, realized_pnl_micros::text AS realized_pnl_micros,
            quantity_delta_micros::text AS quantity_delta_micros,
            cost_basis_delta_micros::text AS cost_basis_delta_micros,
            cash_delta_micros::text AS cash_delta_micros, ledger_plan_hash, content_hash, occurred_at
          FROM accounting_transactions
          WHERE account_id = ${accountId}
          ORDER BY occurred_at, transaction_id
        `.pipe(Effect.flatMap(decodeTransactions))
        const transactions = transactionRows.map(accountingTransactionFromRow)
        const receiptRows = yield* sql<Record<string, unknown>>`
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
          WHERE broker_event_id IN (SELECT broker_event_id FROM accounting_transactions WHERE account_id = ${accountId})
          ORDER BY broker_event_id
        `.pipe(Effect.flatMap(decodeReceipts))
        const receipts = yield* Effect.forEach(receiptRows, (row) =>
          decodeAccountingReceipt(accountingReceiptFromRow(row)),
        )
        const { exactReceipts, plans } = yield* attempt(() => {
          const receiptsByEvent = new Map(receipts.map((receipt) => [receipt.brokerEventId, receipt]))
          if (receiptsByEvent.size !== receipts.length) throw new Error('duplicate accounting receipt broker event')
          const plans = transactions.map((transaction) =>
            rebuildAccountingLedger(transaction, config.tigerBeetle.ledger),
          )
          const exactReceipts = new Map(
            transactions.map((transaction, index) => [
              transaction.brokerEventId,
              receiptIsExact(transaction, receiptsByEvent.get(transaction.brokerEventId), plans[index], config),
            ]),
          )
          return { exactReceipts, plans }
        })
        const ledgerExact = yield* journal.verifyAccount(accountId, plans)

        const durableFillRows = yield* sql<Record<string, unknown>>`
          SELECT
            fill.fill_id,
            fill.broker_order_id,
            fill.event_id AS broker_event_id,
            transaction.transaction_id,
            receipt.receipt_id
          FROM fills AS fill
          LEFT JOIN accounting_transactions AS transaction ON transaction.broker_event_id = fill.event_id
          LEFT JOIN accounting_receipts AS receipt ON receipt.broker_event_id = fill.event_id
          WHERE fill.account_id = ${accountId}
          ORDER BY fill.fill_id
        `.pipe(Effect.flatMap(decodeDurableFills))
        const durableFills = durableFillRows.map((row) => ({
          fillId: row.fill_id,
          brokerOrderId: row.broker_order_id,
          accounted:
            row.transaction_id !== null && row.receipt_id !== null && exactReceipts.get(row.broker_event_id) === true,
        }))

        const projectedPositionRows = yield* sql<Record<string, unknown>>`
          SELECT
            symbol,
            sum(quantity_delta_micros)::text AS quantity_micros,
            sum(cost_basis_delta_micros)::text AS cost_basis_micros
          FROM accounting_transactions
          WHERE account_id = ${accountId}
          GROUP BY symbol
          HAVING sum(quantity_delta_micros) <> 0
          ORDER BY symbol
        `.pipe(Effect.flatMap(decodeProjectedPositions))
        const projectedPositions = projectedPositionRows.map((row) => ({
          symbol: row.symbol,
          quantityMicros: row.quantity_micros,
          costBasisMicros: row.cost_basis_micros,
        }))

        const [openingCash] = yield* sql<Record<string, unknown>>`
          SELECT
            snapshot.cash_micros::text AS cash_micros,
            to_char(event.observed_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS observed_at
          FROM account_snapshots AS snapshot
          JOIN broker_events AS event ON event.event_id = snapshot.event_id
          WHERE snapshot.account_id = ${accountId}
          ORDER BY event.source_sequence
          LIMIT 1
        `.pipe(Effect.flatMap(decodeOpeningCash))
        const comparison = yield* attempt(() => {
          if (transactions.some((transaction) => transaction.occurredAt < openingCash.observed_at)) {
            throw new Error('paper accounting predates the opening cash snapshot')
          }
          const expectedCashMicros = transactions
            .reduce((cash, transaction) => cash + BigInt(transaction.cashDeltaMicros), BigInt(openingCash.cash_micros))
            .toString()
          const accountingHash = canonicalHashV1({
            schemaVersion: 'bayn.paper-accounting-state.v1',
            accountId,
            openingCash,
            transactions,
            receipts,
            ledgerExact,
          })
          const stateHash = reconciledStateHash({
            account: snapshot.account,
            positions: snapshot.positions,
            positionsObservedAt: snapshot.positionsObservedAt,
            orders: snapshot.orders,
            ordersObservedAt: snapshot.ordersObservedAt,
            accountingHash,
          })
          return compareReconciliation({
            accountId,
            stateHash,
            account: snapshot.account,
            positions: snapshot.positions,
            orders: snapshot.orders,
            fills: snapshot.fills,
            intents,
            durableFills,
            projectedPositions,
            expectedCashMicros,
            valuation: snapshot.valuation,
            accountingHash,
            ledgerExact,
            reconciledAt: snapshot.reconciledAt,
          })
        })

        const [previous] = yield* sql<Record<string, unknown>>`
          SELECT discrepancies
          FROM reconciliations
          WHERE account_id = ${accountId}
          ORDER BY reconciled_at DESC, reconciliation_id DESC
          LIMIT 1
        `.pipe(Effect.flatMap(decodePreviousReconciliation))
        const { contentHash, discrepancies, reconciliationId, reconciliationMaterial, status } = yield* attempt(() => {
          const prior = new Map((previous?.discrepancies ?? []).map((value) => [value.discrepancyId, value]))
          const status =
            comparison.discrepancies.length === 0 ? ReconciliationStatus.Exact : ReconciliationStatus.Discrepancy
          const discrepancies: Discrepancy[] = comparison.discrepancies.map((value) => ({
            ...value,
            firstObservedAt: prior.get(value.discrepancyId)?.firstObservedAt ?? snapshot.reconciledAt,
            lastObservedAt: snapshot.reconciledAt,
          }))
          const reconciliationMaterial = {
            schemaVersion: 'bayn.paper-reconciliation.v1' as const,
            accountId,
            expectedHash: comparison.expectedHash,
            observedHash: comparison.observedHash,
            status,
            discrepancies,
            reconciledAt: snapshot.reconciledAt,
          }
          const reconciliationId = canonicalHashV1({
            schemaVersion: 'bayn.paper-reconciliation-id.v1',
            material: reconciliationMaterial,
          })
          const contentHash = canonicalHashV1({ ...reconciliationMaterial, reconciliationId })
          return { contentHash, discrepancies, reconciliationId, reconciliationMaterial, status }
        })
        const reconciliation = yield* decodeReconciliation({
          schemaVersion: reconciliationMaterial.schemaVersion,
          reconciliationId,
          accountId,
          expectedHash: comparison.expectedHash,
          observedHash: comparison.observedHash,
          contentHash,
          status,
          discrepancies,
          reconciledAt: snapshot.reconciledAt,
        })
        yield* sql`
          INSERT INTO reconciliations (
            reconciliation_id, schema_version, account_id, expected_hash, observed_hash,
            content_hash, status, discrepancies, reconciled_at
          ) VALUES (
            ${reconciliation.reconciliationId}, ${reconciliation.schemaVersion}, ${reconciliation.accountId},
            ${reconciliation.expectedHash}, ${reconciliation.observedHash}, ${reconciliation.contentHash},
            ${reconciliation.status}, ${sql.json(encodeDiscrepancies(reconciliation.discrepancies))},
            ${reconciliation.reconciledAt}
          )
          ON CONFLICT (reconciliation_id) DO NOTHING
        `
        const [stored] = yield* sql<Record<string, unknown>>`
          SELECT content_hash FROM reconciliations WHERE reconciliation_id = ${reconciliationId}
        `.pipe(Effect.flatMap(decodeContent))
        if (stored.content_hash !== contentHash) {
          return yield* Effect.fail(new Error('stored reconciliation differs from deterministic replay'))
        }

        if (comparison.discrepancies.length > 0) {
          yield* restrictAuthority(sql, `reconciliation discrepancy ${reconciliationId}`, snapshot.reconciledAt)
        }

        return { reconciliation, metrics: comparison.metrics }
      }),
    )

  return { bindings, reconcile }
}
