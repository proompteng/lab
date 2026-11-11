import { mock, spyOn } from 'bun:test'
import { MessageChannel } from 'node:worker_threads'
import * as Sentry from '@sentry/node'
import { PgClient } from '@effect/sql-pg'
import { Effect, Exit, Layer } from 'effect'
import { NativeArrivalCaptureError } from './native-arrival'
import type { NativeArrivalCaptureFactory, NativeArrivalStore } from './native-arrival-journal'
import { nativeArrivalEpochFixture as epoch, nativeArrivalObservationFixture } from './native-arrival.test-support'
import type { ProjectionWorkerOptions } from './worker'

const envelopes: unknown[] = []
const init = Sentry.init
let initializations = 0
spyOn(Sentry, 'init').mockImplementation((options) => {
  initializations++
  return init({
    ...options,
    transport: () => ({
      send: async (envelope) => {
        envelopes.push(envelope)
        return { statusCode: 200 }
      },
      flush: async () => true,
    }),
  })
})
let interruptOnly = false
let finalized = 0
let appends = 0
const endings: string[] = []
const states: string[] = []
const store: NativeArrivalStore = {
  begin: () => Effect.void,
  append: () =>
    Effect.suspend(() =>
      ++appends === 1
        ? Effect.fail(new NativeArrivalCaptureError({ message: 'private-fixture-payload', cause: 'private-token' }))
        : Effect.void,
    ),
  end: (end) =>
    Effect.sync(() => {
      endings.push(end.status)
    }),
}
mock.module('../../db/postgres-client', () => ({
  PostgresClientLive: () => Layer.succeed(PgClient.PgClient, {} as PgClient.PgClient),
}))
mock.module('../../db/native-arrival-postgres', () => ({ makeNativeArrivalStore: () => store }))
const kafka = await import('./kafka')
mock.module('./kafka', () => ({
  ...kafka,
  makeKafkaMarketProjection: (
    _config: unknown,
    _sources: unknown,
    _factory: unknown,
    _clock: unknown,
    captureFactory: NativeArrivalCaptureFactory,
  ) =>
    Effect.gen(function* () {
      yield* Effect.addFinalizer(() => Effect.sync(() => finalized++))
      if (interruptOnly) return yield* Effect.interrupt
      const capture = yield* captureFactory(epoch.bootstrap, epoch.sources)
      yield* capture.observe(nativeArrivalObservationFixture(1, 'x'.repeat(300_000)))
      for (let turn = 0; turn < 100 && capture.status().status !== 'INCOMPLETE'; turn++) yield* Effect.yieldNow
      states.push(capture.status().status)
      return yield* Effect.interrupt
    }),
}))
const { projectionWorkerProgram } = await import('./market-projection-worker')
const options: ProjectionWorkerOptions = {
  controllerKey: 'a'.repeat(64),
  kafka: {
    brokers: ['unused:9092'],
    username: 'fixture',
    password: 'unused',
    groupPrefix: 'fixture',
    operationTimeoutMs: 500,
    bootstrapTimeoutMs: 500,
    timestampPolicy: epoch.bootstrap.timestampPolicy,
  },
  database: { postgres: { url: 'postgres://unused/unused', tls: false, caPath: '' }, operationTimeoutMs: 500 },
  build: epoch.build,
  sources: epoch.sources,
}
const { port1, port2 } = new MessageChannel()
try {
  const run = () => Effect.runPromiseExit(Effect.scoped(projectionWorkerProgram(options, port1)))
  const first = await run()
  await Sentry.flush(1000)
  const afterFailure = envelopes.length
  interruptOnly = true
  const second = await run()
  await Sentry.flush(1000)
  process.stdout.write(
    `WORKER_ERROR_RESULT=${JSON.stringify({
      initializations,
      afterFailure,
      afterInterruption: envelopes.length,
      envelopes,
      states,
      finalized,
      endings,
      interrupted: [first, second].map(
        (exit) => Exit.isFailure(exit) && exit.cause.reasons.every((reason) => reason._tag === 'Interrupt'),
      ),
    })}\n`,
  )
} finally {
  port1.close()
  port2.close()
  await Sentry.close(1000)
}
