import { PgClient } from '@effect/sql-pg'
import { Effect, Result, Schema } from 'effect'

import { Authority, FillSchema, KillState, NativeProtectionSchema, OrderSchema } from '../execution/contracts'
import { maximumBrokerObservationAgeMs, ObservedBrokerSnapshotSchema } from '../broker/alpaca/observed-snapshot'
import { BrokerReadErrorKind } from '../broker/alpaca/failures'
import { makeBrokerObservationStore } from '../db/broker-observations'
import { databaseUtcInstant } from '../db/clock'
import {
  Sha256Schema,
  StrictNonEmptyStringSchema,
  UnsignedMicrosSchema,
  UtcDatabaseInstantSchema,
  UtcInstantSchema,
  UtcOrderTimestampSchema,
} from '../schemas'
import { ValkeyCache } from '../valkey-cache'
import { legacyAuthorityStateSchemaVersion } from '../execution/legacy-wire'
import type { ForwardPerformanceConfig } from '../forward-performance/config'

export const SafetyAuthorityStateSchema = Schema.Struct({
  singleton: Schema.Literal(true),
  schema_version: Schema.Literal(legacyAuthorityStateSchemaVersion),
  generation_hash: Sha256Schema,
  maximum: Schema.Enum(Authority),
  effective: Schema.Enum(Authority),
  kill_state: Schema.Enum(KillState),
  reason: Schema.NullOr(Schema.String),
  version: Schema.Int.check(Schema.isGreaterThan(0)),
  updated_at: Schema.String,
})

export const OperationalSafetySourceSchema = Schema.Struct({
  schemaVersion: Schema.Literal('bayn.operational-safety-source.v1'),
  accountId: StrictNonEmptyStringSchema,
  asOf: UtcInstantSchema,
  baseline: Schema.NullOr(Schema.Struct({ capturedAt: UtcDatabaseInstantSchema, authority: Schema.Unknown })),
  authority: Schema.Unknown,
  authorityTransitions: Schema.Array(
    Schema.Struct({ capturedAt: UtcDatabaseInstantSchema, previous: Schema.Unknown, authority: Schema.Unknown }),
  ),
  admissions: Schema.Array(
    Schema.Struct({
      eventId: Sha256Schema,
      intentId: Sha256Schema,
      authorityGenerationHash: Sha256Schema,
      capturedAt: UtcDatabaseInstantSchema,
      authority: Schema.Unknown,
    }),
  ),
  broker: Schema.Union([
    Schema.Struct({ status: Schema.Literal('AVAILABLE'), snapshot: ObservedBrokerSnapshotSchema }),
    Schema.Struct({
      status: Schema.Literal('UNAVAILABLE'),
      kind: Schema.Enum(BrokerReadErrorKind),
      operation: Schema.String,
      retryable: Schema.Boolean,
    }),
  ]),
  bindings: Schema.Array(
    Schema.Struct({
      intentId: Sha256Schema,
      clientOrderId: Schema.String,
      symbol: Schema.String,
      quantityAtoms: UnsignedMicrosSchema,
      protection: Schema.optionalKey(NativeProtectionSchema),
    }),
  ),
  intents: Schema.Array(
    Schema.Struct({
      intentId: Sha256Schema,
      authorityGenerationHash: Sha256Schema,
      plan: Schema.Unknown,
      risk: Schema.Unknown,
    }),
  ),
  orders: Schema.Array(
    Schema.Struct({
      eventId: Sha256Schema,
      contentHash: Sha256Schema,
      occurredAt: UtcInstantSchema,
      order: OrderSchema,
    }),
  ),
  fills: Schema.Array(
    Schema.Struct({
      eventId: Sha256Schema,
      contentHash: Sha256Schema,
      sourceTimestamp: UtcOrderTimestampSchema,
      sourceSequence: UnsignedMicrosSchema,
      observedAt: UtcInstantSchema,
      transactionId: Schema.NullOr(Sha256Schema),
      receiptId: Schema.NullOr(Sha256Schema),
      fill: FillSchema,
    }),
  ),
})
export type OperationalSafetySource = typeof OperationalSafetySourceSchema.Type

/** Read alongside the operational cut, before its repeatable-read transaction is released. */
export const captureOperationalSafetySource = (
  config: Pick<ForwardPerformanceConfig, 'build'>,
  registrationHash: string,
  accountId: string,
  asOf: string,
) =>
  Effect.gen(function* () {
    const sql = yield* PgClient.PgClient
    const cache = yield* ValkeyCache
    const baseline =
      yield* sql`SELECT ${databaseUtcInstant(sql, sql`captured_at`)} AS "capturedAt", authority_state AS authority
      FROM operational_safety_baselines WHERE registration_hash=${registrationHash}`
    const authority = yield* sql`SELECT to_jsonb(a) AS state FROM authority_state a WHERE singleton`
    const authorityTransitions =
      yield* sql`SELECT ${databaseUtcInstant(sql, sql`t.captured_at`)} AS "capturedAt", t.previous_state AS previous, t.authority_state AS authority
      FROM operational_safety_authority_transitions t JOIN operational_safety_baselines b ON b.registration_hash=${registrationHash}
      WHERE t.authority_version > (b.authority_state->>'version')::bigint AND t.captured_at<=${asOf}::timestamptz ORDER BY t.authority_version`
    const admissions =
      yield* sql`SELECT a.event_id AS "eventId", i.intent_id AS "intentId", i.authority_generation_hash AS "authorityGenerationHash", ${databaseUtcInstant(sql, sql`a.captured_at`)} AS "capturedAt", a.authority_state AS authority
      FROM operational_safety_mutation_admissions a JOIN mutation_events m USING(event_id) JOIN intents i USING(intent_id)
      WHERE i.account_id=${accountId} AND a.captured_at<=${asOf}::timestamptz ORDER BY a.captured_at,a.event_id`
    const observed = yield* makeBrokerObservationStore(
      sql,
      accountId,
      config.build.sourceRevision,
      maximumBrokerObservationAgeMs,
      cache,
    ).read.pipe(Effect.result)
    const bindings = yield* sql`SELECT intent_id AS "intentId", client_order_id AS "clientOrderId", symbol,
      quantity_atoms::text AS "quantityAtoms", protection FROM intents WHERE account_id=${accountId} AND created_at<=${asOf}::timestamptz ORDER BY intent_id`
    const intents =
      yield* sql`SELECT i.intent_id AS "intentId", i.authority_generation_hash AS "authorityGenerationHash",
      jsonb_strip_nulls(jsonb_build_object('schemaVersion','bayn.intent-plan.v3','strategyName',i.strategy_name,
      'cycleId',i.cycle_id,'decisionHash',i.decision_hash,'policyHash',i.policy_hash,'accountId',i.account_id,
      'symbol',i.symbol,'side',i.side,'orderType',i.order_type,'timeInForce',i.time_in_force,
      'quantityAtoms',i.quantity_atoms::text,'notionalLimitMicros',i.notional_limit_micros::text,'limitPriceMicros',i.limit_price_micros::text,
      'protection',i.protection,'replanGenerationHash',i.replan_generation_hash,'createdAt',to_char(i.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))) AS plan,
      CASE WHEN r.decision_id IS NULL THEN NULL ELSE jsonb_build_object('schemaVersion',r.schema_version,'decisionId',r.decision_id,
      'inputHash',r.input_hash,'intentId',r.intent_id,'policyHash',r.policy_hash,'outcome',r.outcome,'reasonCodes',r.reason_codes,
      'decidedAt',to_char(r.decided_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),'expiresAt',to_char(r.expires_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') ) END AS risk
      FROM intents i LEFT JOIN risk_decisions r ON r.intent_id=i.intent_id AND r.decision_id=i.risk_decision_id
      WHERE i.account_id=${accountId} AND i.created_at<=${asOf}::timestamptz ORDER BY i.intent_id`
    const orders =
      yield* sql`SELECT DISTINCT ON (o.broker_order_id) e.event_id AS "eventId", e.normalized_content_hash AS "contentHash", to_char(e.occurred_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "occurredAt",
      jsonb_strip_nulls(jsonb_build_object('schemaVersion',o.schema_version,'accountId',o.account_id,
      'brokerOrderId',o.broker_order_id,'parentBrokerOrderId',o.parent_broker_order_id,'clientOrderId',o.client_order_id,'intentId',o.intent_id,
      'symbol',o.symbol,'side',o.side,'orderType',o.order_type,'timeInForce',o.time_in_force,'quantityAtoms',o.quantity_atoms::text,
      'notionalMicros',o.notional_micros::text,'filledQuantityAtoms',o.filled_quantity_atoms::text,'limitPriceMicros',o.limit_price_micros::text,
      'stopPriceMicros',o.stop_price_micros::text,'status',o.status,'observedAt',to_char(e.observed_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))) AS "order"
      FROM orders o JOIN broker_events e USING(event_id) WHERE o.account_id=${accountId} AND e.observed_at<=${asOf}::timestamptz
      ORDER BY o.broker_order_id,e.source_sequence DESC,e.event_id COLLATE "C" DESC`
    const fills =
      yield* sql`SELECT e.event_id AS "eventId", e.normalized_content_hash AS "contentHash", f.source_timestamp AS "sourceTimestamp", e.source_sequence::text AS "sourceSequence", to_char(e.observed_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "observedAt",
      t.transaction_id AS "transactionId", r.receipt_id AS "receiptId",
      jsonb_strip_nulls(jsonb_build_object('schemaVersion',f.schema_version,'accountId',f.account_id,'fillId',f.fill_id,
      'brokerOrderId',f.broker_order_id,'clientOrderId',f.client_order_id,'intentId',f.intent_id,'symbol',f.symbol,'side',f.side,
      'quantityAtoms',f.quantity_atoms::text,'priceAtoms',f.price_atoms::text,'feeMicros',f.fee_micros::text,
      'occurredAt',to_char(e.occurred_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))) AS fill
      FROM fills f JOIN broker_events e USING(event_id)
      LEFT JOIN accounting_transactions t ON t.broker_event_id=e.event_id
      LEFT JOIN accounting_receipts r ON r.broker_event_id=e.event_id AND r.recorded_at<=${asOf}::timestamptz
      WHERE f.account_id=${accountId} AND e.observed_at<=${asOf}::timestamptz ORDER BY f.fill_id`
    return yield* Schema.decodeUnknownEffect(OperationalSafetySourceSchema)({
      schemaVersion: 'bayn.operational-safety-source.v1',
      accountId,
      asOf,
      baseline: baseline[0] ?? null,
      authority: authority[0]?.['state'] ?? null,
      authorityTransitions,
      admissions,
      broker: Result.isSuccess(observed)
        ? { status: 'AVAILABLE', snapshot: observed.success }
        : {
            status: 'UNAVAILABLE',
            kind: observed.failure.kind,
            operation: observed.failure.operation,
            retryable: observed.failure.retryable,
          },
      bindings: bindings.map((row) => {
        const { protection, ...binding } = row
        return protection === null ? binding : row
      }),
      orders,
      fills,
      intents,
    })
  })
