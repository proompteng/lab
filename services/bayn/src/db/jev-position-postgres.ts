import { PgClient } from '@effect/sql-pg'
import { Effect, Layer, Schema } from 'effect'

import { operationalError } from '../errors'
import { FillSchema, OrderSide } from '../execution/contracts'
import { decodeJevPortfolio, JevPositionStore, JevPurpose, type JevPortfolio } from '../jev/portfolio'
import { Sha256Schema, strictParseOptions } from '../schemas'

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
    if (portfolio.purpose !== JevPurpose.Manage) return
    yield* requireMatch(
      yield* sql`
    SELECT EXISTS (
      SELECT 1 FROM autonomous_cycle_shadow_decisions AS decision
      JOIN autonomous_cycles AS cycle ON cycle.cycle_id = decision.cycle_id
      WHERE decision.cycle_id = ${cycleId} AND decision.decision_hash = ${portfolio.entryDecisionHash}
        AND cycle.strategy_name = 'jev' AND cycle.account_id = ${state.account.accountId}
        AND decision.document #>> '{bindings,accountId}' = cycle.account_id
        AND decision.document #>> '{strategyDecision,schemaVersion}' = 'bayn.jev-entry-target.v1'
        AND NOT EXISTS (
          SELECT 1 FROM intents AS intent WHERE intent.cycle_id = ${cycleId} AND intent.side = ${OrderSide.Buy}
            AND (intent.account_id <> cycle.account_id OR intent.strategy_name <> 'jev'
              OR intent.decision_hash IS DISTINCT FROM decision.document #>> '{bindings,strategyDecisionHash}'
              OR intent.authority_generation_hash IS DISTINCT FROM decision.document #>> '{bindings,authorityGenerationHash}')
        )
        AND (decision.document ->> 'createdAt')::timestamptz <= ${portfolio.entryFills[0]?.occurredAt ?? r.reconciledAt}::timestamptz
        AND ARRAY(SELECT value FROM jsonb_array_elements_text(decision.document -> 'orderedIntentIds') AS item(value) ORDER BY value COLLATE "C")
          = ARRAY(SELECT jsonb_array_elements_text(${JSON.stringify([...portfolio.entryIntentIds].sort())}::jsonb))
    ) AND ARRAY(
      SELECT intent_id FROM intents WHERE cycle_id = ${cycleId} AND side = ${OrderSide.Buy} ORDER BY intent_id COLLATE "C"
    ) = ARRAY(SELECT jsonb_array_elements_text(${JSON.stringify([...portfolio.entryIntentIds].sort())}::jsonb)) AS matches
  `,
    )
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
          AND fill.quantity_micros = ${fill.quantityMicros} AND fill.price_micros = ${fill.priceMicros}
          AND fill.fee_micros = ${fill.feeMicros} AND event.occurred_at = ${fill.occurredAt}::timestamptz
          AND event.observed_at <= ${r.reconciledAt}::timestamptz AND receipt.recorded_at <= ${r.reconciledAt}::timestamptz
          AND receipt.intent_id = fill.intent_id
          AND transaction.intent_id = fill.intent_id AND transaction.account_id = fill.account_id
          AND transaction.symbol = fill.symbol AND transaction.side = fill.side
          AND transaction.quantity_micros = fill.quantity_micros AND transaction.price_micros = fill.price_micros
          AND transaction.fee_micros = fill.fee_micros AND transaction.occurred_at = event.occurred_at
      ) AS matches
    `,
      )
    }
  })

export const makeJevPositionStore = Effect.gen(function* () {
  const sql = yield* PgClient.PgClient
  return {
    read: ({ cycleId, entryDecisionHash, brokerState }) =>
      Effect.gen(function* () {
        const intents = yield* Schema.decodeUnknownEffect(
          Schema.Array(Schema.Struct({ intent_id: Sha256Schema })).check(Schema.isMinLength(1)),
          strictParseOptions,
        )(
          yield* sql`
        SELECT intent_id FROM intents WHERE cycle_id = ${cycleId} AND account_id = ${brokerState.account.accountId}
          AND side = ${OrderSide.Buy} ORDER BY intent_id COLLATE "C"
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
          'symbol', fill.symbol, 'side', fill.side, 'quantityMicros', fill.quantity_micros::text,
          'priceMicros', fill.price_micros::text, 'feeMicros', fill.fee_micros::text,
          'occurredAt', to_char(event.occurred_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
        ) AS fill
        FROM fills AS fill JOIN broker_events AS event ON event.event_id = fill.event_id
        JOIN intents AS intent ON intent.intent_id = fill.intent_id
        WHERE intent.cycle_id = ${cycleId} AND fill.account_id = ${brokerState.account.accountId}
          AND intent.side = ${OrderSide.Buy} AND fill.side = ${OrderSide.Buy}
        ORDER BY event.occurred_at, fill.fill_id COLLATE "C"
      `,
        )
        const portfolio = yield* Effect.fromResult(
          decodeJevPortfolio({
            purpose: JevPurpose.Manage,
            brokerState,
            entryDecisionHash,
            entryIntentIds: intents.map(({ intent_id }) => intent_id),
            entryFills: rows.map(({ fill }) => fill),
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
