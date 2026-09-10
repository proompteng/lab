import { randomUUID } from 'node:crypto'

import type { ClickhouseClient } from '@effect/sql-clickhouse'
import { Effect } from 'effect'

import type { RuntimeConfig } from '../config'
import { withObservedSpan } from '../telemetry'
import type { FinalizedPublicationRequest, MarketDataContract, SnapshotPublicationRequest } from './model'
import { Pipeable } from '../pipeable'

// A 21-calendar-day catch-up interval contains at most 15 weekday publications. One extra bounded row keeps the
// MarketData seam complete while the runner clamps by calendar date before its single broker-calendar read.
export const cyclePublicationCandidateLimit = 16

const makeMarketDataQueriesDataFirst = (
  sql: ClickhouseClient.ClickhouseClient,
  config: Pick<RuntimeConfig, 'clickhouse'>,
  contract: MarketDataContract,
) => {
  const runQuery = <A, E, R>(logicalOperation: string, query: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
    Effect.suspend(() =>
      query.pipe(
        sql.withQueryId(`bayn-${logicalOperation}-${randomUUID()}`),
        withObservedSpan('market-data.clickhouse', {
          'db.system': 'clickhouse',
          'db.operation.name': logicalOperation,
        }),
      ),
    )

  // The Bayn principal is readonly=1, so query-level setting changes are forbidden. Snapshot counts and content
  // hashes make an incomplete or stale replica read fail closed.
  const loadManifests = runQuery(
    'manifest',
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
    WHERE snapshot_id = ${sql.param('String', config.clickhouse.snapshotId)}
    ORDER BY finalized_at
  `,
  )

  const loadSessions = runQuery(
    'sessions',
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
    WHERE snapshot_id = ${sql.param('String', config.clickhouse.snapshotId)}
    ORDER BY session_date
  `,
  )

  const loadBars = runQuery(
    'bars',
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
    WHERE snapshot_id = ${sql.param('String', config.clickhouse.snapshotId)}
    ORDER BY session_date, symbol
  `,
  )

  const loadPublicationManifests = (request: FinalizedPublicationRequest) =>
    runQuery(
      'cycle-manifest',
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
        toString(manifest.requested_start) AS requested_start,
        toString(manifest.publication_asof) AS publication_asof,
        toString(manifest.first_session) AS first_session,
        toString(manifest.last_session) AS last_session,
        symbol_count,
        session_count,
        bar_count,
        bars_content_hash,
        sessions_content_hash,
        manifest_content_hash,
        toString(manifest.finalized_at) AS finalized_at
      FROM signal.snapshot_manifests_v2 AS manifest
      WHERE manifest.universe_id = ${sql.param('String', contract.universeId)}
        AND manifest.universe_symbol_hash = ${sql.param('String', contract.universeSymbolHash)}
        AND manifest.requested_start = toDate(${sql.param('String', contract.historyStart)})
        AND manifest.publication_asof = toDate(${sql.param('String', request.signalSessionDate)})
        AND manifest.calendar_version = ${sql.param('String', request.signalCalendarVersion)}
      ORDER BY manifest.finalized_at DESC, manifest.snapshot_id DESC
      LIMIT 1
    `,
    )

  const loadCyclePublicationManifests = runQuery(
    'cycle-publication-candidates',
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
      toString(manifest.requested_start) AS requested_start,
      toString(manifest.publication_asof) AS publication_asof,
      toString(manifest.first_session) AS first_session,
      toString(manifest.last_session) AS last_session,
      symbol_count,
      session_count,
      bar_count,
      bars_content_hash,
      sessions_content_hash,
      manifest_content_hash,
      toString(manifest.finalized_at) AS finalized_at
    FROM signal.snapshot_manifests_v2 AS manifest
    WHERE manifest.universe_id = ${sql.param('String', contract.universeId)}
      AND manifest.universe_symbol_hash = ${sql.param('String', contract.universeSymbolHash)}
      AND manifest.requested_start = toDate(${sql.param('String', contract.historyStart)})
    ORDER BY manifest.publication_asof DESC, manifest.finalized_at DESC, manifest.snapshot_id DESC
    LIMIT 1 BY manifest.publication_asof
    LIMIT ${sql.param('UInt8', cyclePublicationCandidateLimit)}
  `,
  )

  const loadSnapshotPublicationManifest = (request: SnapshotPublicationRequest) =>
    runQuery(
      'bound-manifest',
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
    `,
    )

  const loadPublicationSessions = (snapshotId: string) =>
    runQuery(
      'cycle-sessions',
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
    `,
    )

  const loadSnapshotPublicationBars = (snapshotId: string) =>
    runQuery(
      'bound-bars',
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
    `,
    )

  const loadCyclePublicationSessions = (snapshotIds: readonly string[]) =>
    runQuery(
      'cycle-publication-candidate-sessions',
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
    `,
    )

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

export const makeMarketDataQueries = Pipeable.dual(3, makeMarketDataQueriesDataFirst)
