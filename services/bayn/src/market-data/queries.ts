import type { ClickhouseClient } from '@effect/sql-clickhouse'

import type { RuntimeConfig } from '../config'
import type { FinalizedPublicationRequest, MarketDataContract, SnapshotPublicationRequest } from './model'

// A 21-calendar-day catch-up interval contains at most 15 weekday publications. One extra bounded row keeps the
// MarketData seam complete while the runner clamps by calendar date before its single broker-calendar read.
export const cyclePublicationCandidateLimit = 16

export const makeMarketDataQueries = (
  sql: ClickhouseClient.ClickhouseClient,
  config: Pick<RuntimeConfig, 'clickhouse'>,
  contract: MarketDataContract,
) => {
  // The Bayn principal is readonly=1, so query-level setting changes are forbidden. Snapshot counts and content
  // hashes make an incomplete or stale replica read fail closed.
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

  return {
    loadBars,
    loadCyclePublicationManifests,
    loadCyclePublicationSessions,
    loadManifests,
    loadPublicationManifests,
    loadPublicationSessions,
    loadSessions,
    loadSnapshotPublicationBars,
    loadSnapshotPublicationManifest,
  }
}
