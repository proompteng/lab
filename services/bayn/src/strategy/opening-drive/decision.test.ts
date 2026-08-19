import { describe, expect, test } from 'bun:test'
import { Result } from 'effect'

import { sha256 } from '../../hash'
import { verifyIntradaySnapshot, type IntradaySnapshotRows } from '../../market-data'
import { decideOpeningDrive, makeOpeningDriveDefinition } from './decision'
import {
  decodeDefaultOpeningDriveProtocol,
  decodeOpeningDriveProtocol,
  defaultOpeningDriveProtocolHash,
  defaultOpeningDriveProtocolDocument,
  hashOpeningDriveProtocol,
} from './protocol'

const symbols = defaultOpeningDriveProtocolDocument.universe
const barsTopic = 'torghut.bars.1m.v1'
const quotesTopic = 'torghut.quotes.v1'
const tradesTopic = 'torghut.trades.v1'

const request = {
  sessionDate: '2026-08-18',
  rangeStartAt: '2026-08-18T13:30:00.000Z',
  rangeEndAt: '2026-08-18T13:35:00.000Z',
  observedAt: '2026-08-18T13:35:02.000Z',
  universeId: defaultOpeningDriveProtocolDocument.universeId,
  universeSymbolHash: sha256(symbols.join(',')),
  universe: symbols,
  feed: 'sip',
  delayClass: 'real_time_consolidated',
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

const makeRows = (returnOverride?: number): IntradaySnapshotRows => {
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
        volume: '1000',
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
  return { archiveWatermarks, bars, quotes, trades }
}

const snapshot = (returnOverride?: number) => success(verifyIntradaySnapshot(request, makeRows(returnOverride)))
const session = Object.freeze({
  sessionDate: request.sessionDate,
  openAt: request.rangeStartAt,
  closeAt: '2026-08-18T20:00:00.000Z',
  calendarHash: sha256('verified-2026-08-18-exchange-session'),
})
const marketContext = (returnOverride?: number) => Object.freeze({ snapshot: snapshot(returnOverride), session })

describe('opening-drive momentum strategy', () => {
  test('decodes one frozen result-blind consolidated protocol', () => {
    const protocol = success(decodeDefaultOpeningDriveProtocol())
    expect(protocol).toEqual(defaultOpeningDriveProtocolDocument)
    expect(success(hashOpeningDriveProtocol(protocol))).toBe(defaultOpeningDriveProtocolHash)
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

  test('does not enter on opening momentum without a confirmed range breakout', () => {
    const protocol = success(decodeDefaultOpeningDriveProtocol())
    const decision = success(decideOpeningDrive(marketContext(0.01), protocol))

    expect(decision.selectedSymbols).toEqual([])
    expect(decision.signals.every((signal) => signal.rejectionReasons.includes('breakout'))).toBe(true)
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
    const market = snapshot()
    const amdTrade = market.trades.find((trade) => trade.symbol === 'AMD')
    if (amdTrade === undefined) throw new Error('AMD trade fixture is missing')
    const trades = [...market.trades, { ...amdTrade, sourceOffset: '999', price: amdTrade.price * 0.95 }]
    const decision = success(
      decideOpeningDrive(
        {
          snapshot: {
            ...market,
            trades,
            manifest: { ...market.manifest, tradeCount: trades.length },
          },
          session,
        },
        protocol,
      ),
    )

    expect(decision.selectedSymbols).not.toContain('AMD')
    expect(decision.signals.find((signal) => signal.symbol === 'AMD')?.rejectionReasons).toContain('breakout')
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
    expect(
      error(
        decideOpeningDrive(
          {
            snapshot: {
              ...market,
              latestQuotes: { ...market.latestQuotes, AMD: { ...quote, askPrice: Number.NaN } },
            },
            session,
          },
          protocol,
        ),
      ),
    ).toMatchObject({ reason: 'market-value', symbol: 'AMD', field: 'quote-ask' })

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
    ).toMatchObject({ reason: 'market-value', symbol: 'AMD', field: 'bar-vwap' })
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
