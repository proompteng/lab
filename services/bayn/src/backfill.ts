import process from 'node:process'

import { createClient } from '@clickhouse/client'
import { Effect } from 'effect'

import { loadBackfillConfig } from './backfill-config'
import { defaultProtocol } from './protocol'

interface AlpacaBar {
  readonly t: string
  readonly o: number
  readonly h: number
  readonly l: number
  readonly c: number
  readonly v: number
  readonly n: number
  readonly vw: number | null
}

interface AlpacaBarsResponse {
  readonly bars: Readonly<Record<string, readonly AlpacaBar[]>>
  readonly next_page_token: string | null
}

interface BackfillRow {
  readonly symbol: string
  readonly session_date: string
  readonly adjusted_open: number
  readonly adjusted_high: number
  readonly adjusted_low: number
  readonly adjusted_close: number
  readonly adjusted_volume: number
  readonly trade_count: number
  readonly vwap: number | null
  readonly source: 'alpaca'
  readonly source_feed: string
  readonly adjustment: 'all'
  readonly asof_date: string
  readonly dataset_version: string
  readonly ingested_at: string
}

const main = async (): Promise<void> => {
  const {
    clickhouseUrl,
    clickhouseUsername,
    clickhousePassword,
    alpacaKey,
    alpacaSecret,
    database,
    table,
    cluster,
    start,
    end,
    feed,
    datasetVersion,
  } = await Effect.runPromise(loadBackfillConfig)
  const universe = [...defaultProtocol.universe]
  const client = createClient({
    url: clickhouseUrl,
    username: clickhouseUsername,
    password: clickhousePassword,
    application: 'bayn-backfill',
  })

  try {
    await client.command({ query: `CREATE DATABASE IF NOT EXISTS ${database} ON CLUSTER ${cluster}` })
    await client.command({
      query: `
        CREATE TABLE IF NOT EXISTS ${database}.${table} ON CLUSTER ${cluster}
        (
          symbol LowCardinality(String),
          session_date Date,
          adjusted_open Float64,
          adjusted_high Float64,
          adjusted_low Float64,
          adjusted_close Float64,
          adjusted_volume Float64,
          trade_count UInt64,
          vwap Nullable(Float64),
          source LowCardinality(String),
          source_feed LowCardinality(String),
          adjustment LowCardinality(String),
          asof_date Date,
          dataset_version String,
          ingested_at DateTime64(3, 'UTC')
        )
        ENGINE = ReplicatedReplacingMergeTree(
          '/clickhouse/tables/{cluster}/{shard}/signal_adjusted_daily_bars_v1',
          '{replica}',
          ingested_at
        )
        PARTITION BY toYear(session_date)
        ORDER BY (dataset_version, symbol, session_date)
      `,
    })

    let pageToken: string | null = null
    let inserted = 0
    do {
      const parameters = new URLSearchParams({
        symbols: universe.join(','),
        timeframe: '1Day',
        start: `${start}T00:00:00Z`,
        end: `${end}T23:59:59Z`,
        adjustment: 'all',
        feed,
        sort: 'asc',
        limit: '10000',
      })
      if (pageToken) parameters.set('page_token', pageToken)
      const response = await fetch(`https://data.alpaca.markets/v2/stocks/bars?${parameters.toString()}`, {
        headers: {
          'APCA-API-KEY-ID': alpacaKey,
          'APCA-API-SECRET-KEY': alpacaSecret,
          accept: 'application/json',
        },
      })
      if (!response.ok)
        throw new Error(`Alpaca historical bars failed with HTTP ${response.status}: ${await response.text()}`)
      const payload = (await response.json()) as AlpacaBarsResponse
      const ingestedAt = new Date().toISOString().replace('T', ' ').replace('Z', '')
      const rows: BackfillRow[] = []
      for (const symbol of universe) {
        for (const bar of payload.bars[symbol] ?? []) {
          rows.push({
            symbol,
            session_date: bar.t.slice(0, 10),
            adjusted_open: bar.o,
            adjusted_high: bar.h,
            adjusted_low: bar.l,
            adjusted_close: bar.c,
            adjusted_volume: bar.v,
            trade_count: bar.n,
            vwap: bar.vw,
            source: 'alpaca',
            source_feed: feed,
            adjustment: 'all',
            asof_date: end,
            dataset_version: datasetVersion,
            ingested_at: ingestedAt,
          })
        }
      }
      if (rows.length > 0) {
        await client.insert({ table: `${database}.${table}`, values: rows, format: 'JSONEachRow' })
        inserted += rows.length
      }
      pageToken = payload.next_page_token
    } while (pageToken)

    const proof = await client.query({
      query: `
        SELECT
          symbol,
          count() AS rows,
          toString(min(session_date)) AS first_session,
          toString(max(session_date)) AS last_session
        FROM ${database}.${table} FINAL
        WHERE dataset_version = {datasetVersion:String}
        GROUP BY symbol
        ORDER BY symbol
      `,
      query_params: { datasetVersion },
      format: 'JSONEachRow',
    })
    const coverage = await proof.json<Record<string, string>>()
    const coveredSymbols = coverage.map((row) => row.symbol).sort()
    if (coveredSymbols.join(',') !== universe.sort().join(',')) {
      throw new Error(`backfill coverage mismatch: ${coveredSymbols.join(',')}`)
    }
    console.log(JSON.stringify({ datasetVersion, source: 'alpaca', feed, adjustment: 'all', inserted, coverage }))
  } finally {
    await client.close()
  }
}

main().catch((cause) => {
  console.error(
    JSON.stringify({ service: 'bayn-backfill', error: cause instanceof Error ? cause.message : String(cause) }),
  )
  process.exitCode = 1
})
