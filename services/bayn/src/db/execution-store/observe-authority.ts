import { PgClient } from '@effect/sql-pg'
import { Effect, Result } from 'effect'

import {
  BrokerEnvironment,
  BrokerProvider,
  decodePersistedBrokerIdentity,
  type BrokerIdentity,
} from '../../broker/identity'
import { Authority, type AuthorityState } from '../../execution/contracts'
import {
  decideObserveGeneration,
  validateAuthorityObservation,
  validateObserveGenerationRequest,
  type ObserveGenerationDecision,
  type ObserveGenerationRequest,
} from '../capital-grant-algebra'
import { authorityStateFromRow, type AuthorityPostgres } from './authority-shared'
import type { EnsureAuthorityGenerationInput, ExecutionStoreError } from './contract'
import { failExecutionStore, liftAuthorityDecision, runExecutionOperation } from './errors'
import {
  decodeAuthorityStateObservationRows,
  decodeAuthorityStateRows,
  decodeDatabaseInstant,
  decodeEnsureAuthorityGenerationInput,
  type AuthorityGenerationRow,
} from './rows'

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

export const validateObserveGenerationBrokerIdentityReplay = (
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

export interface ObserveAuthorityInterpreter {
  readonly ensureAuthorityGeneration: (
    input: EnsureAuthorityGenerationInput,
  ) => Effect.Effect<AuthorityState, ExecutionStoreError>
}

export const makeObserveAuthorityInterpreter = (
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

  const rotateObserveGeneration = (
    decision: Extract<ObserveGenerationDecision, { readonly _tag: 'RotateObserveGeneration' }>,
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
      const rotated = yield* sql<Record<string, unknown>>`
        UPDATE authority_state
        SET
          generation_hash = ${decision.generationHash},
          maximum = ${decision.maximum},
          effective = 'OBSERVE',
          version = ${decision.authorityVersion},
          updated_at = ${activatedAt}
        WHERE singleton
        RETURNING
          schema_version, generation_hash, maximum, effective, kill_state, reason,
          version::text AS version, updated_at
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
          return yield* rotateObserveGeneration(decision)
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

  return { ensureAuthorityGeneration }
}
