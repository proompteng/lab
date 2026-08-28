import { describe, expect, test } from 'bun:test'

import { Result } from 'effect'

import {
  CycleState,
  makeCycleDraft,
  makeCycleExecutionPolicyFromModel,
  makeCycleIdentity,
  makeExecutionCalendarObservation,
  makeIntradayCycleWindow,
  type AutonomousCycle,
} from '../cycle'
import { canonicalHashV1, sha256 } from '../hash'
import type { IntradayMarketSnapshot } from '../market-data'
import { IntradayMomentumFailure, type IntradayMomentumTargetPortfolio } from '../strategy/intraday-momentum/model'
import { makeIntradayMomentumDefinition } from '../strategy/intraday-momentum/decision'
import {
  decodeDefaultIntradayMomentumProtocol,
  intradayMomentumExecutionModel,
} from '../strategy/intraday-momentum/protocol'
import {
  compileIntradayMomentumDecision,
  intradayMomentumCloseQuery,
  IntradayMomentumCloseAwaitingSnapshot,
  IntradayMomentumEntryAwaitingSnapshot,
  intradayMomentumEntryDisposition,
  intradayMomentumEntryQuery,
} from './intraday-momentum-decision'

const success = <A, E>(result: Result.Result<A, E>): A => Result.getOrThrow(result)
const failure = <A, E>(result: Result.Result<A, E>): E => Result.getOrThrow(Result.flip(result))
const protocol = success(decodeDefaultIntradayMomentumProtocol())

const makeActiveCycle = (openAt = '2026-08-18T13:30:00.000Z', closeAt = '2026-08-18T20:00:00.000Z') => {
  const executionCalendar = success(
    makeExecutionCalendarObservation({
      schemaVersion: 'bayn.alpaca-market-calendar-observation.v1',
      source: 'alpaca-v2-calendar',
      date: openAt.slice(0, 10),
      openAt,
      closeAt,
    }),
  )
  const executionPolicy = success(makeCycleExecutionPolicyFromModel(intradayMomentumExecutionModel))
  if (executionPolicy.schemaVersion !== 'bayn.autonomous-cycle-execution-policy.v3') {
    throw new Error('intraday-momentum fixture requires the rolling intraday execution policy')
  }
  const identity = success(
    makeCycleIdentity({
      schemaVersion: 'bayn.autonomous-cycle-identity.v3',
      strategyName: 'intraday-momentum',
      qualificationRunId: sha256('qualification'),
      strategyProtocolHash: sha256('protocol'),
      accountId: 'sandbox-account-binding',
      executionSessionDate: executionCalendar.executionSessionDate,
      executionCalendarSchemaVersion: executionCalendar.executionCalendarSchemaVersion,
      executionCalendarSource: executionCalendar.executionCalendarSource,
      executionCalendarHash: executionCalendar.executionCalendarHash,
      executionPolicy,
    }),
  )
  const window = success(makeIntradayCycleWindow(executionCalendar, executionPolicy))
  const draft = success(makeCycleDraft(identity, window))
  return {
    ...draft,
    state: CycleState.Active,
    bindings: {},
    stateVersion: 3,
    createdAt: openAt,
    updatedAt: window.submissionOpenAt,
  } satisfies AutonomousCycle
}

const calendarFor = (cycle: AutonomousCycle) => {
  const material = {
    schemaVersion: 'bayn.alpaca-market-calendar-observation.v1' as const,
    source: 'alpaca-v2-calendar' as const,
    requestedRange: {
      start: cycle.identity.executionSessionDate,
      end: cycle.identity.executionSessionDate,
    },
    timeZone: 'UTC' as const,
    sessions: [
      {
        date: cycle.identity.executionSessionDate,
        openAt: cycle.window.executionOpenAt,
        closeAt: cycle.window.executionCloseAt,
      },
    ],
  }
  return Object.freeze({ ...material, normalizedResponseHash: canonicalHashV1(material) })
}

const target = (observedAt: string, selected: boolean): IntradayMomentumTargetPortfolio => ({
  schemaVersion: 'bayn.intraday-momentum.target.v1',
  strategy: 'intraday-momentum',
  sessionDate: '2026-08-18',
  snapshotId: sha256(observedAt),
  observedAt,
  calendarHash: sha256('calendar'),
  selectedSymbols: selected ? ['AMD'] : [],
  targetWeights: { AMD: selected ? 0.1 : 0 },
  signals: [
    {
      symbol: 'AMD',
      referencePriceMicros: '100000000',
      rangeHighPriceMicros: '100000000',
      rangeLowPriceMicros: '99000000',
      bidPriceMicros: '99990000',
      askPriceMicros: '100010000',
      quoteObservedAt: observedAt,
      confirmationTradePriceMicros: '100000000',
      confirmationTradeObservedAt: observedAt,
      lookbackReturnBps: selected ? 20 : 0,
      breakoutBps: selected ? 5 : 0,
      rangeLocationPpm: selected ? 900_000 : 500_000,
      spreadBps: 2,
      eligible: selected,
      rejectionReasons: selected ? [] : ['lookback-return'],
      rank: selected ? 1 : null,
    },
  ],
})

describe('intraday-momentum runtime decision boundary', () => {
  test.each([
    ['late morning', '2026-08-18T16:00:02.000Z', '2026-08-18T15:40:00.000Z', '2026-08-18T16:00:00.000Z'],
    ['afternoon', '2026-08-18T18:30:02.000Z', '2026-08-18T18:10:00.000Z', '2026-08-18T18:30:00.000Z'],
  ])('queries the latest completed rolling window in the %s', (_, observedAt, rangeStartAt, rangeEndAt) => {
    const cycle = makeActiveCycle()
    const query = success(intradayMomentumEntryQuery(cycle, protocol, calendarFor(cycle), observedAt))

    expect(query).toMatchObject({
      sessionDate: '2026-08-18',
      rangeStartAt,
      rangeEndAt,
      observedAt,
      minimumWatermarkLagMs: 2_000,
      feed: 'iex',
      delayClass: 'real_time_exchange_only',
    })
  })

  test('rejects entry before warmup and at or after the session-relative cutoff', () => {
    const cycle = makeActiveCycle()
    const calendar = calendarFor(cycle)

    expect(failure(intradayMomentumEntryQuery(cycle, protocol, calendar, '2026-08-18T13:59:59.999Z'))).toMatchObject({
      operation: 'entry-query',
    })
    expect(
      failure(intradayMomentumEntryQuery(cycle, protocol, calendar, cycle.window.submissionCutoffAt)),
    ).toMatchObject({
      operation: 'entry-query',
    })
  })

  test('classifies the first decision-delay interval as retryable snapshot waiting', () => {
    const cycle = makeActiveCycle()
    const calendar = calendarFor(cycle)
    const availableAt = new Date(
      Date.parse(cycle.window.submissionOpenAt) + protocol.decisionDelaySeconds * 1_000,
    ).toISOString()

    expect(failure(intradayMomentumEntryQuery(cycle, protocol, calendar, cycle.window.submissionOpenAt))).toEqual(
      new IntradayMomentumEntryAwaitingSnapshot({
        message: 'full-session intraday entry is waiting for its first decision-delay-complete snapshot',
        availableAt,
      }),
    )
    expect(success(intradayMomentumEntryQuery(cycle, protocol, calendar, availableAt))).toMatchObject({
      rangeEndAt: cycle.window.submissionOpenAt,
      observedAt: availableAt,
    })
  })

  test('classifies a missing rolling baseline as retryable snapshot waiting', () => {
    const definition = {
      ...makeIntradayMomentumDefinition(protocol),
      decide: () =>
        Result.fail(
          new IntradayMomentumFailure({
            reason: 'snapshot-coverage',
            message: 'intraday symbol lacks the complete rolling lookback baseline',
            symbol: 'AMD',
          }),
        ),
    }

    expect(
      failure(compileIntradayMomentumDecision(definition, makeActiveCycle(), {} as IntradayMarketSnapshot)),
    ).toEqual(
      new IntradayMomentumEntryAwaitingSnapshot({
        message: 'intraday symbol lacks the complete rolling lookback baseline',
      }),
    )
  })

  test('derives the rolling cutoff from an early-close session instead of a fixed clock', () => {
    const cycle = makeActiveCycle('2026-08-18T13:30:00.000Z', '2026-08-18T17:00:00.000Z')
    const calendar = calendarFor(cycle)

    expect(cycle.window.submissionCutoffAt).toBe('2026-08-18T16:00:00.000Z')
    expect(success(intradayMomentumEntryQuery(cycle, protocol, calendar, '2026-08-18T15:40:02.000Z'))).toMatchObject({
      rangeStartAt: '2026-08-18T15:20:00.000Z',
      rangeEndAt: '2026-08-18T15:40:00.000Z',
    })
    expect(failure(intradayMomentumEntryQuery(cycle, protocol, calendar, '2026-08-18T16:00:00.000Z'))).toMatchObject({
      operation: 'entry-query',
    })
  })

  test('uses only a completed minute for close pricing', () => {
    const cycle = makeActiveCycle()
    const calendar = calendarFor(cycle)

    expect(
      success(intradayMomentumCloseQuery(cycle, protocol, calendar, '2026-08-18T19:30:01.000Z', ['AMD'])),
    ).toMatchObject({
      rangeStartAt: '2026-08-18T19:29:00.000Z',
      rangeEndAt: '2026-08-18T19:30:00.000Z',
      minimumWatermarkLagMs: 0,
      universe: protocol.universe,
      universeSymbolHash: protocol.universeSymbolHash,
      symbols: ['AMD'],
      purpose: 'LIQUIDATION',
    })
    expect(failure(intradayMomentumCloseQuery(cycle, protocol, calendar, '2026-08-18T19:30:00.000Z', ['AMD']))).toEqual(
      new IntradayMomentumCloseAwaitingSnapshot({
        message: 'intraday close is waiting for the current minute to become complete',
      }),
    )
  })

  test('keeps an empty signal armed until finalization headroom, then terminalizes honestly', () => {
    const cutoffAt = '2026-08-18T19:00:00.000Z'

    expect(intradayMomentumEntryDisposition(target('2026-08-18T18:00:00.000Z', false), cutoffAt, 60_000)).toBe(
      'AWAIT_SIGNAL',
    )
    expect(intradayMomentumEntryDisposition(target('2026-08-18T18:59:30.000Z', false), cutoffAt, 60_000)).toBe(
      'NO_TRADE',
    )
    expect(intradayMomentumEntryDisposition(target('2026-08-18T18:59:30.000Z', true), cutoffAt, 60_000)).toBe('EXECUTE')
  })
})
