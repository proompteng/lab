import { parentPort, workerData } from 'node:worker_threads'
import { randomUUID } from 'node:crypto'
import { NodeRuntime } from '@effect/platform-node'
import { Cause, Deferred, Effect, Exit, FiberMap, FiberSet, Layer, Logger, Redacted, Scope } from 'effect'

import { initializeErrorTracking } from '../../error-tracking'
import { sampleRuntimeMemory } from '../../telemetry-memory'
import { KafkaMarketFailure, makeKafkaMarketProjection } from './kafka'
import { IntradaySnapshotFailure, IntradaySnapshotPurpose } from '../intraday/model'
import { compactStreamingProjection } from './query-cut'
import { snapshotCutMeasurement, snapshotFailureMeasurement } from './telemetry'
import { makeMarketHints } from './readiness'
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
        if (request.operation === 'memory-ack' || request.operation === 'market-changed-ack') return
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
    const hints = yield* makeMarketHints(options.sourceRevision, yield* Effect.sync(randomUUID))
    let pending: { readonly eventId: string; readonly acknowledged: Deferred.Deferred<void> } | undefined
    let awaitingMemoryAck = false
    const acknowledge = (request: ProjectionWorkerRequest) => {
      if (request.operation === 'memory-ack') awaitingMemoryAck = false
      if (request.operation === 'market-changed-ack' && pending?.eventId === request.eventId)
        Deferred.doneUnsafe(pending.acknowledged, Exit.void)
    }
    port.on('message', acknowledge)
    yield* Scope.addFinalizer(
      scope,
      Effect.sync(() => port.off('message', acknowledge)),
    )
    const reportMemory = Effect.gen(function* () {
      port.postMessage({
        _tag: 'Memory',
        memory: yield* sampleRuntimeMemory,
      } satisfies ProjectionWorkerResponse)
      awaitingMemoryAck = true
    }).pipe(Effect.catchDefect(() => Effect.logWarning('Projection memory sample delivery failed')))
    yield* Effect.forever(
      Effect.suspend(() => (awaitingMemoryAck ? Effect.void : reportMemory)).pipe(
        Effect.andThen(Effect.sleep('15 seconds')),
      ),
    ).pipe(Effect.forkIn(scope))
    const projection = yield* makeKafkaMarketProjection(
      { ...options.kafka, password: Redacted.make(options.kafka.password) },
      options.sources,
      undefined,
      undefined,
      undefined,
      hints,
    ).pipe(Effect.provideService(Scope.Scope, scope))
    const publish = hints.serve((event) =>
      Effect.gen(function* () {
        const acknowledged = yield* Deferred.make<void>()
        pending = { eventId: event.eventId, acknowledged }
        yield* Effect.sync(() => port.postMessage({ _tag: 'MarketChanged', event } satisfies ProjectionWorkerResponse))
        yield* Effect.logDebug('Market change hint offered to parent', {
          eventId: event.eventId,
          producerId: event.producerId,
          sequence: event.sequence,
          reason: event.reason,
        })
        yield* Deferred.await(acknowledged)
        pending = undefined
      }),
    )
    return yield* Effect.raceFirst(serveProjectionWorker(projection, Scope.close(scope, Exit.void), port), publish)
  })

if (import.meta.main && parentPort !== null) {
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
