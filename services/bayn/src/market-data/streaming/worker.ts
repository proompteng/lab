import type { LoadedRuntimeConfig } from '../../config/model'
import { Worker } from 'node:worker_threads'
import { Deferred, Effect, Exit, Match, Queue, Redacted, Result, Schema } from 'effect'
import { MarketReadySchema, type MarketReadyWakeup } from '../../execution/events'
import { strictParseOptions } from '../../schemas'
import { marketReadyRecoverySchedule } from './readiness'

import { observeCaptureWorker, type CaptureHealth } from './capture-health'
import type { NativeArrivalEpoch } from './native-arrival'
import type { MarketSources } from './raw-events'
import {
  KafkaMarketFailure,
  type KafkaMarketConfig,
  type KafkaProjectionRead,
  type KafkaMarketProjection,
} from './kafka'
import { IntradaySnapshotFailure, type IntradaySnapshotQuery } from '../intraday/model'

export type ProjectionStatus = Effect.Success<KafkaMarketProjection['Service']['status']>

export interface ProjectionWorkerOptions {
  readonly controllerKey: string
  readonly kafka: Omit<KafkaMarketConfig, 'password'> & { readonly password: string }
  readonly database: {
    readonly postgres: { readonly url: string; readonly tls: boolean; readonly caPath: string }
    readonly operationTimeoutMs: number
  }
  readonly sources: MarketSources
  readonly build: NativeArrivalEpoch['build']
}

type ProjectionWorkerOperation =
  | { readonly operation: 'check' | 'status' | 'stop' }
  | { readonly operation: 'cancel' }
  | { readonly operation: 'read'; readonly query: IntradaySnapshotQuery }
export type ProjectionWorkerRequest =
  | (ProjectionWorkerOperation & { readonly id: number })
  | { readonly operation: 'health-ack' }
  | { readonly operation: 'market-ready-ack'; readonly eventId: string }

export type ProjectionWorkerResponse =
  | { readonly _tag: 'MarketReady'; readonly event: MarketReadyWakeup }
  | { readonly _tag: 'CaptureHealth'; readonly health: CaptureHealth }
  | { readonly _tag: 'Ready'; readonly value: ProjectionStatus }
  | {
      readonly _tag: 'Read'
      readonly id: number
      readonly value: KafkaProjectionRead
      readonly status: ProjectionStatus
    }
  | { readonly _tag: 'Checked'; readonly id: number; readonly status: ProjectionStatus }
  | { readonly _tag: 'Status'; readonly id: number; readonly value: ProjectionStatus }
  | { readonly _tag: 'Stopped'; readonly id: number }
  | {
      readonly _tag: 'SnapshotFailure'
      readonly id: number
      readonly reason: IntradaySnapshotFailure['reason']
      readonly message: string
      readonly ingestionDelayDirection?: IntradaySnapshotFailure['ingestionDelayDirection']
      readonly facts?: Readonly<Record<string, unknown>>
      readonly cause: string
    }
  | {
      readonly _tag: 'Failure'
      readonly id: number
      readonly operation: KafkaMarketFailure['operation']
      readonly message: string
      readonly cause: string
    }

type Reply = Exclude<ProjectionWorkerResponse, { readonly _tag: 'Ready' | 'CaptureHealth' | 'MarketReady' }>

export const projectionWorkerOptions = (
  kafka: KafkaMarketConfig,
  database: Pick<LoadedRuntimeConfig, 'postgres' | 'operationTimeoutMs'>,
  sources: MarketSources,
  build: NativeArrivalEpoch['build'],
  controllerKey: string,
): ProjectionWorkerOptions => ({
  controllerKey,
  kafka: { ...kafka, password: Redacted.value(kafka.password) },
  database: { ...database, postgres: { ...database.postgres, url: Redacted.value(database.postgres.url) } },
  sources,
  build,
})

export const makeThreadedKafkaProjection = (
  options: ProjectionWorkerOptions,
  spawn = () =>
    new Worker(new URL('./market-projection-worker.js', import.meta.url), {
      name: 'bayn-market-projection',
      workerData: options,
    }),
) =>
  Effect.gen(function* () {
    const receiveHealth = yield* observeCaptureWorker
    const ready = yield* Deferred.make<void, KafkaMarketFailure>()
    const marketReady = yield* Queue.dropping<MarketReadyWakeup>(1)
    let publishing = false
    const pending = new Map<number, (reply: Effect.Effect<Reply, KafkaMarketFailure>) => void>()
    let sequence = 0
    let stopped = false
    let lastStatus: ProjectionStatus | undefined
    let terminal: KafkaMarketFailure | undefined
    const unavailable = (message: string, cause?: unknown) =>
      new KafkaMarketFailure({ operation: 'read', message, cause })
    const fail = (failure: KafkaMarketFailure) => {
      terminal ??= failure
      Deferred.doneUnsafe(ready, Exit.fail(terminal))
      for (const resume of pending.values()) resume(Effect.fail(terminal))
      pending.clear()
    }
    const worker = yield* Effect.try({
      try: spawn,
      catch: (cause) => unavailable('Kafka projection thread could not start', cause),
    })
    const onMessage = (reply: ProjectionWorkerResponse) => {
      if (reply._tag === 'MarketReady') {
        const event = Schema.decodeUnknownResult(MarketReadySchema, strictParseOptions)(reply.event)
        if (Result.isFailure(event)) {
          fail(unavailable('Kafka projection returned an invalid market readiness event'))
          return
        }
        Queue.offerUnsafe(marketReady, event.success)
        return
      }
      if (reply._tag === 'CaptureHealth') {
        receiveHealth(reply.health)
        // Health acknowledgements never enter the request/deadline machinery.
        try {
          worker.postMessage({ operation: 'health-ack' } satisfies ProjectionWorkerRequest)
        } catch {}
        return
      }
      if (reply._tag === 'Ready') {
        lastStatus = reply.value
        Deferred.doneUnsafe(ready, Exit.void)
        return
      }
      const resume = pending.get(reply.id)
      pending.delete(reply.id)
      Match.value(reply).pipe(
        Match.tag('Stopped', () => {
          stopped = true
        }),
        Match.tag('Status', ({ value }) => {
          lastStatus = value
        }),
        Match.tag('Read', 'Checked', ({ status }) => {
          lastStatus = status
        }),
        Match.orElse(() => {}),
      )
      if (resume === undefined) return
      resume(
        reply._tag === 'Failure'
          ? Effect.fail(
              new KafkaMarketFailure({
                operation: reply.operation,
                message: reply.message,
                cause: reply.cause,
              }),
            )
          : Effect.succeed(reply),
      )
    }
    const onError = (cause: Error) => fail(unavailable('Kafka projection thread failed', cause))
    const onExit = (code: number) => {
      if (!stopped) fail(unavailable('Kafka projection thread exited before shutdown was acknowledged', { code }))
    }
    worker.on('message', onMessage)
    worker.on('error', onError)
    worker.on('exit', onExit)

    const request = (message: Exclude<ProjectionWorkerOperation, { readonly operation: 'cancel' }>) =>
      Effect.callback<Reply, KafkaMarketFailure>((resume) => {
        if (terminal !== undefined || stopped) {
          resume(Effect.fail(terminal ?? unavailable('Kafka projection thread is stopped')))
          return
        }
        const id = ++sequence
        pending.set(id, resume)
        try {
          worker.postMessage({ ...message, id } satisfies ProjectionWorkerRequest)
        } catch (cause) {
          pending.delete(id)
          resume(Effect.fail(unavailable('Kafka projection request could not be sent', cause)))
        }
        return Effect.sync(() => {
          if (!pending.delete(id)) return
          try {
            worker.postMessage({ id, operation: 'cancel' } satisfies ProjectionWorkerRequest)
          } catch (cause) {
            fail(unavailable('Kafka projection request could not be cancelled', cause))
          }
        })
      }).pipe(
        Effect.timeoutOrElse({
          duration: options.kafka.operationTimeoutMs * (message.operation === 'stop' ? 5 : 1),
          orElse: () => Effect.fail(unavailable(`Kafka projection ${message.operation} request timed out`)),
        }),
      )

    yield* Effect.addFinalizer(() =>
      request({ operation: 'stop' }).pipe(
        Effect.catchCause((cause) => Effect.logError('Kafka projection thread did not acknowledge shutdown', cause)),
        Effect.ensuring(
          Effect.promise(() => worker.terminate()).pipe(
            Effect.andThen(
              Effect.sync(() => {
                fail(unavailable('Kafka projection owner stopped'))
                worker.off('message', onMessage)
                worker.off('error', onError)
                worker.off('exit', onExit)
              }),
            ),
          ),
        ),
      ),
    )
    yield* Deferred.await(ready).pipe(
      Effect.timeoutOrElse({
        duration: options.kafka.operationTimeoutMs * 5,
        orElse: () => Effect.fail(unavailable('Kafka projection thread startup timed out')),
      }),
    )
    const read = (query: IntradaySnapshotQuery) =>
      request({ operation: 'read', query }).pipe(
        Effect.flatMap(
          (reply): Effect.Effect<KafkaProjectionRead, KafkaMarketFailure | IntradaySnapshotFailure> =>
            reply._tag === 'SnapshotFailure'
              ? Effect.fail(
                  new IntradaySnapshotFailure({
                    reason: reply.reason,
                    message: reply.message,
                    cause: reply.cause,
                    ...(reply.facts === undefined ? {} : { facts: reply.facts }),
                    ...(reply.ingestionDelayDirection === undefined
                      ? {}
                      : { ingestionDelayDirection: reply.ingestionDelayDirection }),
                  }),
                )
              : reply._tag === 'Read'
                ? Effect.succeed(reply.value)
                : Effect.fail(unavailable('Kafka projection returned the wrong response')),
        ),
      )
    return {
      startWakeups: (publish: (event: MarketReadyWakeup) => Effect.Effect<void, KafkaMarketFailure>) =>
        Effect.gen(function* () {
          if (publishing) return yield* unavailable('Kafka market readiness publisher is already started')
          publishing = true
          yield* Effect.forever(
            Queue.take(marketReady).pipe(
              Effect.flatMap((event) =>
                publish(event).pipe(
                  Effect.timeoutOrElse({
                    duration: options.kafka.operationTimeoutMs,
                    orElse: () => Effect.fail(unavailable('Durable market readiness scheduling timed out')),
                  }),
                  Effect.andThen(
                    Effect.try({
                      try: () =>
                        worker.postMessage({
                          operation: 'market-ready-ack',
                          eventId: event.eventId,
                        } satisfies ProjectionWorkerRequest),
                      catch: (cause) => unavailable('Market readiness delivery could not be acknowledged', cause),
                    }),
                  ),
                  Effect.retry({
                    schedule: marketReadyRecoverySchedule,
                    while: () => terminal === undefined && !stopped,
                  }),
                ),
              ),
            ),
          ).pipe(
            Effect.tapError((failure) => Effect.sync(() => fail(failure))),
            Effect.forkScoped,
          )
        }),
      check: request({ operation: 'check' }).pipe(
        Effect.flatMap((reply) =>
          reply._tag === 'Checked'
            ? Effect.void
            : Effect.fail(unavailable('Kafka projection returned the wrong readiness response')),
        ),
      ),
      read,
      status: request({ operation: 'status' }).pipe(
        Effect.flatMap((reply) =>
          reply._tag === 'Status'
            ? Effect.succeed(reply.value)
            : Effect.fail(unavailable('Kafka projection returned the wrong status response')),
        ),
        Effect.catch(() =>
          lastStatus === undefined
            ? Effect.die('Kafka projection thread has no acknowledged source status')
            : Effect.succeed({
                ...lastStatus,
                ready: false,
                failure: terminal?.message ?? 'Kafka projection thread unavailable',
              }),
        ),
      ),
    }
  })
