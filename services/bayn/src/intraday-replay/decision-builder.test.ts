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
import { selectReplayAlphaBaselineSource } from './alpha-baseline'
import { selectReplayAlphaBaselinePreparation } from './alpha-prepared-baseline'
import { preparedReplayAlphaBaselineFixture } from './alpha-prepared-baseline.test-support'
import type { AnyReplayAlphaBaselineAdmissionUse } from './alpha-baseline-use'
import { alphaReplayBaselineFixture } from './alpha-replay.test-support'
import { observeResearchEntry } from './decision-builder'
import { operationalError } from '../errors'
import { makeReplayDecisionLatency } from './decision-latency'
import { ReplayBrokerFailure } from './broker'

const run = async (
  options: {
    readonly lateBaseline?: boolean
    readonly expiryMs?: number
    readonly failRecord?: boolean
    readonly failAfterRecord?: boolean
    readonly failRelease?: boolean
    readonly preparedBaseline?: 'early' | 'late-before-admission'
  } = {},
) => {
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
  const commandLeadMs = options.preparedBaseline === undefined ? 0 : 100
  const preparation =
    options.preparedBaseline === undefined
      ? null
      : preparedReplayAlphaBaselineFixture(
          options.preparedBaseline === 'early' ? undefined : new Date(Date.parse(input.observedAt) - 50).toISOString(),
        )
  const calendar = Schema.decodeUnknownSync(MarketCalendarObservationSchema)(
    Result.getOrThrow(
      normalizeMarketCalendarResult(
        [{ date: '2026-09-04', session_open: '0930', session_close: '1600', open: '09:30', close: '16:00' }],
        { start: '2026-09-04', end: '2026-09-04' },
      ),
    ),
  )
  const reads: { kind: string; observedAt: string }[] = []
  const snapshots: string[] = []
  const baselineCuts: string[] = []
  const recorded: unknown[] = []
  const uses: AnyReplayAlphaBaselineAdmissionUse[] = []
  const latency = makeReplayDecisionLatency(
    currentUtcInstant,
    options.failRelease
      ? {
          p95FullBatchMs: 1000,
          advanceTo: () => Effect.fail(new ReplayBrokerFailure({ message: 'test-only release failure' })),
        }
      : null,
    true,
  )
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
      yield* TestClock.setTime(Date.parse(input.observedAt) - commandLeadMs)
      const result = yield* Effect.result(
        latency.runPass(
          Effect.gen(function* () {
            yield* TestClock.adjust(commandLeadMs)
            return yield* observeResearchEntry(
              (query, observedAt) =>
                Effect.gen(function* () {
                  if (preparation !== null) {
                    const commandIssuedAt = yield* latency.currentCommandIssuedAt
                    baselineCuts.push(commandIssuedAt)
                    return yield* Effect.fromResult(
                      selectReplayAlphaBaselinePreparation(binding, [preparation.source], query, commandIssuedAt),
                    )
                  }
                  baselineCuts.push(observedAt)
                  return yield* Effect.fromResult(selectReplayAlphaBaselineSource(binding, sources, query, observedAt))
                }),
              (use) =>
                Effect.sync(() => {
                  uses.push(use)
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
              calendar,
              sessionDate: input.query.sessionDate,
              observedAt: input.observedAt,
              admissionExpiresAt: Date.parse(input.observedAt) + (options.expiryMs ?? 60000),
              loadSnapshot: (query) =>
                Effect.sync(() => {
                  snapshots.push(query.observedAt)
                  return Result.getOrThrow(constructStreamingSnapshot(input.cut, query))
                }),
            })
          }),
        ),
      )
      return { result, completedAt: yield* Clock.currentTimeMillis, latencyEvidence: yield* latency.evidence }
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          TestClock.layer(),
          Layer.succeed(
            CandidateObservationStore,
            latency.wrapObservations({
              latestJevWindowEnd: () => Effect.succeed(Option.none()),
              readIntradayAlphaSessionState: () =>
                options.failAfterRecord
                  ? Effect.fail(
                      operationalError({
                        component: 'strategy',
                        operation: 'test',
                        message: 'test-only later decision failure',
                      }),
                    )
                  : Effect.succeed({
                      morningOrbTakenSymbols: [],
                      middayReversionCompleted: false,
                      noiseAreaTakenSymbols: [],
                    }),
              record: (observation) =>
                options.failRecord
                  ? Effect.fail(
                      operationalError({
                        component: 'database',
                        operation: 'test',
                        message: 'test-only durable record failure',
                      }),
                    )
                  : Effect.sync(() => {
                      recorded.push(observation)
                    }),
            }),
          ),
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
  return { ...result, input, preparation, reads, snapshots, baselineCuts, recorded, uses }
}

test('prepared alpha executes four legs from its witnessed source and cannot acquire a baseline during command reconciliation', async () => {
  const early = await run({ preparedBaseline: 'early' })
  const decision = Result.getOrThrow(early.result).decision
  if (decision.schemaVersion !== 'bayn.intraday-alpha-target.v2') throw new Error('Missing native alpha target')
  expect(decision.selectedSymbols).toEqual(['COHR', 'LITE', 'MU', 'SNDK'])
  expect(early.uses).toHaveLength(1)
  expect(early.uses[0]).toMatchObject({
    schemaVersion: 'bayn.replay-alpha-baseline-use.v2',
    sourcePreparationHash: early.preparation?.source.preparationHash,
    sourceWitnessHash: early.preparation?.source.witnessSourceHash,
    admissionObservedAt: early.input.observedAt,
  })
  expect(early.baselineCuts).toEqual([new Date(Date.parse(early.input.observedAt) - 100).toISOString()])
  const late = await run({ preparedBaseline: 'late-before-admission' })
  expect(Result.isFailure(late.result) && late.result.failure).toMatchObject({
    _tag: 'JevAwaitingEvidence',
    readiness: DecisionReadinessReason.SnapshotUnavailable,
  })
  expect(Date.parse(late.preparation?.source.availableAt ?? '')).toBeLessThan(Date.parse(late.input.observedAt))
  expect(late.recorded).toEqual([])
  expect(late.uses).toEqual([])
  const failed = await run({ preparedBaseline: 'early', failRecord: true })
  expect(Result.isFailure(failed.result)).toBe(true)
  expect(failed.uses).toEqual([])
})

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
  expect(f.uses).toHaveLength(1)
  expect(f.uses[0]).toMatchObject({
    admissionObservedAt: f.input.observedAt,
    cycleId: '1'.repeat(64),
    authorityGenerationHash: '2'.repeat(64),
  })
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
    expect(f.uses).toEqual([])
    expect(f.completedAt).toBeGreaterThan(Date.parse(f.input.observedAt) + 5)
  }
})

test('baseline-use evidence follows durable observation success even if the later decision fails', async () => {
  const before = await run({ failRecord: true })
  expect(Result.isFailure(before.result)).toBe(true)
  expect(before.recorded).toEqual([])
  expect(before.uses).toEqual([])
  const after = await run({ failAfterRecord: true })
  expect(Result.isFailure(after.result)).toBe(true)
  expect(after.recorded).toHaveLength(1)
  expect(after.uses).toHaveLength(1)
  expect(after.uses[0]?.admissionObservedAt).toBe(after.input.observedAt)
  const unreleased = await run({ failRelease: true })
  expect(Result.isFailure(unreleased.result)).toBe(true)
  expect(unreleased.recorded).toHaveLength(1)
  expect(unreleased.uses).toHaveLength(1)
  expect(unreleased.latencyEvidence.unreleasedObservationHashes).toEqual([unreleased.uses[0]?.observationHash])
})
