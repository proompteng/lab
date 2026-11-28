import { PgClient } from '@effect/sql-pg'
import { Effect, Option, Result, Schema } from 'effect'
import { withObservedStage } from '../../telemetry'
import { databaseUtcInstant } from '../clock'

import {
  BrokerEnvironment,
  BrokerProvider,
  decodePersistedBrokerIdentity,
  type BrokerIdentity,
} from '../../broker/identity'
import { Authority, type AuthorityState } from '../../execution/contracts'
import { acquireExecutionWriterFence } from '../../execution/writer-fence'
import { sha256 } from '../../hash'
import {
  strategyProtocolCutoverRestrictionReason,
  executionActivationExpiredRestrictionReason,
  reconciliationDiscrepancyRestrictionPattern,
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
  makeAuthorityPostgres,
  researchCapitalGrantGenerationFromRow,
  type AuthorityPostgres,
} from './authority-shared'
import type { AuthorityGenerationStoreShape, EnsureAuthorityGenerationInput } from './contract'
import { executionStoreError, failExecutionStore, liftAuthorityDecision, runExecutionOperation } from './errors'
import {
  decodeAuthorityStateObservationRows,
  decodeAuthorityStateRows,
  decodeDatabaseInstant,
  decodeEnsureAuthorityGenerationInput,
  type AuthorityGenerationRow,
} from './rows'

export const LEGACY_AUTONOMOUS_OBSERVE_GENERATION_HASH =
  'd290539ec85334d8ce267f98919c139cb382068101042d69b5433832136dc063'

export const readAuthorityState = (sql: PgClient.PgClient) => {
  const statement = sql`
    SELECT schema_version, generation_hash, maximum, effective, kill_state, reason,
      version::text AS version, ${databaseUtcInstant(sql, sql`updated_at`)} AS updated_at
    FROM authority_state
    WHERE singleton
  `
  return runExecutionOperation(
    'authority',
    Effect.scoped(
      Effect.gen(function* () {
        const transaction = yield* Effect.serviceOption(sql.transactionService)
        const connection = Option.isSome(transaction)
          ? transaction.value[0]
          : yield* sql.reserve.pipe(withObservedStage('bayn.postgres.connection-acquire', { dependency: 'postgresql' }))
        const [query, parameters] = statement.compile()
        return yield* connection
          .execute(query, parameters, undefined)
          .pipe(withObservedStage('bayn.postgres.authority-query', { dependency: 'postgresql' }))
      }),
    ).pipe(
      Effect.flatMap(decodeAuthorityStateRows),
      Effect.flatMap((rows) =>
        rows[0] === undefined
          ? failExecutionStore('authority', 'invariant', 'durable authority state is missing')
          : authorityStateFromRow(rows[0]),
      ),
    ),
  )
}

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

const validateObserveGenerationBrokerIdentityReplay = (
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

export const previousConfiguredController = (sql: PgClient.PgClient, identity: BrokerIdentity) =>
  sql`
    SELECT parent.broker_identity_hash AS controller_key
    FROM authority_state s JOIN authority_generations g USING (generation_hash)
    JOIN authority_generations parent ON parent.generation_hash = g.previous_generation_hash
    WHERE s.singleton AND s.maximum = 'OBSERVE' AND g.broker_identity_hash = ${identity.identityHash}
      AND parent.broker_identity_hash <> g.broker_identity_hash
  `.pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(Schema.Struct({ controller_key: Schema.String })))),
    Effect.map((rows) => rows[0]?.controller_key ?? null),
  )

export const selectConfiguredBrokerAccount = (
  identity: BrokerIdentity,
  staleThresholdMs: number,
  allowAccountHandoff = true,
) =>
  Effect.flatMap(PgClient.PgClient, (sql) =>
    sql.withTransaction(
      Effect.gen(function* () {
        yield* acquireExecutionWriterFence(sql)
        const authority = makeAuthorityPostgres(sql)
        yield* authority.lockAuthorityGenerations
        const [current] = yield* sql`
          SELECT generation_hash FROM authority_state WHERE singleton FOR UPDATE
        `.pipe(
          Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(Schema.Struct({ generation_hash: Schema.String })))),
        )
        if (current === undefined) return null
        const [source] = yield* authority.readGeneration(current.generation_hash)
        if (source === undefined)
          return yield* failExecutionStore('authority', 'invariant', 'authority history is missing')
        const binding = validateObserveGenerationBrokerIdentityReplay(source, identity)
        if (Result.isSuccess(binding)) {
          return !allowAccountHandoff || source.broker_identity_hash === null
            ? null
            : yield* previousConfiguredController(sql, identity)
        }
        if (binding.failure.failure === 'invariant' || source.broker_identity_hash === null) {
          return yield* executionStoreError({ operation: 'authority', ...binding.failure })
        }
        // A namespaced controller cannot retire a predecessor in another Restate namespace.
        if (!allowAccountHandoff)
          return yield* failExecutionStore(
            'authority',
            'conflict',
            'a prefixed Restate sleeve requires its own Postgres database and broker account',
          )
        const predecessor = source.broker_identity_hash
        const activatedAt = yield* authority.nextAuthorityInstant
        const generationHash = sha256(
          ['bayn.observe-account', current.generation_hash, identity.identityHash].join('\u0000'),
        )
        const inserted = yield* sql`
          INSERT INTO authority_generations (
            generation_hash, schema_version, previous_generation_hash, maximum,
            authority_version, account_id, broker_identity_schema_version, broker_identity_hash,
            broker_provider, broker_environment, activated_at
          )
          SELECT ${generationHash}, 'bayn.authority-generation-history.v1', s.generation_hash, 'OBSERVE',
            s.version + 1, ${identity.accountId}, ${identity.schemaVersion}, ${identity.identityHash},
            ${identity.provider}, ${identity.environment}, ${activatedAt}
          FROM authority_state s JOIN authority_generations g USING (generation_hash)
          JOIN LATERAL (
            SELECT * FROM reconciliations WHERE account_id = g.account_id
            ORDER BY reconciled_at DESC, reconciliation_id COLLATE "C" DESC LIMIT 1
          ) r ON true
          JOIN LATERAL (
            SELECT position_count, observed_at FROM position_snapshots
            WHERE account_id = g.account_id AND ingestion_order_trusted
            ORDER BY ingestion_sequence DESC LIMIT 1
          ) position ON true
          WHERE s.singleton AND s.generation_hash = ${current.generation_hash}
            AND s.maximum = s.effective AND s.kill_state = 'CLEAR' AND s.reason IS NULL
            AND g.broker_provider = ${identity.provider} AND g.broker_environment = ${identity.environment}
            AND r.status = 'EXACT' AND r.expected_hash = r.observed_hash
            AND r.reconciled_at >= s.updated_at AND r.reconciled_at <= clock_timestamp()
            AND r.reconciled_at > clock_timestamp() - ${staleThresholdMs}::bigint * interval '1 millisecond'
            AND position.position_count = 0 AND position.observed_at <= r.reconciled_at
            AND observe_recovery_account_settled(s.generation_hash, g.account_id, r.reconciled_at)
            AND NOT EXISTS (
              WITH pending_inference AS MATERIALIZED (
                SELECT request.payload FROM jev_evaluation_requests request
                JOIN autonomous_cycles cycle USING (cycle_id)
                LEFT JOIN jev_evaluation_resolutions resolution USING (request_id)
                WHERE cycle.account_id = g.account_id AND resolution.request_id IS NULL
                UNION ALL
                SELECT plan.payload FROM jev_inference_work work JOIN jev_batch_plans plan USING (batch_id)
                JOIN autonomous_cycles cycle ON cycle.cycle_id = plan.cycle_id
                LEFT JOIN jev_batch_results result USING (batch_id)
                WHERE cycle.account_id = g.account_id AND result.batch_id IS NULL
              )
              SELECT 1 FROM autonomous_cycles WHERE account_id = g.account_id AND state IN ('PENDING', 'ACTIVE')
              UNION ALL
              SELECT 1 FROM intents WHERE account_id = g.account_id AND state <> 'TERMINAL'
              UNION ALL
              SELECT 1 FROM pending_inference WHERE (payload ->> 'expiresAt')::timestamptz > clock_timestamp()
            )
          RETURNING generation_hash
        `
        if (inserted.length === 0) {
          return yield* failExecutionStore('authority', 'conflict', 'the current broker account has not settled')
        }
        yield* sql`
          UPDATE authority_state
          SET generation_hash = ${generationHash}, maximum = 'OBSERVE', effective = 'OBSERVE',
            version = version + 1, updated_at = ${activatedAt}
          WHERE singleton AND generation_hash = ${current.generation_hash}
        `
        return predecessor
      }),
    ),
  )

export const makeObserveAuthorityInterpreter = (
  sql: PgClient.PgClient,
  authority: AuthorityPostgres,
  brokerIdentity: BrokerIdentity | undefined,
): AuthorityGenerationStoreShape => {
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
        SELECT to_char(${authority.clock.now} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS activated_at
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
          version::text AS version, ${databaseUtcInstant(sql, sql`updated_at`)} AS updated_at
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

  const terminalizeUnusedResearchCycles = (
    decision: Extract<ObserveGenerationDecision, { readonly _tag: 'RotateObserveGeneration' }>,
    request: ObserveGenerationRequest,
    activatedAt: string,
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
              OR state.reason = ${strategyProtocolCutoverRestrictionReason}
              OR state.reason ~ ${reconciliationDiscrepancyRestrictionPattern}
              OR (
                state.reason IN (
                  ${executionMandateCompletedRestrictionReason},
                  ${executionActivationExpiredRestrictionReason},
                  ${legacyV1CompletedRestrictionReason},
                  ${legacyExecutionActivationExpiredRestrictionReason}
                )
                AND (
                  EXISTS (
                    SELECT 1
                    FROM autonomous_forward_performance_receipts AS receipt
                    WHERE receipt.authority_generation_hash = state.generation_hash
                  )
                  OR research_paper_expired_zero_execution_settled(state.generation_hash)
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
        AND (
          ${activatedAt} < cycle.submission_open_at
          OR (
            state.reason = ${strategyProtocolCutoverRestrictionReason}
            AND cycle.snapshot_id IS NULL
            AND NOT EXISTS (
              SELECT 1
              FROM autonomous_cycle_shadow_decisions AS decision
              WHERE decision.cycle_id = cycle.cycle_id
            )
          )
        )
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
      yield* terminalizeUnusedResearchCycles(decision, request, activatedAt)
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
            AND observe_recovery_account_settled(
              state.generation_hash, ${identity.accountId}, reconciliation.reconciled_at
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
                  OR state.reason = ${strategyProtocolCutoverRestrictionReason}
                  OR state.reason ~ ${reconciliationDiscrepancyRestrictionPattern}
                  OR (
                    state.reason IN (
                      ${executionMandateCompletedRestrictionReason},
                      ${executionActivationExpiredRestrictionReason},
                      ${legacyV1CompletedRestrictionReason},
                      ${legacyExecutionActivationExpiredRestrictionReason}
                    )
                    AND (
                      EXISTS (
                        SELECT 1
                        FROM autonomous_forward_performance_receipts AS receipt
                        WHERE receipt.authority_generation_hash = state.generation_hash
                      )
                      OR research_paper_expired_zero_execution_settled(state.generation_hash)
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
          state.version::text AS version, ${databaseUtcInstant(sql, sql`state.updated_at`)} AS updated_at
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
          version::text AS version, ${databaseUtcInstant(sql, sql`updated_at`)} AS updated_at,
          ${authority.clock.now} AS observed_at
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
          version::text AS version, ${databaseUtcInstant(sql, sql`updated_at`)} AS updated_at,
          ${authority.clock.now} AS observed_at
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
    readAuthorityState: readAuthorityState(sql),
    readResearchAuthorityGeneration,
    readAuthorityGenerationLineage,
  }
}
