import { ClickhouseClient } from '@effect/sql-clickhouse'
import { Effect, Layer, Option, Result, pipe } from 'effect'
import type { SqlError } from 'effect/unstable/sql/SqlError'

import type { RuntimeConfig } from '../config'
import { OperationalError } from '../errors'
import {
  renderMarketDataVerificationError,
  selectCyclePublicationManifests,
  selectPublicationManifest,
  verifyFinalizedCalendar,
  verifyFinalizedManifest,
  verifyFinalizedSnapshot,
  verifyBoundFinalizedPublication,
  verifyCyclePublications,
  type MarketDataVerificationError,
} from '../market-data-verification'
import { currentUtcInstant } from '../time'
import { marketDataOperationError } from './errors'
import {
  MarketData,
  type FinalizedPublicationDiscovery,
  type FinalizedPublicationInspection,
  type FinalizedPublicationRequest,
  type MarketDataContract,
  type MarketDataService,
  type SnapshotPublicationRequest,
  type SnapshotRequest,
} from './model'
import { decodeSnapshotRows, type SignalManifestRow } from './rows'

// A 21-calendar-day catch-up interval contains at most 15 weekday publications. One extra bounded row keeps the
// MarketData seam complete while the runner clamps by calendar date before its single broker-calendar read.
const cyclePublicationCandidateLimit = 16

export const makeMarketData = (
  config: Pick<RuntimeConfig, 'clickhouse' | 'operationTimeoutMs'>,
  contract: MarketDataContract,
): Effect.Effect<MarketDataService, never, ClickhouseClient.ClickhouseClient> =>
  pipe(
    ClickhouseClient.ClickhouseClient,
    Effect.map((sql): MarketDataService => {
      // The Bayn principal is readonly=1, so query-level setting changes are forbidden. Snapshot counts and content
      // hashes below make an incomplete or stale replica read fail closed.
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

      const request = (observedAt: string): SnapshotRequest => {
        const common = {
          snapshotId: config.clickhouse.snapshotId,
          publicationAsOf: config.clickhouse.publicationAsOf,
          calendarVersion: config.clickhouse.calendarVersion,
          universe: contract.universe,
          bounds: config.clickhouse.bounds,
          observedAt,
        } as const
        return {
          ...common,
          universeId: contract.universeId,
          universeSymbolHash: contract.universeSymbolHash,
          historyStart: contract.historyStart,
          evaluationStart: contract.evaluationStart,
        }
      }
      const snapshotPublicationRequest = (input: SnapshotPublicationRequest, observedAt: string): SnapshotRequest => ({
        snapshotId: input.snapshotId,
        publicationAsOf: input.signalSessionDate,
        calendarVersion: input.signalCalendarVersion,
        universe: contract.universe,
        bounds: {
          schemaVersion: 'bayn.evaluation-bounds.v1',
          dataStart: contract.historyStart,
          dataEnd: input.signalSessionDate,
          lookbackStart: contract.historyStart,
          evaluationStart: contract.evaluationStart,
          evaluationEnd: input.signalSessionDate,
        },
        observedAt,
        universeId: contract.universeId,
        universeSymbolHash: contract.universeSymbolHash,
        historyStart: contract.historyStart,
        evaluationStart: contract.evaluationStart,
      })
      const verify = <A>(
        operation: 'check' | 'inspect' | 'inspect-publication' | 'verify',
        result: Result.Result<A, MarketDataVerificationError>,
      ): Effect.Effect<A, OperationalError> =>
        pipe(
          Effect.fromResult(result),
          Effect.mapError(
            (cause) =>
              new OperationalError({
                component: 'market-data',
                operation,
                message: renderMarketDataVerificationError(cause),
                retryable: false,
                cause,
              }),
          ),
        )

      const observedAt = currentUtcInstant

      const decodeManifestRows = (
        rows: readonly unknown[],
      ): Result.Result<readonly SignalManifestRow[], MarketDataVerificationError> =>
        pipe(
          decodeSnapshotRows([], [], rows),
          Result.map((snapshot) => snapshot.manifests),
        )

      const inspectPublicationRows = (
        input: FinalizedPublicationRequest,
        manifestRows: readonly unknown[],
        expectedSnapshotId?: string,
      ): Effect.Effect<FinalizedPublicationInspection, OperationalError | SqlError> =>
        pipe(
          decodeManifestRows(manifestRows),
          Result.flatMap((manifests) => selectPublicationManifest(manifests, expectedSnapshotId)),
          (result) => verify('inspect-publication', result),
          Effect.flatMap((manifest) =>
            pipe(
              Option.fromNullishOr(manifest),
              Option.match({
                onNone: () =>
                  pipe(
                    observedAt,
                    Effect.map(
                      (instant): FinalizedPublicationInspection => ({ outcome: 'MISSING', observedAt: instant }),
                    ),
                  ),
                onSome: (selected) =>
                  pipe(
                    loadPublicationSessions(selected.snapshot_id),
                    Effect.flatMap((sessionRows) =>
                      pipe(
                        observedAt,
                        Effect.flatMap((inspectedAt) =>
                          pipe(
                            decodeSnapshotRows([], sessionRows, manifestRows),
                            Result.flatMap((rows) =>
                              verifyBoundFinalizedPublication(rows, input, contract, inspectedAt, expectedSnapshotId),
                            ),
                            (result) => verify('inspect-publication', result),
                            Effect.map(
                              (inspection): FinalizedPublicationInspection => ({
                                outcome: 'FINALIZED',
                                observedAt: inspectedAt,
                                inspection,
                              }),
                            ),
                          ),
                        ),
                      ),
                    ),
                  ),
              }),
            ),
          ),
        )

      const inspectCyclePublicationRows = (
        manifestRows: readonly unknown[],
      ): Effect.Effect<FinalizedPublicationDiscovery, OperationalError | SqlError> =>
        pipe(
          decodeManifestRows(manifestRows),
          Result.flatMap((manifests) => selectCyclePublicationManifests(manifests, cyclePublicationCandidateLimit)),
          (result) => verify('inspect-publication', result),
          Effect.flatMap((manifests) =>
            pipe(
              Option.fromNullishOr(manifests[0]),
              Option.match({
                onNone: () =>
                  pipe(
                    observedAt,
                    Effect.map(
                      (instant): FinalizedPublicationDiscovery => ({ outcome: 'MISSING', observedAt: instant }),
                    ),
                  ),
                onSome: () => {
                  const snapshotIds = manifests.map((manifest) => manifest.snapshot_id)
                  return pipe(
                    loadCyclePublicationSessions(snapshotIds),
                    Effect.flatMap((sessionRows) =>
                      pipe(
                        observedAt,
                        Effect.flatMap((inspectedAt) =>
                          pipe(
                            decodeSnapshotRows([], sessionRows, []),
                            Result.flatMap((rows) =>
                              verifyCyclePublications(manifests, rows.sessions, contract, inspectedAt),
                            ),
                            (result) => verify('inspect-publication', result),
                            Effect.map(
                              (publications): FinalizedPublicationDiscovery => ({
                                outcome: 'FINALIZED',
                                observedAt: inspectedAt,
                                publications,
                              }),
                            ),
                          ),
                        ),
                      ),
                    ),
                  )
                },
              }),
            ),
          ),
        )

      return {
        check: pipe(
          observedAt,
          Effect.flatMap((instant) =>
            pipe(
              loadManifests,
              Effect.flatMap((manifests) =>
                pipe(
                  decodeSnapshotRows([], [], manifests),
                  Result.flatMap((rows) => verifyFinalizedManifest(rows.manifests, request(instant))),
                  (result) => verify('check', result),
                ),
              ),
            ),
          ),
          Effect.mapError((cause) =>
            marketDataOperationError('check', 'failed to check finalized Signal snapshot', cause),
          ),
        ),
        inspect: pipe(
          observedAt,
          Effect.flatMap((instant) =>
            pipe(
              Effect.all({ manifests: loadManifests, sessions: loadSessions }, { concurrency: 2 }),
              Effect.flatMap(({ manifests, sessions }) =>
                pipe(
                  decodeSnapshotRows([], sessions, manifests),
                  Result.flatMap((rows) => verifyFinalizedCalendar(rows, request(instant))),
                  (result) => verify('inspect', result),
                ),
              ),
            ),
          ),
          Effect.mapError((cause) =>
            marketDataOperationError('inspect', 'failed to inspect finalized Signal calendar', cause),
          ),
        ),
        inspectCyclePublications: loadCyclePublicationManifests.pipe(
          Effect.flatMap(inspectCyclePublicationRows),
          Effect.mapError((cause) =>
            marketDataOperationError(
              'inspect-publication',
              'failed to inspect bounded finalized Signal publication candidates',
              cause,
            ),
          ),
        ),
        inspectPublication: (input) =>
          loadPublicationManifests(input).pipe(
            Effect.flatMap((manifestRows) => inspectPublicationRows(input, manifestRows)),
            Effect.mapError((cause) =>
              marketDataOperationError(
                'inspect-publication',
                `failed to inspect finalized Signal publication for ${input.signalSessionDate}`,
                cause,
              ),
            ),
          ),
        inspectSnapshotPublication: (input) =>
          loadSnapshotPublicationManifest(input).pipe(
            Effect.flatMap((manifestRows) => inspectPublicationRows(input, manifestRows, input.snapshotId)),
            Effect.mapError((cause) =>
              marketDataOperationError(
                'inspect-publication',
                `failed to inspect bound finalized Signal publication ${input.snapshotId}`,
                cause,
              ),
            ),
          ),
        loadSnapshotPublication: (input) =>
          pipe(
            Effect.all(
              {
                manifests: loadSnapshotPublicationManifest(input),
                sessions: loadPublicationSessions(input.snapshotId),
                bars: loadSnapshotPublicationBars(input.snapshotId),
              },
              { concurrency: 3 },
            ),
            Effect.flatMap(({ bars, manifests, sessions }) =>
              pipe(
                observedAt,
                Effect.flatMap((instant) =>
                  pipe(
                    decodeSnapshotRows(bars, sessions, manifests),
                    Result.flatMap((rows) => verifyFinalizedSnapshot(rows, snapshotPublicationRequest(input, instant))),
                    (result) => verify('verify', result),
                  ),
                ),
              ),
            ),
            Effect.mapError((cause) =>
              marketDataOperationError(
                'load',
                `failed to load bound finalized Signal snapshot ${input.snapshotId}`,
                cause,
              ),
            ),
          ),
        load: pipe(
          observedAt,
          Effect.flatMap((instant) =>
            pipe(
              Effect.all({ manifests: loadManifests, sessions: loadSessions, bars: loadBars }, { concurrency: 3 }),
              Effect.flatMap(({ bars, manifests, sessions }) =>
                pipe(
                  decodeSnapshotRows(bars, sessions, manifests),
                  Result.flatMap((rows) => verifyFinalizedSnapshot(rows, request(instant))),
                  (result) => verify('verify', result),
                ),
              ),
            ),
          ),
          Effect.mapError((cause) =>
            marketDataOperationError('load', 'failed to load finalized Signal snapshot', cause),
          ),
        ),
      }
    }),
  )

export const MarketDataLive = (
  config: Pick<RuntimeConfig, 'clickhouse' | 'operationTimeoutMs'>,
  contract: MarketDataContract,
): Layer.Layer<MarketData, never, ClickhouseClient.ClickhouseClient> =>
  Layer.effect(MarketData, makeMarketData(config, contract))
