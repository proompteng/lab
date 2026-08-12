import { PgClient } from '@effect/sql-pg'
import { Data, Effect, Result, Schema } from 'effect'

import type { AccountingTransaction } from '../accounting/schema'
import { MutationOperation } from '../broker/alpaca-mutations'
import type { RuntimeConfig } from '../config'
import type { JournalService } from '../ledger'
import {
  Authority,
  DiscrepancySchema,
  IntentState,
  KillState,
  OrderSide,
  OrderType,
  SignedMicrosSchema,
  TerminalOutcome,
  TimeInForce,
  UnsignedMicrosSchema,
  decodeAccountingReceipt,
  type AccountSnapshot,
  type AccountingReceipt,
  type Fill,
  type Order,
  type Position,
  type Reconciliation,
  type Valuation,
} from '../execution/contracts'
import {
  type IntentExpectation,
  type ReconciliationComparison,
  type ReconciliationMetrics,
  type ReconciliationRiskContext,
} from '../reconciliation'
import { isPaperEpisodeFailureRestriction } from '../paper-episode'
import {
  IsoDateSchema,
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
import {
  compareOpeningCash,
  decideReconciliation,
  projectIntentExpectations,
  reconciliationAlgebraFailureDetails,
  riskContextFromRow,
  validateReconciliationReadback,
  verifyAccountingReceipts,
  type ReconciliationAlgebraFailure,
} from './reconciliation-algebra'
import { Pipeable } from '../pipeable'

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

export interface ReconciliationWriteResult extends ReconciliationReport {
  readonly accountingHash: string
  readonly riskContext: ReconciliationRiskContext
}

interface AccountingReadPhase {
  readonly intents: readonly IntentExpectation[]
  readonly unknownMutationCount: number
  readonly transactions: readonly AccountingTransaction[]
  readonly receipts: readonly AccountingReceipt[]
  readonly exactReceipts: ReadonlyMap<string, boolean>
  readonly ledgerExact: boolean
}

interface ComparisonReadPhase {
  readonly accountingHash: string
  readonly comparison: ReconciliationComparison
}

export class ReconciliationStoreError extends Data.TaggedError('ReconciliationStoreError')<{
  readonly operation: 'bindings' | 'reconcile' | 'restrict-authority' | 'risk-context'
  readonly failure: 'decode' | 'invariant' | 'ledger' | 'query'
  readonly message: string
  readonly cause?: unknown
}> {}

const IntentBindingRow = Schema.Struct({ intent_id: Sha256, client_order_id: NonEmptyString })
const IntentRow = Schema.Struct({
  intent_id: Sha256,
  client_order_id: NonEmptyString,
  symbol: Schema.String,
  side: Schema.Enum(OrderSide),
  order_type: Schema.Enum(OrderType),
  time_in_force: Schema.Enum(TimeInForce),
  quantity_micros: Schema.String,
  notional_limit_micros: Schema.String,
  state: Schema.Enum(IntentState),
  terminal_outcome: Schema.NullOr(Schema.Enum(TerminalOutcome)),
  broker_order_id: Schema.NullOr(NonEmptyString),
  mutation_operation: Schema.NullOr(Schema.Enum(MutationOperation)),
  mutation_event_type: Schema.NullOr(Schema.Enum(MutationEventType)),
  mutation_occurred_at: Schema.NullOr(UtcInstant),
  submit_request_hash: Schema.NullOr(Sha256),
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
const ReconciliationRiskContextRow = Schema.Tuple([
  Schema.Struct({
    trading_date: IsoDateSchema,
    authority_schema_version: Schema.NullOr(Schema.Literal('bayn.paper-authority.v1')),
    authority_generation_hash: Schema.NullOr(Sha256),
    authority_maximum: Schema.NullOr(Schema.Enum(Authority)),
    authority_effective: Schema.NullOr(Schema.Enum(Authority)),
    authority_kill: Schema.NullOr(Schema.Enum(KillState)),
    authority_reason: Schema.NullOr(NonEmptyString),
    authority_version: Schema.NullOr(Schema.String),
    authority_updated_at: Schema.NullOr(Schema.Date),
    authority_observed_at: Schema.NullOr(Schema.Date),
    daily_traded_notional_micros: UnsignedMicrosSchema,
    day_start_equity_micros: SignedMicrosSchema,
    peak_equity_micros: SignedMicrosSchema,
  }),
])

const decodeBindings = Schema.decodeUnknownEffect(Schema.Array(IntentBindingRow), strictParseOptions)
const decodeIntents = Schema.decodeUnknownEffect(Schema.Array(IntentRow), strictParseOptions)
const decodeDurableFills = Schema.decodeUnknownEffect(Schema.Array(DurableFillRow), strictParseOptions)
const decodeProjectedPositions = Schema.decodeUnknownEffect(Schema.Array(ProjectedPositionRow), strictParseOptions)
const decodeOpeningCash = Schema.decodeUnknownEffect(OpeningCashRow, strictParseOptions)
const decodeTransactions = Schema.decodeUnknownEffect(Schema.Array(AccountingTransactionRowSchema), strictParseOptions)
const decodeReceipts = Schema.decodeUnknownEffect(Schema.Array(AccountingReceiptRowSchema), strictParseOptions)
const decodePreviousReconciliation = Schema.decodeUnknownEffect(PreviousReconciliationRows, strictParseOptions)
const decodeContent = Schema.decodeUnknownEffect(ReconciliationContentRow, strictParseOptions)
const decodeRiskContext = Schema.decodeUnknownEffect(ReconciliationRiskContextRow, strictParseOptions)
const encodeDiscrepancies = Schema.encodeSync(Schema.fromJsonString(Schema.Array(DiscrepancySchema)))

const storeError = (
  operation: ReconciliationStoreError['operation'],
  failure: ReconciliationStoreError['failure'],
  message: string,
  cause?: unknown,
): ReconciliationStoreError => new ReconciliationStoreError({ operation, failure, message, cause })

const runStore = <A, E, R>(
  operation: ReconciliationStoreError['operation'],
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<A, ReconciliationStoreError, R> =>
  effect.pipe(
    Effect.mapError((cause) => {
      if (cause instanceof ReconciliationStoreError) return cause
      return storeError(
        operation,
        Schema.isSchemaError(cause) ? 'decode' : 'query',
        `paper reconciliation ${operation} failed`,
        cause,
      )
    }),
  )

const attempt = <A>(
  operation: ReconciliationStoreError['operation'],
  evaluate: () => A,
): Result.Result<A, ReconciliationStoreError> =>
  Result.try({
    try: evaluate,
    catch: (cause) => storeError(operation, 'invariant', `paper reconciliation ${operation} invariant failed`, cause),
  })

const isTransientReconciliationRestriction = (reason: string | null): boolean =>
  reason === 'reconciliation pass incomplete' || reason?.startsWith('reconciliation discrepancy ') === true

const shouldPromoteRestrictionReason = (currentReason: string | null, nextReason: string): boolean =>
  isTransientReconciliationRestriction(currentReason) && isPaperEpisodeFailureRestriction(nextReason)

const fromDecision = <A>(
  operation: ReconciliationStoreError['operation'],
  decision: Result.Result<A, ReconciliationAlgebraFailure>,
): Effect.Effect<A, ReconciliationStoreError> =>
  Effect.fromResult(decision).pipe(
    Effect.mapError((failure) => {
      const details = reconciliationAlgebraFailureDetails(failure)
      return storeError(operation, details.failure, details.message, details.cause)
    }),
  )

const restrictAuthorityDataFirst = (
  sql: PgClient.PgClient,
  reason: string,
  updatedAt: string,
): Effect.Effect<void, ReconciliationStoreError> =>
  runStore(
    'restrict-authority',
    sql.withTransaction(
      Effect.gen(function* () {
        yield* sql`
          SELECT pg_advisory_xact_lock(
            hashtextextended('bayn.paper-authority-generation.v1', 0)
          )
        `
        const existing = yield* sql<{
          effective: Authority
          kill_state: KillState
          reason: string | null
        }>`
          SELECT effective, kill_state, reason
          FROM authority_state
          WHERE singleton
          FOR UPDATE
        `
        const state = existing[0]
        if (state === undefined) {
          return yield* storeError(
            'restrict-authority',
            'invariant',
            'authority restriction requires initialized durable authority state',
          )
        }
        const isRestricted = state.effective === Authority.Observe && state.kill_state === KillState.Active
        const promoteReason = isRestricted && shouldPromoteRestrictionReason(state.reason, reason)
        if (isRestricted && !promoteReason) return

        const restricted = yield* sql<Record<string, unknown>>`
          UPDATE authority_state
          SET
            effective = 'OBSERVE',
            kill_state = 'ACTIVE',
            reason = ${reason},
            version = version + 1,
            updated_at = greatest(
              ${updatedAt}::timestamptz,
              updated_at + interval '1 millisecond'
            )
          WHERE singleton
          RETURNING singleton
        `
        if (restricted.length !== 1) {
          return yield* storeError('restrict-authority', 'invariant', 'authority restriction was not durably applied')
        }
      }),
    ),
  )

export const restrictAuthority = Pipeable.dual(3, restrictAuthorityDataFirst)

const makeReconciliationDataFirst = (
  sql: PgClient.PgClient,
  journal: JournalService,
  config: Pick<RuntimeConfig, 'tigerBeetle'>,
) => {
  const bindings = (accountId: string): Effect.Effect<readonly IntentBinding[], ReconciliationStoreError> =>
    runStore(
      'bindings',
      sql<Record<string, unknown>>`
        SELECT intent_id, client_order_id
        FROM intents
        WHERE account_id = ${accountId}
        ORDER BY client_order_id COLLATE "C"
      `.pipe(
        Effect.flatMap(decodeBindings),
        Effect.map((rows) => rows.map((row) => ({ intentId: row.intent_id, clientOrderId: row.client_order_id }))),
      ),
    )

  const readAccountingPhase = (accountId: string): Effect.Effect<AccountingReadPhase, ReconciliationStoreError> =>
    runStore(
      'reconcile',
      Effect.gen(function* () {
        const intentRows = yield* sql<Record<string, unknown>>`
          SELECT
            intent.intent_id,
            intent.client_order_id,
            intent.symbol,
            intent.side,
            intent.order_type,
            intent.time_in_force,
            intent.quantity_micros::text AS quantity_micros,
            intent.notional_limit_micros::text AS notional_limit_micros,
            intent.state,
            intent.terminal_outcome,
            accepted.broker_order_id,
            latest.operation AS mutation_operation,
            latest.event_type AS mutation_event_type,
            to_char(latest.occurred_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS mutation_occurred_at,
            submitted.request_hash AS submit_request_hash
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
          LEFT JOIN LATERAL (
            SELECT request_hash
            FROM mutation_events
            WHERE intent_id = intent.intent_id AND operation = 'SUBMIT'
            ORDER BY sequence DESC
            LIMIT 1
          ) AS submitted ON true
          WHERE intent.account_id = ${accountId}
          ORDER BY intent.client_order_id COLLATE "C"
        `.pipe(Effect.flatMap(decodeIntents))
        const { intents, unknownMutationCount } = yield* fromDecision(
          'reconcile',
          projectIntentExpectations(intentRows),
        )

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
          ORDER BY occurred_at, transaction_id COLLATE "C"
        `.pipe(Effect.flatMap(decodeTransactions))
        const transactions = yield* Effect.fromResult(
          attempt('reconcile', () => transactionRows.map(accountingTransactionFromRow)),
        )
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
          ORDER BY broker_event_id COLLATE "C"
        `.pipe(Effect.flatMap(decodeReceipts))
        const receipts = yield* Effect.forEach(receiptRows, (row) =>
          decodeAccountingReceipt(accountingReceiptFromRow(row)),
        )
        const { exactReceipts, plans } = yield* fromDecision(
          'reconcile',
          verifyAccountingReceipts(transactions, receipts, config),
        )
        const ledgerExact = yield* journal
          .verifyAccount(accountId, plans)
          .pipe(
            Effect.mapError((cause) =>
              storeError('reconcile', 'ledger', 'TigerBeetle account verification failed during reconciliation', cause),
            ),
          )

        return { intents, unknownMutationCount, transactions, receipts, exactReceipts, ledgerExact }
      }),
    )

  const readComparisonPhase = (
    accountId: string,
    snapshot: BrokerSnapshot,
    accounting: AccountingReadPhase,
  ): Effect.Effect<ComparisonReadPhase, ReconciliationStoreError> =>
    runStore(
      'reconcile',
      Effect.gen(function* () {
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
          ORDER BY fill.fill_id COLLATE "C"
        `.pipe(Effect.flatMap(decodeDurableFills))
        const durableFills = durableFillRows.map((row) => ({
          fillId: row.fill_id,
          brokerOrderId: row.broker_order_id,
          accounted:
            row.transaction_id !== null &&
            row.receipt_id !== null &&
            accounting.exactReceipts.get(row.broker_event_id) === true,
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
          ORDER BY symbol COLLATE "C"
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
        return yield* fromDecision(
          'reconcile',
          compareOpeningCash({
            accountId,
            openingCash,
            transactions: accounting.transactions,
            receipts: accounting.receipts,
            ledgerExact: accounting.ledgerExact,
            snapshot,
            intents: accounting.intents,
            durableFills,
            projectedPositions,
          }),
        )
      }),
    )

  const writeReconciliationPhase = (
    accountId: string,
    comparison: ReconciliationComparison,
    reconciledAt: string,
  ): Effect.Effect<Reconciliation, ReconciliationStoreError> =>
    runStore(
      'reconcile',
      Effect.gen(function* () {
        const [previous] = yield* sql<Record<string, unknown>>`
          SELECT discrepancies
          FROM reconciliations
          WHERE account_id = ${accountId}
          ORDER BY reconciled_at DESC, reconciliation_id COLLATE "C" DESC
          LIMIT 1
        `.pipe(Effect.flatMap(decodePreviousReconciliation))
        const reconciliation = yield* fromDecision(
          'reconcile',
          decideReconciliation({
            accountId,
            comparison,
            previous: previous?.discrepancies ?? [],
            reconciledAt,
          }),
        )
        const encodedDiscrepancies = yield* Effect.fromResult(
          attempt('reconcile', () => encodeDiscrepancies(reconciliation.discrepancies)),
        )
        yield* sql`
          INSERT INTO reconciliations (
            reconciliation_id, schema_version, account_id, expected_hash, observed_hash,
            content_hash, status, discrepancies, reconciled_at
          ) VALUES (
            ${reconciliation.reconciliationId}, ${reconciliation.schemaVersion}, ${reconciliation.accountId},
            ${reconciliation.expectedHash}, ${reconciliation.observedHash}, ${reconciliation.contentHash},
            ${reconciliation.status}, ${sql.json(encodedDiscrepancies)},
            ${reconciliation.reconciledAt}
          )
          ON CONFLICT (reconciliation_id) DO NOTHING
          `
        const [stored] = yield* sql<Record<string, unknown>>`
          SELECT content_hash FROM reconciliations WHERE reconciliation_id = ${reconciliation.reconciliationId}
        `.pipe(Effect.flatMap(decodeContent))
        yield* fromDecision('reconcile', validateReconciliationReadback(reconciliation, stored.content_hash))

        if (reconciliation.discrepancies.length > 0) {
          yield* restrictAuthority(sql, `reconciliation discrepancy ${reconciliation.reconciliationId}`, reconciledAt)
        }
        return reconciliation
      }),
    )

  const readRiskContextPhase = (
    accountId: string,
    reconciledAt: string,
    unknownMutationCount: number,
  ): Effect.Effect<ReconciliationRiskContext, ReconciliationStoreError> =>
    runStore(
      'reconcile',
      Effect.gen(function* () {
        const [riskContextRow] = yield* sql<Record<string, unknown>>`
          WITH boundary AS (
            SELECT (${reconciledAt}::timestamptz AT TIME ZONE 'America/New_York')::date AS trading_date
          )
          SELECT
            boundary.trading_date::text AS trading_date,
            authority.schema_version AS authority_schema_version,
            authority.generation_hash AS authority_generation_hash,
            authority.maximum AS authority_maximum,
            authority.effective AS authority_effective,
            authority.kill_state AS authority_kill,
            authority.reason AS authority_reason,
            authority.version::text AS authority_version,
            authority.updated_at AS authority_updated_at,
            CASE WHEN authority.singleton IS NULL THEN NULL ELSE clock_timestamp() END AS authority_observed_at,
            coalesce((
              SELECT sum(transaction.notional_micros)::text
              FROM accounting_transactions AS transaction
              WHERE transaction.account_id = ${accountId}
                AND transaction.occurred_at <= ${reconciledAt}
                AND (transaction.occurred_at AT TIME ZONE 'America/New_York')::date = boundary.trading_date
            ), '0') AS daily_traded_notional_micros,
            (
              SELECT valuation.equity_micros::text
              FROM valuations AS valuation
              WHERE valuation.account_id = ${accountId}
                AND valuation.as_of <= ${reconciledAt}
                AND (valuation.as_of AT TIME ZONE 'America/New_York')::date = boundary.trading_date
              ORDER BY valuation.as_of, valuation.valuation_id COLLATE "C"
              LIMIT 1
            ) AS day_start_equity_micros,
            (
              SELECT max(valuation.equity_micros)::text
              FROM valuations AS valuation
              WHERE valuation.account_id = ${accountId}
                AND valuation.as_of <= ${reconciledAt}
            ) AS peak_equity_micros
          FROM boundary
          LEFT JOIN authority_state AS authority ON authority.singleton
        `.pipe(Effect.flatMap(decodeRiskContext))
        return yield* fromDecision('risk-context', riskContextFromRow(riskContextRow, unknownMutationCount))
      }),
    )

  const reconcileTransaction = (
    snapshot: BrokerSnapshot,
  ): Effect.Effect<ReconciliationWriteResult, ReconciliationStoreError> =>
    runStore(
      'reconcile',
      Effect.gen(function* () {
        const accountId = snapshot.account.accountId
        yield* sql`SELECT pg_advisory_xact_lock(hashtextextended(${`ALPACA:${accountId}`}, 0))`
        const accounting = yield* readAccountingPhase(accountId)
        const { accountingHash, comparison } = yield* readComparisonPhase(accountId, snapshot, accounting)
        const reconciliation = yield* writeReconciliationPhase(accountId, comparison, snapshot.reconciledAt)
        const riskContext = yield* readRiskContextPhase(
          accountId,
          snapshot.reconciledAt,
          accounting.unknownMutationCount,
        )
        return { reconciliation, metrics: comparison.metrics, accountingHash, riskContext }
      }),
    )

  const reconcile = (snapshot: BrokerSnapshot): Effect.Effect<ReconciliationWriteResult, ReconciliationStoreError> =>
    runStore('reconcile', sql.withTransaction(reconcileTransaction(snapshot)))

  return { bindings, reconcile }
}

export const makeReconciliation = Pipeable.dual(3, makeReconciliationDataFirst)
