import { NativeProtectionSchema } from '../../contracts'
import { orderRequestBody } from '../../../broker/alpaca-mutations/decisions'
import { canonicalHashV1Result } from '../../../hash'
import { OrderSide, OrderType, TimeInForce } from '../../contracts'
import { PgClient } from '@effect/sql-pg'
import { Effect, Result, Schema } from 'effect'
import type { SqlError } from 'effect/sql/SqlError'

import { MutationOperation } from '../../../broker/alpaca-mutations/model'
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
    denial_reason,
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
        cause instanceof MutationStoreError
          ? cause
          : storeError({ operation: 'read', failure: 'query', message: 'mutation read failed', cause }),
      ),
    )

  const appendEvent = (operation: MutationStoreError['operation'], event: MutationEvent, requireCurrentRisk = false) =>
    Effect.gen(function* () {
      let requestBody: unknown = null
      if (event.eventType === 'SUBMIT_STARTED') {
        const rows = yield* sql<
          Record<string, unknown>
        >`SELECT client_order_id, symbol, side, order_type, time_in_force,
          quantity_atoms::text, notional_limit_micros::text, limit_price_micros::text, protection FROM intents WHERE intent_id = ${event.intentId}`
        const [intent] = yield* Schema.decodeUnknownEffect(
          Schema.Tuple([
            Schema.Struct({
              client_order_id: Schema.String,
              symbol: Schema.String,
              side: Schema.Enum(OrderSide),
              order_type: Schema.Literals([OrderType.Limit, OrderType.StopLimit]),
              time_in_force: Schema.Literals([
                TimeInForce.Day,
                TimeInForce.ImmediateOrCancel,
                TimeInForce.GoodUntilCanceled,
              ]),
              quantity_atoms: Schema.String,
              notional_limit_micros: Schema.String,
              limit_price_micros: Schema.String,
              protection: Schema.NullOr(NativeProtectionSchema),
            }),
          ]),
        )(rows).pipe(
          Effect.mapError((cause) =>
            storeError({ operation, failure: 'decode', message: 'submit evidence intent is invalid', cause }),
          ),
        )
        const body = orderRequestBody({
          clientOrderId: intent.client_order_id,
          symbol: intent.symbol,
          side: intent.side,
          orderType: intent.order_type,
          timeInForce: intent.time_in_force,
          quantityAtoms: intent.quantity_atoms,
          notionalLimitMicros: intent.notional_limit_micros,
          limitPriceMicros: intent.limit_price_micros,
          ...(intent.protection === null ? {} : { protection: intent.protection }),
        })
        if (Result.isFailure(body))
          return yield* storeError({
            operation,
            failure: 'invariant',
            message: 'submit evidence request is invalid',
            cause: body.failure,
          })
        const hash = canonicalHashV1Result(body.success)
        if (Result.isFailure(hash) || hash.success !== event.requestHash)
          return yield* storeError({
            operation,
            failure: 'conflict',
            message: 'submit evidence differs from the request hash',
          })
        requestBody = body.success
      }
      return yield* sql<{ event_id: string }>`
      INSERT INTO mutation_events (
        event_id,
        schema_version,
        mutation_id,
        intent_id,
        sequence,
        operation,
        event_type,
        request_hash,
        request_body,
        consistency_delay_ms,
        broker_order_id,
        request_id,
        response_status,
        response_content_hash,
        denial_reason,
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
        ${sql.json(requestBody)},
        ${event.consistencyDelayMs},
        ${event.brokerOrderId ?? null},
        ${event.requestId ?? null},
        ${event.responseStatus ?? null},
        ${event.responseContentHash ?? null},
        ${event.denialReason ?? null},
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
            AND decision.decided_at <= execution_account_now(intent.account_id)
            AND decision.expires_at > execution_account_now(intent.account_id)
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
    })

  return { readLatest, latest, appendEvent }
}
