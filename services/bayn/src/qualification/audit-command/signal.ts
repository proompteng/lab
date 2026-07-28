import { ClickhouseClient } from '@effect/sql-clickhouse'
import { Effect, Layer, Redacted } from 'effect'
import * as Reactivity from 'effect/unstable/reactivity/Reactivity'

import { MarketData, MarketDataLive, type MarketDataSnapshot } from '../../market-data'
import type { InputManifest, Protocol } from '../../types'
import {
  qualificationAuditCommandError,
  type AcquireAuditSignalClient,
  type AuditConfig,
  type AuditSignalClient,
  type QualificationAuditCommandError,
} from './model'

const loadSignalWithClient = (
  input: AuditConfig,
  manifest: InputManifest,
  protocol: Protocol,
  sql: ClickhouseClient.ClickhouseClient,
): Effect.Effect<MarketDataSnapshot, QualificationAuditCommandError> => {
  const marketDataConfig = {
    operationTimeoutMs: input.operationTimeoutMs,
    clickhouse: {
      url: input.signalUrl,
      username: input.signalUsername,
      password: input.signalPassword,
      snapshotId: manifest.finalizedSnapshot.snapshotId,
      publicationAsOf: manifest.finalizedSnapshot.asOfSession,
      calendarVersion: manifest.finalizedSnapshot.calendarVersion,
      bounds: manifest.bounds,
    },
  }
  const layer = MarketDataLive(marketDataConfig, protocol).pipe(
    Layer.provide(Layer.succeed(ClickhouseClient.ClickhouseClient, sql)),
  )
  return MarketData.pipe(
    Effect.flatMap((marketData) => marketData.load),
    Effect.provide(layer),
    Effect.mapError((cause) =>
      qualificationAuditCommandError('signal-access', 'Signal snapshot audit read failed', cause),
    ),
  )
}

export const acquireAuditSignalClient: AcquireAuditSignalClient<Reactivity.Reactivity> = (input) =>
  ClickhouseClient.make({
    url: input.signalUrl,
    username: input.signalUsername,
    password: Redacted.value(input.signalPassword),
    database: 'signal',
    application: 'bayn-qualification-audit',
    request_timeout: input.operationTimeoutMs,
  }).pipe(
    Effect.mapError((cause) =>
      qualificationAuditCommandError('signal-access', 'Signal snapshot audit read failed', cause),
    ),
    Effect.map(
      (sql): AuditSignalClient => ({
        load: (manifest, protocol) => loadSignalWithClient(input, manifest, protocol, sql),
      }),
    ),
  )

export const loadAuditSignal = <R = Reactivity.Reactivity>(
  input: AuditConfig,
  manifest: InputManifest,
  protocol: Protocol,
  acquireClient: AcquireAuditSignalClient<R> = acquireAuditSignalClient as AcquireAuditSignalClient<R>,
): Effect.Effect<MarketDataSnapshot, QualificationAuditCommandError, R> =>
  Effect.scoped(acquireClient(input).pipe(Effect.flatMap((client) => client.load(manifest, protocol))))
