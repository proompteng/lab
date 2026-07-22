import { PgClient } from '@effect/sql-pg'
import { Context, Data, Effect, Layer, Schema } from 'effect'

import { canonicalHashV1 } from '../hash'
import { Authority, IntentState, KillState, TerminalOutcome } from '../paper'
import {
  Sha256Schema as Sha256,
  StrictNonEmptyStringSchema as NonEmptyString,
  UtcInstantSchema as UtcInstant,
  strictParseOptions,
} from '../schemas'
import { MutationEvidenceSchema, MutationOperation, type MutationEvidence } from '../broker/alpaca-mutations'
import { mutationFence, WriterFence, WriterFenceError } from './writer-fence'

export enum MutationEventType {
  SubmitStarted = 'SUBMIT_STARTED',
  SubmitAccepted = 'SUBMIT_ACCEPTED',
  SubmitRejected = 'SUBMIT_REJECTED',
  SubmitUnknown = 'SUBMIT_UNKNOWN',
  RecoveryFound = 'RECOVERY_FOUND',
  RecoveryNotFound = 'RECOVERY_NOT_FOUND',
  RecoveryUnknown = 'RECOVERY_UNKNOWN',
  CancelStarted = 'CANCEL_STARTED',
  CancelAccepted = 'CANCEL_ACCEPTED',
  CancelUnknown = 'CANCEL_UNKNOWN',
}

const Sequence = Schema.Int.check(Schema.isGreaterThan(0))
const HttpStatus = Schema.Int.check(Schema.isBetween({ minimum: 100, maximum: 599 }))
const ConsistencyDelay = Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 300_000 }))
const MutationEventSchema = Schema.Struct({
  schemaVersion: Schema.Literal('bayn.paper-mutation-event.v1'),
  eventId: Sha256,
  mutationId: Sha256,
  intentId: Sha256,
  sequence: Sequence,
  operation: Schema.Enum(MutationOperation),
  eventType: Schema.Enum(MutationEventType),
  requestHash: Sha256,
  consistencyDelayMs: ConsistencyDelay,
  brokerOrderId: Schema.optionalKey(NonEmptyString),
  requestId: Schema.optionalKey(NonEmptyString),
  responseStatus: Schema.optionalKey(HttpStatus),
  responseContentHash: Schema.optionalKey(Sha256),
  occurredAt: UtcInstant,
})
export type MutationEvent = typeof MutationEventSchema.Type

const StoredEventRow = Schema.Struct({
  schema_version: Schema.Literal('bayn.paper-mutation-event.v1'),
  event_id: Sha256,
  mutation_id: Sha256,
  intent_id: Sha256,
  sequence: Sequence,
  operation: Schema.Enum(MutationOperation),
  event_type: Schema.Enum(MutationEventType),
  request_hash: Sha256,
  consistency_delay_ms: ConsistencyDelay,
  broker_order_id: Schema.NullOr(NonEmptyString),
  request_id: Schema.NullOr(NonEmptyString),
  response_status: Schema.NullOr(HttpStatus),
  response_content_hash: Schema.NullOr(Sha256),
  occurred_at: UtcInstant,
})
const decodeRows = Schema.decodeUnknownEffect(Schema.Array(StoredEventRow), strictParseOptions)
const decodeSha = Schema.decodeUnknownEffect(Sha256)
const decodeTime = Schema.decodeUnknownEffect(UtcInstant)
const decodeBrokerOrderId = Schema.decodeUnknownEffect(NonEmptyString.check(Schema.isMaxLength(256)))
const decodeEvidence = Schema.decodeUnknownEffect(MutationEvidenceSchema, strictParseOptions)

const eventIdentity = (event: Omit<MutationEvent, 'eventId'>) => ({
  schemaVersion: event.schemaVersion,
  mutationId: event.mutationId,
  intentId: event.intentId,
  sequence: event.sequence,
  operation: event.operation,
  eventType: event.eventType,
  requestHash: event.requestHash,
  consistencyDelayMs: event.consistencyDelayMs,
  ...(event.brokerOrderId === undefined ? {} : { brokerOrderId: event.brokerOrderId }),
  ...(event.requestId === undefined ? {} : { requestId: event.requestId }),
  ...(event.responseStatus === undefined ? {} : { responseStatus: event.responseStatus }),
  ...(event.responseContentHash === undefined ? {} : { responseContentHash: event.responseContentHash }),
  occurredAt: event.occurredAt,
})

export const mutationId = (intentId: string, operation: MutationOperation): string =>
  canonicalHashV1({ schemaVersion: 'bayn.paper-mutation.v1', intentId, operation })

const makeEvent = (event: Omit<MutationEvent, 'eventId' | 'schemaVersion'>): MutationEvent => {
  const content = { schemaVersion: 'bayn.paper-mutation-event.v1' as const, ...event }
  return { ...content, eventId: canonicalHashV1(eventIdentity(content)) }
}

const toEvent = (row: typeof StoredEventRow.Type): MutationEvent => ({
  schemaVersion: row.schema_version,
  eventId: row.event_id,
  mutationId: row.mutation_id,
  intentId: row.intent_id,
  sequence: row.sequence,
  operation: row.operation,
  eventType: row.event_type,
  requestHash: row.request_hash,
  consistencyDelayMs: row.consistency_delay_ms,
  ...(row.broker_order_id === null ? {} : { brokerOrderId: row.broker_order_id }),
  ...(row.request_id === null ? {} : { requestId: row.request_id }),
  ...(row.response_status === null ? {} : { responseStatus: row.response_status }),
  ...(row.response_content_hash === null ? {} : { responseContentHash: row.response_content_hash }),
  occurredAt: row.occurred_at,
})

export class MutationStoreError extends Data.TaggedError('MutationStoreError')<{
  readonly operation: 'begin-submit' | 'record-submit' | 'begin-cancel' | 'record-cancel' | 'record-recovery' | 'read'
  readonly failure: 'authority' | 'conflict' | 'decode' | 'invariant' | 'query'
  readonly message: string
  readonly cause?: unknown
}> {}

export interface StartReceipt {
  readonly event: MutationEvent
  readonly started: boolean
}

export interface MutationStoreShape {
  readonly beginSubmit: (
    intentId: string,
    requestHash: string,
    consistencyDelayMs: number,
    occurredAt: string,
  ) => Effect.Effect<StartReceipt, MutationStoreError | WriterFenceError>
  readonly submitAccepted: (
    intentId: string,
    requestHash: string,
    brokerOrderId: string,
    evidence: MutationEvidence,
    terminalOutcome?: TerminalOutcome,
  ) => Effect.Effect<MutationEvent, MutationStoreError | WriterFenceError>
  readonly submitRejected: (
    intentId: string,
    requestHash: string,
    evidence: MutationEvidence,
  ) => Effect.Effect<MutationEvent, MutationStoreError | WriterFenceError>
  readonly submitUnknown: (
    intentId: string,
    requestHash: string,
    occurredAt: string,
    evidence?: Partial<MutationEvidence>,
  ) => Effect.Effect<MutationEvent, MutationStoreError | WriterFenceError>
  readonly beginCancel: (
    intentId: string,
    requestHash: string,
    brokerOrderId: string,
    consistencyDelayMs: number,
    occurredAt: string,
  ) => Effect.Effect<StartReceipt, MutationStoreError | WriterFenceError>
  readonly cancelAccepted: (
    intentId: string,
    requestHash: string,
    brokerOrderId: string,
    evidence: MutationEvidence,
  ) => Effect.Effect<MutationEvent, MutationStoreError | WriterFenceError>
  readonly cancelUnknown: (
    intentId: string,
    requestHash: string,
    brokerOrderId: string,
    occurredAt: string,
    evidence?: Partial<MutationEvidence>,
  ) => Effect.Effect<MutationEvent, MutationStoreError | WriterFenceError>
  readonly recoveryFound: (
    intentId: string,
    operation: MutationOperation,
    requestHash: string,
    brokerOrderId: string,
    evidence: MutationEvidence,
    terminalOutcome?: TerminalOutcome,
  ) => Effect.Effect<MutationEvent, MutationStoreError | WriterFenceError>
  readonly recoveryNotFound: (
    intentId: string,
    operation: MutationOperation,
    requestHash: string,
    evidence: MutationEvidence,
  ) => Effect.Effect<MutationEvent, MutationStoreError | WriterFenceError>
  readonly recoveryUnknown: (
    intentId: string,
    operation: MutationOperation,
    requestHash: string,
    occurredAt: string,
    evidence?: Partial<MutationEvidence>,
  ) => Effect.Effect<MutationEvent, MutationStoreError | WriterFenceError>
  readonly latest: (
    intentId: string,
    operation: MutationOperation,
  ) => Effect.Effect<MutationEvent | undefined, MutationStoreError>
}

export class MutationStore extends Context.Service<MutationStore, MutationStoreShape>()('bayn/MutationStore') {}

const storeError = (
  operation: MutationStoreError['operation'],
  failure: MutationStoreError['failure'],
  message: string,
  cause?: unknown,
) => new MutationStoreError({ operation, failure, message, cause })

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

const makeStore = Effect.gen(function* () {
  const sql = yield* PgClient.PgClient
  const fence = yield* WriterFence

  const run = <A, E, R>(
    operation: MutationStoreError['operation'],
    effect: Effect.Effect<A, E, R>,
  ): Effect.Effect<A, MutationStoreError | WriterFenceError, R> =>
    effect.pipe(
      Effect.mapError((cause) =>
        cause instanceof MutationStoreError || cause instanceof WriterFenceError
          ? cause
          : storeError(operation, 'query', `mutation ${operation} failed`, cause),
      ),
    )

  const withFence = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    sql.withTransaction(
      Effect.gen(function* () {
        yield* sql`SELECT pg_advisory_xact_lock(${mutationFence.namespace}, ${mutationFence.key})`
        yield* fence.check
        return yield* effect
      }),
    )

  const latest = (intentId: string, operation: MutationOperation) =>
    Effect.gen(function* () {
      const decodedIntentId = yield* decodeSha(intentId).pipe(
        Effect.mapError((cause) => storeError('read', 'decode', 'invalid intent ID', cause)),
      )
      const rows = yield* decodeRows(yield* selectLatest(sql, decodedIntentId, operation)).pipe(
        Effect.mapError((cause) => storeError('read', 'decode', 'stored mutation event failed decoding', cause)),
      )
      return rows[0] === undefined ? undefined : toEvent(rows[0])
    }).pipe(
      Effect.mapError((cause) =>
        cause instanceof MutationStoreError ? cause : storeError('read', 'query', 'mutation read failed', cause),
      ),
    )

  const append = (event: MutationEvent) =>
    Effect.as(
      sql`
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
        ) VALUES (
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
        )
      `,
      event,
    )

  const assertAuthority = (operation: 'submit' | 'cancel') =>
    Effect.gen(function* () {
      const rows = yield* sql<{ effective: string; kill_state: string; maximum: string }>`
        SELECT maximum, effective, kill_state
        FROM authority_state
        WHERE singleton
        FOR UPDATE
      `
      const authority = rows[0]
      if (authority === undefined) {
        return yield* Effect.fail(
          storeError(
            operation === 'submit' ? 'begin-submit' : 'begin-cancel',
            'authority',
            'paper authority is not initialized',
          ),
        )
      }
      if (authority.maximum !== Authority.Paper) {
        return yield* Effect.fail(
          storeError(
            operation === 'submit' ? 'begin-submit' : 'begin-cancel',
            'authority',
            'GitOps maximum authority is not PAPER',
          ),
        )
      }
      if (
        operation === 'submit' &&
        (authority.effective !== Authority.Paper || authority.kill_state !== KillState.Clear)
      ) {
        return yield* Effect.fail(storeError('begin-submit', 'authority', 'effective authority is not PAPER and clear'))
      }
      if (
        operation === 'cancel' &&
        authority.kill_state === KillState.Clear &&
        authority.effective !== Authority.Paper
      ) {
        return yield* Effect.fail(
          storeError('begin-cancel', 'authority', 'cancellation requires PAPER authority or an active kill'),
        )
      }
    })

  const assertNoOtherUnresolved = (intentId: string) =>
    Effect.gen(function* () {
      const rows = yield* sql<{ unresolved: boolean }>`
        SELECT EXISTS (
          SELECT 1
          FROM (
            SELECT DISTINCT ON (events.mutation_id)
              events.intent_id,
              events.operation,
              events.event_type,
              intents.state
            FROM mutation_events AS events
            JOIN intents ON intents.intent_id = events.intent_id
            ORDER BY events.mutation_id, events.sequence DESC
          ) AS latest
          WHERE latest.intent_id <> ${intentId}
            AND (
              latest.event_type IN (
                'SUBMIT_STARTED',
                'SUBMIT_UNKNOWN',
                'RECOVERY_NOT_FOUND',
                'RECOVERY_UNKNOWN',
                'CANCEL_STARTED',
                'CANCEL_ACCEPTED',
                'CANCEL_UNKNOWN'
              )
              OR (
                latest.operation = 'CANCEL'
                AND latest.event_type = 'RECOVERY_FOUND'
                AND latest.state <> 'TERMINAL'
              )
            )
        ) AS unresolved
      `
      if (rows[0]?.unresolved !== false) {
        return yield* Effect.fail(
          storeError('begin-submit', 'invariant', 'another broker mutation has an unresolved outcome'),
        )
      }
    })

  const begin = (
    operation: MutationOperation,
    intentId: string,
    requestHash: string,
    consistencyDelayMs: number,
    occurredAt: string,
    brokerOrderId?: string,
  ) =>
    run(
      operation === MutationOperation.Submit ? 'begin-submit' : 'begin-cancel',
      Effect.gen(function* () {
        const decodedIntentId = yield* decodeSha(intentId).pipe(
          Effect.mapError((cause) =>
            storeError(
              operation === MutationOperation.Submit ? 'begin-submit' : 'begin-cancel',
              'decode',
              'invalid intent ID',
              cause,
            ),
          ),
        )
        const decodedRequestHash = yield* decodeSha(requestHash).pipe(
          Effect.mapError((cause) =>
            storeError(
              operation === MutationOperation.Submit ? 'begin-submit' : 'begin-cancel',
              'decode',
              'invalid request hash',
              cause,
            ),
          ),
        )
        const decodedConsistencyDelay = yield* Schema.decodeUnknownEffect(ConsistencyDelay)(consistencyDelayMs).pipe(
          Effect.mapError((cause) =>
            storeError(
              operation === MutationOperation.Submit ? 'begin-submit' : 'begin-cancel',
              'decode',
              'invalid broker consistency delay',
              cause,
            ),
          ),
        )
        const decodedTime = yield* decodeTime(occurredAt).pipe(
          Effect.mapError((cause) =>
            storeError(
              operation === MutationOperation.Submit ? 'begin-submit' : 'begin-cancel',
              'decode',
              'invalid mutation time',
              cause,
            ),
          ),
        )
        const decodedBrokerOrderId =
          brokerOrderId === undefined
            ? undefined
            : yield* decodeBrokerOrderId(brokerOrderId).pipe(
                Effect.mapError((cause) =>
                  storeError(
                    operation === MutationOperation.Submit ? 'begin-submit' : 'begin-cancel',
                    'decode',
                    'invalid broker order ID',
                    cause,
                  ),
                ),
              )
        return yield* withFence(
          Effect.gen(function* () {
            const existing = yield* latest(decodedIntentId, operation)
            if (existing !== undefined) {
              if (
                existing.requestHash !== decodedRequestHash ||
                existing.consistencyDelayMs !== decodedConsistencyDelay ||
                (operation === MutationOperation.Cancel && existing.brokerOrderId !== decodedBrokerOrderId) ||
                existing.mutationId !== mutationId(decodedIntentId, operation)
              ) {
                return yield* Effect.fail(
                  storeError(
                    operation === MutationOperation.Submit ? 'begin-submit' : 'begin-cancel',
                    'conflict',
                    'mutation identity was reused with different request content',
                  ),
                )
              }
              return { event: existing, started: false } satisfies StartReceipt
            }

            yield* assertAuthority(operation === MutationOperation.Submit ? 'submit' : 'cancel')
            if (operation === MutationOperation.Submit) yield* assertNoOtherUnresolved(decodedIntentId)
            const intents = yield* sql<{ state: string; updated_at: string }>`
              SELECT state, to_char(updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS updated_at
              FROM intents
              WHERE intent_id = ${decodedIntentId}
              FOR UPDATE
            `
            const intent = intents[0]
            if (intent === undefined) {
              return yield* Effect.fail(
                storeError(
                  operation === MutationOperation.Submit ? 'begin-submit' : 'begin-cancel',
                  'invariant',
                  'intent does not exist',
                ),
              )
            }
            const requiredState =
              operation === MutationOperation.Submit ? IntentState.Approved : IntentState.Acknowledged
            if (intent.state !== requiredState) {
              return yield* Effect.fail(
                storeError(
                  operation === MutationOperation.Submit ? 'begin-submit' : 'begin-cancel',
                  'invariant',
                  `${operation.toLowerCase()} requires an ${requiredState} intent`,
                ),
              )
            }
            if (decodedTime <= intent.updated_at) {
              return yield* Effect.fail(
                storeError(
                  operation === MutationOperation.Submit ? 'begin-submit' : 'begin-cancel',
                  'invariant',
                  'mutation time must follow the intent state',
                ),
              )
            }

            const event = makeEvent({
              mutationId: mutationId(decodedIntentId, operation),
              intentId: decodedIntentId,
              sequence: 1,
              operation,
              eventType:
                operation === MutationOperation.Submit
                  ? MutationEventType.SubmitStarted
                  : MutationEventType.CancelStarted,
              requestHash: decodedRequestHash,
              consistencyDelayMs: decodedConsistencyDelay,
              ...(decodedBrokerOrderId === undefined ? {} : { brokerOrderId: decodedBrokerOrderId }),
              occurredAt: decodedTime,
            })
            yield* append(event)
            if (operation === MutationOperation.Submit) {
              const transitioned = yield* sql<{ intent_id: string }>`
                UPDATE intents
                SET state = ${IntentState.IoStarted}, state_version = state_version + 1, updated_at = ${decodedTime}
                WHERE intent_id = ${decodedIntentId} AND state = ${IntentState.Approved}
                RETURNING intent_id
              `
              if (transitioned.length !== 1) {
                return yield* Effect.fail(
                  storeError('begin-submit', 'conflict', 'approved intent transition lost its race'),
                )
              }
            }
            return { event, started: true } satisfies StartReceipt
          }),
        )
      }),
    )

  const appendOutcome = (
    storeOperation: MutationStoreError['operation'],
    intentId: string,
    operation: MutationOperation,
    requestHash: string,
    eventType: MutationEventType,
    occurredAt: string,
    fields: {
      readonly brokerOrderId?: string
      readonly evidence?: Partial<MutationEvidence>
      readonly nextState?: IntentState
      readonly fromState?: IntentState
      readonly terminalOutcome?: TerminalOutcome
      readonly recover?: boolean
    },
  ) =>
    run(
      storeOperation,
      Effect.gen(function* () {
        const decodedIntentId = yield* decodeSha(intentId).pipe(
          Effect.mapError((cause) => storeError(storeOperation, 'decode', 'invalid intent ID', cause)),
        )
        const decodedRequestHash = yield* decodeSha(requestHash).pipe(
          Effect.mapError((cause) => storeError(storeOperation, 'decode', 'invalid request hash', cause)),
        )
        const decodedTime = yield* decodeTime(occurredAt).pipe(
          Effect.mapError((cause) => storeError(storeOperation, 'decode', 'invalid mutation time', cause)),
        )
        const decodedBrokerOrderId =
          fields.brokerOrderId === undefined
            ? undefined
            : yield* decodeBrokerOrderId(fields.brokerOrderId).pipe(
                Effect.mapError((cause) => storeError(storeOperation, 'decode', 'invalid broker order ID', cause)),
              )
        const decodedEvidence =
          fields.evidence?.requestId === undefined ||
          fields.evidence.status === undefined ||
          fields.evidence.contentHash === undefined ||
          fields.evidence.observedAt === undefined
            ? undefined
            : yield* decodeEvidence(fields.evidence).pipe(
                Effect.mapError((cause) => storeError(storeOperation, 'decode', 'invalid broker evidence', cause)),
              )
        return yield* withFence(
          Effect.gen(function* () {
            const previous = yield* latest(decodedIntentId, operation)
            if (previous === undefined) {
              return yield* Effect.fail(
                storeError(storeOperation, 'invariant', 'mutation STARTED event does not exist'),
              )
            }
            if (previous.requestHash !== decodedRequestHash) {
              return yield* Effect.fail(storeError(storeOperation, 'conflict', 'mutation request hash changed'))
            }
            const eventBrokerOrderId = decodedBrokerOrderId ?? previous.brokerOrderId
            const event = makeEvent({
              mutationId: previous.mutationId,
              intentId: decodedIntentId,
              sequence: previous.sequence + 1,
              operation,
              eventType,
              requestHash: decodedRequestHash,
              consistencyDelayMs: previous.consistencyDelayMs,
              ...(eventBrokerOrderId === undefined ? {} : { brokerOrderId: eventBrokerOrderId }),
              ...(decodedEvidence?.requestId === undefined ? {} : { requestId: decodedEvidence.requestId }),
              ...(decodedEvidence?.status === undefined ? {} : { responseStatus: decodedEvidence.status }),
              ...(decodedEvidence?.contentHash === undefined
                ? {}
                : { responseContentHash: decodedEvidence.contentHash }),
              occurredAt: decodedTime,
            })
            if (
              previous.eventType === event.eventType &&
              previous.requestId === event.requestId &&
              previous.responseStatus === event.responseStatus &&
              previous.responseContentHash === event.responseContentHash &&
              previous.brokerOrderId === event.brokerOrderId
            ) {
              return previous
            }
            yield* append(event)

            if (fields.recover === true) {
              const recovered = yield* sql<{ intent_id: string }>`
                UPDATE intents
                SET state = ${IntentState.Recovered}, state_version = state_version + 1, updated_at = ${decodedTime}
                WHERE intent_id = ${decodedIntentId} AND state = ${IntentState.Unknown}
                RETURNING intent_id
              `
              if (recovered.length !== 1) {
                return yield* Effect.fail(
                  storeError(storeOperation, 'conflict', 'unknown intent recovery lost its race'),
                )
              }
              if (fields.nextState !== undefined) {
                const transitioned = yield* sql<{ intent_id: string }>`
                  UPDATE intents
                  SET
                    state = ${fields.nextState},
                    terminal_outcome = ${fields.terminalOutcome ?? null},
                    state_version = state_version + 1,
                    updated_at = GREATEST(
                      ${decodedTime}::timestamptz + interval '1 microsecond',
                      updated_at + interval '1 microsecond'
                  )
                  WHERE intent_id = ${decodedIntentId} AND state = ${IntentState.Recovered}
                  RETURNING intent_id
                `
                if (transitioned.length !== 1) {
                  return yield* Effect.fail(
                    storeError(storeOperation, 'conflict', 'recovered intent outcome lost its race'),
                  )
                }
              }
            } else if (fields.nextState !== undefined) {
              const transitioned = yield* sql<{ intent_id: string }>`
                UPDATE intents
                SET
                  state = ${fields.nextState},
                  terminal_outcome = ${fields.terminalOutcome ?? null},
                  state_version = state_version + 1,
                  updated_at = GREATEST(${decodedTime}::timestamptz, updated_at + interval '1 microsecond')
                WHERE intent_id = ${decodedIntentId} AND state = ${fields.fromState ?? IntentState.IoStarted}
                RETURNING intent_id
              `
              if (transitioned.length !== 1) {
                return yield* Effect.fail(
                  storeError(storeOperation, 'conflict', 'intent mutation outcome lost its race'),
                )
              }
            }
            return event
          }),
        )
      }),
    )

  const completeEvidence = (evidence: Partial<MutationEvidence> | undefined): Partial<MutationEvidence> | undefined =>
    evidence?.requestId !== undefined &&
    evidence.status !== undefined &&
    evidence.contentHash !== undefined &&
    evidence.observedAt !== undefined
      ? evidence
      : undefined

  return {
    beginSubmit: (intentId, requestHash, consistencyDelayMs, occurredAt) =>
      begin(MutationOperation.Submit, intentId, requestHash, consistencyDelayMs, occurredAt),
    submitAccepted: (intentId, requestHash, brokerOrderId, evidence, terminalOutcome) => {
      const terminal = terminalOutcome !== undefined
      return appendOutcome(
        'record-submit',
        intentId,
        MutationOperation.Submit,
        requestHash,
        MutationEventType.SubmitAccepted,
        evidence.observedAt,
        {
          brokerOrderId,
          evidence,
          nextState: terminal ? IntentState.Terminal : IntentState.Acknowledged,
          ...(terminalOutcome === undefined ? {} : { terminalOutcome }),
        },
      )
    },
    submitRejected: (intentId, requestHash, evidence) =>
      appendOutcome(
        'record-submit',
        intentId,
        MutationOperation.Submit,
        requestHash,
        MutationEventType.SubmitRejected,
        evidence.observedAt,
        {
          evidence,
          nextState: IntentState.Terminal,
          terminalOutcome: TerminalOutcome.Rejected,
        },
      ),
    submitUnknown: (intentId, requestHash, occurredAt, evidence) =>
      appendOutcome(
        'record-submit',
        intentId,
        MutationOperation.Submit,
        requestHash,
        MutationEventType.SubmitUnknown,
        occurredAt,
        { evidence: completeEvidence(evidence), nextState: IntentState.Unknown },
      ),
    beginCancel: (intentId, requestHash, brokerOrderId, consistencyDelayMs, occurredAt) =>
      begin(MutationOperation.Cancel, intentId, requestHash, consistencyDelayMs, occurredAt, brokerOrderId),
    cancelAccepted: (intentId, requestHash, brokerOrderId, evidence) =>
      appendOutcome(
        'record-cancel',
        intentId,
        MutationOperation.Cancel,
        requestHash,
        MutationEventType.CancelAccepted,
        evidence.observedAt,
        { brokerOrderId, evidence },
      ),
    cancelUnknown: (intentId, requestHash, brokerOrderId, occurredAt, evidence) =>
      appendOutcome(
        'record-cancel',
        intentId,
        MutationOperation.Cancel,
        requestHash,
        MutationEventType.CancelUnknown,
        occurredAt,
        { brokerOrderId, evidence: completeEvidence(evidence) },
      ),
    recoveryFound: (intentId, operation, requestHash, brokerOrderId, evidence, terminalOutcome) => {
      const terminal = terminalOutcome !== undefined
      return appendOutcome(
        'record-recovery',
        intentId,
        operation,
        requestHash,
        MutationEventType.RecoveryFound,
        evidence.observedAt,
        {
          brokerOrderId,
          evidence,
          recover: operation === MutationOperation.Submit,
          ...(operation === MutationOperation.Submit || terminal
            ? {
                nextState: terminal ? IntentState.Terminal : IntentState.Acknowledged,
                ...(operation === MutationOperation.Cancel ? { fromState: IntentState.Acknowledged } : {}),
                ...(terminalOutcome === undefined ? {} : { terminalOutcome }),
              }
            : {}),
        },
      )
    },
    recoveryNotFound: (intentId, operation, requestHash, evidence) =>
      appendOutcome(
        'record-recovery',
        intentId,
        operation,
        requestHash,
        MutationEventType.RecoveryNotFound,
        evidence.observedAt,
        { evidence },
      ),
    recoveryUnknown: (intentId, operation, requestHash, occurredAt, evidence) =>
      appendOutcome(
        'record-recovery',
        intentId,
        operation,
        requestHash,
        MutationEventType.RecoveryUnknown,
        occurredAt,
        { evidence: completeEvidence(evidence) },
      ),
    latest,
  } satisfies MutationStoreShape
})

export const MutationStoreLive = Layer.effect(MutationStore, makeStore)
