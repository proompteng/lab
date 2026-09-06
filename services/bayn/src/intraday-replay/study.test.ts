import { describe, expect, test } from 'bun:test'
import { Cause, Deferred, Effect, Exit, Fiber, Result, Schema } from 'effect'

import { makeStrategyProtocolHashResult } from '../contracts'
import { operationalError } from '../errors'
import { canonicalHashV1Result } from '../hash'
import { IntradaySnapshotFailure, type IntradayMarketDataService } from '../market-data'
import { loadQuoteBoundExecutionRiskPolicy } from '../observe-composition/decision-builder'
import { activeStrategyBehaviorHash, activeStrategyName } from '../strategy'
import {
  decodeDefaultIntradayMomentumProtocol,
  hashIntradayMomentumProtocol,
} from '../strategy/intraday-momentum/protocol'
import { makeIntradayMomentumTestSnapshot } from '../strategy/intraday-momentum/test-support'
import { ArchiveReplayStudyInputSchema, runArchiveReplayStudy, type ArchiveReplayStudyInput } from './study'

const protocol = Result.getOrThrow(decodeDefaultIntradayMomentumProtocol())
const protocolHash = Result.getOrThrow(hashIntradayMomentumProtocol(protocol))
const strategyProtocolHash = Result.getOrThrow(
  makeStrategyProtocolHashResult({
    name: activeStrategyName,
    behaviorHash: activeStrategyBehaviorHash,
    parameterHash: protocolHash,
    parameterSchemaVersion: protocol.schemaVersion,
  }),
)

const inputEffect = Effect.gen(function* () {
  const risk = yield* loadQuoteBoundExecutionRiskPolicy('build-contract', protocol.universe)
  const input: ArchiveReplayStudyInput = {
    schemaVersion: 'bayn.archive-replay-study-input.v1',
    experimentPlanHash: 'a'.repeat(64),
    strategyProtocolHash,
    riskPolicyHash: Result.getOrThrow(canonicalHashV1Result(risk)),
    sessionMode: 'independent-flat-start',
    scenarios: [
      {
        name: 'stress',
        input: {
          schemaVersion: 'bayn.intraday-replay-input.v1',
          range: { start: '2026-09-01', end: '2026-09-02' },
          calendar: [
            { date: '2026-09-01', open: '09:30', close: '16:00' },
            { date: '2026-09-02', open: '09:30', close: '16:00' },
          ],
          initialCapitalMicros: '2000000000',
          allocationCapitalMicros: '2000000000',
          assumptions: {
            pollIntervalMs: 30_000,
            firstPollDelayMs: 2_000,
            orderLatencyMs: 100,
            availableLiquidityPpm: 1_000_000,
            slippageBps: 1,
            feeMultiplierPpm: 1_000_000,
          },
        },
      },
    ],
  }
  return input
})

const archive = (missingDate?: string, defect = false) => {
  const dates: string[] = []
  const service: IntradayMarketDataService = {
    check: Effect.void,
    captureVersion: (query) => {
      dates.push(query.sessionDate)
      if (defect) return Effect.die('archive defect')
      if (query.sessionDate === missingDate)
        return Effect.fail(
          operationalError({
            component: 'market-data',
            operation: 'load-intraday',
            message: 'missing archive contract',
            cause: new IntradaySnapshotFailure({ reason: 'coverage', message: 'missing archive contract' }),
          }),
        )
      return Effect.succeed(
        Object.values(protocol.sourceTopics).map((sourceTopic) => ({
          sourceTopic,
          sourcePartition: 0,
          inclusiveLastOffset: '100',
        })),
      )
    },
    loadSnapshot: (request) =>
      Effect.succeed(
        makeIntradayMomentumTestSnapshot(protocol, request, request.purpose === undefined ? { AAPL: 0.01 } : {}),
      ),
    verifyArchiveSnapshot: () => Effect.die('unused verification'),
  }
  return { service, dates }
}

describe('archive replay study', () => {
  test('evaluates later dates after a missing session and withholds aggregate P&L', async () => {
    const input = await Effect.runPromise(inputEffect)
    const market = archive('2026-09-01')
    const report = await Effect.runPromise(runArchiveReplayStudy(input, market.service, '2026-09-05T00:00:00.000Z'))
    const scenario = report.scenarios[0]
    expect(scenario?.replays.map((replay) => replay.sessions[0]?.status)).toEqual(['INCOMPLETE', 'COMPLETE'])
    expect(scenario?.totals.independentSessionNetPnlMicros).toBeNull()
    expect(scenario?.replays.map((replay) => replay.sessions[0]?.openingCashMicros)).toEqual([
      '2000000000',
      '2000000000',
    ])
    expect(new Set(market.dates)).toEqual(new Set(['2026-09-01', '2026-09-02']))
    expect(report.qualification).toBe('NOT_QUALIFIED')
    const { reportHash, ...material } = report
    expect(reportHash).toBe(Result.getOrThrow(canonicalHashV1Result(material)))
  })

  test('retains every declared execution scenario and complete zero-fill results', async () => {
    const input = await Effect.runPromise(inputEffect)
    const first = input.scenarios[0]
    if (first === undefined) throw new Error('test scenario missing')
    const report = await Effect.runPromise(
      runArchiveReplayStudy(
        { ...input, scenarios: [first, { ...first, name: 'second-stress' }] },
        archive().service,
        '2026-09-05T00:00:00.000Z',
      ),
    )
    expect(report.scenarios.map((scenario) => scenario.name)).toEqual(['stress', 'second-stress'])
    expect(report.scenarios.map((scenario) => scenario.totals.independentSessionNetPnlMicros)).toEqual(['0', '0'])
    expect(report.scenarios.every((scenario) => scenario.totals.executionSessionCount === 0)).toBe(true)
  })

  test('rejects mismatched identity and unfinished calendar before archive reads', async () => {
    const input = await Effect.runPromise(inputEffect)
    for (const [candidate, now] of [
      [{ ...input, strategyProtocolHash: '0'.repeat(64) }, '2026-09-05T00:00:00.000Z'],
      [input, '2026-09-02T15:00:00.000Z'],
    ] as const) {
      const market = archive()
      const exit = await Effect.runPromiseExit(runArchiveReplayStudy(candidate, market.service, now))
      expect(Exit.isFailure(exit)).toBe(true)
      expect(market.dates).toEqual([])
    }
  })

  test('rejects scenario selection with different dates or duplicate names', async () => {
    const input = await Effect.runPromise(inputEffect)
    const first = input.scenarios[0]
    if (first === undefined) throw new Error('test scenario missing')
    expect(Schema.is(ArchiveReplayStudyInputSchema)({ ...input, scenarios: [first, first] })).toBe(false)
    expect(
      Schema.is(ArchiveReplayStudyInputSchema)({
        ...input,
        scenarios: [first, { ...first, name: 'other', input: { ...first.input, initialCapitalMicros: '3000000000' } }],
      }),
    ).toBe(false)
  })

  test('propagates defects instead of presenting them as completed experiments', async () => {
    const input = await Effect.runPromise(inputEffect)
    const exit = await Effect.runPromiseExit(
      runArchiveReplayStudy(input, archive(undefined, true).service, '2026-09-05T00:00:00.000Z'),
    )
    expect(Exit.isFailure(exit) && Cause.hasDies(exit.cause)).toBe(true)
  })

  test('interrupts a pending archive read without starting later sessions', async () => {
    const requested: string[] = []
    let canceled = false
    await Effect.runPromise(
      Effect.gen(function* () {
        const input = yield* inputEffect
        const entered = yield* Deferred.make<void>()
        const market: IntradayMarketDataService = {
          ...archive().service,
          captureVersion: (query) =>
            Effect.gen(function* () {
              requested.push(query.sessionDate)
              yield* Deferred.succeed(entered, undefined)
              return yield* Effect.never
            }).pipe(
              Effect.onInterrupt(() =>
                Effect.sync(() => {
                  canceled = true
                }),
              ),
            ),
        }
        const fiber = yield* runArchiveReplayStudy(input, market, '2026-09-05T00:00:00.000Z').pipe(
          Effect.forkChild({ startImmediately: true }),
        )
        yield* Deferred.await(entered)
        yield* Fiber.interrupt(fiber)
      }),
    )
    expect(requested).toEqual(['2026-09-01'])
    expect(canceled).toBe(true)
  })
})
