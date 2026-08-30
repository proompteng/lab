import { PgClient } from '@effect/sql-pg'
import { Effect } from 'effect'

import { BrokerEnvironment } from '../../broker/identity'
import {
  decodeResearchCapitalGrantProofBinding,
  type AuthorityState,
  type ResearchCapitalGrantProofBinding,
} from '../../execution/contracts'
import {
  capitalGrantEffectiveAuthority,
  decideCapitalGrantActivation,
  deriveResearchCapitalGrantGeneration,
  validateCapitalGrantGenerationFreshness,
  validateCapitalGrantPrepareGeneration,
  validateCapitalGrantSourceAuthority,
  validateLatestExactReconciliation,
  validateMutationCoverage,
  validateResearchCapitalGrantGenerationReplay,
  validateResearchCapitalGrantProof,
  type CapitalGrantActivationDecision,
  type DerivedResearchCapitalGrantGeneration,
  type ExactReconciliationFacts,
} from '../../execution/capital-grant-algebra'
import type { WriterFenceService } from '../../execution/writer-fence'
import { Pipeable } from '../../pipeable'
import {
  authorityStateFromRow,
  researchCapitalGrantGenerationFromRow,
  type AuthorityPostgres,
} from './authority-shared'
import type { ExecutionStoreError, ExecutionStoreRuntimeConfig } from './contract'
import { failExecutionStore, liftAuthorityDecision, runExecutionOperation } from './errors'
import {
  decodeActivationReconciliationRows,
  decodeAuthorityStateRows,
  decodeMutationBaseline,
  type ActivationReconciliationRow,
} from './rows'

export interface CapitalGrantInterpreter {
  readonly activateResearchCapitalGrant: (
    proof: ResearchCapitalGrantProofBinding,
    sourceGenerationHash: string,
    cutoffAt: string,
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
        'research capital grant requires the exact configured sandbox broker identity and OBSERVE generation',
      )
    }
    return Effect.succeed({
      accountId: identity.accountId,
      brokerIdentityHash: identity.identityHash,
      sourceGenerationHash,
    })
  }

  const reconciliationFacts = (row: ActivationReconciliationRow): ExactReconciliationFacts => ({
    reconciliationId: row.reconciliation_id,
    accountId: row.account_id,
    contentHash: row.content_hash,
    status: row.status,
    reconciledAt: row.reconciled_at,
  })

  const readLatestExactReconciliation = (binding: Pick<ResearchCapitalGrantRuntimeBinding, 'accountId'>) =>
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
    binding: Pick<ResearchCapitalGrantRuntimeBinding, 'accountId'>,
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

  const requireFreshCapitalGrantGeneration = (derived: Pick<DerivedResearchCapitalGrantGeneration, 'reconciliation'>) =>
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

  const activateAuthorityState = (
    generationHash: string,
    authorityVersion: number,
    kill: AuthorityState['kill'],
    activatedAt: Date,
  ) =>
    sql<Record<string, unknown>>`
      UPDATE authority_state
      SET
        generation_hash = ${generationHash},
        maximum = 'PAPER',
        effective = ${capitalGrantEffectiveAuthority(kill)},
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

  const deriveResearchCapitalGrantForActivation = (
    proof: ResearchCapitalGrantProofBinding,
    binding: ResearchCapitalGrantRuntimeBinding,
    current: AuthorityState,
  ) =>
    Effect.gen(function* () {
      yield* liftAuthorityDecision(validateCapitalGrantSourceAuthority(current))
      yield* liftAuthorityDecision(
        validateCapitalGrantPrepareGeneration(current, {
          configuredGenerationHash: binding.sourceGenerationHash,
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
          'research capital grant broker identity does not match the configured sandbox account',
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
    cutoffAt: string,
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
      if (activatedAt.toISOString() >= cutoffAt) {
        return yield* failExecutionStore(
          'authority',
          'invariant',
          'research capital activation crossed its immutable cutoff before commit',
        )
      }
      return yield* writeResearchCapitalGrantGenerationActivation(decision, derived, activatedAt)
    })

  const activateResearchCapitalGrant = (
    candidate: ResearchCapitalGrantProofBinding,
    sourceGenerationHash: string,
    cutoffAt: string,
  ) =>
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
        return yield* writerFence.transaction(
          activateResearchCapitalGrantGenerationTransaction(proof, binding, cutoffAt),
        )
      }),
    )

  return { activateResearchCapitalGrant }
}

export const makeCapitalGrantInterpreter = Pipeable.dual(4, makeCapitalGrantInterpreterDataFirst)
