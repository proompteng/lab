import { describe, expect, test } from 'bun:test'
import { Result, Schema } from 'effect'

import { canonicalHashV1, sha256 } from '../../hash'
import { verifyIntradaySnapshot, type IntradaySnapshotRows } from '../../market-data'
import { strictParseOptions } from '../../schemas'
import { decideOpeningDrive, makeOpeningDriveDefinition } from './decision'
import { OpeningDriveTargetPortfolioSchema } from './model'
import {
  decodeDefaultOpeningDriveProtocol,
  decodeOpeningDriveProtocol,
  decodeOpeningDriveProtocolV1,
  defaultOpeningDriveProtocolHash,
  defaultOpeningDriveProtocolDocument,
  hashOpeningDriveProtocol,
  openingDriveProtocolV1Document,
  openingDriveProtocolV1Hash,
} from './protocol'

const symbols = defaultOpeningDriveProtocolDocument.universe
const barsTopic = 'torghut.bars.1m.v1'
const quotesTopic = 'torghut.quotes.v1'
const tradesTopic = 'torghut.trades.v1'
const calendarMaterial = {
  schemaVersion: 'bayn.alpaca-market-calendar-observation.v1' as const,
  source: 'alpaca-v2-calendar' as const,
  requestedRange: { start: '2026-08-18', end: '2026-08-18' },
  timeZone: 'UTC' as const,
  sessions: [{ date: '2026-08-18', openAt: '2026-08-18T13:30:00.000Z', closeAt: '2026-08-18T20:00:00.000Z' }],
}
const calendar = { ...calendarMaterial, normalizedResponseHash: canonicalHashV1(calendarMaterial) }

const request = {
  sessionDate: '2026-08-18',
  calendar,
  rangeStartAt: '2026-08-18T13:30:00.000Z',
  rangeEndAt: '2026-08-18T13:35:00.000Z',
  observedAt: '2026-08-18T13:35:02.000Z',
  universeId: defaultOpeningDriveProtocolDocument.universeId,
  universeSymbolHash: sha256(symbols.join(',')),
  universe: symbols,
  feed: defaultOpeningDriveProtocolDocument.feed,
  delayClass: defaultOpeningDriveProtocolDocument.delayClass,
  sourceTopics: { bars: barsTopic, quotes: quotesTopic, trades: tradesTopic },
  maximumQuoteAgeMs: defaultOpeningDriveProtocolDocument.maximumQuoteAgeMs,
  minimumWatermarkLagMs: defaultOpeningDriveProtocolDocument.decisionDelaySeconds * 1_000,
  archiveWatermarks: [
    { sourceTopic: barsTopic, sourcePartition: 0, inclusiveLastOffset: String(symbols.length * 5) },
    { sourceTopic: quotesTopic, sourcePartition: 0, inclusiveLastOffset: String(symbols.length * 6) },
    { sourceTopic: tradesTopic, sourcePartition: 0, inclusiveLastOffset: String(symbols.length * 7) },
  ],
} as const

const success = <A, E>(result: Result.Result<A, E>): A => Result.getOrThrow(result)
const error = <A, E>(result: Result.Result<A, E>): E => Result.getOrThrow(Result.flip(result))

const returnBySymbol: Readonly<Record<string, number>> = {
  AMD: 0.016,
  AVGO: 0.015,
  NVDA: 0.014,
}

const makeRows = (returnOverride?: number, volumeOverride?: string): IntradaySnapshotRows => {
  let offset = 1
  const bars = symbols.flatMap((symbol, symbolIndex) => {
    const opening = 100 + symbolIndex
    return Array.from({ length: 5 }, (_, minute) => {
      const eventAt = `2026-08-18T13:3${minute}:00.000Z`
      return {
        provider: 'alpaca',
        universe_id: request.universeId,
        universe_symbol_hash: request.universeSymbolHash,
        feed: request.feed,
        market_session: 'regular',
        delay_class: request.delayClass,
        symbol,
        event_at: eventAt,
        ingested_at: `2026-08-18T13:3${minute + 1}:00.000Z`,
        source_topic: barsTopic,
        source_partition: '0',
        source_offset: String(offset++),
        schema_version: '1',
        channel: 'bars',
        is_final: '1',
        open: String(opening),
        high: String(opening * 1.011),
        low: String(opening * 0.995),
        close: String(opening * (1 + minute * 0.001)),
        volume: volumeOverride ?? '1000',
        vwap: String(opening),
        trade_count: '100',
      }
    })
  })
  const quotes = symbols.map((symbol, symbolIndex) => {
    const opening = 100 + symbolIndex
    const openingReturn = returnOverride ?? returnBySymbol[symbol] ?? 0.001
    const midpoint = opening * (1 + openingReturn)
    return {
      provider: 'alpaca',
      universe_id: request.universeId,
      universe_symbol_hash: request.universeSymbolHash,
      feed: request.feed,
      market_session: 'regular',
      delay_class: request.delayClass,
      symbol,
      event_at: '2026-08-18T13:35:01.500Z',
      ingested_at: '2026-08-18T13:35:01.600Z',
      source_topic: quotesTopic,
      source_partition: '0',
      source_offset: String(offset++),
      schema_version: '1',
      bid_price: String(midpoint - 0.01),
      bid_size: '100',
      ask_price: String(midpoint + 0.01),
      ask_size: '100',
    }
  })
  const trades = symbols.map((symbol, symbolIndex) => {
    const opening = 100 + symbolIndex
    const openingReturn = returnOverride ?? returnBySymbol[symbol] ?? 0.001
    return {
      provider: 'alpaca',
      universe_id: request.universeId,
      universe_symbol_hash: request.universeSymbolHash,
      feed: request.feed,
      market_session: 'regular',
      delay_class: request.delayClass,
      symbol,
      event_at: '2026-08-18T13:35:01.400Z',
      ingested_at: '2026-08-18T13:35:01.500Z',
      source_topic: tradesTopic,
      source_partition: '0',
      source_offset: String(offset++),
      schema_version: '1',
      price: String(opening * (1 + openingReturn)),
      size: '10',
    }
  })
  const archiveWatermarks = request.archiveWatermarks.map((watermark) => ({
    source_topic: watermark.sourceTopic,
    source_partition: String(watermark.sourcePartition),
    inclusive_last_offset: watermark.inclusiveLastOffset,
  }))
  return { archiveWatermarks, bars, quotes, trades } satisfies IntradaySnapshotRows
}

const snapshot = (returnOverride?: number) => success(verifyIntradaySnapshot(request, makeRows(returnOverride)))
const session = Object.freeze({
  sessionDate: request.sessionDate,
  openAt: request.rangeStartAt,
  closeAt: '2026-08-18T20:00:00.000Z',
  calendarHash: calendar.normalizedResponseHash,
})
const marketContext = (returnOverride?: number) => Object.freeze({ snapshot: snapshot(returnOverride), session })

describe('opening-drive momentum strategy', () => {
  test('decodes one frozen result-blind exchange-only protocol', () => {
    const protocol = success(decodeDefaultOpeningDriveProtocol())
    const legacy = success(decodeOpeningDriveProtocolV1(openingDriveProtocolV1Document))
    expect(protocol).toEqual(defaultOpeningDriveProtocolDocument)
    expect(success(hashOpeningDriveProtocol(protocol))).toBe(defaultOpeningDriveProtocolHash)
    expect(success(hashOpeningDriveProtocol(legacy))).toBe(openingDriveProtocolV1Hash)
    expect(error(decodeOpeningDriveProtocol(openingDriveProtocolV1Document))).toMatchObject({
      _tag: 'OpeningDriveProtocolDecodeError',
    })
    expect(error(decodeOpeningDriveProtocolV1(defaultOpeningDriveProtocolDocument))).toMatchObject({
      _tag: 'OpeningDriveProtocolDecodeError',
    })
    expect(
      error(decodeOpeningDriveProtocol({ ...defaultOpeningDriveProtocolDocument, maximumPositions: 11 })),
    ).toMatchObject({ _tag: 'OpeningDriveProtocolDecodeError' })
    expect(
      error(
        decodeOpeningDriveProtocol({
          ...defaultOpeningDriveProtocolDocument,
          entryCutoffMinutesAfterOpen: defaultOpeningDriveProtocolDocument.openingRangeMinutes,
        }),
      ),
    ).toMatchObject({ _tag: 'OpeningDriveProtocolDecodeError' })
    expect(
      error(
        decodeOpeningDriveProtocol({
          ...defaultOpeningDriveProtocolDocument,
          maximumQuoteAgeMs: 5 * 60_000 + 1,
        }),
      ),
    ).toMatchObject({ _tag: 'OpeningDriveProtocolDecodeError' })
    expect(
      error(
        decodeOpeningDriveProtocol({
          ...defaultOpeningDriveProtocolDocument,
          maximumSymbolWeight: 0.0000001,
        }),
      ),
    ).toMatchObject({ _tag: 'OpeningDriveProtocolDecodeError' })
    expect(
      success(
        decodeOpeningDriveProtocol({
          ...defaultOpeningDriveProtocolDocument,
          decisionDelaySeconds: 30,
          maximumQuoteAgeMs: 1_000,
          executionModel: {
            ...defaultOpeningDriveProtocolDocument.executionModel,
            order: {
              ...defaultOpeningDriveProtocolDocument.executionModel.order,
              decisionAfterOpenMs: defaultOpeningDriveProtocolDocument.openingRangeMinutes * 60_000 + 30_000,
            },
          },
        }),
      ),
    ).toMatchObject({ decisionDelaySeconds: 30, maximumQuoteAgeMs: 1_000 })
    expect(
      error(
        decodeOpeningDriveProtocol({
          ...defaultOpeningDriveProtocolDocument,
          decisionDelaySeconds: 20 * 60 + 1,
          entryCutoffMinutesAfterOpen: 26,
        }),
      ),
    ).toMatchObject({ _tag: 'OpeningDriveProtocolDecodeError' })
    for (const field of [
      'entryCutoffMinutesAfterOpen',
      'flattenBeforeCloseMinutes',
      'hardFlatBeforeCloseMinutes',
    ] as const) {
      expect(
        error(
          decodeOpeningDriveProtocol({
            ...defaultOpeningDriveProtocolDocument,
            [field]: Number.MAX_SAFE_INTEGER,
          }),
        ),
      ).toMatchObject({ _tag: 'OpeningDriveProtocolDecodeError' })
    }
    expect(
      error(
        decodeOpeningDriveProtocol({
          ...defaultOpeningDriveProtocolDocument,
          entryCutoffMinutesAfterOpen: 24 * 60 + 1,
        }),
      ),
    ).toMatchObject({ _tag: 'OpeningDriveProtocolDecodeError' })
  })

  test('selects confirmed post-range breakouts with bounded equal weights', () => {
    const protocol = success(decodeDefaultOpeningDriveProtocol())
    const market = marketContext()
    const decision = success(decideOpeningDrive(market, protocol))
    const replay = success(decideOpeningDrive(market, protocol))

    expect(decision.selectedSymbols).toEqual(['AMD', 'AVGO', 'NVDA'])
    expect(decision.targetWeights['AMD']).toBe(0.1)
    expect(decision.targetWeights['AVGO']).toBe(0.1)
    expect(decision.targetWeights['NVDA']).toBe(0.1)
    expect(Object.values(decision.targetWeights).reduce((sum, weight) => sum + weight, 0)).toBeCloseTo(0.3)
    expect(decision.signals.find((signal) => signal.symbol === 'AMD')).toMatchObject({ eligible: true, rank: 1 })
    expect(replay).toEqual(decision)
  })

  test('returns a deterministic flat target when no symbol clears the frozen gates', () => {
    const protocol = success(decodeDefaultOpeningDriveProtocol())
    const decision = success(decideOpeningDrive(marketContext(0.001), protocol))

    expect(decision.selectedSymbols).toEqual([])
    expect(Object.values(decision.targetWeights).every((weight) => weight === 0)).toBe(true)
    expect(decision.signals.every((signal) => signal.rejectionReasons.includes('opening-return'))).toBe(true)
  })

  test('retains valid zero-dollar-volume rejection evidence in the runtime decision contract', () => {
    const protocol = success(decodeDefaultOpeningDriveProtocol())
    const decision = success(
      decideOpeningDrive(
        { snapshot: success(verifyIntradaySnapshot(request, makeRows(undefined, '0'))), session },
        protocol,
      ),
    )

    expect(decision.signals.every((signal) => signal.openingDollarVolumeMicros === '0')).toBe(true)
    expect(decision.signals.every((signal) => signal.rejectionReasons.includes('dollar-volume'))).toBe(true)
    expect(
      Result.isSuccess(Schema.decodeUnknownResult(OpeningDriveTargetPortfolioSchema, strictParseOptions)(decision)),
    ).toBe(true)
  })

  test('does not enter on opening momentum without a confirmed range breakout', () => {
    const protocol = success(decodeDefaultOpeningDriveProtocol())
    const decision = success(decideOpeningDrive(marketContext(0.01), protocol))

    expect(decision.selectedSymbols).toEqual([])
    expect(decision.signals.every((signal) => signal.rejectionReasons.includes('breakout'))).toBe(true)
  })

  test('does not select a symbol without displayed two-sided quote liquidity', () => {
    const protocol = success(decodeDefaultOpeningDriveProtocol())
    const rows = makeRows()
    const noAskLiquidityRows = {
      ...rows,
      quotes: rows.quotes.map((quote) => (quote.symbol === 'AMD' ? { ...quote, ask_size: '0' } : quote)),
    }
    const market = success(verifyIntradaySnapshot(request, noAskLiquidityRows))
    const decision = success(decideOpeningDrive({ snapshot: market, session }, protocol))

    expect(decision.selectedSymbols).not.toContain('AMD')
    expect(decision.signals.find((signal) => signal.symbol === 'AMD')).toMatchObject({
      eligible: false,
      rejectionReasons: expect.arrayContaining(['displayed-liquidity']),
    })
  })

  test('rejects a fresh observation at the precommitted entry cutoff', () => {
    const protocol = success(decodeDefaultOpeningDriveProtocol())
    const market = snapshot()
    const observedAt = '2026-08-18T14:00:00.000Z'
    const latestQuotes = Object.fromEntries(
      Object.entries(market.latestQuotes).map(([symbol, quote]) => [symbol, { ...quote, eventAt: observedAt }]),
    )

    expect(
      error(
        decideOpeningDrive(
          {
            snapshot: { ...market, manifest: { ...market.manifest, observedAt }, latestQuotes },
            session,
          },
          protocol,
        ),
      ),
    ).toMatchObject({ reason: 'snapshot-window' })
  })

  test('uses the highest Kafka offset when trade timestamps tie', () => {
    const protocol = success(decodeDefaultOpeningDriveProtocol())
    const rows = makeRows()
    const amdTrade = rows.trades.find((trade) => trade.symbol === 'AMD')
    if (amdTrade === undefined) throw new Error('AMD trade fixture is missing')
    const latestOffset = String(symbols.length * 7 + 1)
    const archiveWatermarks = request.archiveWatermarks.map((watermark) =>
      watermark.sourceTopic === tradesTopic ? { ...watermark, inclusiveLastOffset: latestOffset } : watermark,
    )
    const tiedRows = {
      ...rows,
      archiveWatermarks: rows.archiveWatermarks.map((watermark) =>
        watermark.source_topic === tradesTopic ? { ...watermark, inclusive_last_offset: latestOffset } : watermark,
      ),
      trades: [
        ...rows.trades,
        { ...amdTrade, source_offset: latestOffset, price: String(Number(amdTrade.price) * 0.95) },
      ],
    }
    const tiedSnapshot = verifyIntradaySnapshot({ ...request, archiveWatermarks }, tiedRows)
    if (Result.isFailure(tiedSnapshot)) throw new Error(JSON.stringify(tiedSnapshot.failure))
    const market = tiedSnapshot.success
    const decision = success(decideOpeningDrive({ snapshot: market, session }, protocol))

    expect(decision.selectedSymbols).not.toContain('AMD')
    expect(decision.signals.find((signal) => signal.symbol === 'AMD')?.rejectionReasons).toContain('breakout')
  })

  test('rejects latest-trade timestamp ties across Kafka partitions', () => {
    const protocol = success(decodeDefaultOpeningDriveProtocol())
    const rows = makeRows()
    const amdTrade = rows.trades.find((trade) => trade.symbol === 'AMD')
    if (amdTrade === undefined) throw new Error('AMD trade fixture is missing')
    const partitionOneWatermark = {
      sourceTopic: tradesTopic,
      sourcePartition: 1,
      inclusiveLastOffset: '1',
    } as const
    const archiveWatermarks = [...request.archiveWatermarks, partitionOneWatermark].toSorted(
      (left, right) =>
        left.sourceTopic.localeCompare(right.sourceTopic) || left.sourcePartition - right.sourcePartition,
    )
    const market = success(
      verifyIntradaySnapshot(
        { ...request, archiveWatermarks },
        {
          ...rows,
          archiveWatermarks: [
            ...rows.archiveWatermarks,
            {
              source_topic: partitionOneWatermark.sourceTopic,
              source_partition: String(partitionOneWatermark.sourcePartition),
              inclusive_last_offset: partitionOneWatermark.inclusiveLastOffset,
            },
          ].toSorted(
            (left, right) =>
              left.source_topic.localeCompare(right.source_topic) ||
              Number(left.source_partition) - Number(right.source_partition),
          ),
          trades: [
            ...rows.trades,
            {
              ...amdTrade,
              source_partition: String(partitionOneWatermark.sourcePartition),
              source_offset: partitionOneWatermark.inclusiveLastOffset,
              price: String(Number(amdTrade.price) * 0.95),
            },
          ],
        },
      ),
    )

    expect(error(decideOpeningDrive({ snapshot: market, session }, protocol))).toMatchObject({
      reason: 'snapshot-coverage',
      symbol: 'AMD',
    })
  })

  test('rejects latest-quote timestamp ties across Kafka partitions', () => {
    const protocol = success(decodeDefaultOpeningDriveProtocol())
    const rows = makeRows()
    const amdQuote = rows.quotes.find((quote) => quote.symbol === 'AMD')
    if (amdQuote === undefined) throw new Error('AMD quote fixture is missing')
    const partitionOneWatermark = {
      sourceTopic: quotesTopic,
      sourcePartition: 1,
      inclusiveLastOffset: '1',
    } as const
    const archiveWatermarks = [...request.archiveWatermarks, partitionOneWatermark].toSorted(
      (left, right) =>
        left.sourceTopic.localeCompare(right.sourceTopic) || left.sourcePartition - right.sourcePartition,
    )
    const market = success(
      verifyIntradaySnapshot(
        { ...request, archiveWatermarks },
        {
          ...rows,
          archiveWatermarks: [
            ...rows.archiveWatermarks,
            {
              source_topic: partitionOneWatermark.sourceTopic,
              source_partition: String(partitionOneWatermark.sourcePartition),
              inclusive_last_offset: partitionOneWatermark.inclusiveLastOffset,
            },
          ].toSorted(
            (left, right) =>
              left.source_topic.localeCompare(right.source_topic) ||
              Number(left.source_partition) - Number(right.source_partition),
          ),
          quotes: [
            ...rows.quotes,
            {
              ...amdQuote,
              source_partition: String(partitionOneWatermark.sourcePartition),
              source_offset: partitionOneWatermark.inclusiveLastOffset,
              bid_price: String(Number(amdQuote.bid_price) * 0.95),
              ask_price: String(Number(amdQuote.ask_price) * 0.95),
            },
          ],
        },
      ),
    )

    expect(error(decideOpeningDrive({ snapshot: market, session }, protocol))).toMatchObject({
      reason: 'snapshot-coverage',
      symbol: 'AMD',
    })
  })

  test('orders mixed-precision trade timestamps by their nanosecond instant', () => {
    const protocol = success(decodeDefaultOpeningDriveProtocol())
    const rows = makeRows()
    const amdTrade = rows.trades.find((trade) => trade.symbol === 'AMD')
    if (amdTrade === undefined) throw new Error('AMD trade fixture is missing')
    const latestOffset = String(symbols.length * 7 + 1)
    const archiveWatermarks = request.archiveWatermarks.map((watermark) =>
      watermark.sourceTopic === tradesTopic ? { ...watermark, inclusiveLastOffset: latestOffset } : watermark,
    )
    const mixedPrecisionRows = {
      ...rows,
      archiveWatermarks: rows.archiveWatermarks.map((watermark) =>
        watermark.source_topic === tradesTopic ? { ...watermark, inclusive_last_offset: latestOffset } : watermark,
      ),
      trades: [
        ...rows.trades.map((trade) =>
          trade.symbol === 'AMD'
            ? { ...trade, event_at: '2026-08-18T13:35:01.500Z', ingested_at: '2026-08-18T13:35:01.600Z' }
            : trade,
        ),
        {
          ...amdTrade,
          event_at: '2026-08-18T13:35:01.500999999Z',
          ingested_at: '2026-08-18T13:35:01.600999999Z',
          source_offset: latestOffset,
          price: '95',
        },
      ],
    }
    const market = success(verifyIntradaySnapshot({ ...request, archiveWatermarks }, mixedPrecisionRows))
    const decision = success(decideOpeningDrive({ snapshot: market, session }, protocol))

    expect(decision.signals.find((signal) => signal.symbol === 'AMD')).toMatchObject({
      breakoutTradeObservedAt: '2026-08-18T13:35:01.500999999Z',
      eligible: false,
    })
    expect(decision.selectedSymbols).not.toContain('AMD')
  })

  test('computes exact boundary signals from fixed-point prices', () => {
    const protocol = success(decodeDefaultOpeningDriveProtocol())
    const rows = makeRows()
    const boundaryRows = {
      ...rows,
      bars: rows.bars.map((bar) =>
        bar.symbol === 'AMD' ? { ...bar, open: '100', high: '100', low: '99', close: '100', vwap: '100' } : bar,
      ),
      quotes: rows.quotes.map((quote) =>
        quote.symbol === 'AMD' ? { ...quote, bid_price: '100.224775', ask_price: '100.375225' } : quote,
      ),
      trades: rows.trades.map((trade) => (trade.symbol === 'AMD' ? { ...trade, price: '100.05' } : trade)),
    }
    const market = success(verifyIntradaySnapshot(request, boundaryRows))
    const decision = success(decideOpeningDrive({ snapshot: market, session }, protocol))

    expect(decision.signals.find((signal) => signal.symbol === 'AMD')).toMatchObject({
      openingReturnBps: 30,
      breakoutBps: 5,
      spreadBps: 15,
      rangeLocationPpm: 1_000_000,
      eligible: true,
    })
  })

  test('rejects a session whose flatten boundary leaves no entry window', () => {
    const protocol = success(decodeDefaultOpeningDriveProtocol())

    expect(
      error(
        decideOpeningDrive(
          {
            snapshot: snapshot(),
            session: { ...session, closeAt: '2026-08-18T14:05:00.000Z' },
          },
          protocol,
        ),
      ),
    ).toMatchObject({ reason: 'snapshot-window' })
  })

  test('rejects session-close timestamps without an explicit canonical UTC offset', () => {
    const protocol = success(decodeDefaultOpeningDriveProtocol())

    expect(
      error(
        decideOpeningDrive(
          {
            snapshot: snapshot(),
            session: { ...session, closeAt: '2026-08-18T20:00:00.000' },
          },
          protocol,
        ),
      ),
    ).toMatchObject({ reason: 'snapshot-window' })
  })

  test('fails closed on snapshot identity, window, coverage, and non-finite quote drift', () => {
    const protocol = success(decodeDefaultOpeningDriveProtocol())
    const market = snapshot()
    expect(
      error(
        decideOpeningDrive(
          { snapshot: { ...market, manifest: { ...market.manifest, universeId: 'other' } }, session },
          protocol,
        ),
      ),
    ).toMatchObject({ reason: 'snapshot-identity' })
    expect(
      error(
        decideOpeningDrive(
          { snapshot: { ...market, manifest: { ...market.manifest, rangeEndAt: request.rangeStartAt } }, session },
          protocol,
        ),
      ),
    ).toMatchObject({ reason: 'snapshot-window' })
    expect(
      error(decideOpeningDrive({ snapshot: { ...market, bars: market.bars.slice(1) }, session }, protocol)),
    ).toMatchObject({ reason: 'snapshot-coverage' })
    expect(
      error(
        decideOpeningDrive({ snapshot: market, session: { ...session, openAt: '2026-08-18T14:00:00.000Z' } }, protocol),
      ),
    ).toMatchObject({ reason: 'snapshot-window' })
    expect(
      error(decideOpeningDrive({ snapshot: market, session: { ...session, calendarHash: '0'.repeat(64) } }, protocol)),
    ).toMatchObject({ reason: 'snapshot-window' })

    const firstBar = market.bars[0]
    if (firstBar === undefined) throw new Error('opening bar fixture is missing')
    expect(
      error(
        decideOpeningDrive(
          { snapshot: { ...market, bars: [{ ...firstBar, final: false }, ...market.bars.slice(1)] }, session },
          protocol,
        ),
      ),
    ).toMatchObject({ reason: 'snapshot-coverage' })

    const quote = market.latestQuotes['AMD']
    if (quote === undefined) throw new Error('AMD quote fixture is missing')
    const reverifiedFailure = error(
      decideOpeningDrive(
        {
          snapshot: {
            ...market,
            latestQuotes: { ...market.latestQuotes, AMD: { ...quote, askPrice: quote.askPrice + 0.01 } },
          },
          session,
        },
        protocol,
      ),
    )
    expect(reverifiedFailure).toMatchObject({
      reason: 'snapshot-coverage',
      cause: { _tag: 'IntradaySnapshotFailure' },
    })

    const firstTrade = market.trades[0]
    if (firstTrade === undefined) throw new Error('opening trade fixture is missing')
    expect(
      error(
        decideOpeningDrive(
          {
            snapshot: {
              ...market,
              trades: [{ ...firstTrade, sourceOffset: 'not-an-integer' }, ...market.trades],
            },
            session,
          },
          protocol,
        ),
      ),
    ).toMatchObject({ reason: 'snapshot-coverage', cause: { _tag: 'IntradaySnapshotFailure' } })

    expect(
      error(
        decideOpeningDrive(
          {
            snapshot: {
              ...market,
              bars: [{ ...firstBar, vwap: firstBar.high + 1 }, ...market.bars.slice(1)],
            },
            session,
          },
          protocol,
        ),
      ),
    ).toMatchObject({ reason: 'snapshot-coverage' })
  })

  test('exports one intraday long-only strategy definition over the same pure decision', () => {
    const protocol = success(decodeDefaultOpeningDriveProtocol())
    const definition = makeOpeningDriveDefinition(protocol)
    expect(definition.name).toBe('opening-drive-momentum')
    expect(definition.holdingPeriod).toBe('INTRADAY')
    expect(success(definition.decide({ market: marketContext() }))).toEqual(
      success(decideOpeningDrive(marketContext(), protocol)),
    )
  })
})
