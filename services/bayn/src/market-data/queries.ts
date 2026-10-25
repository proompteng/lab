import { randomUUID } from 'node:crypto'
import type { ClickhouseClient } from '@effect/sql-clickhouse'
import { Effect } from 'effect'
import { withObservedSpan } from '../telemetry'

export const makeDailySnapshotQueries = (sql: ClickhouseClient.ClickhouseClient) => {
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

  const loadSnapshotPublicationManifest = (snapshotId: string) =>
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
      WHERE snapshot_id = ${sql.param('String', snapshotId)}
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
  return { loadSnapshotPublicationManifest, loadPublicationSessions, loadSnapshotPublicationBars }
}
