import { parentPort, workerData } from 'node:worker_threads'
import { NodeRuntime, NodeServices } from '@effect/platform-node'
import { PgClient } from '@effect/sql-pg'
import { Cause, Context, Effect, Exit, FiberMap, FiberSet, Layer, Logger, Redacted, Scope } from 'effect'

import { NativeArrivalArchiveLive } from '../../db/native-arrival-archive'
import { makeNativeArrivalStore } from '../../db/native-arrival-postgres'
import { makeConfiguredTelemetryRuntimeLayer } from '../../telemetry'
import { KafkaMarketFailure, makeKafkaMarketProjection } from './kafka'
import { IntradaySnapshotFailure, IntradaySnapshotPurpose } from '../intraday/model'
import { compactStreamingProjection } from './query-cut'
import { snapshotCutMeasurement, snapshotFailureMeasurement } from './telemetry'
import { nativeArrivalCaptureId } from './native-arrival'
import { makeNativeArrivalJournal } from './native-arrival-journal'
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
    const scope = yield* Scope.make()
    yield* Effect.addFinalizer((exit) => Scope.close(scope, exit))
    const archive = NativeArrivalArchiveLive({
      ...options.archive,
      postgres: { ...options.archive.postgres, url: Redacted.make(options.archive.postgres.url) },
    })
    const parent = yield* Effect.context<never>()
    const outerScope = yield* Effect.scope
    const context = yield* Layer.buildWithScope(
      archive.pipe(
        Layer.provideMerge(NodeServices.layer),
        Layer.provideMerge(makeConfiguredTelemetryRuntimeLayer('bayn-market-projection')),
      ),
      scope,
    )
    const services = Context.add(Context.merge(parent, context), Scope.Scope, scope)
    const store = makeNativeArrivalStore(Context.get(context, PgClient.PgClient))
    const projection = yield* makeKafkaMarketProjection(
      { ...options.kafka, password: Redacted.make(options.kafka.password) },
      options.sources,
      undefined,
      undefined,
      (bootstrap, sources) =>
        Effect.gen(function* () {
          const captureId = yield* Effect.fromResult(nativeArrivalCaptureId(options.build, bootstrap, sources))
          return yield* makeNativeArrivalJournal(
            {
              schemaVersion: 'bayn.native-arrival-epoch.v1',
              captureId,
              build: options.build,
              bootstrap,
              sources,
            },
            store,
          )
        }),
    ).pipe(Effect.provideContext(services))
    return yield* serveProjectionWorker(projection, Scope.close(scope, Exit.void), port).pipe(
      Effect.provideContext(Context.add(services, Scope.Scope, outerScope)),
    )
  })

if (import.meta.main && parentPort !== null) {
  // The parent passes only the existing Kafka/archive credentials and public source identity.
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
