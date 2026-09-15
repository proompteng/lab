import { PgClient } from '@effect/sql-pg'
import { Effect, Match } from 'effect'

import { Pipeable } from '../../pipeable'
import { CycleState, type CycleCompletionState, type CycleTerminalReason } from '../model'
import {
  decideAcquire,
  decideActivation,
  decideCompletion,
  makeInitialCycle,
  validateCompletionDocument,
  type AcquireDecision,
  type ActivationDecision,
  type CompletionDecision,
} from './decisions'
import {
  liftCycleDecision,
  runCycleStore,
  type CycleAcquireReceipt,
  type CycleMutationReceipt,
  type CycleStoreInternalError,
  type CycleStoreShape,
} from './model'
import type { CycleMutationPrimitives } from './mutations'
import type { CycleQueries } from './queries'
import { decodeBlockInput, decodeCycleDraft, decodeCycleIdInput, decodeFinishInput, decodeObservedAt } from './rows'

export interface CycleLifecyclePrograms {
  readonly acquire: CycleStoreShape['acquire']
  readonly activate: CycleStoreShape['activate']
  readonly finish: CycleStoreShape['finish']
  readonly block: CycleStoreShape['block']
}

const makeCycleLifecycleProgramsDataFirst = (
  sql: PgClient.PgClient,
  queries: CycleQueries,
  mutations: CycleMutationPrimitives,
): CycleLifecyclePrograms => {
  const interpretAcquireDecision = (
    observedAt: string,
    decision: AcquireDecision,
  ): Effect.Effect<CycleAcquireReceipt, CycleStoreInternalError> =>
    Match.value(decision).pipe(
      Match.tagsExhaustive({
        Return: ({ cycle, created }) => Effect.succeed({ cycle, created }),
        Block: ({ cycle, created, reason }) =>
          mutations
            .blockCycle('acquire', cycle, reason, observedAt)
            .pipe(Effect.map((receipt) => ({ cycle: receipt.cycle, created }))),
      }),
    )

  const acquire: CycleStoreShape['acquire'] = (draft, observedAt) =>
    runCycleStore(
      'acquire',
      decodeCycleDraft(draft).pipe(
        Effect.bindTo('draft'),
        Effect.bind('observedAt', () => decodeObservedAt(observedAt)),
        Effect.map(({ draft: decodedDraft, observedAt: decodedTime }) => ({
          draft: decodedDraft,
          observedAt: decodedTime,
          candidate: makeInitialCycle(decodedDraft, decodedTime),
        })),
        Effect.flatMap(({ draft: decodedDraft, observedAt: decodedTime, candidate }) =>
          sql.withTransaction(
            mutations.insertCycle(candidate).pipe(
              Effect.bindTo('inserted'),
              Effect.bind('storedCycleId', () => mutations.lockAuthoritySlot(candidate)),
              Effect.bind('stored', ({ storedCycleId }) => mutations.readLocked('acquire', storedCycleId)),
              Effect.flatMap(({ inserted, stored }) =>
                liftCycleDecision('acquire', decideAcquire(stored, decodedDraft, decodedTime, inserted.length === 1)),
              ),
              Effect.flatMap((decision) => interpretAcquireDecision(decodedTime, decision)),
            ),
          ),
        ),
      ),
    )

  const persistActivation = (
    observedAt: string,
    decision: Extract<ActivationDecision, { readonly _tag: 'Persist' }>,
  ): Effect.Effect<CycleMutationReceipt, CycleStoreInternalError> =>
    sql<Record<string, unknown>>`
      UPDATE autonomous_cycles
      SET
        state = ${CycleState.Active},
        state_version = ${decision.cycle.stateVersion + 1},
        updated_at = ${observedAt}
      WHERE cycle_id = ${decision.cycle.identity.cycleId}
        AND state = ${CycleState.Pending}
        AND state_version = ${decision.cycle.stateVersion}
        AND (
          schema_version = 'bayn.autonomous-cycle.v3'
          OR snapshot_id IS NOT NULL
        )
      RETURNING cycle_id
    `.pipe(
      Effect.flatMap((rows) => mutations.requireApplied('activate', rows)),
      Effect.flatMap(() => mutations.readLocked('activate', decision.cycle.identity.cycleId)),
      Effect.map((cycle) => ({ cycle, changed: true })),
    )

  const interpretActivationDecision = (
    observedAt: string,
    decision: ActivationDecision,
  ): Effect.Effect<CycleMutationReceipt, CycleStoreInternalError> =>
    Match.value(decision).pipe(
      Match.tagsExhaustive({
        Replay: ({ cycle }) => Effect.succeed({ cycle, changed: false }),
        Persist: (persist) => persistActivation(observedAt, persist),
        Block: ({ cycle, reason }) => mutations.blockCycle('activate', cycle, reason, observedAt),
      }),
    )

  const activate: CycleStoreShape['activate'] = (cycleId, observedAt) =>
    runCycleStore(
      'activate',
      decodeCycleIdInput({ cycleId, observedAt }).pipe(
        Effect.flatMap((input) =>
          sql.withTransaction(
            mutations.readLocked('activate', input.cycleId).pipe(
              Effect.flatMap((cycle) => liftCycleDecision('activate', decideActivation(cycle, input.observedAt))),
              Effect.flatMap((decision) => interpretActivationDecision(input.observedAt, decision)),
            ),
          ),
        ),
      ),
    )

  const persistCompletion = (
    observedAt: string,
    decision: Extract<CompletionDecision, { readonly _tag: 'VerifyDecision' }>,
  ): Effect.Effect<CycleMutationReceipt, CycleStoreInternalError> =>
    sql<Record<string, unknown>>`
      UPDATE autonomous_cycles
      SET
        state = ${decision.state},
        state_version = ${decision.cycle.stateVersion + 1},
        updated_at = ${observedAt},
        terminal_at = ${observedAt}
      WHERE cycle_id = ${decision.cycle.identity.cycleId}
        AND state = ${CycleState.Active}
        AND state_version = ${decision.cycle.stateVersion}
        AND decision_hash = ${decision.decisionHash}
      RETURNING cycle_id
    `.pipe(
      Effect.flatMap((rows) => mutations.requireApplied('finish', rows)),
      Effect.flatMap(() => mutations.readLocked('finish', decision.cycle.identity.cycleId)),
      Effect.map((cycle) => ({ cycle, changed: true })),
    )

  const interpretCompletionDecision = (
    observedAt: string,
    decision: CompletionDecision,
  ): Effect.Effect<CycleMutationReceipt, CycleStoreInternalError> =>
    Match.value(decision).pipe(
      Match.tagsExhaustive({
        Replay: ({ cycle }) => Effect.succeed({ cycle, changed: false }),
        VerifyDecision: (verification) =>
          queries.selectDecisionDocuments(verification.cycle.identity.cycleId).pipe(
            Effect.flatMap((documents) => {
              const document = documents[0]
              if (document === undefined || document.mode !== 'PAPER') {
                return liftCycleDecision('finish', validateCompletionDocument(verification, documents))
              }
              return queries
                .executionCompletionEvidenceMatches(document, observedAt)
                .pipe(
                  Effect.flatMap((matches) =>
                    liftCycleDecision('finish', validateCompletionDocument(verification, documents, matches)),
                  ),
                )
            }),
            Effect.andThen(persistCompletion(observedAt, verification)),
          ),
      }),
    )

  const finish = (
    cycleId: string,
    state: CycleCompletionState,
    observedAt: string,
  ): ReturnType<CycleStoreShape['finish']> =>
    runCycleStore(
      'finish',
      decodeFinishInput({ cycleId, state, observedAt }).pipe(
        Effect.flatMap((input) =>
          sql.withTransaction(
            mutations.readLocked('finish', input.cycleId).pipe(
              Effect.flatMap((cycle) =>
                liftCycleDecision('finish', decideCompletion(cycle, input.state, input.observedAt)),
              ),
              Effect.flatMap((decision) => interpretCompletionDecision(input.observedAt, decision)),
            ),
          ),
        ),
      ),
    )

  const block = (
    cycleId: string,
    reason: CycleTerminalReason,
    observedAt: string,
  ): ReturnType<CycleStoreShape['block']> =>
    runCycleStore(
      'block',
      decodeBlockInput({ cycleId, reason, observedAt }).pipe(
        Effect.flatMap((input) =>
          sql.withTransaction(
            mutations
              .readLocked('block', input.cycleId)
              .pipe(Effect.flatMap((cycle) => mutations.blockCycle('block', cycle, input.reason, input.observedAt))),
          ),
        ),
      ),
    )

  return { acquire, activate, finish, block }
}

export const makeCycleLifecyclePrograms = Pipeable.dual(3, makeCycleLifecycleProgramsDataFirst)
