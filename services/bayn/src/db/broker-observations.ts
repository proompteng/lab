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
import { IntentState, OrderSchema } from '../execution/contracts'
import type { NativeProtectionCancelCommand } from '../execution/intents/domain'
import { currentUtcInstant } from '../time'
import { canonicalHashV1Result, sha256 } from '../hash'
import { ValkeyCache, maximumValkeyValueLength } from '../valkey-cache'
import { withObservedStage } from '../telemetry'
import { Sha256Schema, UtcInstantSchema, strictParseOptions } from '../schemas'
import { BrokerNotificationSchema, type BrokerNotification } from '../broker/notifications'
import { acquireExecutionWriterFence } from '../execution/writer-fence'
import { brokerActivitySourceContentIsConsistent } from './broker-activity-conflicts'
import {
  BrokerSourceProjectionReceiptSchema,
  type BrokerSourceProjectionReceipt,
} from '../broker/trade-update-projection'
import {
  FillActivitySchema,
  brokerActivityCursorIsReady,
  brokerActivityCompletionHash,
  brokerActivityHeartbeatFreshnessMs,
  brokerActivityPrefixEvidence,
  brokerActivityProjectionContract,
  brokerActivityRangeRequestHash,
  decideBrokerActivityCatchup,
  decideBrokerActivityEvent,
  decideBrokerActivityHeartbeat,
  type AccountActivityCut,
  type BrokerActivityCatchupResult,
  type BrokerActivityCatchupComplete,
  type BrokerActivityCursorState,
  type BrokerActivityEvent,
  type BrokerActivityHeartbeat,
  type BrokerActivityHeartbeatReceipt,
  type BrokerActivityProjection,
  type BrokerActivityRecordResult,
  type BrokerActivityReceipt,
  type BrokerActivityPersistenceResult,
} from '../broker/activities'

const materializationBytes = Metric.histogram('bayn_broker_materialization_bytes', {
  boundaries: [4096, 16384, 65536, 262144, 1048576, 4194304, maximumValkeyValueLength],
})

const StateMaterialization = Schema.Struct({ snapshotHash: Sha256Schema, state: ObservedBrokerStateSchema })

const ActivityCursorRows = Schema.Array(
  Schema.Struct({
    cursor: Schema.NullOr(Schema.String),
    sourceRevision: Schema.String,
    caughtUp: Schema.Boolean,
    replayFromId: Schema.NullOr(Schema.String),
    replayUntilId: Schema.NullOr(Schema.String),
    bootstrapEventCount: Schema.NullOr(Schema.BigInt),
    bootstrapPrefixHash: Schema.NullOr(Schema.String),
    rangeRequestHash: Schema.NullOr(Schema.String),
    completionHash: Schema.NullOr(Schema.String),
    fillFeeComplete: Schema.Boolean,
    fresh: Schema.Boolean,
    sessionId: Schema.NullOr(Schema.String),
    requestId: Schema.NullOr(Schema.String),
  }),
).check(Schema.isMaxLength(1))

const ActivityOwnerRows = Schema.Array(Schema.Struct({ sourceRevision: Schema.String })).check(Schema.isMaxLength(1))

const ActivityPrefixRows = Schema.Array(Schema.Struct({ sourceEventId: Schema.String, sourceEventHash: Schema.String }))

const ActivityProjectionRows = Schema.Array(
  Schema.Struct({
    projection: Schema.Literals(['FILL', 'FEE', 'BUST', 'CANONICAL_ONLY', 'DUPLICATE', 'RECONCILE_REQUIRED']),
    sourceEventHash: Schema.String,
    equivalentContent: Schema.Boolean,
  }),
).check(Schema.isMaxLength(1))

const ActivityPriorRows = Schema.Array(Schema.Struct({ outcome: Schema.String, active: Schema.Boolean })).check(
  Schema.isMaxLength(1),
)

const ActivityFillRows = Schema.Array(
  Schema.Struct({
    fill: FillActivitySchema,
    requestId: Schema.String,
    contentHash: Schema.String,
    observedAt: UtcInstantSchema,
  }),
)

const ActivityFeeRows = Schema.Array(Schema.Struct({ sourceEventId: Schema.String, key: Schema.String }))

const activityProjectionReceipt = (
  outcome: 'FILL' | 'FEE' | 'BUST' | 'CANONICAL_ONLY' | 'DUPLICATE' | 'RECONCILE_REQUIRED',
): BrokerActivityReceipt['projection'] => {
  switch (outcome) {
    case 'FILL':
      return 'Fill'
    case 'FEE':
      return 'Fee'
    case 'BUST':
      return 'Bust'
    case 'CANONICAL_ONLY':
      return 'CanonicalOnly'
    case 'DUPLICATE':
      return 'Duplicate'
    case 'RECONCILE_REQUIRED':
      return 'ReconcileRequired'
  }
}

const maximumRetainedSnapshotBytes = maximumValkeyValueLength

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
      Schema.Struct({
        generation: Schema.Int,
        snapshot_hash: Schema.String,
        state_hash: Schema.String,
        observedAt: UtcInstantSchema,
      }),
    ),
    strictParseOptions,
  )
  const decodePendingProjectionRows = Schema.decodeUnknownEffect(
    Schema.Array(
      Schema.Struct({
        generation: Schema.Int,
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
      sql.withTransaction(
        Effect.gen(function* () {
          yield* acquireExecutionWriterFence(sql)
          yield* sql`
            INSERT INTO broker_observations (account_id, source_revision, next_poll_not_before)
            VALUES (${accountId}, ${sourceRevision}, to_timestamp(${nextPollNotBeforeMs}::double precision / 1000.0))
            ON CONFLICT (account_id) DO UPDATE SET source_revision = EXCLUDED.source_revision,
              generation = broker_observations.generation + 1, available = false,
              poll_started_at = NULL, notification_fence_at = NULL, financial_reconciliation_fence_at = NULL,
              observed_at = NULL, completed_at = NULL, snapshot_hash = NULL, state_hash = NULL,
              protection_read_expires_at = NULL, protection_read_cost_ms = NULL, protection_read_claim_id = NULL,
              next_poll_not_before = GREATEST(broker_observations.next_poll_not_before,
                to_timestamp(${nextPollNotBeforeMs}::double precision / 1000.0))`
        }),
      ),
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
      sql.withTransaction(
        Effect.gen(function* () {
          // Commit the verified source payload and revoke any older revision's readable cut before acknowledging
          // ingress. Restate can route a new shared handler before its exclusive owner is activated; the database
          // generation is the common fence that every deployed reader already honors.
          const inserted = yield* sql`INSERT INTO broker_source_events(
            account_id,event_id,source_revision,received_at,event_kind,session_id,notification
          ) VALUES (
            ${accountId},${notification.eventId},${notification.session.sourceRevision},${notification.receivedAt}::timestamptz,
            ${notification._tag},${notification.session.sessionId},${JSON.stringify(notification)}::jsonb
          )
            ON CONFLICT (account_id,event_id) DO NOTHING
            RETURNING event_id`
          const covered = yield* notificationCovered(notification.eventId)
          if (inserted.length === 1 && !covered)
            yield* sql`UPDATE broker_observations SET generation = generation + 1, available = false
              WHERE account_id = ${accountId}`
          return { covered }
        }),
      ),
    )
  const cursorRows = sql`SELECT last_source_event_id AS cursor, source_revision AS "sourceRevision",
      (coverage_status = 'COMPLETE') AS "caughtUp",
      replay_from_id AS "replayFromId",
      replay_until_id AS "replayUntilId", bootstrap_event_count AS "bootstrapEventCount",
      bootstrap_prefix_hash AS "bootstrapPrefixHash", range_request_hash AS "rangeRequestHash",
      completion_hash AS "completionHash",
      fill_fee_complete AS "fillFeeComplete",
      heartbeat_at IS NOT NULL AND heartbeat_at >= clock_timestamp() - (${brokerActivityHeartbeatFreshnessMs} * interval '1 millisecond') AS fresh,
      session_id AS "sessionId", request_id AS "requestId"
    FROM broker_activity_cursors WHERE account_id = ${accountId}`.pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(ActivityCursorRows, strictParseOptions)),
  )
  const activityOwnerRows = sql`SELECT source_revision AS "sourceRevision"
    FROM broker_observations WHERE account_id = ${accountId}`.pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(ActivityOwnerRows, strictParseOptions)),
  )
  const retiredActivityRevision = (rows: readonly { readonly sourceRevision: string }[]) => {
    const activeSourceRevision = rows[0]?.sourceRevision ?? null
    return activeSourceRevision === null || activeSourceRevision === sourceRevision
      ? undefined
      : ({ _tag: 'RetiredRevision', activeSourceRevision } as const)
  }
  const readActivityCursor: Effect.Effect<BrokerActivityCursorState, BrokerReadError> = run(
    cursorRows.pipe(
      Effect.map((rows) => ({
        cursor: rows[0]?.cursor ?? null,
        caughtUp: rows[0]?.caughtUp ?? false,
        replayFromId: rows[0]?.replayFromId ?? null,
        replayUntilId: rows[0]?.replayUntilId ?? null,
        completionHash: rows[0]?.completionHash ?? null,
        fillFeeComplete: rows[0]?.fillFeeComplete ?? true,
        sourceRevision,
      })),
    ),
  )
  const retainedActivityProjection = (event: BrokerActivityEvent) =>
    sql`SELECT projection.outcome AS projection, original.source_event_hash AS "sourceEventHash",
        original.activity_json::jsonb = ${event.activityJson}::jsonb AS "equivalentContent"
      FROM broker_activity_events AS original
      JOIN broker_activity_event_projections AS projection USING (account_id,source_event_id)
      WHERE original.account_id = ${accountId} AND original.source_event_id = ${event.sourceEventId}`.pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(ActivityProjectionRows, strictParseOptions)),
      Effect.map((rows) => rows[0]),
    )
  const activityPrefixRows = (replayFromId: string, replayUntilId: string) =>
    sql`SELECT source_event_id AS "sourceEventId", source_event_hash AS "sourceEventHash"
      FROM broker_activity_events
      WHERE account_id = ${accountId}
        AND source_event_id >= ${replayFromId}
        AND source_event_id <= ${replayUntilId}
      ORDER BY source_event_id COLLATE "C"`.pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(ActivityPrefixRows, strictParseOptions)),
    )
  const activityCoveragePoisonedBy = (transportEventId: string) =>
    sql`SELECT EXISTS (
        SELECT 1 FROM broker_activity_coverage_receipts
        WHERE account_id = ${accountId} AND transport_event_id = ${transportEventId}
          AND status = 'POISONED'
      ) AS poisoned`.pipe(
      Effect.flatMap(
        Schema.decodeUnknownEffect(Schema.Tuple([Schema.Struct({ poisoned: Schema.Boolean })]), strictParseOptions),
      ),
      Effect.map(([row]) => row.poisoned),
    )
  const recordActivity = (event: BrokerActivityEvent, requested: BrokerActivityProjection) =>
    run(
      sql.withTransaction(
        Effect.gen(function* () {
          yield* acquireExecutionWriterFence(sql)
          const retired = retiredActivityRevision(yield* activityOwnerRows)
          if (retired !== undefined) return retired
          yield* sql`INSERT INTO broker_activity_cursors(account_id,source_revision)
            VALUES (${accountId},${sourceRevision}) ON CONFLICT (account_id) DO NOTHING`
          const locked = yield* sql`SELECT last_source_event_id AS cursor, source_revision AS "sourceRevision",
              (coverage_status = 'COMPLETE') AS "caughtUp",
              replay_from_id AS "replayFromId",
              replay_until_id AS "replayUntilId", bootstrap_event_count AS "bootstrapEventCount",
              bootstrap_prefix_hash AS "bootstrapPrefixHash", range_request_hash AS "rangeRequestHash",
              completion_hash AS "completionHash",
              fill_fee_complete AS "fillFeeComplete",
              heartbeat_at IS NOT NULL AND heartbeat_at >= clock_timestamp() - (${brokerActivityHeartbeatFreshnessMs} * interval '1 millisecond') AS fresh,
              session_id AS "sessionId", request_id AS "requestId"
            FROM broker_activity_cursors WHERE account_id = ${accountId} FOR UPDATE`.pipe(
            Effect.flatMap(Schema.decodeUnknownEffect(ActivityCursorRows, strictParseOptions)),
          )
          const current = locked[0]
          if (current === undefined) return yield* observationUnavailable('Durable activity cursor is absent')
          const retained =
            current.cursor !== null && event.sourceEventId <= current.cursor
              ? yield* retainedActivityProjection(event)
              : undefined
          const admission = decideBrokerActivityEvent(current, event, retained, true)
          if (Result.isFailure(admission)) {
            const inserted = yield* sql`INSERT INTO broker_activity_source_conflicts(
              account_id,source_event_id,retained_source_event_hash,conflicting_source_event_hash,
              transport_event_id,source_revision,session_id,request_id,received_at,activity_json
            ) VALUES (
              ${accountId},${event.sourceEventId},${retained?.sourceEventHash ?? null},${event.contentHash},
              ${event.eventId},${sourceRevision},${event.session.sessionId},${event.session.requestId},
              ${event.receivedAt}::timestamptz,${event.activityJson}
            ) ON CONFLICT (account_id,source_event_id,conflicting_source_event_hash) DO NOTHING
              RETURNING source_event_id`
            if (inserted.length === 1) {
              yield* sql`UPDATE broker_activity_cursors SET fill_fee_complete = false,
                  session_id = NULL, request_id = NULL, heartbeat_at = NULL, updated_at = clock_timestamp()
                WHERE account_id = ${accountId}`
              yield* sql`UPDATE broker_observations SET generation = generation + 1, available = false
                WHERE account_id = ${accountId}`
            }
            return { _tag: 'SourceConflict', eventId: event.eventId } as const
          }
          if (admission.success._tag === 'Replay') {
            if (retained === undefined)
              return yield* observationUnavailable('Activity replay is missing its retained projection')
            if (yield* activityCoveragePoisonedBy(event.eventId))
              return { _tag: 'CoverageConflict', eventId: event.eventId } as const
            return {
              _tag: 'Accepted',
              receipt: {
                accepted: true,
                eventId: event.eventId,
                cursor: current.cursor,
                caughtUp: current.caughtUp,
                replayFromId: current.replayFromId,
                replayUntilId: current.replayUntilId,
                completionHash: current.completionHash,
                sourceRevision,
                fillFeeComplete: current.fillFeeComplete,
                replayed: true,
                projection: activityProjectionReceipt(retained.projection),
                projectionContract: brokerActivityProjectionContract,
              },
            } satisfies BrokerActivityRecordResult
          }

          yield* sql`INSERT INTO broker_activity_events(
            account_id,source_event_id,transport_event_id,source_event_hash,source_revision,ref_id,previous_ref_id,
            activity_type,session_id,request_id,received_at,activity_json
          ) VALUES (
            ${accountId},${event.sourceEventId},${event.eventId},${event.contentHash},${sourceRevision},${event.refId},
            ${event.previousRefId ?? null},${event.activityType},${event.session.sessionId},${event.session.requestId},
            ${event.receivedAt}::timestamptz,${event.activityJson}
          )`

          const requestedPrevious = 'previousRefId' in requested ? requested.previousRefId : null
          const reference = yield* sql`SELECT
            EXISTS (
              SELECT 1 FROM broker_activity_event_projections
              WHERE account_id = ${accountId} AND ref_id = ${event.refId}
                AND outcome IN ('FILL','FEE','BUST','CANONICAL_ONLY')
            ) AS existing,
            EXISTS (
              SELECT 1 FROM broker_activity_event_projections AS projection
              WHERE projection.account_id = ${accountId} AND projection.ref_id = ${event.refId}
                AND projection.outcome IN ('FILL','FEE','BUST','CANONICAL_ONLY')
                AND projection.previous_ref_id IS NOT DISTINCT FROM ${requestedPrevious}::uuid
                AND (
                  (${requested._tag === 'Fill'} AND projection.outcome = 'FILL'
                    AND projection.fill = ${requested._tag === 'Fill' ? JSON.stringify(requested.fill) : null}::jsonb) OR
                  (${requested._tag === 'Fee'} AND projection.outcome = 'FEE'
                    AND projection.fee_key = ${requested._tag === 'Fee' ? requested.feeKey : null}) OR
                  (${requested._tag === 'Bust'} AND projection.outcome = 'BUST') OR
                  CASE WHEN ${requested._tag === 'CanonicalOnly'} AND projection.outcome = 'CANONICAL_ONLY' THEN
                    EXISTS (
                      SELECT 1 FROM broker_activity_events AS retained
                      WHERE retained.account_id = projection.account_id AND retained.source_event_id = projection.source_event_id
                        AND (retained.activity_json::jsonb - 'event_id') = (${event.activityJson}::jsonb - 'event_id')
                    )
                  ELSE false END
                )
            ) AS identical`.pipe(
            Effect.flatMap(
              Schema.decodeUnknownEffect(
                Schema.Tuple([Schema.Struct({ existing: Schema.Boolean, identical: Schema.Boolean })]),
                strictParseOptions,
              ),
            ),
            Effect.map(([row]) => row),
          )
          let projection: BrokerActivityProjection | { readonly _tag: 'Duplicate'; readonly refId: string } =
            !reference.existing
              ? requested
              : reference.identical
                ? { _tag: 'Duplicate', refId: event.refId }
                : { _tag: 'ReconcileRequired', refId: event.refId, reason: 'UNSUPPORTED_ACTIVITY' }
          if (projection._tag === 'CanonicalOnly' && projection.previousRefId !== undefined)
            projection = {
              _tag: 'ReconcileRequired',
              refId: event.refId,
              reason: 'UNSUPPORTED_ACTIVITY',
            }
          if (
            (projection._tag === 'Fill' || projection._tag === 'Fee' || projection._tag === 'Bust') &&
            'previousRefId' in projection
          ) {
            const prior = yield* sql`SELECT prior.outcome,
                NOT EXISTS (
                  SELECT 1 FROM broker_activity_event_projections AS reversal
                  WHERE reversal.account_id = prior.account_id AND reversal.previous_ref_id = prior.ref_id
                    AND reversal.outcome IN ('FILL','FEE','BUST')
                ) AS active
              FROM broker_activity_event_projections AS prior
              WHERE prior.account_id = ${accountId} AND prior.ref_id = ${projection.previousRefId}
                AND prior.outcome IN ('FILL','FEE')`.pipe(
              Effect.flatMap(Schema.decodeUnknownEffect(ActivityPriorRows, strictParseOptions)),
              Effect.map((rows) => rows[0]),
            )
            const expected = projection._tag === 'Fee' ? 'FEE' : 'FILL'
            if (prior === undefined || !prior.active || prior.outcome !== expected)
              projection = {
                _tag: 'ReconcileRequired',
                refId: event.refId,
                reason: 'UNSUPPORTED_ACTIVITY',
              }
          }
          const outcome =
            projection._tag === 'Duplicate'
              ? 'DUPLICATE'
              : projection._tag === 'ReconcileRequired'
                ? 'RECONCILE_REQUIRED'
                : projection._tag === 'CanonicalOnly'
                  ? 'CANONICAL_ONLY'
                  : projection._tag.toUpperCase()
          yield* sql`INSERT INTO broker_activity_event_projections(
            account_id,source_event_id,source_revision,outcome,ref_id,previous_ref_id,fill,fee_key,reason
          ) VALUES (
            ${accountId},${event.sourceEventId},${sourceRevision},${outcome},${projection.refId},
            ${'previousRefId' in projection ? projection.previousRefId : null},
            ${projection._tag === 'Fill' ? JSON.stringify(projection.fill) : null}::jsonb,
            ${projection._tag === 'Fee' ? projection.feeKey : null},
            ${projection._tag === 'ReconcileRequired' || projection._tag === 'CanonicalOnly' ? projection.reason : null}
          )`
          const append = decideBrokerActivityEvent(current, event, undefined, projection._tag !== 'ReconcileRequired')
          if (Result.isFailure(append) || append.success._tag !== 'Append')
            return yield* observationUnavailable('Activity append no longer advances the durable cursor')
          const { fillFeeComplete, invalidatesCoverage, preserveHeartbeat } = append.success
          yield* sql`UPDATE broker_observations SET generation = generation + 1, available = false
            WHERE account_id = ${accountId}`
          if (invalidatesCoverage) {
            const { replayFromId, replayUntilId, bootstrapEventCount, bootstrapPrefixHash, rangeRequestHash } = current
            if (
              replayFromId === null ||
              replayUntilId === null ||
              bootstrapEventCount === null ||
              bootstrapPrefixHash === null ||
              rangeRequestHash === null ||
              current.completionHash === null
            )
              return yield* observationUnavailable('Complete activity coverage has no retained proof')
            const prefixRows = yield* activityPrefixRows(replayFromId, replayUntilId)
            const evidence = brokerActivityPrefixEvidence(prefixRows)
            const observedCursor = prefixRows.at(-1)?.sourceEventId ?? null
            const observedCompletionHash = brokerActivityCompletionHash({
              rangeRequestHash,
              cursor: observedCursor,
              eventCount: evidence.eventCount,
              prefixHash: evidence.prefixHash,
            })
            yield* sql`INSERT INTO broker_activity_coverage_receipts(
                account_id,transport_event_id,source_revision,session_id,request_id,received_at,cursor,
                replay_from_id,replay_until_id,event_count,prefix_hash,range_request_hash,completion_hash,
                observed_cursor,observed_event_count,observed_prefix_hash,observed_range_request_hash,
                observed_completion_hash,status,reason
              ) VALUES (
                ${accountId},${event.eventId},${sourceRevision},${event.session.sessionId},
                ${event.session.requestId},${event.receivedAt}::timestamptz,${current.cursor},
                ${replayFromId},${replayUntilId},${bootstrapEventCount},${bootstrapPrefixHash},
                ${rangeRequestHash},${current.completionHash},${observedCursor},${evidence.eventCount},
                ${evidence.prefixHash},${rangeRequestHash},${observedCompletionHash},'POISONED','LATE_PUBLICATION'
              ) ON CONFLICT (account_id,transport_event_id) DO NOTHING`
            yield* sql`UPDATE broker_activity_cursors SET
                source_revision = ${sourceRevision}, last_source_event_id = ${event.sourceEventId},
                last_source_event_hash = ${event.contentHash},
                last_activity_received_at = ${event.receivedAt}::timestamptz,
                coverage_status = 'POISONED', replay_from_id = NULL, replay_until_id = NULL,
                bootstrap_session_id = NULL, bootstrap_request_id = NULL, bootstrap_event_count = NULL,
                bootstrap_prefix_hash = NULL, range_request_hash = NULL, completion_hash = NULL,
                fill_fee_complete = ${fillFeeComplete}, session_id = NULL, request_id = NULL,
                heartbeat_at = NULL, updated_at = clock_timestamp()
              WHERE account_id = ${accountId}`
            return { _tag: 'CoverageConflict', eventId: event.eventId } as const
          }
          yield* sql`UPDATE broker_activity_cursors SET
              source_revision = ${sourceRevision}, last_source_event_id = ${event.sourceEventId},
              last_source_event_hash = ${event.contentHash}, last_activity_received_at = ${event.receivedAt}::timestamptz,
              fill_fee_complete = ${fillFeeComplete},
              session_id = CASE
                WHEN ${preserveHeartbeat}
                THEN session_id ELSE NULL END,
              request_id = CASE
                WHEN ${preserveHeartbeat}
                THEN request_id ELSE NULL END,
              heartbeat_at = CASE
                WHEN ${preserveHeartbeat}
                THEN heartbeat_at ELSE NULL END,
              updated_at = clock_timestamp()
            WHERE account_id = ${accountId}`
          return {
            _tag: 'Accepted',
            receipt: {
              accepted: true,
              eventId: event.eventId,
              cursor: event.sourceEventId,
              caughtUp: current.caughtUp,
              replayFromId: current.replayFromId,
              replayUntilId: current.replayUntilId,
              completionHash: current.completionHash,
              sourceRevision,
              fillFeeComplete,
              replayed: false,
              projection: projection._tag,
              projectionContract: brokerActivityProjectionContract,
            },
          } satisfies BrokerActivityRecordResult
        }),
      ),
    )
  const recordActivityCatchup = (boundary: BrokerActivityCatchupComplete) =>
    run(
      sql.withTransaction(
        Effect.gen(function* () {
          yield* acquireExecutionWriterFence(sql)
          const retired = retiredActivityRevision(yield* activityOwnerRows)
          if (retired !== undefined) return retired
          yield* sql`INSERT INTO broker_activity_cursors(account_id,source_revision)
            VALUES (${accountId},${sourceRevision}) ON CONFLICT (account_id) DO NOTHING`
          const locked = yield* sql`SELECT last_source_event_id AS cursor, source_revision AS "sourceRevision",
              (coverage_status = 'COMPLETE') AS "caughtUp",
              replay_from_id AS "replayFromId",
              replay_until_id AS "replayUntilId", bootstrap_event_count AS "bootstrapEventCount",
              bootstrap_prefix_hash AS "bootstrapPrefixHash", range_request_hash AS "rangeRequestHash",
              completion_hash AS "completionHash",
              fill_fee_complete AS "fillFeeComplete",
              heartbeat_at IS NOT NULL AND heartbeat_at >= clock_timestamp() - (${brokerActivityHeartbeatFreshnessMs} * interval '1 millisecond') AS fresh,
              session_id AS "sessionId", request_id AS "requestId"
            FROM broker_activity_cursors WHERE account_id = ${accountId} FOR UPDATE`.pipe(
            Effect.flatMap(Schema.decodeUnknownEffect(ActivityCursorRows, strictParseOptions)),
          )
          const current = locked[0]
          if (current === undefined) return yield* observationUnavailable('Durable activity cursor is absent')
          const prefixRows = yield* activityPrefixRows(boundary.replayFromId, boundary.replayUntilId)
          const evidence = brokerActivityPrefixEvidence(prefixRows)
          const rangeRequestHash = brokerActivityRangeRequestHash({
            identityHash: boundary.session.identityHash,
            sessionId: boundary.session.sessionId,
            requestId: boundary.session.requestId,
            replayFromId: boundary.replayFromId,
            replayUntilId: boundary.replayUntilId,
          })
          const completionHash = brokerActivityCompletionHash({
            rangeRequestHash,
            cursor: boundary.cursor,
            eventCount: evidence.eventCount,
            prefixHash: evidence.prefixHash,
          })
          const last = prefixRows.at(-1)?.sourceEventId ?? null
          const evidenceMatches =
            last === boundary.cursor &&
            evidence.eventCount === boundary.eventCount &&
            evidence.prefixHash === boundary.prefixHash &&
            rangeRequestHash === boundary.rangeRequestHash &&
            completionHash === boundary.completionHash
          const admission = decideBrokerActivityCatchup(current, boundary, evidenceMatches)
          const coverageReceipt = yield* sql`INSERT INTO broker_activity_coverage_receipts(
              account_id,transport_event_id,source_revision,session_id,request_id,received_at,cursor,
              replay_from_id,replay_until_id,event_count,prefix_hash,range_request_hash,completion_hash,
              observed_cursor,observed_event_count,observed_prefix_hash,observed_range_request_hash,
              observed_completion_hash,status,reason
            ) VALUES (
              ${accountId},${boundary.eventId},${sourceRevision},${boundary.session.sessionId},
              ${boundary.session.requestId},${boundary.receivedAt}::timestamptz,${boundary.cursor},
              ${boundary.replayFromId},${boundary.replayUntilId},${boundary.eventCount},${boundary.prefixHash},
              ${boundary.rangeRequestHash},${boundary.completionHash},${last},${evidence.eventCount},
              ${evidence.prefixHash},${rangeRequestHash},${completionHash},
              ${Result.isSuccess(admission) ? 'COMPLETE' : 'POISONED'},
              ${Result.isFailure(admission) ? admission.failure : null}
            ) ON CONFLICT (account_id,transport_event_id) DO NOTHING
              RETURNING transport_event_id`
          if (Result.isFailure(admission)) {
            if (coverageReceipt.length === 1 || current.caughtUp) {
              yield* sql`UPDATE broker_activity_cursors SET source_revision = ${sourceRevision},
                  coverage_status = 'POISONED', replay_from_id = NULL, replay_until_id = NULL,
                  bootstrap_session_id = NULL, bootstrap_request_id = NULL, bootstrap_event_count = NULL,
                  bootstrap_prefix_hash = NULL, range_request_hash = NULL, completion_hash = NULL,
                  session_id = NULL, request_id = NULL, heartbeat_at = NULL,
                  updated_at = clock_timestamp()
                WHERE account_id = ${accountId}`
              yield* sql`UPDATE broker_observations SET generation = generation + 1, available = false
                WHERE account_id = ${accountId}`
            }
            return { _tag: 'CoverageConflict', eventId: boundary.eventId } as const
          }
          yield* sql`UPDATE broker_activity_cursors SET source_revision = ${sourceRevision},
              coverage_status = 'COMPLETE', replay_from_id = ${admission.success.replayFromId},
              replay_until_id = ${admission.success.replayUntilId},
              bootstrap_session_id = ${boundary.session.sessionId},
              bootstrap_request_id = ${boundary.session.requestId}, bootstrap_event_count = ${boundary.eventCount},
              bootstrap_prefix_hash = ${boundary.prefixHash}, range_request_hash = ${boundary.rangeRequestHash},
              completion_hash = ${boundary.completionHash}, session_id = NULL, request_id = NULL,
              heartbeat_at = NULL,
              updated_at = clock_timestamp()
            WHERE account_id = ${accountId}`
          return {
            _tag: 'Accepted',
            receipt: {
              cursor: current.cursor,
              caughtUp: true,
              replayFromId: boundary.replayFromId,
              replayUntilId: boundary.replayUntilId,
              completionHash: boundary.completionHash,
              fillFeeComplete: current.fillFeeComplete,
              sourceRevision,
            },
          } satisfies BrokerActivityCatchupResult
        }),
      ),
    )
  const recordActivityHeartbeat = (heartbeat: BrokerActivityHeartbeat) =>
    run(
      sql.withTransaction(
        Effect.gen(function* () {
          yield* acquireExecutionWriterFence(sql)
          const retired = retiredActivityRevision(yield* activityOwnerRows)
          if (retired !== undefined) return retired
          const locked = yield* sql`SELECT last_source_event_id AS cursor, source_revision AS "sourceRevision",
              (coverage_status = 'COMPLETE') AS "caughtUp",
              replay_from_id AS "replayFromId",
              replay_until_id AS "replayUntilId", bootstrap_event_count AS "bootstrapEventCount",
              bootstrap_prefix_hash AS "bootstrapPrefixHash", range_request_hash AS "rangeRequestHash",
              completion_hash AS "completionHash",
              fill_fee_complete AS "fillFeeComplete",
              heartbeat_at IS NOT NULL AND heartbeat_at >= clock_timestamp() - (${brokerActivityHeartbeatFreshnessMs} * interval '1 millisecond') AS fresh,
              session_id AS "sessionId", request_id AS "requestId"
            FROM broker_activity_cursors WHERE account_id = ${accountId} FOR UPDATE`.pipe(
            Effect.flatMap(Schema.decodeUnknownEffect(ActivityCursorRows, strictParseOptions)),
          )
          const current = locked[0]
          if (current === undefined)
            return yield* observationUnavailable('Activity heartbeat does not cover a caught-up durable cursor')
          const admission = decideBrokerActivityHeartbeat(current, heartbeat)
          if (Result.isFailure(admission))
            return yield* observationUnavailable('Activity heartbeat does not cover a caught-up durable cursor')
          // Repair only historical representation-only conflicts on an authenticated, cursor-bound heartbeat.
          // The existing heartbeat-age check still independently gates activity reads and readiness.
          // Finite publication proofs keep their original raw hashes and remain independently fail-closed.
          const recovered =
            !current.fillFeeComplete &&
            (yield* sql`SELECT (
              EXISTS (SELECT 1 FROM broker_activity_source_conflicts WHERE account_id = ${accountId})
              AND (${brokerActivitySourceContentIsConsistent(sql, accountId)})
              AND NOT EXISTS (
                SELECT 1 FROM broker_activity_events AS event
                LEFT JOIN broker_activity_event_projections AS projection USING (account_id,source_event_id)
                WHERE event.account_id = ${accountId}
                  AND (projection.outcome IS NULL OR projection.outcome = 'RECONCILE_REQUIRED')
              )
              AND NOT EXISTS (SELECT 1 FROM broker_activity_coverage_receipts
                WHERE account_id = ${accountId} AND status = 'POISONED')
            ) AS recoverable`.pipe(
              Effect.flatMap(
                Schema.decodeUnknownEffect(
                  Schema.Tuple([Schema.Struct({ recoverable: Schema.Boolean })]),
                  strictParseOptions,
                ),
              ),
              Effect.map(([row]) => row.recoverable),
            ))
          const fillFeeComplete = current.fillFeeComplete || recovered
          const activated = admission.success.activated || recovered
          if (recovered)
            yield* sql`UPDATE broker_observations SET generation = generation + 1, available = false
              WHERE account_id = ${accountId}`
          yield* sql`UPDATE broker_activity_cursors SET source_revision = ${sourceRevision},
              fill_fee_complete = ${fillFeeComplete},
              session_id = ${heartbeat.session.sessionId}, request_id = ${heartbeat.session.requestId},
              heartbeat_at = CASE
                WHEN session_id = ${heartbeat.session.sessionId} AND request_id = ${heartbeat.session.requestId}
                THEN GREATEST(heartbeat_at, ${heartbeat.receivedAt}::timestamptz)
                ELSE ${heartbeat.receivedAt}::timestamptz END,
              updated_at = clock_timestamp()
            WHERE account_id = ${accountId}`
          return {
            _tag: 'Accepted',
            receipt: {
              cursor: current.cursor,
              caughtUp: current.caughtUp,
              replayFromId: current.replayFromId,
              replayUntilId: current.replayUntilId,
              completionHash: current.completionHash,
              fillFeeComplete,
              sourceRevision,
              activated,
            },
          } satisfies BrokerActivityPersistenceResult<BrokerActivityHeartbeatReceipt>
        }),
      ),
    )
  let activityView: AccountActivityCut | undefined
  const readAccountActivity: Effect.Effect<AccountActivityCut, BrokerReadError> = run(
    Effect.gen(function* () {
      const cursor = (yield* cursorRows)[0]
      if (cursor === undefined || !brokerActivityCursorIsReady(cursor, sourceRevision))
        return yield* observationUnavailable('Durable Activity SSE fill and fee projection is not ready and complete')
      const version = sha256(`${cursor.cursor ?? 'empty'}\n${cursor.sourceRevision}`)
      // At a verified cursor the projections are immutable. Liveness still comes from the fresh cursor read.
      if (activityView?.version === version)
        return {
          ...activityView,
          evidence: { ...activityView.evidence, requestId: cursor.requestId, observedAt: yield* currentUtcInstant },
        }
      const fills = yield* sql`SELECT projection.fill, event.request_id AS "requestId",
          event.source_event_hash AS "contentHash",
          to_char(event.received_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "observedAt"
        FROM broker_activity_event_projections AS projection
        JOIN broker_activity_events AS event USING (account_id,source_event_id)
        WHERE projection.account_id = ${accountId} AND projection.outcome = 'FILL'
          AND NOT EXISTS (
            SELECT 1 FROM broker_activity_event_projections AS reversal
            WHERE reversal.account_id = projection.account_id AND reversal.previous_ref_id = projection.ref_id
              AND reversal.outcome IN ('FILL','FEE','BUST')
          )
        ORDER BY projection.source_event_id COLLATE "C"`.pipe(
        Effect.flatMap(Schema.decodeUnknownEffect(ActivityFillRows, strictParseOptions)),
      )
      const fees = yield* sql`SELECT projection.source_event_id AS "sourceEventId", projection.fee_key AS key
        FROM broker_activity_event_projections AS projection
        WHERE projection.account_id = ${accountId} AND projection.outcome = 'FEE'
          AND NOT EXISTS (
            SELECT 1 FROM broker_activity_event_projections AS reversal
            WHERE reversal.account_id = projection.account_id AND reversal.previous_ref_id = projection.ref_id
              AND reversal.outcome IN ('FILL','FEE','BUST')
          )
        ORDER BY projection.source_event_id COLLATE "C"`.pipe(
        Effect.flatMap(Schema.decodeUnknownEffect(ActivityFeeRows, strictParseOptions)),
      )
      const confirmedCursor = (yield* cursorRows)[0]
      if (
        confirmedCursor === undefined ||
        !brokerActivityCursorIsReady(confirmedCursor, sourceRevision) ||
        confirmedCursor.cursor !== cursor.cursor
      )
        return yield* observationUnavailable('Durable Activity SSE prefix changed while materializing its projection')
      const observedAt = yield* currentUtcInstant
      const feeVersion = sha256(fees.map(({ sourceEventId, key }) => `${sourceEventId}\n${key}`).join('\n\n'))
      const feeCounts = new Map<string, number>()
      for (const { key } of fees) feeCounts.set(key, (feeCounts.get(key) ?? 0) + 1)
      activityView = {
        version,
        feeVersion,
        fills: fills.map(({ fill, requestId, contentHash, observedAt }) => ({
          value: fill,
          evidence: { status: 200, requestId, contentHash, observedAt },
        })),
        feeCounts,
        evidence: {
          status: 200,
          requestId: confirmedCursor.requestId,
          contentHash: version,
          observedAt,
        },
      }
      return activityView
    }),
  )
  const isSessionBoundaryCovered = (sessionId: string) =>
    run(
      sql`SELECT EXISTS (
        SELECT 1 FROM broker_source_events AS boundary
        JOIN broker_observations AS observation ON observation.account_id = boundary.account_id
          AND observation.financial_reconciliation_fence_at >= boundary.recorded_at
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
  const readProtectionOrder = (brokerOrderId: string, clientOrderId: string) =>
    run(
      // Canonical nested protection normalization is the only first writer of this association. Stream updates
      // can reuse that exact identity, never create one. This proves identity, while the independent session
      // financial fence and complete-history reconciliation continue to govern readiness and money.
      sql`SELECT jsonb_strip_nulls(jsonb_build_object(
        'schemaVersion', child.schema_version, 'accountId', child.account_id,
        'brokerOrderId', child.broker_order_id, 'parentBrokerOrderId', child.parent_broker_order_id,
        'clientOrderId', child.client_order_id, 'intentId', child.intent_id, 'symbol', child.symbol,
        'side', child.side, 'orderType', child.order_type, 'timeInForce', child.time_in_force,
        'quantityAtoms', child.quantity_atoms::text, 'notionalMicros', child.notional_micros::text,
        'filledQuantityAtoms', child.filled_quantity_atoms::text, 'limitPriceMicros', child.limit_price_micros::text,
        'stopPriceMicros', child.stop_price_micros::text, 'status', child.status,
        'observedAt', to_char(event.observed_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
      )) AS value
      FROM orders AS child JOIN broker_events AS event USING (event_id)
      JOIN intents AS intent ON intent.intent_id = child.intent_id AND intent.account_id = child.account_id
      WHERE child.account_id = ${accountId} AND child.broker_order_id = ${brokerOrderId}
        AND child.client_order_id = ${clientOrderId} AND child.parent_broker_order_id IS NOT NULL
        AND child.symbol = intent.symbol AND child.quantity_atoms > 0 AND child.quantity_atoms <= intent.quantity_atoms
        AND child.time_in_force = 'DAY' AND child.notional_micros IS NULL
        AND intent.protection->>'_tag' IN ('Bracket','EquityShortBracket','Oco','EquityShortOco')
        AND child.side = CASE WHEN intent.protection->>'_tag' IN ('EquityShortBracket','EquityShortOco') THEN 'BUY' ELSE 'SELL' END
        AND ((child.order_type = 'STOP_LIMIT' AND child.stop_price_micros = (intent.protection->>'stopPriceMicros')::numeric
          AND child.limit_price_micros = (intent.protection->>'stopLimitPriceMicros')::numeric)
          OR (child.order_type = 'LIMIT' AND child.stop_price_micros IS NULL
            AND child.limit_price_micros = (intent.protection->>'profitLimitPriceMicros')::numeric))
        AND EXISTS (
          SELECT 1 FROM orders AS parent WHERE parent.account_id = child.account_id
            AND parent.broker_order_id = child.parent_broker_order_id AND parent.intent_id = child.intent_id
            AND parent.client_order_id = intent.client_order_id AND parent.parent_broker_order_id IS NULL
            AND parent.symbol = intent.symbol AND parent.side = intent.side
            AND parent.quantity_atoms = intent.quantity_atoms AND parent.notional_micros IS NULL
            AND parent.order_type = intent.order_type AND parent.time_in_force = intent.time_in_force
            AND parent.limit_price_micros = intent.limit_price_micros AND parent.stop_price_micros IS NULL
        )
      ORDER BY event.source_sequence DESC LIMIT 1`.pipe(
        Effect.flatMap(
          Schema.decodeUnknownEffect(
            Schema.Array(Schema.Struct({ value: OrderSchema })).check(Schema.isMaxLength(1)),
            strictParseOptions,
          ),
        ),
        Effect.map((rows) => rows[0]?.value),
      ),
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
      WHERE event.account_id = ${accountId} AND projection.event_id IS NULL`.pipe(
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
      sql.withTransaction(
        Effect.gen(function* () {
          // A fresh statement after taking this lock must see any just-committed scoped submit.
          const [locked] = yield* sql`SELECT account_id FROM broker_observations
          WHERE account_id = ${accountId} AND source_revision = ${sourceRevision} FOR UPDATE`
          if (locked === undefined)
            return yield* observationUnavailable('Broker observation owner is not active for this revision')
          return yield* sql`
    WITH owner AS (
      SELECT account_id, generation,
        GREATEST(next_poll_not_before, (
          SELECT max(mutation.occurred_at) + ${mutationConsistencyDelayMs} * interval '1 millisecond'
          FROM mutation_events AS mutation JOIN intents AS intent USING (intent_id)
          WHERE intent.account_id = broker_observations.account_id
        )) AS next_poll_not_before,
        clock_timestamp() AS checked_at FROM broker_observations
      WHERE account_id = ${accountId} AND source_revision = ${sourceRevision}
    ), pending_protection AS (
      SELECT max(active.deadline) AS deadline FROM owner
      JOIN autonomous_cycles AS cycle ON cycle.account_id = owner.account_id AND cycle.state = 'ACTIVE'
      JOIN intents AS intent ON intent.account_id = owner.account_id AND intent.cycle_id = cycle.cycle_id
      JOIN autonomous_cycle_paper_closures AS closure ON closure.cycle_id = cycle.cycle_id
      JOIN protection_release_proofs AS proof
        ON proof.proof_id = closure.document #>> '{document,plannerInput,protectionClose,proofId}'
      JOIN risk_decisions AS risk ON risk.decision_id = intent.risk_decision_id AND risk.intent_id = intent.intent_id
      CROSS JOIN LATERAL (SELECT LEAST(closure.expires_at, risk.expires_at,
        (closure.document #>> '{document,submissionCutoffAt}')::timestamptz,
        (closure.document #>> '{document,strategyDecision,commitDeadlineAt}')::timestamptz
      ) AS deadline) AS active
      WHERE intent.state = ${IntentState.IoStarted}
        AND closure.document #> '{document,orderedIntentIds}' = jsonb_build_array(intent.intent_id)
        AND proof.evidence #>> '{frontier,observationGeneration}' = owner.generation::text
        AND active.deadline > execution_account_commit_now(owner.account_id)
    ), claimed AS (
      INSERT INTO broker_observation_captures (account_id, capture_id, generation)
      SELECT account_id, ${captureId}, generation + 1 FROM owner CROSS JOIN pending_protection
      WHERE next_poll_not_before <= checked_at AND pending_protection.deadline IS NULL
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
      ceil(EXTRACT(EPOCH FROM GREATEST(next_poll_not_before, pending_protection.deadline)) * 1000)::double precision
        AS "nextPollNotBeforeMs"
    FROM owner CROSS JOIN pending_protection WHERE NOT EXISTS (SELECT 1 FROM reserved)
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
          )
        }),
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
      SELECT generation, snapshot_hash, state_hash,
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
        SELECT generation, snapshot_hash, state_hash,
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
            generation: pending.generation,
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
  const readObservation = run(
    Effect.gen(function* () {
      const row = yield* readProjection(null)
      const value = yield* readSnapshotPayload(row.snapshot_hash)
      const validated = yield* validateObservedBrokerSnapshot(value, accountId, yield* currentUtcInstant, maximumAgeMs)
      yield* requireSettled(row.pending)
      yield* requireSettledCashFees(validated)
      return { row, observation: validated }
    }),
  )
  const read = readObservation.pipe(Effect.map(({ observation }) => observation))
  const readForReconciliation = readObservation.pipe(
    Effect.map(({ row, observation }) => ({
      observation,
      // The generation and materialization identity bind completion to the exact cut that reconciliation read.
      // A concurrent source event rotates the generation in its insertion transaction, so this update then becomes
      // a conservative no-op and the replacement capture must reconcile before its session can use the fast lane.
      complete: run(
        sql`UPDATE broker_observations
          SET financial_reconciliation_fence_at = notification_fence_at
          WHERE account_id = ${accountId} AND source_revision = ${sourceRevision}
            AND generation = ${row.generation} AND snapshot_hash = ${row.snapshot_hash}
            AND available AND notification_fence_at IS NOT NULL`.pipe(Effect.asVoid),
      ),
    })),
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
    readActivityCursor,
    recordActivity,
    recordActivityCatchup,
    recordActivityHeartbeat,
    readAccountActivity,
    isNotificationCovered,
    isSessionBoundaryCovered,
    readNotification,
    readProtectionOrder,
    readSourceProjection,
    readProjectionBacklog,
    recordProjection,
    hasSessionProjectionGap,
    read,
    readForReconciliation,
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
