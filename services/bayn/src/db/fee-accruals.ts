import { PgClient } from '@effect/sql-pg'
import { Effect, Result, Schema } from 'effect'
import { FeeAccrualSchema, prepareFeeAccrual } from '../accounting/fee-accrual'
import { hashLedgerPlanResult } from '../ledger-plan'
import type { JournalService } from '../ledger'
import { IsoDateSchema, Sha256Schema, strictParseOptions } from '../schemas'
import { CashReportingQuantumSchema, reportedCashMicros } from '../broker/alpaca/cash-reporting'
import { ReconciliationStoreError, type BrokerSnapshot } from './reconciliation'
import { OrderSide } from '../execution/contracts'
import { acknowledgeFeePosting, FeePostingKind, readAcknowledgedFeePostings } from './fee-posting'
import { readOpeningCash } from './account-baseline'

const integer = Schema.String.check(Schema.isPattern(/^(?:0|[1-9][0-9]*)$/))
export const StoredAccrual = Schema.Struct({
  accrual_id: Sha256Schema,
  data: FeeAccrualSchema,
  settlement_date: IsoDateSchema,
  content_hash: Sha256Schema,
  coin_quantity_atoms: Schema.NullOr(integer),
  cash_debit_micros: Schema.NullOr(integer),
  expense_micros: integer,
  matched_coin_quantity_atoms: integer,
  matched_cash_micros: integer,
  ledger_plan_hash: Sha256Schema,
  tigerbeetle_cluster_id: integer,
  tigerbeetle_ledger: Schema.Int,
  posted: Schema.Boolean,
})
const SourceTrade = Schema.Struct({
  transactionId: Sha256Schema,
  cycleId: Sha256Schema,
  brokerOrderId: Schema.String,
  quantityAtoms: integer,
  priceAtoms: integer,
  date: Schema.String,
  orderAccountedQuantityAtoms: integer,
})
const invariant = (message: string, cause?: unknown) =>
  new ReconciliationStoreError({
    operation: 'reconcile',
    failure: 'invariant',
    message,
    ...(cause === undefined ? {} : { cause }),
  })
const fromResult = <A, E>(value: Result.Result<A, E>) =>
  Effect.fromResult(value).pipe(
    Effect.mapError((cause) => invariant('Observed fee accrual evidence is invalid', cause)),
  )
type Identity = { readonly clusterId: bigint; readonly ledger: number }
export type FeeAccrualRecords = Effect.Success<ReturnType<typeof readFeeAccruals>>

export const feeAccrualCohortSettled = (
  record: typeof StoredAccrual.Type,
  records: readonly (typeof StoredAccrual.Type)[],
): boolean =>
  records
    .filter(
      (candidate) =>
        candidate.data.accountId === record.data.accountId &&
        candidate.data.kind === record.data.kind &&
        candidate.data.symbol === record.data.symbol &&
        candidate.settlement_date === record.settlement_date,
    )
    .every(
      (candidate) =>
        candidate.posted &&
        (candidate.data.kind === 'COIN'
          ? candidate.matched_coin_quantity_atoms === candidate.coin_quantity_atoms
          : candidate.matched_cash_micros === candidate.cash_debit_micros),
    )

export const cashAccrualReportingOffsetMicros = (records: readonly (typeof StoredAccrual.Type)[]): string => {
  const latest = records
    .filter((record) => record.posted && record.data.kind === 'CASH' && !feeAccrualCohortSettled(record, records))
    .toSorted((a, b) => a.data.observedAt.localeCompare(b.data.observedAt) || a.accrual_id.localeCompare(b.accrual_id))
    .at(-1)
  if (latest === undefined || latest.data.kind !== 'CASH') return '0'
  return (
    BigInt(reportedCashMicros(latest.data.projectedCashMicros, latest.data.cashReportingQuantumMicros)) -
    BigInt(latest.data.projectedCashMicros)
  ).toString()
}

export const readStoredFeeAccruals = (sql: PgClient.PgClient, accountId: string) =>
  Effect.gen(function* () {
    return yield* fromResult(
      Schema.decodeUnknownResult(
        Schema.Array(StoredAccrual),
        strictParseOptions,
      )(
        yield* sql`
    SELECT a.accrual_id,a.data,cohort.settlement_date,a.content_hash,a.coin_quantity_atoms::text,a.cash_debit_micros::text,a.expense_micros::text,
      COALESCE((SELECT sum(m.coin_quantity_atoms) FROM broker_fee_accrual_matches m WHERE m.accrual_id=a.accrual_id),0)::text AS matched_coin_quantity_atoms,
      (COALESCE((SELECT sum(m.accrual_cash_micros) FROM broker_fee_accrual_matches m WHERE m.accrual_id=a.accrual_id),0)-COALESCE((SELECT sum(c.cash_debit_micros) FROM broker_fee_match_corrections c WHERE c.accrual_id=a.accrual_id),0))::text AS matched_cash_micros,
      a.ledger_plan_hash,a.tigerbeetle_cluster_id::text,a.tigerbeetle_ledger::integer,a.posted_at IS NOT NULL AS posted
    FROM broker_fee_accruals a JOIN broker_fee_accrual_cohorts cohort USING(accrual_id) WHERE a.account_id=${accountId} ORDER BY a.observed_at,a.accrual_id COLLATE "C"
  `,
      ),
    )
  })
export const verifyFeeAccrualRecord = (row: typeof StoredAccrual.Type, accountId: string, identity: Identity) =>
  Result.gen(function* () {
    const prepared = yield* prepareFeeAccrual(row.data, identity.ledger)
    const planHash = yield* hashLedgerPlanResult(prepared.plan)
    if (
      row.data.accountId !== accountId ||
      row.accrual_id !== prepared.accrualId ||
      row.content_hash !== prepared.contentHash ||
      row.coin_quantity_atoms !== prepared.coinQuantityAtoms ||
      row.cash_debit_micros !== prepared.cashDebitMicros ||
      row.expense_micros !== prepared.expenseMicros ||
      row.ledger_plan_hash !== planHash ||
      row.tigerbeetle_cluster_id !== identity.clusterId.toString() ||
      row.tigerbeetle_ledger !== identity.ledger ||
      BigInt(row.matched_coin_quantity_atoms) > BigInt(row.coin_quantity_atoms ?? '0') ||
      BigInt(row.matched_cash_micros) > BigInt(row.cash_debit_micros ?? '0')
    )
      return yield* Result.fail(invariant('Stored fee accrual differs from its source or ledger identity'))
    return { ...row, ...prepared }
  })
export const readFeeAccruals = (sql: PgClient.PgClient, accountId: string, identity: Identity) =>
  Effect.gen(function* () {
    const rows = yield* readStoredFeeAccruals(sql, accountId)
    return yield* Effect.forEach(rows, (row) => fromResult(verifyFeeAccrualRecord(row, accountId, identity)))
  })

export const postFeeAccruals = (
  sql: PgClient.PgClient,
  journal: JournalService,
  accountId: string,
  identity: Identity,
) =>
  Effect.gen(function* () {
    const rows = yield* readFeeAccruals(sql, accountId, identity)
    const acknowledged = yield* readAcknowledgedFeePostings(sql, accountId, FeePostingKind.Accrual)
    for (const row of rows) {
      if (row.posted && acknowledged.has(row.accrualId)) continue
      if (row.plan.transfers.length > 0)
        yield* journal.post(row.plan).pipe(
          Effect.mapError(
            (cause) =>
              new ReconciliationStoreError({
                operation: 'reconcile',
                failure: 'ledger',
                message: 'Fee accrual ledger posting failed',
                cause,
              }),
          ),
        )
      if (!row.posted)
        yield* sql`UPDATE broker_fee_accruals SET posted_at=clock_timestamp() WHERE accrual_id=${row.accrualId}`
      yield* acknowledgeFeePosting(sql, accountId, FeePostingKind.Accrual, row.accrualId, row.ledger_plan_hash)
    }
    return rows
  })
export const feeAccrualSources = <A extends { readonly date: string }>(
  rows: readonly A[],
  side: OrderSide,
): readonly A[] => {
  const latestDate = rows.reduce((date, row) => (row.date > date ? row.date : date), '')
  return side === OrderSide.Sell ? rows.filter((row) => row.date === latestDate) : rows
}

const sourcesFor = (sql: PgClient.PgClient, snapshot: BrokerSnapshot, side: OrderSide, symbol: string | null) =>
  Effect.gen(function* () {
    const rows = yield* fromResult(
      Schema.decodeUnknownResult(
        Schema.Array(SourceTrade),
        strictParseOptions,
      )(
        yield* sql`
    SELECT t.transaction_id AS "transactionId",i.cycle_id AS "cycleId",f.broker_order_id AS "brokerOrderId",
      t.quantity_atoms::text AS "quantityAtoms",t.price_atoms::text AS "priceAtoms",
      (SELECT sum(t2.quantity_atoms)::text FROM accounting_transactions t2 JOIN fills f2 ON f2.event_id=t2.broker_event_id
        WHERE t2.account_id=t.account_id AND f2.broker_order_id=f.broker_order_id) AS "orderAccountedQuantityAtoms",to_char(t.occurred_at AT TIME ZONE 'UTC','YYYY-MM-DD') AS date
    FROM accounting_transactions t JOIN fills f ON f.event_id=t.broker_event_id JOIN intents i ON i.intent_id=t.intent_id JOIN autonomous_cycles c ON c.cycle_id=i.cycle_id
    WHERE t.account_id=${snapshot.account.accountId} AND i.account_id=t.account_id AND c.account_id=t.account_id
      AND t.symbol=i.symbol AND t.symbol IN('BTC/USD','ETH/USD','SOL/USD') AND (${symbol}::text IS NULL OR t.symbol=${symbol})
      AND i.strategy_name='jev' AND t.side=${side} AND c.state='ACTIVE' AND c.schema_version='bayn.autonomous-cycle.v4'
      AND c.execution_calendar_schema_version='bayn.continuous-market-hours.v1'
      AND t.occurred_at<=${side === OrderSide.Buy ? snapshot.positionsObservedAt : snapshot.account.observedAt}::timestamptz
      AND NOT EXISTS(SELECT 1 FROM broker_fee_accruals a,LATERAL jsonb_array_elements(a.data->'sourceTrades') b
        WHERE a.account_id=t.account_id AND a.cycle_id=c.cycle_id AND b->>'transactionId'=t.transaction_id)
    ORDER BY t.transaction_id COLLATE "C"
  `,
      ),
    )
    const selected = feeAccrualSources(rows, side)
    const first = selected[0]
    if (first === undefined) return null
    if (rows.some((row) => row.cycleId !== first.cycleId) || selected.some((row) => row.date !== first.date))
      return yield* invariant('Fee settlement mixes active cycles or trading dates')
    for (const id of new Set(selected.map((row) => row.brokerOrderId))) {
      const order = snapshot.orders.find((value) => value.brokerOrderId === id)
      const source = selected.find((row) => row.brokerOrderId === id)
      if (
        order === undefined ||
        source === undefined ||
        BigInt(order.filledQuantityAtoms) !== BigInt(source.orderAccountedQuantityAtoms)
      )
        return yield* invariant('Fee settlement does not cover the complete observed native fill quantity')
    }
    return {
      cycleId: first.cycleId,
      date: first.date,
      sourceTrades: selected.map(({ transactionId, quantityAtoms, priceAtoms }) => ({
        transactionId,
        quantityAtoms,
        priceAtoms,
      })),
    }
  })
const persistAccrual = (sql: PgClient.PgClient, input: unknown, identity: Identity) =>
  Effect.gen(function* () {
    const prepared = yield* fromResult(prepareFeeAccrual(input, identity.ledger))
    const data = prepared.data
    const planHash = yield* fromResult(hashLedgerPlanResult(prepared.plan))
    yield* sql`INSERT INTO broker_fee_accruals(accrual_id,account_id,kind,symbol,cycle_id,fee_date,position_snapshot_id,account_event_id,observed_at,
    coin_quantity_atoms,cash_debit_micros,expense_micros,data,content_hash,ledger_plan_hash,tigerbeetle_cluster_id,tigerbeetle_ledger)
    VALUES(${prepared.accrualId},${data.accountId},${data.kind},${data.symbol},${data.cycleId},${data.date}::date,
      ${data.kind === 'COIN' ? data.positionSnapshotId : null},${data.kind === 'CASH' ? data.accountEventId : null},${data.observedAt}::timestamptz,
      ${prepared.coinQuantityAtoms},${prepared.cashDebitMicros},${prepared.expenseMicros},${sql.json(data)},${prepared.contentHash},${planHash},${identity.clusterId.toString()},${identity.ledger})`
  })
const fresh = (observedAt: string, reconciledAt: string) =>
  Date.parse(reconciledAt) >= Date.parse(observedAt) && Date.parse(reconciledAt) - Date.parse(observedAt) <= 60000

export const prepareObservedCoinFees = (sql: PgClient.PgClient, snapshot: BrokerSnapshot, identity: Identity) =>
  Effect.gen(function* () {
    const accountId = snapshot.account.accountId
    const held = snapshot.positions.filter((position) => position.quantityAtoms !== '0')
    const position = held.length === 1 ? held[0] : undefined
    if (position === undefined || !['BTC/USD', 'ETH/USD', 'SOL/USD'].includes(position.symbol)) return
    if (position.schemaVersion !== 'bayn.position.v2' || BigInt(position.quantityAtoms) <= 0n)
      return yield* invariant('Native coin settlement requires a trusted long position with cost basis')
    const [balance] = yield* fromResult(
      Schema.decodeUnknownResult(
        Schema.Tuple([Schema.Struct({ quantity: integer, cost: integer })]),
        strictParseOptions,
      )(
        yield* sql`
    SELECT (COALESCE((SELECT sum(quantity_delta_atoms) FROM accounting_transactions WHERE account_id=${accountId} AND symbol=${position.symbol}),0)
      -COALESCE((SELECT sum(quantity_atoms) FROM broker_inventory_debits WHERE account_id=${accountId} AND symbol=${position.symbol}),0))::text AS quantity,
      (COALESCE((SELECT sum(cost_basis_delta_micros) FROM accounting_transactions WHERE account_id=${accountId} AND symbol=${position.symbol}),0)
      -COALESCE((SELECT sum(cost_basis_micros) FROM broker_inventory_debits WHERE account_id=${accountId} AND symbol=${position.symbol}),0))::text AS cost
  `,
      ),
    )
    if (BigInt(balance.quantity) <= BigInt(position.quantityAtoms)) return
    const sources = yield* sourcesFor(sql, snapshot, OrderSide.Buy, position.symbol)
    if (sources === null) return
    if (!fresh(snapshot.positionsObservedAt, snapshot.reconciledAt))
      return yield* invariant('Coin settlement cannot use a stale position observation')
    const bound = yield* sql`SELECT 1 FROM position_snapshots ps JOIN positions p ON p.snapshot_id=ps.snapshot_id
    WHERE ps.snapshot_id=${snapshot.positionSnapshotId} AND ps.account_id=${accountId} AND ps.observed_at=${snapshot.positionsObservedAt}::timestamptz
      AND ps.position_count=${snapshot.positions.length} AND p.account_id=${accountId} AND p.symbol=${position.symbol}
      AND p.quantity_atoms=${position.quantityAtoms}::numeric AND p.cost_basis_micros=${position.costBasisMicros}::numeric`
    if (bound.length !== 1) return yield* invariant('Coin settlement differs from its durable broker snapshot')
    yield* persistAccrual(
      sql,
      {
        schemaVersion: 'bayn.broker-fee-accrual.v1',
        kind: 'COIN',
        accountId,
        symbol: position.symbol,
        ...sources,
        positionSnapshotId: snapshot.positionSnapshotId,
        observedAt: snapshot.positionsObservedAt,
        projectedQuantityAtoms: balance.quantity,
        observedQuantityAtoms: position.quantityAtoms,
        projectedCostMicros: balance.cost,
        observedCostMicros: position.costBasisMicros,
      },
      identity,
    )
  })

export const prepareObservedCashFees = (sql: PgClient.PgClient, snapshot: BrokerSnapshot, identity: Identity) =>
  Effect.gen(function* () {
    const accountId = snapshot.account.accountId
    const openingCash = yield* readOpeningCash(sql, accountId)
    const [balance] = yield* fromResult(
      Schema.decodeUnknownResult(
        Schema.Tuple([Schema.Struct({ cash: Schema.String })]),
        strictParseOptions,
      )(
        yield* sql`
    SELECT (${openingCash.cash_micros}::numeric
      +COALESCE((SELECT sum(cash_delta_micros) FROM accounting_transactions WHERE account_id=${accountId}),0)
      +COALESCE((SELECT sum(cash_delta_micros) FROM broker_cash_fee_deltas WHERE account_id=${accountId}),0)
      +COALESCE((SELECT sum(rounding_delta_micros) FROM broker_cash_settlements WHERE account_id=${accountId}),0))::text AS cash
  `,
      ),
    )
    if (
      BigInt(reportedCashMicros(balance.cash, snapshot.cashReportingQuantumMicros)) <=
      BigInt(snapshot.account.cashMicros)
    )
      return
    const sources = yield* sourcesFor(sql, snapshot, OrderSide.Sell, null)
    if (sources === null) return
    if (!fresh(snapshot.account.observedAt, snapshot.reconciledAt))
      return yield* invariant('Cash settlement cannot use a stale account observation')
    const bound =
      yield* sql`SELECT 1 FROM account_snapshots a JOIN broker_events e USING(event_id) WHERE a.event_id=${snapshot.accountEventId}
    AND a.account_id=${accountId} AND a.cash_micros=${snapshot.account.cashMicros}::numeric AND e.observed_at=${snapshot.account.observedAt}::timestamptz AND e.event_kind='ACCOUNT'`
    if (bound.length !== 1) return yield* invariant('Cash settlement differs from its durable broker account snapshot')
    const [opening] = yield* fromResult(
      Schema.decodeUnknownResult(
        Schema.Tuple([
          Schema.Struct({
            openingAccountEventId: Sha256Schema,
            openingCashReportingQuantumMicros: CashReportingQuantumSchema,
          }),
        ]),
        strictParseOptions,
      )(
        yield* sql`SELECT a.event_id AS "openingAccountEventId",r.quantum_micros::text AS "openingCashReportingQuantumMicros"
        FROM account_snapshots a JOIN broker_events e USING(event_id) LEFT JOIN account_cash_reporting r ON r.account_event_id=a.event_id
        WHERE a.account_id=${accountId} AND e.account_id=${accountId} AND e.event_kind='ACCOUNT' AND e.observed_at<(
          SELECT min(t.occurred_at) FROM accounting_transactions t WHERE t.account_id=${accountId}
          AND t.transaction_id IN ${sql.in(sources.sourceTrades.map((trade) => trade.transactionId))})
        ORDER BY e.observed_at DESC,e.source_sequence DESC LIMIT 1`,
      ),
    )
    yield* persistAccrual(
      sql,
      {
        schemaVersion: 'bayn.broker-fee-accrual.v2',
        kind: 'CASH',
        accountId,
        symbol: 'USD',
        ...sources,
        ...opening,
        accountEventId: snapshot.accountEventId,
        observedAt: snapshot.account.observedAt,
        projectedCashMicros: balance.cash,
        observedCashMicros: snapshot.account.cashMicros,
        cashReportingQuantumMicros: snapshot.cashReportingQuantumMicros,
      },
      identity,
    )
  })
