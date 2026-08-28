import { ClickhouseClient } from '@effect/sql-clickhouse'
import { Effect, Layer, type Result } from 'effect'

import { operationalError } from '../../errors'
import { marketDataOperationError } from '../errors'
import {
  IntradayMarketData,
  IntradaySnapshotFailure,
  intradaySnapshotSymbols,
  type ArchiveVerifiedIntradayMarketSnapshot,
  type IntradayMarketDataService,
  type IntradayMarketSnapshot,
  type IntradaySnapshotRequest,
} from './model'
import { intradayArchivePageSize, makeIntradayMarketDataQueries, type IntradayArchivePageCursor } from './queries'
import {
  decodeIntradayBarRows,
  decodeIntradayQuoteRows,
  decodeIntradayTradeRows,
  type IntradayBarRow,
  type IntradayQuoteRow,
  type IntradayTradeRow,
} from './rows'
import { intradayInstantNanos } from './time'
import {
  verifyIntradayArchiveWatermarks,
  verifyIntradaySnapshot,
  verifyIntradaySnapshotQuery,
  verifyIntradaySnapshotRequest,
  reverifyIntradayMarketSnapshot,
} from './verification'

type IntradayPageRow = IntradayBarRow | IntradayQuoteRow | IntradayTradeRow
type IntradayPageDecoder = (
  rows: readonly unknown[],
) => Result.Result<readonly IntradayPageRow[], IntradaySnapshotFailure>

const maximumIntradayArchivePages = 100
const compareText = (left: string, right: string): number => (left < right ? -1 : left > right ? 1 : 0)
const compareBigInt = (left: bigint, right: bigint): number => (left < right ? -1 : left > right ? 1 : 0)
const pageCursor = (row: IntradayPageRow): IntradayArchivePageCursor => ({
  eventAt: row.event_at,
  symbol: row.symbol,
  sourceTopic: row.source_topic,
  sourcePartition: Number(row.source_partition),
  sourceOffset: row.source_offset,
})
const comparePageCursors = (left: IntradayArchivePageCursor, right: IntradayArchivePageCursor): number =>
  compareBigInt(intradayInstantNanos(left.eventAt), intradayInstantNanos(right.eventAt)) ||
  compareText(left.symbol, right.symbol) ||
  compareText(left.sourceTopic, right.sourceTopic) ||
  left.sourcePartition - right.sourcePartition ||
  compareBigInt(BigInt(left.sourceOffset), BigInt(right.sourceOffset))

export const loadIntradayArchivePages = <E, R>(
  loadPage: (after?: IntradayArchivePageCursor) => Effect.Effect<readonly unknown[], E, R>,
  decodePage: IntradayPageDecoder,
  maximumRows: number,
  pageSize = intradayArchivePageSize,
): Effect.Effect<readonly unknown[], E | IntradaySnapshotFailure, R> =>
  Effect.gen(function* () {
    if (!Number.isSafeInteger(maximumRows) || maximumRows < 1) {
      return yield* new IntradaySnapshotFailure({
        reason: 'rows',
        message: 'intraday archive row budget must be a positive safe integer',
        facts: { maximumRows },
      })
    }
    const rows: unknown[] = []
    let after: IntradayArchivePageCursor | undefined
    for (let page = 0; page < maximumIntradayArchivePages; page += 1) {
      const loaded = yield* loadPage(after)
      if (loaded.length > pageSize) {
        return yield* new IntradaySnapshotFailure({
          reason: 'rows',
          message: 'intraday archive page exceeded its fixed row limit',
          facts: { page, pageSize, rowCount: loaded.length },
        })
      }
      const decoded = yield* Effect.fromResult(decodePage(loaded))
      if (rows.length + loaded.length > maximumRows) {
        return yield* new IntradaySnapshotFailure({
          reason: 'rows',
          message: 'intraday archive snapshot exceeded its aggregate row budget',
          facts: { maximumRows, retainedRows: rows.length, incomingRows: loaded.length },
        })
      }
      rows.push(...loaded)
      if (loaded.length < pageSize) return Object.freeze(rows)
      const last = decoded.at(-1)
      if (last === undefined) {
        return yield* new IntradaySnapshotFailure({
          reason: 'rows',
          message: 'full intraday archive page has no canonical continuation row',
          facts: { page, pageSize },
        })
      }
      const next = pageCursor(last)
      if (after !== undefined && comparePageCursors(after, next) >= 0) {
        return yield* new IntradaySnapshotFailure({
          reason: 'ordering',
          message: 'intraday archive pagination did not advance its canonical cursor',
          facts: { page },
        })
      }
      after = next
    }
    return yield* new IntradaySnapshotFailure({
      reason: 'rows',
      message: 'intraday archive snapshot exceeded the bounded page budget',
      facts: { maximumPages: maximumIntradayArchivePages, pageSize },
    })
  })

const requestFromSnapshot = (snapshot: IntradayMarketSnapshot): IntradaySnapshotRequest => {
  const { manifest } = snapshot
  return {
    sessionDate: manifest.sessionDate,
    calendar: manifest.calendar,
    rangeStartAt: manifest.rangeStartAt,
    rangeEndAt: manifest.rangeEndAt,
    observedAt: manifest.observedAt,
    universeId: manifest.universeId,
    universeSymbolHash: manifest.universeSymbolHash,
    universe: manifest.symbols,
    feed: manifest.feed,
    delayClass: manifest.delayClass,
    sourceTopics: manifest.sourceTopics,
    maximumQuoteAgeMs: manifest.maximumQuoteAgeMs,
    minimumWatermarkLagMs: manifest.minimumWatermarkLagMs,
    archiveWatermarks: manifest.archiveWatermarks,
  }
}

/**
 * Re-loads a caller-provided snapshot at its exact immutable watermarks. Pure
 * envelope revalidation cannot establish which tied archive row won the
 * canonical query, so any replay boundary must use this check before invoking
 * a strategy artifact.
 */
export const verifyIntradayArchiveSnapshot = <E, R>(
  loadSnapshot: (request: IntradaySnapshotRequest) => Effect.Effect<ArchiveVerifiedIntradayMarketSnapshot, E, R>,
  snapshot: IntradayMarketSnapshot,
): Effect.Effect<ArchiveVerifiedIntradayMarketSnapshot, E | IntradaySnapshotFailure, R> =>
  Effect.fromResult(reverifyIntradayMarketSnapshot(snapshot)).pipe(
    Effect.flatMap((bound) =>
      loadSnapshot(requestFromSnapshot(bound)).pipe(
        Effect.flatMap((authoritative) =>
          authoritative.manifest.snapshotId === bound.manifest.snapshotId
            ? Effect.succeed(authoritative)
            : Effect.fail(
                new IntradaySnapshotFailure({
                  reason: 'hash',
                  message: 'intraday replay snapshot is not the canonical immutable archive winner',
                  facts: {
                    boundSnapshotId: bound.manifest.snapshotId,
                    authoritativeSnapshotId: authoritative.manifest.snapshotId,
                  },
                }),
              ),
        ),
      ),
    ),
  )

export const makeIntradayMarketData: Effect.Effect<
  IntradayMarketDataService,
  never,
  ClickhouseClient.ClickhouseClient
> = Effect.map(ClickhouseClient.ClickhouseClient, (sql): IntradayMarketDataService => {
  const { captureIntradayArchiveWatermarks, loadIntradayBars, loadIntradayQuotes, loadIntradayTrades } =
    makeIntradayMarketDataQueries(sql)
  const mapFailure = (cause: unknown) =>
    cause instanceof IntradaySnapshotFailure
      ? operationalError({
          component: 'market-data',
          operation: 'load-intraday',
          message: cause.message,
          cause,
        })
      : marketDataOperationError('load', 'failed to load immutable intraday market snapshot', cause)
  const loadSnapshot: IntradayMarketDataService['loadSnapshot'] = (request) =>
    Effect.fromResult(verifyIntradaySnapshotRequest(request)).pipe(
      Effect.flatMap((verified) =>
        Effect.all(
          {
            archiveWatermarks: captureIntradayArchiveWatermarks(verified),
            bars: loadIntradayArchivePages(
              (after) => loadIntradayBars(verified, after),
              decodeIntradayBarRows,
              intradaySnapshotSymbols(verified).length *
                ((Date.parse(verified.rangeEndAt) - Date.parse(verified.rangeStartAt)) / 60_000),
            ),
            quotes: loadIntradayArchivePages(
              (after) => loadIntradayQuotes(verified, after),
              decodeIntradayQuoteRows,
              intradaySnapshotSymbols(verified).length,
            ),
            trades: loadIntradayArchivePages(
              (after) => loadIntradayTrades(verified, after),
              decodeIntradayTradeRows,
              intradaySnapshotSymbols(verified).length,
            ),
          },
          { concurrency: 4 },
        ).pipe(Effect.map((rows) => ({ rows, verified }))),
      ),
      Effect.flatMap(({ rows, verified }) => Effect.fromResult(verifyIntradaySnapshot(verified, rows))),
      Effect.map((snapshot) => snapshot as ArchiveVerifiedIntradayMarketSnapshot),
      Effect.mapError(mapFailure),
    )
  return {
    captureVersion: (query) =>
      Effect.fromResult(verifyIntradaySnapshotQuery(query)).pipe(
        Effect.flatMap((verified) =>
          captureIntradayArchiveWatermarks(verified).pipe(Effect.map((rows) => ({ rows, verified }))),
        ),
        Effect.flatMap(({ rows, verified }) => Effect.fromResult(verifyIntradayArchiveWatermarks(verified, rows))),
        Effect.mapError(mapFailure),
      ),
    loadSnapshot,
    verifyArchiveSnapshot: (snapshot) =>
      verifyIntradayArchiveSnapshot(loadSnapshot, snapshot).pipe(Effect.mapError(mapFailure)),
  }
})

export const IntradayMarketDataLive = Layer.effect(IntradayMarketData, makeIntradayMarketData)
