import { ClickhouseClient } from '@effect/sql-clickhouse'
import { Clock, Context, Effect, Layer, Option, Result, Schema, pipe } from 'effect'
import { isSqlError, type SqlError } from 'effect/unstable/sql/SqlError'

import type { RuntimeConfig } from './config'
import type { EvaluationBounds, FinalizedSnapshotProvenance } from './contracts'
import { OperationalError, operationalError, retryableOperationalError } from './errors'
import {
  decodeSignalCount,
  renderMarketDataVerificationError,
  selectCyclePublicationManifests,
  selectPublicationManifest,
  verifyFinalizedCalendar,
  verifyFinalizedManifest,
  verifyFinalizedSnapshot,
  verifyBoundFinalizedPublication,
  verifyCyclePublications,
  type MarketDataVerificationError,
} from './market-data-verification'
import {
  DigitsSchema,
  GitSourceRevisionSchema as SourceRevisionSchema,
  ImageDigestSchema,
  ImageRepositorySchema,
  IsoDateSchema,
  Sha256Schema as HashSchema,
  SignalRowSymbolSchema as SymbolSchema,
  UniverseIdSchema,
  strictParseOptions as StrictParseOptions,
} from './schemas'
import {
  DataFeed,
  DataSource,
  PriceAdjustment,
  PublicationSchema,
  type DailyBar,
  type InputManifest,
  type IsoDate,
  type Protocol,
} from './types'

export {
  renderMarketDataVerificationError,
  selectCyclePublicationManifests,
  selectPublicationManifest,
  verifyFinalizedCalendar,
  verifyFinalizedManifest,
  verifyFinalizedPublication,
  verifyFinalizedSnapshot,
  verifyBoundFinalizedPublication,
  verifyCyclePublications,
  type MarketDataVerificationError,
} from './market-data-verification'

const calendarTimeZone = 'America/New_York' as const
// A 21-calendar-day catch-up interval contains at most 15 weekday publications. One extra bounded row keeps the
// MarketData seam complete while the runner clamps by calendar date before its single broker-calendar read.
const cyclePublicationCandidateLimit = 16
const SnapshotIdSchema = HashSchema
const FixedDecimalSchema = Schema.String.check(Schema.isPattern(/^(?:0|[1-9]\d*)\.\d{8}$/))
const MarketTimeSchema = Schema.String.check(Schema.isPattern(/^(?:0\d|1\d|2[0-3]):[0-5]\d$/))
const CountSchema = Schema.Union([Schema.Finite, DigitsSchema])
const FinalizedAtSchema = Schema.String.check(
  Schema.isPattern(/^\d{4}-\d{2}-\d{2} (?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d\.\d{3}$/),
)

const SignalBarRowSchema = Schema.Struct({
  snapshot_id: SnapshotIdSchema,
  symbol: SymbolSchema,
  session_date: IsoDateSchema,
  adjusted_open: FixedDecimalSchema,
  adjusted_high: FixedDecimalSchema,
  adjusted_low: FixedDecimalSchema,
  adjusted_close: FixedDecimalSchema,
  adjusted_volume: FixedDecimalSchema,
  trade_count: DigitsSchema,
  vwap: Schema.NullOr(FixedDecimalSchema),
  provider: Schema.Enum(DataSource),
  source_feed: Schema.Enum(DataFeed),
  adjustment: Schema.Enum(PriceAdjustment),
  publication_asof: IsoDateSchema,
})
const SignalSessionRowSchema = Schema.Struct({
  snapshot_id: SnapshotIdSchema,
  calendar_version: Schema.Trim.check(Schema.isMinLength(1)),
  session_date: IsoDateSchema,
  open_time: MarketTimeSchema,
  close_time: MarketTimeSchema,
  timezone: Schema.Literal(calendarTimeZone),
  provider: Schema.Enum(DataSource),
})
const SignalManifestFields = {
  snapshot_id: SnapshotIdSchema,
  publisher_source_revision: SourceRevisionSchema,
  publisher_image_repository: ImageRepositorySchema,
  publisher_image_digest: ImageDigestSchema,
  provider: Schema.Enum(DataSource),
  source_feed: Schema.Enum(DataFeed),
  adjustment: Schema.Enum(PriceAdjustment),
  calendar_version: Schema.Trim.check(Schema.isMinLength(1)),
  requested_start: IsoDateSchema,
  publication_asof: IsoDateSchema,
  first_session: IsoDateSchema,
  last_session: IsoDateSchema,
  symbol_count: CountSchema,
  session_count: CountSchema,
  bar_count: CountSchema,
  bars_content_hash: HashSchema,
  sessions_content_hash: HashSchema,
  manifest_content_hash: HashSchema,
  finalized_at: FinalizedAtSchema,
} as const
const SignalManifestRowSchema = Schema.Struct({
  schema_version: Schema.Literal(PublicationSchema.AdjustedDailySnapshotV2),
  universe_id: UniverseIdSchema,
  universe_symbol_hash: HashSchema,
  ...SignalManifestFields,
})

export type SignalBarRow = typeof SignalBarRowSchema.Type
export type SignalSessionRow = typeof SignalSessionRowSchema.Type
export type SignalManifestRow = Omit<
  typeof SignalManifestRowSchema.Type,
  'symbol_count' | 'session_count' | 'bar_count'
> & {
  readonly symbol_count: number
  readonly session_count: number
  readonly bar_count: number
}

export interface SnapshotRows {
  readonly bars: readonly SignalBarRow[]
  readonly sessions: readonly SignalSessionRow[]
  readonly manifests: readonly SignalManifestRow[]
}

export interface SnapshotRequest {
  readonly snapshotId: string
  readonly publicationAsOf: string
  readonly calendarVersion: string
  readonly universe: readonly string[]
  readonly bounds: EvaluationBounds
  readonly observedAt: string
  readonly universeId: FinalizedSnapshotProvenance['universeId']
  readonly universeSymbolHash: string
  readonly historyStart: IsoDate
  readonly evaluationStart: IsoDate
}

export type MarketDataContract = Pick<
  Protocol,
  'universeId' | 'universeSymbolHash' | 'universe' | 'historyStart' | 'evaluationStart'
>

export interface MarketDataSnapshot {
  readonly bars: readonly DailyBar[]
  readonly manifest: InputManifest
}

export type VerifiedSignalSession = Pick<
  SignalSessionRow,
  'calendar_version' | 'session_date' | 'close_time' | 'timezone'
>

export interface MarketDataInspection {
  readonly manifest: InputManifest
  readonly sessionDates: readonly IsoDate[]
  readonly signalSession: VerifiedSignalSession
}

export interface FinalizedPublicationRequest {
  readonly signalSessionDate: IsoDate
  readonly signalCalendarVersion: string
}

export interface SnapshotPublicationRequest extends FinalizedPublicationRequest {
  readonly snapshotId: string
}

export type FinalizedPublicationInspection =
  | {
      readonly outcome: 'MISSING'
      readonly observedAt: string
    }
  | {
      readonly outcome: 'FINALIZED'
      readonly observedAt: string
      readonly inspection: MarketDataInspection
    }

export type FinalizedPublicationDiscovery =
  | {
      readonly outcome: 'MISSING'
      readonly observedAt: string
    }
  | {
      readonly outcome: 'FINALIZED'
      readonly observedAt: string
      readonly publications: readonly MarketDataInspection[]
    }

export interface MarketDataService {
  readonly check: Effect.Effect<FinalizedSnapshotProvenance, OperationalError>
  readonly inspect: Effect.Effect<MarketDataInspection, OperationalError>
  readonly inspectCyclePublications: Effect.Effect<FinalizedPublicationDiscovery, OperationalError>
  readonly inspectPublication: (
    request: FinalizedPublicationRequest,
  ) => Effect.Effect<FinalizedPublicationInspection, OperationalError>
  readonly inspectSnapshotPublication: (
    request: SnapshotPublicationRequest,
  ) => Effect.Effect<FinalizedPublicationInspection, OperationalError>
  readonly loadSnapshotPublication: (
    request: SnapshotPublicationRequest,
  ) => Effect.Effect<MarketDataSnapshot, OperationalError>
  readonly load: Effect.Effect<MarketDataSnapshot, OperationalError>
}

export type MarketData = {
  readonly MarketData: unique symbol
  readonly Service: MarketDataService
}

export const MarketData = Context.Service<MarketData, MarketDataService>('bayn/MarketData')

export const marketDataOperationError = (
  operation: 'check' | 'inspect' | 'inspect-publication' | 'load',
  message: string,
  cause: unknown,
): OperationalError => {
  if (cause instanceof OperationalError) return cause
  const makeError = isSqlError(cause) && !cause.isRetryable ? operationalError : retryableOperationalError
  return makeError('market-data', operation, message, cause)
}

const decodeBars = (rows: readonly unknown[]): Result.Result<readonly SignalBarRow[], MarketDataVerificationError> =>
  pipe(
    Schema.decodeUnknownResult(Schema.Array(SignalBarRowSchema), StrictParseOptions)(rows),
    Result.mapError(
      (cause): MarketDataVerificationError => ({
        _tag: 'RowDecodeFailed',
        rows: 'bars',
        cause,
      }),
    ),
  )

const decodeSessions = (
  rows: readonly unknown[],
): Result.Result<readonly SignalSessionRow[], MarketDataVerificationError> =>
  pipe(
    Schema.decodeUnknownResult(Schema.Array(SignalSessionRowSchema), StrictParseOptions)(rows),
    Result.mapError(
      (cause): MarketDataVerificationError => ({
        _tag: 'RowDecodeFailed',
        rows: 'sessions',
        cause,
      }),
    ),
  )

const decodeManifests = (
  rows: readonly unknown[],
): Result.Result<readonly SignalManifestRow[], MarketDataVerificationError> =>
  pipe(
    Schema.decodeUnknownResult(Schema.Array(SignalManifestRowSchema), StrictParseOptions)(rows),
    Result.mapError(
      (cause): MarketDataVerificationError => ({
        _tag: 'RowDecodeFailed',
        rows: 'manifests',
        cause,
      }),
    ),
    Result.flatMap((manifests) =>
      Result.all(
        manifests.map((manifest) =>
          pipe(
            Result.all({
              symbol_count: decodeSignalCount(manifest.symbol_count, 'symbol_count'),
              session_count: decodeSignalCount(manifest.session_count, 'session_count'),
              bar_count: decodeSignalCount(manifest.bar_count, 'bar_count'),
            }),
            Result.map((counts): SignalManifestRow => ({ ...manifest, ...counts })),
          ),
        ),
      ),
    ),
  )

const decodeSnapshotRows = (
  bars: readonly unknown[],
  sessions: readonly unknown[],
  manifests: readonly unknown[],
): Result.Result<SnapshotRows, MarketDataVerificationError> =>
  Result.all({
    bars: decodeBars(bars),
    sessions: decodeSessions(sessions),
    manifests: decodeManifests(manifests),
  })

const makeMarketData = (
  config: Pick<RuntimeConfig, 'clickhouse' | 'operationTimeoutMs'>,
  contract: MarketDataContract,
): Effect.Effect<MarketDataService, never, ClickhouseClient.ClickhouseClient> =>
  pipe(
    ClickhouseClient.ClickhouseClient,
    Effect.map((sql): MarketDataService => {
      // The Bayn principal is readonly=1, so query-level setting changes are forbidden. Snapshot counts and content
      // hashes below make an incomplete or stale replica read fail closed.
      const loadManifests = sql`
        SELECT
          snapshot_id,
          schema_version,
          publisher_source_revision,
          publisher_image_repository,
          publisher_image_digest,
          universe_id,
          universe_symbol_hash,
          provider,
          source_feed,
          adjustment,
          calendar_version,
          toString(requested_start) AS requested_start,
          toString(publication_asof) AS publication_asof,
          toString(first_session) AS first_session,
          toString(last_session) AS last_session,
          symbol_count,
          session_count,
          bar_count,
          bars_content_hash,
          sessions_content_hash,
          manifest_content_hash,
          toString(finalized_at) AS finalized_at
        FROM signal.snapshot_manifests_v2
        WHERE snapshot_id = ${sql.param('String', config.clickhouse.snapshotId)}
        ORDER BY finalized_at
      `.pipe(sql.withQueryId(`bayn-manifest-${config.clickhouse.snapshotId.slice(-32)}`))
      const loadSessions = sql`
            SELECT
              snapshot_id,
              calendar_version,
              toString(session_date) AS session_date,
              open_time,
              close_time,
              timezone,
              provider
            FROM signal.exchange_sessions_v1
            WHERE snapshot_id = ${sql.param('String', config.clickhouse.snapshotId)}
            ORDER BY session_date
          `.pipe(sql.withQueryId(`bayn-sessions-${config.clickhouse.snapshotId.slice(-32)}`))
      const loadBars = sql`
            SELECT
              snapshot_id,
              symbol,
              toString(session_date) AS session_date,
              toDecimalString(adjusted_open, 8) AS adjusted_open,
              toDecimalString(adjusted_high, 8) AS adjusted_high,
              toDecimalString(adjusted_low, 8) AS adjusted_low,
              toDecimalString(adjusted_close, 8) AS adjusted_close,
              toDecimalString(adjusted_volume, 8) AS adjusted_volume,
              toString(trade_count) AS trade_count,
              if(isNull(vwap), NULL, toDecimalString(vwap, 8)) AS vwap,
              provider,
              source_feed,
              adjustment,
              toString(publication_asof) AS publication_asof
            FROM signal.adjusted_daily_bars_v2
            WHERE snapshot_id = ${sql.param('String', config.clickhouse.snapshotId)}
            ORDER BY session_date, symbol
          `.pipe(sql.withQueryId(`bayn-bars-${config.clickhouse.snapshotId.slice(-32)}`))

      const loadPublicationManifests = (request: FinalizedPublicationRequest) =>
        sql`
        SELECT
          snapshot_id,
          schema_version,
          publisher_source_revision,
          publisher_image_repository,
          publisher_image_digest,
          universe_id,
          universe_symbol_hash,
          provider,
          source_feed,
          adjustment,
          calendar_version,
          toString(requested_start) AS requested_start,
          toString(publication_asof) AS publication_asof,
          toString(first_session) AS first_session,
          toString(last_session) AS last_session,
          symbol_count,
          session_count,
          bar_count,
          bars_content_hash,
          sessions_content_hash,
          manifest_content_hash,
          toString(finalized_at) AS finalized_at
        FROM signal.snapshot_manifests_v2
        WHERE universe_id = ${sql.param('String', contract.universeId)}
          AND universe_symbol_hash = ${sql.param('String', contract.universeSymbolHash)}
          AND requested_start = toDate(${sql.param('String', contract.historyStart)})
          AND publication_asof = toDate(${sql.param('String', request.signalSessionDate)})
          AND calendar_version = ${sql.param('String', request.signalCalendarVersion)}
        ORDER BY finalized_at DESC, snapshot_id DESC
        LIMIT 1
      `.pipe(sql.withQueryId(`bayn-cycle-manifest-${request.signalSessionDate}`))

      const loadCyclePublicationManifests = sql`
      SELECT
        snapshot_id,
        schema_version,
        publisher_source_revision,
        publisher_image_repository,
        publisher_image_digest,
        universe_id,
        universe_symbol_hash,
        provider,
        source_feed,
        adjustment,
        calendar_version,
        toString(requested_start) AS requested_start,
        toString(publication_asof) AS publication_asof,
        toString(first_session) AS first_session,
        toString(last_session) AS last_session,
        symbol_count,
        session_count,
        bar_count,
        bars_content_hash,
        sessions_content_hash,
        manifest_content_hash,
        toString(finalized_at) AS finalized_at
      FROM signal.snapshot_manifests_v2
      WHERE universe_id = ${sql.param('String', contract.universeId)}
        AND universe_symbol_hash = ${sql.param('String', contract.universeSymbolHash)}
        AND requested_start = toDate(${sql.param('String', contract.historyStart)})
      ORDER BY publication_asof DESC, finalized_at DESC, snapshot_id DESC
      LIMIT 1 BY publication_asof
      LIMIT ${sql.param('UInt8', cyclePublicationCandidateLimit)}
    `.pipe(sql.withQueryId('bayn-cycle-publication-candidates'))

      const loadSnapshotPublicationManifest = (request: SnapshotPublicationRequest) =>
        sql`
        SELECT
          snapshot_id,
          schema_version,
          publisher_source_revision,
          publisher_image_repository,
          publisher_image_digest,
          universe_id,
          universe_symbol_hash,
          provider,
          source_feed,
          adjustment,
          calendar_version,
          toString(requested_start) AS requested_start,
          toString(publication_asof) AS publication_asof,
          toString(first_session) AS first_session,
          toString(last_session) AS last_session,
          symbol_count,
          session_count,
          bar_count,
          bars_content_hash,
          sessions_content_hash,
          manifest_content_hash,
          toString(finalized_at) AS finalized_at
        FROM signal.snapshot_manifests_v2
        WHERE snapshot_id = ${sql.param('String', request.snapshotId)}
        ORDER BY finalized_at
      `.pipe(sql.withQueryId(`bayn-bound-manifest-${request.snapshotId.slice(-32)}`))

      const loadPublicationSessions = (snapshotId: string) =>
        sql`
        SELECT
          snapshot_id,
          calendar_version,
          toString(session_date) AS session_date,
          open_time,
          close_time,
          timezone,
          provider
        FROM signal.exchange_sessions_v1
        WHERE snapshot_id = ${sql.param('String', snapshotId)}
        ORDER BY session_date
      `.pipe(sql.withQueryId(`bayn-cycle-sessions-${snapshotId.slice(-32)}`))

      const loadSnapshotPublicationBars = (snapshotId: string) =>
        sql`
        SELECT
          snapshot_id,
          symbol,
          toString(session_date) AS session_date,
          toDecimalString(adjusted_open, 8) AS adjusted_open,
          toDecimalString(adjusted_high, 8) AS adjusted_high,
          toDecimalString(adjusted_low, 8) AS adjusted_low,
          toDecimalString(adjusted_close, 8) AS adjusted_close,
          toDecimalString(adjusted_volume, 8) AS adjusted_volume,
          toString(trade_count) AS trade_count,
          if(isNull(vwap), NULL, toDecimalString(vwap, 8)) AS vwap,
          provider,
          source_feed,
          adjustment,
          toString(publication_asof) AS publication_asof
        FROM signal.adjusted_daily_bars_v2
        WHERE snapshot_id = ${sql.param('String', snapshotId)}
        ORDER BY session_date, symbol
      `.pipe(sql.withQueryId(`bayn-bound-bars-${snapshotId.slice(-32)}`))

      const loadCyclePublicationSessions = (snapshotIds: readonly string[]) =>
        sql`
        SELECT
          snapshot_id,
          calendar_version,
          toString(session_date) AS session_date,
          open_time,
          close_time,
          timezone,
          provider
        FROM signal.exchange_sessions_v1
        WHERE has(${sql.param('Array(String)', snapshotIds)}, snapshot_id)
        ORDER BY snapshot_id, session_date
      `.pipe(sql.withQueryId('bayn-cycle-publication-candidate-sessions'))

      const request = (observedAt: string): SnapshotRequest => {
        const common = {
          snapshotId: config.clickhouse.snapshotId,
          publicationAsOf: config.clickhouse.publicationAsOf,
          calendarVersion: config.clickhouse.calendarVersion,
          universe: contract.universe,
          bounds: config.clickhouse.bounds,
          observedAt,
        } as const
        return {
          ...common,
          universeId: contract.universeId,
          universeSymbolHash: contract.universeSymbolHash,
          historyStart: contract.historyStart,
          evaluationStart: contract.evaluationStart,
        }
      }
      const snapshotPublicationRequest = (input: SnapshotPublicationRequest, observedAt: string): SnapshotRequest => ({
        snapshotId: input.snapshotId,
        publicationAsOf: input.signalSessionDate,
        calendarVersion: input.signalCalendarVersion,
        universe: contract.universe,
        bounds: {
          schemaVersion: 'bayn.evaluation-bounds.v1',
          dataStart: contract.historyStart,
          dataEnd: input.signalSessionDate,
          lookbackStart: contract.historyStart,
          evaluationStart: contract.evaluationStart,
          evaluationEnd: input.signalSessionDate,
        },
        observedAt,
        universeId: contract.universeId,
        universeSymbolHash: contract.universeSymbolHash,
        historyStart: contract.historyStart,
        evaluationStart: contract.evaluationStart,
      })
      const verify = <A>(
        operation: 'check' | 'inspect' | 'inspect-publication' | 'verify',
        result: Result.Result<A, MarketDataVerificationError>,
      ): Effect.Effect<A, OperationalError> =>
        pipe(
          Effect.fromResult(result),
          Effect.mapError(
            (cause) =>
              new OperationalError({
                component: 'market-data',
                operation,
                message: renderMarketDataVerificationError(cause),
                retryable: false,
                cause,
              }),
          ),
        )

      const observedAt = pipe(
        Clock.currentTimeMillis,
        Effect.map((millis) => new Date(millis).toISOString()),
      )

      const decodeManifestRows = (
        rows: readonly unknown[],
      ): Result.Result<readonly SignalManifestRow[], MarketDataVerificationError> =>
        pipe(
          decodeSnapshotRows([], [], rows),
          Result.map((snapshot) => snapshot.manifests),
        )

      const inspectPublicationRows = (
        input: FinalizedPublicationRequest,
        manifestRows: readonly unknown[],
        expectedSnapshotId?: string,
      ): Effect.Effect<FinalizedPublicationInspection, OperationalError | SqlError> =>
        pipe(
          decodeManifestRows(manifestRows),
          Result.flatMap((manifests) => selectPublicationManifest(manifests, expectedSnapshotId)),
          (result) => verify('inspect-publication', result),
          Effect.flatMap((manifest) =>
            pipe(
              Option.fromNullishOr(manifest),
              Option.match({
                onNone: () =>
                  pipe(
                    observedAt,
                    Effect.map(
                      (instant): FinalizedPublicationInspection => ({ outcome: 'MISSING', observedAt: instant }),
                    ),
                  ),
                onSome: (selected) =>
                  pipe(
                    loadPublicationSessions(selected.snapshot_id),
                    Effect.flatMap((sessionRows) =>
                      pipe(
                        observedAt,
                        Effect.flatMap((inspectedAt) =>
                          pipe(
                            decodeSnapshotRows([], sessionRows, manifestRows),
                            Result.flatMap((rows) =>
                              verifyBoundFinalizedPublication(rows, input, contract, inspectedAt, expectedSnapshotId),
                            ),
                            (result) => verify('inspect-publication', result),
                            Effect.map(
                              (inspection): FinalizedPublicationInspection => ({
                                outcome: 'FINALIZED',
                                observedAt: inspectedAt,
                                inspection,
                              }),
                            ),
                          ),
                        ),
                      ),
                    ),
                  ),
              }),
            ),
          ),
        )

      const inspectCyclePublicationRows = (
        manifestRows: readonly unknown[],
      ): Effect.Effect<FinalizedPublicationDiscovery, OperationalError | SqlError> =>
        pipe(
          decodeManifestRows(manifestRows),
          Result.flatMap((manifests) => selectCyclePublicationManifests(manifests, cyclePublicationCandidateLimit)),
          (result) => verify('inspect-publication', result),
          Effect.flatMap((manifests) =>
            pipe(
              Option.fromNullishOr(manifests[0]),
              Option.match({
                onNone: () =>
                  pipe(
                    observedAt,
                    Effect.map(
                      (instant): FinalizedPublicationDiscovery => ({ outcome: 'MISSING', observedAt: instant }),
                    ),
                  ),
                onSome: () => {
                  const snapshotIds = manifests.map((manifest) => manifest.snapshot_id)
                  return pipe(
                    loadCyclePublicationSessions(snapshotIds),
                    Effect.flatMap((sessionRows) =>
                      pipe(
                        observedAt,
                        Effect.flatMap((inspectedAt) =>
                          pipe(
                            decodeSnapshotRows([], sessionRows, []),
                            Result.flatMap((rows) =>
                              verifyCyclePublications(manifests, rows.sessions, contract, inspectedAt),
                            ),
                            (result) => verify('inspect-publication', result),
                            Effect.map(
                              (publications): FinalizedPublicationDiscovery => ({
                                outcome: 'FINALIZED',
                                observedAt: inspectedAt,
                                publications,
                              }),
                            ),
                          ),
                        ),
                      ),
                    ),
                  )
                },
              }),
            ),
          ),
        )

      return {
        check: pipe(
          observedAt,
          Effect.flatMap((instant) =>
            pipe(
              loadManifests,
              Effect.flatMap((manifests) =>
                pipe(
                  decodeSnapshotRows([], [], manifests),
                  Result.flatMap((rows) => verifyFinalizedManifest(rows.manifests, request(instant))),
                  (result) => verify('check', result),
                ),
              ),
            ),
          ),
          Effect.mapError((cause) =>
            marketDataOperationError('check', 'failed to check finalized Signal snapshot', cause),
          ),
        ),
        inspect: pipe(
          observedAt,
          Effect.flatMap((instant) =>
            pipe(
              Effect.all({ manifests: loadManifests, sessions: loadSessions }, { concurrency: 2 }),
              Effect.flatMap(({ manifests, sessions }) =>
                pipe(
                  decodeSnapshotRows([], sessions, manifests),
                  Result.flatMap((rows) => verifyFinalizedCalendar(rows, request(instant))),
                  (result) => verify('inspect', result),
                ),
              ),
            ),
          ),
          Effect.mapError((cause) =>
            marketDataOperationError('inspect', 'failed to inspect finalized Signal calendar', cause),
          ),
        ),
        inspectCyclePublications: loadCyclePublicationManifests.pipe(
          Effect.flatMap(inspectCyclePublicationRows),
          Effect.mapError((cause) =>
            marketDataOperationError(
              'inspect-publication',
              'failed to inspect bounded finalized Signal publication candidates',
              cause,
            ),
          ),
        ),
        inspectPublication: (input) =>
          loadPublicationManifests(input).pipe(
            Effect.flatMap((manifestRows) => inspectPublicationRows(input, manifestRows)),
            Effect.mapError((cause) =>
              marketDataOperationError(
                'inspect-publication',
                `failed to inspect finalized Signal publication for ${input.signalSessionDate}`,
                cause,
              ),
            ),
          ),
        inspectSnapshotPublication: (input) =>
          loadSnapshotPublicationManifest(input).pipe(
            Effect.flatMap((manifestRows) => inspectPublicationRows(input, manifestRows, input.snapshotId)),
            Effect.mapError((cause) =>
              marketDataOperationError(
                'inspect-publication',
                `failed to inspect bound finalized Signal publication ${input.snapshotId}`,
                cause,
              ),
            ),
          ),
        loadSnapshotPublication: (input) =>
          pipe(
            Effect.all(
              {
                manifests: loadSnapshotPublicationManifest(input),
                sessions: loadPublicationSessions(input.snapshotId),
                bars: loadSnapshotPublicationBars(input.snapshotId),
              },
              { concurrency: 3 },
            ),
            Effect.flatMap(({ bars, manifests, sessions }) =>
              pipe(
                observedAt,
                Effect.flatMap((instant) =>
                  pipe(
                    decodeSnapshotRows(bars, sessions, manifests),
                    Result.flatMap((rows) => verifyFinalizedSnapshot(rows, snapshotPublicationRequest(input, instant))),
                    (result) => verify('verify', result),
                  ),
                ),
              ),
            ),
            Effect.mapError((cause) =>
              marketDataOperationError(
                'load',
                `failed to load bound finalized Signal snapshot ${input.snapshotId}`,
                cause,
              ),
            ),
          ),
        load: pipe(
          observedAt,
          Effect.flatMap((instant) =>
            pipe(
              Effect.all({ manifests: loadManifests, sessions: loadSessions, bars: loadBars }, { concurrency: 3 }),
              Effect.flatMap(({ bars, manifests, sessions }) =>
                pipe(
                  decodeSnapshotRows(bars, sessions, manifests),
                  Result.flatMap((rows) => verifyFinalizedSnapshot(rows, request(instant))),
                  (result) => verify('verify', result),
                ),
              ),
            ),
          ),
          Effect.mapError((cause) =>
            marketDataOperationError('load', 'failed to load finalized Signal snapshot', cause),
          ),
        ),
      }
    }),
  )

export const MarketDataLive = (
  config: Pick<RuntimeConfig, 'clickhouse' | 'operationTimeoutMs'>,
  contract: MarketDataContract,
): Layer.Layer<MarketData, never, ClickhouseClient.ClickhouseClient> =>
  Layer.effect(MarketData, makeMarketData(config, contract))
