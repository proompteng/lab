import { mock } from 'bun:test'
import { parentPort, workerData } from 'node:worker_threads'
import { NodeRuntime } from '@effect/platform-node'
import { PgClient } from '@effect/sql-pg'
import { Effect, FiberSet, Layer, Logger } from 'effect'
import { TestClock } from 'effect/testing'
import type { NativeArrivalCaptureFactory, NativeArrivalStore } from './native-arrival-journal'
import {
  nativeArrivalEpochFixture as epoch,
  nativeArrivalObservationFixture as observation,
} from './native-arrival.test-support'

const store: NativeArrivalStore = {
  begin: () => Effect.void,
  append: () => Effect.never,
  end: () => Effect.void,
}
await mock.module('../../db/postgres-client', () => ({
  PostgresClientLive: () => Layer.succeed(PgClient.PgClient, {} as PgClient.PgClient),
}))
await mock.module('../../db/native-arrival-postgres', () => ({ makeNativeArrivalStore: () => store }))
const kafka = await import('./kafka')
await mock.module('./kafka', () => ({
  ...kafka,
  makeKafkaMarketProjection: (
    _config: unknown,
    _sources: unknown,
    _factory: unknown,
    _clock: unknown,
    capture: NativeArrivalCaptureFactory,
  ) =>
    Effect.gen(function* () {
      const failed = yield* capture(epoch.bootstrap, epoch.sources)
      yield* failed.observe(observation(3))
      yield* capture(epoch.bootstrap, epoch.sources)
      const status = Effect.succeed({ epoch: 'fixture', sequence: 0, ready: true, bootstrapDeadlineAtMs: null })
      return { status, check: Effect.void, read: Effect.never, readForLiquidation: Effect.never }
    }),
}))
const { projectionWorkerProgram } = await import('./market-projection-worker')
if (parentPort === null) throw new Error('Fixture needs a real worker port')
const port = parentPort
const program = Effect.gen(function* () {
  const run = yield* FiberSet.makeRuntime()
  const advance = (message: { fixtureAdvance?: number }) => {
    if (message.fixtureAdvance !== undefined)
      run(
        TestClock.adjust(message.fixtureAdvance).pipe(
          Effect.andThen(Effect.sync(() => port.postMessage({ _tag: 'FixtureAdvanced' }))),
        ),
      )
  }
  if (workerData.fixtureClock) {
    port.on('message', advance)
    yield* Effect.addFinalizer(() => Effect.sync(() => port.off('message', advance)))
  }
  return yield* projectionWorkerProgram(workerData, port)
}).pipe(Effect.scoped, Effect.provide(Logger.layer([])))
NodeRuntime.runMain(workerData.fixtureClock ? program.pipe(Effect.provide(TestClock.layer())) : program)
