import { expect, test } from 'bun:test'
import { Deferred, Effect, Exit, Fiber, Result } from 'effect'
import { TestClock } from 'effect/testing'

import { operationalError } from '../errors'
import { IntradaySnapshotPurpose, type IntradayMarketDataService } from '../market-data'
import {
  ActiveExecutionStages,
  ExecutionStageTimings,
  type ActiveExecutionStage,
  type ExecutionStageTiming,
} from '../telemetry'
import { streamingFixture } from '../testing/streaming-market-fixture'
import { loadIntradaySnapshot } from './intraday-market-data'

test.each([undefined, IntradaySnapshotPurpose.EntryPricing, IntradaySnapshotPurpose.Liquidation])(
  'loads the %s snapshot lazily with one measured source request',
  async (purpose) => {
    const fixture = streamingFixture()
    const query = { ...fixture.query, ...(purpose === undefined ? {} : { purpose }) }
    const timings = new Map<string, ExecutionStageTiming>()
    let calls = 0
    const marketData: IntradayMarketDataService = {
      check: Effect.void,
      verifyReference: () => Effect.die('Unexpected reference read'),
      loadSnapshot: (actualQuery) => {
        calls += 1
        expect(actualQuery).toEqual(query)
        return TestClock.adjust(25).pipe(Effect.as(fixture.snapshot))
      },
    }
    const program = loadIntradaySnapshot(marketData, query)
    expect(calls).toBe(0)
    const actual = await Effect.runPromise(
      program.pipe(Effect.provideService(ExecutionStageTimings, timings), Effect.provide(TestClock.layer())),
    )
    expect(calls).toBe(1)
    expect(actual).toBe(fixture.snapshot)
    expect([...timings.values()]).toEqual([
      {
        stage: 'bayn.market-data.snapshot',
        dependency: 'market-data',
        operation: purpose ?? 'signal',
        count: 1,
        inclusiveElapsedMs: 25,
        maxElapsedMs: 25,
        failures: 0,
        interruptions: 0,
      },
    ])
  },
)

test('retains a snapshot source failure without reading a replacement', async () => {
  const { query } = streamingFixture()
  const failure = operationalError({ component: 'market-data', operation: 'snapshot', message: 'source unavailable' })
  let calls = 0
  const marketData: IntradayMarketDataService = {
    check: Effect.void,
    verifyReference: () => Effect.die('Unexpected reference read'),
    loadSnapshot: () => Effect.sync(() => (calls += 1)).pipe(Effect.andThen(Effect.fail(failure))),
  }
  const result = await Effect.runPromise(loadIntradaySnapshot(marketData, query).pipe(Effect.result))
  expect(result).toEqual(Result.fail(failure))
  expect(calls).toBe(1)
})

test('cancels the owned snapshot read once and clears its active diagnostic stage', async () => {
  const { query } = streamingFixture()
  const timings = new Map<string, ExecutionStageTiming>()
  const active = new Map<symbol, ActiveExecutionStage>()
  let finalized = 0
  const exit = await Effect.runPromise(
    Effect.gen(function* () {
      const entered = yield* Deferred.make<void>()
      const marketData: IntradayMarketDataService = {
        check: Effect.void,
        verifyReference: () => Effect.die('Unexpected reference read'),
        loadSnapshot: () =>
          Deferred.succeed(entered, undefined).pipe(
            Effect.andThen(Effect.never),
            Effect.ensuring(Effect.sync(() => (finalized += 1))),
          ),
      }
      const fiber = yield* loadIntradaySnapshot(marketData, query).pipe(Effect.forkChild({ startImmediately: true }))
      yield* Deferred.await(entered)
      yield* TestClock.adjust(25)
      yield* Fiber.interrupt(fiber)
      return yield* Fiber.await(fiber)
    }).pipe(
      Effect.provideService(ExecutionStageTimings, timings),
      Effect.provideService(ActiveExecutionStages, active),
      Effect.provide(TestClock.layer()),
    ),
  )
  expect(Exit.isFailure(exit)).toBe(true)
  expect(finalized).toBe(1)
  expect(active.size).toBe(0)
  expect([...timings.values()]).toMatchObject([
    { stage: 'bayn.market-data.snapshot', count: 1, maxElapsedMs: 25, interruptions: 1, failures: 0 },
  ])
})
