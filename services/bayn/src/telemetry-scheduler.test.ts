import { expect, test } from 'bun:test'
import { Clock, Deferred, Duration, Effect, Exit, Logger, Metric } from 'effect'
import { PrometheusMetrics } from 'effect/observability'
import { observeSchedulerDelay } from './telemetry-scheduler'

const testClock = (
  read: Effect.Effect<bigint>,
  sleep: Clock.Clock['sleep'],
  allowLogTimestamp = false,
): Clock.Clock => ({
  currentTimeMillisUnsafe: () => {
    if (allowLogTimestamp) return 0
    throw new Error('wall clock read')
  },
  currentTimeMillis: Effect.die('wall clock read'),
  currentTimeNanosUnsafe: () => {
    throw new Error('wall clock read')
  },
  currentTimeNanos: Effect.die('wall clock read'),
  monotonicTimeNanosUnsafe: () => {
    throw new Error('unscoped clock read')
  },
  monotonicTimeNanos: read,
  sleep,
})

test('records monotonic wake-up delay without wall-clock reads, catch-up samples or detached timers', async () => {
  let now = 0n
  let sleeps = 0
  let interrupted = 0
  const durations: number[] = []
  const result = await Effect.runPromise(
    Effect.gen(function* () {
      const first = yield* Deferred.make<void>()
      const second = yield* Deferred.make<void>()
      const third = yield* Deferred.make<void>()
      const releaseFirst = yield* Deferred.make<void>()
      const releaseSecond = yield* Deferred.make<void>()
      const clock = testClock(
        Effect.sync(() => now),
        (duration) =>
          Effect.gen(function* () {
            durations.push(Duration.toMillis(duration))
            sleeps++
            yield* Deferred.succeed(sleeps === 1 ? first : sleeps === 2 ? second : third, undefined)
            yield* sleeps === 1
              ? Deferred.await(releaseFirst)
              : sleeps === 2
                ? Deferred.await(releaseSecond)
                : Effect.never
          }).pipe(
            Effect.onInterrupt(() =>
              Effect.sync(() => {
                interrupted++
              }),
            ),
          ),
      )
      return yield* Effect.scoped(
        Effect.gen(function* () {
          yield* observeSchedulerDelay.pipe(Effect.provideService(Clock.Clock, clock), Effect.forkScoped)
          yield* Deferred.await(first)
          const before = yield* PrometheusMetrics.format()
          now = 3_422_000_000n
          yield* Deferred.succeed(releaseFirst, undefined)
          yield* Deferred.await(second)
          const delayed = yield* PrometheusMetrics.format()
          now += 1_000_000_000n
          yield* Deferred.succeed(releaseSecond, undefined)
          yield* Deferred.await(third)
          const recovered = yield* PrometheusMetrics.format()
          return { before, delayed, recovered }
        }),
      )
    }).pipe(Effect.provideService(Metric.MetricRegistry, new Map())),
  )
  expect(result.before).not.toContain('bayn_scheduler_delay_seconds_count')
  expect(result.delayed).toContain('bayn_scheduler_delay_seconds_count 1\n')
  expect(result.delayed).toContain('bayn_scheduler_delay_seconds_sum 2.422\n')
  expect(result.recovered).toContain('bayn_scheduler_delay_seconds_count 2\n')
  expect(result.recovered).toContain('bayn_scheduler_delay_seconds_sum 2.422\n')
  expect(durations).toEqual([1000, 1000, 1000])
  expect(sleeps).toBe(3)
  expect(interrupted).toBe(1)
})

test.each(['clock', 'metric'])('a %s defect stops only the diagnostic and reports a fixed warning', async (failure) => {
  const messages: unknown[] = []
  let sleeps = 0
  const result = await Effect.runPromise(
    observeSchedulerDelay.pipe(
      Effect.provideService(
        Clock.Clock,
        testClock(
          failure === 'clock' ? Effect.die('private diagnostic failure') : Effect.succeed(0n),
          () =>
            Effect.sync(() => {
              sleeps++
            }),
          true,
        ),
      ),
      Effect.provideService(
        Metric.MetricRegistry,
        new (class extends Map {
          override set(): this {
            throw new Error('private metric failure')
          }
        })(),
      ),
      Effect.provide(
        Logger.layer([
          Logger.make((options) => {
            messages.push(options.message)
          }),
        ]),
      ),
      Effect.as('original work continues'),
    ),
  )
  expect(result).toBe('original work continues')
  expect(sleeps).toBe(failure === 'clock' ? 0 : 1)
  expect(JSON.stringify(messages)).toContain('Bayn scheduler-delay diagnostics stopped')
  expect(JSON.stringify(messages)).not.toContain('private')
})

test.each(['failure', 'defect', 'interruption'])(
  'scope %s cancels the sampler without changing the original outcome',
  async (outcome) => {
    let interrupted = 0
    const messages: unknown[] = []
    const reason = { original: true }
    const result = await Effect.runPromiseExit(
      Effect.scoped(
        Effect.gen(function* () {
          const sleeping = yield* Deferred.make<void>()
          const clock = testClock(Effect.succeed(0n), () =>
            Deferred.succeed(sleeping, undefined).pipe(
              Effect.andThen(Effect.never),
              Effect.onInterrupt(() =>
                Effect.sync(() => {
                  interrupted++
                }),
              ),
            ),
          )
          yield* observeSchedulerDelay.pipe(Effect.provideService(Clock.Clock, clock), Effect.forkScoped)
          yield* Deferred.await(sleeping)
          return yield* outcome === 'failure'
            ? Effect.fail(reason)
            : outcome === 'defect'
              ? Effect.die(reason)
              : Effect.interrupt
        }),
      ).pipe(
        Effect.provide(
          Logger.layer([
            Logger.make((options) => {
              messages.push(options.message)
            }),
          ]),
        ),
      ),
    )
    expect(Exit.isFailure(result)).toBe(true)
    if (Exit.isFailure(result)) {
      expect(result.cause.reasons).toHaveLength(1)
      const actual = result.cause.reasons[0]
      expect(actual?._tag).toBe(outcome === 'failure' ? 'Fail' : outcome === 'defect' ? 'Die' : 'Interrupt')
      if (actual?._tag === 'Fail') expect(actual.error).toBe(reason)
      if (actual?._tag === 'Die') expect(actual.defect).toBe(reason)
    }
    expect(interrupted).toBe(1)
    expect(messages).toEqual([])
  },
)
