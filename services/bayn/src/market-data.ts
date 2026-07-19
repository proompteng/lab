import { createClient, type ClickHouseClient } from '@clickhouse/client'
import { Context, Effect, Layer } from 'effect'

import type { BaynConfig } from './config'
import { hashObject } from './hash'
import type { DailyBar, InputManifest, IsoDate, SymbolCoverage } from './types'

interface ClickHouseBarRow {
  readonly symbol: string
  readonly session_date: string
  readonly adjusted_open: number | string
  readonly adjusted_high: number | string
  readonly adjusted_low: number | string
  readonly adjusted_close: number | string
  readonly adjusted_volume: number | string
  readonly source: string
  readonly source_feed: string
  readonly adjustment: string
  readonly dataset_version: string
}

export interface MarketDataSnapshot {
  readonly bars: readonly DailyBar[]
  readonly manifest: InputManifest
}

export interface MarketDataService {
  readonly load: Effect.Effect<MarketDataSnapshot, Error>
}

export const MarketData = Context.GenericTag<MarketDataService>('bayn/MarketData')

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
): Effect.Effect<MarketDataSnapshot, Error> =>
  Effect.tryPromise({
    try: async () => {
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
      })
      const rows = await result.json<ClickHouseBarRow>()
      const bars = rows.map(toBar)
      const manifest = buildInputManifest(bars, database, table, universe, config.datasetVersion)
      return { bars, manifest }
    },
    catch: (cause) => new Error(`failed to load Signal ClickHouse input: ${String(cause)}`),
  })

export const MarketDataLive = (config: BaynConfig): Layer.Layer<MarketDataService, Error> =>
  Layer.scoped(
    MarketData,
    Effect.acquireRelease(
      Effect.try({
        try: () =>
          createClient({
            url: config.clickhouse.url,
            username: config.clickhouse.username,
            password: config.clickhouse.password,
            database: config.clickhouse.database,
            application: 'bayn',
          }),
        catch: (cause) => new Error(`failed to create ClickHouse client: ${String(cause)}`),
      }),
      (client) => Effect.promise(() => client.close()),
    ).pipe(Effect.map((client) => ({ load: loadSnapshot(client, config.clickhouse, config.protocol.universe) }))),
  )
