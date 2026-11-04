import { PgClient } from '@effect/sql-pg'
import { Effect, Schema } from 'effect'

import { executionDecisionRows } from '../db/execution-decision-query'
import { generationScope } from '../forward-performance/postgres/scope'
import { canonicalHashV1Result } from '../hash'
import { Sha256Schema, SignedMicrosSchema, UtcInstantSchema } from '../schemas'
import { SystemSourceCutSchema } from './source-cut'

export const readSystemCashObservations = (
  accountId: string,
  scope: {
    readonly accountBindingHash: string
    readonly openAt: string
    readonly closeAt: string
    readonly asOf: string
  },
) =>
  Effect.gen(function* () {
    const sql = yield* PgClient.PgClient
    return yield* Schema.decodeUnknownEffect(
      Schema.Array(
        Schema.Struct({
          accountBindingHash: Sha256Schema,
          sourceHash: Sha256Schema,
          at: UtcInstantSchema,
          availableAt: UtcInstantSchema,
          cashMicros: SignedMicrosSchema,
        }),
      ),
    )(
      yield* sql`
    SELECT ${scope.accountBindingHash}::text AS "accountBindingHash", event.content_hash AS "sourceHash",
      to_char(event.occurred_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS at,
      to_char(event.observed_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "availableAt",
      snapshot.cash_micros::text AS "cashMicros"
    FROM account_snapshots AS snapshot JOIN broker_events AS event USING (event_id)
    WHERE snapshot.account_id = ${accountId}
      AND event.occurred_at BETWEEN ${scope.openAt}::timestamptz AND ${scope.closeAt}::timestamptz
      AND event.observed_at <= ${scope.asOf}::timestamptz
    ORDER BY event.occurred_at, event.source_sequence`,
    )
  })

export const readSystemBatchEvidence = (accountId: string, generationHash: string, openAt: string, closeAt: string) =>
  Effect.gen(function* () {
    const sql = yield* PgClient.PgClient
    return yield* Schema.decodeUnknownEffect(SystemSourceCutSchema.fields.batches)(
      yield* sql`
      SELECT plan.payload AS plan, observation.payload AS observation, result.payload AS result
      FROM jev_batch_plans AS plan JOIN autonomous_cycles AS cycle USING (cycle_id)
      LEFT JOIN intraday_candidate_observations AS observation ON observation.content_hash = plan.observation_hash
      LEFT JOIN jev_batch_results AS result USING (batch_id)
      WHERE cycle.account_id = ${accountId} AND plan.authority_generation_hash = ${generationHash}
        AND plan.payload->>'observedAt' >= ${openAt}
        AND plan.payload->>'observedAt' < ${closeAt}
      ORDER BY plan.payload->>'observedAt', plan.batch_id`,
    )
  })

export const readSystemMutationEvidence = (accountId: string, generationHash: string, from: string) =>
  Effect.gen(function* () {
    const sql = yield* PgClient.PgClient
    return yield* Schema.decodeUnknownEffect(SystemSourceCutSchema.fields.mutations)(
      yield* sql`
        WITH latest AS MATERIALIZED (
          SELECT DISTINCT ON (event.mutation_id) event.mutation_id, event.event_type, event.occurred_at
          FROM mutation_events AS event JOIN intents AS intent USING (intent_id)
          WHERE intent.account_id = ${accountId} AND intent.authority_generation_hash = ${generationHash}
          ORDER BY event.mutation_id, event.sequence DESC
        )
        SELECT intent.authority_generation_hash AS "authorityGenerationHash", intent.decision_hash AS "strategyDecisionHash", jsonb_strip_nulls(jsonb_build_object(
          'schemaVersion', event.schema_version, 'eventId', event.event_id, 'mutationId', event.mutation_id,
          'intentId', event.intent_id, 'sequence', event.sequence::integer, 'operation', event.operation,
          'eventType', event.event_type, 'requestHash', event.request_hash, 'consistencyDelayMs', event.consistency_delay_ms,
          'brokerOrderId', event.broker_order_id, 'requestId', event.request_id, 'responseStatus', event.response_status,
          'responseContentHash', event.response_content_hash, 'denialReason', event.denial_reason,
          'occurredAt', to_char(event.occurred_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')))
          || CASE WHEN event.routing IS NULL THEN '{}'::jsonb ELSE jsonb_build_object('routing', event.routing) END AS event
        FROM mutation_events AS event JOIN intents AS intent USING (intent_id) JOIN latest USING (mutation_id)
        WHERE intent.account_id = ${accountId} AND intent.authority_generation_hash = ${generationHash}
          AND (latest.occurred_at >= ${from}::timestamptz OR latest.event_type IN (
            'SUBMIT_STARTED', 'CANCEL_STARTED', 'SUBMIT_UNKNOWN', 'CANCEL_UNKNOWN', 'RECOVERY_UNKNOWN'))
        ORDER BY event.mutation_id, event.sequence`,
    )
  })

export const systemControllerPassQuery = (
  sql: PgClient.PgClient,
  controllerKey: string,
  planHash: string | null,
  openAt: string,
  closeAt: string,
  asOf: string,
) => sql`
        SELECT DISTINCT status->>'controller_key' AS "controllerKey",
          status->>'plan_hash' AS "planHash", (status->>'epoch')::double precision AS epoch,
          (status->>'last_sequence')::double precision AS sequence, status->>'last_receipt_hash' AS "receiptHash",
          to_char((status->>'completed_at')::timestamptz AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "completedAt",
          status->'last_pass' AS observation
        FROM execution_controller_observations
        WHERE controller_key = ${controllerKey} AND status->>'plan_hash' = ${planHash}
          AND status->>'last_receipt_hash' IS NOT NULL AND jsonb_typeof(status->'last_pass') = 'object'
          AND (status->>'completed_at')::timestamptz <= ${asOf}::timestamptz
          AND ((status->>'completed_at')::timestamptz BETWEEN ${openAt}::timestamptz AND ${closeAt}::timestamptz
            OR (status #>> '{last_pass,executionIssuedAt}')::timestamptz BETWEEN ${openAt}::timestamptz AND ${closeAt}::timestamptz)
        ORDER BY "receiptHash", epoch, sequence, "completedAt"`

export const readSystemControllerPasses = (
  controllerKey: string,
  planHash: string | null,
  openAt: string,
  closeAt: string,
  asOf: string,
) =>
  Effect.gen(function* () {
    const sql = yield* PgClient.PgClient
    return yield* Schema.decodeUnknownEffect(SystemSourceCutSchema.fields.controllerPasses)(
      yield* systemControllerPassQuery(sql, controllerKey, planHash, openAt, closeAt, asOf),
    )
  })

export const readSystemDurableObservations = (registrationHash: string) =>
  Effect.gen(function* () {
    const sql = yield* PgClient.PgClient
    return yield* Schema.decodeUnknownEffect(SystemSourceCutSchema.fields.durableObservations)(
      yield* sql`
    SELECT kind, source_hash AS "sourceHash", correct,
      to_char(source_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "sourceAt",
      to_char((date_trunc('milliseconds', witnessed_at) +
        CASE WHEN witnessed_at > date_trunc('milliseconds', witnessed_at) THEN interval '1 millisecond'
          ELSE interval '0' END) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "witnessedAt"
    FROM system_durable_observations WHERE registration_hash = ${registrationHash}
    ORDER BY witnessed_at, kind, source_hash`,
    )
  })

export const readSystemDecisionAdmissions = ({
  accountId,
  generationHash,
  openAt,
  firstSession,
  lastSession,
  asOf,
}: {
  readonly accountId: string
  readonly generationHash: string
  readonly openAt: string
  readonly firstSession: string
  readonly lastSession: string
  readonly asOf: string
}) =>
  Effect.gen(function* () {
    const sql = yield* PgClient.PgClient
    const rows = yield* Schema.decodeUnknownEffect(
      Schema.Array(
        Schema.Struct({
          eventId: Sha256Schema,
          decisionId: Sha256Schema,
          observedAt: UtcInstantSchema,
        }),
      ),
    )(
      yield* sql`
      SELECT receipt.event_id AS "eventId", receipt.decision_id AS "decisionId",
        to_char((date_trunc('milliseconds', receipt.observed_at) +
          CASE WHEN receipt.observed_at > date_trunc('milliseconds', receipt.observed_at)
            THEN interval '1 millisecond' ELSE interval '0' END) AT TIME ZONE 'UTC',
          'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "observedAt"
      FROM execution_decision_admissions receipt JOIN mutation_events event USING(event_id)
        JOIN intents intent USING(intent_id)
        JOIN autonomous_cycles cycle ON cycle.cycle_id = intent.cycle_id
      WHERE intent.account_id = ${accountId} AND intent.authority_generation_hash = ${generationHash}
        AND cycle.execution_session_date BETWEEN ${firstSession}::date AND ${lastSession}::date
        AND event.occurred_at >= ${openAt}::timestamptz
        AND receipt.observed_at <= ${asOf}::timestamptz
      ORDER BY receipt.event_id, receipt.decision_id`,
    )
    return yield* Effect.forEach(rows, (row) =>
      Effect.gen(function* () {
        return { ...row, sourceHash: yield* Effect.fromResult(canonicalHashV1Result(row)) }
      }),
    )
  })

export const systemDecisionQuery = (
  sql: PgClient.PgClient,
  scope: {
    readonly accountId: string
    readonly generationHash: string
    readonly firstSession: string
    readonly lastSession: string
  },
) => sql`
  SELECT cycle.execution_session_date::text AS "sessionDate", decision.document
  FROM autonomous_cycles AS cycle JOIN (${executionDecisionRows(sql)}) AS decision USING (cycle_id)
  WHERE cycle.account_id = ${scope.accountId}
    AND ${generationScope(sql, scope.accountId, scope.generationHash, 'cycle')}
    AND cycle.execution_session_date BETWEEN ${scope.firstSession}::date AND ${scope.lastSession}::date
  ORDER BY cycle.execution_session_date, decision.decision_hash`
