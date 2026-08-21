import { describe, expect, test } from 'bun:test'

import { Effect, Result } from 'effect'

import {
  CycleState,
  makeCycleDraft,
  makeCycleExecutionPolicyFromModel,
  makeCycleIdentity,
  makeCycleWindow,
  makeIntradayCycleWindow,
  makeExecutionCalendarObservation,
  type AutonomousCycle,
} from '../cycle'
import { canonicalHashV1, sha256 } from '../hash'
import {
  verifyIntradaySnapshot,
  type IntradayMarketDataService,
  type IntradaySnapshotRequest,
  type IntradaySnapshotRows,
} from '../market-data'
import {
  decodeDefaultOpeningDriveProtocol,
  makeOpeningDriveDefinition,
  type OpeningDriveRejectionReason,
  type OpeningDriveStrategyDefinition,
  type OpeningDriveTargetPortfolio,
  openingDriveExecutionModel,
  type OpeningDriveProtocol,
} from '../strategy/opening-drive'
import {
  closeBidPrices,
  compileOpeningDriveDecision,
  executionMarketDataBinding,
  loadIntradaySnapshot,
  openingDriveCloseQuery,
  openingDriveEntryDisposition,
  openingDriveEntryQuery,
  requireFreshOpeningDrivePositionQuotes,
} from './opening-drive-decision'

const success = <A, E>(result: Result.Result<A, E>): A => Result.getOrThrow(result)
const failure = <A, E>(result: Result.Result<A, E>): E => Result.getOrThrow(Result.flip(result))
const hash = (value: string): string => sha256(value)

const protocol: OpeningDriveProtocol = success(decodeDefaultOpeningDriveProtocol())
const calendarMaterial = {
  schemaVersion: 'bayn.alpaca-market-calendar-observation.v1' as const,
  source: 'alpaca-v2-calendar' as const,
  requestedRange: { start: '2026-08-17', end: '2026-08-18' },
  timeZone: 'UTC' as const,
  sessions: [{ date: '2026-08-18', openAt: '2026-08-18T13:30:00.000Z', closeAt: '2026-08-18T20:00:00.000Z' }],
} as const
const calendar = Object.freeze({
  ...calendarMaterial,
  normalizedResponseHash: canonicalHashV1(calendarMaterial),
})

const makeActiveCycle = (): AutonomousCycle => {
  const executionCalendar = success(
    makeExecutionCalendarObservation({
      schemaVersion: calendar.schemaVersion,
      source: calendar.source,
      ...calendar.sessions[0]!,
    }),
  )
  const executionPolicy = success(makeCycleExecutionPolicyFromModel(openingDriveExecutionModel))
  if (executionPolicy.schemaVersion !== 'bayn.autonomous-cycle-execution-policy.v2') {
    throw new Error('opening-drive fixture requires the post-open execution policy')
  }
  const identity = success(
    makeCycleIdentity({
      schemaVersion: 'bayn.autonomous-cycle-identity.v3',
      strategyName: 'opening-drive-momentum',
      qualificationRunId: hash('qualification'),
      strategyProtocolHash: hash('protocol'),
      accountId: 'sandbox-account-binding',
      executionSessionDate: executionCalendar.executionSessionDate,
      executionCalendarSchemaVersion: executionCalendar.executionCalendarSchemaVersion,
      executionCalendarSource: executionCalendar.executionCalendarSource,
      executionCalendarHash: executionCalendar.executionCalendarHash,
      executionPolicy,
    }),
  )
  const window = success(makeIntradayCycleWindow(executionCalendar, executionPolicy))
  return {
    ...success(makeCycleDraft(identity, window)),
    state: CycleState.Active,
    bindings: {},
    stateVersion: 3,
    createdAt: '2026-08-17T20:00:00.000Z',
    updatedAt: window.submissionOpenAt,
  }
}

const makeHistoricalActiveCycle = (): AutonomousCycle => {
  const executionCalendar = success(
    makeExecutionCalendarObservation({
      schemaVersion: calendar.schemaVersion,
      source: calendar.source,
      ...calendar.sessions[0]!,
    }),
  )
  const executionPolicy = success(makeCycleExecutionPolicyFromModel(openingDriveExecutionModel))
  if (executionPolicy.schemaVersion !== 'bayn.autonomous-cycle-execution-policy.v2') {
    throw new Error('opening-drive fixture requires the post-open execution policy')
  }
  const identity = success(
    makeCycleIdentity({
      schemaVersion: 'bayn.autonomous-cycle-identity.v2',
      strategyName: 'opening-drive-momentum',
      qualificationRunId: hash('qualification'),
      strategyProtocolHash: hash('protocol'),
      accountId: 'sandbox-account-binding',
      signalSessionDate: '2026-08-17',
      signalCalendarVersion: 'signal-calendar-v1',
      executionSessionDate: executionCalendar.executionSessionDate,
      executionCalendarSchemaVersion: executionCalendar.executionCalendarSchemaVersion,
      executionCalendarSource: executionCalendar.executionCalendarSource,
      executionCalendarHash: executionCalendar.executionCalendarHash,
      executionPolicy,
    }),
  )
  const window = success(
    makeCycleWindow(
      {
        calendar_version: 'signal-calendar-v1',
        session_date: '2026-08-17',
        close_time: '16:00',
        timezone: 'America/New_York',
      },
      executionCalendar,
      executionPolicy,
    ),
  )
  return {
    ...success(makeCycleDraft(identity, window)),
    state: CycleState.Active,
    bindings: { snapshotId: hash('daily-snapshot') },
    stateVersion: 3,
    createdAt: '2026-08-17T20:00:00.000Z',
    updatedAt: window.submissionOpenAt,
  }
}

const sourceTopics = Object.freeze({
  bars: 'torghut.bars.1m.v1',
  quotes: 'torghut.quotes.v1',
  trades: 'torghut.trades.v1',
})
const snapshotRequest: IntradaySnapshotRequest = {
  sessionDate: '2026-08-18',
  calendar,
  rangeStartAt: '2026-08-18T19:29:00.000Z',
  rangeEndAt: '2026-08-18T19:30:00.000Z',
  observedAt: '2026-08-18T19:30:01.000Z',
  universeId: protocol.universeId,
  universeSymbolHash: protocol.universeSymbolHash,
  universe: protocol.universe,
  feed: protocol.feed,
  delayClass: protocol.delayClass,
  sourceTopics,
  maximumQuoteAgeMs: protocol.maximumQuoteAgeMs,
  minimumWatermarkLagMs: 0,
  archiveWatermarks: Object.values(sourceTopics).map((sourceTopic) => ({
    sourceTopic,
    sourcePartition: 0,
    inclusiveLastOffset: String(protocol.universe.length),
  })),
}

const makeSnapshotRows = (): IntradaySnapshotRows => {
  const identity = (symbol: string, sourceTopic: string, sourceOffset: number) => ({
    provider: 'alpaca',
    universe_id: protocol.universeId,
    universe_symbol_hash: protocol.universeSymbolHash,
    feed: protocol.feed,
    market_session: 'regular',
    delay_class: protocol.delayClass,
    symbol,
    source_topic: sourceTopic,
    source_partition: '0',
    source_offset: String(sourceOffset),
    schema_version: '1',
  })
  const bars = protocol.universe.map((symbol, index) => ({
    ...identity(symbol, sourceTopics.bars, index + 1),
    event_at: snapshotRequest.rangeStartAt,
    ingested_at: snapshotRequest.rangeEndAt,
    channel: 'bars',
    is_final: '1',
    open: symbol === 'AMD' ? '100' : String(101 + index),
    high: symbol === 'AMD' ? '101' : String(102 + index),
    low: symbol === 'AMD' ? '99' : String(100 + index),
    close: symbol === 'AMD' ? '100.5' : String(101.5 + index),
    volume: '1000',
    vwap: symbol === 'AMD' ? '100.25' : String(101.25 + index),
    trade_count: '100',
  }))
  const quotes = protocol.universe.map((symbol, index) => ({
    ...identity(symbol, sourceTopics.quotes, index + 1),
    event_at: '2026-08-18T19:30:00.500Z',
    ingested_at: '2026-08-18T19:30:00.600Z',
    latest_payload_variants: '1',
    bid_price: symbol === 'AMD' ? '100.123456' : String(101.123456 + index),
    bid_size: '100',
    ask_price: symbol === 'AMD' ? '100.133456' : String(101.133456 + index),
    ask_size: symbol === 'AMD' ? '10.9' : '100',
  }))
  const trades = protocol.universe.map((symbol, index) => ({
    ...identity(symbol, sourceTopics.trades, index + 1),
    event_at: '2026-08-18T19:30:00.400Z',
    ingested_at: '2026-08-18T19:30:00.500Z',
    latest_payload_variants: '1',
    price: symbol === 'AMD' ? '100.13' : String(101.13 + index),
    size: '10',
  }))
  return {
    archiveWatermarks: snapshotRequest.archiveWatermarks.map((watermark) => ({
      source_topic: watermark.sourceTopic,
      source_partition: String(watermark.sourcePartition),
      inclusive_last_offset: watermark.inclusiveLastOffset,
    })),
    bars,
    quotes,
    trades,
  }
}

const makeOpeningRangeRows = (request: IntradaySnapshotRequest): IntradaySnapshotRows => {
  const identity = (symbol: string, sourceTopic: string, sourceOffset: number) => ({
    provider: 'alpaca',
    universe_id: protocol.universeId,
    universe_symbol_hash: protocol.universeSymbolHash,
    feed: protocol.feed,
    market_session: 'regular',
    delay_class: protocol.delayClass,
    symbol,
    source_topic: sourceTopic,
    source_partition: '0',
    source_offset: String(sourceOffset),
    schema_version: '1',
  })
  const rangeStart = Date.parse(request.rangeStartAt)
  const rangeMinutes = (Date.parse(request.rangeEndAt) - rangeStart) / 60_000
  const leaders = new Map([
    ['AMD', 0.016],
    ['AVGO', 0.015],
    ['NVDA', 0.014],
  ])
  const bars = protocol.universe.flatMap((symbol, symbolIndex) => {
    const opening = 100 + symbolIndex
    return Array.from({ length: rangeMinutes }, (_, minute) => ({
      ...identity(symbol, sourceTopics.bars, symbolIndex * rangeMinutes + minute + 1),
      event_at: new Date(rangeStart + minute * 60_000).toISOString(),
      ingested_at: new Date(rangeStart + (minute + 1) * 60_000).toISOString(),
      channel: 'bars',
      is_final: '1',
      open: String(opening),
      high: String(opening * 1.011),
      low: String(opening * 0.995),
      close: String(opening * (1 + minute * 0.001)),
      volume: '1000',
      vwap: String(opening),
      trade_count: '100',
    }))
  })
  const quotes = protocol.universe.map((symbol, index) => {
    const opening = 100 + index
    const midpoint = opening * (1 + (leaders.get(symbol) ?? 0.001))
    return {
      ...identity(symbol, sourceTopics.quotes, index + 1),
      event_at: new Date(Date.parse(request.rangeEndAt) + 500).toISOString(),
      ingested_at: new Date(Date.parse(request.rangeEndAt) + 600).toISOString(),
      latest_payload_variants: '1',
      bid_price: String(midpoint - 0.01),
      bid_size: '100',
      ask_price: String(midpoint + 0.01),
      ask_size: '100',
    }
  })
  const trades = protocol.universe.map((symbol, index) => {
    const opening = 100 + index
    return {
      ...identity(symbol, sourceTopics.trades, index + 1),
      event_at: new Date(Date.parse(request.rangeEndAt) + 400).toISOString(),
      ingested_at: new Date(Date.parse(request.rangeEndAt) + 500).toISOString(),
      latest_payload_variants: '1',
      price: String(opening * (1 + (leaders.get(symbol) ?? 0.001))),
      size: '10',
    }
  })
  return {
    archiveWatermarks: request.archiveWatermarks.map((watermark) => ({
      source_topic: watermark.sourceTopic,
      source_partition: String(watermark.sourcePartition),
      inclusive_last_offset: watermark.inclusiveLastOffset,
    })),
    bars,
    quotes,
    trades,
  }
}

const snapshot = success(verifyIntradaySnapshot(snapshotRequest, makeSnapshotRows()))

describe('opening-drive runtime decision boundary', () => {
  test('admits entry only for the exact post-open range and bounded submission window', () => {
    const cycle = makeActiveCycle()
    const query = success(openingDriveEntryQuery(cycle, protocol, calendar, cycle.window.submissionOpenAt))

    expect(query).toMatchObject({
      sessionDate: '2026-08-18',
      rangeStartAt: '2026-08-18T13:30:00.000Z',
      rangeEndAt: '2026-08-18T13:35:00.000Z',
      observedAt: '2026-08-18T13:35:01.000Z',
      minimumWatermarkLagMs: 1_000,
    })
    expect(failure(openingDriveEntryQuery(cycle, protocol, calendar, '2026-08-18T13:35:00.999Z'))).toMatchObject({
      operation: 'entry-query',
    })
    expect(failure(openingDriveEntryQuery(cycle, protocol, calendar, cycle.window.submissionCutoffAt))).toMatchObject({
      operation: 'entry-query',
    })
  })

  test('keeps a persisted v2 opening-drive cycle eligible for its verified intraday entry read', () => {
    const cycle = makeHistoricalActiveCycle()
    const query = success(openingDriveEntryQuery(cycle, protocol, calendar, cycle.window.submissionOpenAt))

    expect(query).toMatchObject({
      sessionDate: '2026-08-18',
      rangeStartAt: '2026-08-18T13:30:00.000Z',
      rangeEndAt: '2026-08-18T13:35:00.000Z',
    })
  })

  test('uses only the last complete minute before a close decision', () => {
    const cycle = makeActiveCycle()
    const query = success(openingDriveCloseQuery(cycle, protocol, calendar, '2026-08-18T19:30:01.000Z'))

    expect(query).toMatchObject({
      sessionDate: '2026-08-18',
      rangeStartAt: '2026-08-18T19:29:00.000Z',
      rangeEndAt: '2026-08-18T19:30:00.000Z',
      observedAt: '2026-08-18T19:30:01.000Z',
      minimumWatermarkLagMs: 0,
    })
    expect(failure(openingDriveCloseQuery(cycle, protocol, calendar, '2026-08-18T19:30:00.000Z'))).toMatchObject({
      operation: 'close-query',
    })
    expect(failure(openingDriveCloseQuery(cycle, protocol, calendar, '2026-08-18T20:00:01.000Z'))).toMatchObject({
      operation: 'close-query',
    })
  })

  test('captures one immutable archive version before loading its snapshot', async () => {
    const calls: string[] = []
    const service: IntradayMarketDataService = {
      captureVersion: () => {
        calls.push('capture')
        return Effect.succeed(snapshot.manifest.archiveWatermarks)
      },
      loadSnapshot: (request) => {
        calls.push(`load:${request.archiveWatermarks[0]?.inclusiveLastOffset}`)
        return Effect.succeed(snapshot)
      },
    }
    const query = success(openingDriveCloseQuery(makeActiveCycle(), protocol, calendar, snapshot.manifest.observedAt))

    expect(await Effect.runPromise(loadIntradaySnapshot(service, query))).toBe(snapshot)
    expect(calls).toEqual([`capture`, `load:${protocol.universe.length}`])
  })

  test('binds the exact snapshot and uses adverse bid prices for liquidation', () => {
    expect(success(executionMarketDataBinding(snapshot))).toMatchObject({
      snapshotId: snapshot.manifest.snapshotId,
      contentHash: snapshot.manifest.contentHash,
      barsContentHash: snapshot.manifest.barsContentHash,
      quotesContentHash: snapshot.manifest.quotesContentHash,
      tradesContentHash: snapshot.manifest.tradesContentHash,
    })
    expect(success(closeBidPrices(snapshot, ['AMD', 'AMD']))).toEqual({ AMD: '100120000' })
    expect(failure(closeBidPrices(snapshot, ['AAPL']))).toMatchObject({ operation: 'close-prices' })

    const amdQuote = snapshot.latestQuotes['AMD']
    if (amdQuote === undefined) return expect.unreachable('opening-drive fixture requires an AMD quote')
    const staleHeldSymbolSnapshot = {
      ...snapshot,
      latestQuotes: {
        ...snapshot.latestQuotes,
        AMD: { ...amdQuote, eventAt: '2026-08-18T19:29:59.999Z' },
      },
    }
    expect(failure(closeBidPrices(staleHeldSymbolSnapshot, ['AMD']))).toMatchObject({
      operation: 'close-prices',
      message: 'closing quote for AMD is outside the freshness window',
    })
    expect(success(closeBidPrices(staleHeldSymbolSnapshot, ['AVGO']))).toEqual({ AVGO: '102120000' })
  })

  test('rejects an entry-cycle liquidation when the held symbol quote is stale', () => {
    const delayedSnapshot = success(
      verifyIntradaySnapshot({ ...snapshotRequest, observedAt: '2026-08-18T19:30:02.000Z' }, makeSnapshotRows()),
    )

    expect(
      failure(requireFreshOpeningDrivePositionQuotes(delayedSnapshot, [{ symbol: 'AMD', quantityMicros: '1000000' }])),
    ).toMatchObject({
      operation: 'entry-decision',
      message: 'existing position AMD has no fresh entry-cycle liquidation quote',
    })
    expect(success(requireFreshOpeningDrivePositionQuotes(delayedSnapshot, []))).toBeUndefined()
  })

  test('carries the verified whole-share ask quantity into runtime planning', () => {
    const cycle = makeActiveCycle()
    const definition: OpeningDriveStrategyDefinition = {
      name: 'opening-drive-momentum',
      holdingPeriod: 'INTRADAY',
      parameters: protocol,
      decide: () =>
        Result.succeed({
          schemaVersion: 'bayn.opening-drive.target.v1',
          strategy: 'opening-drive-momentum',
          sessionDate: cycle.identity.executionSessionDate,
          snapshotId: snapshot.manifest.snapshotId,
          observedAt: snapshot.manifest.observedAt,
          calendarHash: cycle.window.executionCalendarHash,
          selectedSymbols: ['AMD'],
          targetWeights: { AMD: 0.1 },
          signals: [
            {
              symbol: 'AMD',
              openingPriceMicros: '100000000',
              rangeHighPriceMicros: '101000000',
              rangeLowPriceMicros: '99000000',
              bidPriceMicros: '100123456',
              askPriceMicros: '100133456',
              quoteObservedAt: '2026-08-18T19:30:00.500Z',
              breakoutTradePriceMicros: '100130000',
              breakoutTradeObservedAt: '2026-08-18T19:30:00.400Z',
              openingReturnBps: 50,
              breakoutBps: 10,
              rangeLocationPpm: 900_000,
              spreadBps: 1,
              openingDollarVolumeMicros: '1000000000',
              eligible: true,
              rejectionReasons: [],
              rank: 1,
            },
          ],
        }),
    }
    expect(success(compileOpeningDriveDecision(definition, cycle, snapshot))).toMatchObject({
      priceMicros: { AMD: '100140000' },
      bidPriceMicros: { AMD: '100120000' },
      askPriceMicros: { AMD: '100140000' },
      maximumBuyQuantityMicros: { AMD: '10000000' },
    })
  })

  test('waits only for mutable entry evidence and finalizes no-trade before the cutoff headroom', () => {
    const cycle = makeActiveCycle()
    const baseDecision: OpeningDriveTargetPortfolio = {
      schemaVersion: 'bayn.opening-drive.target.v1' as const,
      strategy: 'opening-drive-momentum' as const,
      sessionDate: cycle.identity.executionSessionDate,
      snapshotId: hash('entry-snapshot'),
      observedAt: cycle.window.submissionOpenAt,
      calendarHash: cycle.window.executionCalendarHash,
      selectedSymbols: ['AMD'],
      targetWeights: { AMD: 0.1 },
      signals: [
        {
          symbol: 'AMD',
          openingPriceMicros: '100000000',
          rangeHighPriceMicros: '101000000',
          rangeLowPriceMicros: '99000000',
          bidPriceMicros: '101040000',
          askPriceMicros: '101050000',
          quoteObservedAt: cycle.window.submissionOpenAt,
          breakoutTradePriceMicros: '101060000',
          breakoutTradeObservedAt: cycle.window.submissionOpenAt,
          openingReturnBps: 50,
          breakoutBps: 6,
          rangeLocationPpm: 900_000,
          spreadBps: 1,
          openingDollarVolumeMicros: '1000000000',
          eligible: true,
          rejectionReasons: [],
          rank: 1,
        },
      ],
    }
    const decisionWith = (
      observedAt: string,
      rejectionReasons: readonly OpeningDriveRejectionReason[],
    ): OpeningDriveTargetPortfolio => ({
      ...baseDecision,
      observedAt,
      selectedSymbols: [],
      targetWeights: { AMD: 0 },
      signals: baseDecision.signals.map((signal) => ({
        ...signal,
        eligible: false,
        rejectionReasons,
        rank: null,
      })),
    })

    expect(
      openingDriveEntryDisposition(
        decisionWith('2026-08-18T13:35:01.000Z', ['breakout', 'spread']),
        cycle.window.submissionCutoffAt,
        60_000,
      ),
    ).toBe('AWAIT_SIGNAL')
    expect(
      openingDriveEntryDisposition(
        decisionWith('2026-08-18T13:59:00.000Z', ['breakout']),
        cycle.window.submissionCutoffAt,
        60_000,
      ),
    ).toBe('NO_TRADE')
    expect(
      openingDriveEntryDisposition(
        decisionWith('2026-08-18T13:35:01.000Z', ['opening-return']),
        cycle.window.submissionCutoffAt,
        60_000,
      ),
    ).toBe('AWAIT_SIGNAL')
    expect(
      openingDriveEntryDisposition(
        decisionWith('2026-08-18T13:35:01.000Z', ['range-location']),
        cycle.window.submissionCutoffAt,
        60_000,
      ),
    ).toBe('AWAIT_SIGNAL')
    expect(
      openingDriveEntryDisposition(
        decisionWith('2026-08-18T13:35:01.000Z', ['market-data-freshness']),
        cycle.window.submissionCutoffAt,
        60_000,
      ),
    ).toBe('AWAIT_SIGNAL')
    expect(
      openingDriveEntryDisposition(
        decisionWith('2026-08-18T13:59:00.000Z', ['market-data-freshness']),
        cycle.window.submissionCutoffAt,
        60_000,
      ),
    ).toBe('NO_TRADE')
    expect(
      openingDriveEntryDisposition(
        decisionWith('2026-08-18T13:35:01.000Z', ['dollar-volume']),
        cycle.window.submissionCutoffAt,
        60_000,
      ),
    ).toBe('NO_TRADE')
    expect(openingDriveEntryDisposition(baseDecision, cycle.window.submissionCutoffAt, 60_000)).toBe('EXECUTE')
  })

  test('compiles the real strategy against the exact selected-session calendar binding', () => {
    const cycle = makeActiveCycle()
    const query = success(openingDriveEntryQuery(cycle, protocol, calendar, cycle.window.submissionOpenAt))
    const request: IntradaySnapshotRequest = {
      ...query,
      archiveWatermarks: [
        {
          sourceTopic: sourceTopics.bars,
          sourcePartition: 0,
          inclusiveLastOffset: String(protocol.universe.length * protocol.openingRangeMinutes),
        },
        {
          sourceTopic: sourceTopics.quotes,
          sourcePartition: 0,
          inclusiveLastOffset: String(protocol.universe.length),
        },
        {
          sourceTopic: sourceTopics.trades,
          sourcePartition: 0,
          inclusiveLastOffset: String(protocol.universe.length),
        },
      ],
    }
    const entrySnapshot = success(verifyIntradaySnapshot(request, makeOpeningRangeRows(request)))

    expect(
      success(compileOpeningDriveDecision(makeOpeningDriveDefinition(protocol), cycle, entrySnapshot)),
    ).toMatchObject({
      decision: {
        schemaVersion: 'bayn.opening-drive.target.v1',
        calendarHash: cycle.window.executionCalendarHash,
        selectedSymbols: ['AMD', 'AVGO', 'NVDA'],
      },
      executionMarketData: {
        snapshotId: entrySnapshot.manifest.snapshotId,
      },
    })
  })
})
