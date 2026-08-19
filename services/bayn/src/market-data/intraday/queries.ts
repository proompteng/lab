import type { ClickhouseClient } from '@effect/sql-clickhouse'

import type { IntradaySnapshotQuery, IntradaySnapshotRequest } from './model'

export const makeIntradayMarketDataQueries = (sql: ClickhouseClient.ClickhouseClient) => {
  const bounds = (request: IntradaySnapshotQuery) => ({
    start: sql.param('String', request.rangeStartAt),
    end: sql.param('String', request.rangeEndAt),
    observed: sql.param('String', request.observedAt),
  })

  const watermarkBounds = (request: IntradaySnapshotRequest, sourceTopic: string) => {
    const watermarks = request.archiveWatermarks.filter((watermark) => watermark.sourceTopic === sourceTopic)
    return {
      partitions: watermarks.map((watermark) => String(watermark.sourcePartition)),
      offsets: watermarks.map((watermark) => watermark.inclusiveLastOffset),
    }
  }

  const captureIntradayArchiveWatermarks = (request: IntradaySnapshotQuery) => sql`
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
        AND has(${sql.param('Array(String)', request.universe)}, symbol)
      UNION ALL
      SELECT source_topic, source_partition, source_offset
      FROM signal.intraday_quotes_v1
      WHERE universe_id = ${sql.param('String', request.universeId)}
        AND universe_symbol_hash = ${sql.param('String', request.universeSymbolHash)}
        AND feed = ${sql.param('String', request.feed)}
        AND source_topic = ${sql.param('String', request.sourceTopics.quotes)}
        AND has(${sql.param('Array(String)', request.universe)}, symbol)
      UNION ALL
      SELECT source_topic, source_partition, source_offset
      FROM signal.intraday_trades_v1
      WHERE universe_id = ${sql.param('String', request.universeId)}
        AND universe_symbol_hash = ${sql.param('String', request.universeSymbolHash)}
        AND feed = ${sql.param('String', request.feed)}
        AND source_topic = ${sql.param('String', request.sourceTopics.trades)}
        AND has(${sql.param('Array(String)', request.universe)}, symbol)
    )
    GROUP BY source_topic, source_partition
    ORDER BY source_topic, source_partition
  `

  const loadIntradayBars = (request: IntradaySnapshotRequest) => {
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
          AND has(${sql.param('Array(String)', request.universe)}, symbol)
          AND event_ts >= parseDateTime64BestEffort(${time.start}, 3, 'UTC')
          AND event_ts < parseDateTime64BestEffort(${time.end}, 3, 'UTC')
          AND ingest_ts <= parseDateTime64BestEffort(${time.observed}, 3, 'UTC')
          AND has(${sql.param('Array(String)', watermark.partitions)}, toString(source_partition))
          AND source_offset <= ifNull(
            toUInt64OrNull(arrayElement(
              ${sql.param('Array(String)', watermark.offsets)},
              indexOf(${sql.param('Array(String)', watermark.partitions)}, toString(source_partition))
            )),
            0
          )
        ORDER BY source_offset DESC
        LIMIT 1 BY universe_id, feed, symbol, event_ts
      )
      ORDER BY event_ts, symbol, source_topic, source_partition, source_offset
    `
  }

  const loadIntradayQuotes = (request: IntradaySnapshotRequest) => {
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
        toString(bid_price) AS bid_price,
        toString(bid_size) AS bid_size,
        toString(ask_price) AS ask_price,
        toString(ask_size) AS ask_size,
        toString(schema_version) AS schema_version
      FROM signal.intraday_quotes_v1 FINAL
      WHERE universe_id = ${sql.param('String', request.universeId)}
        AND universe_symbol_hash = ${sql.param('String', request.universeSymbolHash)}
        AND feed = ${sql.param('String', request.feed)}
        AND source_topic = ${sql.param('String', request.sourceTopics.quotes)}
        AND has(${sql.param('Array(String)', request.universe)}, symbol)
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
      ORDER BY event_ts, symbol, source_topic, source_partition, source_offset
    `
  }

  const loadIntradayTrades = (request: IntradaySnapshotRequest) => {
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
        toString(price) AS price,
        toString(size) AS size,
        toString(schema_version) AS schema_version
      FROM signal.intraday_trades_v1 FINAL
      WHERE universe_id = ${sql.param('String', request.universeId)}
        AND universe_symbol_hash = ${sql.param('String', request.universeSymbolHash)}
        AND feed = ${sql.param('String', request.feed)}
        AND source_topic = ${sql.param('String', request.sourceTopics.trades)}
        AND has(${sql.param('Array(String)', request.universe)}, symbol)
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
      ORDER BY event_ts, symbol, source_topic, source_partition, source_offset
    `
  }

  return { captureIntradayArchiveWatermarks, loadIntradayBars, loadIntradayQuotes, loadIntradayTrades }
}
