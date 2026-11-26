import { expect, test } from 'bun:test'
import { Clock, Effect, Layer, Logger, Option, Result, Schema } from 'effect'
import { TestClock } from 'effect/testing'

import { BrokerRead, MarketCalendarObservationSchema } from '../broker/alpaca/model'
import { normalizeMarketCalendarResult } from '../broker/alpaca/normalizers'
import { DecisionReadinessReason } from '../cycle/runner/readiness'
import { JevClient } from '../jev/client'
import { JevBatchStore } from '../jev/batch-evaluation'
import { EntryInferenceJournal } from '../jev/entry-inference'
import { JevEvaluationStore } from '../jev/evaluation'
import { constructStreamingSnapshot } from '../market-data/streaming/snapshot'
import { CandidateObservationStore } from '../observe-composition/candidate-observation'
import { makeIntradayAlphaRuntime } from './strategy'
import { makeAlphaStreamingSnapshot, makeFlatAlphaPortfolio } from '../strategy/intraday-alpha/test-support'
import { shortEntryBrokerReads } from '../testing/entry-broker-reads.test-support'
import { fixtureRuntime } from '../testing/runtime-fixtures'
import { currentUtcInstant } from '../time'
import { ResearchStrategyEngine } from '../system-assessment/strategy-binding'
import { selectReplayAlphaBaseline } from './alpha-baseline'
import { alphaReplayBaselineFixture } from './alpha-replay.test-support'
import { observeResearchEntry } from './decision-builder'

const run = async (options: { readonly lateBaseline?: boolean; readonly expiryMs?: number } = {}) => {
  const retained = alphaReplayBaselineFixture()
  const binding = retained.binding
  if (binding.engine !== ResearchStrategyEngine.IntradayAlpha) throw new Error('Missing alpha policy')
  const input = makeAlphaStreamingSnapshot({
    minutesFromOpen: 121,
    profiles: {
      COHR: { basePrice: 100, endReturnBps: -350 },
      LITE: { basePrice: 90, endReturnBps: -280 },
      MU: { basePrice: 80, endReturnBps: 250 },
      SNDK: { basePrice: 60, endReturnBps: 340 },
    },
  })
  const portfolio = makeFlatAlphaPortfolio(input.observedAt, '100000000000', '100000000000', 'native-replay-clock-test')
  const calendar = Result.getOrThrow(
    normalizeMarketCalendarResult(
      [{ date: '2026-09-04', session_open: '0930', session_close: '1600', open: '09:30', close: '16:00' }],
      { start: '2026-09-04', end: '2026-09-04' },
    ),
  )
  const reads: { kind: string; observedAt: string }[] = []
  const snapshots: string[] = []
  const baselineCuts: string[] = []
  const recorded: unknown[] = []
  const unused = Effect.die('Unexpected capability in native alpha replay')
  const read = <A, E>(kind: string, select: (value: ReturnType<typeof shortEntryBrokerReads>) => Effect.Effect<A, E>) =>
    Effect.gen(function* () {
      yield* TestClock.adjust('1 millis')
      const observedAt = yield* currentUtcInstant
      reads.push({ kind, observedAt })
      return yield* select(shortEntryBrokerReads(portfolio.brokerState.account, observedAt))
    })
  const sources = [
    {
      ...retained.source,
      availableAt: options.lateBaseline
        ? new Date(Date.parse(input.observedAt) + 1).toISOString()
        : retained.source.availableAt,
    },
  ]
  const result = await Effect.runPromise(
    Effect.gen(function* () {
      yield* TestClock.setTime(Date.parse(input.observedAt))
      const result = yield* Effect.result(
        observeResearchEntry((query, observedAt) =>
          Effect.gen(function* () {
            baselineCuts.push(observedAt)
            return yield* Effect.fromResult(selectReplayAlphaBaseline(binding, sources, query, observedAt))
          }),
        )({
          strategy: makeIntradayAlphaRuntime(binding.parameters, {
            ...fixtureRuntime.provenance,
            strategy: binding.strategy,
          }),
          query: input.query,
          observation: {
            cycleId: '1'.repeat(64),
            authorityGenerationHash: '2'.repeat(64),
            protocol: binding.parameters.sharedProtocol,
            portfolio,
          },
          calendar: Schema.decodeUnknownSync(MarketCalendarObservationSchema)(calendar),
          sessionDate: input.query.sessionDate,
          observedAt: input.observedAt,
          admissionExpiresAt: Date.parse(input.observedAt) + (options.expiryMs ?? 60000),
          loadSnapshot: (query) =>
            Effect.sync(() => {
              snapshots.push(query.observedAt)
              return Result.getOrThrow(constructStreamingSnapshot(input.cut, query))
            }),
        }),
      )
      return { result, completedAt: yield* Clock.currentTimeMillis }
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          TestClock.layer(),
          Layer.succeed(CandidateObservationStore, {
            latestJevWindowEnd: () => Effect.succeed(Option.none()),
            readIntradayAlphaSessionState: () =>
              Effect.succeed({
                morningOrbTakenSymbols: [],
                middayReversionCompleted: false,
                noiseAreaTakenSymbols: [],
              }),
            record: (observation) =>
              Effect.sync(() => {
                recorded.push(observation)
              }),
          }),
          Layer.succeed(BrokerRead, {
            account: read('account', (broker) => broker.account),
            accountConfiguration: read('configuration', (broker) => broker.accountConfiguration),
            assetBySymbol: (symbol) => read(symbol, (broker) => broker.assetBySymbol(symbol)),
            positions: unused,
            orders: () => unused,
            orderById: () => unused,
            orderByClientId: () => unused,
            fillActivities: () => unused,
            feeActivities: () => unused,
            marketCalendar: () => unused,
          }),
          Layer.succeed(JevClient, { evaluate: () => unused }),
          Layer.succeed(EntryInferenceJournal, { recordVisualClaims: () => unused, recordTransitions: () => unused }),
          Layer.succeed(JevBatchStore, {
            read: () => unused,
            pending: () => unused,
            begin: () => unused,
            complete: () => unused,
            finish: () => unused,
          }),
          Layer.succeed(JevEvaluationStore, { read: () => unused, recordAll: () => unused, abandon: () => unused }),
          Logger.layer([]),
        ),
      ),
    ),
  )
  return { ...result, input, reads, snapshots, baselineCuts, recorded }
}

test('research alpha observes fresh borrow eligibility before snapshot refresh while preserving the original baseline cut', async () => {
  const f = await run()
  const value = Result.getOrThrow(f.result)
  expect(value.decision.schemaVersion).toBe('bayn.intraday-alpha-target.v2')
  if (value.decision.schemaVersion !== 'bayn.intraday-alpha-target.v2') throw new Error('Missing alpha target')
  expect(value.decision.selectedSymbols).toEqual(['COHR', 'LITE', 'MU', 'SNDK'])
  expect(f.reads).toHaveLength(22)
  expect(f.snapshots).toHaveLength(1)
  expect(Date.parse(f.snapshots[0] ?? '')).toBeGreaterThan(Date.parse(f.input.observedAt))
  expect(f.reads.every((read) => Date.parse(read.observedAt) <= Date.parse(f.snapshots[0] ?? ''))).toBe(true)
  expect(f.baselineCuts).toEqual([f.input.observedAt])
  expect(f.recorded).toHaveLength(1)
})

test('delayed eligibility cannot admit a newly available baseline or extend the original entry deadline', async () => {
  for (const options of [{ lateBaseline: true }, { expiryMs: 5 }]) {
    const f = await run(options)
    expect(f.reads).toHaveLength(22)
    expect(Result.isFailure(f.result)).toBe(true)
    if (Result.isFailure(f.result)) {
      const error = f.result.failure
      expect(error._tag).toBe('JevAwaitingEvidence')
      if (error._tag === 'JevAwaitingEvidence')
        expect(error.readiness).toBe(
          'lateBaseline' in options
            ? DecisionReadinessReason.SnapshotUnavailable
            : DecisionReadinessReason.SnapshotStale,
        )
    }
    expect(f.baselineCuts).toEqual([f.input.observedAt])
    expect(f.recorded).toEqual([])
    expect(f.completedAt).toBeGreaterThan(Date.parse(f.input.observedAt) + 5)
  }
})
