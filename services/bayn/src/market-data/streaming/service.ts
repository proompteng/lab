import { Effect, Layer, Result } from 'effect'
import { PgClient } from '@effect/sql-pg'

import { operationalError } from '../../errors'
import { marketDataOperationError } from '../errors'
import { IntradayMarketData, type IntradayMarketDataService, type IntradaySnapshotQuery } from '../intraday/model'
import { persistIntradayRecordRows } from '../intraday/verification'
import { KafkaMarketProjection } from './kafka'
import { recoverStreamingSnapshotReference, streamingSnapshotReference } from './reference'
import { reproduceStreamingSnapshot } from './replay'
import {
  constructStreamingSnapshot,
  type StreamingMarketSnapshot,
  type StreamingVerifiedMarketSnapshot,
} from './snapshot'

export const streamingIntradayMarketDataLive = (shadowOnly = false) =>
  Layer.effect(
    IntradayMarketData,
    Effect.gen(function* () {
      const archive = yield* IntradayMarketData
      const kafka = yield* KafkaMarketProjection
      const postgres = yield* PgClient.PgClient
      const observed = new Map<string, StreamingVerifiedMarketSnapshot>()
      const loadSnapshot = (query: IntradaySnapshotQuery) =>
        Effect.gen(function* () {
          const cut = yield* kafka.read.pipe(
            Effect.mapError((cause) => marketDataOperationError('load', 'Kafka market projection is not ready', cause)),
          )
          const snapshot = yield* Effect.fromResult(constructStreamingSnapshot(cut, query)).pipe(
            Effect.mapError((cause) =>
              marketDataOperationError('load', 'Streaming snapshot verification failed', cause),
            ),
          )
          observed.set(snapshot.manifest.snapshotId, snapshot)
          if (observed.size > 32) {
            const oldest = observed.keys().next()
            if (oldest.done !== true) observed.delete(oldest.value)
          }
          return snapshot
        })
      const verifyReference = (snapshot: StreamingMarketSnapshot) =>
        Effect.gen(function* () {
          const replay = persistIntradayRecordRows(snapshot).pipe(
            Result.flatMap((rows) => reproduceStreamingSnapshot(snapshot.manifest, rows)),
          )
          if (Result.isFailure(replay))
            return yield* operationalError({
              component: 'market-data',
              operation: 'load',
              message: 'Streaming snapshot evidence does not reproduce its recorded cut',
              cause: replay.failure,
            })
          const cached = observed.get(snapshot.manifest.snapshotId)
          if (cached !== undefined && cached.manifest.contentHash === snapshot.manifest.contentHash)
            return streamingSnapshotReference(cached)
          return yield* recoverStreamingSnapshotReference(snapshot.manifest).pipe(
            Effect.provideService(PgClient.PgClient, postgres),
          )
        })
      return {
        ...archive,
        check: shadowOnly
          ? archive.check
          : kafka.read.pipe(
              Effect.asVoid,
              Effect.mapError((cause) => marketDataOperationError('check', 'Kafka projection is rebuilding', cause)),
            ),
        streaming: { shadowOnly, loadSnapshot, verifyReference },
      } satisfies IntradayMarketDataService
    }),
  )

export const StreamingIntradayMarketDataLive = streamingIntradayMarketDataLive()
