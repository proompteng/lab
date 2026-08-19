import { ClickhouseClient } from '@effect/sql-clickhouse'
import { Effect, Layer } from 'effect'

import { operationalError } from '../../errors'
import { marketDataOperationError } from '../errors'
import { IntradayMarketData, IntradaySnapshotFailure, type IntradayMarketDataService } from './model'
import { makeIntradayMarketDataQueries } from './queries'
import {
  verifyIntradayArchiveWatermarks,
  verifyIntradaySnapshot,
  verifyIntradaySnapshotQuery,
  verifyIntradaySnapshotRequest,
} from './verification'

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
  return {
    captureVersion: (query) =>
      Effect.fromResult(verifyIntradaySnapshotQuery(query)).pipe(
        Effect.flatMap((verified) => captureIntradayArchiveWatermarks(verified)),
        Effect.flatMap((rows) => Effect.fromResult(verifyIntradayArchiveWatermarks(query, rows))),
        Effect.mapError(mapFailure),
      ),
    loadSnapshot: (request) =>
      Effect.fromResult(verifyIntradaySnapshotRequest(request)).pipe(
        Effect.flatMap((verified) =>
          Effect.all(
            {
              archiveWatermarks: captureIntradayArchiveWatermarks(verified),
              bars: loadIntradayBars(verified),
              quotes: loadIntradayQuotes(verified),
              trades: loadIntradayTrades(verified),
            },
            { concurrency: 4 },
          ),
        ),
        Effect.flatMap((rows) => Effect.fromResult(verifyIntradaySnapshot(request, rows))),
        Effect.mapError(mapFailure),
      ),
  }
})

export const IntradayMarketDataLive = Layer.effect(IntradayMarketData, makeIntradayMarketData)
