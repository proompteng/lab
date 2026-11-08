import { Worker } from 'node:worker_threads'
import { Deferred, Effect, Exit, Redacted, type Result } from 'effect'

import type { nativeArrivalArchiveConfig } from '../../db/native-arrival-archive'
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
  readonly kafka: Omit<KafkaMarketConfig, 'password'> & { readonly password: string }
  readonly archive: {
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
export type ProjectionWorkerRequest = ProjectionWorkerOperation & { readonly id: number }

export type ProjectionWorkerResponse =
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

type Reply = Exclude<ProjectionWorkerResponse, { readonly _tag: 'Ready' }>

export const projectionWorkerOptions = (
  kafka: KafkaMarketConfig,
  archive: Result.Result.Success<ReturnType<typeof nativeArrivalArchiveConfig>>,
  sources: MarketSources,
  build: NativeArrivalEpoch['build'],
): ProjectionWorkerOptions => ({
  kafka: { ...kafka, password: Redacted.value(kafka.password) },
  archive: { ...archive, postgres: { ...archive.postgres, url: Redacted.value(archive.postgres.url) } },
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
    const ready = yield* Deferred.make<void, KafkaMarketFailure>()
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
      if (reply._tag === 'Ready') {
        lastStatus = reply.value
        Deferred.doneUnsafe(ready, Exit.void)
        return
      }
      const resume = pending.get(reply.id)
      pending.delete(reply.id)
      if (reply._tag === 'Stopped') stopped = true
      if (reply._tag === 'Status') lastStatus = reply.value
      if (reply._tag === 'Read' || reply._tag === 'Checked') lastStatus = reply.status
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
