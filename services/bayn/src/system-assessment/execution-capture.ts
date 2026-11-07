import { PgClient } from '@effect/sql-pg'
import { Effect, Schema } from 'effect'
import { canonicalHashV1Result } from '../hash'
import { ReconciliationSchema } from '../execution/contracts'
import { ProtectionIntentEvidenceSchema } from './execution-plans'
import { ObservedExecutionOrderSchema } from './execution-evidence'
import { SystemAssessmentError } from './economics'
import { FillSchema } from '../execution/contracts'
import { Sha256Schema, UnsignedMicrosSchema, UtcInstantSchema, UtcOrderTimestampSchema } from '../schemas'

export interface ExecutionCaptureScope {
  readonly accountId: string
  readonly generationHash: string
  readonly firstSession: string
  readonly lastSession: string
  readonly asOf: string
}

export const readSystemProtectionIntents = (scope: ExecutionCaptureScope, maximumBrokerStateAgeMs: number) =>
  Effect.gen(function* () {
    const sql = yield* PgClient.PgClient
    const rows = yield* Schema.decodeUnknownEffect(
      Schema.Array(
        Schema.Struct({
          ...ProtectionIntentEvidenceSchema.fields,
          sourceHash: Schema.optionalKey(Sha256Schema),
          reconciliation: Schema.Array(ReconciliationSchema),
        }),
      ),
    )(
      yield* sql`
      SELECT intent.intent_id AS "intentId", intent.client_order_id AS "clientOrderId",
        intent.authority_generation_hash AS "authorityGenerationHash",
        jsonb_strip_nulls(jsonb_build_object(
          'schemaVersion','bayn.intent-plan.v3','strategyName',intent.strategy_name,'cycleId',intent.cycle_id,
          'decisionHash',intent.decision_hash,'policyHash',intent.policy_hash,'accountId',intent.account_id,
          'symbol',intent.symbol,'side',intent.side,'orderType',intent.order_type,'timeInForce',intent.time_in_force,
          'quantityAtoms',intent.quantity_atoms::text,'notionalLimitMicros',intent.notional_limit_micros::text,
          'limitPriceMicros',intent.limit_price_micros::text,'protection',intent.protection,
          'replanGenerationHash',intent.replan_generation_hash,
          'createdAt',to_char(intent.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
        )) AS plan,
        jsonb_build_object('schemaVersion',risk.schema_version,'decisionId',risk.decision_id,'inputHash',risk.input_hash,
          'intentId',risk.intent_id,'policyHash',risk.policy_hash,'outcome',risk.outcome,'reasonCodes',risk.reason_codes,
          'decidedAt',to_char(risk.decided_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
          'expiresAt',to_char(risk.expires_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')) AS "riskDecision",
        coalesce((SELECT jsonb_agg(jsonb_build_object('schemaVersion',r.schema_version,'reconciliationId',r.reconciliation_id,
          'accountId',r.account_id,'expectedHash',r.expected_hash,'observedHash',r.observed_hash,'contentHash',r.content_hash,
          'status',r.status,'discrepancies',r.discrepancies,
          'reconciledAt',to_char(r.reconciled_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')))
          FROM reconciliations r WHERE r.account_id=intent.account_id AND r.reconciled_at <= intent.created_at
            AND r.reconciled_at > intent.created_at - ${maximumBrokerStateAgeMs} * interval '1 millisecond'), '[]'::jsonb) AS reconciliation
      FROM intents intent JOIN autonomous_cycles cycle USING(cycle_id)
        JOIN risk_decisions risk ON risk.intent_id=intent.intent_id AND risk.decision_id=intent.risk_decision_id
      WHERE intent.account_id=${scope.accountId} AND cycle.account_id=${scope.accountId}
        AND intent.authority_generation_hash=${scope.generationHash}
        AND cycle.execution_session_date BETWEEN ${scope.firstSession}::date AND ${scope.lastSession}::date
        AND intent.protection->>'_tag' IN ('Oco','StopLimit') AND risk.outcome='APPROVED'
        AND intent.created_at<=${scope.asOf}::timestamptz AND risk.decided_at<=${scope.asOf}::timestamptz
      ORDER BY intent.created_at,intent.intent_id`,
    )
    return yield* Effect.forEach(rows, (row) =>
      Effect.gen(function* () {
        const matches = []
        for (const reconciliation of row.reconciliation) {
          const hash = yield* Effect.fromResult(
            canonicalHashV1Result({
              entryDecisionHash:
                row.plan.protection !== undefined && row.plan.protection._tag !== 'Bracket'
                  ? row.plan.protection.entryDecisionHash
                  : null,
              reconciliationId: reconciliation.reconciliationId,
              protection: row.plan.protection,
            }),
          )
          if (hash === row.plan.replanGenerationHash) matches.push(reconciliation)
        }
        const reconciliation = matches[0]
        if (reconciliation === undefined || matches.length !== 1)
          return yield* new SystemAssessmentError({ message: 'Protection intent lacks its exact fresh reconciliation' })
        const material = {
          plan: row.plan,
          authorityGenerationHash: row.authorityGenerationHash,
          intentId: row.intentId,
          clientOrderId: row.clientOrderId,
          riskDecision: row.riskDecision,
          reconciliation,
        }
        return { ...material, sourceHash: yield* Effect.fromResult(canonicalHashV1Result(material)) }
      }),
    )
  })

export const ObservedExecutionFillSchema = Schema.Struct({
  eventId: Sha256Schema,
  observedAt: UtcInstantSchema,
  sourceTimestamp: UtcOrderTimestampSchema,
  sourceSequence: UnsignedMicrosSchema,
  fill: FillSchema,
})
export const readSystemExecutionFills = (scope: ExecutionCaptureScope, openAt: string, closeAt: string) =>
  Effect.gen(function* () {
    const sql = yield* PgClient.PgClient
    return yield* Schema.decodeUnknownEffect(Schema.Array(ObservedExecutionFillSchema))(
      yield* sql`
      SELECT event.event_id AS "eventId", event.source_sequence::text AS "sourceSequence", fill.source_timestamp AS "sourceTimestamp",
        to_char(event.observed_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "observedAt",
        jsonb_strip_nulls(jsonb_build_object('schemaVersion',fill.schema_version,'accountId',fill.account_id,
          'fillId',fill.fill_id,'brokerOrderId',fill.broker_order_id,'clientOrderId',fill.client_order_id,'intentId',fill.intent_id,
          'symbol',fill.symbol,'side',fill.side,'quantityAtoms',fill.quantity_atoms::text,'priceAtoms',fill.price_atoms::text,
          'feeMicros',fill.fee_micros::text,'occurredAt',to_char(event.occurred_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))) AS fill
      FROM fills fill JOIN broker_events event USING(event_id) JOIN intents intent USING(intent_id)
        JOIN autonomous_cycles cycle USING(cycle_id)
      WHERE fill.account_id=${scope.accountId} AND intent.account_id=${scope.accountId} AND cycle.account_id=${scope.accountId}
        AND intent.authority_generation_hash=${scope.generationHash}
        AND cycle.execution_session_date BETWEEN ${scope.firstSession}::date AND ${scope.lastSession}::date
        AND event.occurred_at BETWEEN ${openAt}::timestamptz AND ${closeAt}::timestamptz
        AND event.observed_at<=${scope.asOf}::timestamptz
      ORDER BY event.occurred_at,event.source_sequence,event.event_id`,
    )
  })

export const readSystemExecutionOrders = (scope: ExecutionCaptureScope) =>
  Effect.gen(function* () {
    const sql = yield* PgClient.PgClient
    return yield* Schema.decodeUnknownEffect(Schema.Array(ObservedExecutionOrderSchema))(
      yield* sql`
      SELECT DISTINCT ON (observed.broker_order_id)
        event.event_id AS "eventId",
        to_char(event.occurred_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "occurredAt",
        jsonb_strip_nulls(jsonb_build_object(
          'schemaVersion', observed.schema_version, 'accountId', observed.account_id,
          'brokerOrderId', observed.broker_order_id, 'parentBrokerOrderId', observed.parent_broker_order_id,
          'clientOrderId', observed.client_order_id, 'intentId', observed.intent_id,
          'symbol', observed.symbol, 'side', observed.side, 'orderType', observed.order_type,
          'timeInForce', observed.time_in_force, 'quantityAtoms', observed.quantity_atoms::text,
          'notionalMicros', observed.notional_micros::text, 'filledQuantityAtoms', observed.filled_quantity_atoms::text,
          'limitPriceMicros', observed.limit_price_micros::text, 'stopPriceMicros', observed.stop_price_micros::text,
          'status', observed.status,
          'observedAt', to_char(event.observed_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
        )) AS "order"
      FROM orders observed JOIN broker_events event ON event.event_id = observed.event_id
        JOIN intents intent ON intent.intent_id = observed.intent_id
        JOIN autonomous_cycles cycle ON cycle.cycle_id = intent.cycle_id
      WHERE observed.account_id = ${scope.accountId} AND intent.account_id = ${scope.accountId}
        AND cycle.account_id = ${scope.accountId}
        AND intent.authority_generation_hash = ${scope.generationHash}
        AND cycle.execution_session_date BETWEEN ${scope.firstSession}::date AND ${scope.lastSession}::date
        AND event.observed_at <= ${scope.asOf}::timestamptz
      ORDER BY observed.broker_order_id, event.source_sequence DESC, event.event_id COLLATE "C" DESC`,
    )
  })
