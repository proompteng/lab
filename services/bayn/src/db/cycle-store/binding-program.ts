import { PgClient } from '@effect/sql-pg'
import { Effect, Match } from 'effect'

import { CycleState } from '../../cycle'
import { decodeInputManifestArtifact } from '../../evidence-contracts'
import type { ObserveShadowDecisionDocument } from '../../shadow-decision-contract'
import type { InputManifest } from '../../types'
import {
  ensureSnapshotReference,
  renderSnapshotReferenceIssue,
  snapshotReferenceIssueTags,
} from '../snapshot-reference'
import {
  decideDecisionBinding,
  decideSnapshotBinding,
  type DecisionBindingDecision,
  type SnapshotDecision,
} from './decisions'
import {
  cycleStoreError,
  failCycleStore,
  liftCycleDecision,
  runCycleStore,
  type CycleMutationReceipt,
  type CycleStoreInternalError,
  type CycleStoreShape,
} from './model'
import type { CycleMutationPrimitives } from './mutations'
import type { CycleQueries } from './queries'
import { decodeDecisionInput, decodeSnapshotInput } from './rows'

export interface CycleBindingPrograms {
  readonly bindSnapshot: CycleStoreShape['bindSnapshot']
  readonly bindDecision: CycleStoreShape['bindDecision']
}

export const makeCycleBindingPrograms = (
  sql: PgClient.PgClient,
  queries: CycleQueries,
  mutations: CycleMutationPrimitives,
): CycleBindingPrograms => {
  const persistSnapshotReference = (inputManifest: InputManifest): Effect.Effect<void, CycleStoreInternalError> =>
    ensureSnapshotReference(sql, inputManifest).pipe(
      Effect.catchTag(snapshotReferenceIssueTags, (cause) =>
        Effect.fail(
          cycleStoreError(
            'bind-snapshot',
            'conflict',
            `stored snapshot reference diverged from the finalized Signal publication: ${renderSnapshotReferenceIssue(cause)}`,
            cause,
          ),
        ),
      ),
    )

  const persistSnapshot = (
    manifest: InputManifest,
    observedAt: string,
    decision: Extract<SnapshotDecision, { readonly _tag: 'Persist' }>,
  ): Effect.Effect<CycleMutationReceipt, CycleStoreInternalError> =>
    persistSnapshotReference(manifest).pipe(
      Effect.andThen(sql<Record<string, unknown>>`
        UPDATE autonomous_cycles
        SET
          snapshot_id = ${decision.snapshotId},
          state_version = ${decision.cycle.stateVersion + 1},
          updated_at = ${observedAt}
        WHERE cycle_id = ${decision.cycle.identity.cycleId}
          AND state = ${CycleState.Pending}
          AND state_version = ${decision.cycle.stateVersion}
          AND snapshot_id IS NULL
        RETURNING cycle_id
      `),
      Effect.flatMap((rows) => mutations.requireApplied('bind-snapshot', rows)),
      Effect.flatMap(() => mutations.readLocked('bind-snapshot', decision.cycle.identity.cycleId)),
      Effect.map((cycle) => ({ cycle, changed: true })),
    )

  const interpretSnapshotDecision = (
    manifest: InputManifest,
    observedAt: string,
    decision: SnapshotDecision,
  ): Effect.Effect<CycleMutationReceipt, CycleStoreInternalError> =>
    Match.value(decision).pipe(
      Match.tagsExhaustive({
        Replay: ({ cycle }) => persistSnapshotReference(manifest).pipe(Effect.as({ cycle, changed: false })),
        Persist: (persist) => persistSnapshot(manifest, observedAt, persist),
        Block: ({ cycle, reason }) => mutations.blockCycle('bind-snapshot', cycle, reason, observedAt),
      }),
    )

  const bindSnapshot: CycleStoreShape['bindSnapshot'] = (cycleId, inputManifest, observedAt) =>
    runCycleStore(
      'bind-snapshot',
      decodeSnapshotInput({ cycleId, observedAt }).pipe(
        Effect.bindTo('input'),
        Effect.bind('manifest', () => decodeInputManifestArtifact(inputManifest)),
        Effect.flatMap(({ input, manifest }) =>
          sql.withTransaction(
            mutations.readLocked('bind-snapshot', input.cycleId).pipe(
              Effect.flatMap((cycle) =>
                liftCycleDecision(
                  'bind-snapshot',
                  decideSnapshotBinding(cycle, manifest.finalizedSnapshot, input.observedAt),
                ),
              ),
              Effect.flatMap((decision) => interpretSnapshotDecision(manifest, input.observedAt, decision)),
            ),
          ),
        ),
      ),
    )

  const persistDecisionBinding = (
    observedAt: string,
    decision: Extract<DecisionBindingDecision, { readonly _tag: 'Persist' }>,
  ): Effect.Effect<CycleMutationReceipt, CycleStoreInternalError> =>
    queries.decisionEvidenceMatches(decision.document).pipe(
      Effect.flatMap((matches) =>
        matches
          ? Effect.void
          : failCycleStore(
              'bind-decision',
              'invariant',
              'shadow decision does not match the durable snapshot and exact reconciliation evidence',
            ),
      ),
      Effect.andThen(sql`
        INSERT INTO autonomous_cycle_shadow_decisions (
          cycle_id,
          schema_version,
          document,
          created_at
        ) VALUES (
          ${decision.cycle.identity.cycleId},
          ${decision.document.schemaVersion},
          ${sql.json(decision.document)},
          ${decision.document.createdAt}
        )
      `),
      Effect.andThen(sql<Record<string, unknown>>`
        UPDATE autonomous_cycles
        SET
          decision_hash = ${decision.document.contentHash},
          state_version = ${decision.cycle.stateVersion + 1},
          updated_at = ${observedAt}
        WHERE cycle_id = ${decision.cycle.identity.cycleId}
          AND state = ${CycleState.Active}
          AND state_version = ${decision.cycle.stateVersion}
          AND decision_hash IS NULL
        RETURNING cycle_id
      `),
      Effect.flatMap((rows) => mutations.requireApplied('bind-decision', rows)),
      Effect.flatMap(() => mutations.readLocked('bind-decision', decision.cycle.identity.cycleId)),
      Effect.map((cycle) => ({ cycle, changed: true })),
    )

  const interpretDecisionBinding = (
    observedAt: string,
    decision: DecisionBindingDecision,
  ): Effect.Effect<CycleMutationReceipt, CycleStoreInternalError> =>
    Match.value(decision).pipe(
      Match.tagsExhaustive({
        Replay: ({ cycle }) => Effect.succeed({ cycle, changed: false }),
        Persist: (persist) => persistDecisionBinding(observedAt, persist),
        Block: ({ cycle, reason }) => mutations.blockCycle('bind-decision', cycle, reason, observedAt),
      }),
    )

  const bindDecision: CycleStoreShape['bindDecision'] = (
    cycleId: string,
    document: ObserveShadowDecisionDocument,
    observedAt: string,
  ) =>
    runCycleStore(
      'bind-decision',
      decodeDecisionInput({ cycleId, document, observedAt }).pipe(
        Effect.flatMap((input) =>
          sql.withTransaction(
            mutations.readLocked('bind-decision', input.cycleId).pipe(
              Effect.bindTo('cycle'),
              Effect.bind('documents', ({ cycle }) =>
                cycle.bindings.decisionHash === undefined
                  ? Effect.succeed([])
                  : queries.selectDecisionDocuments(input.cycleId),
              ),
              Effect.flatMap(({ cycle, documents }) =>
                liftCycleDecision(
                  'bind-decision',
                  decideDecisionBinding(cycle, input.document, input.observedAt, documents),
                ),
              ),
              Effect.flatMap((decision) => interpretDecisionBinding(input.observedAt, decision)),
            ),
          ),
        ),
      ),
    )

  return { bindSnapshot, bindDecision }
}
