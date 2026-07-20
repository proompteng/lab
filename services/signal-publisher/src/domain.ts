import { createHash } from 'node:crypto'

import { Schema } from 'effect'

export const provider = 'alpaca' as const
export const adjustment = 'all' as const
export const calendarTimeZone = 'America/New_York' as const
export const manifestSchemaVersion = 'signal.adjusted-daily-snapshot.v1' as const

const validIsoDate = (value: string): boolean => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  const parsed = new Date(`${value}T00:00:00Z`)
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value
}

export const IsoDateSchema = Schema.String.check(
  Schema.isPattern(/^\d{4}-\d{2}-\d{2}$/),
  Schema.makeFilter(validIsoDate, {
    expected: 'a valid ISO date (YYYY-MM-DD)',
  }),
)
export const SnapshotIdSchema = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/))
export const MarketTimeSchema = Schema.String.check(Schema.isPattern(/^(?:0\d|1\d|2[0-3]):[0-5]\d$/))
const NonNegativeFinite = Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0))
const NonNegativeInteger = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))
const UtcTimestamp = Schema.String.check(
  Schema.isPattern(/^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d+)?Z$/),
  Schema.makeFilter((value: string) => validIsoDate(value.slice(0, 10)), { expected: 'a valid UTC timestamp' }),
)

const AlpacaBarSchema = Schema.Struct({
  t: UtcTimestamp,
  o: Schema.Finite,
  h: Schema.Finite,
  l: Schema.Finite,
  c: Schema.Finite,
  v: NonNegativeFinite,
  n: NonNegativeInteger,
  vw: Schema.NullOr(Schema.Finite),
})

export const AlpacaBarsResponseSchema = Schema.Struct({
  bars: Schema.Record(Schema.String, Schema.Array(AlpacaBarSchema)),
  next_page_token: Schema.NullOr(Schema.String),
})

export const AlpacaCalendarResponseSchema = Schema.Array(
  Schema.Struct({
    date: IsoDateSchema,
    open: MarketTimeSchema,
    close: MarketTimeSchema,
  }),
)

export type IsoDate = typeof IsoDateSchema.Type
export const isIsoDate = (value: string): value is IsoDate => validIsoDate(value)
export type AlpacaBar = typeof AlpacaBarSchema.Type
export type AlpacaCalendarSession = (typeof AlpacaCalendarResponseSchema.Type)[number]

export interface PublisherProvenance {
  readonly sourceRevision: string
  readonly imageRepository: string
  readonly imageDigest: string
}

export interface BarRow {
  readonly snapshot_id: string
  readonly symbol: string
  readonly session_date: IsoDate
  readonly adjusted_open: string
  readonly adjusted_high: string
  readonly adjusted_low: string
  readonly adjusted_close: string
  readonly adjusted_volume: string
  readonly trade_count: string
  readonly vwap: string | null
  readonly provider: typeof provider
  readonly source_feed: 'iex' | 'sip'
  readonly adjustment: typeof adjustment
  readonly publication_asof: IsoDate
}

export interface SessionRow {
  readonly snapshot_id: string
  readonly calendar_version: string
  readonly session_date: IsoDate
  readonly open_time: string
  readonly close_time: string
  readonly timezone: typeof calendarTimeZone
  readonly provider: typeof provider
}

export interface ManifestRow {
  readonly snapshot_id: string
  readonly schema_version: typeof manifestSchemaVersion
  readonly publisher_source_revision: string
  readonly publisher_image_repository: string
  readonly publisher_image_digest: string
  readonly provider: typeof provider
  readonly source_feed: 'iex' | 'sip'
  readonly adjustment: typeof adjustment
  readonly calendar_version: string
  readonly requested_start: IsoDate
  readonly publication_asof: IsoDate
  readonly first_session: IsoDate
  readonly last_session: IsoDate
  readonly symbol_count: number
  readonly session_count: number
  readonly bar_count: number
  readonly bars_content_hash: string
  readonly sessions_content_hash: string
  readonly manifest_content_hash: string
  readonly finalized_at: string
}

export interface Publication {
  readonly bars: readonly BarRow[]
  readonly sessions: readonly SessionRow[]
  readonly manifest: ManifestRow
}

export interface BuildPublicationInput {
  readonly barsBySymbol: Readonly<Record<string, readonly AlpacaBar[]>>
  readonly calendar: readonly AlpacaCalendarSession[]
  readonly symbols: readonly string[]
  readonly feed: 'iex' | 'sip'
  readonly calendarVersion: string
  readonly requestedStart: IsoDate
  readonly publicationAsOf: IsoDate
  readonly finalizedAt: string
  readonly provenance: PublisherProvenance
}

type Json = null | boolean | number | string | readonly Json[] | { readonly [key: string]: Json }

const canonicalJson = (value: Json): string => {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson((value as Record<string, Json>)[key])}`)
    .join(',')}}`
}

const hashJson = (value: Json): string => createHash('sha256').update(canonicalJson(value)).digest('hex')

const reject = (message: string): never => {
  throw new Error(message)
}

const decimal = (value: number, name: string): string => {
  if (!Number.isFinite(value)) reject(`${name} must be finite`)
  if (Math.abs(value) >= 10_000_000_000) reject(`${name} exceeds Decimal64(8) range`)
  return value.toFixed(8)
}

const sessionDate = (timestamp: string): IsoDate => {
  const value = timestamp.slice(0, 10)
  if (!isIsoDate(value) || Number.isNaN(Date.parse(timestamp))) {
    reject(`invalid Alpaca bar timestamp: ${timestamp}`)
  }
  return value as IsoDate
}

const normalizeBar = (
  snapshotId: string,
  symbol: string,
  bar: AlpacaBar,
  feed: 'iex' | 'sip',
  publicationAsOf: IsoDate,
): BarRow => {
  if (bar.o <= 0 || bar.h <= 0 || bar.l <= 0 || bar.c <= 0) {
    reject(`${symbol} ${bar.t} contains a non-positive price`)
  }
  if (bar.l > Math.min(bar.o, bar.c) || bar.h < Math.max(bar.o, bar.c) || bar.l > bar.h) {
    reject(`${symbol} ${bar.t} contains inconsistent OHLC prices`)
  }
  if (bar.vw !== null && bar.vw <= 0) reject(`${symbol} ${bar.t} contains a non-positive VWAP`)
  return {
    snapshot_id: snapshotId,
    symbol,
    session_date: sessionDate(bar.t),
    adjusted_open: decimal(bar.o, 'adjusted_open'),
    adjusted_high: decimal(bar.h, 'adjusted_high'),
    adjusted_low: decimal(bar.l, 'adjusted_low'),
    adjusted_close: decimal(bar.c, 'adjusted_close'),
    adjusted_volume: decimal(bar.v, 'adjusted_volume'),
    trade_count: String(bar.n),
    vwap: bar.vw === null ? null : decimal(bar.vw, 'vwap'),
    provider,
    source_feed: feed,
    adjustment,
    publication_asof: publicationAsOf,
  }
}

const validateSymbols = (symbols: readonly string[]): readonly string[] => {
  const normalized = symbols
    .map((symbol) => symbol.trim().toUpperCase())
    .filter(Boolean)
    .sort()
  if (normalized.length === 0) reject('at least one symbol is required')
  if (new Set(normalized).size !== normalized.length) reject('symbols must be unique')
  for (const symbol of normalized) {
    if (!/^[A-Z][A-Z0-9.-]{0,14}$/.test(symbol)) reject(`invalid symbol: ${symbol}`)
  }
  return normalized
}

const manifestHash = (manifest: Omit<ManifestRow, 'manifest_content_hash'>): string =>
  hashJson(manifest as unknown as Json)

export const buildPublication = (input: BuildPublicationInput): Publication => {
  const symbols = validateSymbols(input.symbols)
  if (input.requestedStart > input.publicationAsOf) reject('requested start must not be after publication as-of')
  if (
    !/^\d{4}-\d{2}-\d{2} (?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d\.\d{3}$/.test(input.finalizedAt) ||
    !validIsoDate(input.finalizedAt.slice(0, 10))
  ) {
    reject('finalizedAt must be a UTC ClickHouse timestamp')
  }

  const unexpectedSymbols = Object.keys(input.barsBySymbol)
    .filter((symbol) => !symbols.includes(symbol))
    .sort()
  if (unexpectedSymbols.length > 0) reject(`provider returned unexpected symbols: ${unexpectedSymbols.join(',')}`)

  const calendar = [...input.calendar].sort((left, right) => left.date.localeCompare(right.date))
  if (calendar.length === 0) reject('calendar returned no exchange sessions')
  const calendarDates = new Set<IsoDate>()
  for (const session of calendar) {
    if (session.date < input.requestedStart || session.date > input.publicationAsOf) {
      reject(`calendar session ${session.date} is outside requested bounds`)
    }
    if (calendarDates.has(session.date)) reject(`duplicate calendar session: ${session.date}`)
    if (session.open >= session.close) reject(`calendar session ${session.date} has invalid market hours`)
    calendarDates.add(session.date)
  }
  if (!calendarDates.has(input.publicationAsOf)) {
    reject(`publication as-of ${input.publicationAsOf} is not an exchange session`)
  }

  const barsWithoutSnapshot: Omit<BarRow, 'snapshot_id'>[] = []
  const barKeys = new Set<string>()
  for (const symbol of symbols) {
    const sourceBars = input.barsBySymbol[symbol] ?? []
    for (const sourceBar of sourceBars) {
      const row = normalizeBar('', symbol, sourceBar, input.feed, input.publicationAsOf)
      if (row.session_date < input.requestedStart || row.session_date > input.publicationAsOf) {
        reject(`${symbol} ${row.session_date} is outside requested bounds`)
      }
      if (!calendarDates.has(row.session_date)) reject(`${symbol} ${row.session_date} is not an exchange session`)
      const key = `${symbol}\u001f${row.session_date}`
      if (barKeys.has(key)) reject(`duplicate adjusted bar: ${symbol} ${row.session_date}`)
      barKeys.add(key)
      const { snapshot_id: _, ...withoutSnapshot } = row
      barsWithoutSnapshot.push(withoutSnapshot)
    }
    for (const session of calendar) {
      if (!barKeys.has(`${symbol}\u001f${session.date}`)) {
        reject(`incomplete snapshot: missing ${symbol} ${session.date}`)
      }
    }
  }
  if (barsWithoutSnapshot.length === 0) reject('provider returned no adjusted bars')
  barsWithoutSnapshot.sort((left, right) =>
    left.session_date === right.session_date
      ? left.symbol.localeCompare(right.symbol)
      : left.session_date.localeCompare(right.session_date),
  )

  const sessionsWithoutSnapshot = calendar.map((session) => ({
    calendar_version: input.calendarVersion,
    session_date: session.date,
    open_time: session.open,
    close_time: session.close,
    timezone: calendarTimeZone,
    provider,
  }))
  const barsContentHash = hashJson(barsWithoutSnapshot as unknown as Json)
  const sessionsContentHash = hashJson(sessionsWithoutSnapshot as unknown as Json)
  const snapshotIdentity = {
    schemaVersion: manifestSchemaVersion,
    provider,
    feed: input.feed,
    adjustment,
    calendarVersion: input.calendarVersion,
    requestedStart: input.requestedStart,
    publicationAsOf: input.publicationAsOf,
    symbols,
    barsContentHash,
    sessionsContentHash,
  } as const
  const snapshotId = hashJson(snapshotIdentity)
  const bars = barsWithoutSnapshot.map((bar) => ({ snapshot_id: snapshotId, ...bar }))
  const sessions = sessionsWithoutSnapshot.map((session) => ({ snapshot_id: snapshotId, ...session }))
  const manifestWithoutHash: Omit<ManifestRow, 'manifest_content_hash'> = {
    snapshot_id: snapshotId,
    schema_version: manifestSchemaVersion,
    publisher_source_revision: input.provenance.sourceRevision,
    publisher_image_repository: input.provenance.imageRepository,
    publisher_image_digest: input.provenance.imageDigest,
    provider,
    source_feed: input.feed,
    adjustment,
    calendar_version: input.calendarVersion,
    requested_start: input.requestedStart,
    publication_asof: input.publicationAsOf,
    first_session: sessions[0].session_date,
    last_session: sessions.at(-1)!.session_date,
    symbol_count: symbols.length,
    session_count: sessions.length,
    bar_count: bars.length,
    bars_content_hash: barsContentHash,
    sessions_content_hash: sessionsContentHash,
    finalized_at: input.finalizedAt,
  }
  return {
    bars,
    sessions,
    manifest: { ...manifestWithoutHash, manifest_content_hash: manifestHash(manifestWithoutHash) },
  }
}

const withoutSnapshot = <A extends { readonly snapshot_id: string }>({ snapshot_id: _, ...value }: A) => value

const withoutManifestHash = ({ manifest_content_hash: _, ...manifest }: ManifestRow) => manifest

export const verifyPublication = (
  expected: Publication,
  storedBars: readonly BarRow[],
  storedSessions: readonly SessionRow[],
  storedManifests: readonly ManifestRow[],
): void => {
  if (storedManifests.length !== 1) {
    reject(`snapshot ${expected.manifest.snapshot_id} has ${storedManifests.length} manifest rows; expected 1`)
  }
  const manifest = storedManifests[0]
  if (manifest.manifest_content_hash !== manifestHash(withoutManifestHash(manifest))) {
    reject(`snapshot ${manifest.snapshot_id} manifest hash is invalid`)
  }
  if (canonicalJson(manifest as unknown as Json) !== canonicalJson(expected.manifest as unknown as Json)) {
    reject(`snapshot ${manifest.snapshot_id} manifest does not match expected publication`)
  }

  const orderedBars = [...storedBars].sort((left, right) =>
    left.session_date === right.session_date
      ? left.symbol.localeCompare(right.symbol)
      : left.session_date.localeCompare(right.session_date),
  )
  const orderedSessions = [...storedSessions].sort((left, right) => left.session_date.localeCompare(right.session_date))
  if (
    orderedBars.length !== manifest.bar_count ||
    new Set(orderedBars.map((row) => `${row.symbol}\u001f${row.session_date}`)).size !== orderedBars.length
  ) {
    reject(`snapshot ${manifest.snapshot_id} bar cardinality is invalid`)
  }
  if (
    orderedSessions.length !== manifest.session_count ||
    new Set(orderedSessions.map((row) => row.session_date)).size !== orderedSessions.length
  ) {
    reject(`snapshot ${manifest.snapshot_id} session cardinality is invalid`)
  }
  if (hashJson(orderedBars.map(withoutSnapshot) as unknown as Json) !== manifest.bars_content_hash) {
    reject(`snapshot ${manifest.snapshot_id} bar content hash is invalid`)
  }
  if (hashJson(orderedSessions.map(withoutSnapshot) as unknown as Json) !== manifest.sessions_content_hash) {
    reject(`snapshot ${manifest.snapshot_id} session content hash is invalid`)
  }
}

export const missingRows = <A extends { readonly snapshot_id: string }>(
  expected: readonly A[],
  stored: readonly A[],
  key: (row: A) => string,
): readonly A[] => {
  const expectedByKey = new Map(expected.map((row) => [key(row), row]))
  const storedKeys = new Set<string>()
  for (const row of stored) {
    const rowKey = key(row)
    if (storedKeys.has(rowKey)) reject(`duplicate staged row: ${rowKey}`)
    storedKeys.add(rowKey)
    const expectedRow = expectedByKey.get(rowKey)
    if (!expectedRow || canonicalJson(row as unknown as Json) !== canonicalJson(expectedRow as unknown as Json)) {
      reject(`staged row does not match publication: ${rowKey}`)
    }
  }
  return expected.filter((row) => !storedKeys.has(key(row)))
}
