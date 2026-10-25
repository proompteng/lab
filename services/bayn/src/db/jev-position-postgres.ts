import { JevPositionExitPolicySchema } from '../jev/exit-policy'
import { PgClient } from '@effect/sql-pg'
import { Effect, Layer, Schema } from 'effect'
import { JevExitReason, JevExitTargetSchema } from '../jev/exit'

import { operationalError } from '../errors'
import { FillSchema, OrderSide } from '../execution/contracts'
import {
  decodeJevPortfolio,
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
    if (portfolio.purpose !== JevPurpose.Manage) return
    yield* requireMatch(
      yield* sql`
    SELECT EXISTS (
      SELECT 1 FROM autonomous_cycle_shadow_decisions AS decision
      JOIN autonomous_cycles AS cycle ON cycle.cycle_id = decision.cycle_id
      WHERE decision.cycle_id = ${cycleId} AND decision.decision_hash = ${portfolio.entryDecisionHash}
        AND cycle.strategy_name = 'jev' AND cycle.account_id = ${state.account.accountId}
        AND decision.document #>> '{bindings,accountId}' = cycle.account_id
        AND decision.document #>> '{strategyDecision,schemaVersion}' = 'bayn.jev-entry-target.v6'
        AND decision.document #> '{strategyDecision,exitPolicy}' = ${JSON.stringify(portfolio.exitPolicy)}::jsonb
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
    const protection = yield* readProtectionEvidence(sql, cycleId, portfolio.entryDecisionHash)
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
      portfolio.entryFills[0]?.symbol ?? '',
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
  symbol: string,
  firstFillAt: string,
  reconciledAt: string,
) =>
  Effect.gen(function* () {
    const [debit] = yield* Schema.decodeUnknownEffect(
      Schema.Tuple([JevInventoryDebitSchema]),
      strictParseOptions,
    )(
      yield* sql`
      SELECT COALESCE(sum(quantity_atoms),0)::text AS "quantityAtoms", COALESCE(sum(cost_basis_micros),0)::text AS "costBasisMicros"
      FROM broker_inventory_debits WHERE account_id=${accountId} AND symbol=${symbol} AND posted
        AND effective_at >= ${firstFillAt}::timestamptz AND effective_at <= ${reconciledAt}::timestamptz
    `,
    )
    return debit
  })

const readProtectionEvidence = (sql: PgClient.PgClient, cycleId: string, entryDecisionHash: string) =>
  Effect.gen(function* () {
    const rows = yield* Schema.decodeUnknownEffect(
      Schema.Array(Schema.Struct({ intentId: Sha256Schema })),
      strictParseOptions,
    )(
      yield* sql`
    SELECT intent_id AS "intentId" FROM intents WHERE cycle_id = ${cycleId} AND protection IS NOT NULL
      AND (protection ->> '_tag' = 'Bracket' OR protection ->> 'entryDecisionHash' = ${entryDecisionHash})
    ORDER BY intent_id COLLATE "C"
  `,
    )
    const [latch] = yield* Schema.decodeUnknownEffect(
      Schema.Tuple([Schema.Struct({ exitRequestedAt: Schema.NullOr(Schema.String) })]),
      strictParseOptions,
    )(
      yield* sql`
    SELECT to_char(min(at) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "exitRequestedAt" FROM (
      SELECT c.requested_at AS at FROM native_protection_cancel_commands c JOIN intents i USING (intent_id)
        WHERE i.cycle_id = ${cycleId}
      UNION ALL
      SELECT i.updated_at FROM intents i WHERE i.cycle_id = ${cycleId} AND i.protection ->> '_tag' IN ('Oco','StopLimit')
        AND i.state = 'TERMINAL' AND i.terminal_outcome = 'REJECTED'
      UNION ALL
      SELECT t.occurred_at FROM accounting_transactions t JOIN intents i USING (intent_id)
        JOIN accounting_receipts r USING (broker_event_id)
        WHERE i.cycle_id = ${cycleId} AND i.protection IS NOT NULL AND t.side = 'SELL'
    ) requests
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
      WHERE i.cycle_id = ${cycleId} ORDER BY c.requested_at, c.broker_order_id COLLATE "C" LIMIT 1
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
    SELECT COALESCE(sum(-t.quantity_delta_atoms),0)::text AS "quantityAtoms", COALESCE(sum(-t.cost_basis_delta_micros),0)::text AS "costBasisMicros"
    FROM accounting_transactions t JOIN accounting_receipts receipt ON receipt.broker_event_id = t.broker_event_id AND receipt.intent_id = t.intent_id JOIN intents i ON i.intent_id = t.intent_id
    WHERE i.cycle_id = ${cycleId} AND i.protection IS NOT NULL AND t.side = 'SELL'
  `,
    )
    return {
      protectionIntentIds: rows.map((row) => row.intentId),
      exitRequestedAt: latch.exitRequestedAt,
      profitExitRequested:
        request !== undefined &&
        request.requestedAt === latch.exitRequestedAt &&
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
          'symbol', fill.symbol, 'side', fill.side, 'quantityAtoms', fill.quantity_atoms::text,
          'priceAtoms', fill.price_atoms::text, 'feeMicros', fill.fee_micros::text,
          'occurredAt', to_char(event.occurred_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
        ) AS fill
        FROM fills AS fill JOIN broker_events AS event ON event.event_id = fill.event_id
        JOIN intents AS intent ON intent.intent_id = fill.intent_id
        WHERE intent.cycle_id = ${cycleId} AND fill.account_id = ${brokerState.account.accountId}
          AND intent.side = ${OrderSide.Buy} AND fill.side = ${OrderSide.Buy}
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
            brokerState,
            entryDecisionHash,
            ...(yield* readProtectionEvidence(sql, cycleId, entryDecisionHash)),
            exitPolicy: entry.exitPolicy,
            entryIntentIds: intents.map(({ intent_id }) => intent_id),
            entryFills: rows.map(({ fill }) => fill),
            entryInventoryDebit: yield* readEntryInventoryDebit(
              sql,
              brokerState.account.accountId,
              rows[0]?.fill.symbol ?? '',
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
