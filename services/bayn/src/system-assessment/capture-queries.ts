import { PgClient } from '@effect/sql-pg'
import { Effect, Schema } from 'effect'

import { databaseUtcInstant } from '../db/clock'
import { executionDecisionRows } from '../db/execution-decision-query'
import { generationScope } from '../forward-performance/postgres/scope'
import { canonicalHashV1Result } from '../hash'
import { Sha256Schema, SignedMicrosSchema, UtcInstantSchema, strictParseOptions } from '../schemas'
import { FeeSettlementAnchorsSchema } from './cash-settlements'
import {
  AlphaObservationEvidenceSchema,
  PreparedAlphaSystemDurableObservationSchema,
  RetainedSystemSourceCutSchema,
  SystemDurableObservationSchema,
} from './source-cut'
import { SystemAssessmentError } from './economics'
import { reproduceIntradayAlphaObservation } from '../strategy/intraday-alpha/observation'
import { resolveAlphaRegularSession } from '../strategy/intraday-alpha/signals'
import { registeredAlphaObservationSessions } from './calendar'
import {
  registeredAlphaBaselineCaptureScope,
  verifyRegisteredAlphaBaselinePreparations,
} from './alpha-baseline-capture'
import { RecordedAlphaBaselinePreparationSchema } from '../observe-composition/alpha-baseline-preparation'
import type { SystemRegistration } from './policy'
import { ResearchStrategyEngine } from './strategy-binding'

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

/** Retain observed anchors and posting times, without assigning a physical debit time to a fee. */
export const readSystemFeeSettlementAnchors = (
  accountId: string,
  sessions: readonly { sessionDate: string; openAt: string; closeAt: string; recoveryCloseAt: string }[],
  asOf: string,
) =>
  Effect.gen(function* () {
    const sql = yield* PgClient.PgClient
    return yield* Schema.decodeUnknownEffect(FeeSettlementAnchorsSchema)(
      yield* sql`
      WITH sessions AS (
        SELECT * FROM jsonb_to_recordset(${JSON.stringify(sessions)}::jsonb)
          AS calendar("sessionDate" date, "openAt" timestamptz, "closeAt" timestamptz, "recoveryCloseAt" timestamptz)
      )
      SELECT calendar."sessionDate"::text, bound.phase,
        ${databaseUtcInstant(sql, sql`bound.cut_at`)} AS "cutAt",
        CASE WHEN bound.phase='RECONCILED' THEN reconciliation.content_hash END AS "reconciliationHash",
        CASE WHEN bound.phase='RECONCILED' THEN coalesce(fees.items,'[]'::jsonb) ELSE '[]'::jsonb END AS fees,
        CASE WHEN cash.event_id IS NOT NULL THEN jsonb_build_object(
          'sourceHash',cash.content_hash,'at',${databaseUtcInstant(sql, sql`cash.occurred_at`)},
          'availableAt',${databaseUtcInstant(sql, sql`cash.observed_at`)},
          'cashMicros',cash.cash_micros::text,'positions',CASE WHEN inventory.content_hash IS NOT NULL THEN jsonb_build_object(
            'sourceHash',inventory.content_hash,'at',${databaseUtcInstant(sql, sql`inventory.observed_at`)},
            'count',inventory.position_count) END) END AS observation
      FROM sessions calendar
      CROSS JOIN LATERAL (
        SELECT count(*) AS observed_count, count(fee.posted_at) FILTER (WHERE fee.posted_at<=${asOf}::timestamptz) AS posted_count,
          max(fee.posted_at) AS last_posted,
          jsonb_agg(jsonb_build_object('activityId',fee.activity_id,'sourceHash',fee.content_hash,
            'postedAt',CASE WHEN fee.posted_at<=${asOf}::timestamptz THEN
              ${databaseUtcInstant(sql, sql`fee.posted_at`)} END,
            'availableAt',${databaseUtcInstant(sql, sql`fee.first_observed_at`)})
            ORDER BY fee.activity_id COLLATE "C") AS items
        FROM broker_fee_accounting fee
        WHERE fee.account_id=${accountId} AND fee.fee_date=calendar."sessionDate"
          AND fee.first_observed_at<=${asOf}::timestamptz
      ) fees
      LEFT JOIN LATERAL (
        SELECT rec.reconciled_at,rec.content_hash,rec.account_event_id,rec.position_snapshot_id
        FROM reconciliations rec
        JOIN account_snapshots s ON s.event_id=rec.account_event_id AND s.account_id=rec.account_id
        JOIN broker_events e ON e.event_id=s.event_id AND e.account_id=s.account_id
        JOIN position_snapshots p ON p.snapshot_id=rec.position_snapshot_id AND p.account_id=rec.account_id
        WHERE rec.account_id=${accountId} AND rec.status='EXACT' AND rec.discrepancies='[]'::jsonb
          AND rec.reconciled_at>=greatest(calendar."recoveryCloseAt",fees.last_posted)
          AND rec.reconciled_at<=${asOf}::timestamptz AND fees.observed_count=fees.posted_count
          AND e.event_kind='ACCOUNT'
          AND e.occurred_at BETWEEN greatest(calendar."recoveryCloseAt",fees.last_posted) AND rec.reconciled_at
          AND e.observed_at<=rec.reconciled_at AND p.observed_at<=rec.reconciled_at
        ORDER BY rec.reconciled_at,rec.reconciliation_id COLLATE "C" LIMIT 1
      ) reconciliation ON true
      CROSS JOIN LATERAL (VALUES
        ('OPENING',calendar."openAt",calendar."openAt"-interval '24 hours'),
        ('RECOVERY',calendar."recoveryCloseAt",calendar."closeAt"),
        ('RECONCILED',reconciliation.reconciled_at,greatest(calendar."recoveryCloseAt",fees.last_posted))
      ) bound(phase,cut_at,earliest_at)
      LEFT JOIN LATERAL (
        SELECT event.event_id,event.content_hash,event.occurred_at,event.observed_at,snapshot.cash_micros
        FROM broker_events event JOIN account_snapshots snapshot USING(event_id,account_id)
        WHERE event.account_id=${accountId} AND event.event_kind='ACCOUNT'
          AND event.occurred_at BETWEEN bound.earliest_at AND bound.cut_at
          AND event.observed_at<=least(bound.cut_at,${asOf}::timestamptz)
          AND (bound.phase<>'RECONCILED' OR event.event_id=reconciliation.account_event_id)
        ORDER BY event.observed_at DESC,event.source_sequence DESC LIMIT 1
      ) cash ON true
      LEFT JOIN LATERAL (
        SELECT p.content_hash,p.observed_at,p.position_count FROM position_snapshots p
        WHERE p.account_id=${accountId} AND cash.event_id IS NOT NULL
          AND CASE WHEN bound.phase='RECONCILED' THEN p.snapshot_id=reconciliation.position_snapshot_id
            ELSE p.observed_at<=cash.occurred_at END
        ORDER BY p.observed_at DESC,p.ingestion_sequence DESC LIMIT 1
      ) inventory ON true
      ORDER BY calendar."sessionDate",bound.cut_at NULLS LAST,bound.phase
    `,
    )
  })

export const readSystemBatchEvidence = (accountId: string, generationHash: string, openAt: string, closeAt: string) =>
  Effect.gen(function* () {
    const sql = yield* PgClient.PgClient
    return yield* Schema.decodeUnknownEffect(RetainedSystemSourceCutSchema.fields.batches)(
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

/** Standalone observations include abstentions and blocked plans; availability is witnessed separately. */
export const readSystemAlphaObservations = (
  accountId: string,
  generationHash: string,
  registeredCalendar: Parameters<typeof registeredAlphaObservationSessions>[0],
  asOf: string,
  sharedProtocolHash: string,
) =>
  Effect.gen(function* () {
    const sessions = yield* Effect.fromResult(registeredAlphaObservationSessions(registeredCalendar))
    const sql = yield* PgClient.PgClient
    const rows = yield* Schema.decodeUnknownEffect(
      Schema.Array(Schema.Struct({ ...AlphaObservationEvidenceSchema.fields, observedAt: UtcInstantSchema })),
      strictParseOptions,
    )(
      yield* sql`
      SELECT observation.content_hash AS "contentHash", observation.payload,
        to_char(observation.observed_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "observedAt"
      FROM intraday_candidate_observations AS observation
      WHERE observation.payload->>'schemaVersion' = 'bayn.intraday-alpha-observation.v2'
        AND observation.payload->>'authorityGenerationHash' = ${generationHash}
        AND observation.payload #>> '{portfolio,brokerState,account,accountId}' = ${accountId}
        AND observation.observed_at <= ${asOf}::timestamptz
        AND EXISTS (
          SELECT 1 FROM jsonb_to_recordset(${JSON.stringify(sessions)}::jsonb)
            AS calendar("sessionDate" date, "openAt" timestamptz, "closeAt" timestamptz)
          WHERE observation.observed_at >= calendar."openAt"
            AND observation.observed_at < calendar."closeAt"
        )
      ORDER BY observation.observed_at, observation.content_hash
    `,
    )
    const seen = new Set<string>()
    const retained = []
    for (const row of rows) {
      const observation = yield* Effect.fromResult(reproduceIntradayAlphaObservation(row.payload))
      const session = sessions.find((session) => session.sessionDate === observation.snapshot.manifest.sessionDate)
      const calendar = yield* Effect.fromResult(
        resolveAlphaRegularSession(observation.snapshot.manifest.calendar, observation.snapshot.manifest.sessionDate),
      )
      if (
        seen.has(row.contentHash) ||
        observation.contentHash !== row.contentHash ||
        observation.observedAt !== row.observedAt ||
        observation.authorityGenerationHash !== generationHash ||
        observation.portfolio.brokerState.account.accountId !== accountId ||
        (yield* Effect.fromResult(canonicalHashV1Result(observation.protocol))) !== sharedProtocolHash ||
        session === undefined ||
        calendar.openAt !== session.regularOpenAt ||
        calendar.closeAt !== session.regularCloseAt ||
        observation.observedAt < session.openAt ||
        observation.observedAt >= session.closeAt ||
        observation.observedAt > asOf
      )
        return yield* new SystemAssessmentError({
          message: 'Retained alpha observation differs from its registered identity, calendar or source cut',
        })
      seen.add(row.contentHash)
      retained.push({ contentHash: row.contentHash, payload: row.payload })
    }
    return retained
  }).pipe(Effect.mapError((cause) => new SystemAssessmentError({ message: 'Alpha observation capture failed', cause })))

/** A physical build owns its own preparation; older immutable producer rows are never rewritten or aliased. */
export const readSystemAlphaBaselinePreparations = (registration: SystemRegistration, asOf: string) =>
  Effect.gen(function* () {
    const scope = yield* Effect.fromResult(registeredAlphaBaselineCaptureScope(registration))
    if (scope.binding.engine !== ResearchStrategyEngine.IntradayAlpha) return []
    const sql = yield* PgClient.PgClient
    const rows = yield* Schema.decodeUnknownEffect(
      Schema.Array(RecordedAlphaBaselinePreparationSchema),
      strictParseOptions,
    )(
      yield* sql`
      SELECT source.content_hash AS "contentHash", source.payload,
        to_char(source.recorded_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "recordedAt"
      FROM intraday_alpha_baseline_preparations source
      WHERE source.account_id = ${scope.candidate.riskPolicy.accountId}
        AND source.authority_generation_hash = ${scope.candidate.authorityGenerationHash}
        AND source.recorded_at <= ${asOf}::timestamptz
        AND source.payload #>> '{executionBuild,sourceRevision}' = ${scope.candidate.sourceRevision}
        AND source.payload #>> '{executionBuild,imageDigest}' = ${`sha256:${scope.candidate.imageDigest}`}
        AND (${scope.imageRepository}::text IS NULL OR
          source.payload #>> '{executionBuild,imageRepository}' = ${scope.imageRepository})
        AND EXISTS (
          SELECT 1 FROM jsonb_to_recordset(${JSON.stringify(scope.sessions)}::jsonb)
            AS calendar("sessionDate" date, "openAt" timestamptz, "closeAt" timestamptz)
          WHERE source.session_date = calendar."sessionDate"
            AND source.recorded_at >= calendar."openAt" AND source.recorded_at < calendar."closeAt"
        )
      ORDER BY source.recorded_at, source.content_hash
    `,
    )
    return yield* Effect.fromResult(verifyRegisteredAlphaBaselinePreparations(registration, rows, asOf))
  }).pipe(Effect.mapError((cause) => new SystemAssessmentError({ message: 'Alpha preparation capture failed', cause })))

export const readSystemMutationEvidence = (accountId: string, generationHash: string, from: string) =>
  Effect.gen(function* () {
    const sql = yield* PgClient.PgClient
    return yield* Schema.decodeUnknownEffect(RetainedSystemSourceCutSchema.fields.mutations)(
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
        SELECT DISTINCT pass.controller_key AS "controllerKey",
          pass.plan_hash AS "planHash", pass.epoch::double precision AS epoch,
          pass.last_sequence::double precision AS sequence, pass.last_receipt_hash AS "receiptHash",
          to_char(pass.completed_at::timestamptz AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "completedAt",
          pass.last_pass AS observation
        FROM execution_controller_observations AS observation
        CROSS JOIN LATERAL jsonb_to_record(observation.status) AS pass(
          controller_key text, plan_hash text, active text, epoch text, last_sequence text,
          last_receipt_hash text, completed_at text, last_pass jsonb
        )
        WHERE observation.controller_key = ${controllerKey} AND pass.plan_hash = ${planHash}
          AND pass.active = 'true'
          AND pass.last_receipt_hash IS NOT NULL AND jsonb_typeof(pass.last_pass) = 'object'
          AND pass.completed_at::timestamptz <= ${asOf}::timestamptz
          AND (pass.completed_at::timestamptz BETWEEN ${openAt}::timestamptz AND ${closeAt}::timestamptz
            OR (pass.last_pass->>'executionIssuedAt')::timestamptz BETWEEN ${openAt}::timestamptz AND ${closeAt}::timestamptz)
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
    return yield* Schema.decodeUnknownEffect(RetainedSystemSourceCutSchema.fields.controllerPasses)(
      yield* systemControllerPassQuery(sql, controllerKey, planHash, openAt, closeAt, asOf),
    )
  })

export const readSystemDurableObservations = (registrationHash: string) =>
  Effect.gen(function* () {
    const sql = yield* PgClient.PgClient
    return yield* Schema.decodeUnknownEffect(RetainedSystemSourceCutSchema.fields.durableObservations)(
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

export const readStrategyBoundSystemDurableObservations = (registrationHash: string, asOf: string) =>
  Effect.gen(function* () {
    const sql = yield* PgClient.PgClient
    return yield* Schema.decodeUnknownEffect(
      Schema.Array(SystemDurableObservationSchema),
      strictParseOptions,
    )(
      yield* sql`
      SELECT kind, source_hash AS "sourceHash", correct,
        to_char(source_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "sourceAt",
        to_char((date_trunc('milliseconds', witnessed_at) +
          CASE WHEN witnessed_at > date_trunc('milliseconds', witnessed_at) THEN interval '1 millisecond'
            ELSE interval '0' END) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "witnessedAt"
      FROM system_durable_observations
      WHERE registration_hash = ${registrationHash} AND witnessed_at <= ${asOf}::timestamptz
      ORDER BY witnessed_at, kind, source_hash`,
    )
  })

export const readPreparedAlphaSystemDurableObservations = (registrationHash: string, asOf: string) =>
  Effect.gen(function* () {
    const sql = yield* PgClient.PgClient
    return yield* Schema.decodeUnknownEffect(
      Schema.Array(PreparedAlphaSystemDurableObservationSchema),
      strictParseOptions,
    )(
      yield* sql`
      SELECT kind, source_hash AS "sourceHash", correct,
        to_char(source_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "sourceAt",
        to_char((date_trunc('milliseconds', witnessed_at) +
          CASE WHEN witnessed_at > date_trunc('milliseconds', witnessed_at) THEN interval '1 millisecond'
            ELSE interval '0' END) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "witnessedAt"
      FROM system_durable_observations
      WHERE registration_hash = ${registrationHash} AND witnessed_at <= ${asOf}::timestamptz
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
