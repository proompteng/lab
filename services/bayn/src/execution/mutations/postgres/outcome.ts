import { PgClient } from '@effect/sql-pg'
import { Effect, Result } from 'effect'
import type { SqlError } from 'effect/unstable/sql/SqlError'

import { MutationOperation, type PartialMutationEvidence } from '../../../broker/alpaca-mutations'
import { IntentState } from '../../contracts'
import {
  decideAcknowledgedRecovery,
  decideCancelFirst,
  decideCancelRecoveryState,
  decideMutationOutcome,
  decideMutationOutcomeDefinition,
  decideMutationOutcomeWrite,
  decideRecoveredOutcomeWrite,
  decideSubmitRecoveryWrite,
  decodeOutcomeInput,
  outcomeStoreOperation,
} from '../decisions'
import type {
  MutationEvent,
  MutationIntentTransition,
  MutationOutcomeDefinition,
  MutationOutcomeInput,
  MutationStoreError,
  OutcomeStoreOperation,
} from '../model'
import { decodeAcknowledged, decodeIntentIds, decodeOutcomeIntentSnapshot } from '../rows'
import type { MutationEventPostgres } from './events'
import { fromDecision } from './shared'
import type { WriterFenceError, WriterFenceService } from '../../writer-fence'
import { Pipeable } from '../../../pipeable'

export interface MutationOutcomePostgres {
  readonly appendOutcome: (
    definition: MutationOutcomeDefinition,
    intentId: string,
    requestHash: string,
    occurredAt: string,
    evidence?: PartialMutationEvidence,
    brokerOrderId?: string,
  ) => Effect.Effect<MutationEvent, MutationStoreError | SqlError | WriterFenceError>
}

const makeMutationOutcomePostgresDataFirst = (
  sql: PgClient.PgClient,
  fence: WriterFenceService,
  events: MutationEventPostgres,
): MutationOutcomePostgres => {
  const readOutcomeIntentSnapshot = (operation: OutcomeStoreOperation, intentId: string) =>
    sql<{ state: string; terminal_outcome: string | null }>`
      SELECT state, terminal_outcome
      FROM intents
      WHERE intent_id = ${intentId}
      FOR UPDATE
    `.pipe(Effect.flatMap((rows) => fromDecision(() => decodeOutcomeIntentSnapshot(operation, rows))))

  const transitionFromIoStarted = (
    operation: OutcomeStoreOperation,
    input: MutationOutcomeInput,
    transition: Extract<MutationIntentTransition, { readonly _tag: 'TransitionFromIoStarted' }>,
  ) =>
    sql<{ intent_id: string }>`
      UPDATE intents
      SET
        state = ${transition.nextState},
        terminal_outcome = ${transition.terminalOutcome ?? null},
        state_version = state_version + 1,
        updated_at = GREATEST(${input.occurredAt}::timestamptz, updated_at + interval '1 microsecond')
      WHERE intent_id = ${input.intentId} AND state = ${IntentState.IoStarted}
      RETURNING intent_id
    `.pipe(
      Effect.flatMap((rows) =>
        fromDecision(() =>
          Result.flatMap(
            decodeIntentIds(operation, 'mutation outcome transition result failed decoding', rows),
            (intentIds) => decideMutationOutcomeWrite(operation, intentIds),
          ),
        ),
      ),
    )

  const recoverUnknownSubmit = (operation: OutcomeStoreOperation, input: MutationOutcomeInput) =>
    sql<{ intent_id: string }>`
      UPDATE intents
      SET state = ${IntentState.Recovered}, state_version = state_version + 1, updated_at = ${input.occurredAt}
      WHERE intent_id = ${input.intentId} AND state = ${IntentState.Unknown}
      RETURNING intent_id
    `.pipe(
      Effect.flatMap((rows) =>
        fromDecision(() => decodeIntentIds(operation, 'submit recovery result failed decoding', rows)),
      ),
    )

  const transitionRecoveredSubmit = (
    operation: OutcomeStoreOperation,
    input: MutationOutcomeInput,
    transition: Extract<MutationIntentTransition, { readonly _tag: 'RecoverSubmit' }>,
  ) =>
    sql<{ intent_id: string }>`
      UPDATE intents
      SET
        state = ${transition.nextState},
        terminal_outcome = ${transition.terminalOutcome ?? null},
        state_version = state_version + 1,
        updated_at = GREATEST(
          ${input.occurredAt}::timestamptz + interval '1 microsecond',
          updated_at + interval '1 microsecond'
      )
      WHERE intent_id = ${input.intentId} AND state = ${IntentState.Recovered}
      RETURNING intent_id
    `.pipe(
      Effect.flatMap((rows) =>
        fromDecision(() =>
          Result.flatMap(
            decodeIntentIds(operation, 'recovered submit transition result failed decoding', rows),
            (intentIds) => decideRecoveredOutcomeWrite(operation, intentIds, false),
          ),
        ),
      ),
    )

  const transitionAcknowledgedSubmit = (
    operation: OutcomeStoreOperation,
    input: MutationOutcomeInput,
    transition: Extract<MutationIntentTransition, { readonly _tag: 'RecoverSubmit' }>,
  ) =>
    sql<{ intent_id: string }>`
      UPDATE intents
      SET
        state = ${IntentState.Terminal},
        terminal_outcome = ${transition.terminalOutcome ?? null},
        state_version = state_version + 1,
        updated_at = GREATEST(
          ${input.occurredAt}::timestamptz,
          updated_at + interval '1 microsecond'
        )
      WHERE intent_id = ${input.intentId} AND state = ${IntentState.Acknowledged}
      RETURNING intent_id
    `.pipe(
      Effect.flatMap((rows) =>
        fromDecision(() =>
          Result.flatMap(
            decodeIntentIds(operation, 'acknowledged submit transition result failed decoding', rows),
            (intentIds) => decideRecoveredOutcomeWrite(operation, intentIds, true),
          ),
        ),
      ),
    )

  const verifyAcknowledgedSubmit = (operation: OutcomeStoreOperation, intentId: string) =>
    sql<{ acknowledged: boolean }>`
      SELECT EXISTS (
        SELECT 1
        FROM intents
        WHERE intent_id = ${intentId} AND state = ${IntentState.Acknowledged}
      ) AS acknowledged
    `.pipe(
      Effect.flatMap((rows) =>
        fromDecision(() =>
          Result.flatMap(decodeAcknowledged(operation, rows), (acknowledged) =>
            decideAcknowledgedRecovery(operation, acknowledged),
          ),
        ),
      ),
    )

  const applySubmitRecovery = (
    operation: OutcomeStoreOperation,
    input: MutationOutcomeInput,
    transition: Extract<MutationIntentTransition, { readonly _tag: 'RecoverSubmit' }>,
  ) =>
    Effect.gen(function* () {
      const recoveredIntentIds = yield* recoverUnknownSubmit(operation, input)
      const decision = yield* fromDecision(() => decideSubmitRecoveryWrite(operation, recoveredIntentIds, transition))
      switch (decision._tag) {
        case 'TransitionRecoveredIntent':
          return yield* transitionRecoveredSubmit(operation, input, transition)
        case 'TransitionAcknowledgedTerminalIntent':
          return yield* transitionAcknowledgedSubmit(operation, input, transition)
        case 'VerifyAcknowledgedIntent':
          return yield* verifyAcknowledgedSubmit(operation, input.intentId)
      }
    })

  const recoverUnknownCancel = (operation: OutcomeStoreOperation, input: MutationOutcomeInput) =>
    sql<{ intent_id: string }>`
      UPDATE intents
      SET
        state = ${IntentState.Recovered},
        state_version = state_version + 1,
        updated_at = GREATEST(${input.occurredAt}::timestamptz, updated_at + interval '1 microsecond')
      WHERE intent_id = ${input.intentId} AND state = ${IntentState.Unknown}
      RETURNING intent_id
    `.pipe(
      Effect.flatMap((rows) =>
        fromDecision(() => decodeIntentIds(operation, 'cancel recovery result failed decoding', rows)),
      ),
    )

  const applyCancelRecovery = (
    operation: OutcomeStoreOperation,
    input: MutationOutcomeInput,
    transition: Extract<MutationIntentTransition, { readonly _tag: 'RecoverCancelTerminal' }>,
  ) =>
    Effect.gen(function* () {
      const recoveredIntentIds = yield* recoverUnknownCancel(operation, input)
      const fromState = yield* fromDecision(() => decideCancelRecoveryState(operation, recoveredIntentIds))
      const transitioned = yield* sql<{ intent_id: string }>`
        UPDATE intents
        SET
          state = ${IntentState.Terminal},
          terminal_outcome = ${transition.terminalOutcome},
          state_version = state_version + 1,
          updated_at = GREATEST(${input.occurredAt}::timestamptz, updated_at + interval '1 microsecond')
        WHERE intent_id = ${input.intentId} AND state = ${fromState}
        RETURNING intent_id
      `
      return yield* fromDecision(() =>
        Result.flatMap(
          decodeIntentIds(operation, 'cancel terminal transition result failed decoding', transitioned),
          (intentIds) => decideMutationOutcomeWrite(operation, intentIds),
        ),
      )
    })

  const applyOutcomeTransition = (
    operation: OutcomeStoreOperation,
    input: MutationOutcomeInput,
    transition: MutationIntentTransition,
  ) => {
    switch (transition._tag) {
      case 'KeepIntentState':
        return Effect.void
      case 'TransitionFromIoStarted':
        return transitionFromIoStarted(operation, input, transition)
      case 'RecoverSubmit':
        return applySubmitRecovery(operation, input, transition)
      case 'RecoverCancelTerminal':
        return applyCancelRecovery(operation, input, transition)
    }
  }

  const outcomeTransaction = (
    operation: OutcomeStoreOperation,
    input: MutationOutcomeInput,
    definition: MutationOutcomeDefinition,
  ) => {
    const facts = decideMutationOutcomeDefinition(definition)
    return Effect.gen(function* () {
      const previous = yield* events.readLatest(input.intentId, facts.operation)
      const currentIntent = yield* readOutcomeIntentSnapshot(operation, input.intentId)
      const decision = yield* fromDecision(() => decideMutationOutcome(input, definition, previous, currentIntent))
      if (decision._tag === 'ReplayMutation') return decision.event

      if (decision.cancelFirst._tag === 'RequireNoDurableCancellation') {
        const cancellation = yield* events.readLatest(input.intentId, MutationOperation.Cancel)
        yield* fromDecision(() => decideCancelFirst(decision.cancelFirst, cancellation))
      }
      yield* events.appendEvent(operation, decision.event)
      yield* applyOutcomeTransition(operation, input, decision.transition)
      return decision.event
    })
  }

  const appendOutcome = (
    definition: MutationOutcomeDefinition,
    intentId: string,
    requestHash: string,
    occurredAt: string,
    evidence?: PartialMutationEvidence,
    brokerOrderId?: string,
  ) => {
    const operation = outcomeStoreOperation(definition)
    return fromDecision(() =>
      Result.map(
        decodeOutcomeInput(operation, {
          intentId,
          requestHash,
          occurredAt,
          ...(evidence === undefined ? {} : { evidence }),
          ...(brokerOrderId === undefined ? {} : { brokerOrderId }),
        }),
        (input) => ({ definition, input }),
      ),
    ).pipe(
      Effect.flatMap(({ definition, input }) => fence.transaction(outcomeTransaction(operation, input, definition))),
    )
  }

  return { appendOutcome }
}

export const makeMutationOutcomePostgres = Pipeable.dual(3, makeMutationOutcomePostgresDataFirst)
