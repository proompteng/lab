import { PgClient } from '@effect/sql-pg'
import { Effect } from 'effect'

import { WriterFence } from '../../execution/writer-fence'
import {
  Authority,
  decodePaperAuthorityProofBinding,
  type AuthorityState,
  type PaperAuthorityGeneration,
  type PaperAuthorityProofBinding,
} from '../../paper'
import {
  bindPaperGenerationRuntime,
  decidePaperActivation,
  derivePaperAuthorityGeneration,
  paperActivationEffectiveAuthority,
  validateDerivedPaperGeneration,
  validateLatestExactReconciliation,
  validateMutationCoverage,
  validatePaperGenerationEvidence,
  validatePaperGenerationFreshness,
  validatePaperGenerationReplay,
  validatePaperPrepareGeneration,
  validatePaperSourceAuthority,
  type DerivedPaperGeneration,
  type ExactReconciliationFacts,
  type PaperActivationDecision,
  type PaperGenerationEvidenceFacts,
  type PaperGenerationRuntimeBinding,
} from '../paper-authority-algebra'
import { authorityStateFromRow, paperGenerationFromRow, type AuthorityPostgres } from './authority-shared'
import type { PaperStoreError, PaperStoreRuntimeConfig } from './contract'
import { failPaperStore, liftAuthorityDecision, runPaperOperation } from './errors'
import {
  decodeActivationEvidenceRows,
  decodeActivationReconciliationRows,
  decodeAuthorityStateRows,
  decodeMutationBaseline,
  type ActivationEvidenceRow,
  type ActivationReconciliationRow,
} from './rows'

export interface PaperAuthorityInterpreter {
  readonly preparePaperGeneration: (
    proof: PaperAuthorityProofBinding,
  ) => Effect.Effect<PaperAuthorityGeneration, PaperStoreError, WriterFence>
  readonly activatePaperGeneration: (
    proof: PaperAuthorityProofBinding,
  ) => Effect.Effect<AuthorityState, PaperStoreError, WriterFence>
}

export const makePaperAuthorityInterpreter = (
  sql: PgClient.PgClient,
  authority: AuthorityPostgres,
  config: PaperStoreRuntimeConfig,
): PaperAuthorityInterpreter => {
  const requirePaperGenerationRuntime = (
    expectedMaximum: Authority,
    operation: 'PREPARE' | 'activation',
  ): Effect.Effect<PaperGenerationRuntimeBinding, PaperStoreError> =>
    liftAuthorityDecision(
      bindPaperGenerationRuntime(
        {
          maximumAuthority: config.maximumAuthority,
          alpaca:
            config.alpaca === undefined
              ? undefined
              : {
                  accountId: config.alpaca.expectedAccountId,
                  authorityGenerationHash: config.alpaca.authorityGenerationHash,
                },
          qualificationRunId: config.qualificationRunId,
        },
        expectedMaximum,
        operation,
      ),
    )

  const evidenceFacts = (row: ActivationEvidenceRow): PaperGenerationEvidenceFacts => ({
    lock: row.lock_payload,
    result: row.result_payload,
    runStatus: row.run_status,
    expectedArtifactCount: row.expected_artifact_count,
    expectedEventCount: row.expected_event_count,
    expectedGateCount: row.expected_gate_count,
    artifactCount: row.artifact_count,
    eventCount: row.event_count,
    gateCount: row.gate_count,
    statusCount: row.status_count,
    writingStatusCount: row.writing_status_count,
    completeStatusCount: row.complete_status_count,
    writingDetail: row.writing_detail,
    completeDetail: row.complete_detail,
    protocolSchemaVersion: row.protocol_schema_version,
    strategyName: row.strategy_name,
    behaviorHash: row.behavior_hash,
    parameterHash: row.parameter_hash,
    parameters: row.parameters,
  })

  const readPaperGenerationEvidence = (binding: PaperGenerationRuntimeBinding) =>
    sql`
      LOCK TABLE
        evaluation_artifacts,
        evaluation_events,
        gate_outcomes,
        status_history
      IN SHARE MODE
    `.pipe(
      Effect.andThen(
        sql<Record<string, unknown>>`
          SELECT
            lock.payload AS lock_payload,
            result.payload AS result_payload,
            run.status AS run_status,
            run.expected_artifact_count,
            run.expected_event_count,
            run.expected_gate_count,
            (
              SELECT count(*)::integer
              FROM evaluation_artifacts
              WHERE run_id = run.run_id
            ) AS artifact_count,
            (
              SELECT count(*)::integer
              FROM evaluation_events
              WHERE run_id = run.run_id
            ) AS event_count,
            (
              SELECT count(*)::integer
              FROM gate_outcomes
              WHERE run_id = run.run_id
            ) AS gate_count,
            (
              SELECT count(*)::integer
              FROM status_history
              WHERE run_id = run.run_id
            ) AS status_count,
            (
              SELECT count(*)::integer
              FROM status_history
              WHERE run_id = run.run_id AND status = 'WRITING'
            ) AS writing_status_count,
            (
              SELECT count(*)::integer
              FROM status_history
              WHERE run_id = run.run_id AND status = 'COMPLETE'
            ) AS complete_status_count,
            (
              SELECT detail
              FROM status_history
              WHERE run_id = run.run_id AND status = 'WRITING'
            ) AS writing_detail,
            (
              SELECT detail
              FROM status_history
              WHERE run_id = run.run_id AND status = 'COMPLETE'
            ) AS complete_detail,
            protocol.schema_version AS protocol_schema_version,
            protocol.strategy_name,
            protocol.behavior_hash,
            protocol.parameter_hash,
            protocol.parameters
          FROM qualification_results AS result
          JOIN qualification_locks AS lock
            ON lock.lock_id = result.lock_id
            AND lock.candidate_run_id = result.run_id
          JOIN evaluation_runs AS run
            ON run.run_id = result.run_id
            AND run.protocol_hash = lock.protocol_hash
            AND run.snapshot_id = lock.snapshot_id
            AND run.source_revision = lock.source_revision
            AND run.image_repository = lock.image_repository
            AND run.image_digest = lock.image_digest
          JOIN protocol_locks AS protocol
            ON protocol.protocol_hash = run.protocol_hash
            AND protocol.strategy_name = run.strategy_name
          WHERE result.run_id = ${binding.qualificationRunId}
          FOR SHARE OF result, lock, run, protocol
        `.pipe(Effect.flatMap(decodeActivationEvidenceRows)),
      ),
      Effect.map((rows) => (rows[0] === undefined ? undefined : evidenceFacts(rows[0]))),
      Effect.flatMap((evidence) =>
        liftAuthorityDecision(validatePaperGenerationEvidence(evidence, binding, config.build)),
      ),
    )

  const reconciliationFacts = (row: ActivationReconciliationRow): ExactReconciliationFacts => ({
    reconciliationId: row.reconciliation_id,
    accountId: row.account_id,
    contentHash: row.content_hash,
    status: row.status,
    reconciledAt: row.reconciled_at,
  })

  const readLatestExactReconciliation = (binding: PaperGenerationRuntimeBinding) =>
    sql<Record<string, unknown>>`
      SELECT
        reconciliation_id, account_id, content_hash, status, reconciled_at
      FROM reconciliations
      WHERE account_id = ${binding.accountId}
      ORDER BY reconciled_at DESC, reconciliation_id DESC
      LIMIT 1
      FOR SHARE
    `.pipe(
      Effect.flatMap(decodeActivationReconciliationRows),
      Effect.map((rows) => (rows[0] === undefined ? undefined : reconciliationFacts(rows[0]))),
      Effect.flatMap((reconciliation) =>
        liftAuthorityDecision(validateLatestExactReconciliation(reconciliation, binding.accountId)),
      ),
    )

  const verifyMutationCoverage = (binding: PaperGenerationRuntimeBinding, reconciliation: ExactReconciliationFacts) =>
    sql<Record<string, unknown>>`
      WITH latest AS (
        SELECT DISTINCT ON (event.mutation_id)
          event.operation,
          event.event_type,
          event.occurred_at,
          intent.state
        FROM mutation_events AS event
        JOIN intents AS intent ON intent.intent_id = event.intent_id
        WHERE intent.account_id = ${binding.accountId}
        ORDER BY event.mutation_id, event.sequence DESC
      )
      SELECT
        count(*) FILTER (
          WHERE latest.state <> 'TERMINAL'
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
          )::integer AS unresolved_count,
        max(latest.occurred_at) AS latest_mutation_at
      FROM latest
    `.pipe(
      Effect.flatMap(decodeMutationBaseline),
      Effect.flatMap(([baseline]) =>
        liftAuthorityDecision(
          validateMutationCoverage(
            {
              unresolvedCount: baseline.unresolved_count,
              latestMutationAt: baseline.latest_mutation_at,
            },
            reconciliation,
          ),
        ),
      ),
    )

  const derivePaperGeneration = (
    proof: PaperAuthorityProofBinding,
    binding: PaperGenerationRuntimeBinding,
    current: AuthorityState,
  ) =>
    Effect.gen(function* () {
      yield* liftAuthorityDecision(validatePaperSourceAuthority(current))
      const evidence = yield* readPaperGenerationEvidence(binding)
      const reconciliation = yield* readLatestExactReconciliation(binding)
      yield* verifyMutationCoverage(binding, reconciliation)
      return yield* liftAuthorityDecision(
        derivePaperAuthorityGeneration({
          current,
          proof,
          binding,
          evidence,
          reconciliation,
          build: config.build,
        }),
      )
    })

  const requireFreshPaperGeneration = (derived: DerivedPaperGeneration) =>
    authority.nextAuthorityInstant.pipe(
      Effect.flatMap((observedAt) =>
        liftAuthorityDecision(
          validatePaperGenerationFreshness(derived.reconciliation, observedAt, config.reconciliationStaleThresholdMs),
        ),
      ),
    )

  const preparePaperGenerationTransaction = (
    proof: PaperAuthorityProofBinding,
    binding: PaperGenerationRuntimeBinding,
  ) =>
    Effect.gen(function* () {
      const locked = yield* authority.lockPaperAuthority(binding.accountId)
      yield* liftAuthorityDecision(validatePaperPrepareGeneration(locked.current, binding))
      const derived = yield* derivePaperGeneration(proof, binding, locked.current)
      yield* requireFreshPaperGeneration(derived)
      return derived.generation
    })

  const preparePaperGeneration = (candidate: PaperAuthorityProofBinding) =>
    runPaperOperation(
      'authority',
      Effect.gen(function* () {
        const proof = yield* decodePaperAuthorityProofBinding(candidate)
        const binding = yield* requirePaperGenerationRuntime(Authority.Observe, 'PREPARE')
        const fence = yield* WriterFence
        return yield* fence.transaction(preparePaperGenerationTransaction(proof, binding))
      }),
    )

  const replayPaperGeneration = (
    current: AuthorityState,
    history: Parameters<typeof paperGenerationFromRow>[0],
    proof: PaperAuthorityProofBinding,
    binding: PaperGenerationRuntimeBinding,
  ) =>
    paperGenerationFromRow(history).pipe(
      Effect.flatMap((stored) =>
        liftAuthorityDecision(validatePaperGenerationReplay(stored, binding, proof, config.build)),
      ),
      Effect.as(current),
    )

  const writePaperGenerationActivation = (
    decision: Extract<PaperActivationDecision, { readonly _tag: 'ActivatePaperGeneration' }>,
    derived: DerivedPaperGeneration,
    activatedAt: Date,
  ) =>
    Effect.gen(function* () {
      const input = derived.generation
      yield* sql`
        INSERT INTO authority_generations (
          generation_hash, schema_version, activation_schema_version,
          previous_generation_hash, maximum, authority_version,
          qualification_run_id, qualification_lock_id, qualification_result_hash,
          protocol_hash, qualification_execution_policy_hash,
          qualification_source_revision, qualification_image_repository,
          qualification_image_digest, activation_source_revision,
          activation_image_repository, activation_image_digest,
          strategy_name, strategy_behavior_hash,
          strategy_parameter_hash, strategy_parameter_schema_version, account_id,
          risk_policy_hash, proof_plan_hash, reconciliation_id,
          reconciliation_content_hash, activated_at
        ) VALUES (
          ${input.generationHash}, 'bayn.authority-generation-history.v1',
          ${input.schemaVersion}, ${input.previousGenerationHash}, 'PAPER', ${decision.authorityVersion},
          ${input.qualificationRunId}, ${input.qualificationLockId},
          ${input.qualificationResultHash}, ${input.protocolHash},
          ${input.qualificationExecutionPolicyHash}, ${input.qualificationSourceRevision},
          ${input.qualificationImageRepository}, ${input.qualificationImageDigest},
          ${input.activationSourceRevision}, ${input.activationImageRepository},
          ${input.activationImageDigest}, ${input.strategyName},
          ${input.strategyBehaviorHash}, ${input.strategyParameterHash},
          ${input.strategyParameterSchemaVersion}, ${input.accountId},
          ${input.riskPolicyHash}, ${input.proofPlanHash}, ${input.reconciliationId},
          ${input.reconciliationContentHash}, ${activatedAt}
        )
      `
      const effective = paperActivationEffectiveAuthority(derived.current.kill)
      const activatedRows = yield* sql<Record<string, unknown>>`
        UPDATE authority_state
        SET
          generation_hash = ${input.generationHash},
          maximum = 'PAPER',
          effective = ${effective},
          version = ${decision.authorityVersion},
          updated_at = ${activatedAt}
        WHERE singleton
        RETURNING
          schema_version, generation_hash, maximum, effective, kill_state, reason,
          version::text AS version, updated_at
      `.pipe(Effect.flatMap(decodeAuthorityStateRows))
      const activatedRow = activatedRows[0]
      if (activatedRow === undefined) {
        return yield* failPaperStore('authority', 'invariant', 'PAPER authority was not activated')
      }
      return yield* authorityStateFromRow(activatedRow)
    })

  const activatePaperGenerationTransaction = (
    proof: PaperAuthorityProofBinding,
    binding: PaperGenerationRuntimeBinding,
  ) =>
    Effect.gen(function* () {
      const locked = yield* authority.lockPaperAuthority(binding.accountId)
      const decision = yield* liftAuthorityDecision(decidePaperActivation(locked.current, binding))
      if (decision._tag === 'ReplayPaperGeneration') {
        return yield* replayPaperGeneration(decision.current, locked.history, proof, binding)
      }
      const derived = yield* derivePaperGeneration(proof, binding, decision.current)
      yield* liftAuthorityDecision(validateDerivedPaperGeneration(derived.generation, binding))
      const [existing] = yield* authority.readGeneration(derived.generation.generationHash)
      yield* authority.requireUnusedGeneration(derived.generation.generationHash, existing)
      const activatedAt = yield* requireFreshPaperGeneration(derived)
      return yield* writePaperGenerationActivation(decision, derived, activatedAt)
    })

  const activatePaperGeneration = (candidate: PaperAuthorityProofBinding) =>
    runPaperOperation(
      'authority',
      Effect.gen(function* () {
        const proof = yield* decodePaperAuthorityProofBinding(candidate)
        const binding = yield* requirePaperGenerationRuntime(Authority.Paper, 'activation')
        const fence = yield* WriterFence
        return yield* fence.transaction(activatePaperGenerationTransaction(proof, binding))
      }),
    )

  return { preparePaperGeneration, activatePaperGeneration }
}
