import { ClickhouseClient } from '@effect/sql-clickhouse'
import { Clock, Context, Effect, Layer, Schema } from 'effect'

import type { RuntimeConfig } from './config'
import { type EvaluationBounds, type FinalizedSnapshotProvenance, FinalizedSnapshotProvenanceSchema } from './contracts'
import { OperationalError, operationalError } from './errors'
import { canonicalHashV1, sha256 } from './hash'
import {
  DataFeed,
  DataSource,
  PriceAdjustment,
  PublicationSchema,
  type DailyBar,
  type InputManifest,
  type IsoDate,
  type Protocol,
  type SymbolCoverage,
} from './types'

const database = 'signal' as const
const tables = {
  bars: 'adjusted_daily_bars_v2',
  sessions: 'exchange_sessions_v1',
  manifests: 'snapshot_manifests_v2',
} as const
const calendarTimeZone = 'America/New_York' as const
const StrictParseOptions = { onExcessProperty: 'error' } as const

const isIsoDate = (value: string): value is IsoDate => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  const parsed = new Date(`${value}T00:00:00.000Z`)
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value
}
const IsoDateSchema = Schema.String.pipe(Schema.refine(isIsoDate, { expected: 'a valid ISO date (YYYY-MM-DD)' }))
const SnapshotIdSchema = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/))
const HashSchema = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/))
const SourceRevisionSchema = Schema.String.check(Schema.isPattern(/^[a-f0-9]{40}$/))
const ImageRepositorySchema = Schema.String.check(Schema.isPattern(/^[a-z0-9.-]+(?::[0-9]+)?\/[a-z0-9._/-]+$/))
const ImageDigestSchema = Schema.String.check(Schema.isPattern(/^sha256:[a-f0-9]{64}$/))
const SymbolSchema = Schema.String.check(Schema.isPattern(/^[A-Z][A-Z0-9.-]{0,14}$/))
const FixedDecimalSchema = Schema.String.check(Schema.isPattern(/^(?:0|[1-9]\d*)\.\d{8}$/))
const DigitsSchema = Schema.String.check(Schema.isPattern(/^\d+$/))
const MarketTimeSchema = Schema.String.check(Schema.isPattern(/^(?:0\d|1\d|2[0-3]):[0-5]\d$/))
const CountSchema = Schema.Union([Schema.Number, DigitsSchema])
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
  universe_id: Schema.Literal('equity-infrastructure-v1'),
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
  readonly universeId: 'equity-infrastructure-v1'
  readonly universeSymbolHash: string
  readonly historyStart: IsoDate
  readonly evaluationStart: IsoDate
}

type MarketDataContract = Pick<
  Protocol,
  'universeId' | 'universeSymbolHash' | 'universe' | 'historyStart' | 'evaluationStart'
>

export interface MarketDataSnapshot {
  readonly bars: readonly DailyBar[]
  readonly manifest: InputManifest
}

export interface MarketDataInspection {
  readonly manifest: InputManifest
  readonly sessionDates: readonly IsoDate[]
}

export interface MarketDataService {
  readonly check: Effect.Effect<FinalizedSnapshotProvenance, OperationalError>
  readonly inspect: Effect.Effect<MarketDataInspection, OperationalError>
  readonly load: Effect.Effect<MarketDataSnapshot, OperationalError>
}

export class MarketData extends Context.Service<MarketData, MarketDataService>()('bayn/MarketData') {}

const asCount = (value: string | number, name: string): number => {
  const parsed = typeof value === 'number' ? value : Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error(`${name} is not a safe non-negative integer`)
  return parsed
}

const decodeBars = Schema.decodeUnknownSync(Schema.Array(SignalBarRowSchema), StrictParseOptions)
const decodeSessions = Schema.decodeUnknownSync(Schema.Array(SignalSessionRowSchema), StrictParseOptions)
const decodeManifests = Schema.decodeUnknownSync(Schema.Array(SignalManifestRowSchema), StrictParseOptions)
const decodeFinalizedSnapshot = Schema.decodeUnknownSync(FinalizedSnapshotProvenanceSchema, StrictParseOptions)

const canonicalUniverse = (universe: readonly string[]): readonly string[] => {
  const canonical = [...new Set(universe)].sort()
  if (canonical.length === 0 || canonical.length !== universe.length) {
    throw new Error('evaluation universe must be non-empty and unique')
  }
  if (canonical.some((symbol, index) => symbol !== universe[index])) {
    throw new Error('evaluation universe must use canonical sorted order')
  }
  return canonical
}

const withoutSnapshot = <A extends { readonly snapshot_id: string }>({ snapshot_id: _, ...row }: A) => row
const withoutManifestHash = ({ manifest_content_hash: _, ...manifest }: SignalManifestRow) => manifest

const toUtcInstant = (value: string): string => `${value.replace(' ', 'T')}Z`

const toNumber = (value: string, name: string, positive: boolean): number => {
  const parsed = Number(value)
  if (!Number.isFinite(parsed) || (positive ? parsed <= 0 : parsed < 0)) {
    throw new Error(`${name} must be a finite ${positive ? 'positive' : 'non-negative'} number`)
  }
  return parsed
}

const toDailyBar = (row: SignalBarRow, publicationSchemaVersion: PublicationSchema): DailyBar => {
  const bar: DailyBar = {
    symbol: row.symbol,
    sessionDate: row.session_date,
    open: toNumber(row.adjusted_open, 'adjusted_open', true),
    high: toNumber(row.adjusted_high, 'adjusted_high', true),
    low: toNumber(row.adjusted_low, 'adjusted_low', true),
    close: toNumber(row.adjusted_close, 'adjusted_close', true),
    volume: toNumber(row.adjusted_volume, 'adjusted_volume', false),
    source: row.provider,
    sourceFeed: row.source_feed,
    adjustment: row.adjustment,
    publicationSchemaVersion,
  }
  if (bar.low > Math.min(bar.open, bar.close) || bar.high < Math.max(bar.open, bar.close) || bar.low > bar.high) {
    throw new Error(`${bar.symbol} ${bar.sessionDate} contains inconsistent OHLC prices`)
  }
  return bar
}

const assertBoundSessions = (sessions: ReadonlySet<string>, bounds: EvaluationBounds): void => {
  for (const [name, value] of Object.entries(bounds)) {
    if (name === 'schemaVersion') continue
    if (!sessions.has(value)) throw new Error(`${name} ${value} is not an exchange session in the snapshot`)
  }
}

interface VerifiedManifest {
  readonly manifest: SignalManifestRow
  readonly finalizedSnapshot: FinalizedSnapshotProvenance
  readonly universe: readonly string[]
}

const verifyManifest = (manifests: readonly SignalManifestRow[], request: SnapshotRequest): VerifiedManifest => {
  const universe = canonicalUniverse(request.universe)
  if (manifests.length !== 1) {
    throw new Error(`snapshot ${request.snapshotId} has ${manifests.length} manifests; expected exactly one`)
  }
  const manifest = manifests[0]
  if (manifest.snapshot_id !== request.snapshotId) throw new Error('manifest snapshot ID does not match request')
  if (manifest.calendar_version !== request.calendarVersion) throw new Error('manifest calendar version does not match')
  if (manifest.publication_asof !== request.publicationAsOf) {
    throw new Error(
      `snapshot publication ${manifest.publication_asof} does not match expected session ${request.publicationAsOf}`,
    )
  }
  const finalizedAt = toUtcInstant(manifest.finalized_at)
  if (finalizedAt > request.observedAt) throw new Error('snapshot finalization is in the future')
  if (manifest.manifest_content_hash !== canonicalHashV1(withoutManifestHash(manifest))) {
    throw new Error('snapshot manifest content hash is invalid')
  }
  if (manifest.symbol_count !== universe.length) throw new Error('manifest symbol count does not match request')
  if (manifest.bar_count !== manifest.session_count * manifest.symbol_count) {
    throw new Error('manifest does not describe a complete symbol-session product')
  }
  const snapshotIdentity = {
    schemaVersion: manifest.schema_version,
    provider: manifest.provider,
    feed: manifest.source_feed,
    adjustment: manifest.adjustment,
    calendarVersion: manifest.calendar_version,
    requestedStart: manifest.requested_start,
    publicationAsOf: manifest.publication_asof,
    symbols: universe,
    barsContentHash: manifest.bars_content_hash,
    sessionsContentHash: manifest.sessions_content_hash,
  } as const
  const expectedSnapshotId = canonicalHashV1({
    ...snapshotIdentity,
    universeId: manifest.universe_id,
    universeSymbolHash: manifest.universe_symbol_hash,
  })
  if (manifest.snapshot_id !== expectedSnapshotId) throw new Error('snapshot ID does not match finalized content')
  if (request.bounds.dataStart < manifest.first_session || request.bounds.dataEnd > manifest.last_session) {
    throw new Error('evaluation data bounds are outside the finalized snapshot')
  }

  const commonSnapshot = {
    snapshotId: manifest.snapshot_id,
    publicationId: manifest.manifest_content_hash,
    publicationSchemaVersion: manifest.schema_version,
    source: manifest.provider,
    sourceFeed: manifest.source_feed,
    adjustment: manifest.adjustment,
    calendarVersion: manifest.calendar_version,
    publisherSourceRevision: manifest.publisher_source_revision,
    publisherImage: {
      repository: manifest.publisher_image_repository,
      digest: manifest.publisher_image_digest,
    },
    finalizedAt,
    requestedStart: manifest.requested_start,
    firstSession: manifest.first_session,
    lastSession: manifest.last_session,
    asOfSession: manifest.publication_asof,
    symbols: universe,
    rowCount: manifest.bar_count,
    sessionCount: manifest.session_count,
    contentHash: manifest.bars_content_hash,
    sessionsContentHash: manifest.sessions_content_hash,
  } as const

  if (manifest.universe_id !== request.universeId) throw new Error('manifest universe ID does not match request')
  if (manifest.universe_symbol_hash !== request.universeSymbolHash) {
    throw new Error('manifest universe symbol hash does not match request')
  }
  if (sha256(universe.join(',')) !== request.universeSymbolHash) {
    throw new Error('requested universe symbol hash does not match its symbols')
  }
  if (manifest.requested_start !== request.historyStart || manifest.first_session !== request.historyStart) {
    throw new Error('snapshot history start does not match the compiled strategy')
  }
  if (
    request.bounds.dataStart !== request.historyStart ||
    request.bounds.lookbackStart !== request.historyStart ||
    request.bounds.evaluationStart !== request.evaluationStart
  ) {
    throw new Error('evaluation bounds do not match the compiled strategy history')
  }
  if (request.bounds.dataEnd !== request.publicationAsOf || request.bounds.evaluationEnd !== request.publicationAsOf) {
    throw new Error('evaluation end must match the finalized publication session')
  }

  return {
    manifest,
    universe,
    finalizedSnapshot: decodeFinalizedSnapshot({
      schemaVersion: 'bayn.finalized-snapshot.v3',
      universeId: manifest.universe_id,
      universeSymbolHash: manifest.universe_symbol_hash,
      ...commonSnapshot,
    }),
  }
}

export const verifyFinalizedManifest = (
  manifests: readonly SignalManifestRow[],
  request: SnapshotRequest,
): FinalizedSnapshotProvenance => verifyManifest(manifests, request).finalizedSnapshot

interface VerifiedCalendar {
  readonly verifiedManifest: VerifiedManifest
  readonly orderedSessions: readonly SignalSessionRow[]
  readonly boundedSessions: readonly SignalSessionRow[]
  readonly inputManifest: InputManifest
}

const verifyCalendar = (
  sessions: readonly SignalSessionRow[],
  manifests: readonly SignalManifestRow[],
  request: SnapshotRequest,
): VerifiedCalendar => {
  const verifiedManifest = verifyManifest(manifests, request)
  const { finalizedSnapshot, manifest, universe } = verifiedManifest
  const orderedSessions = [...sessions].sort((left, right) => left.session_date.localeCompare(right.session_date))
  const sessionDates = new Set<string>()
  for (const session of orderedSessions) {
    if (session.snapshot_id !== request.snapshotId) throw new Error('exchange session has a mixed snapshot ID')
    if (session.calendar_version !== manifest.calendar_version)
      throw new Error('exchange session mixes calendar versions')
    if (session.provider !== manifest.provider) throw new Error('exchange session mixes providers')
    if (session.open_time >= session.close_time)
      throw new Error(`exchange session ${session.session_date} has invalid hours`)
    if (sessionDates.has(session.session_date)) throw new Error(`duplicate exchange session: ${session.session_date}`)
    sessionDates.add(session.session_date)
  }
  if (orderedSessions.length !== manifest.session_count)
    throw new Error('exchange-session count does not match manifest')
  const firstSession = orderedSessions.at(0)
  const lastSession = orderedSessions.at(-1)
  if (firstSession === undefined || lastSession === undefined) throw new Error('snapshot has no exchange sessions')
  if (firstSession.session_date !== manifest.first_session) throw new Error('first exchange session does not match')
  if (lastSession.session_date !== manifest.last_session) throw new Error('last exchange session does not match')
  if (canonicalHashV1(orderedSessions.map(withoutSnapshot)) !== manifest.sessions_content_hash) {
    throw new Error('exchange-session content hash is invalid')
  }
  assertBoundSessions(sessionDates, request.bounds)
  const boundedSessions = orderedSessions.filter(
    (session) => session.session_date >= request.bounds.dataStart && session.session_date <= request.bounds.dataEnd,
  )
  const firstBoundedSession = boundedSessions.at(0)
  const lastBoundedSession = boundedSessions.at(-1)
  if (firstBoundedSession === undefined || lastBoundedSession === undefined) {
    throw new Error('evaluation bounds contain no exchange sessions')
  }
  const symbols: SymbolCoverage[] = universe.map((symbol) => ({
    symbol,
    rows: boundedSessions.length,
    firstSession: firstBoundedSession.session_date,
    lastSession: lastBoundedSession.session_date,
  }))
  const manifestFields = {
    database,
    bounds: request.bounds,
    rowCount: boundedSessions.length * universe.length,
    sessionCount: boundedSessions.length,
    firstSession: firstBoundedSession.session_date,
    lastSession: lastBoundedSession.session_date,
    symbols,
  } as const
  const material: Omit<InputManifest, 'hash'> = {
    schemaVersion: 'bayn.input-manifest.v3',
    tables,
    ...manifestFields,
    finalizedSnapshot,
  }
  const inputManifest = { ...material, hash: canonicalHashV1(material) }
  return {
    verifiedManifest,
    orderedSessions,
    boundedSessions,
    inputManifest,
  }
}

export const verifyFinalizedCalendar = (
  rows: Pick<SnapshotRows, 'sessions' | 'manifests'>,
  request: SnapshotRequest,
): MarketDataInspection => {
  const calendar = verifyCalendar(rows.sessions, rows.manifests, request)
  return {
    manifest: calendar.inputManifest,
    sessionDates: calendar.boundedSessions.map((session) => session.session_date),
  }
}

export const verifyFinalizedSnapshot = (rows: SnapshotRows, request: SnapshotRequest): MarketDataSnapshot => {
  const calendar = verifyCalendar(rows.sessions, rows.manifests, request)
  const { manifest, universe } = calendar.verifiedManifest
  const sessionDates = new Set(calendar.orderedSessions.map((session) => session.session_date))
  const orderedBars = [...rows.bars].sort((left, right) =>
    left.session_date === right.session_date
      ? left.symbol.localeCompare(right.symbol)
      : left.session_date.localeCompare(right.session_date),
  )
  const barKeys = new Set<string>()
  const actualSymbols = new Set<string>()
  for (const bar of orderedBars) {
    if (bar.snapshot_id !== request.snapshotId) throw new Error('adjusted bar has a mixed snapshot ID')
    if (
      bar.provider !== manifest.provider ||
      bar.source_feed !== manifest.source_feed ||
      bar.adjustment !== manifest.adjustment
    ) {
      throw new Error('adjusted bars mix provider, feed, or adjustment provenance')
    }
    if (bar.publication_asof !== manifest.publication_asof) throw new Error('adjusted bar mixes publication as-of')
    if (!sessionDates.has(bar.session_date))
      throw new Error(`${bar.symbol} ${bar.session_date} is not an exchange session`)
    const key = `${bar.symbol}\u001f${bar.session_date}`
    if (barKeys.has(key)) throw new Error(`duplicate adjusted bar: ${bar.symbol} ${bar.session_date}`)
    barKeys.add(key)
    actualSymbols.add(bar.symbol)
  }
  if (orderedBars.length !== manifest.bar_count) throw new Error('adjusted-bar count does not match manifest')
  if ([...actualSymbols].sort().join(',') !== universe.join(','))
    throw new Error('snapshot universe does not match request')
  for (const session of calendar.orderedSessions) {
    for (const symbol of universe) {
      if (!barKeys.has(`${symbol}\u001f${session.session_date}`)) {
        throw new Error(`incomplete snapshot: missing ${symbol} ${session.session_date}`)
      }
    }
  }
  if (canonicalHashV1(orderedBars.map(withoutSnapshot)) !== manifest.bars_content_hash) {
    throw new Error('adjusted-bar content hash is invalid')
  }
  const boundedSessionDates = new Set(calendar.boundedSessions.map((session) => session.session_date))
  const boundedRows = orderedBars.filter((bar) => boundedSessionDates.has(bar.session_date))
  if (boundedRows.length !== calendar.inputManifest.rowCount) {
    throw new Error('bounded snapshot is not a complete symbol-session product')
  }
  return {
    bars: boundedRows.map((row) => toDailyBar(row, manifest.schema_version)),
    manifest: calendar.inputManifest,
  }
}

const decodeSnapshotRows = (
  bars: readonly unknown[],
  sessions: readonly unknown[],
  manifests: readonly unknown[],
): SnapshotRows => ({
  bars: decodeBars(bars) as readonly SignalBarRow[],
  sessions: decodeSessions(sessions) as readonly SignalSessionRow[],
  manifests: decodeManifests(manifests).map((manifest) => ({
    ...manifest,
    symbol_count: asCount(manifest.symbol_count, 'symbol_count'),
    session_count: asCount(manifest.session_count, 'session_count'),
    bar_count: asCount(manifest.bar_count, 'bar_count'),
  })) as readonly SignalManifestRow[],
})

const makeMarketData = (
  config: Pick<RuntimeConfig, 'clickhouse' | 'operationTimeoutMs'>,
  contract: MarketDataContract,
): Effect.Effect<MarketDataService, never, ClickhouseClient.ClickhouseClient> =>
  Effect.gen(function* () {
    const sql = yield* ClickhouseClient.ClickhouseClient
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
    const verify = <A>(operation: string, body: () => A): Effect.Effect<A, OperationalError> =>
      Effect.try({
        try: body,
        catch: (cause) => operationalError('market-data', operation, 'Signal snapshot verification failed', cause),
      })

    return {
      check: Effect.gen(function* () {
        const observedAt = new Date(yield* Clock.currentTimeMillis).toISOString()
        const manifests = yield* loadManifests
        return yield* verify('check', () =>
          verifyFinalizedManifest(decodeSnapshotRows([], [], manifests).manifests, request(observedAt)),
        )
      }).pipe(
        Effect.mapError((cause) =>
          cause instanceof OperationalError
            ? cause
            : operationalError('market-data', 'check', 'failed to check finalized Signal snapshot', cause),
        ),
      ),
      inspect: Effect.gen(function* () {
        const observedAt = new Date(yield* Clock.currentTimeMillis).toISOString()
        const [manifests, sessions] = yield* Effect.all([loadManifests, loadSessions], { concurrency: 2 })
        const rows = decodeSnapshotRows([], sessions, manifests)
        return yield* verify('inspect', () => verifyFinalizedCalendar(rows, request(observedAt)))
      }).pipe(
        Effect.mapError((cause) =>
          cause instanceof OperationalError
            ? cause
            : operationalError('market-data', 'inspect', 'failed to inspect finalized Signal calendar', cause),
        ),
      ),
      load: Effect.gen(function* () {
        const observedAt = new Date(yield* Clock.currentTimeMillis).toISOString()
        const [manifests, sessions, bars] = yield* Effect.all([loadManifests, loadSessions, loadBars], {
          concurrency: 3,
        })
        return yield* verify('verify', () =>
          verifyFinalizedSnapshot(decodeSnapshotRows(bars, sessions, manifests), request(observedAt)),
        )
      }).pipe(
        Effect.mapError((cause) =>
          cause instanceof OperationalError
            ? cause
            : operationalError('market-data', 'load', 'failed to load finalized Signal snapshot', cause),
        ),
      ),
    }
  })

export const MarketDataLive = (
  config: Pick<RuntimeConfig, 'clickhouse' | 'operationTimeoutMs'>,
  contract: MarketDataContract,
): Layer.Layer<MarketData, never, ClickhouseClient.ClickhouseClient> =>
  Layer.effect(MarketData, makeMarketData(config, contract))
