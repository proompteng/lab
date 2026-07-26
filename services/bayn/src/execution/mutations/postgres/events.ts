import { PgClient } from '@effect/sql-pg'
import { Effect, Result } from 'effect'
import type { SqlError } from 'effect/unstable/sql/SqlError'

import { MutationOperation } from '../../../broker/alpaca-mutations'
import { decideMutationAppend, storeError } from '../decisions'
import { MutationStoreError, type MutationEvent, type MutationStoreShape } from '../model'
import { decodeEventIds, decodeIntentId, decodeStoredEvents } from '../rows'
import { fromDecision } from './shared'

export interface MutationEventPostgres {
  readonly readLatest: (
    intentId: string,
    operation: MutationOperation,
  ) => Effect.Effect<MutationEvent | undefined, MutationStoreError | SqlError>
  readonly latest: MutationStoreShape['latest']
  readonly appendEvent: (
    operation: MutationStoreError['operation'],
    event: MutationEvent,
    requireCurrentRisk?: boolean,
  ) => Effect.Effect<MutationEvent, MutationStoreError | SqlError>
}

const selectLatest = (sql: PgClient.PgClient, intentId: string, operation: MutationOperation) => sql`
  SELECT
    schema_version,
    event_id,
    mutation_id,
    intent_id,
    sequence::integer,
    operation,
    event_type,
    request_hash,
    consistency_delay_ms,
    broker_order_id,
    request_id,
    response_status::integer,
    response_content_hash,
    to_char(occurred_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS occurred_at
  FROM mutation_events
  WHERE intent_id = ${intentId} AND operation = ${operation}
  ORDER BY sequence DESC
  LIMIT 1
`

export const makeMutationEventPostgres = (sql: PgClient.PgClient): MutationEventPostgres => {
  const readLatest = (intentId: string, operation: MutationOperation) =>
    selectLatest(sql, intentId, operation).pipe(
      Effect.flatMap((rows) => fromDecision(() => Result.map(decodeStoredEvents(rows), (events) => events[0]))),
    )

  const latest = (intentId: string, operation: MutationOperation) =>
    fromDecision(() => decodeIntentId(intentId)).pipe(
      Effect.flatMap((decodedIntentId) => readLatest(decodedIntentId, operation)),
      Effect.mapError((cause) =>
        cause instanceof MutationStoreError ? cause : storeError('read', 'query', 'mutation read failed', cause),
      ),
    )

  const appendEvent = (operation: MutationStoreError['operation'], event: MutationEvent, requireCurrentRisk = false) =>
    sql<{ event_id: string }>`
      INSERT INTO mutation_events (
        event_id,
        schema_version,
        mutation_id,
        intent_id,
        sequence,
        operation,
        event_type,
        request_hash,
        consistency_delay_ms,
        broker_order_id,
        request_id,
        response_status,
        response_content_hash,
        occurred_at
      )
      SELECT
        ${event.eventId},
        ${event.schemaVersion},
        ${event.mutationId},
        ${event.intentId},
        ${event.sequence},
        ${event.operation},
        ${event.eventType},
        ${event.requestHash},
        ${event.consistencyDelayMs},
        ${event.brokerOrderId ?? null},
        ${event.requestId ?? null},
        ${event.responseStatus ?? null},
        ${event.responseContentHash ?? null},
        ${event.occurredAt}
      WHERE ${!requireCurrentRisk}
        OR EXISTS (
          SELECT 1
          FROM intents AS intent
          JOIN risk_decisions AS decision
            ON decision.decision_id = intent.risk_decision_id
            AND decision.intent_id = intent.intent_id
          WHERE intent.intent_id = ${event.intentId}
            AND decision.outcome = 'APPROVED'
            AND decision.decided_at <= clock_timestamp()
            AND decision.expires_at > clock_timestamp()
        )
      RETURNING event_id
    `.pipe(
      Effect.flatMap((rows) =>
        fromDecision(() =>
          Result.flatMap(decodeEventIds(operation, rows), (eventIds) =>
            decideMutationAppend(operation, event, eventIds, requireCurrentRisk),
          ),
        ),
      ),
    )

  return { readLatest, latest, appendEvent }
}
