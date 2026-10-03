import { describe, expect, test } from 'bun:test'
import { Clock, Effect, Option, Result } from 'effect'
import { TestClock } from 'effect/testing'

import { BrokerRead, type BrokerReadShape } from '../broker/alpaca'
import { CycleState, decodeAutonomousCycle } from '../cycle'
import { Authority, KillState, OrderType } from '../execution/contracts'
import { JevBatchStore } from '../jev/batch-evaluation'
import { JevClient } from '../jev/client'
import { JevEvaluationStore } from '../jev/evaluation'
import { nativeJevBatchResult, nativeJevFixture } from '../jev/native.test-support'
import { JevPositionStore, JevPurpose } from '../jev/portfolio'
import { type IntradayMarketDataService, MarketData } from '../market-data'
import { IntradaySnapshotFailure } from '../market-data/intraday/model'
import { retryableOperationalError } from '../errors'
import { reconciledStateHash } from '../reconciliation'
import { type ReconciliationPassResult } from '../reconciler'
import { loadStrategyExecutionRiskPolicy } from '../observe-composition'
import { makeIntradayMomentumTestSnapshot } from '../strategy/intraday-momentum/test-support'
import { fixtureRuntime } from '../testing/runtime-fixtures'
import { fixtureStreamingReference, streamingFixtureFromRaw } from '../testing/streaming-market-fixture'
import { currentUtcInstant } from '../time'
import { CandidateObservationStore } from './candidate-observation'
import { checkAdvancedMarketProjection, closeQuoteContinuationDelayMs } from './recovery-driver'
import { advanceExecutionOnce } from '../execution/advance'
import { ExecutionControllerOutcome } from '../execution/controller-status'
import {
  completeExecutionControllerTick,
  decodeExecutionControllerState,
  decideExecutionControllerActivation,
  decideExecutionControllerTick,
} from '../execution/controller'
import {
  buildMutationShadowCycleDecision,
  ExecutionCloseAwaitingMarketData,
  executionCloseMarketDataDiagnostics,
  prepareClosingExecutionCycleDecision,
} from './decision-builder'
import { prepareObserveStartup } from './startup'

const generationHash = 'b'.repeat(64)
const native = nativeJevFixture()
const accountId = native.portfolio.brokerState.account.accountId
const at = native.query.observedAt
const activeCycle = Effect.runSync(
  decodeAutonomousCycle({
    ...native.draft,
    state: CycleState.Active,
    bindings: {},
    stateVersion: 1,
    createdAt: at,
    updatedAt: at,
  }),
)

const factsAt = (observedAt: string, held = false): ReconciliationPassResult => {
  const source = held ? nativeJevFixture(JevPurpose.Manage).portfolio.brokerState : native.portfolio.brokerState
  const state = {
    ...source,
    account: { ...source.account, observedAt },
    positions: source.positions.map((position) => ({ ...position, observedAt })),
    positionsObservedAt: observedAt,
    orders: source.orders.map((order) => ({ ...order, observedAt })),
    ordersObservedAt: observedAt,
  }
  const hash = Result.getOrThrow(reconciledStateHash(state))
  const reconciliation = { ...source.reconciliation, reconciledAt: observedAt, expectedHash: hash, observedHash: hash }
  return {
    report: {
      reconciliation,
      metrics: {
        brokerPollAgeMs: 0,
        oldestUnknownMutationAgeMs: 0,
        cashDifferenceMicros: '0',
        positionDifferenceMicros: '0',
        equityDifferenceMicros: '0',
        accountingExact: true,
        discrepancyCount: 0,
      },
    },
    brokerState: { ...state, reconciliation },
    riskContext: {
      tradingDate: native.query.sessionDate,
      authority: {
        schemaVersion: 'bayn.paper-authority.v1',
        generationHash,
        maximum: Authority.Execution,
        effective: Authority.Execution,
        kill: KillState.Clear,
        version: 1,
        updatedAt: observedAt,
      },
      authorityObservedAt: observedAt,
      unknownMutationCount: 0,
      dailyTradedNotionalMicros: '0',
      dayStartEquityMicros: state.account.equityMicros,
      peakEquityMicros: state.account.equityMicros,
    },
  }
}

const unavailable = new IntradaySnapshotFailure({
  reason: 'not-ready',
  message: 'Fixture quote partition has not caught up',
  facts: { symbol: 'AAPL' },
})
const marketFailure = retryableOperationalError({
  component: 'market-data',
  operation: 'snapshot',
  message: 'Fixture archive cut unavailable',
  cause: unavailable,
})
const freshMarket: IntradayMarketDataService = {
  check: Effect.void,
  loadSnapshot: (query) =>
    Effect.sync(
      () =>
        streamingFixtureFromRaw(
          makeIntradayMomentumTestSnapshot(native.protocol, { ...query, archiveWatermarks: [] }, { AAPL: 0.02 }, 10),
          query,
        ).snapshot,
    ),
  verifyReference: fixtureStreamingReference,
}

const fixture = async () => {
  const input = {
    accountId,
    authorityGenerationHash: generationHash,
    pollIntervalMs: 30_000,
    reconciliationIntervalMs: 30_000,
    reconciliationPassTimeoutMs: 30_000,
    strategy: fixtureRuntime,
    intradayMarketData: freshMarket,
  }
  const preparation = Result.getOrThrow(prepareObserveStartup(input))
  const policy = await Effect.runPromise(loadStrategyExecutionRiskPolicy(accountId, fixtureRuntime))
  const unused = Effect.die(new Error('Unexpected fixture I/O'))
  const broker: BrokerReadShape = {
    account: unused,
    accountConfiguration: unused,
    assetBySymbol: () => unused,
    positions: unused,
    orders: () => unused,
    orderById: () => unused,
    orderByClientId: () => unused,
    feeActivities: () => unused,
    fillActivities: () => unused,
    marketCalendar: () =>
      Effect.succeed({
        value: native.query.calendar,
        evidence: {
          requestId: 'fixture',
          status: 200,
          contentHash: 'f'.repeat(64),
          observedAt: at,
        },
      }),
  }
  const document = await Effect.runPromise(
    Effect.gen(function* () {
      yield* TestClock.setTime(Date.parse(at))
      return yield* buildMutationShadowCycleDecision({
        authorityGenerationHash: generationHash,
        cycle: activeCycle,
        executionModel: preparation.executionModel,
        policy,
        reconcile: Effect.succeed(factsAt(at)),
        strategy: fixtureRuntime,
        intradayMarketData: freshMarket,
      })
    }).pipe(
      Effect.provideService(BrokerRead, broker),
      Effect.provideService(MarketData, {
        check: unused,
        load: unused,
        inspect: unused,
        inspectCyclePublications: unused,
        inspectPublication: () => unused,
        inspectSnapshotPublication: () => unused,
        loadSnapshotPublication: () => unused,
      }),
      Effect.provideService(CandidateObservationStore, {
        record: () => Effect.void,
        latestJevWindowEnd: () => Effect.succeed(Option.none()),
      }),
      Effect.provideService(JevBatchStore, {
        read: () => unused,
        pending: () => Effect.succeed([]),
        begin: (plan) =>
          Clock.currentTimeMillis.pipe(
            Effect.map((now) => ({
              plan,
              result: nativeJevBatchResult(plan, new Date(now).toISOString(), (symbol) =>
                symbol === 'AAPL' ? 'enter' : 'wait',
              ),
            })),
          ),
        finish: () => unused,
      }),
      Effect.provideService(JevEvaluationStore, {
        read: () => unused,
        begin: () => unused,
        record: () => unused,
        abandon: () => unused,
      }),
      Effect.provideService(JevClient, { evaluate: () => unused }),
      Effect.provideService(JevPositionStore, { read: () => unused }),
      Effect.provide(TestClock.layer()),
    ),
  )
  return {
    input,
    preparation,
    policy,
    entryDocument: document,
    cycle: Effect.runSync(
      decodeAutonomousCycle({
        ...activeCycle,
        bindings: { snapshotId: document.bindings.snapshotId, decisionHash: document.contentHash },
        stateVersion: 2,
        updatedAt: document.createdAt,
      }),
    ),
    closeExpiresAt: activeCycle.window.executionCloseAt,
  }
}

describe('closing market-data fallback boundaries', () => {
  test.each([undefined, 5_000])(
    'a failed post-pass projection check owns its retry delay (%s)',
    async (failureDelay) => {
      const result = {
        outcome: 'RECOVERED',
        action: 'WAITING',
        waitReason: 'CLOSE_QUOTE_PENDING',
        observedAt: at,
        cycle: activeCycle,
      } as const
      const advanced = {
        result,
        observation: {
          result: 'SUCCESS',
          outcome: 'RECOVERED',
          recoveryAction: 'WAITING',
          waitReason: 'CLOSE_QUOTE_PENDING',
          observedAt: at,
        } as const,
        nextDelayMs: 1_000,
      }
      let checks = 0
      const checked = checkAdvancedMarketProjection(
        advanced,
        Effect.sync(() => {
          checks += 1
        }).pipe(Effect.andThen(Effect.fail(marketFailure))),
        (error) => {
          expect(error.cause).toBe(marketFailure)
          return Effect.succeed({
            observation: {
              result: 'FAILURE',
              observedAt: at,
              operation: error.operation,
              failure: error.failure,
              message: error.message,
            },
            ...(failureDelay === undefined ? {} : { nextDelayMs: failureDelay }),
          })
        },
      )
      const outcome = await Effect.runPromise(
        advanceExecutionOnce(
          {
            controllerKey: 'a'.repeat(64),
            epoch: 1,
            sequence: 0,
            issuedAt: at,
            sourceRevision: 'd'.repeat(40),
          },
          { advance: checked, nextDelayMs: 30_000 },
        ),
      )
      expect(checks).toBe(1)
      expect(outcome).toMatchObject({
        _tag: 'Blocked',
        nextDelayMs: failureDelay ?? 30_000,
        observation: { result: 'FAILURE', failure: 'market-data' },
      })
    },
  )

  test('successful projection validation preserves the completed pass', async () => {
    const advanced = {
      observation: {
        result: 'SUCCESS',
        outcome: 'RECOVERED',
        recoveryAction: 'WAITING',
        waitReason: 'CLOSE_QUOTE_PENDING',
        observedAt: at,
      } as const,
      nextDelayMs: 1_000,
    }
    expect(
      await Effect.runPromise(
        checkAdvancedMarketProjection(advanced, Effect.void, () =>
          Effect.die(new Error('successful health check cannot report a failure')),
        ),
      ),
    ).toBe(advanced)
  })

  test('quote scheduling uses completion time and the remaining session budget', async () => {
    const waiting = {
      outcome: 'RECOVERED',
      action: 'WAITING',
      waitReason: 'CLOSE_QUOTE_PENDING',
      observedAt: at,
      cycle: activeCycle,
    } as const
    const close = Date.parse(activeCycle.window.executionCloseAt)
    expect(closeQuoteContinuationDelayMs(waiting, 30_000, new Date(close - 750).toISOString())).toBe(750)
    expect(closeQuoteContinuationDelayMs(waiting, 30_000, new Date(close + 1).toISOString())).toBeUndefined()
    expect(
      closeQuoteContinuationDelayMs(
        {
          outcome: 'RECOVERED',
          action: 'COMPLETED',
          observedAt: at,
          cycle: activeCycle,
        },
        30_000,
        at,
      ),
    ).toBeUndefined()
    await Effect.runPromise(
      Effect.gen(function* () {
        yield* TestClock.setTime(close - 1)
        yield* checkAdvancedMarketProjection(
          {
            result: waiting,
            observation: { result: 'SUCCESS', outcome: 'RECOVERED', observedAt: at },
          },
          TestClock.setTime(close),
          () => Effect.die(new Error('unexpected failure')),
        )
        expect(closeQuoteContinuationDelayMs(waiting, 30_000, yield* currentUtcInstant)).toBeUndefined()
      }).pipe(Effect.provide(TestClock.layer())),
    )
  })

  test('a short durable continuation catches a delayed quote that expires during the ordinary idle interval', async () => {
    const request = await fixture()
    const start = Date.parse(at) + 16 * 60_000 + 24_000
    const quoteEventAt = new Date(start + 3_100).toISOString()
    const quoteAvailableAt = start + 8_800
    const loadSnapshot: IntradayMarketDataService['loadSnapshot'] = (query) =>
      Effect.try({
        try: () => {
          const raw = makeIntradayMomentumTestSnapshot(
            native.protocol,
            { ...query, archiveWatermarks: [] },
            { AAPL: 0.02 },
            10,
          )
          const eventAt =
            Date.parse(query.observedAt) >= quoteAvailableAt ? quoteEventAt : new Date(start - 16_000).toISOString()
          return streamingFixtureFromRaw(
            {
              ...raw,
              quotes: raw.quotes.map((quote) => ({
                ...quote,
                eventAt,
                ingestedAt: new Date(Date.parse(eventAt) + 5_700).toISOString(),
              })),
            },
            query,
          ).snapshot
        },
        catch: (cause) =>
          retryableOperationalError({
            component: 'market-data',
            operation: 'snapshot',
            message: 'Fixture quote cut unavailable',
            cause,
          }),
      })
    const reconcile = Effect.gen(function* () {
      yield* TestClock.adjust(3_000)
      return factsAt(yield* currentUtcInstant, true)
    })
    await Effect.runPromise(
      Effect.gen(function* () {
        yield* TestClock.setTime(start)
        const close = prepareClosingExecutionCycleDecision({
          ...request,
          input: { ...request.input, intradayMarketData: { ...freshMarket, loadSnapshot } },
          reconcile,
        })
        const first = yield* Effect.flip(close)
        expect(first).toMatchObject({ quotePending: true, readiness: { reason: 'SNAPSHOT_STALE', symbol: 'AAPL' } })
        const result = {
          outcome: 'RECOVERED',
          action: 'WAITING',
          waitReason: 'CLOSE_QUOTE_PENDING',
          observedAt: first instanceof ExecutionCloseAwaitingMarketData ? first.observedAt : '',
          cycle: request.cycle,
        } as const
        const nextDelayMs = closeQuoteContinuationDelayMs(result, 30_000, yield* currentUtcInstant)
        expect(nextDelayMs).toBe(1_000)
        const command = {
          controllerKey: 'a'.repeat(64),
          epoch: 1,
          sequence: 0,
          issuedAt: result.observedAt,
          sourceRevision: 'd'.repeat(40),
        }
        const outcome = yield* advanceExecutionOnce(command, {
          advance: Effect.succeed({
            result,
            observation: {
              result: 'SUCCESS',
              outcome: 'RECOVERED',
              recoveryAction: 'WAITING',
              observedAt: result.observedAt,
              waitReason: 'CLOSE_QUOTE_PENDING',
            },
            ...(nextDelayMs === undefined ? {} : { nextDelayMs }),
          }),
          nextDelayMs: 30_000,
        })
        const activated = Result.getOrThrow(
          decideExecutionControllerActivation(null, {
            schemaVersion: 'bayn.execution-controller-activation.v1',
            controllerKey: command.controllerKey,
            epoch: 1,
            firstSequence: 0,
            planHash: 'b'.repeat(64),
            sourceRevision: command.sourceRevision,
          }),
        ).state
        expect(outcome._tag).toBe('Waiting')
        const completed = Result.getOrThrow(
          completeExecutionControllerTick(
            activated,
            { schemaVersion: 'bayn.execution-controller-tick.v1', epoch: 1, sequence: 0 },
            {
              completedAt: result.observedAt,
              outcome: {
                _tag: ExecutionControllerOutcome.Waiting,
                receiptHash: outcome.receiptHash,
                nextDelayMs: outcome.nextDelayMs,
              },
            },
            command.sourceRevision,
          ),
        )
        const restarted = Result.getOrThrow(decodeExecutionControllerState(JSON.parse(JSON.stringify(completed))))
        expect(restarted.nextDueAt).toBe(new Date(start + 4_000).toISOString())
        expect(
          Result.getOrThrow(
            decideExecutionControllerTick(
              restarted,
              { schemaVersion: 'bayn.execution-controller-tick.v1', epoch: 1, sequence: 0 },
              command.controllerKey,
              restarted.nextDueAt ?? '',
              command.sourceRevision,
            ),
          )._tag,
        ).toBe('Ignored')
        yield* TestClock.adjust(nextDelayMs ?? 30_000)
        expect(yield* Effect.flip(close)).toMatchObject({ quotePending: true })
        yield* TestClock.adjust(nextDelayMs ?? 30_000)
        const ready = yield* close
        expect(ready.document.dispatchable).toBe(true)
        expect(ready.document.targetPlan.intentTargets.every((target) => target.orderType === OrderType.Limit)).toBe(
          true,
        )
        expect(Date.parse(yield* currentUtcInstant) - Date.parse(quoteEventAt)).toBe(7_900)

        yield* TestClock.setTime(start + 3_000 + 30_000)
        const missed = yield* Effect.flip(close)
        expect(missed).toBeInstanceOf(ExecutionCloseAwaitingMarketData)
      }).pipe(Effect.provide(TestClock.layer())),
    )
  })

  test('only quote-pending closes before the session deadline use a bounded continuation', () => {
    const waiting = {
      outcome: 'RECOVERED',
      action: 'WAITING',
      waitReason: 'CLOSE_QUOTE_PENDING',
      observedAt: at,
      cycle: activeCycle,
    } as const
    expect(closeQuoteContinuationDelayMs(waiting, 500, at)).toBe(500)
    expect(
      closeQuoteContinuationDelayMs({ ...waiting, waitReason: 'CLOSE_MARKET_DATA_UNAVAILABLE' }, 30_000, at),
    ).toBeUndefined()
    expect(closeQuoteContinuationDelayMs({ ...waiting, waitReason: 'JEV_POSITION_HELD' }, 30_000, at)).toBeUndefined()
    expect(closeQuoteContinuationDelayMs(waiting, 30_000, activeCycle.window.executionCloseAt)).toBeUndefined()
  })

  test('an unavailable intraday cut preserves its cause without a second reconciliation', async () => {
    const request = await fixture()
    let reads = 0
    const failure = await Effect.runPromise(
      Effect.gen(function* () {
        yield* TestClock.setTime(Date.parse(at) + 60_000)
        return yield* Effect.flip(
          prepareClosingExecutionCycleDecision({
            ...request,
            input: {
              ...request.input,
              intradayMarketData: { ...freshMarket, loadSnapshot: () => Effect.fail(marketFailure) },
            },
            reconcile: currentUtcInstant.pipe(
              Effect.map((now) => {
                reads += 1
                return factsAt(now, true)
              }),
            ),
          }),
        )
      }).pipe(Effect.provide(TestClock.layer())),
    )
    expect(reads).toBe(1)
    expect(failure).toBeInstanceOf(ExecutionCloseAwaitingMarketData)
    expect(failure.cause).toBe(marketFailure)
    if (!(failure instanceof ExecutionCloseAwaitingMarketData)) throw new Error('Expected a close wait')
    expect(executionCloseMarketDataDiagnostics(failure)).toMatchObject({
      component: 'market-data',
      operation: 'snapshot',
      snapshotFailure: 'not-ready',
    })
    expect(failure).toMatchObject({
      message: marketFailure.message,
      readiness: { reason: 'SNAPSHOT_UNAVAILABLE', message: unavailable.message, symbol: 'AAPL' },
    })
  })

  test.each([0, -1])('fallback is allowed when the archive finishes at the window boundary (%ims)', async (offset) => {
    const request = await fixture()
    let reads = 0
    const start = Date.parse(request.cycle.window.executionCloseAt) - native.protocol.flattenBeforeCloseMinutes * 60_000
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        yield* TestClock.setTime(start + offset)
        return yield* prepareClosingExecutionCycleDecision({
          ...request,
          input: {
            ...request.input,
            intradayMarketData: {
              ...freshMarket,
              loadSnapshot: () => TestClock.setTime(start).pipe(Effect.andThen(Effect.fail(marketFailure))),
            },
          },
          reconcile: currentUtcInstant.pipe(
            Effect.map((now) => {
              reads += 1
              return factsAt(now, true)
            }),
          ),
        })
      }).pipe(Effect.provide(TestClock.layer())),
    )
    expect(reads).toBe(2)
    expect(result.document.bindings.executionMarketData?.schemaVersion).toBe(
      'bayn.reconciled-position-liquidation-binding.v1',
    )
    expect(result.document.targetPlan.intentTargets.every((target) => target.orderType === OrderType.Market)).toBe(true)
  })

  test('the second boundary check still refuses a fallback that expires during reconciliation', async () => {
    const request = await fixture()
    let reads = 0
    const close = Date.parse(request.closeExpiresAt)
    const failure = await Effect.runPromise(
      Effect.gen(function* () {
        yield* TestClock.setTime(close - 1)
        return yield* Effect.flip(
          prepareClosingExecutionCycleDecision({
            ...request,
            input: {
              ...request.input,
              intradayMarketData: { ...freshMarket, loadSnapshot: () => Effect.fail(marketFailure) },
            },
            reconcile: Effect.gen(function* () {
              reads += 1
              if (reads === 2) yield* TestClock.setTime(close)
              return factsAt(yield* currentUtcInstant, true)
            }),
          }),
        )
      }).pipe(Effect.provide(TestClock.layer())),
    )
    expect(reads).toBe(2)
    expect(failure).toBeInstanceOf(ExecutionCloseAwaitingMarketData)
    expect(failure.message).toBe(marketFailure.message)
  })
})
