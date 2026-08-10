import { PgClient } from '@effect/sql-pg'
import { Effect, Result } from 'effect'
import type { SqlError } from 'effect/unstable/sql/SqlError'

import { MutationOperation } from '../../../broker/alpaca-mutations'
import { IntentState } from '../../contracts'
import {
  decideMutationAuthority,
  decideMutationContainment,
  decideFinalSubmitAuthorization,
  decideMutationStart,
  decideMutationStartReplay,
  decideSubmitStartWrite,
  decodeStartInput,
  startStoreOperationFor,
} from '../decisions'
import type { MutationStartInput, MutationStoreError, StartReceipt } from '../model'
import { decodeAuthoritySnapshot, decodeIntentIds, decodeIntentSnapshot, decodeUnresolved } from '../rows'
import type { MutationEventPostgres } from './events'
import { fromDecision } from './shared'
import type { WriterFenceError, WriterFenceService } from '../../writer-fence'
import { Pipeable } from '../../../pipeable'

export interface MutationStartPostgres {
  readonly authorizeSubmit: (
    intentId: string,
    closeOnly?: boolean,
  ) => Effect.Effect<void, MutationStoreError | SqlError>
  readonly begin: (
    operation: MutationOperation,
    intentId: string,
    requestHash: string,
    consistencyDelayMs: number,
    occurredAt: string,
    brokerOrderId?: string,
    closeOnly?: boolean,
  ) => Effect.Effect<StartReceipt, MutationStoreError | SqlError | WriterFenceError>
}

const makeMutationStartPostgresDataFirst = (
  sql: PgClient.PgClient,
  fence: WriterFenceService,
  events: MutationEventPostgres,
): MutationStartPostgres => {
  const readAuthorityBinding = (operation: MutationOperation, closeOnly = false) =>
    sql<{
      effective: string
      generation_hash: string
      generation_account_id: string | null
      generation_maximum: string | null
      kill_state: string
      maximum: string
    }>`
      SELECT
        authority.maximum,
        authority.effective,
        authority.kill_state,
        authority.generation_hash,
        generation.maximum AS generation_maximum,
        generation.account_id AS generation_account_id
      FROM authority_state AS authority
      LEFT JOIN authority_generations AS generation
        ON generation.generation_hash = authority.generation_hash
      WHERE authority.singleton
      FOR UPDATE OF authority
    `.pipe(
      Effect.flatMap((rows) =>
        fromDecision(() =>
          Result.flatMap(decodeAuthoritySnapshot(operation, rows), (authority) =>
            decideMutationAuthority(operation, authority, closeOnly),
          ),
        ),
      ),
    )

  const requireNoOtherUnresolved = (intentId: string) =>
    sql<{ unresolved: boolean }>`
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
          AND latest.state <> 'TERMINAL'
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
            )
          )
      ) AS unresolved
    `.pipe(
      Effect.flatMap((rows) => fromDecision(() => Result.flatMap(decodeUnresolved(rows), decideMutationContainment))),
    )

  const readIntent = (operation: MutationOperation, intentId: string) =>
    sql<{
      account_id: string
      authority_generation_hash: string
      generation_account_id: string | null
      generation_maximum: string | null
      generation_risk_policy_hash: string | null
      generation_strategy_name: string | null
      policy_hash: string
      side: string
      state: string
      strategy_name: string
      updated_at: string
    }>`
      SELECT
        intent.account_id,
        intent.authority_generation_hash,
        intent.policy_hash,
        intent.side,
        intent.state,
        intent.strategy_name,
        generation.account_id AS generation_account_id,
        generation.maximum AS generation_maximum,
        generation.risk_policy_hash AS generation_risk_policy_hash,
        generation.strategy_name AS generation_strategy_name,
        to_char(intent.updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS updated_at
      FROM intents AS intent
      LEFT JOIN authority_generations AS generation
        ON generation.generation_hash = intent.authority_generation_hash
      WHERE intent.intent_id = ${intentId}
      FOR UPDATE OF intent
    `.pipe(Effect.flatMap((rows) => fromDecision(() => decodeIntentSnapshot(operation, rows))))

  const transitionSubmitStart = (input: MutationStartInput) =>
    sql<{ intent_id: string }>`
      UPDATE intents
      SET state = ${IntentState.IoStarted}, state_version = state_version + 1, updated_at = ${input.occurredAt}
      WHERE intent_id = ${input.intentId} AND state = ${IntentState.Approved}
      RETURNING intent_id
    `.pipe(
      Effect.flatMap((rows) =>
        fromDecision(() =>
          Result.flatMap(
            decodeIntentIds('begin-submit', 'submit transition result failed decoding', rows),
            decideSubmitStartWrite,
          ),
        ),
      ),
    )

  const beginTransaction = (operation: MutationOperation, input: MutationStartInput) =>
    Effect.gen(function* () {
      const existing = yield* events.readLatest(input.intentId, operation)
      const replay = yield* fromDecision(() => decideMutationStartReplay(operation, input, existing))
      if (replay._tag === 'ReplayMutation') return replay.receipt

      const authority = yield* readAuthorityBinding(operation, input.closeOnly === true)
      if (operation === MutationOperation.Submit) yield* requireNoOtherUnresolved(input.intentId)
      const intent = yield* readIntent(operation, input.intentId)
      const submitted =
        operation === MutationOperation.Cancel
          ? yield* events.readLatest(input.intentId, MutationOperation.Submit)
          : undefined
      const decision = yield* fromDecision(() => decideMutationStart(operation, input, authority, intent, submitted))
      yield* events.appendEvent(
        startStoreOperationFor(operation),
        decision.event,
        operation === MutationOperation.Submit,
      )
      if (decision.intentTransition === 'ApprovedToIoStarted') yield* transitionSubmitStart(input)
      return { event: decision.event, started: true } satisfies StartReceipt
    })

  const begin = (
    operation: MutationOperation,
    intentId: string,
    requestHash: string,
    consistencyDelayMs: number,
    occurredAt: string,
    brokerOrderId?: string,
    closeOnly?: boolean,
  ) =>
    fromDecision(() =>
      decodeStartInput(operation, {
        intentId,
        requestHash,
        consistencyDelayMs,
        occurredAt,
        ...(brokerOrderId === undefined ? {} : { brokerOrderId }),
        ...(closeOnly === true ? { closeOnly: true as const } : {}),
      }),
    ).pipe(Effect.flatMap((input) => fence.transaction(beginTransaction(operation, input))))

  const authorizeSubmit = (intentId: string, closeOnly = false) =>
    Effect.gen(function* () {
      const authority = yield* readAuthorityBinding(MutationOperation.Submit, closeOnly)
      const intent = yield* readIntent(MutationOperation.Submit, intentId)
      yield* fromDecision(() => decideFinalSubmitAuthorization({ authority, intent, closeOnly }))
    })

  return { authorizeSubmit, begin }
}

export const makeMutationStartPostgres = Pipeable.dual(3, makeMutationStartPostgresDataFirst)
