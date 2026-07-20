import { createClient, type ClickHouseClient } from '@clickhouse/client'
import { Context, Effect, Layer, Redacted, Schema } from 'effect'

import type { BaynConfig } from './config'
import { baynError, type BaynError } from './errors'
import { hashObject } from './hash'
import type { DailyBar, InputManifest, IsoDate, SymbolCoverage } from './types'

const ClickHouseNumber = Schema.Union([Schema.Number, Schema.String])
const ClickHouseBarRow = Schema.Struct({
  symbol: Schema.String,
  session_date: Schema.String,
  adjusted_open: ClickHouseNumber,
  adjusted_high: ClickHouseNumber,
  adjusted_low: ClickHouseNumber,
  adjusted_close: ClickHouseNumber,
  adjusted_volume: ClickHouseNumber,
  source: Schema.String,
  source_feed: Schema.String,
  adjustment: Schema.String,
  dataset_version: Schema.String,
})
type ClickHouseBarRow = typeof ClickHouseBarRow.Type

const decodeClickHouseBarRows = Schema.decodeUnknownSync(Schema.Array(ClickHouseBarRow))

export interface MarketDataSnapshot {
  readonly bars: readonly DailyBar[]
  readonly manifest: InputManifest
}

export interface MarketDataService {
  readonly load: Effect.Effect<MarketDataSnapshot, BaynError>
}

export class MarketData extends Context.Service<MarketData, MarketDataService>()('bayn/MarketData') {}

const identifier = (value: string, name: string): string => {
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(value)) {
    throw new Error(`${name} is not a valid ClickHouse identifier`)
  }
  return value
}

const numberField = (value: number | string, name: string): number => {
  const parsed = typeof value === 'number' ? value : Number.parseFloat(value)
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`${name} must be a finite non-negative number`)
  }
  return parsed
}

const isoDate = (value: string): IsoDate => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(Date.parse(`${value}T00:00:00Z`))) {
    throw new Error(`invalid session date: ${value}`)
  }
  return value as IsoDate
}

const toBar = (row: ClickHouseBarRow): DailyBar => {
  const bar: DailyBar = {
    symbol: row.symbol,
    sessionDate: isoDate(row.session_date),
    open: numberField(row.adjusted_open, 'adjusted_open'),
    high: numberField(row.adjusted_high, 'adjusted_high'),
    low: numberField(row.adjusted_low, 'adjusted_low'),
    close: numberField(row.adjusted_close, 'adjusted_close'),
    volume: numberField(row.adjusted_volume, 'adjusted_volume'),
    source: row.source,
    sourceFeed: row.source_feed,
    adjustment: row.adjustment,
    datasetVersion: row.dataset_version,
  }
  if (bar.open <= 0 || bar.high <= 0 || bar.low <= 0 || bar.close <= 0) {
    throw new Error(`${bar.symbol} ${bar.sessionDate} contains a non-positive price`)
  }
  if (bar.low > Math.min(bar.open, bar.close) || bar.high < Math.max(bar.open, bar.close) || bar.low > bar.high) {
    throw new Error(`${bar.symbol} ${bar.sessionDate} contains inconsistent OHLC prices`)
  }
  return bar
}

export const buildInputManifest = (
  bars: readonly DailyBar[],
  database: string,
  table: string,
  expectedUniverse: readonly string[],
  expectedDatasetVersion: string,
): InputManifest => {
  if (bars.length === 0) throw new Error('Signal ClickHouse returned no adjusted bars')

  const bySymbol = new Map<string, DailyBar[]>()
  const uniqueRows = new Set<string>()
  for (const bar of bars) {
    if (bar.datasetVersion !== expectedDatasetVersion) {
      throw new Error(`unexpected dataset version ${bar.datasetVersion}`)
    }
    const key = `${bar.symbol}\u001f${bar.sessionDate}`
    if (uniqueRows.has(key)) throw new Error(`duplicate adjusted bar: ${bar.symbol} ${bar.sessionDate}`)
    uniqueRows.add(key)
    const symbolBars = bySymbol.get(bar.symbol) ?? []
    symbolBars.push(bar)
    bySymbol.set(bar.symbol, symbolBars)
  }

  const actualSymbols = [...bySymbol.keys()].sort()
  const requiredSymbols = [...expectedUniverse].sort()
  if (actualSymbols.join(',') !== requiredSymbols.join(',')) {
    throw new Error(`universe mismatch: expected ${requiredSymbols.join(',')}; received ${actualSymbols.join(',')}`)
  }

  const sourceValues = new Set(bars.map((bar) => bar.source))
  const feedValues = new Set(bars.map((bar) => bar.sourceFeed))
  const adjustmentValues = new Set(bars.map((bar) => bar.adjustment))
  if (sourceValues.size !== 1 || feedValues.size !== 1 || adjustmentValues.size !== 1) {
    throw new Error('dataset mixes source, feed, or adjustment contracts')
  }

  const symbols: SymbolCoverage[] = requiredSymbols.map((symbol) => {
    const symbolBars = bySymbol.get(symbol)
    if (!symbolBars || symbolBars.length === 0) throw new Error(`missing adjusted bars for ${symbol}`)
    symbolBars.sort((left, right) => left.sessionDate.localeCompare(right.sessionDate))
    return {
      symbol,
      rows: symbolBars.length,
      firstSession: symbolBars[0].sessionDate,
      lastSession: symbolBars.at(-1)!.sessionDate,
    }
  })

  const contentHash = hashObject(
    [...bars]
      .sort((left, right) =>
        left.sessionDate === right.sessionDate
          ? left.symbol.localeCompare(right.symbol)
          : left.sessionDate.localeCompare(right.sessionDate),
      )
      .map((bar) => ({
        symbol: bar.symbol,
        sessionDate: bar.sessionDate,
        open: bar.open,
        high: bar.high,
        low: bar.low,
        close: bar.close,
        volume: bar.volume,
        source: bar.source,
        sourceFeed: bar.sourceFeed,
        adjustment: bar.adjustment,
        datasetVersion: bar.datasetVersion,
      })),
  )

  const manifestWithoutHash = {
    schemaVersion: 'bayn.input-manifest.v1' as const,
    contentHash,
    database,
    table,
    datasetVersion: expectedDatasetVersion,
    source: [...sourceValues][0],
    sourceFeed: [...feedValues][0],
    adjustment: [...adjustmentValues][0],
    rowCount: bars.length,
    firstSession: symbols.map((coverage) => coverage.firstSession).sort()[0],
    lastSession: symbols
      .map((coverage) => coverage.lastSession)
      .sort()
      .at(-1)!,
    symbols,
  }
  return { ...manifestWithoutHash, hash: hashObject(manifestWithoutHash) }
}

const loadSnapshot = (
  client: ClickHouseClient,
  config: BaynConfig['clickhouse'],
  universe: readonly string[],
): Effect.Effect<MarketDataSnapshot, BaynError> =>
  Effect.tryPromise({
    try: async (signal) => {
      const database = identifier(config.database, 'database')
      const table = identifier(config.table, 'table')
      const result = await client.query({
        query: `
          SELECT
            symbol,
            toString(session_date) AS session_date,
            adjusted_open,
            adjusted_high,
            adjusted_low,
            adjusted_close,
            adjusted_volume,
            source,
            source_feed,
            adjustment,
            dataset_version
          FROM ${database}.${table} FINAL
          WHERE dataset_version = {datasetVersion:String}
            AND symbol IN {universe:Array(String)}
          ORDER BY session_date, symbol
        `,
        query_params: { datasetVersion: config.datasetVersion, universe: [...universe] },
        format: 'JSONEachRow',
        abort_signal: signal,
      })
      const rows = decodeClickHouseBarRows(await result.json<unknown>())
      const bars = rows.map(toBar)
      const manifest = buildInputManifest(bars, database, table, universe, config.datasetVersion)
      return { bars, manifest }
    },
    catch: (cause) => baynError('market-data', 'load', 'failed to load Signal ClickHouse input', cause),
  })

export interface MarketDataDependencies {
  readonly createClient: typeof createClient
}

const defaultDependencies: MarketDataDependencies = { createClient }

export const MarketDataLive = (
  config: BaynConfig,
  universe: readonly string[],
  dependencies: MarketDataDependencies = defaultDependencies,
): Layer.Layer<MarketData, BaynError> =>
  Layer.effect(
    MarketData,
    Effect.acquireRelease(
      Effect.try({
        try: () =>
          dependencies.createClient({
            url: config.clickhouse.url,
            username: config.clickhouse.username,
            password: Redacted.value(config.clickhouse.password),
            database: config.clickhouse.database,
            application: 'bayn',
            request_timeout: config.operationTimeoutMs,
          }),
        catch: (cause) => baynError('market-data', 'connect', 'failed to create ClickHouse client', cause),
      }),
      (client) =>
        Effect.tryPromise({
          try: () => client.close(),
          catch: (cause) => baynError('market-data', 'close', 'failed to close ClickHouse client', cause),
        }).pipe(
          Effect.catch((error) =>
            Effect.logWarning('ClickHouse client close failed').pipe(
              Effect.annotateLogs({ component: error.component, operation: error.operation, error: error.message }),
            ),
          ),
        ),
    ).pipe(Effect.map((client) => ({ load: loadSnapshot(client, config.clickhouse, universe) }))),
  )
