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
import { IntradaySnapshotPurpose, type IntradayMarketSnapshot } from '../market-data'
import type { ArchiveVerifiedIntradayMarketSnapshot } from '../market-data/intraday/model'
import { IntradayMomentumFailure, type IntradayMomentumTargetPortfolio } from '../strategy/intraday-momentum/model'
import { makeIntradayMomentumDefinition } from '../strategy/intraday-momentum/decision'
import {
  decodeDefaultIntradayMomentumProtocol,
  intradayMomentumExecutionModel,
} from '../strategy/intraday-momentum/protocol'
import {
  evaluateIntradayMomentumDecision,
  intradayMomentumCloseQuery,
  IntradayMomentumCloseAwaitingSnapshot,
  IntradayMomentumEntryAwaitingSnapshot,
  intradayMomentumEntryDisposition,
  intradayMomentumEntryQuery,
  intradayMomentumPricingQuery,
} from './intraday-momentum-decision'
import { maximumBuyQuantities } from './intraday-market-data'

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
  schemaVersion: 'bayn.intraday-momentum.target.v2',
  strategy: 'intraday-momentum',
  sessionDate: '2026-08-18',
  snapshotId: sha256(observedAt),
  observedAt,
  calendarHash: sha256('calendar'),
  benchmark: {
    symbol: 'SPY',
    referencePriceMicros: '100000000',
    bidPriceMicros: '100040000',
    askPriceMicros: '100060000',
    bidSizeMicros: '1000000',
    askSizeMicros: '1000000',
    quoteObservedAt: observedAt,
  },
  selectedSymbols: selected ? ['AAPL'] : [],
  targetWeights: { AAPL: selected ? 0.1 : 0 },
  signals: [
    {
      symbol: 'AAPL',
      referencePriceMicros: '100000000',
      rangeHighPriceMicros: '100000000',
      rangeLowPriceMicros: '99000000',
      bidPriceMicros: '99990000',
      askPriceMicros: '100010000',
      bidSizeMicros: '1000000',
      askSizeMicros: '1000000',
      quoteObservedAt: observedAt,
      confirmationTradePriceMicros: '100000000',
      confirmationTradeObservedAt: observedAt,
      excessReturnNumerator: selected ? '15' : '-5',
      excessReturnDenominator: '10000',
      lookbackReturnBps: selected ? 20 : 0,
      benchmarkReturnBps: 5,
      excessReturnBps: selected ? 15 : -5,
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
    ['late morning', '2026-08-18T16:00:02.000Z', '2026-08-18T15:30:00.000Z', '2026-08-18T16:00:00.000Z'],
    ['afternoon', '2026-08-18T18:30:02.000Z', '2026-08-18T18:00:00.000Z', '2026-08-18T18:30:00.000Z'],
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
      symbols: ['AAPL', 'AMZN', 'IWM', 'NVDA', 'QQQ', 'SMH', 'SPY'],
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
      failure(
        evaluateIntradayMomentumDecision(
          definition,
          makeActiveCycle(),
          {} as unknown as ArchiveVerifiedIntradayMarketSnapshot,
        ),
      ),
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
      rangeStartAt: '2026-08-18T15:10:00.000Z',
      rangeEndAt: '2026-08-18T15:40:00.000Z',
    })
    expect(failure(intradayMomentumEntryQuery(cycle, protocol, calendar, '2026-08-18T16:00:00.000Z'))).toMatchObject({
      operation: 'entry-query',
    })
  })

  test('keeps held-only pricing out of candidate signal evidence', () => {
    const cycle = makeActiveCycle()
    const calendar = calendarFor(cycle)
    const entryQuery = success(intradayMomentumEntryQuery(cycle, protocol, calendar, '2026-08-18T16:00:02.000Z'))
    const pricingQuery = success(
      intradayMomentumPricingQuery(cycle, protocol, calendar, '2026-08-18T16:00:02.000Z', entryQuery.rangeEndAt, [
        'AVGO',
        'AMD',
        'AMD',
      ]),
    )

    expect(entryQuery.symbols).toEqual(['AAPL', 'AMZN', 'IWM', 'NVDA', 'QQQ', 'SMH', 'SPY'])
    expect(pricingQuery).toMatchObject({
      symbols: ['AMD', 'AVGO'],
      purpose: IntradaySnapshotPurpose.EntryPricing,
    })
    expect(
      failure(
        intradayMomentumPricingQuery(cycle, protocol, calendar, '2026-08-18T16:00:02.000Z', entryQuery.rangeEndAt, [
          'OUTSIDE',
        ]),
      ),
    ).toMatchObject({ operation: 'entry-query', message: 'existing position is outside the strategy source universe' })
  })

  test('keeps fresh decision-window quotes valid across a controller minute boundary', () => {
    const cycle = makeActiveCycle()
    const calendar = calendarFor(cycle)
    const observedAt = '2026-08-18T16:00:01.500Z'
    const decisionQuery = success(intradayMomentumEntryQuery(cycle, protocol, calendar, observedAt))
    const pricingQuery = success(
      intradayMomentumPricingQuery(cycle, protocol, calendar, observedAt, decisionQuery.rangeEndAt, ['AAPL']),
    )

    expect(decisionQuery.rangeEndAt).toBe('2026-08-18T15:59:00.000Z')
    expect(pricingQuery).toMatchObject({
      rangeStartAt: '2026-08-18T15:58:00.000Z',
      rangeEndAt: decisionQuery.rangeEndAt,
      observedAt,
      symbols: ['AAPL'],
      purpose: IntradaySnapshotPurpose.EntryPricing,
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
      purpose: IntradaySnapshotPurpose.Liquidation,
    })
    expect(failure(intradayMomentumCloseQuery(cycle, protocol, calendar, '2026-08-18T19:30:00.000Z', ['AMD']))).toEqual(
      new IntradayMomentumCloseAwaitingSnapshot({
        message: 'intraday close is waiting for the current minute to become complete',
      }),
    )
  })

  test('keeps an empty signal armed until finalization headroom, then terminalizes honestly', () => {
    const cutoffAt = '2026-08-18T19:00:00.000Z'

    expect(intradayMomentumEntryDisposition(target('2026-08-18T18:00:00.000Z', false), false, cutoffAt, 60_000)).toBe(
      'AWAIT_SIGNAL',
    )
    expect(intradayMomentumEntryDisposition(target('2026-08-18T18:59:30.000Z', false), false, cutoffAt, 60_000)).toBe(
      'NO_TRADE',
    )
    expect(intradayMomentumEntryDisposition(target('2026-08-18T18:59:30.000Z', true), false, cutoffAt, 60_000)).toBe(
      'EXECUTE',
    )
    expect(intradayMomentumEntryDisposition(target('2026-08-18T18:00:00.000Z', false), true, cutoffAt, 60_000)).toBe(
      'EXECUTE',
    )
  })

  test('records zero buy capacity when the displayed ask cannot fill one whole-share IOC order', () => {
    const cycle = makeActiveCycle()
    const observedAt = '2026-08-18T16:00:02.000Z'
    const quote = {
      provider: 'alpaca' as const,
      universeId: protocol.universeId,
      universeSymbolHash: protocol.universeSymbolHash,
      feed: protocol.feed,
      marketSession: 'regular' as const,
      delayClass: protocol.delayClass,
      symbol: 'AAPL',
      eventAt: observedAt,
      ingestedAt: observedAt,
      sourceTopic: protocol.sourceTopics.quotes,
      sourcePartition: 0,
      sourceOffset: '1',
      schemaVersion: 1 as const,
      bidPrice: 100,
      bidSize: 1,
      askPrice: 100.01,
      askSize: 0.75,
    }
    const snapshot: IntradayMarketSnapshot = {
      bars: [],
      quotes: [quote],
      trades: [],
      latestQuotes: { AAPL: quote },
      manifest: {
        schemaVersion: 'bayn.intraday-market-snapshot.v1',
        sessionDate: cycle.identity.executionSessionDate,
        calendar: calendarFor(cycle),
        rangeStartAt: '2026-08-18T15:30:00.000Z',
        rangeEndAt: '2026-08-18T16:00:00.000Z',
        observedAt,
        universeId: protocol.universeId,
        universeSymbolHash: protocol.universeSymbolHash,
        universe: protocol.universe,
        symbols: ['AAPL'],
        purpose: IntradaySnapshotPurpose.EntryPricing,
        feed: protocol.feed,
        delayClass: protocol.delayClass,
        sourceTopics: protocol.sourceTopics,
        archiveWatermarks: [],
        maximumQuoteAgeMs: protocol.maximumQuoteAgeMs,
        minimumWatermarkLagMs: 2_000,
        barCount: 0,
        quoteCount: 1,
        tradeCount: 0,
        barsContentHash: sha256('bars'),
        quotesContentHash: sha256('quotes'),
        tradesContentHash: sha256('trades'),
        lineage: [],
        contentHash: sha256('snapshot-content'),
        snapshotId: sha256('snapshot'),
      },
    }

    expect(success(maximumBuyQuantities(snapshot, { AAPL: 0.1 }))).toEqual({ AAPL: '0' })
  })
})
