import { PgClient } from '@effect/sql-pg'
import { Effect, Schema } from 'effect'

import {
  decodeAuthorityState,
  decodeCapitalGrantGeneration,
  decodeResearchCapitalGrantGeneration,
  type AuthorityState,
  type CapitalGrantGeneration,
  type ResearchCapitalGrantGeneration,
} from '../../execution/contracts'
import {
  requireUnusedAuthorityGeneration,
  validateAuthorityObservation,
  validateCurrentGenerationHistory,
  type AuthorityGenerationHistoryFacts,
} from '../capital-grant-algebra'
import type { ExecutionStoreError } from './contract'
import { failExecutionStore, liftAuthorityDecision, runExecutionOperation } from './errors'
import {
  decodeAuthorityGenerationRows,
  decodeAuthorityStateObservationRows,
  decodeDatabaseInstant,
  type AuthorityGenerationRow,
  type AuthorityStateRow,
} from './rows'

export const authorityStateFromRow = (
  row: AuthorityStateRow,
): Effect.Effect<AuthorityState, ExecutionStoreError | Schema.SchemaError> => {
  const version = Number(row.version)
  if (!Number.isSafeInteger(version) || version <= 0) {
    return failExecutionStore('authority', 'invariant', 'durable authority version is not a safe positive integer')
  }
  return decodeAuthorityState({
    schemaVersion: row.schema_version,
    generationHash: row.generation_hash,
    maximum: row.maximum,
    effective: row.effective,
    kill: row.kill_state,
    ...(row.reason === null ? {} : { reason: row.reason }),
    version,
    updatedAt: row.updated_at.toISOString(),
  })
}

export const paperGenerationFromRow = (
  row: AuthorityGenerationRow,
): Effect.Effect<CapitalGrantGeneration, ExecutionStoreError | Schema.SchemaError> => {
  if (
    row.activation_schema_version !== 'bayn.paper-authority-generation.v2' ||
    row.previous_generation_hash === null ||
    row.qualification_run_id === null ||
    row.qualification_lock_id === null ||
    row.qualification_result_hash === null ||
    row.protocol_hash === null ||
    row.qualification_execution_policy_hash === null ||
    row.qualification_source_revision === null ||
    row.qualification_image_repository === null ||
    row.qualification_image_digest === null ||
    row.activation_source_revision === null ||
    row.activation_image_repository === null ||
    row.activation_image_digest === null ||
    row.strategy_name === null ||
    row.strategy_behavior_hash === null ||
    row.strategy_parameter_hash === null ||
    row.strategy_parameter_schema_version === null ||
    row.account_id === null ||
    row.risk_policy_hash === null ||
    row.proof_plan_hash === null ||
    row.reconciliation_id === null ||
    row.reconciliation_content_hash === null
  ) {
    return failExecutionStore('authority', 'invariant', 'PAPER authority generation history is incomplete')
  }
  return decodeCapitalGrantGeneration({
    schemaVersion: row.activation_schema_version,
    generationHash: row.generation_hash,
    maximum: row.maximum,
    previousGenerationHash: row.previous_generation_hash,
    qualificationRunId: row.qualification_run_id,
    qualificationLockId: row.qualification_lock_id,
    qualificationResultHash: row.qualification_result_hash,
    protocolHash: row.protocol_hash,
    qualificationExecutionPolicyHash: row.qualification_execution_policy_hash,
    qualificationSourceRevision: row.qualification_source_revision,
    qualificationImageRepository: row.qualification_image_repository,
    qualificationImageDigest: row.qualification_image_digest,
    activationSourceRevision: row.activation_source_revision,
    activationImageRepository: row.activation_image_repository,
    activationImageDigest: row.activation_image_digest,
    strategyName: row.strategy_name,
    strategyBehaviorHash: row.strategy_behavior_hash,
    strategyParameterHash: row.strategy_parameter_hash,
    strategyParameterSchemaVersion: row.strategy_parameter_schema_version,
    accountId: row.account_id,
    riskPolicyHash: row.risk_policy_hash,
    proofPlanHash: row.proof_plan_hash,
    reconciliationId: row.reconciliation_id,
    reconciliationContentHash: row.reconciliation_content_hash,
  })
}

export const researchPaperGenerationFromRow = (
  row: AuthorityGenerationRow,
): Effect.Effect<ResearchCapitalGrantGeneration, ExecutionStoreError | Schema.SchemaError> => {
  if (
    row.activation_schema_version !== 'bayn.paper-authority-generation.v3' ||
    row.previous_generation_hash === null ||
    row.research_plan_hash === null ||
    row.activation_source_revision === null ||
    row.activation_image_repository === null ||
    row.activation_image_digest === null ||
    row.strategy_name === null ||
    row.strategy_behavior_hash === null ||
    row.strategy_parameter_hash === null ||
    row.strategy_parameter_schema_version === null ||
    row.strategy_protocol_hash === null ||
    row.account_id === null ||
    row.broker_identity_hash === null ||
    row.risk_policy_hash === null ||
    row.proof_plan_hash === null ||
    row.reconciliation_id === null ||
    row.reconciliation_content_hash === null
  ) {
    return failExecutionStore('authority', 'invariant', 'research PAPER authority generation history is incomplete')
  }
  return decodeResearchCapitalGrantGeneration({
    schemaVersion: row.activation_schema_version,
    generationHash: row.generation_hash,
    maximum: row.maximum,
    previousGenerationHash: row.previous_generation_hash,
    grant: { _tag: 'Research', planHash: row.research_plan_hash },
    activationSourceRevision: row.activation_source_revision,
    activationImageRepository: row.activation_image_repository,
    activationImageDigest: row.activation_image_digest,
    strategyName: row.strategy_name,
    strategyBehaviorHash: row.strategy_behavior_hash,
    strategyParameterHash: row.strategy_parameter_hash,
    strategyParameterSchemaVersion: row.strategy_parameter_schema_version,
    strategyProtocolHash: row.strategy_protocol_hash,
    accountId: row.account_id,
    brokerIdentityHash: row.broker_identity_hash,
    riskPolicyHash: row.risk_policy_hash,
    proofPlanHash: row.proof_plan_hash,
    reconciliationId: row.reconciliation_id,
    reconciliationContentHash: row.reconciliation_content_hash,
  })
}

const generationHistoryFacts = (
  history: AuthorityGenerationRow,
): AuthorityGenerationHistoryFacts & { readonly row: AuthorityGenerationRow } => ({
  generationHash: history.generation_hash,
  maximum: history.maximum,
  authorityVersion: history.authority_version,
  activatedAt: history.activated_at,
  row: history,
})

export interface LockedCapitalGrant {
  readonly current: AuthorityState
  readonly history: AuthorityGenerationRow
}

export const makeAuthorityPostgres = (sql: PgClient.PgClient) => {
  const lockAuthorityGenerations = Effect.gen(function* () {
    yield* sql`
      SELECT pg_advisory_xact_lock(
        hashtextextended('bayn.paper-authority-generation.v1', 0)
      )
    `
    yield* sql`LOCK TABLE authority_generations IN SHARE ROW EXCLUSIVE MODE`
  })

  const readGeneration = (generationHash: string) =>
    sql<Record<string, unknown>>`
      SELECT
        generation_hash, activation_schema_version, previous_generation_hash, maximum,
        authority_version::text AS authority_version,
        broker_identity_schema_version, broker_identity_hash, broker_provider, broker_environment,
        qualification_run_id,
        qualification_lock_id, qualification_result_hash, protocol_hash,
        qualification_execution_policy_hash, qualification_source_revision,
        qualification_image_repository, qualification_image_digest,
        activation_source_revision, activation_image_repository, activation_image_digest,
        strategy_name, strategy_behavior_hash, strategy_parameter_hash,
        strategy_parameter_schema_version, account_id, risk_policy_hash, proof_plan_hash,
        reconciliation_id, reconciliation_content_hash, research_plan_hash, strategy_protocol_hash, activated_at
      FROM authority_generations
      WHERE generation_hash = ${generationHash}
    `.pipe(Effect.flatMap(decodeAuthorityGenerationRows))

  const verifyCurrentGenerationHistory = (current: AuthorityState, history: AuthorityGenerationRow | undefined) =>
    liftAuthorityDecision(
      validateCurrentGenerationHistory(current, history === undefined ? undefined : generationHistoryFacts(history)),
    ).pipe(Effect.asVoid)

  const requireCurrentGenerationHistory = (
    current: AuthorityState,
    history: AuthorityGenerationRow | undefined,
  ): Effect.Effect<AuthorityGenerationRow, ExecutionStoreError> =>
    liftAuthorityDecision(
      validateCurrentGenerationHistory(current, history === undefined ? undefined : generationHistoryFacts(history)),
    ).pipe(Effect.map((validated) => validated.row))

  const requireUnusedGeneration = (generationHash: string, history: AuthorityGenerationRow | undefined) =>
    liftAuthorityDecision(
      requireUnusedAuthorityGeneration(
        generationHash,
        history === undefined ? undefined : generationHistoryFacts(history),
      ),
    )

  const nextAuthorityInstant = sql<Record<string, unknown>>`
    SELECT greatest(
      clock_timestamp(),
      updated_at + interval '1 millisecond'
    ) AS activated_at
    FROM authority_state
    WHERE singleton
  `.pipe(
    Effect.flatMap(decodeDatabaseInstant),
    Effect.flatMap((rows) =>
      rows[0] === undefined
        ? failExecutionStore('authority', 'invariant', 'authority update time is unavailable')
        : Effect.succeed(rows[0].activated_at),
    ),
  )

  const lockCapitalGrant = (accountId: string): Effect.Effect<LockedCapitalGrant, ExecutionStoreError> =>
    runExecutionOperation(
      'authority',
      Effect.gen(function* () {
        yield* sql`
          SELECT pg_advisory_xact_lock(
            hashtextextended(${`ALPACA:${accountId}`}, 0)
          )
        `
        yield* lockAuthorityGenerations
        const currentRows = yield* sql<Record<string, unknown>>`
          SELECT
            schema_version, generation_hash, maximum, effective, kill_state, reason,
            version::text AS version, updated_at, clock_timestamp() AS observed_at
          FROM authority_state
          WHERE singleton
          FOR UPDATE
        `.pipe(Effect.flatMap(decodeAuthorityStateObservationRows))
        const currentRow = currentRows[0]
        if (currentRow === undefined) {
          return yield* failExecutionStore('authority', 'invariant', 'PAPER generation requires initialized authority')
        }
        const current = yield* authorityStateFromRow(currentRow)
        yield* liftAuthorityDecision(validateAuthorityObservation(current, currentRow.observed_at))
        const history = yield* readGeneration(current.generationHash).pipe(
          Effect.flatMap((rows) => requireCurrentGenerationHistory(current, rows[0])),
        )
        return { current, history }
      }),
    )

  return {
    lockAuthorityGenerations,
    readGeneration,
    verifyCurrentGenerationHistory,
    requireUnusedGeneration,
    nextAuthorityInstant,
    lockCapitalGrant,
  }
}

export type AuthorityPostgres = ReturnType<typeof makeAuthorityPostgres>
