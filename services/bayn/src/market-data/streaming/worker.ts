import type { LoadedRuntimeConfig } from '../../config/model'
import { Worker } from 'node:worker_threads'
import { Deferred, Effect, Exit, Match, Queue, Redacted, Result, Schema } from 'effect'
import { MarketChangedSchema, type MarketChangedWakeup } from '../../execution/events'
import { strictParseOptions } from '../../schemas'
import { marketHintRecoverySchedule } from './readiness'

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
  | { readonly operation: 'market-changed-ack'; readonly eventId: string }

export type ProjectionWorkerResponse =
  | { readonly _tag: 'MarketChanged'; readonly event: MarketChangedWakeup }
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

type Reply = Exclude<ProjectionWorkerResponse, { readonly _tag: 'Ready' | 'CaptureHealth' | 'MarketChanged' }>

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
    const changed = yield* Queue.sliding<{ readonly event: MarketChangedWakeup; readonly worker: Worker }>(1)
    const restart = yield* Queue.dropping<void>(1)
    const pending = new Map<number, (reply: Effect.Effect<Reply, KafkaMarketFailure>) => void>()
    let publishing = false
    let sequence = 0
    let stopped = false
    let stopping = false
    let established = false
    let lastStatus: ProjectionStatus | undefined
    let terminal: KafkaMarketFailure | undefined
    type Connection = {
      readonly worker: Worker
      readonly ready: Deferred.Deferred<void, KafkaMarketFailure>
      readonly detach: () => void
      failed: boolean
    }
    let active: Connection | undefined
    const unavailable = (message: string, cause?: unknown) =>
      new KafkaMarketFailure({ operation: 'read', message, cause })
    const fail = (connection: Connection, failure: KafkaMarketFailure) => {
      if (active !== connection || connection.failed) return
      connection.failed = true
      terminal = failure
      Deferred.doneUnsafe(connection.ready, Exit.fail(failure))
      for (const resume of pending.values()) resume(Effect.fail(failure))
      pending.clear()
      if (established && !stopping) Queue.offerUnsafe(restart, undefined)
    }
    const open = Effect.gen(function* () {
      const ready = yield* Deferred.make<void, KafkaMarketFailure>()
      const worker = yield* Effect.try({
        try: spawn,
        catch: (cause) => unavailable('Kafka projection thread could not start', cause),
      })
      const connection: Connection = {
        worker,
        ready,
        failed: false,
        detach: () => {
          worker.off('message', onMessage)
          worker.off('error', onError)
          worker.off('exit', onExit)
        },
      }
      const onMessage = (reply: ProjectionWorkerResponse) => {
        if (active !== connection || connection.failed) return
        if (reply._tag === 'MarketChanged') {
          const event = Schema.decodeUnknownResult(MarketChangedSchema, strictParseOptions)(reply.event)
          if (Result.isFailure(event)) {
            fail(connection, unavailable('Kafka projection returned an invalid market change hint'))
            return
          }
          Queue.offerUnsafe(changed, { event: event.success, worker })
          return
        }
        if (reply._tag === 'CaptureHealth') {
          receiveHealth(reply.health)
          try {
            worker.postMessage({ operation: 'health-ack' } satisfies ProjectionWorkerRequest)
          } catch {}
          return
        }
        if (reply._tag === 'Ready') {
          lastStatus = reply.value
          terminal = undefined
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
                new KafkaMarketFailure({ operation: reply.operation, message: reply.message, cause: reply.cause }),
              )
            : Effect.succeed(reply),
        )
      }
      const onError = (cause: Error) => fail(connection, unavailable('Kafka projection thread failed', cause))
      const onExit = (code: number) => {
        if (!stopped)
          fail(connection, unavailable('Kafka projection thread exited before shutdown was acknowledged', { code }))
      }
      active = connection
      worker.on('message', onMessage)
      worker.on('error', onError)
      worker.on('exit', onExit)
      return connection
    })
    const close = (connection: Connection) =>
      Effect.gen(function* () {
        connection.detach()
        yield* Effect.promise(() => connection.worker.terminate())
      })
    const awaitReady = (connection: Connection) =>
      Deferred.await(connection.ready).pipe(
        Effect.timeoutOrElse({
          duration: options.kafka.operationTimeoutMs * 5,
          orElse: () => Effect.fail(unavailable('Kafka projection thread startup timed out')),
        }),
        Effect.tapError((failure) => Effect.sync(() => fail(connection, failure))),
      )
    const request = (message: Exclude<ProjectionWorkerOperation, { readonly operation: 'cancel' }>) =>
      Effect.callback<Reply, KafkaMarketFailure>((resume) => {
        const connection = active
        if (connection === undefined || connection.failed || stopped) {
          resume(Effect.fail(terminal ?? unavailable('Kafka projection thread is stopped')))
          return
        }
        const id = ++sequence
        pending.set(id, resume)
        try {
          connection.worker.postMessage({ ...message, id } satisfies ProjectionWorkerRequest)
        } catch (cause) {
          pending.delete(id)
          resume(Effect.fail(unavailable('Kafka projection request could not be sent', cause)))
        }
        return Effect.sync(() => {
          if (!pending.delete(id)) return
          try {
            connection.worker.postMessage({ id, operation: 'cancel' } satisfies ProjectionWorkerRequest)
          } catch (cause) {
            fail(connection, unavailable('Kafka projection request could not be cancelled', cause))
          }
        })
      }).pipe(
        Effect.timeoutOrElse({
          duration: options.kafka.operationTimeoutMs * (message.operation === 'stop' ? 5 : 1),
          orElse: () => Effect.fail(unavailable(`Kafka projection ${message.operation} request timed out`)),
        }),
      )
    yield* Effect.addFinalizer(() =>
      Effect.gen(function* () {
        stopping = true
        yield* request({ operation: 'stop' }).pipe(
          Effect.catchCause((cause) => Effect.logError('Kafka projection thread did not acknowledge shutdown', cause)),
          Effect.ensuring(Effect.suspend(() => (active === undefined ? Effect.void : close(active)))),
        )
        stopped = true
      }),
    )
    yield* awaitReady(yield* open)
    established = true
    yield* Effect.forever(
      Queue.take(restart).pipe(
        Effect.andThen(
          Effect.suspend(() => {
            if (active?.failed !== true) return Effect.void
            return Effect.gen(function* () {
              if (active !== undefined) yield* close(active)
              yield* awaitReady(yield* open)
              yield* Effect.logWarning('Kafka projection thread recovered with a new source epoch')
            }).pipe(
              Effect.tapError((failure) =>
                Effect.logWarning('Kafka projection thread restart failed', {
                  operation: failure.operation,
                  message: failure.message,
                }),
              ),
              Effect.retry({ schedule: marketHintRecoverySchedule }),
            )
          }),
        ),
      ),
    ).pipe(Effect.forkScoped)
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
      startWakeups: (publish: (event: MarketChangedWakeup) => Effect.Effect<void, KafkaMarketFailure>) =>
        Effect.gen(function* () {
          if (publishing) return yield* unavailable('Kafka market hint publisher is already started')
          publishing = true
          yield* Effect.forever(
            Queue.take(changed).pipe(
              Effect.flatMap(({ event, worker }) =>
                publish(event).pipe(
                  Effect.timeoutOrElse({
                    duration: options.kafka.operationTimeoutMs,
                    orElse: () => Effect.fail(unavailable('Durable market hint acceptance timed out')),
                  }),
                  Effect.retry({
                    schedule: marketHintRecoverySchedule,
                    while: (failure) => failure.retryable !== false,
                  }),
                  Effect.andThen(
                    Effect.try({
                      try: () => {
                        // A dead sender cannot receive an ACK; Restate has already accepted its immutable hint.
                        if (worker.threadId !== -1)
                          worker.postMessage({
                            operation: 'market-changed-ack',
                            eventId: event.eventId,
                          } satisfies ProjectionWorkerRequest)
                      },
                      catch: (cause) => unavailable('Accepted market hint could not acknowledge its sender', cause),
                    }).pipe(
                      Effect.catch((failure) =>
                        Effect.logWarning('Accepted market hint sender acknowledgement failed', {
                          eventId: event.eventId,
                          producerId: event.producerId,
                          sequence: event.sequence,
                        }).pipe(
                          Effect.andThen(
                            Effect.sync(() => {
                              if (active?.worker === worker) fail(active, failure)
                            }),
                          ),
                        ),
                      ),
                    ),
                  ),
                  Effect.andThen(
                    Effect.logDebug('Market change hint durably accepted', {
                      eventId: event.eventId,
                      producerId: event.producerId,
                      sequence: event.sequence,
                      reason: event.reason,
                    }),
                  ),
                ),
              ),
            ),
          ).pipe(
            Effect.tapError((failure) =>
              Effect.logError('Market change hint delivery permanently rejected', {
                operation: failure.operation,
                message: failure.message,
              }),
            ),
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
