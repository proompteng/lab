import { describe, expect, test } from 'bun:test'
import { Effect, Option } from 'effect'
import { TestClock } from 'effect/testing'
import { NodeServices } from '@effect/platform-node'

import { CycleState, type AutonomousCycle } from '../cycle'
import { retryableOperationalError, operationalError } from '../errors'
import { type IntradayMarketDataService } from '../market-data'
import { CandidateObservationStore } from '../observe-composition/candidate-observation'
import { makeIntradayMomentumTestSnapshot } from '../strategy/intraday-momentum/test-support'
import { streamingFixtureFromRaw } from '../testing/streaming-market-fixture'
import { JevBatchStore } from './batch-evaluation'
import { JevClient } from './client'
import { JevEvaluationStore } from './evaluation'
import { JevExitReason } from './exit'
import { nativeJevDecisionEvidence, nativeJevFixture } from './native.test-support'
import { JevPositionStore, JevPurpose } from './portfolio'
import { evaluateJevPositionManagement } from './runtime'

const scenario = (
  options: {
    readonly consumed?: boolean
    readonly pending?: boolean
    readonly protective?: boolean
    readonly maximumHold?: boolean
    readonly storeFailure?: boolean
    readonly mismatchedWindow?: boolean
  } = {},
) => {
  const fixture = nativeJevFixture(JevPurpose.Manage, '2026-09-04T14:30:32.000Z')
  const original = fixture.portfolio
  if (original.purpose !== JevPurpose.Manage) throw new Error('Expected held-position fixture')
  const portfolio = {
    ...original,
    entryFills: options.maximumHold
      ? original.entryFills.map((fill) => ({ ...fill, occurredAt: '2026-09-04T14:15:32.000Z' }))
      : original.entryFills,
  }
  const cycle: AutonomousCycle = {
    ...fixture.draft,
    state: CycleState.Active,
    bindings: {},
    stateVersion: 1,
    createdAt: fixture.observation.payload.observedAt,
    updatedAt: fixture.observation.payload.observedAt,
  }
  const calls = { pricing: 0, signal: 0, pending: 0, finish: 0, window: 0 }
  const databaseFailure = operationalError({ component: 'database', operation: 'window', message: 'test failure' })
  const marketData: IntradayMarketDataService = {
    check: Effect.void,
    verifyReference: () => Effect.die('Unexpected reference read'),
    loadSnapshot: (query) =>
      Effect.suspend(() => {
        if (query.purpose === undefined) {
          calls.signal += 1
          if (options.mismatchedWindow)
            return Effect.succeed({
              ...fixture.snapshot,
              manifest: {
                ...fixture.snapshot.manifest,
                rangeEndAt: '2026-09-04T14:29:00.000Z',
              },
            })
          return Effect.fail(
            retryableOperationalError({
              component: 'market-data',
              operation: 'snapshot',
              message: 'signal history unavailable',
            }),
          )
        }
        calls.pricing += 1
        return Effect.succeed(
          streamingFixtureFromRaw(
            makeIntradayMomentumTestSnapshot(
              fixture.protocol,
              { ...query, archiveWatermarks: [] },
              { AAPL: options.protective ? -0.02 : 0.02 },
            ),
            query,
          ).snapshot,
        )
      }),
  }
  const pendingEvidence = nativeJevDecisionEvidence(fixture, 'hold')
  const program = evaluateJevPositionManagement({
    cycle,
    entryDecisionHash: portfolio.entryDecisionHash,
    authorityGenerationHash: fixture.observation.payload.authorityGenerationHash,
    protocol: fixture.protocol,
    calendar: fixture.snapshot.manifest.calendar,
    brokerState: portfolio.brokerState,
    marketData,
  }).pipe(
    Effect.provideService(JevPositionStore, { read: () => Effect.succeed(portfolio) }),
    Effect.provideService(CandidateObservationStore, {
      record: () => Effect.die('Unexpected observation write'),
      latestJevWindowEnd: () =>
        Effect.suspend(() => {
          calls.window += 1
          return options.storeFailure
            ? Effect.fail(databaseFailure)
            : Effect.succeed(
                options.consumed === false ? Option.none() : Option.some(fixture.snapshot.manifest.rangeEndAt),
              )
        }),
    }),
    Effect.provideService(JevBatchStore, {
      pending: () =>
        Effect.sync(() => {
          calls.pending += 1
          return options.pending ? ['pending'] : []
        }),
      finish: () =>
        Effect.sync(() => {
          calls.finish += 1
          return { plan: pendingEvidence.batchPlan, result: null }
        }),
      read: () => Effect.die('Unexpected batch read'),
      begin: () => Effect.die('Unexpected inference batch'),
    }),
    Effect.provideService(JevEvaluationStore, {
      read: () => Effect.die('Unexpected evaluation read'),
      begin: () => Effect.die('Unexpected evaluation claim'),
      record: () => Effect.die('Unexpected evaluation write'),
      abandon: () => Effect.die('Unexpected evaluation abandonment'),
    }),
    Effect.provideService(JevClient, { evaluate: () => Effect.die('Unexpected provider call') }),
  )
  const run = () =>
    Effect.runPromise(
      TestClock.setTime(Date.parse(fixture.observation.payload.observedAt)).pipe(
        Effect.andThen(program),
        Effect.provide(TestClock.layer()),
        Effect.provide(NodeServices.layer),
      ),
    )
  return { calls, run }
}

describe('Jev management observation admission', () => {
  test('a consumed minute checks protection without loading its full signal history', async () => {
    const check = scenario()
    expect(await check.run()).toMatchObject({
      _tag: 'Wait',
      details: { readiness: { reason: 'SIGNAL_WINDOW_OBSERVED', availableAt: '2026-09-04T14:31:02.000Z' } },
    })
    expect(check.calls).toEqual({ pricing: 1, signal: 0, pending: 1, finish: 0, window: 1 })
  })

  test('pending inference recovery precedes the full signal read', async () => {
    const check = scenario({ pending: true })
    expect(await check.run()).toMatchObject({ _tag: 'Wait', details: { readiness: { reason: 'DECISION_PENDING' } } })
    expect(check.calls).toEqual({ pricing: 1, signal: 0, pending: 1, finish: 1, window: 0 })
  })

  test('a fresh minute still requires source evidence and preserves its unavailability', async () => {
    const check = scenario({ consumed: false })
    expect(await check.run()).toMatchObject({
      _tag: 'Wait',
      details: { readiness: { reason: 'SNAPSHOT_UNAVAILABLE' } },
    })
    expect(check.calls).toEqual({ pricing: 1, signal: 1, pending: 1, finish: 0, window: 1 })
  })

  test.each([
    [JevExitReason.ProtectiveStop, { protective: true }, 1],
    [JevExitReason.MaximumHold, { maximumHold: true }, 0],
  ] as const)('%s remains eligible before observation admission', async (reason, options, pricing) => {
    const check = scenario(options)
    expect(await check.run()).toMatchObject({ _tag: 'Exit', target: { reason } })
    expect(check.calls).toEqual({ pricing, signal: 0, pending: 0, finish: 0, window: 0 })
  })

  test('a failed durable window read cannot become a successful wait', async () => {
    const check = scenario({ storeFailure: true })
    const failure = await check.run().catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(Error)
    expect(failure).toMatchObject({ message: expect.stringContaining('test failure') })
    expect(check.calls.signal).toBe(0)
  })

  test('a different returned signal window cannot use the admitted window', async () => {
    const check = scenario({ consumed: false, mismatchedWindow: true })
    const failure = await check.run().catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(Error)
    expect(failure).toMatchObject({ message: expect.stringContaining('differs from its admitted window') })
    expect(check.calls).toEqual({ pricing: 1, signal: 1, pending: 1, finish: 0, window: 1 })
  })
})
