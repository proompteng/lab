import { parentPort, workerData } from 'node:worker_threads'
import { NodeRuntime, NodeServices } from '@effect/platform-node'
import { PgClient } from '@effect/sql-pg'
import { Cause, Context, Effect, Exit, FiberMap, FiberSet, Layer, Logger, Redacted, Scope } from 'effect'

import { NativeArrivalArchiveLive } from '../../db/native-arrival-archive'
import { makeNativeArrivalStore } from '../../db/native-arrival-postgres'
import { KafkaMarketFailure, KafkaMarketProjection, makeKafkaMarketProjection } from './kafka'
import { nativeArrivalCaptureId } from './native-arrival'
import { makeNativeArrivalJournal } from './native-arrival-journal'
import type { ProjectionWorkerOptions, ProjectionWorkerRequest, ProjectionWorkerResponse } from './worker'

export const serveProjectionWorker = (
  projection: KafkaMarketProjection['Service'],
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
                    case 'read':
                    case 'liquidation':
                      return {
                        _tag: 'Read',
                        id: request.id,
                        value: yield* request.operation === 'read' ? projection.read : projection.readForLiquidation,
                      } satisfies ProjectionWorkerResponse
                    case 'status':
                      return {
                        _tag: 'Status',
                        id: request.id,
                        value: yield* projection.status,
                      } satisfies ProjectionWorkerResponse
                    case 'stop':
                      yield* close
                      return { _tag: 'Stopped', id: request.id } satisfies ProjectionWorkerResponse
                    case 'cancel':
                      return yield* Effect.die('Cancellation must be handled before starting a projection request')
                  }
                }),
              )
              if (Exit.isSuccess(result)) return yield* send(result.value)
              const failure = Cause.squash(result.cause)
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
    const projectionLayer = Layer.effect(
      KafkaMarketProjection,
      Effect.gen(function* () {
        const store = makeNativeArrivalStore(yield* PgClient.PgClient)
        return yield* makeKafkaMarketProjection(
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
        )
      }),
    ).pipe(Layer.provide(archive), Layer.provide(NodeServices.layer))
    const context = yield* Layer.buildWithScope(projectionLayer, scope)
    return yield* serveProjectionWorker(
      Context.get(context, KafkaMarketProjection),
      Scope.close(scope, Exit.void),
      port,
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
