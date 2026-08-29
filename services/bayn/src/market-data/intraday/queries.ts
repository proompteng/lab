import type { ClickhouseClient } from '@effect/sql-clickhouse'

import { intradaySnapshotSymbols, type IntradaySnapshotQuery, type IntradaySnapshotRequest } from './model'

export const intradayArchivePageSize = 100_000

export interface IntradayArchivePageCursor {
  readonly eventAt: string
  readonly symbol: string
  readonly sourceTopic: string
  readonly sourcePartition: number
  readonly sourceOffset: string
}

export const makeIntradayMarketDataQueries = (sql: ClickhouseClient.ClickhouseClient) => {
  const symbols = (request: IntradaySnapshotQuery) => sql.param('Array(String)', intradaySnapshotSymbols(request))
  const bounds = (request: IntradaySnapshotQuery) => {
    const session = request.calendar.sessions.find((candidate) => candidate.date === request.sessionDate)
    return {
      start: sql.param('String', request.rangeStartAt),
      end: sql.param('String', request.rangeEndAt),
      observed: sql.param('String', request.observedAt),
      open: sql.param('String', session?.openAt ?? request.rangeStartAt),
      close: sql.param('String', session?.closeAt ?? request.rangeEndAt),
    }
  }

  const watermarkBounds = (request: IntradaySnapshotRequest, sourceTopic: string) => {
    const watermarks = request.archiveWatermarks.filter((watermark) => watermark.sourceTopic === sourceTopic)
    return {
      partitions: watermarks.map((watermark) => String(watermark.sourcePartition)),
      offsets: watermarks.map((watermark) => watermark.inclusiveLastOffset),
    }
  }

  const afterCursorWhere = (cursor: IntradayArchivePageCursor | undefined, precision: 3 | 9) => {
    if (cursor === undefined) return sql``
    const eventAt = sql.param('String', cursor.eventAt)
    const symbol = sql.param('String', cursor.symbol)
    const sourceTopic = sql.param('String', cursor.sourceTopic)
    const sourcePartition = sql.param('String', String(cursor.sourcePartition))
    const sourceOffset = sql.param('String', cursor.sourceOffset)
    return precision === 3
      ? sql`WHERE tuple(event_ts, symbol, source_topic, toUInt64(source_partition), source_offset) > tuple(parseDateTime64BestEffort(${eventAt}, 3, 'UTC'), ${symbol}, ${sourceTopic}, toUInt64(${sourcePartition}), toUInt64(${sourceOffset}))`
      : sql`WHERE tuple(event_ts, symbol, source_topic, toUInt64(source_partition), source_offset) > tuple(parseDateTime64BestEffort(${eventAt}, 9, 'UTC'), ${symbol}, ${sourceTopic}, toUInt64(${sourcePartition}), toUInt64(${sourceOffset}))`
  }

  const captureIntradayArchiveWatermarks = (request: IntradaySnapshotQuery) => {
    const time = bounds(request)
    return sql`
    SELECT
      source_topic,
      toString(source_partition) AS source_partition,
      toString(max(source_offset)) AS inclusive_last_offset
    FROM (
      SELECT source_topic, source_partition, source_offset
      FROM signal.intraday_bars_1m_v2
      WHERE universe_id = ${sql.param('String', request.universeId)}
        AND universe_symbol_hash = ${sql.param('String', request.universeSymbolHash)}
        AND feed = ${sql.param('String', request.feed)}
        AND source_topic = ${sql.param('String', request.sourceTopics.bars)}
        AND event_ts >= parseDateTime64BestEffort(${time.open}, 3, 'UTC')
        AND event_ts <= parseDateTime64BestEffort(${time.close}, 3, 'UTC')
        AND ingest_ts <= parseDateTime64BestEffort(${time.observed}, 3, 'UTC')
      UNION ALL
      SELECT source_topic, source_partition, source_offset
      FROM signal.intraday_quotes_v1
      WHERE universe_id = ${sql.param('String', request.universeId)}
        AND universe_symbol_hash = ${sql.param('String', request.universeSymbolHash)}
        AND feed = ${sql.param('String', request.feed)}
        AND source_topic = ${sql.param('String', request.sourceTopics.quotes)}
        AND event_ts >= parseDateTime64BestEffort(${time.open}, 9, 'UTC')
        AND event_ts <= parseDateTime64BestEffort(${time.close}, 9, 'UTC')
        AND ingest_ts <= parseDateTime64BestEffort(${time.observed}, 9, 'UTC')
      UNION ALL
      SELECT source_topic, source_partition, source_offset
      FROM signal.intraday_trades_v1
      WHERE universe_id = ${sql.param('String', request.universeId)}
        AND universe_symbol_hash = ${sql.param('String', request.universeSymbolHash)}
        AND feed = ${sql.param('String', request.feed)}
        AND source_topic = ${sql.param('String', request.sourceTopics.trades)}
        AND event_ts >= parseDateTime64BestEffort(${time.open}, 9, 'UTC')
        AND event_ts <= parseDateTime64BestEffort(${time.close}, 9, 'UTC')
        AND ingest_ts <= parseDateTime64BestEffort(${time.observed}, 9, 'UTC')
    )
    GROUP BY source_topic, source_partition
    ORDER BY source_topic, source_partition
  `
  }

  const loadIntradayBars = (request: IntradaySnapshotRequest, after?: IntradayArchivePageCursor) => {
    const time = bounds(request)
    const watermark = watermarkBounds(request, request.sourceTopics.bars)
    return sql`
      SELECT
        provider,
        universe_id,
        universe_symbol_hash,
        feed,
        channel,
        market_session,
        delay_class,
        symbol,
        concat(replaceOne(toString(event_ts), ' ', 'T'), 'Z') AS event_at,
        concat(replaceOne(toString(ingest_ts), ' ', 'T'), 'Z') AS ingested_at,
        source_topic,
        toString(source_partition) AS source_partition,
        toString(source_offset) AS source_offset,
        toString(is_final) AS is_final,
        toString(open) AS open,
        toString(high) AS high,
        toString(low) AS low,
        toString(close) AS close,
        toString(volume) AS volume,
        if(isNull(vwap), NULL, toString(vwap)) AS vwap,
        if(isNull(trade_count), NULL, toString(trade_count)) AS trade_count,
        toString(schema_version) AS schema_version
      FROM (
        SELECT *
        FROM signal.intraday_bars_1m_v2
        WHERE universe_id = ${sql.param('String', request.universeId)}
          AND universe_symbol_hash = ${sql.param('String', request.universeSymbolHash)}
          AND feed = ${sql.param('String', request.feed)}
          AND source_topic = ${sql.param('String', request.sourceTopics.bars)}
          AND has(${symbols(request)}, symbol)
          AND event_ts >= parseDateTime64BestEffort(${time.start}, 9, 'UTC')
          AND event_ts < parseDateTime64BestEffort(${time.end}, 9, 'UTC')
          AND ingest_ts <= parseDateTime64BestEffort(${time.observed}, 9, 'UTC')
          AND has(${sql.param('Array(String)', watermark.partitions)}, toString(source_partition))
          AND source_offset <= ifNull(
            toUInt64OrNull(arrayElement(
              ${sql.param('Array(String)', watermark.offsets)},
              indexOf(${sql.param('Array(String)', watermark.partitions)}, toString(source_partition))
            )),
            0
          )
        ORDER BY ingest_ts DESC, source_partition DESC, source_offset DESC
        LIMIT 1 BY universe_id, feed, symbol, event_ts
      )
      ${afterCursorWhere(after, 3)}
      ORDER BY event_ts, symbol, source_topic, source_partition, source_offset
      LIMIT ${sql.param('UInt32', intradayArchivePageSize)}
    `
  }

  const loadIntradayQuotes = (request: IntradaySnapshotRequest, after?: IntradayArchivePageCursor) => {
    const time = bounds(request)
    const watermark = watermarkBounds(request, request.sourceTopics.quotes)
    return sql`
      SELECT
        provider,
        universe_id,
        universe_symbol_hash,
        feed,
        market_session,
        delay_class,
        symbol,
        concat(replaceOne(toString(event_ts), ' ', 'T'), 'Z') AS event_at,
        concat(replaceOne(toString(ingest_ts), ' ', 'T'), 'Z') AS ingested_at,
        source_topic,
        toString(source_partition) AS source_partition,
        toString(source_offset) AS source_offset,
        toString(latest_payload_variants) AS latest_payload_variants,
        toString(bid_price) AS bid_price,
        toString(bid_size) AS bid_size,
        toString(ask_price) AS ask_price,
        toString(ask_size) AS ask_size,
        toString(schema_version) AS schema_version
      FROM (
        SELECT *
        FROM (
          SELECT
            *,
            row_number() OVER (
              PARTITION BY symbol
              ORDER BY ingest_ts DESC, source_topic DESC, source_partition DESC, source_offset DESC
            ) AS latest_candidate_rank,
            uniqExact(tuple(bid_price, bid_size, ask_price, ask_size, market_session, delay_class)) OVER (
              PARTITION BY symbol
            ) AS latest_payload_variants
          FROM (
            SELECT *, max(event_ts) OVER (PARTITION BY symbol) AS latest_event_ts
            FROM signal.intraday_quotes_v1 FINAL
            WHERE universe_id = ${sql.param('String', request.universeId)}
              AND universe_symbol_hash = ${sql.param('String', request.universeSymbolHash)}
              AND feed = ${sql.param('String', request.feed)}
              AND source_topic = ${sql.param('String', request.sourceTopics.quotes)}
              AND has(${symbols(request)}, symbol)
              AND event_ts >= parseDateTime64BestEffort(${time.start}, 9, 'UTC')
              AND event_ts <= parseDateTime64BestEffort(${time.close}, 9, 'UTC')
              AND ingest_ts <= parseDateTime64BestEffort(${time.observed}, 9, 'UTC')
              AND has(${sql.param('Array(String)', watermark.partitions)}, toString(source_partition))
              AND source_offset <= ifNull(
                toUInt64OrNull(arrayElement(
                  ${sql.param('Array(String)', watermark.offsets)},
                  indexOf(${sql.param('Array(String)', watermark.partitions)}, toString(source_partition))
                )),
                0
              )
          )
          WHERE event_ts = latest_event_ts
        )
        WHERE latest_candidate_rank = 1
      )
      ${afterCursorWhere(after, 9)}
      ORDER BY event_ts, symbol, source_topic, source_partition, source_offset
      LIMIT ${sql.param('UInt32', intradayArchivePageSize)}
    `
  }

  const loadIntradayTrades = (request: IntradaySnapshotRequest, after?: IntradayArchivePageCursor) => {
    const time = bounds(request)
    const watermark = watermarkBounds(request, request.sourceTopics.trades)
    return sql`
      SELECT
        provider,
        universe_id,
        universe_symbol_hash,
        feed,
        market_session,
        delay_class,
        symbol,
        concat(replaceOne(toString(event_ts), ' ', 'T'), 'Z') AS event_at,
        concat(replaceOne(toString(ingest_ts), ' ', 'T'), 'Z') AS ingested_at,
        source_topic,
        toString(source_partition) AS source_partition,
        toString(source_offset) AS source_offset,
        toString(latest_payload_variants) AS latest_payload_variants,
        toString(price) AS price,
        toString(size) AS size,
        toString(schema_version) AS schema_version
      FROM (
        SELECT *
        FROM (
          SELECT
            *,
            row_number() OVER (
              PARTITION BY symbol
              ORDER BY ingest_ts DESC, source_topic DESC, source_partition DESC, source_offset DESC
            ) AS latest_candidate_rank,
            uniqExact(tuple(price, size, market_session, delay_class)) OVER (
              PARTITION BY symbol
            ) AS latest_payload_variants
          FROM (
            SELECT *, max(event_ts) OVER (PARTITION BY symbol) AS latest_event_ts
            FROM signal.intraday_trades_v1 FINAL
            WHERE universe_id = ${sql.param('String', request.universeId)}
              AND universe_symbol_hash = ${sql.param('String', request.universeSymbolHash)}
              AND feed = ${sql.param('String', request.feed)}
              AND source_topic = ${sql.param('String', request.sourceTopics.trades)}
              AND has(${symbols(request)}, symbol)
              AND event_ts >= parseDateTime64BestEffort(${time.start}, 9, 'UTC')
              AND event_ts <= parseDateTime64BestEffort(${time.close}, 9, 'UTC')
              AND ingest_ts <= parseDateTime64BestEffort(${time.observed}, 9, 'UTC')
              AND has(${sql.param('Array(String)', watermark.partitions)}, toString(source_partition))
              AND source_offset <= ifNull(
                toUInt64OrNull(arrayElement(
                  ${sql.param('Array(String)', watermark.offsets)},
                  indexOf(${sql.param('Array(String)', watermark.partitions)}, toString(source_partition))
                )),
                0
              )
          )
          WHERE event_ts = latest_event_ts
        )
        WHERE latest_candidate_rank = 1
      )
      ${afterCursorWhere(after, 9)}
      ORDER BY event_ts, symbol, source_topic, source_partition, source_offset
      LIMIT ${sql.param('UInt32', intradayArchivePageSize)}
    `
  }

  return { captureIntradayArchiveWatermarks, loadIntradayBars, loadIntradayQuotes, loadIntradayTrades }
}
