import { PgClient } from '@effect/sql-pg'
import { Effect, Layer, Metric, Option, Result, Schema } from 'effect'

import {
  BrokerObservations,
  ObservedBrokerSnapshotSchema,
  ObservedBrokerStateSchema,
  observedBrokerState,
  validateObservedBrokerState,
  decodeObservedBrokerSnapshot,
  observationUnavailable,
  requireSettledCashFees,
  validateObservedBrokerSnapshot,
  type BrokerObservationTicket,
  type ObservedBrokerSnapshot,
} from '../broker/alpaca/observed-snapshot'
import { BrokerReadError, BrokerReadErrorKind } from '../broker/alpaca/failures'
import { mutationConsistencyDelayMs } from '../broker/alpaca/model'
import { protectionReleaseReadCount, type ProtectionReadAllowance } from '../broker/alpaca/poll-budget'
import type { NativeProtectionCancelCommand } from '../execution/intents/domain'
import { currentUtcInstant } from '../time'
import { canonicalHashV1Result } from '../hash'
import { ValkeyCache } from '../valkey-cache'
import { withObservedStage } from '../telemetry'
import { Sha256Schema, UtcInstantSchema, strictParseOptions } from '../schemas'
import { BrokerNotificationSchema, type BrokerNotification } from '../broker/notifications'
import {
  BrokerSourceProjectionReceiptSchema,
  type BrokerSourceProjectionReceipt,
} from '../broker/trade-update-projection'

const materializationBytes = Metric.histogram('bayn_broker_materialization_bytes', {
  boundaries: [4096, 16384, 65536, 262144, 1048576, 4194304],
})

const StateMaterialization = Schema.Struct({ snapshotHash: Sha256Schema, state: ObservedBrokerStateSchema })

const maximumRetainedSnapshotBytes = 8 * 1024 * 1024

const freezeMaterialization = (value: unknown): void => {
  if (typeof value !== 'object' || value === null || Object.isFrozen(value)) return
  for (const child of Object.values(value)) freezeMaterialization(child)
  Object.freeze(value)
}

export enum BrokerObservationClaimStatus {
  Reserved = 'RESERVED',
  QuotaWait = 'QUOTA_WAIT',
  AlreadyClaimed = 'ALREADY_CLAIMED',
}
export type BrokerObservationClaim =
  | {
      readonly status: BrokerObservationClaimStatus.Reserved
      readonly ticket: BrokerObservationTicket
      readonly nextPollNotBeforeMs: number
    }
  | {
      readonly status: BrokerObservationClaimStatus.QuotaWait | BrokerObservationClaimStatus.AlreadyClaimed
      readonly nextPollNotBeforeMs: number
    }
const quotaDeadline = Schema.Int.check(
  Schema.isGreaterThanOrEqualTo(0),
  Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER),
)
const claimRows = Schema.Array(
  Schema.Union([
    Schema.Struct({
      status: Schema.Literal(BrokerObservationClaimStatus.Reserved),
      generation: Schema.Int.check(Schema.isGreaterThan(0)),
      startedAt: UtcInstantSchema,
      nextPollNotBeforeMs: quotaDeadline,
    }),
    Schema.Struct({
      status: Schema.Union([
        Schema.Literal(BrokerObservationClaimStatus.QuotaWait),
        Schema.Literal(BrokerObservationClaimStatus.AlreadyClaimed),
      ]),
      generation: Schema.Null,
      startedAt: Schema.Null,
      nextPollNotBeforeMs: quotaDeadline,
    }),
  ]),
).check(Schema.isMaxLength(1))

export const makeBrokerObservationStore = (
  sql: PgClient.PgClient,
  accountId: string,
  sourceRevision: string,
  maximumAgeMs: number,
  cache: ValkeyCache['Service'],
) => {
  const decodeProjectionRows = Schema.decodeUnknownEffect(
    Schema.Array(
      Schema.Struct({ snapshot_hash: Schema.String, state_hash: Schema.String, observedAt: UtcInstantSchema }),
    ),
    strictParseOptions,
  )
  const decodePendingProjectionRows = Schema.decodeUnknownEffect(
    Schema.Array(
      Schema.Struct({
        snapshot_hash: Schema.String,
        state_hash: Schema.String,
        observedAt: UtcInstantSchema,
        newerMutation: Schema.Boolean,
        newerBrokerEvent: Schema.Boolean,
        newerNotification: Schema.Boolean,
      }),
    ),
    strictParseOptions,
  )
  const run = <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, BrokerReadError, R> =>
    effect.pipe(
      Effect.mapError((cause) =>
        cause instanceof BrokerReadError
          ? cause
          : observationUnavailable('Broker observation persistence failed', cause),
      ),
    )
  const payloadKey = (kind: 'snapshot' | 'state', hash: string) =>
    Result.map(
      canonicalHashV1Result({ accountId, sourceRevision, hash }),
      (keyHash) => `bayn:broker:${kind}:${keyHash}`,
    )
  const makePayloadReader = <A>(kind: 'snapshot' | 'state', schema: Schema.Codec<A, unknown>) => {
    let retained: { readonly hash: string; readonly encoded: string; readonly value: A } | undefined
    return (hash: string) =>
      Effect.gen(function* () {
        const key = yield* Effect.fromResult(payloadKey(kind, hash))
        const encoded = yield* cache.get(key)
        if (Option.isNone(encoded))
          return yield* observationUnavailable('Required Valkey broker materialization is absent')
        const bytes = Buffer.byteLength(encoded.value)
        const previous = retained
        const reused = previous !== undefined && previous.hash === hash && previous.encoded === encoded.value
        const value = reused
          ? structuredClone(previous.value)
          : yield* Schema.decodeUnknownEffect(Schema.fromJsonString(schema), strictParseOptions)(encoded.value)
        if (!reused) {
          if ((yield* Effect.fromResult(canonicalHashV1Result(value))) !== hash)
            return yield* observationUnavailable('Valkey broker materialization content hash changed')
          // Retain only one private, verified snapshot. Every read still fetches current bytes; neither
          // PostgreSQL admission nor account/chronology/age checks can be satisfied by this pure reuse.
          if (kind === 'snapshot' && bytes <= maximumRetainedSnapshotBytes) {
            const owned = structuredClone(value)
            freezeMaterialization(owned)
            retained = { hash, encoded: encoded.value, value: owned }
          } else retained = undefined
        }
        yield* Metric.update(materializationBytes.pipe(Metric.withAttributes({ namespace: 'bayn', kind })), bytes)
        yield* Effect.annotateCurrentSpan({
          'bayn.broker.payload_kind': kind,
          'bayn.broker.payload_bytes': bytes,
          'bayn.broker.payload_decode_reused': reused,
        })
        return value
      }).pipe(withObservedStage('bayn.broker.observation.materialization', { dependency: 'valkey', operation: kind }))
  }
  const readSnapshotPayload = makePayloadReader('snapshot', ObservedBrokerSnapshotSchema)
  const readStatePayload = makePayloadReader('state', StateMaterialization)

  const activate = (nextPollNotBeforeMs: number) =>
    run(
      sql`
    INSERT INTO broker_observations (account_id, source_revision, next_poll_not_before)
    VALUES (${accountId}, ${sourceRevision}, to_timestamp(${nextPollNotBeforeMs}::double precision / 1000.0))
    ON CONFLICT (account_id) DO UPDATE SET source_revision = EXCLUDED.source_revision,
      generation = broker_observations.generation + 1, available = false,
      poll_started_at = NULL, notification_fence_at = NULL, observed_at = NULL, completed_at = NULL, snapshot_hash = NULL, state_hash = NULL,
      protection_read_expires_at = NULL, protection_read_cost_ms = NULL, protection_read_claim_id = NULL,
      next_poll_not_before = GREATEST(broker_observations.next_poll_not_before,
          to_timestamp(${nextPollNotBeforeMs}::double precision / 1000.0))
  `.pipe(Effect.asVoid),
    )
  const invalidate = run(
    sql`
    UPDATE broker_observations SET generation = generation + 1, available = false
    WHERE account_id = ${accountId}
  `.pipe(Effect.asVoid),
  )
  const notificationCovered = (eventId: string) =>
    sql`SELECT EXISTS (
      SELECT 1 FROM broker_observations AS observation
      WHERE observation.account_id = event.account_id AND observation.available
        AND observation.notification_fence_at >= event.recorded_at
    ) AS covered FROM broker_source_events AS event
      WHERE event.account_id = ${accountId} AND event.event_id = ${eventId}`.pipe(
      Effect.flatMap(
        Schema.decodeUnknownEffect(Schema.Tuple([Schema.Struct({ covered: Schema.Boolean })]), strictParseOptions),
      ),
      Effect.map(([row]) => row.covered),
    )
  const isNotificationCovered = (eventId: string) => run(notificationCovered(eventId))
  const recordNotification = (notification: BrokerNotification) =>
    run(
      Effect.gen(function* () {
        // Commit the verified source payload before acknowledging ingress. The immutable event is the recovery source;
        // Restate owner state retains only its stable identity.
        yield* sql`INSERT INTO broker_source_events(
          account_id,event_id,source_revision,received_at,event_kind,session_id,notification
        ) VALUES (
          ${accountId},${notification.eventId},${notification.session.sourceRevision},${notification.receivedAt}::timestamptz,
          ${notification._tag},${notification.session.sessionId},${JSON.stringify(notification)}::jsonb
        )
          ON CONFLICT (account_id,event_id) DO NOTHING`
        return { covered: yield* notificationCovered(notification.eventId) }
      }),
    )
  const isSessionBoundaryCovered = (sessionId: string) =>
    run(
      sql`SELECT EXISTS (
        SELECT 1 FROM broker_source_events AS boundary
        JOIN broker_observations AS observation ON observation.account_id = boundary.account_id
          AND observation.notification_fence_at >= boundary.recorded_at
        WHERE boundary.account_id = ${accountId} AND boundary.session_id = ${sessionId}
          AND boundary.event_kind = 'SessionReady'
      ) AS covered`.pipe(
        Effect.flatMap(
          Schema.decodeUnknownEffect(Schema.Tuple([Schema.Struct({ covered: Schema.Boolean })]), strictParseOptions),
        ),
        Effect.map(([row]) => row.covered),
      ),
    )
  const readNotification = (eventId: string) =>
    run(
      Effect.gen(function* () {
        const rows = yield* sql`SELECT notification::text AS notification FROM broker_source_events
          WHERE account_id = ${accountId} AND event_id = ${eventId}`.pipe(
          Effect.flatMap(
            Schema.decodeUnknownEffect(
              Schema.Array(Schema.Struct({ notification: Schema.NullOr(Schema.String) })).check(Schema.isMaxLength(1)),
              strictParseOptions,
            ),
          ),
        )
        const payload = rows[0]?.notification
        if (payload === undefined || payload === null)
          return yield* observationUnavailable('Durable broker source event payload is absent')
        return yield* Schema.decodeUnknownEffect(
          Schema.fromJsonString(BrokerNotificationSchema),
          strictParseOptions,
        )(payload).pipe(
          Effect.mapError((cause) => observationUnavailable('Durable broker source event payload is invalid', cause)),
        )
      }),
    )
  const readSourceProjection = (eventId: string) =>
    run(
      sql`SELECT CASE
          WHEN outcome = 'PROJECTED' THEN jsonb_strip_nulls(jsonb_build_object(
            '_tag', 'Projected',
            'eventId', event_id,
            'observedAt', to_char(observed_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
            'orderEventId', order_event_id,
            'fillEventId', fill_event_id
          ))
          WHEN outcome = 'CANONICALLY_COVERED' THEN jsonb_build_object(
            '_tag', 'CanonicallyCovered',
            'eventId', event_id,
            'observedAt', to_char(observed_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
          )
          ELSE jsonb_build_object(
            '_tag', 'ReconcileRequired',
            'eventId', event_id,
            'observedAt', to_char(observed_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
            'reason', reason
          )
        END AS receipt
        FROM broker_source_event_projections
        WHERE account_id = ${accountId} AND event_id = ${eventId}`.pipe(
        Effect.flatMap(
          Schema.decodeUnknownEffect(
            Schema.Array(Schema.Struct({ receipt: BrokerSourceProjectionReceiptSchema })).check(Schema.isMaxLength(1)),
            strictParseOptions,
          ),
        ),
        Effect.map((rows) => rows[0]?.receipt),
      ),
    )
  const readProjectionBacklog = run(
    sql`SELECT COUNT(*)::integer AS pending,
      COALESCE(EXTRACT(EPOCH FROM clock_timestamp() - MIN(event.recorded_at)),0)::double precision AS "oldestPendingSeconds"
      FROM broker_source_events AS event
      LEFT JOIN broker_source_event_projections AS projection USING (account_id,event_id)
      WHERE event.account_id = ${accountId} AND event.source_revision = ${sourceRevision}
        AND projection.event_id IS NULL`.pipe(
      Effect.flatMap(
        Schema.decodeUnknownEffect(
          Schema.Tuple([
            Schema.Struct({
              pending: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
              oldestPendingSeconds: Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0)),
            }),
          ]),
          strictParseOptions,
        ),
      ),
      Effect.map(([row]) => row),
    ),
  )
  const recordProjection = (projection: BrokerSourceProjectionReceipt) =>
    run(
      Effect.gen(function* () {
        yield* sql`INSERT INTO broker_source_event_projections(
          account_id,event_id,source_revision,outcome,reason,order_event_id,fill_event_id,observed_at
        ) VALUES (
          ${accountId},${projection.eventId},${sourceRevision},
          ${projection._tag === 'Projected' ? 'PROJECTED' : projection._tag === 'CanonicallyCovered' ? 'CANONICALLY_COVERED' : 'RECONCILE_REQUIRED'},
          ${projection._tag === 'ReconcileRequired' ? projection.reason : null},
          ${projection._tag === 'Projected' ? projection.orderEventId : null},
          ${projection._tag === 'Projected' ? (projection.fillEventId ?? null) : null},
          ${projection.observedAt}::timestamptz
        ) ON CONFLICT (account_id,event_id) DO NOTHING`
        const retained = yield* readSourceProjection(projection.eventId)
        if (retained === undefined)
          return yield* observationUnavailable('Durable broker source projection receipt is absent')
        return retained
      }),
    )
  const hasSessionProjectionGap = (sessionId: string) =>
    run(
      sql`SELECT EXISTS (
        SELECT 1 FROM broker_source_event_projections AS projection
        JOIN broker_source_events AS event USING (account_id,event_id)
        WHERE projection.account_id = ${accountId} AND event.source_revision = ${sourceRevision}
          AND event.session_id = ${sessionId} AND projection.outcome = 'RECONCILE_REQUIRED'
          AND NOT (projection.reason = 'SESSION_BOUNDARY' AND event.event_kind = 'SessionReady')
      ) AS unresolved`.pipe(
        Effect.flatMap(
          Schema.decodeUnknownEffect(Schema.Tuple([Schema.Struct({ unresolved: Schema.Boolean })]), strictParseOptions),
        ),
        Effect.map(([row]) => row.unresolved),
      ),
    )
  const recoverUnfinished = (captureId: string) =>
    run(
      sql`
    WITH owner AS (
      SELECT account_id, generation FROM broker_observations
      WHERE account_id = ${accountId} AND source_revision = ${sourceRevision}
      FOR UPDATE
    ), unfinished AS (
      SELECT capture.generation FROM broker_observation_captures AS capture
      JOIN owner ON owner.account_id = capture.account_id AND owner.generation = capture.generation
      WHERE capture.capture_id = ${captureId} AND NOT capture.settled
      FOR UPDATE OF capture
    )
    UPDATE broker_observations SET generation = generation + 1, available = false
    WHERE account_id = ${accountId} AND source_revision = ${sourceRevision}
      AND generation IN (SELECT generation FROM unfinished)
  `.pipe(Effect.asVoid),
    )
  const begin = (
    captureId: string,
    interruptedNotBeforeMs: number,
  ): Effect.Effect<BrokerObservationClaim, BrokerReadError> =>
    run(
      sql`
    WITH owner AS (
      SELECT account_id, generation,
        GREATEST(next_poll_not_before, (
          SELECT max(mutation.occurred_at) + ${mutationConsistencyDelayMs} * interval '1 millisecond'
          FROM mutation_events AS mutation JOIN intents AS intent USING (intent_id)
          WHERE intent.account_id = broker_observations.account_id
        )) AS next_poll_not_before,
        clock_timestamp() AS checked_at FROM broker_observations
      WHERE account_id = ${accountId} AND source_revision = ${sourceRevision}
      FOR UPDATE
    ), claimed AS (
      INSERT INTO broker_observation_captures (account_id, capture_id, generation)
      SELECT account_id, ${captureId}, generation + 1 FROM owner
      WHERE next_poll_not_before <= checked_at
      ON CONFLICT DO NOTHING
      RETURNING account_id, generation
    ), reserved AS (
    UPDATE broker_observations SET generation = claimed.generation, quota_generation = claimed.generation,
      protection_read_expires_at = NULL, protection_read_cost_ms = NULL, protection_read_claim_id = NULL,
      next_poll_not_before = GREATEST(broker_observations.next_poll_not_before,
        to_timestamp(${interruptedNotBeforeMs}::double precision / 1000.0))
    FROM claimed WHERE broker_observations.account_id = claimed.account_id
    RETURNING broker_observations.generation,
      to_char(clock_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "startedAt",
      (EXTRACT(EPOCH FROM broker_observations.next_poll_not_before) * 1000)::double precision AS "nextPollNotBeforeMs"
    )
    SELECT 'RESERVED' AS status, generation, "startedAt", "nextPollNotBeforeMs" FROM reserved
    UNION ALL
    SELECT CASE WHEN EXISTS (
      SELECT 1 FROM broker_observation_captures WHERE account_id = owner.account_id AND capture_id = ${captureId}
    ) THEN 'ALREADY_CLAIMED' ELSE 'QUOTA_WAIT' END AS status,
      NULL::integer AS generation, NULL::text AS "startedAt",
      ceil(EXTRACT(EPOCH FROM next_poll_not_before) * 1000)::double precision AS "nextPollNotBeforeMs"
    FROM owner WHERE NOT EXISTS (SELECT 1 FROM reserved)
  `.pipe(
        Effect.flatMap(Schema.decodeUnknownEffect(claimRows, strictParseOptions)),
        Effect.flatMap((rows) =>
          Effect.gen(function* () {
            const row = rows[0]
            if (row === undefined)
              return yield* observationUnavailable('Broker observation owner is not active for this revision')
            if (row.status === BrokerObservationClaimStatus.Reserved)
              return {
                status: row.status,
                ticket: { generation: row.generation, startedAt: row.startedAt },
                nextPollNotBeforeMs: row.nextPollNotBeforeMs,
              }
            if (row.status === BrokerObservationClaimStatus.AlreadyClaimed) yield* recoverUnfinished(captureId)
            return { status: row.status, nextPollNotBeforeMs: row.nextPollNotBeforeMs }
          }),
        ),
      ),
    )
  const publish = (
    ticket: BrokerObservationTicket,
    value: ObservedBrokerSnapshot,
    nextPollNotBeforeMs: number,
    protectionAllowance?: ProtectionReadAllowance,
  ) =>
    run(
      Effect.gen(function* () {
        const decoded = decodeObservedBrokerSnapshot(value)
        if (Result.isFailure(decoded))
          return yield* observationUnavailable(
            'Broker observation cannot be published because decoding failed',
            decoded.failure,
          )
        yield* validateObservedBrokerSnapshot(value, accountId, yield* currentUtcInstant, maximumAgeMs)
        if (value.startedAt !== ticket.startedAt)
          return yield* observationUnavailable('Broker poll start does not match its durable ticket')
        const snapshotHash = yield* Effect.fromResult(canonicalHashV1Result(value))
        const state = { snapshotHash, state: observedBrokerState(value) }
        const stateHash = yield* Effect.fromResult(canonicalHashV1Result(state))
        const ttlMs = Math.floor(maximumAgeMs - (Date.parse(yield* currentUtcInstant) - Date.parse(value.observedAt)))
        const snapshotJson = JSON.stringify(value)
        const stateJson = JSON.stringify(state)
        yield* Effect.annotateCurrentSpan({
          'bayn.broker.snapshot_bytes': Buffer.byteLength(snapshotJson),
          'bayn.broker.state_bytes': Buffer.byteLength(stateJson),
        })
        // Publish acknowledged immutable payloads before exposing their durable fenced references.
        const snapshotKey = yield* Effect.fromResult(payloadKey('snapshot', snapshotHash))
        const stateKey = yield* Effect.fromResult(payloadKey('state', stateHash))
        yield* cache.putAll([
          { key: snapshotKey, value: snapshotJson, ttlMs },
          { key: stateKey, value: stateJson, ttlMs },
        ])
        const rows = yield* sql`
      WITH published AS (
      UPDATE broker_observations SET available = true, poll_started_at = ${value.startedAt}::timestamptz,
        observed_at = ${value.observedAt}::timestamptz, completed_at = ${value.completedAt}::timestamptz,
        snapshot_hash = ${snapshotHash}, state_hash = ${stateHash},
        notification_fence_at = (SELECT claimed_at FROM broker_observation_captures
          WHERE account_id = ${accountId} AND generation = ${ticket.generation}),
        protection_read_expires_at = to_timestamp(${protectionAllowance?.expiresAtMs ?? null}::double precision / 1000.0),
        protection_read_cost_ms = ${protectionAllowance?.requestCostMs ?? null}::integer,
        next_poll_not_before = to_timestamp(${nextPollNotBeforeMs}::double precision / 1000.0)
      WHERE account_id = ${accountId} AND source_revision = ${sourceRevision} AND generation = ${ticket.generation}
        AND (poll_started_at IS NULL OR poll_started_at <= ${ticket.startedAt}::timestamptz)
        AND NOT EXISTS (
          SELECT 1 FROM mutation_events AS mutation JOIN intents AS intent USING (intent_id)
          WHERE intent.account_id = ${accountId}
            AND mutation.occurred_at + ${mutationConsistencyDelayMs} * interval '1 millisecond' >= (
              SELECT claimed_at FROM broker_observation_captures
              WHERE account_id = ${accountId} AND generation = ${ticket.generation}
            )
        )
        AND NOT EXISTS (SELECT 1 FROM broker_events WHERE account_id = ${accountId}
          AND observed_at > ${ticket.startedAt}::timestamptz)
        AND NOT EXISTS (SELECT 1 FROM broker_source_events WHERE account_id = ${accountId}
          AND recorded_at > (SELECT claimed_at FROM broker_observation_captures
            WHERE account_id = ${accountId} AND generation = ${ticket.generation}))
      RETURNING account_id
      )
      UPDATE broker_observation_captures SET settled = true
      WHERE account_id = ${accountId} AND generation = ${ticket.generation}
        AND EXISTS (SELECT 1 FROM published)
      RETURNING account_id
    `
        return rows.length === 1
      }),
    )
  const failed = (ticket: BrokerObservationTicket, nextPollNotBeforeMs: number) =>
    run(
      sql`
    WITH failed AS (
    UPDATE broker_observations SET
      available = CASE WHEN generation = ${ticket.generation} THEN false ELSE available END,
      poll_started_at = CASE WHEN generation = ${ticket.generation} THEN ${ticket.startedAt}::timestamptz ELSE poll_started_at END,
      completed_at = CASE WHEN generation = ${ticket.generation} THEN NULL ELSE completed_at END,
      next_poll_not_before = to_timestamp(${nextPollNotBeforeMs}::double precision / 1000.0)
    WHERE account_id = ${accountId} AND source_revision = ${sourceRevision} AND quota_generation = ${ticket.generation}
    RETURNING account_id
    )
    UPDATE broker_observation_captures SET settled = true
    WHERE account_id = ${accountId} AND generation = ${ticket.generation}
  `.pipe(Effect.asVoid),
    )
  const reserveProtectionRead = (
    command: NativeProtectionCancelCommand,
    claimId: string,
    maximumReadMs: number,
  ): Effect.Effect<number | undefined, BrokerReadError> =>
    run(
      sql`
        WITH eligible AS MATERIALIZED (
          SELECT account_id,
            GREATEST(next_poll_not_before, clock_timestamp())
              + protection_read_cost_ms * ${protectionReleaseReadCount}::integer * interval '1 millisecond' AS paid_at
          FROM broker_observations
          WHERE account_id = ${accountId} AND account_id = ${command.accountId} AND source_revision = ${sourceRevision}
            AND protection_read_expires_at > clock_timestamp() + ${maximumReadMs}::integer * interval '1 millisecond'
          FOR UPDATE
        ), claimed AS (
          INSERT INTO protection_release_read_claims (claim_id, intent_id, broker_order_id, requested_at)
          SELECT ${claimId}, ${command.intentId}, ${command.brokerOrderId}, ${command.requestedAt}::timestamptz
          FROM eligible
          ON CONFLICT DO NOTHING
          RETURNING claim_id
        )
        UPDATE broker_observations AS owner SET
          protection_read_expires_at = NULL, protection_read_cost_ms = NULL, protection_read_claim_id = claimed.claim_id,
          next_poll_not_before = eligible.paid_at
        FROM eligible, claimed WHERE owner.account_id = eligible.account_id
        RETURNING ceil(EXTRACT(EPOCH FROM eligible.paid_at) * 1000)::double precision AS "paidAtMs"
      `.pipe(
        Effect.flatMap(
          Schema.decodeUnknownEffect(Schema.Array(Schema.Struct({ paidAtMs: quotaDeadline })), strictParseOptions),
        ),
        Effect.map(([row]) => row?.paidAtMs),
      ),
    )
  const settleProtectionRead = (claimId: string, nextPollNotBeforeMs: number) =>
    run(
      sql`UPDATE broker_observations
        SET protection_read_claim_id = NULL,
          next_poll_not_before = GREATEST(next_poll_not_before,
            to_timestamp(${nextPollNotBeforeMs}::double precision / 1000.0))
        WHERE account_id = ${accountId} AND source_revision = ${sourceRevision} AND protection_read_claim_id = ${claimId}`.pipe(
        Effect.asVoid,
      ),
    )
  const readProjection = (intentId: string | null) =>
    run(
      Effect.gen(function* () {
        const rows = yield* sql`
      SELECT snapshot_hash, state_hash,
        to_char(observed_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "observedAt"
      FROM broker_observations
      WHERE account_id = ${accountId} AND source_revision = ${sourceRevision} AND available
        AND NOT EXISTS (
          SELECT 1 FROM mutation_events AS mutation JOIN intents AS intent USING (intent_id)
          WHERE intent.account_id = ${accountId} AND mutation.occurred_at >= poll_started_at
            AND NOT (${intentId}::text IS NOT NULL AND mutation.intent_id = ${intentId}
              AND mutation.event_type = 'SUBMIT_STARTED')
        )
        AND NOT EXISTS (SELECT 1 FROM broker_events WHERE account_id = ${accountId}
          AND observed_at > completed_at)
        AND NOT EXISTS (SELECT 1 FROM broker_source_events WHERE account_id = ${accountId}
          AND recorded_at > notification_fence_at)
        AND (${intentId}::text IS NULL OR NOT EXISTS (
          SELECT 1 FROM (
            SELECT DISTINCT ON (mutation.mutation_id) mutation.intent_id, mutation.event_type, mutation.operation, intent.state
            FROM mutation_events AS mutation JOIN intents AS intent USING (intent_id)
            WHERE intent.account_id = ${accountId}
            ORDER BY mutation.mutation_id, mutation.sequence DESC
          ) AS latest WHERE latest.state <> 'TERMINAL' AND (
            latest.event_type IN ('SUBMIT_STARTED', 'SUBMIT_UNKNOWN', 'RECOVERY_NOT_FOUND', 'RECOVERY_UNKNOWN',
              'CANCEL_STARTED', 'CANCEL_ACCEPTED', 'CANCEL_UNKNOWN')
            OR (latest.operation = 'CANCEL' AND latest.event_type = 'RECOVERY_FOUND')
          ) AND NOT (latest.intent_id = ${intentId} AND latest.event_type = 'SUBMIT_STARTED')
        ))
        AND (${intentId}::text IS NULL OR EXISTS (
          SELECT 1 FROM intents AS reserved
          WHERE reserved.intent_id = ${intentId} AND reserved.account_id = ${accountId} AND reserved.state = 'IO_STARTED'
            AND EXISTS (SELECT 1 FROM mutation_events WHERE intent_id = reserved.intent_id
              AND event_type = 'SUBMIT_STARTED')
        ))
    `.pipe(Effect.flatMap(decodeProjectionRows))
        const row = rows[0]
        if (row === undefined) {
          const now = yield* currentUtcInstant
          // Account timestamp maxima preserve the strict EXISTS comparisons while
          // using the existing ordered indexes for these additional diagnostics.
          const awaiting = yield* sql`
        SELECT snapshot_hash, state_hash,
          to_char(observed_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "observedAt",
          EXISTS (SELECT 1 FROM mutation_events AS mutation JOIN intents AS intent USING (intent_id)
            WHERE intent.account_id = ${accountId} AND mutation.occurred_at >= poll_started_at) AS "newerMutation",
          COALESCE((SELECT max(observed_at) FROM broker_events WHERE account_id = ${accountId}) > completed_at, false) AS "newerBrokerEvent",
          COALESCE((SELECT max(recorded_at) FROM broker_source_events WHERE account_id = ${accountId}) > notification_fence_at, false) AS "newerNotification"
        FROM broker_observations
        WHERE account_id = ${accountId} AND source_revision = ${sourceRevision}
          AND observed_at > ${now}::timestamptz - ${maximumAgeMs} * interval '1 millisecond'
          AND completed_at <= ${now}::timestamptz AND completed_at >= poll_started_at
          AND (
            EXISTS (SELECT 1 FROM mutation_events AS mutation JOIN intents AS intent USING (intent_id)
              WHERE intent.account_id = ${accountId} AND mutation.occurred_at >= poll_started_at)
            OR EXISTS (SELECT 1 FROM broker_events WHERE account_id = ${accountId} AND observed_at > completed_at)
            OR EXISTS (SELECT 1 FROM broker_source_events WHERE account_id = ${accountId} AND recorded_at > notification_fence_at)
          )
      `.pipe(Effect.flatMap(decodePendingProjectionRows))
          if (awaiting.length === 0) {
            // Diagnose only an already rejected read. A rollout changes the
            // account's observation owner before all predecessor APIs retire.
            // This later read cannot admit a cut or relax the revision fence.
            const ownership = yield* sql`
          SELECT EXISTS (
            SELECT 1 FROM broker_observations
            WHERE account_id = ${accountId} AND source_revision <> ${sourceRevision}
          ) AS "foreignRevision"
        `.pipe(
              Effect.flatMap(
                Schema.decodeUnknownEffect(
                  Schema.Tuple([Schema.Struct({ foreignRevision: Schema.Boolean })]),
                  strictParseOptions,
                ),
              ),
            )
            return yield* new BrokerReadError({
              operation: 'preflight',
              kind: BrokerReadErrorKind.Timeout,
              retryable: true,
              observationFailure: 'NO_ADMISSIBLE_CUT',
              message: ownership[0].foreignRevision
                ? 'Broker observation source revision differs from this runtime'
                : 'Broker observation is unavailable or invalidated by a mutation',
            })
          }
          const pending = awaiting[0]
          if (pending === undefined) return yield* observationUnavailable('Broker observation metadata is absent')
          // These are the selected pending cut's fences, from that query's own
          // snapshot, not the cause of the earlier admission query's rejection.
          yield* Effect.annotateCurrentSpan({
            'bayn.broker.observation.pending.newer_mutation': pending.newerMutation,
            'bayn.broker.observation.pending.newer_broker_event': pending.newerBrokerEvent,
            'bayn.broker.observation.pending.newer_notification': pending.newerNotification,
          }).pipe(Effect.catchDefect(() => Effect.void))
          return {
            snapshot_hash: pending.snapshot_hash,
            state_hash: pending.state_hash,
            observedAt: pending.observedAt,
            pending: true,
          }
        }
        // Keep an expired available cut distinct from NO_ADMISSIBLE_CUT: recovery
        // uses that marker to retain its post-mutation cadence. Its cache TTL has
        // already elapsed, so reject before attempting either materialization.
        const now = yield* currentUtcInstant
        if (Date.parse(now) - Date.parse(row.observedAt) >= maximumAgeMs)
          return yield* observationUnavailable('Broker observation rejected: stale-observation')
        return { ...row, pending: false }
      }).pipe(withObservedStage('bayn.broker.observation.fence', { dependency: 'postgresql' })),
    )
  const requireSettled = (pending: boolean) =>
    pending
      ? Effect.fail(
          new BrokerReadError({
            operation: 'preflight',
            kind: BrokerReadErrorKind.ObservationPending,
            retryable: true,
            message: 'Broker observation is awaiting a fresh post-mutation cut',
          }),
        )
      : Effect.void
  const read = run(
    Effect.gen(function* () {
      const row = yield* readProjection(null)
      const value = yield* readSnapshotPayload(row.snapshot_hash)
      const validated = yield* validateObservedBrokerSnapshot(value, accountId, yield* currentUtcInstant, maximumAgeMs)
      yield* requireSettled(row.pending)
      yield* requireSettledCashFees(validated)
      return validated
    }),
  )
  const readState = (intentId: string | null) =>
    run(
      Effect.gen(function* () {
        const row = yield* readProjection(intentId)
        const value = yield* readStatePayload(row.state_hash)
        if (value.snapshotHash !== row.snapshot_hash)
          return yield* observationUnavailable('Broker state does not belong to the fenced snapshot')
        const validated = yield* validateObservedBrokerState(
          value.state,
          accountId,
          yield* currentUtcInstant,
          maximumAgeMs,
        )
        yield* requireSettled(row.pending)
        if (intentId !== null) yield* requireSettledCashFees(validated)
        return validated
      }),
    )
  return {
    activate,
    begin,
    publish,
    failed,
    reserveProtectionRead,
    settleProtectionRead,
    interrupt: recoverUnfinished,
    invalidate,
    recordNotification,
    isNotificationCovered,
    isSessionBoundaryCovered,
    readNotification,
    readSourceProjection,
    readProjectionBacklog,
    recordProjection,
    hasSessionProjectionGap,
    read,
    readState: readState(null),
    readForSubmit: readState,
  }
}

export const BrokerObservationsLive = (accountId: string, sourceRevision: string, maximumAgeMs: number) =>
  Layer.effect(
    BrokerObservations,
    Effect.map(Effect.all({ sql: PgClient.PgClient, cache: ValkeyCache }), ({ sql, cache }) =>
      makeBrokerObservationStore(sql, accountId, sourceRevision, maximumAgeMs, cache),
    ),
  )
