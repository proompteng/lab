import type { PgClient } from '@effect/sql-pg'
import { Effect, Result, Schema } from 'effect'

import { decodeExecutionCycleClosureResult } from '../src/db/execution-cycle-closure'
import { OrderSide, OrderStatus, OrderType } from '../src/execution/contracts'
import { legacyExecutionAuthorityToken } from '../src/execution/legacy-wire'
import { CycleDecisionJsonRow } from '../src/forward-performance/postgres/model'
import { verifyPerformanceDecisionJson } from '../src/forward-performance/postgres/projection'
import { decodeIntradayBarRows } from '../src/market-data/intraday/rows'
import { normalizeBar } from '../src/market-data/intraday/verification'
import { isContinuousMarket } from '../src/market-hours'
import {
  NonNegativeIntegerSchema,
  PositiveMicrosSchema,
  SignedMicrosSchema,
  StrictNonEmptyStringSchema,
  SymbolSchema,
  UnsignedMicrosSchema,
  UtcOrderTimestampSchema,
  strictParseOptions,
} from '../src/schemas'
import { priceNumberToMicros } from '../src/strategy/execution-model/fixed-point'
import { IntradayAlphaPhase } from '../src/strategy/intraday-alpha/constants'
import type { ActiveAlphaPhase } from '../src/strategy/intraday-alpha/signals'
import { isIntradayAlphaTarget } from '../src/strategy/runtime-decision'

const Id = StrictNonEmptyStringSchema
const nullableId = Schema.NullOr(Id)

const FillRow = Schema.Struct({
  fillId: Id,
  sourceAt: UtcOrderTimestampSchema,
  orderId: Id,
  intentId: nullableId,
  symbol: SymbolSchema,
  side: Schema.Enum(OrderSide),
  quantityAtoms: PositiveMicrosSchema,
  priceAtoms: PositiveMicrosSchema,
  grossMicros: Schema.NullOr(SignedMicrosSchema),
  feeMicros: Schema.NullOr(SignedMicrosSchema),
  accountingBound: Schema.Boolean,
})

const OrderRow = Schema.Struct({
  orderId: Id,
  parentOrderId: nullableId,
  intentId: nullableId,
  cycleId: nullableId,
  symbol: SymbolSchema,
  side: Schema.Enum(OrderSide),
  status: Schema.Enum(OrderStatus),
  orderType: Schema.Enum(OrderType),
  protectionTag: nullableId,
  quantityAtoms: Schema.NullOr(PositiveMicrosSchema),
  filledQuantityAtoms: UnsignedMicrosSchema,
  limitPriceMicros: Schema.NullOr(PositiveMicrosSchema),
  stopPriceMicros: Schema.NullOr(PositiveMicrosSchema),
  updatedAt: UtcOrderTimestampSchema,
})

const InventoryRow = Schema.Struct({
  symbol: SymbolSchema,
  openingAtoms: SignedMicrosSchema,
  openingBasisMicros: SignedMicrosSchema,
  closingAtoms: SignedMicrosSchema,
  closingBasisMicros: SignedMicrosSchema,
  atRegularCloseAtoms: SignedMicrosSchema,
})

const PositionRow = Schema.Struct({
  symbol: SymbolSchema,
  observedAt: UtcOrderTimestampSchema,
  quantityAtoms: SignedMicrosSchema,
  markPriceMicros: UnsignedMicrosSchema,
  unrealizedPnlMicros: SignedMicrosSchema,
})
const TickCountRow = Schema.Struct({
  observedTicks: NonNegativeIntegerSchema,
  closeMarketDataUnavailableTicks: NonNegativeIntegerSchema,
})

const CancelRow = Schema.Struct({ cycleId: Id, acknowledged: Schema.Boolean, released: Schema.Boolean })
const FeeRow = Schema.Struct({ netAmountMicros: SignedMicrosSchema, posted: Schema.Boolean })
const CutRow = Schema.Struct({
  startAt: Schema.Date,
  endAt: Schema.Date,
  closeAt: Schema.Date,
  queriedAt: Schema.Date,
  unaccountedFillEvents: NonNegativeIntegerSchema,
  nonterminalIntents: NonNegativeIntegerSchema,
})

const ReconciliationRow = Schema.Struct({
  status: Schema.Literals(['EXACT', 'DISCREPANCY']),
  reconciledAt: Schema.Date,
  discrepancies: NonNegativeIntegerSchema,
  positionsObservedAt: Schema.NullOr(Schema.Date),
  positionCount: Schema.NullOr(NonNegativeIntegerSchema),
  coversSessionEvidence: Schema.Boolean,
})

const DecisionRow = Schema.Struct({
  ...CycleDecisionJsonRow.fields,
  strategy_protocol_hash: Id,
  qualification_run_id: Id,
  authority_generation_hash: Id,
  risk_policy_hash: Id,
})

interface Entry {
  readonly cycleId: string
  readonly phase: ActiveAlphaPhase
  readonly legs: readonly {
    readonly intentId: string
    readonly symbol: string
    readonly side: OrderSide
    readonly quantityAtoms: string
    readonly referencePriceMicros: string | null
    readonly signalBarCloseMicros: string | null
  }[]
}

interface CalendarClose {
  readonly cycleId: string
  readonly executionCloseAt: string
  readonly regularCloseAt: string
}

interface CloseReference {
  readonly cycleId: string
  readonly intentId: string
  readonly symbol: string
  readonly side: OrderSide
  readonly referencePriceMicros: string
}

export interface AlphaSessionRows {
  readonly cut: { readonly queriedAt: Date }
  readonly entries: readonly Entry[]
  readonly unverifiedDecisions: number
  readonly fills: readonly (typeof FillRow.Type)[]
  readonly unaccountedFillEvents: number
  readonly nonterminalIntents: number
  readonly orders: readonly (typeof OrderRow.Type)[]
  readonly inventory: readonly (typeof InventoryRow.Type)[]
  readonly cancellations: readonly (typeof CancelRow.Type)[]
  readonly fees: readonly (typeof FeeRow.Type)[]
  readonly reconciliation: typeof ReconciliationRow.Type | null
  readonly calendarCloses: readonly CalendarClose[]
  readonly closeReferences: readonly CloseReference[]
  readonly stopPositionMarks: readonly (typeof PositionRow.Type)[]
  readonly postClosePositions: readonly (typeof PositionRow.Type)[]
  readonly controllerTicks: typeof TickCountRow.Type
}

export const alphaSessionRegularClose = (closeAt: Date, calendarCloses: readonly CalendarClose[]) => {
  const closes = new Set(calendarCloses.map((calendar) => calendar.regularCloseAt))
  const first = calendarCloses[0]
  return first !== undefined && closes.size === 1
    ? { at: new Date(first.regularCloseAt), source: 'VERIFIED_DECISION_CALENDAR' as const }
    : { at: closeAt, source: closes.size === 0 ? ('CLI' as const) : ('CLI_CALENDAR_CONFLICT' as const) }
}

const decode = <S extends Schema.Constraint>(schema: S) =>
  Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(schema), strictParseOptions))

const projectDecision = (
  row: typeof DecisionRow.Type,
  accountId: string,
  date: string,
): { entry: Entry | null; calendar: CalendarClose | null } | 'UNVERIFIED' => {
  const document = verifyPerformanceDecisionJson({
    cycle_id: row.cycle_id,
    decision_hash: row.decision_hash,
    document_json: row.document_json,
    created_at: row.created_at,
  }).verifiedRows[0]?.document
  if (document?.mode !== legacyExecutionAuthorityToken) return 'UNVERIFIED'
  const target = document.strategyDecision
  if (!isIntradayAlphaTarget(target)) return 'UNVERIFIED'
  const bindings = document.bindings
  if (
    document.contentHash !== row.decision_hash ||
    document.createdAt !== row.created_at.toISOString() ||
    bindings.cycleId !== row.cycle_id ||
    bindings.accountId !== accountId ||
    bindings.authorityGenerationHash !== row.authority_generation_hash ||
    bindings.qualificationRunId !== row.qualification_run_id ||
    bindings.strategyProtocolHash !== row.strategy_protocol_hash ||
    bindings.policyHash !== row.risk_policy_hash ||
    target.sessionDate !== date
  )
    return 'UNVERIFIED'
  const binding = document.executionSession
  const provider =
    binding === undefined || isContinuousMarket(binding.calendar)
      ? undefined
      : binding.calendar.providerSessions.find((session) => session.date === date)
  const calendar =
    binding === undefined || provider === undefined || binding.executionSession.date !== date
      ? null
      : {
          cycleId: row.cycle_id,
          executionCloseAt: binding.executionSession.closeAt,
          regularCloseAt: provider.regularCloseAt,
        }
  if (!document.dispatchable || document.targetPlan.intentTargets.length === 0) return { entry: null, calendar }
  if (target.phase === IntradayAlphaPhase.OutsideWindow) return 'UNVERIFIED'

  const observation = target.evidence.observation
  const end = observation.manifest['rangeEndAt']
  if (typeof end !== 'string') return 'UNVERIFIED'
  const bars = decodeIntradayBarRows(observation.rows.bars)
  if (Result.isFailure(bars)) return 'UNVERIFIED'
  const closes = new Map<string, string>()
  for (const bar of bars.success) {
    const normalized = normalizeBar(bar)
    if (Result.isFailure(normalized)) return 'UNVERIFIED'
    const { symbol, eventAt, close } = normalized.success
    if (Date.parse(eventAt) !== Date.parse(end) - 60_000) continue
    const micros = priceNumberToMicros(close, 'signal bar close', 'NEAREST')
    if (Result.isFailure(micros) || closes.has(symbol)) return 'UNVERIFIED'
    closes.set(symbol, micros.success.toString())
  }
  const legs: Entry['legs'][number][] = []
  for (const [index, intent] of document.targetPlan.intentTargets.entries()) {
    const intentId = document.orderedIntentIds[index]
    if (intentId === undefined) return 'UNVERIFIED'
    legs.push({
      intentId,
      symbol: intent.symbol,
      side: intent.side,
      quantityAtoms: intent.quantityAtoms,
      referencePriceMicros:
        document.targetPlan.targets.find((planned) => planned.symbol === intent.symbol)?.referencePriceMicros ?? null,
      signalBarCloseMicros: closes.get(intent.symbol) ?? null,
    })
  }
  return { entry: { cycleId: row.cycle_id, phase: target.phase, legs }, calendar }
}

const projectCloseReferences = (
  documents: readonly { readonly cycleId: string; readonly document: unknown }[],
  accountId: string,
): CloseReference[] =>
  documents.flatMap(({ cycleId, document }) => {
    const decoded = decodeExecutionCycleClosureResult(document)
    if (Result.isFailure(decoded)) return []
    const closure = decoded.success
    if (closure.cycleId !== cycleId || closure.document.bindings.accountId !== accountId) return []
    const { targetPlan, orderedIntentIds } = closure.document
    return targetPlan.intentTargets.flatMap(({ symbol, side }, index) => {
      const intentId = orderedIntentIds[index]
      const target = targetPlan.targets.find((candidate) => candidate.symbol === symbol)
      return intentId === undefined || target === undefined
        ? []
        : [{ cycleId, intentId, symbol, side, referencePriceMicros: target.referencePriceMicros }]
    })
  })

/** Caller must own the read-only repeatable-read snapshot. */
export const readAlphaSession = (
  sql: PgClient.PgClient,
  {
    sessionDate,
    accountId,
    regularClose,
  }: { readonly sessionDate: string; readonly accountId: string; readonly regularClose: string },
) =>
  Effect.gen(function* () {
    yield* sql`SET LOCAL statement_timeout = '25s'`
    const [cut] = yield* sql`
    WITH bounds AS (
      SELECT (${sessionDate}::date::timestamp AT TIME ZONE 'America/New_York') AS start_at,
        ((${sessionDate}::date + 1)::timestamp AT TIME ZONE 'America/New_York') AS end_at
    )
    SELECT start_at AS "startAt", end_at AS "endAt",
      ((${sessionDate}::date + ${regularClose}::time) AT TIME ZONE 'America/New_York') AS "closeAt",
      transaction_timestamp() AS "queriedAt",
      (SELECT count(*)::integer FROM broker_events e LEFT JOIN fills f ON f.event_id=e.event_id
       WHERE e.account_id=${accountId} AND e.event_kind='FILL' AND e.occurred_at >= start_at AND e.occurred_at < end_at
         AND f.event_id IS NULL) AS "unaccountedFillEvents",
      (SELECT count(*)::integer FROM intents i
       WHERE i.account_id=${accountId} AND i.created_at < end_at AND i.state <> 'TERMINAL') AS "nonterminalIntents"
    FROM bounds
  `.pipe(decode(CutRow))
    if (cut === undefined) return yield* Effect.die(new Error('Missing one-row session bounds'))
    const { startAt, endAt, closeAt } = cut
    const decisions = yield* sql`
    SELECT c.cycle_id, d.decision_hash, d.document::text AS document_json, d.created_at,
      c.strategy_protocol_hash, c.qualification_run_id, g.generation_hash AS authority_generation_hash, g.risk_policy_hash
    FROM autonomous_cycles c JOIN autonomous_cycle_shadow_decisions d
      ON d.cycle_id = c.cycle_id AND d.decision_hash = c.decision_hash
    JOIN authority_generations g ON g.account_id = c.account_id AND g.maximum = 'PAPER'
      AND g.strategy_parameter_schema_version IN ('bayn.intraday-alpha-policy.v2', 'bayn.intraday-alpha-policy.v3')
      AND coalesce(g.qualification_run_id,g.research_plan_hash) = c.qualification_run_id
      AND coalesce(g.protocol_hash,g.strategy_protocol_hash) = c.strategy_protocol_hash
      AND d.created_at >= g.activated_at
      AND NOT EXISTS (
        SELECT 1 FROM authority_generations next
        WHERE next.previous_generation_hash=g.generation_hash AND next.account_id=g.account_id
          AND next.maximum='PAPER' AND next.activated_at<=d.created_at
      )
    WHERE c.account_id=${accountId} AND c.execution_session_date=${sessionDate}::date
      AND (d.document #>> '{strategyDecision,schemaVersion}' IN ('bayn.intraday-alpha-target.v2', 'bayn.intraday-alpha-target.v3')
        OR d.document #>> '{strategyDecision,schemaVersion}' IS NULL)
    ORDER BY d.created_at,c.cycle_id COLLATE "C"
  `.pipe(decode(DecisionRow))
    const entries: Entry[] = []
    const calendarCloses: CalendarClose[] = []
    let unverifiedDecisions = 0
    for (const row of decisions) {
      const projection = projectDecision(row, accountId, sessionDate)
      if (projection === 'UNVERIFIED') unverifiedDecisions++
      else {
        if (projection.entry !== null) entries.push(projection.entry)
        if (projection.calendar !== null) calendarCloses.push(projection.calendar)
      }
    }
    const regularCloseAt = alphaSessionRegularClose(closeAt, calendarCloses).at
    const cycleIds = entries.map((entry) => entry.cycleId)
    const fills = yield* sql`
    SELECT f.fill_id AS "fillId", f.source_timestamp AS "sourceAt", f.broker_order_id AS "orderId",
      coalesce(t.intent_id,f.intent_id) AS "intentId", f.symbol, f.side, f.quantity_atoms::text AS "quantityAtoms",
      f.price_atoms::text AS "priceAtoms", t.realized_pnl_micros::text AS "grossMicros", t.fee_micros::text AS "feeMicros",
      coalesce(r.receipt_id IS NOT NULL AND r.intent_id IS NOT DISTINCT FROM t.intent_id AND t.account_id = f.account_id
        AND t.symbol=f.symbol AND t.side=f.side AND t.quantity_atoms=f.quantity_atoms
        AND t.price_atoms=f.price_atoms AND t.fee_micros=f.fee_micros AND t.occurred_at=e.occurred_at
        AND (f.intent_id IS NULL OR t.intent_id IS NOT DISTINCT FROM f.intent_id),false) AS "accountingBound"
    FROM fills f JOIN broker_events e USING (event_id)
    LEFT JOIN accounting_transactions t ON t.broker_event_id=f.event_id
    LEFT JOIN accounting_receipts r ON r.broker_event_id=f.event_id
    WHERE f.account_id=${accountId} AND e.occurred_at >= ${startAt} AND e.occurred_at < ${endAt}
    ORDER BY f.source_timestamp COLLATE "C", f.fill_id COLLATE "C"
  `.pipe(decode(FillRow))
    const orders = yield* sql`
    WITH latest AS (
      SELECT DISTINCT ON (o.broker_order_id) o.*
      FROM orders o JOIN broker_events e USING (event_id)
      WHERE o.account_id=${accountId} AND e.occurred_at < ${endAt}
      ORDER BY o.broker_order_id,o.broker_updated_at COLLATE "C" DESC,e.source_sequence DESC
    )
    SELECT o.broker_order_id AS "orderId", o.parent_broker_order_id AS "parentOrderId",
      coalesce(o.intent_id,parent.intent_id) AS "intentId", i.cycle_id AS "cycleId", o.symbol, o.side, o.status,
      o.order_type AS "orderType", i.protection->>'_tag' AS "protectionTag",
      o.quantity_atoms::text AS "quantityAtoms", o.filled_quantity_atoms::text AS "filledQuantityAtoms",
      o.limit_price_micros::text AS "limitPriceMicros", o.stop_price_micros::text AS "stopPriceMicros",
      o.broker_updated_at AS "updatedAt"
    FROM latest o LEFT JOIN latest parent ON parent.broker_order_id=o.parent_broker_order_id
    LEFT JOIN intents i ON i.intent_id=coalesce(o.intent_id,parent.intent_id) AND i.account_id=o.account_id
    WHERE o.status IN ('NEW','PENDING','PARTIALLY_FILLED')
      OR i.cycle_id = ANY(${cycleIds}::text[])
      OR o.broker_order_id = ANY(${fills.map((fill) => fill.orderId)}::text[])
    ORDER BY o.broker_order_id COLLATE "C"
  `.pipe(decode(OrderRow))
    const closeDocuments = yield* sql`
      SELECT c.cycle_id AS "cycleId", c.document FROM autonomous_cycle_paper_closures c
      WHERE c.cycle_id = ANY(${cycleIds}::text[])
      UNION ALL
      SELECT r.cycle_id AS "cycleId", r.document FROM autonomous_cycle_paper_close_replans r
      WHERE r.cycle_id = ANY(${cycleIds}::text[])
    `.pipe(decode(Schema.Struct({ cycleId: Id, document: Schema.Unknown })))
    const stopSymbols = [
      ...new Set(
        orders
          .filter(
            (order) =>
              order.orderType === OrderType.StopLimit &&
              order.parentOrderId !== null &&
              order.filledQuantityAtoms === '0' &&
              (order.status === OrderStatus.Expired || order.status === OrderStatus.Canceled),
          )
          .map((order) => order.symbol),
      ),
    ]
    const stopPositionMarks = yield* sql`
      SELECT p.symbol, to_char(s.observed_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"000Z"') AS "observedAt",
        p.quantity_atoms::text AS "quantityAtoms", p.market_price_micros::text AS "markPriceMicros",
        p.unrealized_pnl_micros::text AS "unrealizedPnlMicros"
      FROM position_snapshots s JOIN positions p USING (snapshot_id, account_id)
      WHERE s.account_id=${accountId} AND s.observed_at >= ${startAt} AND s.observed_at < ${endAt}
        AND p.symbol = ANY(${stopSymbols}::text[]) AND p.quantity_atoms <> 0 AND p.market_price_micros > 0
      ORDER BY s.observed_at,s.snapshot_id COLLATE "C",p.symbol COLLATE "C"
    `.pipe(decode(PositionRow))
    const postClosePositions = yield* sql`
      SELECT DISTINCT ON (p.symbol) p.symbol,
        to_char(s.observed_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"000Z"') AS "observedAt",
        p.quantity_atoms::text AS "quantityAtoms", p.market_price_micros::text AS "markPriceMicros",
        p.unrealized_pnl_micros::text AS "unrealizedPnlMicros"
      FROM position_snapshots s JOIN positions p USING (snapshot_id, account_id)
      WHERE s.account_id=${accountId} AND s.observed_at > ${regularCloseAt} AND s.observed_at < ${endAt}
        AND p.quantity_atoms <> 0
      ORDER BY p.symbol,s.observed_at,s.snapshot_id COLLATE "C"
    `.pipe(decode(PositionRow))
    const [controllerTicks] = yield* sql`
      SELECT count(*)::integer AS "observedTicks",
        count(*) FILTER (WHERE wait_reason='CLOSE_MARKET_DATA_UNAVAILABLE')::integer AS "closeMarketDataUnavailableTicks"
      FROM (
        SELECT DISTINCT ON (o.controller_key,o.status->>'epoch',o.status->>'last_sequence')
          o.status #>> '{last_pass,waitReason}' AS wait_reason
        FROM execution_controller_observations o
        WHERE o.recorded_at >= ${startAt}
          AND o.controller_key IN (SELECT g.broker_identity_hash FROM authority_generations g
            WHERE g.account_id=${accountId} AND g.maximum='PAPER')
          AND (o.status->>'completed_at')::timestamptz >= ${startAt}
          AND (o.status->>'completed_at')::timestamptz < ${endAt}
        ORDER BY o.controller_key,o.status->>'epoch',o.status->>'last_sequence',o.recorded_at DESC,o.observation_id DESC
      ) completed
    `.pipe(decode(TickCountRow))
    if (controllerTicks === undefined) return yield* Effect.die(new Error('Missing one-row controller tick counts'))
    const inventory = yield* sql`
    WITH inventory_legs AS (
      SELECT symbol, quantity_delta_atoms AS quantity, cost_basis_delta_micros AS basis, occurred_at AS effective_at
      FROM accounting_transactions WHERE account_id=${accountId} AND occurred_at < ${endAt}
      UNION ALL
      SELECT symbol, -quantity_atoms, -cost_basis_micros, effective_at
      FROM broker_inventory_debits WHERE account_id=${accountId} AND posted AND effective_at < ${endAt}
    )
    SELECT symbol,
      coalesce(sum(quantity) FILTER (WHERE effective_at < ${startAt}),0)::text AS "openingAtoms",
      coalesce(sum(basis) FILTER (WHERE effective_at < ${startAt}),0)::text AS "openingBasisMicros",
      sum(quantity)::text AS "closingAtoms",sum(basis)::text AS "closingBasisMicros",
      coalesce(sum(quantity) FILTER (WHERE effective_at <= ${regularCloseAt}),0)::text AS "atRegularCloseAtoms"
    FROM inventory_legs GROUP BY symbol
    HAVING sum(quantity) <> 0 OR sum(basis) <> 0
      OR coalesce(sum(quantity) FILTER (WHERE effective_at < ${startAt}),0) <> 0
      OR coalesce(sum(basis) FILTER (WHERE effective_at < ${startAt}),0) <> 0
      OR coalesce(sum(quantity) FILTER (WHERE effective_at <= ${regularCloseAt}),0) <> 0
    ORDER BY symbol COLLATE "C"
  `.pipe(decode(InventoryRow))
    const reconciliation = yield* sql`
    SELECT r.status,r.reconciled_at AS "reconciledAt",jsonb_array_length(r.discrepancies) AS discrepancies,
      p.position_count AS "positionCount",p.observed_at AS "positionsObservedAt",
      (r.account_event_id IS NOT NULL AND p.observed_at IS NOT NULL AND p.observed_at <= r.reconciled_at AND NOT EXISTS (
        SELECT 1 FROM broker_events e LEFT JOIN accounting_receipts receipt ON receipt.broker_event_id=e.event_id
        WHERE e.account_id=${accountId} AND e.occurred_at >= ${startAt} AND e.occurred_at < ${endAt}
          AND ((e.event_kind IN ('ORDER','FILL') AND e.observed_at > r.reconciled_at) OR
            (e.event_kind='FILL' AND (e.occurred_at > p.observed_at OR receipt.recorded_at > r.reconciled_at)))
      )) AS "coversSessionEvidence"
    FROM reconciliations r LEFT JOIN position_snapshots p
      ON p.account_id=r.account_id AND p.snapshot_id=r.position_snapshot_id
    WHERE r.account_id=${accountId} AND r.reconciled_at >= ${startAt} AND r.reconciled_at < ${endAt}
    ORDER BY r.reconciled_at DESC,r.reconciliation_id COLLATE "C" DESC LIMIT 1
  `.pipe(decode(ReconciliationRow))
    const cancellations = yield* sql`
    SELECT i.cycle_id AS "cycleId", coalesce(a.observed_at < ${endAt}, false) AS acknowledged,
      EXISTS (SELECT 1 FROM protection_release_proofs p
        WHERE p.intent_id=k.intent_id AND p.broker_order_id=k.broker_order_id AND p.requested_at=k.requested_at
          AND p.recorded_at < ${endAt}) AS released
    FROM native_protection_cancel_commands k JOIN intents i USING (account_id,intent_id)
    LEFT JOIN native_protection_cancel_receipts a USING (account_id,intent_id,broker_order_id,requested_at)
    WHERE k.account_id=${accountId} AND k.requested_at >= ${startAt} AND k.requested_at < ${endAt}
      AND i.cycle_id = ANY(${entries.map((entry) => entry.cycleId)}::text[])
  `.pipe(decode(CancelRow))
    // These are session-dated regulatory equity activities, potentially posted after the close/date.
    // Do not add broker_cash_fee_deltas as well; that is a cash/observation-date bridge with overlapping rows.
    const fees = yield* sql`
    SELECT net_amount_micros::text AS "netAmountMicros",posted_at IS NOT NULL AS posted
    FROM broker_fee_accounting
    WHERE account_id=${accountId} AND fee_date=${sessionDate}::date
      AND NOT (data ? 'coinDebit') AND data->>'cryptoCashFee' IS DISTINCT FROM 'true'
  `.pipe(decode(FeeRow))
    const rows: AlphaSessionRows = {
      cut,
      entries,
      unverifiedDecisions,
      fills,
      unaccountedFillEvents: cut.unaccountedFillEvents,
      nonterminalIntents: cut.nonterminalIntents,
      orders,
      inventory,
      cancellations,
      fees,
      reconciliation: reconciliation[0] ?? null,
      calendarCloses,
      closeReferences: projectCloseReferences(closeDocuments, accountId),
      stopPositionMarks,
      postClosePositions,
      controllerTicks,
    }
    return { closeAt, rows }
  })
