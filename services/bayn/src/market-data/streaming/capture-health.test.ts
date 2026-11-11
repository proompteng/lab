import { expect, test } from 'bun:test'
import { Effect, Exit, Logger, Metric, Scope } from 'effect'
import { TestClock } from 'effect/testing'
import { PrometheusMetrics } from 'effect/observability'
import { makeCaptureHealth, observeCaptureWorker } from './capture-health'
import { makeNativeArrivalJournal, type NativeArrivalStore } from './native-arrival-journal'
import { NativeArrivalCaptureError } from './native-arrival'
import {
  nativeArrivalEpochFixture as epoch,
  nativeArrivalObservationFixture as observation,
} from './native-arrival.test-support'

const store: NativeArrivalStore = { begin: () => Effect.void, append: () => Effect.void, end: () => Effect.void }
const isolated = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(Effect.provide(TestClock.layer()), Effect.provide(Logger.layer([])))

test('quiet captures stay healthy; pending work ages only until an acknowledged durable advance', async () => {
  const health = makeCaptureHealth()
  let acknowledge = false
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const capture = yield* health.wrap(() =>
          makeNativeArrivalJournal(epoch, {
            ...store,
            append: () =>
              Effect.suspend(() =>
                acknowledge
                  ? Effect.void
                  : Effect.sleep('1 second').pipe(
                      Effect.andThen(Effect.suspend(() => (acknowledge ? Effect.void : Effect.never))),
                    ),
              ),
          }),
        )(epoch.bootstrap, epoch.sources)
        expect(health.sample(1000, 1000).pendingStagnantSeconds).toBe(0)
        yield* capture.observe(observation(1))
        expect(health.sample(1001, 1001).pendingStagnantSeconds).toBe(0)
        expect(health.sample(1040, 1040).pendingStagnantSeconds).toBe(39)
        acknowledge = true
        yield* TestClock.adjust('2 seconds')
        expect(capture.status().durableConsumerSequence).toBe(1)
        expect(health.sample(1041, 1041).pendingStagnantSeconds).toBe(0)
        expect(health.sample(10000, 10000).pendingStagnantSeconds).toBe(0)
      }),
    ).pipe(isolated),
  )
  expect(health.sample(20000, 20000)).toMatchObject({ activeCaptures: 0, terminalFailures: 0 })
})

test('failed sibling and finalization failure remain counted once; normal interruption is not failure', async () => {
  const health = makeCaptureHealth()
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        yield* health.wrap(() => makeNativeArrivalJournal(epoch, store))(epoch.bootstrap, epoch.sources)
        yield* health.wrap(() =>
          makeNativeArrivalJournal(epoch, {
            ...store,
            end: () => Effect.fail(new NativeArrivalCaptureError({ message: 'seal failed' })),
          }),
        )(epoch.bootstrap, epoch.sources)
        const failed = yield* health.wrap(() => makeNativeArrivalJournal(epoch, store))(epoch.bootstrap, epoch.sources)
        yield* failed.observe(observation(3))
        expect(health.sample(0, 0)).toMatchObject({ activeCaptures: 3, incompleteCaptures: 1, terminalFailures: 1 })
        expect(health.sample(1, 1).terminalFailures).toBe(1)
      }),
    ).pipe(isolated),
  )
  expect(health.sample(10, 10)).toMatchObject({ activeCaptures: 0, incompleteCaptures: 0, terminalFailures: 2 })
  const exit = await Effect.runPromiseExit(
    Effect.scoped(
      health
        .wrap(() => makeNativeArrivalJournal(epoch, store))(epoch.bootstrap, epoch.sources)
        .pipe(Effect.andThen(Effect.interrupt)),
    ).pipe(isolated),
  )
  expect(Exit.hasInterrupts(exit)).toBe(true)
  expect(health.sample(20, 20).terminalFailures).toBe(2)
})

test('parent aggregates siblings, detects absent and stale frames, and retires only the closing owner', async () => {
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const firstScope = yield* Scope.make()
        const secondScope = yield* Scope.make()
        const first = yield* observeCaptureWorker.pipe(Effect.provideService(Scope.Scope, firstScope))
        const second = yield* observeCaptureWorker.pipe(Effect.provideService(Scope.Scope, secondScope))
        first({
          observedAtSeconds: 0,
          activeCaptures: 1,
          incompleteCaptures: 1,
          pendingStagnantSeconds: 0,
          terminalFailures: 1,
        })
        yield* TestClock.adjust('15 seconds')
        let metrics = yield* PrometheusMetrics.format()
        expect(metrics).toContain('bayn_capture_workers_expected 2')
        expect(metrics).toContain('bayn_capture_workers_unobserved 1')
        expect(metrics).toContain('bayn_capture_incomplete 1')
        second({
          observedAtSeconds: 15,
          activeCaptures: 1,
          incompleteCaptures: 0,
          pendingStagnantSeconds: 0,
          terminalFailures: 0,
        })
        yield* TestClock.adjust('45 seconds')
        metrics = yield* PrometheusMetrics.format()
        expect(metrics).toContain('bayn_capture_workers_unobserved 1')
        expect(metrics).toContain('bayn_capture_terminal_failures_total 1')
        yield* Scope.close(firstScope, Exit.void)
        expect(yield* PrometheusMetrics.format()).toContain('bayn_capture_workers_expected 1')
        yield* Scope.close(secondScope, Exit.void)
        metrics = yield* PrometheusMetrics.format()
        expect(metrics).toContain('bayn_capture_workers_expected 0')
        expect(metrics).toContain('bayn_capture_workers_unobserved 0')
      }),
    ).pipe(isolated, Effect.provideService(Metric.MetricRegistry, new Map())),
  )
})

test('a 35-second uncertain acknowledgement retains the same batch and only acknowledged progress resets stagnation', async () => {
  const health = makeCaptureHealth()
  const seen: unknown[] = []
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const capture = yield* health.wrap(() =>
          makeNativeArrivalJournal(epoch, {
            ...store,
            append: (chunks) =>
              Effect.gen(function* () {
                seen.push(chunks)
                yield* Effect.sleep('35 seconds')
                seen.push(chunks)
              }),
          }),
        )(epoch.bootstrap, epoch.sources)
        yield* capture.observe(observation(1))
        health.sample(0, 0)
        yield* TestClock.adjust('1 second')
        yield* TestClock.adjust('34 seconds')
        expect(capture.status().durableConsumerSequence).toBe(0)
        expect(health.sample(35, 35)).toMatchObject({ pendingStagnantSeconds: 35, terminalFailures: 0 })
        yield* TestClock.adjust('1 second')
        expect(capture.status().durableConsumerSequence).toBe(1)
        expect(health.sample(36, 36)).toMatchObject({ pendingStagnantSeconds: 0, terminalFailures: 0 })
        expect(seen).toHaveLength(2)
        expect(seen[0]).toBe(seen[1])
      }),
    ).pipe(isolated),
  )
})

for (const failure of ['typed', 'defect', 'interruption'] as const) {
  test(`a ${failure} append termination stays incomplete beside a healthy capture and counts once`, async () => {
    const health = makeCaptureHealth()
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          yield* health.wrap(() => makeNativeArrivalJournal(epoch, store))(epoch.bootstrap, epoch.sources)
          const failed = yield* health.wrap(() =>
            makeNativeArrivalJournal(epoch, {
              ...store,
              append: () =>
                failure === 'typed'
                  ? Effect.fail(new NativeArrivalCaptureError({ message: 'append failed' }))
                  : failure === 'defect'
                    ? Effect.die('append defect')
                    : Effect.interrupt,
            }),
          )(epoch.bootstrap, epoch.sources)
          yield* failed.observe(observation(1))
          yield* TestClock.adjust('1 second')
          expect(failed.status()).toMatchObject({
            status: 'INCOMPLETE',
            observedConsumerSequence: 1,
            durableConsumerSequence: 0,
          })
          expect(health.sample(100, 100)).toMatchObject({
            activeCaptures: 2,
            incompleteCaptures: 1,
            terminalFailures: 1,
            pendingStagnantSeconds: 0,
          })
          expect(health.sample(200, 200).terminalFailures).toBe(1)
        }),
      ).pipe(isolated),
    )
    expect(health.sample(300, 300)).toMatchObject({ activeCaptures: 0, terminalFailures: 1 })
  })
}
