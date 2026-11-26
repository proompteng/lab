import { Context, Effect, Result, Schema } from 'effect'

import { ExecutionBuildSchema, type ExecutionBuild } from '../build'
import { operationalError, type OperationalError } from '../errors'
import { canonicalHashV1Result } from '../hash'
import { marketHoursAreCanonical, type MarketHours } from '../market-hours'
import { SnapshotCalendarSchema } from '../market-data/streaming/manifest-schema'
import {
  trailingBaselineCoversQuery,
  type TrailingBaselinePendingCoverage,
} from '../market-data/intraday/trailing-baseline'
import {
  reproduceTrailingBaselineAcquisition,
  TrailingBaselineAcquisitionSchema,
  TrailingBaselineQuerySchema,
} from '../market-data/intraday/baseline-acquisition'
import {
  IsoDateSchema,
  Sha256Schema,
  StrictNonEmptyStringSchema,
  UtcInstantSchema,
  strictParseOptions,
  type IsoDate,
} from '../schemas'
import {
  decodeIntradayAlphaPolicy,
  IntradayAlphaPolicySchema,
  intradayAlphaEquityMarketProfile,
  type IntradayAlphaPolicy,
} from '../strategy/intraday-alpha/policy'

export interface NativeAlphaBaselinePreparationRequest {
  readonly cycleId: string
  readonly authorityGenerationHash: string
  readonly accountId: string
  readonly sessionDate: IsoDate
  readonly calendar: MarketHours
  readonly policy: IntradayAlphaPolicy
}

export const AlphaBaselinePreparationSchema = Schema.Struct({
  schemaVersion: Schema.Literal('bayn.intraday-alpha-baseline-preparation.v1'),
  cycleId: Sha256Schema,
  authorityGenerationHash: Sha256Schema,
  accountId: StrictNonEmptyStringSchema,
  sessionDate: IsoDateSchema,
  calendar: SnapshotCalendarSchema,
  policy: IntradayAlphaPolicySchema,
  executionBuild: ExecutionBuildSchema,
  acquisition: TrailingBaselineAcquisitionSchema,
})
export type AlphaBaselinePreparation = typeof AlphaBaselinePreparationSchema.Type
export const RecordedAlphaBaselinePreparationSchema = Schema.Struct({
  contentHash: Sha256Schema,
  payload: AlphaBaselinePreparationSchema,
  recordedAt: UtcInstantSchema,
})
export type RecordedAlphaBaselinePreparation = typeof RecordedAlphaBaselinePreparationSchema.Type

export class NativeAlphaBaselinePreparation extends Context.Service<
  NativeAlphaBaselinePreparation,
  {
    readonly prepare: (
      request: NativeAlphaBaselinePreparationRequest,
    ) => Effect.Effect<RecordedAlphaBaselinePreparation, OperationalError | TrailingBaselinePendingCoverage>
  }
>()('@proompteng/bayn/observe-composition/NativeAlphaBaselinePreparation') {}

const invalid = (message: string, cause?: unknown) =>
  Result.fail(operationalError({ component: 'market-data', operation: 'alpha-baseline-preparation', message, cause }))

/** Query and target-session identities are stable across cycle rollover and different calendar read ranges. */
export const alphaBaselinePreparationIdentity = (
  request: NativeAlphaBaselinePreparationRequest,
  executionBuild: ExecutionBuild,
) =>
  Result.gen(function* () {
    const policy = yield* decodeIntradayAlphaPolicy(request.policy)
    const calendar = yield* Schema.decodeUnknownResult(SnapshotCalendarSchema, strictParseOptions)(request.calendar)
    const build = yield* Schema.decodeUnknownResult(ExecutionBuildSchema, strictParseOptions)(executionBuild)
    if (calendar.schemaVersion !== 'bayn.alpaca-market-calendar-observation.v2' || !marketHoursAreCanonical(calendar))
      return yield* invalid('Baseline preparation requires a canonical provider equity calendar')
    const native = calendar.sessions.find((session) => session.date === request.sessionDate)
    const provider = calendar.providerSessions.find((session) => session.date === request.sessionDate)
    if (
      native === undefined ||
      provider === undefined ||
      provider.regularOpenAt < native.openAt ||
      provider.regularCloseAt > native.closeAt
    )
      return yield* invalid('Baseline preparation has no matching native and provider regular session')
    const query = yield* Schema.decodeUnknownResult(
      TrailingBaselineQuerySchema,
      strictParseOptions,
    )({
      sessionDate: request.sessionDate,
      symbols: [...policy.candidateSymbols].sort(),
      noiseAreaSymbols: [...policy.noiseAreaSymbols].sort(),
      ...policy.trailingBaseline,
      sourceContract: {
        provider: 'alpaca',
        feed: intradayAlphaEquityMarketProfile.feed,
        sourceTopic: intradayAlphaEquityMarketProfile.sourceTopics.bars,
        universeId: intradayAlphaEquityMarketProfile.universeId,
      },
    })
    const scope = {
      schemaVersion: 'bayn.intraday-alpha-baseline-preparation-scope.v1',
      accountId: request.accountId,
      authorityGenerationHash: request.authorityGenerationHash,
      sessionDate: request.sessionDate,
      policy,
      query,
      nativeSession: native,
      providerSession: provider,
      executionBuild: build,
    }
    const scopeHash = yield* canonicalHashV1Result(scope)
    return { scopeHash, scope, query, nativeSession: native, providerSession: provider }
  }).pipe(
    Result.mapError((cause) =>
      operationalError({
        component: 'market-data',
        operation: 'alpha-baseline-preparation',
        message: 'Baseline preparation scope is invalid',
        cause,
      }),
    ),
  )

export const reproduceAlphaBaselinePreparation = (raw: unknown) =>
  Result.gen(function* () {
    const payload = yield* Schema.decodeUnknownResult(AlphaBaselinePreparationSchema, strictParseOptions)(raw)
    const identity = yield* alphaBaselinePreparationIdentity(payload, payload.executionBuild)
    const acquisition = yield* reproduceTrailingBaselineAcquisition(payload.acquisition)
    if (
      (yield* canonicalHashV1Result(identity.query)) !== (yield* canonicalHashV1Result(acquisition.query)) ||
      acquisition.startedAt < identity.nativeSession.openAt ||
      acquisition.completedAt >= identity.nativeSession.closeAt
    )
      return yield* invalid('Baseline preparation source differs from its session, policy, query or acquisition window')
    if (
      acquisition.startedAt < identity.providerSession.regularOpenAt &&
      !trailingBaselineCoversQuery(identity.query, acquisition.trailingBaseline)
    )
      return yield* invalid('Preopen baseline preparation does not cover all requested symbols and noise checkpoints')
    return { payload, contentHash: yield* canonicalHashV1Result(payload), ...identity }
  }).pipe(
    Result.mapError((cause) =>
      operationalError({
        component: 'market-data',
        operation: 'alpha-baseline-preparation',
        message: 'Baseline preparation did not reproduce',
        cause,
      }),
    ),
  )

export const reproduceRecordedAlphaBaselinePreparation = (raw: unknown) =>
  Result.gen(function* () {
    const record = yield* Schema.decodeUnknownResult(RecordedAlphaBaselinePreparationSchema, strictParseOptions)(raw)
    const reproduced = yield* reproduceAlphaBaselinePreparation(record.payload)
    if (
      record.contentHash !== reproduced.contentHash ||
      record.recordedAt < record.payload.acquisition.completedAt ||
      record.recordedAt >= reproduced.nativeSession.closeAt
    )
      return yield* invalid('Baseline preparation hash or server record time is invalid')
    return { ...record, scopeHash: reproduced.scopeHash }
  }).pipe(
    Result.mapError((cause) =>
      operationalError({
        component: 'database',
        operation: 'alpha-baseline-preparation',
        message: 'Retained baseline preparation is invalid',
        cause,
      }),
    ),
  )
