import { JevPositionExitPolicySchema } from '../jev/exit-policy'
import { PgClient } from '@effect/sql-pg'
import { Effect, Layer, Schema } from 'effect'
import { JevExitReason, JevExitTargetSchema } from '../jev/exit'

import { operationalError } from '../errors'
import { FillSchema, OrderStatus } from '../execution/contracts'
import {
  decodeJevPortfolio,
  currentProtectionEvidenceVersion,
  JevInventoryDebitSchema,
  JevPositionStore,
  JevPurpose,
  type JevPortfolio,
} from '../jev/portfolio'
import { Sha256Schema, UtcInstantSchema, strictParseOptions } from '../schemas'

const requireMatch = Schema.decodeUnknownEffect(
  Schema.Tuple([Schema.Struct({ matches: Schema.Literal(true) })]),
  strictParseOptions,
)

export const verifyJevPortfolioSources = (sql: PgClient.PgClient, cycleId: string, portfolio: JevPortfolio) =>
  Effect.gen(function* () {
    const state = portfolio.brokerState
    const r = state.reconciliation
    yield* requireMatch(
      yield* sql`
    SELECT EXISTS (
      SELECT 1 FROM reconciliations WHERE reconciliation_id = ${r.reconciliationId}
        AND account_id = ${state.account.accountId} AND expected_hash = ${r.expectedHash}
        AND observed_hash = ${r.observedHash} AND content_hash = ${r.contentHash}
        AND status = 'EXACT' AND discrepancies = '[]'::jsonb AND reconciled_at = ${r.reconciledAt}::timestamptz
    ) AS matches
  `,
    )
    const externalOpenIntentIds = [
      ...new Set(
        state.orders
          .filter(
            (order) =>
              ![OrderStatus.Filled, OrderStatus.Canceled, OrderStatus.Expired, OrderStatus.Rejected].includes(
                order.status,
              ) &&
              (portfolio.purpose === JevPurpose.Entry || portfolio.exitPolicy.plans[order.symbol] === undefined),
          )
          .map((order) => order.intentId),
      ),
    ]
    if (externalOpenIntentIds.some((id) => id === undefined)) {
      return yield* operationalError({
        component: 'database',
        operation: 'jev-position',
        message: 'Concurrent open order is missing its durable intent identity',
      })
    }
    const verifiedExternalIntentIds = externalOpenIntentIds.filter((id): id is string => id !== undefined).sort()
    if (verifiedExternalIntentIds.length > 0) {
      yield* requireMatch(
        yield* sql`
      SELECT (
        SELECT count(*)::integer FROM intents
        WHERE account_id = ${state.account.accountId}
          AND intent_id = ANY(${verifiedExternalIntentIds}::text[])
          AND protection IS NOT NULL
      ) = ${verifiedExternalIntentIds.length} AS matches
    `,
      )
    }
    if (portfolio.purpose !== JevPurpose.Manage) return
    yield* requireMatch(
      yield* sql`
    SELECT EXISTS (
      SELECT 1 FROM autonomous_cycle_shadow_decisions AS decision
      JOIN autonomous_cycles AS cycle ON cycle.cycle_id = decision.cycle_id
      WHERE decision.cycle_id = ${cycleId} AND decision.decision_hash = ${portfolio.entryDecisionHash}
        AND cycle.strategy_name = 'jev' AND cycle.account_id = ${state.account.accountId}
        AND decision.document #>> '{bindings,accountId}' = cycle.account_id
        AND decision.document #>> '{strategyDecision,schemaVersion}' IN ('bayn.jev-entry-target.v7', 'bayn.entry-ablation-target.v1', 'bayn.repeated-momentum-target.v1', 'bayn.intraday-alpha-target.v1', 'bayn.intraday-alpha-target.v2', 'bayn.intraday-alpha-target.v3')
        AND decision.document #> '{strategyDecision,exitPolicy}' = ${JSON.stringify(portfolio.exitPolicy)}::jsonb
        AND NOT EXISTS (
          SELECT 1 FROM intents AS intent WHERE intent.cycle_id = ${cycleId} AND decision.document -> 'orderedIntentIds' ? intent.intent_id
            AND (intent.account_id <> cycle.account_id OR intent.strategy_name <> 'jev'
              OR intent.decision_hash IS DISTINCT FROM decision.document #>> '{bindings,strategyDecisionHash}'
              OR intent.authority_generation_hash IS DISTINCT FROM decision.document #>> '{bindings,authorityGenerationHash}')
        )
        AND (decision.document ->> 'createdAt')::timestamptz <= ${portfolio.entryFills[0]?.occurredAt ?? r.reconciledAt}::timestamptz
        AND ARRAY(SELECT value FROM jsonb_array_elements_text(decision.document -> 'orderedIntentIds') AS item(value) ORDER BY value COLLATE "C")
          = ARRAY(SELECT jsonb_array_elements_text(${JSON.stringify([...portfolio.entryIntentIds].sort())}::jsonb))
    ) AND ARRAY(
      SELECT i.intent_id FROM intents i JOIN autonomous_cycle_shadow_decisions d ON d.cycle_id = i.cycle_id
      WHERE i.cycle_id = ${cycleId} AND d.decision_hash = ${portfolio.entryDecisionHash}
        AND d.document -> 'orderedIntentIds' ? i.intent_id ORDER BY i.intent_id COLLATE "C"
    ) = ARRAY(SELECT jsonb_array_elements_text(${JSON.stringify([...portfolio.entryIntentIds].sort())}::jsonb)) AS matches
  `,
    )
    const protection = yield* readProtectionEvidence(
      sql,
      cycleId,
      portfolio.entryDecisionHash,
      portfolio.protectionEvidenceVersion,
      r.reconciledAt,
      portfolio.managedSymbol,
    )
    if (
      JSON.stringify(protection.protectionIntentIds) !== JSON.stringify(portfolio.protectionIntentIds) ||
      protection.exitRequestedAt !== portfolio.exitRequestedAt ||
      protection.profitExitRequested !== portfolio.profitExitRequested ||
      JSON.stringify(protection.protectionDisposals) !== JSON.stringify(portfolio.protectionDisposals)
    )
      return yield* operationalError({
        component: 'database',
        operation: 'jev-position',
        message: 'Protection evidence differs from its durable entry binding',
      })
    const debit = yield* readEntryInventoryDebit(
      sql,
      portfolio.brokerState.account.accountId,
      [...new Set(portfolio.entryFills.map((fill) => fill.symbol))].sort(),
      portfolio.entryFills[0]?.occurredAt ?? r.reconciledAt,
      r.reconciledAt,
    )
    if (
      debit.quantityAtoms !== portfolio.entryInventoryDebit.quantityAtoms ||
      debit.costBasisMicros !== portfolio.entryInventoryDebit.costBasisMicros
    )
      return yield* operationalError({
        component: 'database',
        operation: 'jev-position',
        message: 'Held position inventory debit differs from posted accounting',
      })
    for (const fill of portfolio.entryFills) {
      yield* requireMatch(
        yield* sql`
      SELECT EXISTS (
        SELECT 1 FROM fills AS fill JOIN broker_events AS event ON event.event_id = fill.event_id
        JOIN accounting_transactions AS transaction ON transaction.broker_event_id = event.event_id
        JOIN accounting_receipts AS receipt ON receipt.broker_event_id = event.event_id
        WHERE fill.account_id = ${fill.accountId} AND fill.fill_id = ${fill.fillId}
          AND fill.broker_order_id = ${fill.brokerOrderId} AND fill.client_order_id = ${fill.clientOrderId}
          AND fill.intent_id = ${fill.intentId ?? null} AND fill.symbol = ${fill.symbol} AND fill.side = ${fill.side}
          AND fill.quantity_atoms = ${fill.quantityAtoms} AND fill.price_atoms = ${fill.priceAtoms}
          AND fill.fee_micros = ${fill.feeMicros} AND event.occurred_at = ${fill.occurredAt}::timestamptz
          AND event.observed_at <= ${r.reconciledAt}::timestamptz AND receipt.recorded_at <= ${r.reconciledAt}::timestamptz
          AND receipt.intent_id = fill.intent_id
          AND transaction.intent_id = fill.intent_id AND transaction.account_id = fill.account_id
          AND transaction.symbol = fill.symbol AND transaction.side = fill.side
          AND transaction.quantity_atoms = fill.quantity_atoms AND transaction.price_atoms = fill.price_atoms
          AND transaction.fee_micros = fill.fee_micros AND transaction.occurred_at = event.occurred_at
      ) AS matches
    `,
      )
    }
  })

const readEntryInventoryDebit = (
  sql: PgClient.PgClient,
  accountId: string,
  symbols: readonly string[],
  firstFillAt: string,
  reconciledAt: string,
) =>
  Effect.gen(function* () {
    if (symbols.length === 0) return { quantityAtoms: '0', costBasisMicros: '0' }
    const [debit] = yield* Schema.decodeUnknownEffect(
      Schema.Tuple([JevInventoryDebitSchema]),
      strictParseOptions,
    )(
      yield* sql`
      SELECT COALESCE(sum(quantity_atoms),0)::text AS "quantityAtoms", COALESCE(sum(cost_basis_micros),0)::text AS "costBasisMicros"
      FROM broker_inventory_debits WHERE account_id=${accountId} AND symbol = ANY(${symbols}::text[]) AND posted
        AND effective_at >= ${firstFillAt}::timestamptz AND effective_at <= ${reconciledAt}::timestamptz
    `,
    )
    return debit
  })

export const readProtectionEvidence = (
  sql: PgClient.PgClient,
  cycleId: string,
  entryDecisionHash: string,
  version?: typeof currentProtectionEvidenceVersion,
  asOf?: string,
  managedSymbol?: string,
) =>
  Effect.gen(function* () {
    const cutoff =
      version === currentProtectionEvidenceVersion ? yield* Schema.decodeUnknownEffect(UtcInstantSchema)(asOf) : null
    const rows = yield* Schema.decodeUnknownEffect(
      Schema.Array(Schema.Struct({ intentId: Sha256Schema })),
      strictParseOptions,
    )(
      yield* sql`
    SELECT intent_id AS "intentId" FROM intents WHERE cycle_id = ${cycleId} AND protection IS NOT NULL
      AND (protection ->> '_tag' IN ('Bracket','EquityShortBracket') OR protection ->> 'entryDecisionHash' = ${entryDecisionHash})
      AND (${cutoff}::timestamptz IS NULL OR created_at <= ${cutoff}::timestamptz)
    ORDER BY intent_id COLLATE "C"
  `,
    )
    // Untagged retained portfolios reproduce the original all-disposal latch. New evidence keeps a
    // verified native take-profit as inventory disposal; stop fills and unproven child roles still exit.
    const [latch] = yield* Schema.decodeUnknownEffect(
      Schema.Tuple([
        Schema.Struct({
          exitRequestedAt: Schema.NullOr(Schema.String),
          commandOnlyAtEarliest: Schema.Boolean,
          stopDisposalSeen: Schema.Boolean,
        }),
      ]),
      strictParseOptions,
    )(
      yield* sql`
    WITH requests AS (
      SELECT c.requested_at AS at, true AS command, false AS stopped FROM native_protection_cancel_commands c JOIN intents i USING (intent_id)
        WHERE i.cycle_id = ${cycleId} AND NOT c.reanchor
          AND (${managedSymbol ?? null}::text IS NULL OR i.symbol = ${managedSymbol ?? null})
          AND (${cutoff}::timestamptz IS NULL OR c.requested_at < ${cutoff}::timestamptz)
      UNION ALL
      SELECT i.updated_at, false, false FROM intents i WHERE i.cycle_id = ${cycleId} AND i.protection ->> '_tag' IN ('Oco','StopLimit','EquityShortOco','EquityShortStopLimit')
        AND i.state = 'TERMINAL' AND i.terminal_outcome = 'REJECTED'
        AND (${managedSymbol ?? null}::text IS NULL OR i.symbol = ${managedSymbol ?? null})
        AND (${cutoff}::timestamptz IS NULL OR i.updated_at <= ${cutoff}::timestamptz)
      UNION ALL
      SELECT t.occurred_at, false, ${version === currentProtectionEvidenceVersion} AND EXISTS (
        SELECT 1 FROM fills f JOIN orders stop ON stop.broker_order_id = f.broker_order_id
          AND stop.account_id = f.account_id AND stop.intent_id = f.intent_id
        JOIN broker_events order_event ON order_event.event_id = stop.event_id
        WHERE f.event_id = t.broker_event_id AND f.account_id = t.account_id AND f.intent_id = t.intent_id
          AND t.account_id = i.account_id AND t.symbol = i.symbol AND f.symbol = t.symbol AND f.side = t.side
          AND f.quantity_atoms = t.quantity_atoms AND f.price_atoms = t.price_atoms
          AND stop.symbol = t.symbol AND stop.side = t.side AND stop.order_type = 'STOP_LIMIT'
          AND stop.time_in_force = 'DAY'
          AND stop.stop_price_micros = (i.protection ->> 'stopPriceMicros')::numeric
          AND stop.limit_price_micros = (i.protection ->> 'stopLimitPriceMicros')::numeric
          AND stop.quantity_atoms > 0 AND stop.quantity_atoms <= i.quantity_atoms
          AND stop.filled_quantity_atoms >= t.quantity_atoms AND stop.filled_quantity_atoms <= stop.quantity_atoms
          AND order_event.observed_at <= ${cutoff}::timestamptz AND order_event.occurred_at <= ${cutoff}::timestamptz
          AND (
            (i.protection ->> '_tag' IN ('Bracket','EquityShortBracket','Oco','EquityShortOco') AND EXISTS (
              SELECT 1 FROM orders parent JOIN broker_events parent_event ON parent_event.event_id = parent.event_id
              WHERE parent.broker_order_id = stop.parent_broker_order_id AND parent.account_id = i.account_id
                AND parent.intent_id = i.intent_id AND parent.client_order_id = i.client_order_id
                AND parent.symbol = i.symbol AND parent.side = i.side AND parent.quantity_atoms = i.quantity_atoms
                AND parent.order_type = 'LIMIT' AND parent.time_in_force = 'DAY'
                AND parent.parent_broker_order_id IS NULL AND parent.stop_price_micros IS NULL
                AND parent_event.observed_at <= ${cutoff}::timestamptz AND parent_event.occurred_at <= ${cutoff}::timestamptz
            )) OR
            (i.protection ->> '_tag' IN ('StopLimit','EquityShortStopLimit') AND stop.client_order_id = i.client_order_id
              AND stop.parent_broker_order_id IS NULL)
          )
      ) FROM accounting_transactions t JOIN intents i USING (intent_id)
        JOIN accounting_receipts r USING (broker_event_id)
        JOIN broker_events fill_event ON fill_event.event_id = t.broker_event_id
        WHERE i.cycle_id = ${cycleId} AND i.protection IS NOT NULL
          AND (${managedSymbol ?? null}::text IS NULL OR i.symbol = ${managedSymbol ?? null})
          AND (${cutoff}::timestamptz IS NULL OR (t.occurred_at <= ${cutoff}::timestamptz
            AND r.recorded_at <= ${cutoff}::timestamptz AND fill_event.observed_at <= ${cutoff}::timestamptz))
          AND t.side = CASE WHEN i.protection ->> '_tag' IN ('EquityShortBracket','EquityShortOco','EquityShortStopLimit') THEN 'BUY' ELSE 'SELL' END
          AND NOT (${version === currentProtectionEvidenceVersion} AND EXISTS (
            SELECT 1 FROM fills f JOIN orders profit ON profit.broker_order_id = f.broker_order_id
              AND profit.account_id = f.account_id AND profit.intent_id = f.intent_id
            JOIN broker_events order_event ON order_event.event_id = profit.event_id
            WHERE f.event_id = t.broker_event_id AND f.account_id = t.account_id
              AND t.account_id = i.account_id AND t.symbol = i.symbol
              AND f.intent_id = t.intent_id AND f.symbol = t.symbol AND f.side = t.side
              AND f.quantity_atoms = t.quantity_atoms AND f.price_atoms = t.price_atoms
              AND (CASE WHEN i.protection ->> '_tag' IN ('EquityShortBracket','EquityShortOco')
                THEN t.price_atoms <= (i.protection ->> 'profitLimitPriceMicros')::numeric * 1000
                ELSE t.price_atoms >= (i.protection ->> 'profitLimitPriceMicros')::numeric * 1000 END)
              AND profit.symbol = t.symbol AND profit.side = t.side AND profit.order_type = 'LIMIT'
              AND profit.time_in_force = 'DAY' AND profit.stop_price_micros IS NULL
              AND profit.limit_price_micros = (i.protection ->> 'profitLimitPriceMicros')::numeric
              AND profit.quantity_atoms > 0 AND profit.quantity_atoms <= i.quantity_atoms
              AND profit.filled_quantity_atoms >= t.quantity_atoms
              AND profit.filled_quantity_atoms <= profit.quantity_atoms
              AND order_event.observed_at <= ${cutoff}::timestamptz AND order_event.occurred_at <= ${cutoff}::timestamptz
              AND (
                (i.protection ->> '_tag' IN ('Bracket','EquityShortBracket') AND EXISTS (
                  SELECT 1 FROM orders parent JOIN broker_events parent_event ON parent_event.event_id = parent.event_id
                  WHERE parent.broker_order_id = profit.parent_broker_order_id
                    AND parent.account_id = i.account_id AND parent.intent_id = i.intent_id
                    AND parent.client_order_id = i.client_order_id AND parent.symbol = i.symbol
                    AND parent.side = i.side AND parent.quantity_atoms = i.quantity_atoms
                    AND parent.order_type = 'LIMIT' AND parent.time_in_force = 'DAY'
                    AND parent.parent_broker_order_id IS NULL AND parent.stop_price_micros IS NULL
                    AND parent_event.observed_at <= ${cutoff}::timestamptz AND parent_event.occurred_at <= ${cutoff}::timestamptz
                )) OR
                (i.protection ->> '_tag' IN ('Oco','EquityShortOco')
                  AND profit.client_order_id = i.client_order_id AND profit.parent_broker_order_id IS NULL)
              )
          ))
    )
    SELECT to_char(min(at) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "exitRequestedAt",
      COALESCE(bool_and(command) FILTER (WHERE at = (SELECT min(at) FROM requests)), false) AS "commandOnlyAtEarliest",
      COALESCE(bool_or(stopped), false) AS "stopDisposalSeen"
    FROM requests
  `,
    )
    const [request] = yield* Schema.decodeUnknownEffect(
      Schema.Array(
        Schema.Struct({
          target: Schema.NullOr(JevExitTargetSchema),
          requestedAt: UtcInstantSchema,
          bound: Schema.Literal(true),
        }),
      ),
      strictParseOptions,
    )(
      yield* sql`
      SELECT c.exit_target AS target,
        to_char(c.requested_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "requestedAt",
        (c.exit_target IS NULL OR (c.exit_target ->> 'cycleId' = i.cycle_id
          AND c.exit_target #>> '{evidence,portfolio,brokerState,account,accountId}' = c.account_id
          AND EXISTS (SELECT 1 FROM autonomous_cycle_shadow_decisions d WHERE d.cycle_id = i.cycle_id
            AND d.decision_hash = c.exit_target ->> 'entryDecisionHash'
            AND d.document #> '{strategyDecision,exitPolicy}' = c.exit_target #> '{evidence,portfolio,exitPolicy}'))) AS bound
      FROM native_protection_cancel_commands c JOIN intents i USING (intent_id)
      WHERE i.cycle_id = ${cycleId} AND NOT c.reanchor
        AND (${managedSymbol ?? null}::text IS NULL OR i.symbol = ${managedSymbol ?? null})
        AND (${cutoff}::timestamptz IS NULL OR c.requested_at < ${cutoff}::timestamptz)
      ORDER BY c.requested_at, c.broker_order_id COLLATE "C" LIMIT 1
    `,
    )
    if (
      request?.target !== undefined &&
      request.target !== null &&
      (request.target.cycleId !== cycleId ||
        request.target.entryDecisionHash !== entryDecisionHash ||
        request.target.observedAt > request.requestedAt)
    )
      return yield* operationalError({
        component: 'database',
        operation: 'jev-position',
        message: 'Protection cancellation exit evidence differs from its durable entry binding',
      })
    const [disposals] = yield* Schema.decodeUnknownEffect(
      Schema.Tuple([JevInventoryDebitSchema]),
      strictParseOptions,
    )(
      yield* sql`
    SELECT COALESCE(sum(abs(t.quantity_delta_atoms)),0)::text AS "quantityAtoms", COALESCE(sum(abs(t.cost_basis_delta_micros)),0)::text AS "costBasisMicros"
    FROM accounting_transactions t JOIN accounting_receipts receipt ON receipt.broker_event_id = t.broker_event_id AND receipt.intent_id = t.intent_id JOIN intents i ON i.intent_id = t.intent_id
    JOIN broker_events fill_event ON fill_event.event_id = t.broker_event_id
    WHERE i.cycle_id = ${cycleId}
      AND (${cutoff}::timestamptz IS NULL OR (t.occurred_at <= ${cutoff}::timestamptz
        AND receipt.recorded_at <= ${cutoff}::timestamptz AND fill_event.observed_at <= ${cutoff}::timestamptz))
      AND ((i.protection IS NOT NULL AND
        t.side = CASE WHEN i.protection ->> '_tag' IN ('EquityShortBracket','EquityShortOco','EquityShortStopLimit') THEN 'BUY' ELSE 'SELL' END)
        OR (${managedSymbol ?? null}::text IS NOT NULL AND i.protection IS NULL AND EXISTS (
          SELECT 1 FROM (
            SELECT document FROM autonomous_cycle_paper_closures WHERE cycle_id=i.cycle_id
            UNION ALL SELECT document FROM autonomous_cycle_paper_close_replans WHERE cycle_id=i.cycle_id
          ) close_plan
          WHERE close_plan.document->>'entryDecisionHash'=${entryDecisionHash}
            AND close_plan.document #> '{document,orderedIntentIds}' ? i.intent_id
        )))
  `,
    )
    return {
      protectionIntentIds: rows.map((row) => row.intentId),
      exitRequestedAt: latch.exitRequestedAt,
      profitExitRequested:
        request !== undefined &&
        (version === currentProtectionEvidenceVersion
          ? latch.commandOnlyAtEarliest && !latch.stopDisposalSeen
          : request.requestedAt === latch.exitRequestedAt) &&
        request.target !== null &&
        (request.target.reason === JevExitReason.ProfitTarget ||
          (request.target.reason === JevExitReason.ProtectionReleased &&
            request.target.evidence.portfolio.purpose === JevPurpose.Manage &&
            request.target.evidence.portfolio.profitExitRequested)),
      protectionDisposals: disposals,
    }
  })

export const makeJevPositionStore = Effect.gen(function* () {
  const sql = yield* PgClient.PgClient
  return {
    read: ({ cycleId, entryDecisionHash, brokerState, managedSymbol }) =>
      Effect.gen(function* () {
        const intents = yield* Schema.decodeUnknownEffect(
          Schema.Array(Schema.Struct({ intent_id: Sha256Schema })).check(Schema.isMinLength(1)),
          strictParseOptions,
        )(
          yield* sql`
        SELECT intent_id FROM intents i WHERE cycle_id = ${cycleId} AND account_id = ${brokerState.account.accountId}
          AND EXISTS (SELECT 1 FROM autonomous_cycle_shadow_decisions d WHERE d.cycle_id = i.cycle_id
            AND d.decision_hash = ${entryDecisionHash} AND d.document -> 'orderedIntentIds' ? i.intent_id)
          ORDER BY intent_id COLLATE "C"
      `,
        )
        const rows = yield* Schema.decodeUnknownEffect(
          Schema.Array(Schema.Struct({ fill: FillSchema })),
          strictParseOptions,
        )(
          yield* sql`
        SELECT jsonb_build_object(
          'schemaVersion', fill.schema_version, 'accountId', fill.account_id, 'fillId', fill.fill_id,
          'brokerOrderId', fill.broker_order_id, 'clientOrderId', fill.client_order_id, 'intentId', fill.intent_id,
          'symbol', fill.symbol, 'side', fill.side, 'quantityAtoms', fill.quantity_atoms::text,
          'priceAtoms', fill.price_atoms::text, 'feeMicros', fill.fee_micros::text,
          'occurredAt', to_char(event.occurred_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
        ) AS fill
        FROM fills AS fill JOIN broker_events AS event ON event.event_id = fill.event_id
        JOIN intents AS intent ON intent.intent_id = fill.intent_id
        WHERE intent.cycle_id = ${cycleId} AND fill.account_id = ${brokerState.account.accountId}
          AND fill.side = intent.side
          AND EXISTS (SELECT 1 FROM autonomous_cycle_shadow_decisions d WHERE d.cycle_id = intent.cycle_id
            AND d.decision_hash = ${entryDecisionHash} AND d.document -> 'orderedIntentIds' ? intent.intent_id)
        ORDER BY event.occurred_at, fill.fill_id COLLATE "C"
      `,
        )
        const [entry] = yield* Schema.decodeUnknownEffect(
          Schema.Tuple([Schema.Struct({ exitPolicy: JevPositionExitPolicySchema })]),
          strictParseOptions,
        )(
          yield* sql`
          SELECT document #> '{strategyDecision,exitPolicy}' AS "exitPolicy"
          FROM autonomous_cycle_shadow_decisions
          WHERE cycle_id = ${cycleId} AND decision_hash = ${entryDecisionHash}
        `,
        )
        const portfolio = yield* Effect.fromResult(
          decodeJevPortfolio({
            purpose: JevPurpose.Manage,
            protectionEvidenceVersion: currentProtectionEvidenceVersion,
            brokerState,
            entryDecisionHash,
            ...(managedSymbol === undefined ? {} : { managedSymbol }),
            ...(yield* readProtectionEvidence(
              sql,
              cycleId,
              entryDecisionHash,
              currentProtectionEvidenceVersion,
              brokerState.reconciliation.reconciledAt,
              managedSymbol,
            )),
            exitPolicy: entry.exitPolicy,
            entryIntentIds: intents.map(({ intent_id }) => intent_id),
            entryFills: rows.map(({ fill }) => fill),
            entryInventoryDebit: yield* readEntryInventoryDebit(
              sql,
              brokerState.account.accountId,
              [...new Set(rows.map(({ fill }) => fill.symbol))].sort(),
              rows[0]?.fill.occurredAt ?? brokerState.reconciliation.reconciledAt,
              brokerState.reconciliation.reconciledAt,
            ),
          }),
        )
        if (portfolio.purpose !== JevPurpose.Manage)
          return yield* operationalError({
            component: 'database',
            operation: 'jev-position',
            message: 'Expected a held Jev position',
          })
        yield* verifyJevPortfolioSources(sql, cycleId, portfolio)
        return portfolio
      }).pipe(
        Effect.mapError((cause) =>
          operationalError({
            component: 'database',
            operation: 'jev-position',
            message: 'Accounted Jev position evidence could not be verified',
            cause,
          }),
        ),
      ),
  } satisfies JevPositionStore['Service']
})

export const JevPositionStoreLive = Layer.effect(JevPositionStore, makeJevPositionStore)
