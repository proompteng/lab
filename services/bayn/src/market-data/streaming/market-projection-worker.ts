import { parentPort, workerData } from 'node:worker_threads'
import { NodeRuntime, NodeServices } from '@effect/platform-node'
import { PgClient } from '@effect/sql-pg'
import {
  Cause,
  Clock,
  Context,
  Deferred,
  Effect,
  Exit,
  Fiber,
  FiberMap,
  FiberSet,
  Layer,
  Logger,
  Queue,
  Redacted,
  Scope,
} from 'effect'

import { PostgresClientLive } from '../../db/postgres-client'
import { makeNativeArrivalStore } from '../../db/native-arrival-postgres'
import { makeMarketReadyStore } from '../../db/market-ready-postgres'
import { initializeErrorTracking } from '../../error-tracking'
import { makeConfiguredTelemetryRuntimeLayer } from '../../telemetry'
import { KafkaMarketFailure, makeKafkaMarketProjection } from './kafka'
import { IntradaySnapshotFailure, IntradaySnapshotPurpose } from '../intraday/model'
import { compactStreamingProjection } from './query-cut'
import { snapshotCutMeasurement, snapshotFailureMeasurement } from './telemetry'
import { nativeArrivalCaptureId } from './native-arrival'
import { makeCaptureHealth } from './capture-health'
import { makeNativeArrivalJournal } from './native-arrival-journal'
import type { NativeArrivalCapture } from './native-arrival-journal'
import type { NativeArrivalCaptureError, NativeArrivalEpoch } from './native-arrival'
import { serveMarketReadyOutbox } from './readiness'
import type { ProjectionWorkerOptions, ProjectionWorkerRequest, ProjectionWorkerResponse } from './worker'

export const serveProjectionWorker = (
  projection: Effect.Success<ReturnType<typeof makeKafkaMarketProjection>>,
  close: Effect.Effect<void>,
  port: NonNullable<typeof parentPort>,
) =>
  Effect.gen(function* () {
    const run = yield* FiberSet.makeRuntime()
    const requests = yield* FiberMap.make<number>()
    const send = (reply: ProjectionWorkerResponse) => Effect.sync(() => port.postMessage(reply))
    yield* send({ _tag: 'Ready', value: yield* projection.status })
    return yield* Effect.callback<void>((_resume) => {
      const onMessage = (request: ProjectionWorkerRequest) => {
        if (request.operation === 'health-ack' || request.operation === 'market-ready-ack') return
        if (request.operation === 'cancel') {
          run(FiberMap.remove(requests, request.id))
          return
        }
        run(
          FiberMap.run(
            requests,
            request.id,
            Effect.gen(function* () {
              const result = yield* Effect.exit(
                Effect.gen(function* () {
                  switch (request.operation) {
                    case 'check':
                      yield* projection.check
                      return {
                        _tag: 'Checked',
                        id: request.id,
                        status: yield* projection.status,
                      } satisfies ProjectionWorkerResponse
                    case 'read': {
                      const cut = yield* request.query.purpose === IntradaySnapshotPurpose.Liquidation
                        ? projection.readForLiquidation
                        : projection.read
                      const bounded = yield* Effect.fromResult(compactStreamingProjection(cut, request.query)).pipe(
                        Effect.tapError((cause) =>
                          Effect.logWarning('Streaming market snapshot rejected').pipe(
                            Effect.annotateLogs(snapshotFailureMeasurement(cause, request.query, cut.projection)),
                            Effect.annotateLogs({ inputCut: snapshotCutMeasurement(cut, request.query) }),
                          ),
                        ),
                      )
                      return {
                        _tag: 'Read',
                        id: request.id,
                        value: { ...cut, projection: bounded },
                        status: yield* projection.status,
                      } satisfies ProjectionWorkerResponse
                    }
                    case 'status':
                      return {
                        _tag: 'Status',
                        id: request.id,
                        value: yield* projection.status,
                      } satisfies ProjectionWorkerResponse
                    case 'stop':
                      yield* close
                      return { _tag: 'Stopped', id: request.id } satisfies ProjectionWorkerResponse
                  }
                }),
              )
              if (Exit.isSuccess(result)) return yield* send(result.value)
              const failure = Cause.squash(result.cause)
              if (failure instanceof IntradaySnapshotFailure)
                return yield* send({
                  _tag: 'SnapshotFailure',
                  id: request.id,
                  reason: failure.reason,
                  message: failure.message,
                  ...(failure.facts === undefined ? {} : { facts: failure.facts }),
                  ...(failure.ingestionDelayDirection === undefined
                    ? {}
                    : { ingestionDelayDirection: failure.ingestionDelayDirection }),
                  cause: Cause.pretty(result.cause),
                })
              return yield* send({
                _tag: 'Failure',
                id: request.id,
                operation:
                  failure instanceof KafkaMarketFailure
                    ? failure.operation
                    : request.operation === 'stop'
                      ? 'close'
                      : 'read',
                message: failure instanceof Error ? failure.message : 'Kafka projection operation failed',
                cause: Cause.pretty(result.cause),
              })
            }),
          ),
        )
      }
      port.on('message', onMessage)
      return Effect.sync(() => port.off('message', onMessage))
    })
  })

export const projectionWorkerProgram = (options: ProjectionWorkerOptions, port: NonNullable<typeof parentPort>) =>
  Effect.gen(function* () {
    initializeErrorTracking('bayn-market-projection')
    const scope = yield* Scope.make()
    yield* Effect.addFinalizer((exit) => Scope.close(scope, exit))
    const health = makeCaptureHealth()
    const wake = yield* Queue.dropping<void>(1)
    let capture: NativeArrivalCapture | undefined
    let epoch: NativeArrivalEpoch | undefined
    let pendingBootstrap: Effect.Effect<void, NativeArrivalCaptureError> | undefined
    let pending: { readonly eventId: string; readonly acknowledged: Deferred.Deferred<void> } | undefined
    let awaitingHealthAck = false
    const acknowledge = (request: ProjectionWorkerRequest) => {
      if (request.operation === 'health-ack') awaitingHealthAck = false
      if (request.operation === 'market-ready-ack' && pending?.eventId === request.eventId)
        Deferred.doneUnsafe(pending.acknowledged, Exit.void)
    }
    port.on('message', acknowledge)
    const reportHealth = Effect.gen(function* () {
      const monotonic = Number(yield* Clock.monotonicTimeNanos) / 1_000_000_000
      const now = (yield* Clock.currentTimeMillis) / 1000
      port.postMessage({
        _tag: 'CaptureHealth',
        health: health.sample(monotonic, now),
      } satisfies ProjectionWorkerResponse)
      awaitingHealthAck = true
    }).pipe(Effect.catchDefect(() => Effect.logWarning('Native capture health delivery failed')))
    const sampler = yield* Effect.forever(
      Effect.suspend(() => (awaitingHealthAck ? Effect.void : reportHealth)).pipe(
        Effect.andThen(Effect.sleep('15 seconds')),
      ),
    ).pipe(Effect.forkIn(scope))
    // One final bounded frame follows journal finalization, before the stop acknowledgement.
    yield* Scope.addFinalizer(
      scope,
      Fiber.interrupt(sampler).pipe(
        Effect.andThen(reportHealth),
        Effect.ensuring(Effect.sync(() => port.off('message', acknowledge))),
      ),
    )
    const database = PostgresClientLive(
      {
        ...options.database,
        postgres: { ...options.database.postgres, url: Redacted.make(options.database.postgres.url) },
      },
      { maxConnections: 1, applicationName: 'bayn-native-arrival' },
    )
    const parent = yield* Effect.context<never>()
    const outerScope = yield* Effect.scope
    const context = yield* Layer.buildWithScope(
      database.pipe(
        Layer.provideMerge(NodeServices.layer),
        Layer.provideMerge(makeConfiguredTelemetryRuntimeLayer('bayn-market-projection')),
      ),
      scope,
    )
    const services = Context.add(Context.merge(parent, context), Scope.Scope, scope)
    const sql = Context.get(context, PgClient.PgClient)
    const outbox = makeMarketReadyStore(sql, options.controllerKey, options.build.sourceRevision)
    const projection = yield* makeKafkaMarketProjection(
      { ...options.kafka, password: Redacted.make(options.kafka.password) },
      options.sources,
      undefined,
      undefined,
      health.wrap((bootstrap, sources) =>
        Effect.gen(function* () {
          const captureId = yield* Effect.fromResult(nativeArrivalCaptureId(options.build, bootstrap, sources))
          epoch = {
            schemaVersion: 'bayn.native-arrival-epoch.v1',
            captureId,
            build: options.build,
            bootstrap,
            sources,
          }
          const currentEpoch = epoch
          const store = makeNativeArrivalStore(sql, (chunks) => outbox.retain(currentEpoch, chunks))
          capture = yield* makeNativeArrivalJournal(currentEpoch, {
            ...store,
            append: (chunks) => store.append(chunks).pipe(Effect.tap(() => Queue.offer(wake, undefined))),
          })
          return capture
        }),
      ),
      {
        ready: (bootstrap) =>
          Effect.sync(() => {
            if (epoch !== undefined && epoch.bootstrap.epoch === bootstrap.epoch)
              pendingBootstrap = (capture?.flush ?? Effect.void).pipe(Effect.andThen(outbox.bootstrap(epoch)))
            Queue.offerUnsafe(wake, undefined)
          }),
      },
    ).pipe(Effect.provideContext(services))
    const publish = serveMarketReadyOutbox(
      {
        ...outbox,
        next: Effect.gen(function* () {
          const bootstrap = pendingBootstrap
          if (bootstrap !== undefined) {
            yield* bootstrap
            if (pendingBootstrap === bootstrap) pendingBootstrap = undefined
          }
          return yield* outbox.next
        }),
      },
      wake,
      (event) =>
        Effect.gen(function* () {
          const acknowledged = yield* Deferred.make<void>()
          pending = { eventId: event.eventId, acknowledged }
          yield* Effect.sync(() => port.postMessage({ _tag: 'MarketReady', event } satisfies ProjectionWorkerResponse))
          yield* Deferred.await(acknowledged)
          pending = undefined
        }),
    )
    return yield* Effect.raceFirst(
      serveProjectionWorker(projection, Scope.close(scope, Exit.void), port),
      publish,
    ).pipe(Effect.provideContext(Context.add(services, Scope.Scope, outerScope)))
  })

if (import.meta.main && parentPort !== null) {
  // The parent passes only the existing Kafka/PostgreSQL credentials and public source identity.
  const options = workerData as ProjectionWorkerOptions
  NodeRuntime.runMain(
    Layer.effectDiscard(
      projectionWorkerProgram(options, parentPort).pipe(
        Effect.scoped,
        Effect.annotateLogs({ service: 'bayn-market-projection' }),
      ),
    ).pipe(Layer.provide(Logger.layer([Logger.consoleJson])), Layer.launch),
  )
}
