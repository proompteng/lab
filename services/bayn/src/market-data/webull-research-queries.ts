import type { ClickhouseClient } from '@effect/sql-clickhouse'

import type { WebullResearchInput } from './webull-research'

export const makeWebullResearchQueries = (sql: ClickhouseClient.ClickhouseClient, input: WebullResearchInput) => {
  const start = sql`parseDateTime64BestEffort(${sql.param('String', input.startAt)}, 9, 'UTC')`
  const end = sql`parseDateTime64BestEffort(${sql.param('String', new Date(Date.parse(input.startAt) + input.durationMinutes * 60_000).toISOString())}, 9, 'UTC')`
  const evidenceEnd = sql`parseDateTime64BestEffort(${sql.param('String', input.evidenceAsOf ?? new Date(Date.parse(input.startAt) + input.durationMinutes * 60_000).toISOString())}, 9, 'UTC')`
  const requestStart = sql`parseDateTime64BestEffort(${sql.param('String', new Date(Date.parse(input.startAt) - 360_000).toISOString())}, 9, 'UTC')`
  const symbols = sql.param('Array(String)', input.selection.kind === 'symbols' ? input.selection.symbols : [])
  // Read one extra row so a bounded query can never silently claim complete coverage.
  const limit = sql.param('UInt32', 100_001)
  return {
    bars: sql`
      WITH observations AS (
        SELECT provider, feed, b.1 AS symbol, b.2 AS bar_start_ms, b.3 AS session,
          tuple(b.4, b.5, b.6, b.7, b.8, received_at, archived_at,
            toString(capture_id), source_topic, source_partition, source_offset, payload_sha256) AS observation,
          tuple(received_at, source_partition, source_offset) AS revision
        FROM signal.webull_research_events_v1 ARRAY JOIN minute_bars AS b
        WHERE channel = 'bars' AND validation_status = 'VALID'
          AND received_at >= ${start} AND received_at <= ${evidenceEnd}
          AND fromUnixTimestamp64Milli(bar_start_ms, 'UTC') >= ${start}
          AND fromUnixTimestamp64Milli(bar_start_ms, 'UTC') + INTERVAL 1 MINUTE <= ${end}
          AND (empty(${symbols}) OR symbol IN ${symbols})
      ), canonical AS (
        SELECT provider, feed, symbol, bar_start_ms, session,
          argMax(observation, revision) AS latest, argMin(observation, revision) AS first,
          count() AS capture_observations
        FROM observations GROUP BY provider, feed, symbol, bar_start_ms, session
      )
      SELECT provider, feed, symbol, toString(bar_start_ms) AS bar_start_ms, session,
        latest.1 AS open, latest.2 AS high, latest.3 AS low, latest.4 AS close, latest.5 AS volume,
        toString(toUnixTimestamp64Nano(latest.6)) AS received_ns,
        toString(toUnixTimestamp64Nano(latest.7)) AS archived_ns,
        latest.8 AS capture_id, latest.9 AS source_topic, latest.10 AS source_partition,
        toString(latest.11) AS source_offset, latest.12 AS payload_sha256,
        toString(toUnixTimestamp64Nano(first.6)) AS first_received_ns,
        first.8 AS first_capture_id, first.9 AS first_source_topic, first.10 AS first_source_partition,
        toString(first.11) AS first_source_offset, first.12 AS first_payload_sha256,
        toString(capture_observations) AS capture_observations
      FROM canonical ORDER BY toInt64(bar_start_ms), symbol, session LIMIT ${limit}`,
    requests: sql`
      WITH latest_requests AS (
        SELECT provider, feed, r.1 AS symbol,
          argMax(tuple(r.2, r.3, r.4, received_at, source_topic, source_partition, source_offset, payload_sha256),
            tuple(received_at, source_partition, source_offset)) AS latest
        FROM signal.webull_research_events_v1 ARRAY JOIN bar_requests AS r
        WHERE received_at >= ${requestStart} AND received_at <= ${evidenceEnd}
          AND (empty(${symbols}) OR symbol IN ${symbols})
        GROUP BY provider, feed, symbol
      )
      SELECT provider, feed, symbol, latest.1 AS request_state, latest.2 AS observed_count, latest.3 AS excluded_count,
        toString(toUnixTimestamp64Nano(latest.4)) AS received_ns,
        latest.5 AS source_topic, latest.6 AS source_partition, toString(latest.7) AS source_offset, latest.8 AS payload_sha256
      FROM latest_requests ORDER BY symbol LIMIT ${limit}`,
    gaps: sql`
      SELECT gap_channel AS affected_channel, gap_reason AS reason, gap_error AS error_class,
        gap_from AS from_time, gap_to AS to_time,
        toString(toUnixTimestamp64Nano(received_at)) AS received_ns,
        source_topic, source_partition, toString(source_offset) AS source_offset, payload_sha256
      FROM signal.webull_research_events_v1
      WHERE channel = 'gap' AND received_at >= ${start} AND received_at <= ${evidenceEnd}
      ORDER BY received_at, source_partition, source_offset LIMIT ${limit}`,
    alpaca: sql`
      WITH canonical AS (
        SELECT provider, feed, universe_id, market_session AS session, symbol,
          coalesce(event_ts_exact, toDateTime64(event_ts, 9, 'UTC')) AS bar_start,
          argMax(tuple(open, high, low, close, volume,
            coalesce(ingest_ts_exact, toDateTime64(ingest_ts, 9, 'UTC')), source_topic, source_partition, source_offset),
            tuple(coalesce(ingest_ts_exact, toDateTime64(ingest_ts, 9, 'UTC')), source_partition, source_offset)) AS latest
        FROM signal.intraday_bars_1m_v2 FINAL
        WHERE provider = 'alpaca' AND feed = 'iex' AND universe_id = 'torghut-core-equity-v2' AND is_final = 1
          AND event_ts >= ${start} AND event_ts + INTERVAL 1 MINUTE <= ${end}
          AND coalesce(ingest_ts_exact, toDateTime64(ingest_ts, 9, 'UTC')) <= ${evidenceEnd}
          AND (empty(${symbols}) OR symbol IN ${symbols})
        GROUP BY provider, feed, universe_id, session, symbol, bar_start
      )
      SELECT provider, feed, universe_id, session, symbol, toString(toUnixTimestamp64Milli(bar_start)) AS bar_start_ms,
        toString(latest.1) AS open, toString(latest.2) AS high, toString(latest.3) AS low,
        toString(latest.4) AS close, toString(latest.5) AS volume,
        toString(toUnixTimestamp64Nano(latest.6)) AS received_ns,
        latest.7 AS source_topic, latest.8 AS source_partition, toString(latest.9) AS source_offset
      FROM canonical ORDER BY toInt64(bar_start_ms), symbol LIMIT ${limit}`,
  }
}
