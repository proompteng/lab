import type { SimulatedSnapshotReference } from '../../market-data/streaming/simulation-service'
import type { StreamingVerifiedSnapshotReference } from '../../market-data/streaming/reference'
import { PgClient } from '@effect/sql-pg'
import { Effect, Match } from 'effect'
import { legacyExecutionAuthorityToken } from '../../execution/legacy-wire'

import type { CycleDecisionDocument } from '../../shadow-decision-contract'
import { CycleState } from '../model'
import { decideDecisionBinding, type DecisionBindingDecision } from './decisions'
import {
  failCycleStore,
  liftCycleDecision,
  runCycleStore,
  type CycleMutationReceipt,
  type CycleDecisionBindingEvidence,
  type CycleStoreInternalError,
  type CycleStoreShape,
} from './model'
import type { CycleMutationPrimitives } from './mutations'
import type { CycleQueries } from './queries'
import { decodeDecisionInput } from './rows'

export interface CycleBindingPrograms {
  readonly bindDecision: CycleStoreShape['bindDecision']
}

export const makeCycleBindingPrograms = (
  sql: PgClient.PgClient,
  queries: CycleQueries,
  mutations: CycleMutationPrimitives,
): CycleBindingPrograms => {
  const persistIntradaySnapshotReference = (
    reference: StreamingVerifiedSnapshotReference | SimulatedSnapshotReference,
  ): Effect.Effect<void, CycleStoreInternalError> =>
    Effect.gen(function* () {
      const manifest = reference.manifest
      const table =
        reference.schemaVersion === 'bayn.simulated-snapshot-reference.v2'
          ? 'simulated_snapshot_references'
          : 'streaming_snapshot_references'
      yield* sql`
        INSERT INTO ${sql(table)} (
          snapshot_id, schema_version, content_hash, observed_at, manifest
        ) VALUES (
          ${manifest.snapshotId}, ${reference.schemaVersion}, ${manifest.contentHash},
          ${manifest.observedAt}::timestamptz, ${sql.json(manifest)}
        )
        ON CONFLICT (snapshot_id) DO NOTHING
      `
      const [match] = yield* sql<{ matches: boolean }>`
        SELECT EXISTS (
          SELECT 1
          FROM ${sql(table)} AS reference
          WHERE reference.snapshot_id = ${manifest.snapshotId}
            AND reference.schema_version = ${reference.schemaVersion}
            AND reference.content_hash = ${manifest.contentHash}
            AND reference.observed_at = ${manifest.observedAt}::timestamptz
            AND reference.manifest = ${sql.json(manifest)}
        ) AS matches
      `
      if (match?.matches !== true) {
        return yield* failCycleStore(
          'bind-decision',
          'conflict',
          'stored intraday snapshot reference diverged from the verified market manifest',
        )
      }
    })

  const persistDecisionEvidence = (
    evidence: CycleDecisionBindingEvidence | undefined,
  ): Effect.Effect<void, CycleStoreInternalError> =>
    Effect.forEach(
      [...(evidence?.streamingSnapshotReferences ?? []), ...(evidence?.simulatedSnapshotReferences ?? [])],
      persistIntradaySnapshotReference,
      {
        concurrency: 1,
        discard: true,
      },
    )

  const requireDecisionEvidence = (document: CycleDecisionDocument): Effect.Effect<void, CycleStoreInternalError> =>
    queries.decisionEvidenceMismatch(document).pipe(
      Effect.flatMap((mismatch) =>
        mismatch === null
          ? Effect.void
          : Effect.logWarning('Bayn decision evidence rejected').pipe(
              Effect.annotateLogs({
                schemaVersion: 'bayn.decision-evidence-rejection.v1',
                mismatch,
                cycleId: document.bindings.cycleId,
                snapshotId: document.bindings.snapshotId,
                reconciliationId: document.bindings.reconciliationId,
                plannedIntentCount: document.targetPlan.intentTargets.length,
                riskEvaluationCount: document.deltaRisk.length,
                riskContextBound:
                  document.mode === legacyExecutionAuthorityToken && document.bindings.riskContext !== undefined,
                firstRiskStatePresent:
                  document.mode === legacyExecutionAuthorityToken && document.deltaRisk[0]?.facts?.state !== undefined,
              }),
              Effect.andThen(
                failCycleStore(
                  'bind-decision',
                  'invariant',
                  `decision does not match its durable market-data and exact reconciliation evidence [${mismatch}]`,
                ),
              ),
            ),
      ),
    )

  const persistDecisionBinding = (
    observedAt: string,
    decision: Extract<DecisionBindingDecision, { readonly _tag: 'Persist' }>,
  ): Effect.Effect<CycleMutationReceipt, CycleStoreInternalError> =>
    sql`
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
    `.pipe(
      Effect.andThen(sql<Record<string, unknown>>`
        UPDATE autonomous_cycles
        SET
          snapshot_id = ${decision.document.bindings.snapshotId},
          decision_hash = ${decision.document.contentHash},
          state_version = ${decision.cycle.stateVersion + 1},
          updated_at = ${observedAt}
        WHERE cycle_id = ${decision.cycle.identity.cycleId}
          AND state = ${CycleState.Active}
          AND state_version = ${decision.cycle.stateVersion}
          AND decision_hash IS NULL
          AND (
            snapshot_id = ${decision.document.bindings.snapshotId}
            OR (
              schema_version IN ('bayn.autonomous-cycle.v3', 'bayn.autonomous-cycle.v4')
              AND snapshot_id IS NULL
            )
          )
        RETURNING cycle_id
      `),
      Effect.flatMap((rows) => mutations.requireApplied('bind-decision', rows)),
      Effect.flatMap(() => mutations.readLocked('bind-decision', decision.cycle.identity.cycleId)),
      Effect.map((cycle) => ({ cycle, changed: true })),
    )

  const interpretDecisionBinding = (
    observedAt: string,
    decision: DecisionBindingDecision,
    document: CycleDecisionDocument,
    evidence: CycleDecisionBindingEvidence | undefined,
  ): Effect.Effect<CycleMutationReceipt, CycleStoreInternalError> =>
    Match.value(decision).pipe(
      Match.tagsExhaustive({
        Replay: ({ cycle }) =>
          persistDecisionEvidence(evidence).pipe(
            Effect.andThen(requireDecisionEvidence(document)),
            Effect.as({ cycle, changed: false }),
          ),
        Persist: (persist) =>
          persistDecisionEvidence(evidence).pipe(
            Effect.andThen(requireDecisionEvidence(document)),
            Effect.andThen(persistDecisionBinding(observedAt, persist)),
          ),
        Block: ({ cycle, reason }) => mutations.blockCycle('bind-decision', cycle, reason, observedAt),
      }),
    )

  const bindDecision: CycleStoreShape['bindDecision'] = (
    cycleId: string,
    document: CycleDecisionDocument,
    observedAt: string,
    evidence?: CycleDecisionBindingEvidence,
  ) =>
    runCycleStore(
      'bind-decision',
      decodeDecisionInput({ cycleId, document, observedAt }).pipe(
        Effect.tap((input) => queries.retainValidatedDecision(input.document)),
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
              Effect.flatMap((decision) =>
                interpretDecisionBinding(input.observedAt, decision, input.document, evidence),
              ),
            ),
          ),
        ),
      ),
    )

  return { bindDecision }
}
