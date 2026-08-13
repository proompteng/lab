import { PgClient } from '@effect/sql-pg'
import { Effect } from 'effect'

import { BrokerEnvironment } from '../../broker/identity'
import type { WriterFenceService } from '../../execution/writer-fence'
import { historicalSandboxAuthority } from '../../execution/legacy-authority'
import {
  Authority,
  decodeCapitalGrantProofBinding,
  decodeResearchCapitalGrantProofBinding,
  type AuthorityState,
  type CapitalGrantGeneration,
  type CapitalGrantProofBinding,
  type ResearchCapitalGrantProofBinding,
} from '../../execution/contracts'
import {
  bindCapitalGrantRuntime,
  decideCapitalGrantActivation,
  deriveCapitalGrantGeneration,
  deriveResearchCapitalGrantGeneration,
  capitalGrantEffectiveAuthority,
  validateDerivedCapitalGrantGeneration,
  validateLatestExactReconciliation,
  validateMutationCoverage,
  validateCapitalGrantEvidence,
  validateCapitalGrantGenerationFreshness,
  validateCapitalGrantGenerationReplay,
  validateCapitalGrantPrepareGeneration,
  validatePreparedCapitalGrantActivation,
  validateCapitalGrantSourceAuthority,
  validateResearchCapitalGrantProof,
  validateResearchCapitalGrantGenerationReplay,
  type DerivedCapitalGrantGeneration,
  type DerivedResearchCapitalGrantGeneration,
  type ExactReconciliationFacts,
  type CapitalGrantActivationDecision,
  type CapitalGrantEvidenceFacts,
  type CapitalGrantRuntimeBinding,
  type PreparedCapitalGrantActivationBinding,
} from '../capital-grant-algebra'
import {
  authorityStateFromRow,
  capitalGrantGenerationFromRow,
  researchCapitalGrantGenerationFromRow,
  type AuthorityPostgres,
} from './authority-shared'
import type { ExecutionStoreError, ExecutionStoreRuntimeConfig, PreparedCapitalGrantActivation } from './contract'
import { failExecutionStore, liftAuthorityDecision, runExecutionOperation } from './errors'
import {
  decodeActivationEvidenceRows,
  decodeActivationReconciliationRows,
  decodeAuthorityStateRows,
  decodeMutationBaseline,
  type ActivationEvidenceRow,
  type ActivationReconciliationRow,
} from './rows'
import { Pipeable } from '../../pipeable'

export interface CapitalGrantInterpreter {
  readonly prepareCapitalGrant: (
    proof: CapitalGrantProofBinding,
  ) => Effect.Effect<CapitalGrantGeneration, ExecutionStoreError>
  readonly activateCapitalGrant: (proof: CapitalGrantProofBinding) => Effect.Effect<AuthorityState, ExecutionStoreError>
  readonly activatePreparedCapitalGrant: (
    proof: CapitalGrantProofBinding,
    prepared: PreparedCapitalGrantActivation,
  ) => Effect.Effect<AuthorityState, ExecutionStoreError>
  readonly activateResearchCapitalGrant: (
    proof: ResearchCapitalGrantProofBinding,
    sourceGenerationHash: string,
  ) => Effect.Effect<AuthorityState, ExecutionStoreError>
}

interface ResearchCapitalGrantRuntimeBinding {
  readonly accountId: string
  readonly brokerIdentityHash: string
  readonly sourceGenerationHash: string
}

const makeCapitalGrantInterpreterDataFirst = (
  sql: PgClient.PgClient,
  authority: AuthorityPostgres,
  config: ExecutionStoreRuntimeConfig,
  writerFence: WriterFenceService,
): CapitalGrantInterpreter => {
  const requireCapitalGrantRuntime = (
    expectedMaximum: Authority,
    operation: 'PREPARE' | 'activation',
  ): Effect.Effect<CapitalGrantRuntimeBinding, ExecutionStoreError> =>
    liftAuthorityDecision(
      bindCapitalGrantRuntime(
        {
          maximumAuthority: historicalSandboxAuthority(config.execution),
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

  const requireResearchCapitalGrantRuntime = (
    sourceGenerationHash: string,
  ): Effect.Effect<ResearchCapitalGrantRuntimeBinding, ExecutionStoreError> => {
    const identity = config.execution.brokerIdentity
    const alpaca = config.alpaca
    if (
      identity === undefined ||
      alpaca === undefined ||
      identity.environment !== BrokerEnvironment.Sandbox ||
      identity.accountId !== alpaca.expectedAccountId
    ) {
      return failExecutionStore(
        'authority',
        'invariant',
        'research capital grant generation requires the exact configured sandbox broker identity and OBSERVE generation',
      )
    }
    return Effect.succeed({
      accountId: identity.accountId,
      brokerIdentityHash: identity.identityHash,
      sourceGenerationHash,
    })
  }

  const evidenceFacts = (row: ActivationEvidenceRow): CapitalGrantEvidenceFacts => ({
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

  const readCapitalGrantEvidence = (binding: CapitalGrantRuntimeBinding) =>
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
        liftAuthorityDecision(validateCapitalGrantEvidence(evidence, binding, config.build)),
      ),
    )

  const reconciliationFacts = (row: ActivationReconciliationRow): ExactReconciliationFacts => ({
    reconciliationId: row.reconciliation_id,
    accountId: row.account_id,
    contentHash: row.content_hash,
    status: row.status,
    reconciledAt: row.reconciled_at,
  })

  const readLatestExactReconciliation = (binding: Pick<CapitalGrantRuntimeBinding, 'accountId'>) =>
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

  const verifyMutationCoverage = (
    binding: Pick<CapitalGrantRuntimeBinding, 'accountId'>,
    reconciliation: ExactReconciliationFacts,
  ) =>
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

  const deriveQualifiedCapitalGrantGeneration = (
    proof: CapitalGrantProofBinding,
    binding: CapitalGrantRuntimeBinding,
    current: AuthorityState,
  ) =>
    Effect.gen(function* () {
      yield* liftAuthorityDecision(validateCapitalGrantSourceAuthority(current))
      const evidence = yield* readCapitalGrantEvidence(binding)
      const reconciliation = yield* readLatestExactReconciliation(binding)
      yield* verifyMutationCoverage(binding, reconciliation)
      return yield* liftAuthorityDecision(
        deriveCapitalGrantGeneration({
          current,
          proof,
          binding,
          evidence,
          reconciliation,
          build: config.build,
        }),
      )
    })

  const requireFreshCapitalGrantGeneration = (derived: Pick<DerivedCapitalGrantGeneration, 'reconciliation'>) =>
    authority.nextAuthorityInstant.pipe(
      Effect.flatMap((observedAt) =>
        liftAuthorityDecision(
          validateCapitalGrantGenerationFreshness(
            derived.reconciliation,
            observedAt,
            config.reconciliationStaleThresholdMs,
          ),
        ),
      ),
    )

  const prepareCapitalGrantTransaction = (proof: CapitalGrantProofBinding, binding: CapitalGrantRuntimeBinding) =>
    Effect.gen(function* () {
      const locked = yield* authority.lockCapitalGrant(binding.accountId)
      yield* liftAuthorityDecision(validateCapitalGrantPrepareGeneration(locked.current, binding))
      const derived = yield* deriveQualifiedCapitalGrantGeneration(proof, binding, locked.current)
      yield* requireFreshCapitalGrantGeneration(derived)
      return derived.generation
    })

  const prepareCapitalGrant = (candidate: CapitalGrantProofBinding) =>
    runExecutionOperation(
      'authority',
      Effect.gen(function* () {
        const proof = yield* decodeCapitalGrantProofBinding(candidate)
        const binding = yield* requireCapitalGrantRuntime(Authority.Observe, 'PREPARE')
        return yield* writerFence.transaction(prepareCapitalGrantTransaction(proof, binding))
      }),
    )

  const replayCapitalGrantGeneration = (
    current: AuthorityState,
    history: Parameters<typeof capitalGrantGenerationFromRow>[0],
    proof: CapitalGrantProofBinding,
    binding: CapitalGrantRuntimeBinding,
  ) =>
    capitalGrantGenerationFromRow(history).pipe(
      Effect.flatMap((stored) =>
        liftAuthorityDecision(validateCapitalGrantGenerationReplay(stored, binding, proof, config.build)),
      ),
      Effect.as(current),
    )

  const activateAuthorityState = (
    generationHash: string,
    authorityVersion: number,
    kill: AuthorityState['kill'],
    activatedAt: Date,
  ) => {
    const effective = capitalGrantEffectiveAuthority(kill)
    return sql<Record<string, unknown>>`
      UPDATE authority_state
      SET
        generation_hash = ${generationHash},
        maximum = 'PAPER',
        effective = ${effective},
        version = ${authorityVersion},
        updated_at = ${activatedAt}
      WHERE singleton
      RETURNING
        schema_version, generation_hash, maximum, effective, kill_state, reason,
        version::text AS version, updated_at
    `.pipe(
      Effect.flatMap(decodeAuthorityStateRows),
      Effect.flatMap((rows) => {
        const row = rows[0]
        return row === undefined
          ? failExecutionStore('authority', 'invariant', 'execution authority was not activated')
          : authorityStateFromRow(row)
      }),
    )
  }

  const writeCapitalGrantGenerationActivation = (
    decision: Extract<CapitalGrantActivationDecision, { readonly _tag: 'ActivateCapitalGrantGeneration' }>,
    derived: DerivedCapitalGrantGeneration,
    activatedAt: Date,
  ) =>
    Effect.gen(function* () {
      const input = derived.generation
      const identity = config.execution.brokerIdentity
      if (identity === undefined) {
        return yield* failExecutionStore(
          'authority',
          'invariant',
          'capital grant generation requires a configured broker identity',
        )
      }
      if (identity.accountId !== input.accountId) {
        return yield* failExecutionStore(
          'authority',
          'invariant',
          'capital grant generation account does not match the configured broker identity',
        )
      }
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
          broker_identity_schema_version, broker_identity_hash, broker_provider, broker_environment,
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
          ${identity.schemaVersion}, ${identity.identityHash}, ${identity.provider}, ${identity.environment},
          ${input.riskPolicyHash}, ${input.proofPlanHash}, ${input.reconciliationId},
          ${input.reconciliationContentHash}, ${activatedAt}
        )
      `
      return yield* activateAuthorityState(
        input.generationHash,
        decision.authorityVersion,
        derived.current.kill,
        activatedAt,
      )
    })

  const activateCapitalGrantGenerationTransaction = (
    proof: CapitalGrantProofBinding,
    binding: CapitalGrantRuntimeBinding,
    prepared?: PreparedCapitalGrantActivationBinding,
  ) =>
    Effect.gen(function* () {
      const locked = yield* authority.lockCapitalGrant(binding.accountId)
      if (prepared !== undefined) {
        yield* liftAuthorityDecision(validatePreparedCapitalGrantActivation(locked.current, binding, prepared))
      }
      const decision = yield* liftAuthorityDecision(decideCapitalGrantActivation(locked.current, binding))
      if (decision._tag === 'ReplayCapitalGrantGeneration') {
        return yield* replayCapitalGrantGeneration(decision.current, locked.history, proof, binding)
      }
      const derived = yield* deriveQualifiedCapitalGrantGeneration(proof, binding, decision.current)
      yield* liftAuthorityDecision(validateDerivedCapitalGrantGeneration(derived.generation, binding))
      const [existing] = yield* authority.readGeneration(derived.generation.generationHash)
      yield* authority.requireUnusedGeneration(derived.generation.generationHash, existing)
      const activatedAt = yield* requireFreshCapitalGrantGeneration(derived)
      return yield* writeCapitalGrantGenerationActivation(decision, derived, activatedAt)
    })

  const activateCapitalGrant = (candidate: CapitalGrantProofBinding) =>
    runExecutionOperation(
      'authority',
      Effect.gen(function* () {
        const proof = yield* decodeCapitalGrantProofBinding(candidate)
        const binding = yield* requireCapitalGrantRuntime(Authority.Execution, 'activation')
        return yield* writerFence.transaction(activateCapitalGrantGenerationTransaction(proof, binding))
      }),
    )

  const activatePreparedCapitalGrant = (
    candidate: CapitalGrantProofBinding,
    prepared: PreparedCapitalGrantActivation,
  ) =>
    runExecutionOperation(
      'authority',
      Effect.gen(function* () {
        const proof = yield* decodeCapitalGrantProofBinding(candidate)
        const binding = yield* requireCapitalGrantRuntime(Authority.Execution, 'activation')
        return yield* writerFence.transaction(activateCapitalGrantGenerationTransaction(proof, binding, prepared))
      }),
    )

  const deriveResearchCapitalGrantForActivation = (
    proof: ResearchCapitalGrantProofBinding,
    binding: ResearchCapitalGrantRuntimeBinding,
    current: AuthorityState,
  ) =>
    Effect.gen(function* () {
      yield* liftAuthorityDecision(validateCapitalGrantSourceAuthority(current))
      yield* liftAuthorityDecision(
        validateCapitalGrantPrepareGeneration(current, {
          accountId: binding.accountId,
          configuredGenerationHash: binding.sourceGenerationHash,
          qualificationRunId: proof.grant.planHash,
        }),
      )
      yield* liftAuthorityDecision(
        validateResearchCapitalGrantProof({
          proof,
          sourceGenerationHash: binding.sourceGenerationHash,
          accountId: binding.accountId,
          brokerIdentityHash: binding.brokerIdentityHash,
          build: config.build,
        }),
      )
      const reconciliation = yield* readLatestExactReconciliation(binding)
      yield* verifyMutationCoverage(binding, reconciliation)
      return yield* liftAuthorityDecision(deriveResearchCapitalGrantGeneration({ current, proof, reconciliation }))
    })

  const replayResearchCapitalGrantGeneration = (
    current: AuthorityState,
    history: Parameters<typeof researchCapitalGrantGenerationFromRow>[0],
    proof: ResearchCapitalGrantProofBinding,
    binding: ResearchCapitalGrantRuntimeBinding,
  ) =>
    researchCapitalGrantGenerationFromRow(history).pipe(
      Effect.flatMap((stored) =>
        liftAuthorityDecision(
          validateResearchCapitalGrantGenerationReplay(stored, proof, binding.sourceGenerationHash),
        ),
      ),
      Effect.as(current),
    )

  const writeResearchCapitalGrantGenerationActivation = (
    decision: Extract<CapitalGrantActivationDecision, { readonly _tag: 'ActivateCapitalGrantGeneration' }>,
    derived: DerivedResearchCapitalGrantGeneration,
    activatedAt: Date,
  ) =>
    Effect.gen(function* () {
      const input = derived.generation
      const identity = config.execution.brokerIdentity
      if (
        identity === undefined ||
        identity.environment !== BrokerEnvironment.Sandbox ||
        identity.accountId !== input.accountId ||
        identity.identityHash !== input.brokerIdentityHash
      ) {
        return yield* failExecutionStore(
          'authority',
          'invariant',
          'research capital grant generation broker identity does not match the configured sandbox account',
        )
      }
      yield* sql`
        INSERT INTO authority_generations (
          generation_hash, schema_version, activation_schema_version,
          previous_generation_hash, maximum, authority_version,
          activation_source_revision, activation_image_repository, activation_image_digest,
          strategy_name, strategy_behavior_hash, strategy_parameter_hash,
          strategy_parameter_schema_version, strategy_protocol_hash, account_id,
          broker_identity_schema_version, broker_identity_hash, broker_provider, broker_environment,
          risk_policy_hash, proof_plan_hash, reconciliation_id, reconciliation_content_hash,
          research_plan_hash, activated_at
        ) VALUES (
          ${input.generationHash}, 'bayn.authority-generation-history.v1', ${input.schemaVersion},
          ${input.previousGenerationHash}, 'PAPER', ${decision.authorityVersion},
          ${input.activationSourceRevision}, ${input.activationImageRepository}, ${input.activationImageDigest},
          ${input.strategyName}, ${input.strategyBehaviorHash}, ${input.strategyParameterHash},
          ${input.strategyParameterSchemaVersion}, ${input.strategyProtocolHash}, ${input.accountId},
          ${identity.schemaVersion}, ${identity.identityHash}, ${identity.provider}, ${identity.environment},
          ${input.riskPolicyHash}, ${input.proofPlanHash}, ${input.reconciliationId},
          ${input.reconciliationContentHash}, ${input.grant.planHash}, ${activatedAt}
        )
      `
      return yield* activateAuthorityState(
        input.generationHash,
        decision.authorityVersion,
        derived.current.kill,
        activatedAt,
      )
    })

  const activateResearchCapitalGrantGenerationTransaction = (
    proof: ResearchCapitalGrantProofBinding,
    binding: ResearchCapitalGrantRuntimeBinding,
  ) =>
    Effect.gen(function* () {
      const locked = yield* authority.lockCapitalGrant(binding.accountId)
      const decision = yield* liftAuthorityDecision(
        decideCapitalGrantActivation(locked.current, { configuredGenerationHash: locked.current.generationHash }),
      )
      if (decision._tag === 'ReplayCapitalGrantGeneration') {
        return yield* replayResearchCapitalGrantGeneration(decision.current, locked.history, proof, binding)
      }
      const derived = yield* deriveResearchCapitalGrantForActivation(proof, binding, decision.current)
      const [existing] = yield* authority.readGeneration(derived.generation.generationHash)
      yield* authority.requireUnusedGeneration(derived.generation.generationHash, existing)
      const activatedAt = yield* requireFreshCapitalGrantGeneration(derived)
      return yield* writeResearchCapitalGrantGenerationActivation(decision, derived, activatedAt)
    })

  const activateResearchCapitalGrant = (candidate: ResearchCapitalGrantProofBinding, sourceGenerationHash: string) =>
    runExecutionOperation(
      'authority',
      Effect.gen(function* () {
        const proof = yield* decodeResearchCapitalGrantProofBinding(candidate)
        const binding = yield* requireResearchCapitalGrantRuntime(sourceGenerationHash)
        yield* liftAuthorityDecision(
          validateResearchCapitalGrantProof({
            proof,
            sourceGenerationHash: binding.sourceGenerationHash,
            accountId: binding.accountId,
            brokerIdentityHash: binding.brokerIdentityHash,
            build: config.build,
          }),
        )
        return yield* writerFence.transaction(activateResearchCapitalGrantGenerationTransaction(proof, binding))
      }),
    )

  return { prepareCapitalGrant, activateCapitalGrant, activatePreparedCapitalGrant, activateResearchCapitalGrant }
}

export const makeCapitalGrantInterpreter = Pipeable.dual(4, makeCapitalGrantInterpreterDataFirst)
