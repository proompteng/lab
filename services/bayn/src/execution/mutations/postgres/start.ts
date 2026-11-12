import { PgClient } from '@effect/sql-pg'
import { Effect, Option, Result } from 'effect'
import type { SqlError } from 'effect/sql/SqlError'

import { MutationOperation } from '../../../broker/alpaca-mutations/model'
import { IntentState } from '../../contracts'
import {
  decideMutationAuthority,
  decideMutationContainment,
  decideFinalSubmitAuthorization,
  decideMutationStart,
  expiredEntryCancellationAdmissionIsCurrent,
  decideMutationStartReplay,
  decideSubmitStartWrite,
  decodeStartInput,
  storeError,
  startStoreOperationFor,
} from '../decisions'
import type { ExpiredEntryCancellationAdmission, MutationStartInput, MutationStoreError, StartReceipt } from '../model'
import {
  decodeAuthoritySnapshot,
  decodeExpiredEntryCancellationFacts,
  decodeIntentIds,
  decodeIntentSnapshot,
  decodeUnresolved,
} from '../rows'
import type { MutationEventPostgres } from './events'
import { fromDecision } from './shared'
import type { WriterFenceError, WriterFenceService } from '../../writer-fence'

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
    expiredEntryCancellation?: ExpiredEntryCancellationAdmission,
  ) => Effect.Effect<StartReceipt, MutationStoreError | SqlError | WriterFenceError>
}

export const makeMutationStartPostgres = (
  sql: PgClient.PgClient,
  fence: WriterFenceService,
  events: MutationEventPostgres,
): MutationStartPostgres => {
  const otherUnresolved = (intentId: string) => sql`
      EXISTS (
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
      )
    `

  const readAuthorityBinding = (operation: MutationOperation, closeOnly = false, admissionIntentId?: string) =>
    sql<{
      effective: string
      generation_hash: string
      generation_account_id: string | null
      generation_maximum: string | null
      kill_state: string
      maximum: string
      unresolved: boolean
    }>`
      SELECT
        authority.maximum,
        authority.effective,
        authority.kill_state,
        authority.generation_hash,
        generation.maximum AS generation_maximum,
        generation.account_id AS generation_account_id,
        ${admissionIntentId === undefined ? sql`false` : otherUnresolved(admissionIntentId)} AS unresolved
      FROM authority_state AS authority
      LEFT JOIN authority_generations AS generation
        ON generation.generation_hash = authority.generation_hash
      WHERE authority.singleton
      FOR UPDATE OF authority
    `.pipe(
      Effect.flatMap((rows) =>
        fromDecision(() =>
          Result.flatMap(
            decodeAuthoritySnapshot(
              operation,
              rows.map(({ unresolved: _unresolved, ...authority }) => authority),
            ),
            (authority) => decideMutationAuthority(operation, authority, closeOnly),
          ),
        ).pipe(
          Effect.tap(() =>
            admissionIntentId === undefined
              ? Effect.void
              : fromDecision(() =>
                  Result.flatMap(
                    decodeUnresolved(rows.map(({ unresolved }) => ({ unresolved }))),
                    decideMutationContainment,
                  ),
                ),
          ),
        ),
      ),
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

  const validateExpiredEntryCancellation = (input: MutationStartInput) =>
    Effect.gen(function* () {
      const admission = input.expiredEntryCancellation
      if (admission === undefined) return
      // The authority and intent row locks are already held. Sample this intent account's commit clock
      // only after those waits: live accounts use wall time and isolated replay accounts include measured
      // work. Caller time and PostgreSQL transaction-start time cannot admit a stale lookup.
      const rows = yield* sql`
        SELECT intent.account_id,
          authority.generation_hash AS authority_generation_hash,
          authority.version::text AS authority_version,
          authority.maximum, authority.effective, authority.kill_state, authority.reason,
          intent.intent_id, intent.authority_generation_hash AS intent_authority_generation_hash,
          intent.client_order_id, intent.side, ${input.brokerOrderId}::text AS broker_order_id,
          to_char(execution_account_commit_now(intent.account_id) AT TIME ZONE 'UTC',
            'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS admitted_at
        FROM authority_state AS authority
        JOIN intents AS intent ON intent.intent_id = ${input.intentId}
        WHERE authority.singleton
      `
      const facts = yield* fromDecision(() => decodeExpiredEntryCancellationFacts(rows))
      if (!expiredEntryCancellationAdmissionIsCurrent(admission, facts))
        return yield* storeError({
          operation: 'begin-cancel',
          failure: 'authority',
          message: 'expired entry cancellation no longer matches its observed authority, parent or freshness boundary',
        })
    })

  const beginTransaction = (operation: MutationOperation, input: MutationStartInput) =>
    Effect.gen(function* () {
      const existing = yield* events.readLatest(input.intentId, operation)
      const replay = yield* fromDecision(() => decideMutationStartReplay(operation, input, existing))
      if (replay._tag === 'ReplayMutation') return replay.receipt

      // The writer lease already excludes other mutation writers. Read containment in the authority-lock query
      // instead of paying another roundtrip inside the approval lifetime; both decisions retain their validation.
      const authority = yield* readAuthorityBinding(
        operation,
        input.closeOnly === true,
        operation === MutationOperation.Submit ? input.intentId : undefined,
      )
      const intent = yield* readIntent(operation, input.intentId)
      const submitted =
        operation === MutationOperation.Cancel
          ? yield* events.readLatest(input.intentId, MutationOperation.Submit)
          : undefined
      const decision = yield* fromDecision(() => decideMutationStart(operation, input, authority, intent, submitted))
      if (input.expiredEntryCancellation !== undefined) {
        if (operation !== MutationOperation.Cancel)
          return yield* storeError({
            operation: startStoreOperationFor(operation),
            failure: 'invariant',
            message: 'expired entry cancellation admission cannot authorize submission',
          })
        yield* validateExpiredEntryCancellation(input)
      }
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
    expiredEntryCancellation?: ExpiredEntryCancellationAdmission,
  ) =>
    fromDecision(() =>
      decodeStartInput(operation, {
        intentId,
        requestHash,
        consistencyDelayMs,
        occurredAt,
        ...(brokerOrderId === undefined ? {} : { brokerOrderId }),
        ...(closeOnly === true ? { closeOnly: true as const } : {}),
        ...(expiredEntryCancellation === undefined ? {} : { expiredEntryCancellation }),
      }),
    ).pipe(
      Effect.flatMap((input) =>
        Effect.gen(function* () {
          if (Option.isSome(yield* Effect.serviceOption(sql.transactionService)))
            return yield* storeError({
              operation: startStoreOperationFor(operation),
              failure: 'invariant',
              message: 'mutation admission must commit independently before broker routing',
            })
          return yield* fence.transaction(beginTransaction(operation, input))
        }),
      ),
    )

  const authorizeSubmit = (intentId: string, closeOnly = false) =>
    Effect.gen(function* () {
      const authority = yield* readAuthorityBinding(MutationOperation.Submit, closeOnly)
      const intent = yield* readIntent(MutationOperation.Submit, intentId)
      yield* fromDecision(() => decideFinalSubmitAuthorization({ authority, intent }))
    })

  return { authorizeSubmit, begin }
}
