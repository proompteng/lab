import { utcInstantFromEpochMillis } from '../time'
import { MarketCalendarObservationSchema } from '../broker/alpaca/model'
import { regularEquitySessions } from '../market-hours'
import { PgClient } from '@effect/sql-pg'
import { Effect, Layer, Schema } from 'effect'

import { ExecutionBuildSchema, type ExecutionBuild } from '../build'
import { OperationalError, operationalError } from '../errors'
import { canonicalHashV1Result, canonicalJsonV1Result } from '../hash'
import {
  IntradayTrailingBaseline,
  trailingBaselineCoversQuery,
  TrailingBaselinePendingCoverage,
  type IntradayTrailingBaselineService,
} from '../market-data/intraday/trailing-baseline'
import {
  alphaBaselinePreparationIdentity,
  NativeAlphaBaselinePreparation,
  RecordedAlphaBaselinePreparationSchema,
  reproduceAlphaBaselinePreparation,
  reproduceRecordedAlphaBaselinePreparation,
  type AlphaBaselinePreparation,
  type NativeAlphaBaselinePreparationRequest,
} from '../observe-composition/alpha-baseline-preparation'
import { strictParseOptions } from '../schemas'
import { intradayAlphaStrategyIdentity } from '../strategy/intraday-alpha/policy'

const readRecorded = (sql: PgClient.PgClient, scopeHash: string) =>
  Effect.gen(function* () {
    const rows = yield* Schema.decodeUnknownEffect(
      Schema.Array(RecordedAlphaBaselinePreparationSchema),
      strictParseOptions,
    )(
      yield* sql`
      SELECT content_hash AS "contentHash",payload,
        to_char(recorded_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "recordedAt"
      FROM intraday_alpha_baseline_preparations WHERE scope_hash=${scopeHash}`,
    )
    const record = rows[0]
    if (record === undefined) return null
    const verified = yield* Effect.fromResult(reproduceRecordedAlphaBaselinePreparation(record))
    if (rows.length !== 1 || verified.scopeHash !== scopeHash)
      return yield* operationalError({
        component: 'database',
        operation: 'alpha-baseline-preparation',
        message: 'Retained baseline differs from the requested immutable scope',
      })
    return record
  })

/** The source and pending evidence commit in this transaction; a later controller statement witnesses them. */
export const recordNativeAlphaBaselinePreparation = (sql: PgClient.PgClient, payload: AlphaBaselinePreparation) =>
  Effect.gen(function* () {
    const source = yield* Effect.fromResult(reproduceAlphaBaselinePreparation(payload))
    const identity = yield* Effect.fromResult(intradayAlphaStrategyIdentity(payload.policy))
    const parametersHash = yield* Effect.fromResult(canonicalHashV1Result(payload.policy))
    const payloadText = yield* Effect.fromResult(canonicalJsonV1Result(payload))
    const scopeText = yield* Effect.fromResult(canonicalJsonV1Result(source.scope))
    yield* sql`
      INSERT INTO intraday_alpha_baseline_preparations(content_hash,scope_hash,scope_text,cycle_id,authority_generation_hash,account_id,session_date,payload_text)
      SELECT ${source.contentHash},${source.scopeHash},${scopeText},${payload.cycleId},${payload.authorityGenerationHash},${payload.accountId},${payload.sessionDate}::date,${payloadText}
      WHERE EXISTS (
        SELECT 1 FROM autonomous_cycles cycle JOIN authority_generations generation ON generation.generation_hash=${payload.authorityGenerationHash}
        WHERE cycle.cycle_id=${payload.cycleId} AND cycle.account_id=${payload.accountId}
          AND cycle.qualification_run_id=COALESCE(generation.qualification_run_id,generation.research_plan_hash,generation.generation_hash)
          AND cycle.strategy_name='jev' AND cycle.strategy_protocol_hash=${identity.protocolHash}
          AND cycle.execution_session_date=${payload.sessionDate}::date
          AND cycle.execution_open_at=${source.nativeSession.openAt}::timestamptz
          AND cycle.execution_close_at=${source.nativeSession.closeAt}::timestamptz
          AND (generation.account_id IS NULL OR generation.account_id=cycle.account_id)
          AND (generation.strategy_parameter_hash IS NULL OR generation.strategy_parameter_hash=${parametersHash})
          AND (generation.strategy_protocol_hash IS NULL OR generation.strategy_protocol_hash=${identity.protocolHash})
      ) ON CONFLICT (scope_hash) DO NOTHING`
    const record = yield* readRecorded(sql, source.scopeHash)
    if (record === null)
      return yield* operationalError({
        component: 'database',
        operation: 'alpha-baseline-preparation',
        message: 'Baseline preparation has no matching native cycle and authority provenance',
      })
    return record
  }).pipe(
    sql.withTransaction,
    Effect.mapError((cause) =>
      cause instanceof OperationalError
        ? cause
        : operationalError({
            component: 'database',
            operation: 'alpha-baseline-preparation',
            message: 'Baseline preparation could not be durably recorded',
            cause,
          }),
    ),
  )

export const makeNativeAlphaBaselinePreparation = (
  sql: PgClient.PgClient,
  baseline: IntradayTrailingBaselineService,
  executionBuild: ExecutionBuild,
): NativeAlphaBaselinePreparation['Service'] => ({
  prepare: (request: NativeAlphaBaselinePreparationRequest, marketCalendar) =>
    Effect.gen(function* () {
      const identity = yield* Effect.fromResult(alphaBaselinePreparationIdentity(request, executionBuild))
      const existing = yield* readRecorded(sql, identity.scopeHash)
      if (existing !== null) return existing
      if (baseline.acquire === undefined)
        return yield* operationalError({
          component: 'market-data',
          operation: 'alpha-baseline-preparation',
          message: 'Native preparation requires the source-retaining acquisition capability',
        })
      const loadHistorySessions =
        identity.query.checkpointMinutesFromOpen === undefined || marketCalendar === undefined
          ? undefined
          : marketCalendar({
              start: utcInstantFromEpochMillis(Date.parse(request.sessionDate) - 30 * 86_400_000).slice(0, 10),
              end: utcInstantFromEpochMillis(Date.parse(request.sessionDate) - 86_400_000).slice(0, 10),
            }).pipe(
              Effect.flatMap(({ value }) =>
                Schema.decodeUnknownEffect(MarketCalendarObservationSchema.fields.sessions)(
                  regularEquitySessions(value),
                ),
              ),
              Effect.mapError((cause) =>
                operationalError({
                  component: 'market-data',
                  operation: 'alpha-baseline-preparation',
                  message: 'Could not read provider history sessions',
                  cause,
                }),
              ),
            )
      const acquisition = yield* baseline.acquire(identity.query, {
        regularOpenAt: identity.providerSession.regularOpenAt,
        ...(loadHistorySessions === undefined ? {} : { loadHistorySessions }),
      })
      if (
        acquisition.startedAt < identity.providerSession.regularOpenAt &&
        !trailingBaselineCoversQuery(identity.query, acquisition.trailingBaseline)
      )
        return yield* new TrailingBaselinePendingCoverage({
          message: 'Preopen baseline preparation awaits complete symbol and noise-checkpoint coverage',
          regularOpenAt: identity.providerSession.regularOpenAt,
          ...(loadHistorySessions === undefined ? {} : { loadHistorySessions }),
        })
      const payload = {
        schemaVersion: 'bayn.intraday-alpha-baseline-preparation.v1' as const,
        ...request,
        executionBuild,
        acquisition,
      }
      const reproduced = yield* Effect.fromResult(reproduceAlphaBaselinePreparation(payload))
      if (reproduced.scopeHash !== identity.scopeHash)
        return yield* operationalError({
          component: 'market-data',
          operation: 'alpha-baseline-preparation',
          message: 'Acquired baseline changed its preparation scope',
        })
      return yield* recordNativeAlphaBaselinePreparation(sql, reproduced.payload)
    }).pipe(
      Effect.mapError((cause) =>
        cause instanceof OperationalError || cause instanceof TrailingBaselinePendingCoverage
          ? cause
          : operationalError({
              component: 'database',
              operation: 'alpha-baseline-preparation',
              message: 'Native alpha baseline preparation failed',
              cause,
            }),
      ),
    ),
})

export const NativeAlphaBaselinePreparationLive = (executionBuild: ExecutionBuild) =>
  Layer.effect(
    NativeAlphaBaselinePreparation,
    Effect.gen(function* () {
      const build = yield* Schema.decodeUnknownEffect(
        ExecutionBuildSchema,
        strictParseOptions,
      )(executionBuild).pipe(
        Effect.mapError((cause) =>
          operationalError({
            component: 'config',
            operation: 'alpha-baseline-preparation',
            message: 'Native baseline acquisition requires the physical execution build',
            cause,
          }),
        ),
      )
      return makeNativeAlphaBaselinePreparation(yield* PgClient.PgClient, yield* IntradayTrailingBaseline, build)
    }),
  )
