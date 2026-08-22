import { PgClient } from '@effect/sql-pg'
import { Effect, Result } from 'effect'

import {
  BrokerEnvironment,
  BrokerProvider,
  decodePersistedBrokerIdentity,
  type BrokerIdentity,
} from '../../broker/identity'
import {
  Authority,
  type AuthorityState,
  type CapitalGrantGeneration,
  type ResearchCapitalGrantGeneration,
} from '../../execution/contracts'
import {
  executionActivationExpiredRestrictionReason,
  executionMandateCompletedRestrictionReason,
  executionMandateFailureRestrictionPrefix,
  legacyExecutionActivationExpiredRestrictionReason,
  legacyExecutionMandateFailureRestrictionPrefix,
  legacyV1CompletedRestrictionReason,
} from '../../execution/mandate'
import { incompletePassReason } from '../../simulation-reconciliation/broker-reconciler-model'
import {
  decideObserveGeneration,
  validateAuthorityObservation,
  validateObserveGenerationRequest,
  type ObserveGenerationDecision,
  type ObserveGenerationRequest,
} from '../../execution/capital-grant-algebra'
import {
  authorityStateFromRow,
  capitalGrantGenerationFromRow,
  researchCapitalGrantGenerationFromRow,
  type AuthorityPostgres,
} from './authority-shared'
import type { AuthorityGenerationLineage, EnsureAuthorityGenerationInput, ExecutionStoreError } from './contract'
import { failExecutionStore, liftAuthorityDecision, runExecutionOperation } from './errors'
import {
  decodeAuthorityStateObservationRows,
  decodeAuthorityStateRows,
  decodeDatabaseInstant,
  decodeEnsureAuthorityGenerationInput,
  type AuthorityGenerationRow,
} from './rows'
import { Pipeable } from '../../pipeable'

export const LEGACY_AUTONOMOUS_OBSERVE_GENERATION_HASH =
  'd290539ec85334d8ce267f98919c139cb382068101042d69b5433832136dc063'

export interface ObserveGenerationBrokerIdentityFailure {
  readonly failure: 'conflict' | 'invariant'
  readonly message: string
  readonly cause?: unknown
}

const exactBrokerIdentity = (persisted: BrokerIdentity, configured: BrokerIdentity): boolean =>
  persisted.schemaVersion === configured.schemaVersion &&
  persisted.identityHash === configured.identityHash &&
  persisted.provider === configured.provider &&
  persisted.environment === configured.environment &&
  persisted.accountId === configured.accountId

const legacyAutonomousObserveCompatible = (history: AuthorityGenerationRow, configured: BrokerIdentity): boolean =>
  history.generation_hash === LEGACY_AUTONOMOUS_OBSERVE_GENERATION_HASH &&
  history.previous_generation_hash === null &&
  history.maximum === Authority.Observe &&
  history.authority_version === '1' &&
  history.account_id === null &&
  configured.provider === BrokerProvider.Alpaca &&
  configured.environment === BrokerEnvironment.Sandbox

const validateObserveGenerationBrokerIdentityReplayDataFirst = (
  history: AuthorityGenerationRow,
  configured: BrokerIdentity | undefined,
): Result.Result<void, ObserveGenerationBrokerIdentityFailure> => {
  if (configured === undefined) {
    return Result.fail({
      failure: 'conflict',
      message: 'authority generation replay requires a configured broker identity',
    })
  }
  const decoded = decodePersistedBrokerIdentity({
    broker_identity_schema_version: history.broker_identity_schema_version,
    broker_identity_hash: history.broker_identity_hash,
    broker_provider: history.broker_provider,
    broker_environment: history.broker_environment,
    account_id: history.account_id,
  })
  if (Result.isFailure(decoded)) {
    return Result.fail({
      failure: 'invariant',
      message: 'persisted authority generation broker identity is invalid',
      cause: decoded.failure,
    })
  }
  const persisted = decoded.success
  if (persisted === undefined) {
    return legacyAutonomousObserveCompatible(history, configured)
      ? Result.succeed(undefined)
      : Result.fail({
          failure: 'conflict',
          message: 'identity-less authority generation is not the compatible legacy autonomous OBSERVE root',
        })
  }
  if (persisted.schemaVersion === 'bayn.broker-account.v1') {
    return persisted.provider === configured.provider &&
      persisted.environment === configured.environment &&
      persisted.accountId === configured.accountId
      ? Result.succeed(undefined)
      : Result.fail({
          failure: 'conflict',
          message: 'historical authority generation broker account does not match configured sandbox identity',
        })
  }
  return exactBrokerIdentity(persisted, configured)
    ? Result.succeed(undefined)
    : Result.fail({
        failure: 'conflict',
        message: 'authority generation broker identity does not match configured broker identity',
      })
}

export const validateObserveGenerationBrokerIdentityReplay = Pipeable.dual(
  2,
  validateObserveGenerationBrokerIdentityReplayDataFirst,
)

export interface ObserveAuthorityInterpreter {
  readonly ensureAuthorityGeneration: (
    input: EnsureAuthorityGenerationInput,
  ) => Effect.Effect<AuthorityState, ExecutionStoreError>
  readonly readOrInitializeObserveAuthority: (
    input: EnsureAuthorityGenerationInput,
  ) => Effect.Effect<AuthorityState, ExecutionStoreError>
  readonly readAuthorityState: Effect.Effect<AuthorityState, ExecutionStoreError>
  readonly readAuthorityGeneration: (
    generationHash: string,
  ) => Effect.Effect<CapitalGrantGeneration | undefined, ExecutionStoreError>
  readonly readResearchAuthorityGeneration: (
    generationHash: string,
  ) => Effect.Effect<ResearchCapitalGrantGeneration | undefined, ExecutionStoreError>
  readonly readAuthorityGenerationLineage: (
    generationHash: string,
  ) => Effect.Effect<AuthorityGenerationLineage | undefined, ExecutionStoreError>
}

const makeObserveAuthorityInterpreterDataFirst = (
  sql: PgClient.PgClient,
  authority: AuthorityPostgres,
  brokerIdentity: BrokerIdentity | undefined,
): ObserveAuthorityInterpreter => {
  const requireBrokerIdentity = () =>
    brokerIdentity === undefined
      ? failExecutionStore('authority', 'invariant', 'authority generation requires a configured broker identity')
      : Effect.succeed(brokerIdentity)

  const initializeObserveGeneration = (
    decision: Extract<ObserveGenerationDecision, { readonly _tag: 'InitializeObserveGeneration' }>,
  ) =>
    Effect.gen(function* () {
      const [existing] = yield* authority.readGeneration(decision.generationHash)
      yield* authority.requireUnusedGeneration(decision.generationHash, existing)
      const [databaseTime] = yield* sql<Record<string, unknown>>`
        SELECT clock_timestamp() AS activated_at
      `.pipe(Effect.flatMap(decodeDatabaseInstant))
      if (databaseTime === undefined) {
        return yield* failExecutionStore('authority', 'invariant', 'authority initialization time is unavailable')
      }
      const identity = yield* requireBrokerIdentity()
      yield* sql`
        INSERT INTO authority_generations (
          generation_hash, schema_version, previous_generation_hash, maximum,
          authority_version, account_id,
          broker_identity_schema_version, broker_identity_hash, broker_provider, broker_environment,
          activated_at
        ) VALUES (
          ${decision.generationHash}, 'bayn.authority-generation-history.v1', NULL,
          'OBSERVE', 1, ${identity.accountId},
          ${identity.schemaVersion}, ${identity.identityHash}, ${identity.provider}, ${identity.environment},
          ${databaseTime.activated_at}
        )
      `
      const inserted = yield* sql<Record<string, unknown>>`
        INSERT INTO authority_state (
          schema_version, generation_hash, maximum, effective, kill_state,
          reason, version, updated_at
        ) VALUES (
          'bayn.paper-authority.v1', ${decision.generationHash}, ${decision.maximum},
          'OBSERVE', 'CLEAR', NULL, 1, ${databaseTime.activated_at}
        )
        RETURNING
          schema_version, generation_hash, maximum, effective, kill_state, reason,
          version::text AS version, updated_at
      `.pipe(Effect.flatMap(decodeAuthorityStateRows))
      const insertedRow = inserted[0]
      if (insertedRow === undefined) {
        return yield* failExecutionStore('authority', 'invariant', 'authority generation was not initialized')
      }
      return yield* authorityStateFromRow(insertedRow)
    })

  const replayObserveGeneration = (current: AuthorityState) =>
    Effect.gen(function* () {
      const [history] = yield* authority.readGeneration(current.generationHash)
      yield* authority.verifyCurrentGenerationHistory(current, history)
      if (history === undefined) {
        return yield* failExecutionStore('authority', 'invariant', 'current authority generation history is missing')
      }
      const validation = validateObserveGenerationBrokerIdentityReplay(history, brokerIdentity)
      if (Result.isFailure(validation)) {
        return yield* failExecutionStore('authority', validation.failure.failure, validation.failure.message)
      }
      return current
    })

  const terminalizeUnusedPreSubmissionResearchCycles = (
    decision: Extract<ObserveGenerationDecision, { readonly _tag: 'RotateObserveGeneration' }>,
    request: ObserveGenerationRequest,
    activatedAt: Date,
  ) =>
    sql`
      UPDATE autonomous_cycles AS cycle
      SET
        state = 'BLOCKED',
        terminal_reason = 'BLOCKED_PROVENANCE_MISMATCH',
        state_version = cycle.state_version + 1,
        updated_at = ${activatedAt},
        terminal_at = ${activatedAt}
      FROM authority_state AS state
      JOIN authority_generations AS previous_generation
        ON previous_generation.generation_hash = state.generation_hash
      JOIN authority_generations AS candidate_generation
        ON candidate_generation.generation_hash = ${decision.generationHash}
      WHERE state.singleton
        AND state.generation_hash = ${decision.current.generationHash}
        AND state.maximum = 'PAPER'
        AND previous_generation.maximum = 'PAPER'
        AND previous_generation.activation_schema_version IN (
          'bayn.paper-authority-generation.v2',
          'bayn.paper-authority-generation.v3'
        )
        AND candidate_generation.previous_generation_hash = previous_generation.generation_hash
        AND candidate_generation.maximum = 'OBSERVE'
        AND candidate_generation.activation_schema_version IS NULL
        AND candidate_generation.authority_version = ${decision.authorityVersion}
        AND candidate_generation.activated_at = ${activatedAt}
        AND (
          (
            state.effective = 'OBSERVE'
            AND state.kill_state = 'ACTIVE'
            AND (
              state.reason LIKE ${`${executionMandateFailureRestrictionPrefix}%`}
              OR state.reason LIKE ${`${legacyExecutionMandateFailureRestrictionPrefix}%`}
              OR state.reason = ${incompletePassReason}
              OR (
                state.reason IN (
                  ${executionMandateCompletedRestrictionReason},
                  ${executionActivationExpiredRestrictionReason},
                  ${legacyV1CompletedRestrictionReason},
                  ${legacyExecutionActivationExpiredRestrictionReason}
                )
                AND EXISTS (
                  SELECT 1
                  FROM autonomous_forward_performance_receipts AS receipt
                  WHERE receipt.authority_generation_hash = state.generation_hash
                )
              )
            )
          )
          OR (
            state.effective = 'PAPER'
            AND state.kill_state = 'CLEAR'
            AND state.reason IS NULL
          )
        )
        AND cycle.qualification_run_id = CASE previous_generation.activation_schema_version
          WHEN 'bayn.paper-authority-generation.v2' THEN previous_generation.qualification_run_id
          WHEN 'bayn.paper-authority-generation.v3' THEN previous_generation.proof_plan_hash
        END
        AND cycle.account_id = previous_generation.account_id
        AND cycle.qualification_run_id IS DISTINCT FROM ${request.preserveCyclePlanHash ?? null}
        AND cycle.state IN ('PENDING', 'ACTIVE')
        AND cycle.decision_hash IS NULL
        AND cycle.updated_at <= ${activatedAt}
        AND ${activatedAt} < cycle.submission_open_at
        AND NOT EXISTS (
          SELECT 1
          FROM intents AS intent
          WHERE intent.cycle_id = cycle.cycle_id
        )
    `

  const rotateObserveGeneration = (
    decision: Extract<ObserveGenerationDecision, { readonly _tag: 'RotateObserveGeneration' }>,
    request: ObserveGenerationRequest,
  ) =>
    Effect.gen(function* () {
      const [currentHistory] = yield* authority.readGeneration(decision.current.generationHash)
      yield* authority.verifyCurrentGenerationHistory(decision.current, currentHistory)
      const [existing] = yield* authority.readGeneration(decision.generationHash)
      yield* authority.requireUnusedGeneration(decision.generationHash, existing)
      const activatedAt = yield* authority.nextAuthorityInstant
      const identity = yield* requireBrokerIdentity()
      yield* sql`
        INSERT INTO authority_generations (
          generation_hash, schema_version, previous_generation_hash, maximum,
          authority_version, account_id,
          broker_identity_schema_version, broker_identity_hash, broker_provider, broker_environment,
          activated_at
        ) VALUES (
          ${decision.generationHash}, 'bayn.authority-generation-history.v1',
          ${decision.current.generationHash}, 'OBSERVE', ${decision.authorityVersion}, ${identity.accountId},
          ${identity.schemaVersion}, ${identity.identityHash}, ${identity.provider}, ${identity.environment},
          ${activatedAt}
        )
      `
      yield* terminalizeUnusedPreSubmissionResearchCycles(decision, request, activatedAt)
      const rotated = yield* sql<Record<string, unknown>>`
        WITH latest_reconciliation AS (
          SELECT
            status,
            expected_hash,
            observed_hash,
            discrepancies,
            reconciled_at
          FROM reconciliations
          WHERE account_id = ${identity.accountId}
          ORDER BY reconciled_at DESC, reconciliation_id COLLATE "C" DESC
          LIMIT 1
        ), recovery AS (
          SELECT
            state.maximum = 'OBSERVE'
            AND state.effective = 'OBSERVE'
            AND state.kill_state = 'ACTIVE'
            AND state.reason = ${incompletePassReason}
            AND (
              (
                previous_generation.broker_identity_schema_version = ${identity.schemaVersion}
                AND previous_generation.broker_identity_hash = ${identity.identityHash}
                AND previous_generation.broker_provider = ${identity.provider}
                AND previous_generation.broker_environment = ${identity.environment}
                AND previous_generation.account_id = ${identity.accountId}
              )
              OR (
                ${identity.provider} = ${BrokerProvider.Alpaca}
                AND ${identity.environment} = ${BrokerEnvironment.Sandbox}
                AND previous_generation.generation_hash = ${LEGACY_AUTONOMOUS_OBSERVE_GENERATION_HASH}
                AND previous_generation.previous_generation_hash IS NULL
                AND previous_generation.maximum = 'OBSERVE'
                AND previous_generation.authority_version = 1
                AND previous_generation.broker_identity_schema_version IS NULL
                AND previous_generation.broker_identity_hash IS NULL
                AND previous_generation.broker_provider IS NULL
                AND previous_generation.broker_environment IS NULL
                AND previous_generation.account_id IS NULL
              )
            )
            AND reconciliation.status = 'EXACT'
            AND reconciliation.expected_hash = reconciliation.observed_hash
            AND jsonb_array_length(reconciliation.discrepancies) = 0
            AND reconciliation.reconciled_at > state.updated_at
            AND reconciliation.reconciled_at < ${activatedAt}
            AND NOT EXISTS (
              SELECT 1
              FROM mutation_events AS mutation
              JOIN intents AS intent ON intent.intent_id = mutation.intent_id
              WHERE intent.account_id = ${identity.accountId}
            ) AS eligible
          FROM authority_state AS state
          JOIN authority_generations AS previous_generation
            ON previous_generation.generation_hash = state.generation_hash
          LEFT JOIN latest_reconciliation AS reconciliation ON true
          WHERE state.singleton
        ), research_rearm AS (
          SELECT
            state.maximum = 'PAPER'
            AND (
              (
                state.effective = 'OBSERVE'
                AND state.kill_state = 'ACTIVE'
                AND (
                  state.reason LIKE ${`${executionMandateFailureRestrictionPrefix}%`}
                  OR state.reason LIKE ${`${legacyExecutionMandateFailureRestrictionPrefix}%`}
                  OR state.reason = ${incompletePassReason}
                  OR (
                    state.reason IN (
                      ${executionMandateCompletedRestrictionReason},
                      ${executionActivationExpiredRestrictionReason},
                      ${legacyV1CompletedRestrictionReason},
                      ${legacyExecutionActivationExpiredRestrictionReason}
                    )
                    AND EXISTS (
                      SELECT 1
                      FROM autonomous_forward_performance_receipts AS receipt
                      WHERE receipt.authority_generation_hash = state.generation_hash
                    )
                  )
                )
                AND previous_generation.activation_schema_version IN (
                  'bayn.paper-authority-generation.v2',
                  'bayn.paper-authority-generation.v3'
                )
              )
              OR (
                state.effective = 'PAPER'
                AND state.kill_state = 'CLEAR'
                AND state.reason IS NULL
                AND previous_generation.activation_schema_version = 'bayn.paper-authority-generation.v3'
              )
            ) AS candidate,
            research_paper_rearm_eligible(
              ${decision.generationHash},
              ${decision.authorityVersion},
              ${activatedAt}
            ) AS eligible
          FROM authority_state AS state
          JOIN authority_generations AS previous_generation
            ON previous_generation.generation_hash = state.generation_hash
          WHERE state.singleton
        )
        UPDATE authority_state AS state
        SET
          generation_hash = ${decision.generationHash},
          maximum = ${decision.maximum},
          effective = 'OBSERVE',
          kill_state = CASE
            WHEN recovery.eligible OR research_rearm.eligible THEN 'CLEAR'
            ELSE state.kill_state
          END,
          reason = CASE
            WHEN recovery.eligible OR research_rearm.eligible THEN NULL
            ELSE state.reason
          END,
          version = ${decision.authorityVersion},
          updated_at = ${activatedAt}
        FROM recovery, research_rearm
        WHERE state.singleton
          AND (NOT research_rearm.candidate OR research_rearm.eligible)
        RETURNING
          state.schema_version, state.generation_hash, state.maximum, state.effective, state.kill_state, state.reason,
          state.version::text AS version, state.updated_at
      `.pipe(Effect.flatMap(decodeAuthorityStateRows))
      const rotatedRow = rotated[0]
      if (rotatedRow === undefined) {
        return yield* failExecutionStore('authority', 'invariant', 'authority generation was not rotated')
      }
      return yield* authorityStateFromRow(rotatedRow)
    })

  const ensureAuthorityGenerationTransaction = (request: ObserveGenerationRequest) =>
    Effect.gen(function* () {
      yield* authority.lockAuthorityGenerations
      const rows = yield* sql<Record<string, unknown>>`
        SELECT
          schema_version, generation_hash, maximum, effective, kill_state, reason,
          version::text AS version, updated_at, clock_timestamp() AS observed_at
        FROM authority_state
        WHERE singleton
        FOR UPDATE
      `.pipe(Effect.flatMap(decodeAuthorityStateObservationRows))
      const currentRow = rows[0]
      const current = currentRow === undefined ? undefined : yield* authorityStateFromRow(currentRow)
      if (current !== undefined && currentRow !== undefined) {
        yield* liftAuthorityDecision(validateAuthorityObservation(current, currentRow.observed_at))
      }
      const decision = yield* liftAuthorityDecision(decideObserveGeneration(request, current))
      switch (decision._tag) {
        case 'InitializeObserveGeneration':
          return yield* initializeObserveGeneration(decision)
        case 'ReplayObserveGeneration':
          return yield* replayObserveGeneration(decision.current)
        case 'RotateObserveGeneration':
          return yield* rotateObserveGeneration(decision, request)
      }
    })

  const ensureAuthorityGeneration = (candidate: EnsureAuthorityGenerationInput) =>
    runExecutionOperation(
      'authority',
      decodeEnsureAuthorityGenerationInput(candidate).pipe(
        Effect.flatMap((input) =>
          liftAuthorityDecision(validateObserveGenerationRequest(input)).pipe(
            Effect.flatMap((request) => sql.withTransaction(ensureAuthorityGenerationTransaction(request))),
          ),
        ),
      ),
    )

  const readOrInitializeObserveAuthorityTransaction = (request: ObserveGenerationRequest) =>
    Effect.gen(function* () {
      yield* authority.lockAuthorityGenerations
      const rows = yield* sql<Record<string, unknown>>`
        SELECT
          schema_version, generation_hash, maximum, effective, kill_state, reason,
          version::text AS version, updated_at, clock_timestamp() AS observed_at
        FROM authority_state
        WHERE singleton
        FOR UPDATE
      `.pipe(Effect.flatMap(decodeAuthorityStateObservationRows))
      const currentRow = rows[0]
      if (currentRow !== undefined) {
        const current = yield* authorityStateFromRow(currentRow)
        yield* liftAuthorityDecision(validateAuthorityObservation(current, currentRow.observed_at))
        return yield* replayObserveGeneration(current)
      }
      const decision = yield* liftAuthorityDecision(decideObserveGeneration(request, undefined))
      if (decision._tag !== 'InitializeObserveGeneration') {
        return yield* failExecutionStore(
          'authority',
          'invariant',
          'absent authority state did not produce OBSERVE initialization',
        )
      }
      return yield* initializeObserveGeneration(decision)
    })

  const readOrInitializeObserveAuthority = (candidate: EnsureAuthorityGenerationInput) =>
    runExecutionOperation(
      'authority',
      decodeEnsureAuthorityGenerationInput(candidate).pipe(
        Effect.flatMap((input) =>
          liftAuthorityDecision(validateObserveGenerationRequest(input)).pipe(
            Effect.flatMap((request) => sql.withTransaction(readOrInitializeObserveAuthorityTransaction(request))),
          ),
        ),
      ),
    )

  const readAuthorityState = runExecutionOperation(
    'authority',
    sql<Record<string, unknown>>`
        SELECT schema_version, generation_hash, maximum, effective, kill_state, reason,
          version::text AS version, updated_at
        FROM authority_state
        WHERE singleton
      `.pipe(
      Effect.flatMap(decodeAuthorityStateRows),
      Effect.flatMap((rows) =>
        rows[0] === undefined
          ? failExecutionStore('authority', 'invariant', 'durable authority state is missing')
          : authorityStateFromRow(rows[0]),
      ),
    ),
  )

  const readAuthorityGeneration = (generationHash: string) =>
    runExecutionOperation(
      'authority',
      authority.readGeneration(generationHash).pipe(
        Effect.flatMap((rows) => {
          const row = rows[0]
          if (
            row === undefined ||
            row.maximum !== Authority.Execution ||
            row.activation_schema_version !== 'bayn.paper-authority-generation.v2'
          ) {
            return Effect.as(Effect.void, undefined)
          }
          return capitalGrantGenerationFromRow(row).pipe(Effect.map((generation) => generation))
        }),
      ),
    )

  const readResearchAuthorityGeneration = (generationHash: string) =>
    runExecutionOperation(
      'authority',
      authority.readGeneration(generationHash).pipe(
        Effect.flatMap((rows) => {
          const row = rows[0]
          if (
            row === undefined ||
            row.maximum !== Authority.Execution ||
            row.activation_schema_version !== 'bayn.paper-authority-generation.v3'
          ) {
            return Effect.as(Effect.void, undefined)
          }
          return researchCapitalGrantGenerationFromRow(row).pipe(Effect.map((generation) => generation))
        }),
      ),
    )

  const readAuthorityGenerationLineage = (generationHash: string) =>
    runExecutionOperation(
      'authority',
      authority.readGeneration(generationHash).pipe(
        Effect.map((rows) => {
          const row = rows[0]
          return row === undefined
            ? undefined
            : {
                generationHash: row.generation_hash,
                previousGenerationHash: row.previous_generation_hash,
                maximum: row.maximum,
              }
        }),
      ),
    )

  return {
    ensureAuthorityGeneration,
    readOrInitializeObserveAuthority,
    readAuthorityState,
    readAuthorityGeneration,
    readResearchAuthorityGeneration,
    readAuthorityGenerationLineage,
  }
}

export const makeObserveAuthorityInterpreter = Pipeable.dual(3, makeObserveAuthorityInterpreterDataFirst)
