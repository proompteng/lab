import type { PgClient } from '@effect/sql-pg'
import { Data, Effect, Result, Schema } from 'effect'

import { OrderType } from '../src/execution/contracts'
import { legacyExecutionAuthorityToken } from '../src/execution/legacy-wire'
import { CycleDecisionJsonRow } from '../src/forward-performance/postgres/model'
import { verifyPerformanceDecisionJson } from '../src/forward-performance/postgres/projection'
import { forwardPerformanceSnapshot } from '../src/forward-performance/postgres/snapshot'
import { decodeIntradayBarRows } from '../src/market-data/intraday/rows'
import { normalizeBar } from '../src/market-data/intraday/verification'
import { isContinuousMarket, regularEquitySessions } from '../src/market-hours'
import { StrictNonEmptyStringSchema, strictParseOptions } from '../src/schemas'
import { priceNumberToMicros } from '../src/strategy/execution-model/fixed-point'
import { IntradayAlphaPhase } from '../src/strategy/intraday-alpha/constants'
import { AuditInput } from './live-profitability-audit-core'

const Session = AuditInput.fields.sessions.value
const Calendar = Session.fields.calendar
const Entry = Session.fields.entries.value
const Id = StrictNonEmptyStringSchema
const nullableId = Schema.NullOr(Id)
const read = <S extends Schema.Constraint>(schema: S) =>
  Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(schema), strictParseOptions))

const CutRow = Schema.Struct({
  startAt: Schema.Date,
  endAt: Schema.Date,

  missingFillEvents: Session.fields.missingFillEvents,
})
const DecisionRow = Schema.Struct({ ...CycleDecisionJsonRow.fields, entry: Schema.Boolean })
const StoredOrder = Schema.Struct({
  ...Session.fields.orders.value.fields,
  intentId: nullableId,
  decisionHash: nullableId,
  protectionEntryHash: nullableId,
})
const { positions: PositionRows, ...reconciliationFields } = Session.fields.reconciliation.members[0].fields
const ReconciliationCut = Schema.Struct({ id: nullableId, ...reconciliationFields })
type Calendar = NonNullable<typeof Calendar.Type>

class AuditScopeError extends Data.TaggedError('AuditScopeError')<{ readonly message: string }> {}

const projectDecisions = (rows: readonly (typeof DecisionRow.Type)[], account: string, date: string) => {
  const entries: (typeof Entry.Type)[] = []
  const calendars: Calendar[] = []
  const exits = new Map<string, string>()
  const entryBindings = new Map<string, string | null>()
  let unverifiedDecisions = 0
  for (const row of rows) {
    const document = verifyPerformanceDecisionJson(row).verifiedRows[0]?.document
    if (
      document?.mode !== legacyExecutionAuthorityToken ||
      document.contentHash !== row.decision_hash ||
      document.createdAt !== row.created_at.toISOString() ||
      document.bindings.cycleId !== row.cycle_id ||
      document.bindings.accountId !== account ||
      (document.executionSession !== undefined && document.executionSession.executionSession.date !== date)
    ) {
      unverifiedDecisions++
      continue
    }
    const calendar = document.executionSession?.calendar
    if (calendar !== undefined && !isContinuousMarket(calendar)) {
      const regular = regularEquitySessions(calendar).find((day) => day.date === date)
      if (regular !== undefined) calendars.push({ openAt: regular.openAt, closeAt: regular.closeAt })
    }

    const target = document.strategyDecision
    if (!row.entry) {
      for (const item of document.targetPlan.targets)
        exits.set(JSON.stringify([document.contentHash, item.symbol]), item.referencePriceMicros)
      continue
    }
    if (
      target?.schemaVersion !== 'bayn.intraday-alpha-target.v2' ||
      target.sessionDate !== date ||
      !document.dispatchable ||
      target.phase === IntradayAlphaPhase.OutsideWindow
    )
      continue
    const observation = target.evidence.observation
    const end = observation.manifest['rangeEndAt']
    const bars = decodeIntradayBarRows(observation.rows.bars)
    const signal = new Map<string, string>()
    if (typeof end === 'string' && Result.isSuccess(bars)) {
      for (const raw of bars.success) {
        if (Date.parse(raw.event_at) !== Date.parse(end) - 60_000) continue
        const bar = normalizeBar(raw)
        if (Result.isFailure(bar)) continue
        const price = priceNumberToMicros(bar.success.close, 'signal close', 'NEAREST')
        if (Result.isSuccess(price)) signal.set(bar.success.symbol, price.success.toString())
      }
    }
    for (const [index, leg] of document.targetPlan.intentTargets.entries()) {
      const id = document.orderedIntentIds[index]
      if (id === undefined) {
        unverifiedDecisions++
        continue
      }
      const key = JSON.stringify([document.contentHash, leg.symbol])
      entryBindings.set(key, entryBindings.has(key) ? null : id)
      entries.push({
        id,
        sleeve: target.phase,
        symbol: leg.symbol,
        side: leg.side,
        quantityAtoms: leg.quantityAtoms,
        signalMicros: signal.get(leg.symbol) ?? null,
        referenceMicros:
          document.targetPlan.targets.find(({ symbol }) => symbol === leg.symbol)?.referencePriceMicros ?? null,
        holdMinutes: target.exitPolicy.plans[leg.symbol]?.levels.maximumHoldingMinutes ?? null,
      })
    }
  }
  return { entries, calendars, exits, unverifiedDecisions, entryBindings }
}

const readSession = (sql: PgClient.PgClient, account: string, date: string, controllerKeys: readonly string[]) =>
  Effect.gen(function* () {
    const [cut] = yield* sql`
      WITH bounds AS (
        SELECT ${date}::date::timestamp AT TIME ZONE 'America/New_York' AS start_at,
          (${date}::date + 1)::timestamp AT TIME ZONE 'America/New_York' AS day_end,
          transaction_timestamp() AS observed_at
      )
      SELECT start_at AS "startAt", LEAST(observed_at,day_end) AS "endAt",
        (SELECT count(*)::integer FROM broker_events e LEFT JOIN fills f USING (event_id)
         WHERE e.account_id=${account} AND e.event_kind='FILL' AND e.occurred_at>=start_at
           AND e.occurred_at<LEAST(observed_at,day_end) AND f.event_id IS NULL) AS "missingFillEvents"
      FROM bounds
    `.pipe(read(CutRow))
    if (cut === undefined || cut.endAt < cut.startAt) return null
    const { startAt, endAt } = cut
    const decisions = yield* sql`
      WITH cycles AS (
        SELECT cycle_id,decision_hash FROM autonomous_cycles
        WHERE account_id=${account} AND execution_session_date=${date}::date
          AND execution_calendar_source='alpaca-v2-calendar'
      )
      SELECT c.cycle_id,d.decision_hash,d.document::text AS document_json,d.created_at,true AS entry
      FROM cycles c JOIN autonomous_cycle_shadow_decisions d USING (cycle_id,decision_hash)
      WHERE d.created_at<${endAt}
      UNION ALL
      SELECT c.cycle_id,d.close_decision_hash,(d.document->'document')::text,d.created_at,false
      FROM cycles c JOIN autonomous_cycle_paper_closures d USING (cycle_id) WHERE d.created_at<${endAt}
      UNION ALL
      SELECT c.cycle_id,d.close_decision_hash,(d.document->'document')::text,d.created_at,false
      FROM cycles c JOIN autonomous_cycle_paper_close_replans d USING (cycle_id) WHERE d.created_at<${endAt}
    `.pipe(read(DecisionRow))
    const { entries, calendars, exits, unverifiedDecisions, entryBindings } = projectDecisions(decisions, account, date)
    const preparation = yield* sql`
      SELECT DISTINCT scope_text::jsonb #>> '{providerSession,regularOpenAt}' AS "openAt",
        scope_text::jsonb #>> '{providerSession,regularCloseAt}' AS "closeAt"
      FROM intraday_alpha_baseline_preparations
      WHERE account_id=${account} AND session_date=${date}::date AND recorded_at<${endAt}
    `.pipe(read(Calendar))
    const calendar = [...calendars, ...preparation].find((item) => item !== null)
    if (
      calendar !== undefined &&
      [...calendars, ...preparation].some(
        (item) => item?.openAt !== calendar.openAt || item.closeAt !== calendar.closeAt,
      )
    )
      return yield* new AuditScopeError({ message: `Conflicting provider regular-session bounds for ${date}` })

    const fills = yield* sql`
      SELECT f.fill_id AS id,f.broker_order_id AS "orderId",f.symbol,f.side,
        f.source_timestamp AS at,
        f.quantity_atoms::text AS "quantityAtoms",f.price_atoms::text AS "priceAtoms",f.fee_micros::text AS "feeMicros",
        CASE WHEN r.receipt_id IS NOT NULL AND t.account_id=f.account_id AND t.symbol=f.symbol
          AND t.side=f.side AND t.quantity_atoms=f.quantity_atoms AND t.price_atoms=f.price_atoms
          AND t.fee_micros=f.fee_micros AND t.occurred_at=e.occurred_at
          AND r.intent_id IS NOT DISTINCT FROM t.intent_id
          AND (f.intent_id IS NULL OR t.intent_id IS NOT DISTINCT FROM f.intent_id)
          THEN t.realized_pnl_micros::text END AS "realizedMicros"
      FROM fills f JOIN broker_events e USING (event_id)
      LEFT JOIN accounting_transactions t ON t.broker_event_id=f.event_id
      LEFT JOIN accounting_receipts r ON r.broker_event_id=f.event_id
      WHERE f.account_id=${account} AND e.occurred_at>=${startAt} AND e.occurred_at<${endAt}
        AND f.symbol NOT LIKE '%/%'
    `.pipe(read(Session.fields.fills.value))

    const storedOrders = yield* sql`
      WITH history AS MATERIALIZED (
        SELECT o.*,e.occurred_at,e.source_sequence
        FROM orders o JOIN broker_events e USING (event_id)
        WHERE o.account_id=${account} AND e.occurred_at<${endAt} AND o.symbol NOT LIKE '%/%'
      ), latest AS (
        SELECT DISTINCT ON (broker_order_id) * FROM history
        ORDER BY broker_order_id,broker_updated_at COLLATE "C" DESC,source_sequence DESC
      ), first AS (
        SELECT DISTINCT ON (broker_order_id) * FROM history
        ORDER BY broker_order_id,broker_updated_at COLLATE "C",source_sequence
      )
      SELECT o.broker_order_id AS id, o.parent_broker_order_id AS "parentId", o.symbol,o.side,o.order_type AS type,
        o.status,o.quantity_atoms::text AS "quantityAtoms",f.limit_price_micros::text AS "limitMicros",
        o.stop_price_micros::text AS "stopMicros",NULL::text AS "exitReferenceMicros",NULL::text AS "entryId",
        coalesce(to_char(submission.at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),f.broker_updated_at) AS "openedAt",
        CASE WHEN o.status NOT IN ('NEW','PENDING','PARTIALLY_FILLED')
          THEN o.broker_updated_at END AS "terminalAt",
        (o.parent_broker_order_id IS NOT NULL OR coalesce(m.protection->>'_tag','') IN
          ('Oco','EquityShortOco','StopLimit','EquityShortStopLimit')) AS protective,
        m.intent_id AS "intentId",m.decision_hash AS "decisionHash",m.protection->>'entryDecisionHash' AS "protectionEntryHash"
      FROM latest o JOIN first f USING (broker_order_id)
      LEFT JOIN latest parent ON parent.broker_order_id=o.parent_broker_order_id
      LEFT JOIN intents m ON m.account_id=o.account_id AND m.intent_id=coalesce(o.intent_id,parent.intent_id)
      LEFT JOIN LATERAL (
        SELECT min(occurred_at) AS at FROM mutation_events
        WHERE intent_id=m.intent_id AND event_type='SUBMIT_STARTED' AND occurred_at<=f.occurred_at
          AND o.parent_broker_order_id IS NULL
      ) submission ON true
      WHERE o.occurred_at>=${startAt} OR o.status IN ('NEW','PENDING','PARTIALLY_FILLED')
        OR o.broker_order_id=ANY(${fills.map(({ orderId }) => orderId)}::text[])
    `.pipe(read(StoredOrder))
    const entriesById = new Set(entries.map(({ id }) => id))
    const orders = storedOrders.map(({ intentId, decisionHash, protectionEntryHash, ...order }) => ({
      ...order,
      entryId:
        intentId !== null && entriesById.has(intentId)
          ? intentId
          : (entryBindings.get(JSON.stringify([protectionEntryHash, order.symbol])) ?? null),
      // A child's trigger or profit limit is a precommitted exit benchmark, not its execution price.
      exitReferenceMicros: order.protective
        ? (order.stopMicros ?? order.limitMicros)
        : (exits.get(JSON.stringify([decisionHash, order.symbol])) ?? null),
    }))

    const stopSymbols = [
      ...new Set(
        orders.filter((row) => row.protective && row.type === OrderType.StopLimit).map(({ symbol }) => symbol),
      ),
    ]
    const positionMarks =
      stopSymbols.length === 0
        ? []
        : yield* sql`
      SELECT p.symbol,
        to_char(s.observed_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS at,
        p.quantity_atoms::text AS "quantityAtoms",p.market_price_micros::text AS "priceMicros"
      FROM position_snapshots s JOIN positions p USING (snapshot_id,account_id)
      WHERE s.account_id=${account} AND s.observed_at>=${startAt} AND s.observed_at<${endAt}
        AND p.symbol=ANY(${stopSymbols}::text[]) AND p.quantity_atoms<>0 AND p.market_price_micros>0
    `.pipe(read(Session.fields.positionMarks.value))

    const openingPositions = yield* sql`
      WITH movements AS (
        SELECT symbol,quantity_delta_atoms AS quantity FROM accounting_transactions
        WHERE account_id=${account} AND occurred_at<${startAt}
        UNION ALL SELECT symbol,-quantity_atoms FROM broker_inventory_debits
        WHERE account_id=${account} AND posted AND effective_at<${startAt}
      )
      SELECT symbol,sum(quantity)::text AS "quantityAtoms"
      FROM movements WHERE symbol NOT LIKE '%/%' GROUP BY symbol HAVING sum(quantity)<>0
    `.pipe(read(Session.fields.openingPositions.value))
    const [equity] = yield* sql`
      SELECT CASE WHEN a.equity_micros>0 THEN a.equity_micros::text END AS equity
      FROM account_snapshots a JOIN broker_events e USING (event_id)
      WHERE a.account_id=${account} AND e.occurred_at<=${calendar?.openAt ?? startAt}::timestamptz
        AND e.occurred_at>=${startAt}::timestamptz - interval '4 days'
      ORDER BY e.occurred_at DESC,e.source_sequence DESC LIMIT 1
    `.pipe(read(Schema.Struct({ equity: Session.fields.openingEquityMicros })))
    const [reconciliationCut] = yield* sql`
      SELECT p.snapshot_id AS id,to_char(r.reconciled_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS at,
        to_char(p.observed_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "positionsAt",
        (r.status='EXACT' AND jsonb_array_length(r.discrepancies)=0) AS exact,
        p.position_count AS "positionCount",
        (r.account_event_id IS NOT NULL AND NOT EXISTS (
          SELECT 1 FROM broker_events e LEFT JOIN accounting_receipts receipt ON receipt.broker_event_id=e.event_id
          WHERE e.account_id=${account} AND e.occurred_at>=${startAt} AND e.occurred_at<${endAt}
            AND ((e.event_kind IN ('ORDER','FILL') AND e.observed_at>r.reconciled_at)
              OR (e.event_kind='FILL' AND (e.occurred_at>p.observed_at OR receipt.recorded_at>r.reconciled_at)))
        )) AS "coversActivity"
      FROM reconciliations r LEFT JOIN position_snapshots p
        ON p.account_id=r.account_id AND p.snapshot_id=r.position_snapshot_id
      WHERE r.account_id=${account} AND r.reconciled_at>=${startAt} AND r.reconciled_at<${endAt}
      ORDER BY r.reconciled_at DESC,r.reconciliation_id COLLATE "C" DESC LIMIT 1
    `.pipe(read(ReconciliationCut))
    let reconciliation: typeof Session.fields.reconciliation.Type = null
    if (reconciliationCut !== undefined) {
      const { id, ...bound } = reconciliationCut
      const positions =
        id === null
          ? []
          : yield* sql`
        SELECT symbol,quantity_atoms::text AS "quantityAtoms",unrealized_pnl_micros::text AS "unrealizedMicros"
        FROM positions WHERE snapshot_id=${id} AND account_id=${account}
      `.pipe(read(PositionRows.value))
      reconciliation = { ...bound, positions }
    }

    const controller = yield* sql`
      WITH passes AS (
        SELECT DISTINCT ON (controller_key,status->>'last_receipt_hash') controller_key,
          status->>'last_receipt_hash' AS receipt,
          (status->>'completed_at')::timestamptz AS completed,
          status->'last_pass' AS pass
        FROM execution_controller_observations
        WHERE controller_key=ANY(${controllerKeys}::text[]) AND recorded_at>=${startAt} AND recorded_at<${endAt}
          AND status->>'last_receipt_hash' IS NOT NULL AND status->>'completed_at' IS NOT NULL
          AND jsonb_typeof(status->'last_pass')='object'
        ORDER BY controller_key,status->>'last_receipt_hash',observation_id DESC
      )
      SELECT controller_key || ':' || receipt AS id,
        to_char(completed AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS at,
        coalesce(pass->>'brokerObservationFailure'='NO_ADMISSIBLE_CUT',false) AS "noAdmissibleCut",
        coalesce(pass->>'waitReason'='CLOSE_MARKET_DATA_UNAVAILABLE',false) AS "closeMarketDataUnavailable",
        coalesce(pass->>'waitReason'='CLOSE_WINDOW_EXPIRED',false) AS "closeWindowExpired"
      FROM passes WHERE completed>=${startAt} AND completed<${endAt}
    `.pipe(read(Session.fields.controller.value))

    const [fees] = yield* sql`
      SELECT coalesce(-sum(net_amount_micros) FILTER (WHERE posted_at IS NOT NULL),0)::text AS "postedFeeDebitMicros",
        count(*) FILTER (WHERE posted_at IS NULL)::integer AS "pendingFees"
      FROM broker_fee_accounting WHERE account_id=${account} AND fee_date=${date}::date
        AND NOT (data ? 'coinDebit') AND data->>'cryptoCashFee' IS DISTINCT FROM 'true'
    `.pipe(
      read(
        Schema.Struct({
          postedFeeDebitMicros: Session.fields.postedFeeDebitMicros,
          pendingFees: Session.fields.pendingFees,
        }),
      ),
    )

    // Project only completed regular-session evidence, not raw logs or whole historical candidate payloads.
    const marketSymbols = [
      ...new Set(['QQQ', 'SMH', ...entries.map(({ symbol }) => symbol), ...orders.map(({ symbol }) => symbol)]),
    ]
    const bars = yield* sql`
      SELECT DISTINCT raw->>'symbol' AS symbol,substring(raw->>'event_at',1,23)||'Z' AS at,
        raw->>'feed' AS feed, round((raw->>'close')::numeric * 1000000)::text AS "closeMicros"
      FROM autonomous_cycles c JOIN intraday_candidate_observations o USING (cycle_id)
      CROSS JOIN LATERAL jsonb_array_elements(COALESCE(o.payload #> '{rows,bars}','[]'::jsonb)) raw
      WHERE c.account_id=${account} AND c.execution_session_date=${date}::date AND o.observed_at<${endAt}
        AND raw->>'symbol'=ANY(${marketSymbols}::text[]) AND raw->>'feed' IN ('iex','sip')
        AND raw->>'market_session'='regular' AND raw->>'is_final' IN ('1','true')
    `.pipe(read(Session.fields.market.fields.bars.value))
    const quotes =
      orders.length === 0
        ? []
        : yield* sql`
      SELECT DISTINCT raw->>'symbol' AS symbol,raw->>'event_at' AS at,raw->>'feed' AS feed,
        CASE WHEN (raw->>'bid_size')::numeric>0 THEN round((raw->>'bid_price')::numeric * 1000000)::text END AS "bidMicros",
        CASE WHEN (raw->>'ask_size')::numeric>0 THEN round((raw->>'ask_price')::numeric * 1000000)::text END AS "askMicros"
      FROM autonomous_cycles c JOIN intraday_candidate_observations o USING (cycle_id)
      CROSS JOIN LATERAL jsonb_array_elements(COALESCE(o.payload #> '{rows,quotes}','[]'::jsonb)) raw
      WHERE c.account_id=${account} AND c.execution_session_date=${date}::date AND o.observed_at<${endAt}
        AND raw->>'symbol'=ANY(${marketSymbols}::text[]) AND raw->>'feed' IN ('iex','sip')
        AND (raw->>'event_at')::timestamptz>=${startAt} AND (raw->>'event_at')::timestamptz<${endAt}
    `.pipe(read(Session.fields.market.fields.quotes.value))

    return {
      date,
      dayStartAt: startAt.toISOString(),
      asOf: endAt.toISOString(),
      calendar: calendar ?? null,
      openingEquityMicros: equity?.equity ?? null,
      openingPositions,
      positionMarks,
      reconciliation,
      entries,
      orders,
      fills,
      controller,
      market: { bars, quotes },
      postedFeeDebitMicros: fees?.postedFeeDebitMicros ?? '0',
      pendingFees: fees?.pendingFees ?? 0,
      missingFillEvents: cut.missingFillEvents,
      unverifiedDecisions,
    }
  })

export const readLiveProfitability = (sql: PgClient.PgClient, account: string, dates: readonly string[]) =>
  forwardPerformanceSnapshot(sql).withTransaction(
    Effect.gen(function* () {
      yield* sql`SET LOCAL statement_timeout = '25s'`
      yield* sql`SET LOCAL lock_timeout = '2s'`
      const keys = yield* sql`
    SELECT DISTINCT broker_identity_hash AS key FROM live_capital_grants
    WHERE account_id=${account} AND broker_environment='live' AND schema_version='bayn.live-capital-grant.v1'
    UNION
    SELECT DISTINCT broker_identity_hash AS key FROM authority_generations
    WHERE account_id=${account} AND broker_environment='live' AND broker_identity_hash IS NOT NULL
  `.pipe(read(Schema.Struct({ key: Id })))
      if (keys.length === 0)
        return yield* new AuditScopeError({ message: 'No retained live broker binding for the configured account' })
      const sessions = yield* Effect.forEach(dates, (date) =>
        readSession(
          sql,
          account,
          date,
          keys.map(({ key }) => key),
        ),
      )
      return {
        schemaVersion: 'bayn.live-profitability-evidence.v1' as const,
        sessions: sessions.filter((row) => row !== null),
      }
    }),
  )
