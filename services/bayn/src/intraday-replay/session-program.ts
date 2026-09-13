import { operationTimeoutOrElse } from '../operation-timeout'
import { PgClient } from '@effect/sql-pg'
import { Effect, Result, Schema } from 'effect'
import { TestClock } from 'effect/testing'
import { AssetResponseSchema, MarketCalendarResponseSchema } from '../broker/alpaca/model'
import { normalizeAssetResult, normalizeMarketCalendarResult } from '../broker/alpaca/normalizers'
import { BrokerEnvironment, BrokerProvider, makeBrokerIdentity } from '../broker/identity'
import { EmbeddedBuildMetadataSchema, embeddedBuildMetadata } from '../build'
import { BrokerAccess, noCapitalAuthority } from '../execution/authority'
import { makeRuntimeProvenance } from '../contracts'
import { canonicalHashV1Result } from '../hash'
import {
  ImageDigestSchema,
  IsoDateSchema,
  NonNegativeIntegerSchema,
  PositiveIntegerSchema,
  PositiveMicrosSchema,
  StrictNonEmptyStringSchema,
  UtcInstantSchema,
  strictParseOptions,
} from '../schemas'
import {
  activeStrategyBehaviorHash,
  activeStrategyName,
  loadActiveStrategyProtocol,
  makeActiveStrategyRuntime,
} from '../strategy'
import {
  RetainedReplaySourceManifestSchema,
  openRetainedReplaySource,
  validateRetainedReplaySourceManifest,
  validateCapturedReplayCuts,
  type RetainedReplayCapture,
} from './source'
import { makeSimulatedExecutionClock } from './clock'
import { makeReplayBroker, ReplayBrokerFailure } from './broker'
import { makeReplayExecutionRuntime } from './runtime'
import { makeReplayTimeline, driveReplaySession } from './session'
import type { RuntimeConfig } from '../config'
import type { RecordAutonomousCyclePass } from '../app'
import type { OperationalError } from '../errors'
import { postgresMigrations } from '../db/postgres-migrations'

export const ReplaySessionInputSchema = Schema.Struct({
  schemaVersion: Schema.Literal('bayn.execution-replay-session.v1'),
  replicate: StrictNonEmptyStringSchema,
  sessionDate: IsoDateSchema,
  source: RetainedReplaySourceManifestSchema,
  openingCashMicros: PositiveMicrosSchema,
  fractionalTrading: Schema.Boolean,
  calendar: MarketCalendarResponseSchema,
  assets: Schema.Array(AssetResponseSchema).check(Schema.isMinLength(1)),
  assetObservationAt: UtcInstantSchema,
  assetObservationPolicy: Schema.Literals(['retained-as-of-session', 'counterfactual-current-asset-eligibility']),
  build: Schema.Struct({ ...EmbeddedBuildMetadataSchema.fields, imageDigest: ImageDigestSchema }),
  assumptions: Schema.Struct({
    latencyMs: NonNegativeIntegerSchema,
    slippageBps: NonNegativeIntegerSchema.check(Schema.isLessThanOrEqualTo(10_000)),
    availableLiquidityPpm: PositiveIntegerSchema.check(Schema.isLessThanOrEqualTo(1_000_000)),
    feeMultiplierPpm: PositiveIntegerSchema.check(Schema.isBetween({ minimum: 1_000_000, maximum: 10_000_000 })),
  }),
  cadence: Schema.Struct({
    pollIntervalMs: PositiveIntegerSchema,
    reconciliationIntervalMs: PositiveIntegerSchema,
    reconciliationPassTimeoutMs: PositiveIntegerSchema,
    reconciliationStaleThresholdMs: PositiveIntegerSchema,
  }),
})
export const prepareReplaySession = (input: unknown, capture: RetainedReplayCapture) =>
  Result.gen(function* () {
    const supplied = yield* Schema.decodeUnknownResult(ReplaySessionInputSchema, strictParseOptions)(input)
    const decoded = {
      ...supplied,
      assets: [...supplied.assets].sort((a, b) => (a.symbol < b.symbol ? -1 : a.symbol > b.symbol ? 1 : 0)),
      calendar: [...supplied.calendar].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0)),
    }
    yield* validateRetainedReplaySourceManifest(decoded.source)
    yield* validateCapturedReplayCuts(decoded.source, capture)
    const protocol = yield* loadActiveStrategyProtocol()
    const parameterHash = yield* canonicalHashV1Result(protocol)
    if (protocol.streamingInput === undefined)
      return yield* Result.fail(new ReplayBrokerFailure({ message: 'Replay requires streaming input policy' }))
    if (
      decoded.build.strategyBehaviorHash !== activeStrategyBehaviorHash ||
      decoded.build.strategyParameterHash !== parameterHash
    )
      return yield* Result.fail(
        new ReplayBrokerFailure({ message: 'Replay must use the unchanged source-controlled strategy' }),
      )
    if (
      embeddedBuildMetadata !== undefined &&
      (yield* canonicalHashV1Result(embeddedBuildMetadata)) !==
        (yield* canonicalHashV1Result({
          sourceRevision: decoded.build.sourceRevision,
          imageRepository: decoded.build.imageRepository,
          strategyBehaviorHash: decoded.build.strategyBehaviorHash,
          strategyParameterHash: decoded.build.strategyParameterHash,
        }))
    )
      return yield* Result.fail(
        new ReplayBrokerFailure({ message: 'Replay build differs from the executable embedded build' }),
      )
    const universe = {
      universeId: protocol.universeId,
      universeSymbolHash: protocol.universeSymbolHash,
      symbols: protocol.universe,
      topics: { ...protocol.sourceTopics, features: protocol.streamingInput.featureTopic },
    }
    if ((yield* canonicalHashV1Result(universe)) !== (yield* canonicalHashV1Result(decoded.source.universe)))
      return yield* Result.fail(
        new ReplayBrokerFailure({ message: 'Replay source universe differs from the strategy universe' }),
      )
    const calendar = yield* normalizeMarketCalendarResult(decoded.calendar, {
      start: decoded.calendar[0]?.date ?? decoded.sessionDate,
      end: decoded.calendar.at(-1)?.date ?? decoded.sessionDate,
    })
    const session = calendar.sessions.find((entry) => entry.date === decoded.sessionDate)
    if (session === undefined)
      return yield* Result.fail(
        new ReplayBrokerFailure({ message: 'Replay session is not in the supplied market calendar' }),
      )
    if (decoded.calendar.some((entry) => entry.date < decoded.sessionDate))
      return yield* Result.fail(
        new ReplayBrokerFailure({ message: 'A fresh single-session replay cannot include prior calendar sessions' }),
      )
    const openMs = Date.parse(session.openAt)
    const closeMs = Date.parse(session.closeAt)
    if (decoded.assetObservationPolicy === 'retained-as-of-session' && Date.parse(decoded.assetObservationAt) > openMs)
      return yield* Result.fail(
        new ReplayBrokerFailure({ message: 'Retained asset observation was not available at market open' }),
      )
    if (
      decoded.source.coverageStartMs > openMs ||
      decoded.source.coverageEndMs < closeMs ||
      decoded.source.firstAvailableAtMs > openMs ||
      decoded.source.lastAvailableAtMs < closeMs
    )
      return yield* Result.fail(
        new ReplayBrokerFailure({ message: 'Frozen source arrivals do not span market open through close' }),
      )
    const assetSymbols = decoded.assets.map((asset) => asset.symbol)
    if (
      new Set(assetSymbols).size !== assetSymbols.length ||
      assetSymbols.length !== protocol.universe.length ||
      protocol.universe.some((symbol) => !assetSymbols.includes(symbol))
    )
      return yield* Result.fail(
        new ReplayBrokerFailure({ message: 'Replay asset metadata is duplicated or misses source symbols' }),
      )
    const assets = yield* Result.all(
      decoded.assets.map((asset) => normalizeAssetResult(asset, asset.symbol, decoded.assetObservationAt)),
    )
    const runId = yield* canonicalHashV1Result({ ...decoded, assets, captureHash: capture.contentHash })
    const identity = yield* makeBrokerIdentity({
      schemaVersion: 'bayn.broker-identity.v2',
      provider: BrokerProvider.Alpaca,
      environment: BrokerEnvironment.Sandbox,
      accountId: `replay-${runId}`,
    })
    const provenance = makeRuntimeProvenance({
      sourceRevision: decoded.build.sourceRevision,
      image: { repository: decoded.build.imageRepository, digest: decoded.build.imageDigest },
      strategy: {
        name: activeStrategyName,
        behaviorHash: activeStrategyBehaviorHash,
        parameterHash,
        parameterSchemaVersion: protocol.schemaVersion,
      },
    })
    return {
      input: decoded,
      capture,
      runId,
      protocol,
      assets,
      identity,
      openMs,
      closeMs,
      buildEvidence: {
        sourceRevision: decoded.build.sourceRevision,
        imageRepository: decoded.build.imageRepository,
        declaredImageDigest: decoded.build.imageDigest,
        imageDigestVerification: 'unverified-input' as const,
        strategyBehaviorHash: decoded.build.strategyBehaviorHash,
        strategyParameterHash: decoded.build.strategyParameterHash,
        sourceAndStrategyVerification:
          embeddedBuildMetadata === undefined ? ('configured' as const) : ('embedded' as const),
      },
      build: {
        ...decoded.build,
        verification: embeddedBuildMetadata === undefined ? ('development-configured' as const) : ('embedded' as const),
      },
      strategy: makeActiveStrategyRuntime(protocol, provenance),
    }
  })
export type PreparedReplaySession = Result.Result.Success<ReturnType<typeof prepareReplaySession>>
export type ReplayDatabaseConfig = Pick<RuntimeConfig, 'postgres' | 'tigerBeetle' | 'operationTimeoutMs'>

export const prepareFreshReplayDatabase = (timeoutMs = 30_000) =>
  Effect.gen(function* () {
    const sql = yield* PgClient.PgClient
    const schema = yield* sql<Record<string, unknown>>`SELECT
    pg_catalog.current_schemas(false) = ARRAY['public']::name[] AS valid`
    if (schema[0]?.['valid'] !== true)
      return yield* new ReplayBrokerFailure({ message: 'Fresh replay requires public as the only effective schema' })
    const existing = yield* sql<Record<string, unknown>>`SELECT EXISTS (
    SELECT 1 FROM pg_catalog.pg_depend d
    WHERE d.refclassid = 'pg_catalog.pg_namespace'::regclass
      AND d.refobjid = 'public'::regnamespace
  ) AS present`
    if (existing[0]?.['present'] !== false)
      return yield* new ReplayBrokerFailure({
        message:
          'Fresh replay requires an unused database with an empty public schema; preserve existing stores for recovery',
      })
    yield* postgresMigrations
  }).pipe(
    operationTimeoutOrElse({
      duration: timeoutMs,
      orElse: () => Effect.fail(new ReplayBrokerFailure({ message: `Replay database setup exceeded ${timeoutMs}ms` })),
    }),
  )

/** Runs one whole calendar session in a fresh isolated database. Broker credentials are not part of this composition. */
export const runRetainedExecutionSession = (
  prepared: PreparedReplaySession,
  arrivalsPath: string,
  databases: ReplayDatabaseConfig,
  recordPass: (pass: Parameters<RecordAutonomousCyclePass>[0]) => Effect.Effect<void, OperationalError>,
) =>
  Effect.gen(function* () {
    const source = yield* openRetainedReplaySource(
      arrivalsPath,
      prepared.input.source,
      prepared.runId,
      prepared.capture,
    )
    const sql = yield* PgClient.PgClient
    yield* prepareFreshReplayDatabase(databases.operationTimeoutMs)
    yield* TestClock.setTime(prepared.openMs - 1)
    const clock = yield* makeSimulatedExecutionClock(prepared.runId, source.source.sourceManifestHash)
    const advanceTo = yield* makeReplayTimeline(source, clock, prepared.closeMs + 1)
    yield* advanceTo(prepared.openMs - 1)
    const broker = yield* makeReplayBroker({
      runId: prepared.runId,
      sourceManifestHash: source.source.sourceManifestHash,
      openingCashMicros: prepared.input.openingCashMicros,
      protocol: prepared.protocol,
      assumptions: prepared.input.assumptions,
      fractionalTrading: prepared.input.fractionalTrading,
      assets: prepared.assets,
      calendar: prepared.input.calendar,
      advanceToArrival: advanceTo,
      quoteAt: (symbol) => source.cursor.pipe(Effect.map((cursor) => cursor.projection.quotes.get(symbol))),
    })
    const runtime = yield* makeReplayExecutionRuntime({
      config: {
        ...databases,
        build: prepared.build,
        reconciliationStaleThresholdMs: prepared.input.cadence.reconciliationStaleThresholdMs,
        execution: {
          brokerIdentity: prepared.identity,
          brokerAccess: BrokerAccess.ReadOnly,
          capitalAuthority: noCapitalAuthority,
        },
      },
      strategy: prepared.strategy,
      broker,
      source: source.source,
      cursor: source.cursor,
      clock,
      recordPass: () => Effect.void,
      ...prepared.input.cadence,
    })
    const schedule = yield* driveReplaySession(
      { ...runtime, advance: runtime.advance.pipe(Effect.tap((pass) => recordPass(pass.observation))) },
      advanceTo,
      prepared.openMs,
      prepared.closeMs,
    )
    const closingEquity = yield* broker.completeSession(prepared.input.sessionDate)
    // Activities use an exclusive upper timestamp. Observe one millisecond after the terminal market boundary.
    yield* advanceTo(prepared.closeMs + 1)
    const reconciliation = yield* runtime.reconcile
    const brokerState = yield* broker.snapshot
    // Consume and rehash any retained tail only after the final decision; it cannot affect execution inputs.
    yield* source.finish
    const rows = yield* sql<Record<string, unknown>>`SELECT
    (SELECT count(*)::int FROM intents WHERE account_id = ${broker.accountId}) AS intents,
    (SELECT count(*)::int FROM fills WHERE account_id = ${broker.accountId}) AS fills,
    (SELECT count(*)::int FROM accounting_transactions WHERE account_id = ${broker.accountId}) AS transactions`
    const report = {
      schemaVersion: 'bayn.execution-replay-session-report.v1' as const,
      evidenceMode: 'simulated-production-execution' as const,
      profitability: 'UNPROVEN' as const,
      runId: prepared.runId,
      source: source.source,
      sessionDate: prepared.input.sessionDate,
      captureHash: prepared.capture.contentHash,
      build: prepared.buildEvidence,
      assumptions: prepared.input.assumptions,
      schedule,
      closingEquity,
      brokerState,
      reconciliation,
      durableCounts: rows[0],
      processedRecords: (yield* source.cursor).processedRecords,
    }
    return { ...report, reportHash: yield* Effect.fromResult(canonicalHashV1Result(report)) }
  })
