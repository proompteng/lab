import { PgClient } from '@effect/sql-pg'
import { Data, Effect, Result, Schema } from 'effect'

import type { ApplicationPlan } from '../app'
import { databaseUtcInstant } from '../db/clock'
import { authorityStateFromRow } from '../db/execution-store/authority-shared'
import { validateObserveGenerationBrokerIdentityReplay } from '../db/execution-store/observe-authority'
import { PaperAccountHandoffError, verifyPaperAccountHandoff } from '../db/execution-store/paper-account-handoff'
import { AuthorityGenerationBrokerBinding, AuthorityStateObservationRow } from '../db/execution-store/rows'
import { observeCycleGenerationHash, validateAuthorityObservation } from '../execution/capital-grant-algebra'
import { Authority, KillState, type AuthorityState } from '../execution/contracts'
import { isExecutionMandateRecoveryRestriction, isRetiredOneShotMandateRestriction } from '../execution/mandate'
import { strictParseOptions } from '../schemas'
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

const decodePreflightRows = Schema.decodeUnknownEffect(
  Schema.Array(
    Schema.Struct({ ...AuthorityStateObservationRow.fields, ...AuthorityGenerationBrokerBinding.fields }),
  ).check(Schema.isMaxLength(1)),
  strictParseOptions,
)

export const nativeActivationPreflight = (plan: ApplicationPlan) =>
  Effect.gen(function* () {
    const configured = yield* Effect.fromResult(configuredCapitalActivation(plan))
    if (configured !== null) return
    const from = plan.config.paperAccountHandoffFrom
    if (from !== undefined) {
      yield* verifyPaperAccountHandoff({
        from,
        to: plan.config.alpaca.identity,
        reconciliationStaleThresholdMs: plan.config.reconciliationStaleThresholdMs,
      })
      return
    }
    const sql = yield* PgClient.PgClient
    const rows = yield* sql<Record<string, unknown>>`
      SELECT s.schema_version, s.generation_hash, s.maximum, s.effective, s.kill_state, s.reason,
        s.version::text AS version, ${databaseUtcInstant(sql, sql`s.updated_at`)} AS updated_at,
        clock_timestamp() AS observed_at,
        g.previous_generation_hash, g.authority_version::text AS authority_version, g.account_id,
        g.broker_identity_schema_version, g.broker_identity_hash, g.broker_provider, g.broker_environment
      FROM authority_state s LEFT JOIN authority_generations g USING (generation_hash)
      WHERE s.singleton
    `.pipe(Effect.flatMap(decodePreflightRows))
    const row = rows[0]
    if (row === undefined) return
    const authority = yield* authorityStateFromRow(row)
    yield* Effect.fromResult(validateAuthorityObservation(authority, row.observed_at))
    yield* Effect.fromResult(validateObserveActivationAuthority(authority))
    yield* Effect.fromResult(validateObserveGenerationBrokerIdentityReplay(row, plan.config.alpaca.identity)).pipe(
      Effect.mapError(
        () =>
          new PaperAccountHandoffError({
            message: 'changing the active broker account requires the reviewed PAPER account handoff',
          }),
      ),
    )
  }).pipe(
    Effect.mapError(
      (cause) =>
        new NativeActivationPreflightError({
          message:
            cause instanceof PaperAccountHandoffError
              ? cause.message
              : 'native deployment authority preflight failed; predecessor was not deactivated',
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
