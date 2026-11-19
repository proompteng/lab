import { PgClient } from '@effect/sql-pg'
import { Data, Effect, Result } from 'effect'

import type { ApplicationPlan } from '../app'
import { databaseUtcInstant } from '../db/clock'
import { authorityStateFromRow } from '../db/execution-store/authority-shared'
import { decodeAuthorityStateObservationRows } from '../db/execution-store/rows'
import { observeCycleGenerationHash, validateAuthorityObservation } from '../execution/capital-grant-algebra'
import { Authority, KillState, type AuthorityState } from '../execution/contracts'
import { isExecutionMandateRecoveryRestriction, isRetiredOneShotMandateRestriction } from '../execution/mandate'
import { configuredCapitalActivation } from './capital-activation'

export class NativeActivationPreflightError extends Data.TaggedError('NativeActivationPreflightError')<{
  readonly message: string
  readonly cause?: unknown
}> {}

export const validateObserveActivationAuthority = (authority: AuthorityState | null): Result.Result<void, string> => {
  if (authority === null || Result.isSuccess(observeCycleGenerationHash(authority))) return Result.succeed(undefined)
  // Admission to the existing recovery path is not proof of settlement or permission to change authority.
  if (
    authority.maximum === Authority.Execution &&
    authority.effective === Authority.Observe &&
    authority.kill === KillState.Active &&
    (isExecutionMandateRecoveryRestriction(authority.reason) || isRetiredOneShotMandateRestriction(authority.reason))
  )
    return Result.succeed(undefined)
  return Result.fail(
    'OBSERVE deployment requires OBSERVE authority or an existing recoverable restriction before controller handoff',
  )
}

export const nativeActivationPreflight = (plan: ApplicationPlan) =>
  Effect.gen(function* () {
    const configured = yield* Effect.fromResult(configuredCapitalActivation(plan))
    if (configured !== null) return
    const sql = yield* PgClient.PgClient
    const rows = yield* sql<Record<string, unknown>>`
      SELECT schema_version, generation_hash, maximum, effective, kill_state, reason,
        version::text AS version, ${databaseUtcInstant(sql, sql`updated_at`)} AS updated_at,
        clock_timestamp() AS observed_at
      FROM authority_state WHERE singleton
    `.pipe(Effect.flatMap(decodeAuthorityStateObservationRows))
    const row = rows[0]
    if (row === undefined) return
    const authority = yield* authorityStateFromRow(row)
    yield* Effect.fromResult(validateAuthorityObservation(authority, row.observed_at))
    yield* Effect.fromResult(validateObserveActivationAuthority(authority))
  }).pipe(
    Effect.mapError(
      (cause) =>
        new NativeActivationPreflightError({
          message: 'native deployment authority preflight failed; predecessor was not deactivated',
          cause,
        }),
    ),
    Effect.timeoutOrElse({
      duration: plan.config.operationTimeoutMs,
      orElse: () =>
        Effect.fail(
          new NativeActivationPreflightError({
            message: 'native deployment authority preflight timed out; predecessor was not deactivated',
          }),
        ),
    }),
  )
