import { PgClient } from '@effect/sql-pg'
import { databaseUtcInstant, postgresWallClock, type DatabaseClock } from './clock'
import { Data, Effect, Option, Result, Schema } from 'effect'
import {
  CryptoFeeTierSchema,
  cryptoTakerFeeBps,
  effectiveCryptoFeeTier,
  type CryptoTakerFeeBps,
} from '../broker/crypto-fees'

import type { AccountingTransaction } from '../accounting/schema'
import { MutationOperation } from '../broker/alpaca-mutations/model'
import type { RuntimeConfig } from '../config/model'
import { WriterFenceError, type WriterFenceService } from '../execution/writer-fence'
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
  NativeProtectionSchema,
  type NativeProtection,
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
} from '../simulation-reconciliation/broker-model'
import {
  isExecutionMandateFailureRestriction,
  isExecutionMandateRecoveryRestriction,
  isRetiredOneShotMandateRestriction,
} from '../execution/mandate'
import {
  IsoDateSchema,
  Sha256Schema as Sha256,
  StrictNonEmptyStringSchema as NonEmptyString,
  UtcInstantSchema as UtcInstant,
  UtcDatabaseInstantSchema,
  UtcOrderTimestampSchema,
  strictParseOptions,
} from '../schemas'
import { MutationEventType } from '../execution/mutations/model'
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
} from '../reconciliation/algebra'

import { retainAccountCashReporting, readOpeningCash } from './account-baseline'
import { firstSessionEquityQuery, peakEquityQuery } from './risk-valuation-query'
import { postCashSettlements, prepareCashSettlements, type CashSettlementAccounting } from './cash-settlements'
import type { CashReportingQuantum } from '../broker/alpaca/cash-reporting'
import { prepareFeeActivities, postBrokerFeePlans, type BrokerFeeAccounting } from './broker-fees'
import {
  cashAccrualReportingOffsetMicros,
  prepareObservedCoinFees,
  prepareObservedCashFees,
  readFeeAccruals,
  type FeeAccrualRecords,
} from './fee-accruals'
import type { FeeAccrual } from '../accounting/fee-accrual'
import type { FeeActivity } from '../broker/alpaca/model'
import type { Observed } from '../simulation-reconciliation/broker-reconciler-model'
import type { BrokerStateVersion } from '../execution/broker-state-cache'
import { withObservedStage } from '../telemetry'

export interface IntentBinding {
  readonly intentId: string
  readonly clientOrderId: string
  readonly symbol?: string
  readonly quantityAtoms?: string
  readonly protection?: NativeProtection
}

export interface BrokerSnapshot {
  readonly account: AccountSnapshot
  readonly cashReportingQuantumMicros: CashReportingQuantum
  readonly positions: readonly Position[]
  readonly positionsObservedAt: string
  readonly positionSnapshotId: string
  readonly accountEventId: string
  readonly orders: readonly Order[]
  readonly ordersObservedAt: string
  readonly fills: readonly Fill[]
  readonly fees: readonly Observed<FeeActivity>[]
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

export interface ReconciledBrokerSnapshot {
  readonly snapshot: BrokerSnapshot
  readonly persisted: ReconciliationWriteResult
}

interface AccountingReadPhase {
  readonly intents: readonly IntentExpectation[]
  readonly unknownMutationCount: number
  readonly transactions: readonly AccountingTransaction[]
  readonly receipts: readonly AccountingReceipt[]
  readonly exactReceipts: ReadonlyMap<string, boolean>
  readonly ledgerExact: boolean
  readonly fees: readonly FeeActivity[]
  readonly accruals: readonly FeeAccrual[]
  readonly brokerFeeCashDeltaMicros: string
  readonly cashReportingOffsetMicros: string
  readonly cashSettlements: CashSettlementAccounting
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

const IntentBindingRow = Schema.Struct({
  intent_id: Sha256,
  client_order_id: NonEmptyString,
  symbol: Schema.String,
  quantity_atoms: Schema.String,
  protection: Schema.NullOr(NativeProtectionSchema),
})
const IntentRow = Schema.Struct({
  intent_id: Sha256,
  client_order_id: NonEmptyString,
  symbol: Schema.String,
  side: Schema.Enum(OrderSide),
  order_type: Schema.Enum(OrderType),
  time_in_force: Schema.Enum(TimeInForce),
  quantity_atoms: Schema.String,
  notional_limit_micros: Schema.String,
  state: Schema.Enum(IntentState),
  terminal_outcome: Schema.NullOr(Schema.Enum(TerminalOutcome)),
  broker_order_id: Schema.NullOr(NonEmptyString),
  mutation_operation: Schema.NullOr(Schema.Enum(MutationOperation)),
  mutation_event_type: Schema.NullOr(Schema.Enum(MutationEventType)),
  mutation_occurred_at: Schema.NullOr(UtcInstant),
  submit_request_hash: Schema.NullOr(Sha256),
  submit_request_body: Schema.Unknown,
})
const ProtectionChildRow = Schema.Struct({
  intent_id: Sha256,
  broker_order_id: NonEmptyString,
  client_order_id: NonEmptyString,
  parent_broker_order_id: NonEmptyString,
  symbol: Schema.String,
  quantity_atoms: Schema.String,
  order_type: Schema.Literals([OrderType.Limit, OrderType.StopLimit]),
  protection: NativeProtectionSchema,
})

const DurableFillRow = Schema.Struct({
  source_timestamp: UtcOrderTimestampSchema,
  fill_id: NonEmptyString,
  broker_order_id: NonEmptyString,
  broker_event_id: Sha256,
  transaction_id: Schema.NullOr(Sha256),
  receipt_id: Schema.NullOr(Sha256),
})
const ProjectedPositionRow = Schema.Struct({
  symbol: Schema.String,
  quantity_atoms: Schema.String,
  cost_basis_micros: Schema.String,
})
const PreviousReconciliationRows = Schema.Array(
  Schema.Struct({ discrepancies: Schema.Array(DiscrepancySchema) }),
).check(Schema.isMaxLength(1))
const ReconciliationContentRow = Schema.Tuple([Schema.Struct({ content_hash: Sha256 })])
const FinalExecutionRiskContextRow = Schema.Tuple([
  Schema.Struct({
    daily_traded_notional_micros: UnsignedMicrosSchema,
    peak_equity_micros: Schema.NullOr(SignedMicrosSchema),
  }),
])
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
    authority_updated_at: Schema.NullOr(UtcDatabaseInstantSchema),
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
const decodeTransactions = Schema.decodeUnknownEffect(Schema.Array(AccountingTransactionRowSchema), strictParseOptions)
const decodeReceipts = Schema.decodeUnknownEffect(Schema.Array(AccountingReceiptRowSchema), strictParseOptions)
const decodePreviousReconciliation = Schema.decodeUnknownEffect(PreviousReconciliationRows, strictParseOptions)
const decodeContent = Schema.decodeUnknownEffect(ReconciliationContentRow, strictParseOptions)
const decodeFinalExecutionRiskContext = Schema.decodeUnknownEffect(FinalExecutionRiskContextRow, strictParseOptions)
const decodeRiskContext = Schema.decodeUnknownEffect(ReconciliationRiskContextRow, strictParseOptions)
const encodeDiscrepancies = Schema.encodeSync(Schema.Array(DiscrepancySchema))

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
        `execution reconciliation ${operation} failed`,
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
    catch: (cause) =>
      storeError(operation, 'invariant', `execution reconciliation ${operation} invariant failed`, cause),
  })

const isTransientReconciliationRestriction = (reason: string | null): boolean =>
  reason === 'reconciliation pass incomplete' ||
  (reason?.startsWith('reconciliation discrepancy ') === true && isExecutionMandateFailureRestriction(reason))

const isRecoverableRestriction = (reason: string | null): boolean =>
  isExecutionMandateRecoveryRestriction(reason ?? undefined) || isRetiredOneShotMandateRestriction(reason ?? undefined)

const shouldPromoteRestrictionReason = (currentReason: string | null, nextReason: string): boolean =>
  (isRecoverableRestriction(currentReason) && !isRecoverableRestriction(nextReason)) ||
  (currentReason === 'reconciliation pass incomplete' && nextReason.startsWith('reconciliation discrepancy ')) ||
  (isTransientReconciliationRestriction(currentReason) &&
    !isTransientReconciliationRestriction(nextReason) &&
    isExecutionMandateFailureRestriction(nextReason))

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

export const restrictAuthority = (
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

export interface FinalExecutionRiskContext {
  readonly dailyTradedNotionalMicros: string
  readonly peakEquityMicros: string
}

export const readFinalExecutionRiskContext = (
  sql: PgClient.PgClient,
  accountId: string,
  observedAt: string,
): Effect.Effect<FinalExecutionRiskContext, ReconciliationStoreError> =>
  runStore(
    'risk-context',
    Effect.gen(function* () {
      const [row] = yield* sql<Record<string, unknown>>`
        WITH boundary AS (
          SELECT (${observedAt}::timestamptz AT TIME ZONE 'America/New_York')::date AS trading_date
        )
        SELECT coalesce((
          SELECT sum(transaction.notional_micros)::text
          FROM accounting_transactions AS transaction
          WHERE transaction.account_id = ${accountId}
            AND transaction.occurred_at <= ${observedAt}
            AND (transaction.occurred_at AT TIME ZONE 'America/New_York')::date = boundary.trading_date
        ), '0') AS daily_traded_notional_micros,
        (
          ${peakEquityQuery(sql, accountId, observedAt)}
        ) AS peak_equity_micros
        FROM boundary
      `.pipe(Effect.flatMap(decodeFinalExecutionRiskContext))
      if (row.peak_equity_micros === null) {
        return yield* storeError(
          'risk-context',
          'invariant',
          'durable peak equity is unavailable for final execution authorization',
        )
      }
      return {
        dailyTradedNotionalMicros: row.daily_traded_notional_micros,
        peakEquityMicros: row.peak_equity_micros,
      }
    }),
  )

/** Called under the account writer fence; the current durable start reserves this cache version. */
export const verifyBrokerStateVersion = (
  sql: PgClient.PgClient,
  accountId: string,
  version: BrokerStateVersion,
  intentId: string,
  requireCryptoEntryFeeBound: boolean,
): Effect.Effect<CryptoTakerFeeBps | null, ReconciliationStoreError> =>
  runStore(
    'risk-context',
    Effect.gen(function* () {
      const [row] = yield* sql<Record<string, unknown>>`
    SELECT (
      (SELECT reconciliation_id FROM reconciliations WHERE account_id = ${accountId}
        ORDER BY reconciled_at DESC, reconciliation_id COLLATE "C" DESC LIMIT 1) = ${version.reconciliationId}
      AND EXISTS (SELECT 1 FROM reconciliations WHERE account_id = ${accountId}
        AND reconciliation_id = ${version.reconciliationId}
        AND reconciled_at = ${version.reconciledAt}::timestamptz AND status = 'EXACT')
      AND EXISTS (SELECT 1 FROM authority_state WHERE generation_hash = ${version.authorityGenerationHash}
        AND version = ${version.authorityVersion}::bigint)
      AND NOT EXISTS (SELECT 1 FROM native_protection_cancel_commands c WHERE c.account_id = ${accountId}
        AND c.requested_at >= ${version.reconciledAt}::timestamptz)
      AND NOT EXISTS (
        SELECT 1 FROM mutation_events AS mutation JOIN intents AS intent USING (intent_id)
        WHERE intent.account_id = ${accountId} AND mutation.occurred_at >= ${version.reconciledAt}::timestamptz
          AND NOT (mutation.intent_id = ${intentId} AND mutation.event_type = 'SUBMIT_STARTED')
      )
      AND NOT EXISTS (SELECT 1 FROM broker_fee_accruals WHERE account_id = ${accountId} AND posted_at IS NULL)
      AND NOT EXISTS (SELECT 1 FROM broker_fee_accounting WHERE account_id = ${accountId} AND posted_at IS NULL)
      AND NOT EXISTS (SELECT 1 FROM broker_cash_settlements WHERE account_id = ${accountId}
        AND (posted_at IS NULL OR posted_at > ${version.reconciledAt}::timestamptz))
      AND NOT EXISTS (SELECT 1 FROM broker_fee_match_corrections WHERE account_id = ${accountId}
        AND (posted_at IS NULL OR posted_at > ${version.reconciledAt}::timestamptz
          OR (data->'readEvidence'->>'observedAt')::timestamptz > ${version.reconciledAt}::timestamptz))
      AND NOT EXISTS (SELECT 1 FROM broker_events WHERE account_id = ${accountId}
        AND observed_at > ${version.reconciledAt}::timestamptz)
    ) AS valid
  `.pipe(
        Effect.flatMap(
          Schema.decodeUnknownEffect(
            Schema.Tuple([Schema.Struct({ valid: Schema.NullOr(Schema.Boolean) })]),
            strictParseOptions,
          ),
        ),
      )
      if (row.valid !== true)
        return yield* storeError(
          'risk-context',
          'invariant',
          'cached broker reconciliation version changed before submit',
        )
      if (!requireCryptoEntryFeeBound) return null
      const [fee] = yield* sql`
        SELECT
          (d.document #>> '{strategyDecision,evidence,observation,portfolio,brokerState,account,cryptoFeeTier}')::integer AS tier,
          d.document #>> '{strategyDecision,evidence,observation,portfolio,brokerState,account,observedAt}' AS account_observed_at,
          d.document #>> '{strategyDecision,evidence,observation,observedAt}' AS priced_at
        FROM intents i
        JOIN autonomous_cycles c ON c.cycle_id = i.cycle_id
        JOIN autonomous_cycle_shadow_decisions d ON d.cycle_id = c.cycle_id AND d.decision_hash = c.decision_hash
        WHERE i.intent_id = ${intentId} AND i.account_id = ${accountId} AND i.side = 'BUY'
          AND i.decision_hash = d.document #>> '{bindings,strategyDecisionHash}'
          AND d.document #>> '{bindings,accountId}' = ${accountId}
          AND (
            (d.document #>> '{strategyDecision,schemaVersion}' = 'bayn.jev-entry-target.v7'
              AND d.document #>> '{strategyDecision,evidence,observation,protocol,schemaVersion}' IN ('bayn.jev.protocol.v33', 'bayn.jev.protocol.v34'))
            OR (d.document #>> '{strategyDecision,schemaVersion}' = 'bayn.entry-ablation-target.v1'
              AND d.document #>> '{strategyDecision,policy,schemaVersion}' = 'bayn.entry-ablation-policy.v1'
              AND d.document #>> '{strategyDecision,evidence,observation,protocol,schemaVersion}' IN ('bayn.jev.protocol.v33', 'bayn.jev.protocol.v34'))
            OR (d.document #>> '{strategyDecision,schemaVersion}' = 'bayn.repeated-momentum-target.v1'
              AND d.document #>> '{strategyDecision,policy,schemaVersion}' = 'bayn.repeated-momentum-policy.v1'
              AND d.document #>> '{strategyDecision,evidence,observation,protocol,schemaVersion}' IN ('bayn.jev.protocol.v33', 'bayn.jev.protocol.v34'))
          )
          AND d.document #>> '{strategyDecision,evidence,observation,portfolio,brokerState,account,schemaVersion}' = 'bayn.paper-account-snapshot.v2'
          AND d.document #>> '{strategyDecision,evidence,observation,portfolio,brokerState,account,accountId}' = ${accountId}
          AND (d.document #> '{strategyDecision,evidence,observation,portfolio,brokerState,account}') ? 'cryptoFeeTier'
          AND (d.document -> 'orderedIntentIds') @> ${JSON.stringify([intentId])}::jsonb
      `.pipe(
        Effect.flatMap(
          Schema.decodeUnknownEffect(
            Schema.Tuple([
              Schema.Struct({
                tier: Schema.NullOr(CryptoFeeTierSchema),
                account_observed_at: UtcInstant,
                priced_at: UtcInstant,
              }),
            ]),
            strictParseOptions,
          ),
        ),
      )
      return cryptoTakerFeeBps(effectiveCryptoFeeTier(fee.tier, fee.account_observed_at, fee.priced_at))
    }),
  )

export const makeReconciliation = (
  sql: PgClient.PgClient,
  journal: JournalService,
  config: Pick<RuntimeConfig, 'tigerBeetle'>,
  writerFence: WriterFenceService,
  clock: DatabaseClock = postgresWallClock(sql),
) => {
  const bindings = (accountId: string): Effect.Effect<readonly IntentBinding[], ReconciliationStoreError> =>
    runStore(
      'bindings',
      sql<Record<string, unknown>>`
        SELECT intent_id, client_order_id, symbol, quantity_atoms::text, protection
        FROM intents
        WHERE account_id = ${accountId}
        ORDER BY client_order_id COLLATE "C"
      `.pipe(
        Effect.flatMap(decodeBindings),
        Effect.map((rows) =>
          rows.map((row) => ({
            intentId: row.intent_id,
            clientOrderId: row.client_order_id,
            symbol: row.symbol,
            quantityAtoms: row.quantity_atoms,
            ...(row.protection === null ? {} : { protection: row.protection }),
          })),
        ),
      ),
    )

  const readAccountingPhase = (
    accountId: string,
    feeAccounting: BrokerFeeAccounting,
    accruals: FeeAccrualRecords,
    cashSettlements: CashSettlementAccounting,
  ): Effect.Effect<AccountingReadPhase, ReconciliationStoreError> =>
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
            intent.quantity_atoms::text AS quantity_atoms,
            intent.notional_limit_micros::text AS notional_limit_micros,
            intent.state,
            intent.terminal_outcome,
            accepted.broker_order_id,
            latest.operation AS mutation_operation,
            latest.event_type AS mutation_event_type,
            to_char(latest.occurred_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS mutation_occurred_at,
            submitted.request_hash AS submit_request_hash,
            started.request_body AS submit_request_body
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
          LEFT JOIN LATERAL (
            SELECT request_body FROM mutation_events WHERE intent_id = intent.intent_id AND event_type = 'SUBMIT_STARTED'
            ORDER BY sequence DESC LIMIT 1
          ) AS started ON true
          WHERE intent.account_id = ${accountId}
          ORDER BY intent.client_order_id COLLATE "C"
        `.pipe(Effect.flatMap(decodeIntents))
        const projected = yield* fromDecision('reconcile', projectIntentExpectations(intentRows))
        const children = yield* Schema.decodeUnknownEffect(
          Schema.Array(ProtectionChildRow),
          strictParseOptions,
        )(
          yield* sql`
          SELECT DISTINCT ON (o.broker_order_id)
            o.intent_id, o.broker_order_id, o.client_order_id, o.parent_broker_order_id, o.symbol,
            o.quantity_atoms::text, o.order_type, i.protection
          FROM orders o JOIN intents i ON i.intent_id = o.intent_id JOIN broker_events e ON e.event_id = o.event_id
          WHERE o.account_id = ${accountId} AND o.parent_broker_order_id IS NOT NULL
          ORDER BY o.broker_order_id, e.source_sequence DESC
        `,
        )
        const childExpectations = yield* Effect.forEach(children, (child) =>
          Effect.gen(function* () {
            const terms = child.protection
            if (terms._tag === 'StopLimit')
              return yield* storeError(
                'reconcile',
                'invariant',
                'a standalone stop cannot own broker-generated children',
              )
            return {
              intentId: child.intent_id,
              clientOrderId: child.client_order_id,
              brokerOrderId: child.broker_order_id,
              parentBrokerOrderId: child.parent_broker_order_id,
              symbol: child.symbol,
              side: OrderSide.Sell,
              orderType: child.order_type,
              submittedOrderType: child.order_type,
              timeInForce: TimeInForce.Day,
              quantityAtoms: child.quantity_atoms,
              submittedQuantityAtoms: child.quantity_atoms,
              submittedLimitPriceMicros:
                child.order_type === OrderType.StopLimit ? terms.stopLimitPriceMicros : terms.profitLimitPriceMicros,
              ...(child.order_type === OrderType.StopLimit ? { submittedStopPriceMicros: terms.stopPriceMicros } : {}),
              state: IntentState.Acknowledged,
              expectsBrokerOrder: true,
            }
          }),
        )
        const intents: readonly IntentExpectation[] = [...projected.intents, ...childExpectations]
        const unknownMutationCount = projected.unknownMutationCount

        const transactionRows = yield* sql<Record<string, unknown>>`
          SELECT
            schema_version, transaction_id, broker_event_id, intent_id, account_id, symbol, side,
            quantity_atoms::text AS quantity_atoms, price_atoms::text AS price_atoms,
            notional_micros::text AS notional_micros, fee_micros::text AS fee_micros,
            cost_basis_micros::text AS cost_basis_micros, realized_pnl_micros::text AS realized_pnl_micros,
            quantity_delta_atoms::text AS quantity_delta_atoms,
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
          .verifyAccount(accountId, [
            ...plans,
            ...cashSettlements.plans,
            ...feeAccounting.plans,
            ...accruals.map((accrual) => accrual.plan),
          ])
          .pipe(
            Effect.mapError((cause) =>
              storeError('reconcile', 'ledger', 'TigerBeetle account verification failed during reconciliation', cause),
            ),
          )

        return {
          intents,
          unknownMutationCount,
          transactions,
          receipts,
          exactReceipts,
          ledgerExact,
          fees: feeAccounting.fees,
          accruals: accruals.map((accrual) => accrual.data),
          cashReportingOffsetMicros: cashAccrualReportingOffsetMicros(accruals),
          cashSettlements,
          brokerFeeCashDeltaMicros: (
            BigInt(feeAccounting.cashDeltaMicros) -
            accruals.reduce((sum, accrual) => sum + BigInt(accrual.cashDebitMicros ?? '0'), 0n)
          ).toString(),
        }
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
            fill.source_timestamp,
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
          SELECT symbol, sum(quantity_atoms)::text AS quantity_atoms, sum(cost_basis_micros)::text AS cost_basis_micros
          FROM (
            SELECT symbol, quantity_delta_atoms AS quantity_atoms, cost_basis_delta_micros AS cost_basis_micros
            FROM accounting_transactions WHERE account_id = ${accountId}
            UNION ALL
            SELECT symbol, -quantity_atoms, -cost_basis_micros
            FROM broker_inventory_debits WHERE account_id = ${accountId} AND posted
          ) AS inventory
          GROUP BY symbol HAVING sum(quantity_atoms) <> 0 ORDER BY symbol COLLATE "C"
        `.pipe(Effect.flatMap(decodeProjectedPositions))
        const projectedPositions = projectedPositionRows.map((row) => ({
          symbol: row.symbol,
          quantityAtoms: row.quantity_atoms,
          costBasisMicros: row.cost_basis_micros,
        }))

        const openingCash = yield* readOpeningCash(sql, accountId)
        return yield* fromDecision(
          'reconcile',
          compareOpeningCash({
            accountId,
            openingCash,
            transactions: accounting.transactions,
            fillExecutionTimes: new Map(durableFillRows.map((row) => [row.broker_event_id, row.source_timestamp])),
            fees: accounting.fees,
            brokerFeeAccruals: accounting.accruals,
            brokerFeeCashDeltaMicros: accounting.brokerFeeCashDeltaMicros,
            cashReportingOffsetMicros: accounting.cashReportingOffsetMicros,
            cashSettlementDeltaMicros: accounting.cashSettlements.cashDeltaMicros,
            brokerCashSettlements: accounting.cashSettlements.settlements,
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
            ${databaseUtcInstant(sql, sql`authority.updated_at`)} AS authority_updated_at,
            CASE WHEN authority.singleton IS NULL THEN NULL ELSE ${clock.now} END AS authority_observed_at,
            coalesce((
              SELECT sum(transaction.notional_micros)::text
              FROM accounting_transactions AS transaction
              WHERE transaction.account_id = ${accountId}
                AND transaction.occurred_at <= ${reconciledAt}
                AND (transaction.occurred_at AT TIME ZONE 'America/New_York')::date = boundary.trading_date
            ), '0') AS daily_traded_notional_micros,
            (
              ${firstSessionEquityQuery(sql, accountId, reconciledAt)}
            ) AS day_start_equity_micros,
            (
              ${peakEquityQuery(sql, accountId, reconciledAt)}
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
        const cashSettlements = yield* postCashSettlements(sql, journal, accountId, config.tigerBeetle).pipe(
          withObservedStage('bayn.reconciliation.cash-settlement'),
        )
        const feeAccounting = yield* postBrokerFeePlans(sql, journal, accountId, config.tigerBeetle).pipe(
          withObservedStage('bayn.reconciliation.fee-posting'),
        )
        const accruals = yield* readFeeAccruals(sql, accountId, config.tigerBeetle).pipe(
          withObservedStage('bayn.reconciliation.accrual-read', { dependency: 'postgresql' }),
        )
        const accounting = yield* readAccountingPhase(accountId, feeAccounting, accruals, cashSettlements).pipe(
          withObservedStage('bayn.reconciliation.accounting-verify'),
        )
        const { accountingHash, comparison } = yield* readComparisonPhase(accountId, snapshot, accounting).pipe(
          withObservedStage('bayn.reconciliation.compare'),
        )
        const reconciliation = yield* writeReconciliationPhase(accountId, comparison, snapshot.reconciledAt).pipe(
          withObservedStage('bayn.reconciliation.record', { dependency: 'postgresql' }),
        )
        const riskContext = yield* readRiskContextPhase(
          accountId,
          snapshot.reconciledAt,
          accounting.unknownMutationCount,
        ).pipe(withObservedStage('bayn.reconciliation.risk-context', { dependency: 'postgresql' }))
        return { reconciliation, metrics: comparison.metrics, accountingHash, riskContext }
      }),
    )

  const requireAutocommit = Effect.gen(function* () {
    if (Option.isSome(yield* Effect.serviceOption(sql.transactionService)))
      return yield* storeError(
        'reconcile',
        'invariant',
        'Broker fee plans must commit independently before ledger posting',
      )
  })
  const reconcile = <E, R>(
    accountId: string,
    ingestSnapshot: Effect.Effect<BrokerSnapshot, E, R>,
  ): Effect.Effect<ReconciledBrokerSnapshot, E | ReconciliationStoreError, R> =>
    Effect.gen(function* () {
      yield* requireAutocommit
      const snapshot = yield* writerFence
        .transaction(
          Effect.gen(function* () {
            // Only previously committed plans exist here. Recover them before accounting any new fill.
            // Ingestion and preparation then share one commit; newly prepared fees are posted below it.
            yield* postCashSettlements(sql, journal, accountId, config.tigerBeetle)
            yield* postBrokerFeePlans(sql, journal, accountId, config.tigerBeetle)
            const snapshot = yield* ingestSnapshot
            if (snapshot.account.accountId !== accountId)
              return yield* storeError('reconcile', 'invariant', 'Reconciliation snapshot account binding changed')
            yield* runStore(
              'reconcile',
              Effect.gen(function* () {
                yield* retainAccountCashReporting(sql, snapshot)
                yield* prepareCashSettlements(sql, snapshot, config.tigerBeetle)
                yield* prepareObservedCoinFees(sql, snapshot, config.tigerBeetle)
                yield* prepareFeeActivities(sql, accountId, snapshot.fees, config.tigerBeetle)
                yield* prepareObservedCashFees(sql, snapshot, config.tigerBeetle)
              }),
            )
            return snapshot
          }),
        )
        .pipe(
          Effect.mapError((cause) =>
            cause instanceof WriterFenceError
              ? storeError('reconcile', 'query', 'Reconciliation preparation transaction failed', cause)
              : cause,
          ),
        )
      const persisted = yield* runStore('reconcile', writerFence.transaction(reconcileTransaction(snapshot)))
      return { snapshot, persisted }
    })

  const retainCashReporting = (snapshot: Parameters<typeof retainAccountCashReporting>[1]) =>
    runStore('reconcile', writerFence.transaction(retainAccountCashReporting(sql, snapshot)))

  return { bindings, reconcile, retainCashReporting }
}
