import { describe, expect, test } from 'bun:test'
import { Result, Schema } from 'effect'

import { makeExecutionCalendarObservation } from '../../cycle'
import { canonicalHashV1, sha256 } from '../../hash'
import { verifyIntradaySnapshot, type IntradaySnapshotRows } from '../../market-data'
import { strictParseOptions } from '../../schemas'
import { decideIntradayMomentum, makeIntradayMomentumDefinition } from './decision'
import { IntradayMomentumTargetPortfolioSchema, type IntradayMomentumRejectionReason } from './model'
import {
  decodeDefaultIntradayMomentumProtocol,
  decodeIntradayMomentumProtocol,
  defaultIntradayMomentumProtocolDocument,
  hashIntradayMomentumProtocol,
} from './protocol'

const symbols = defaultIntradayMomentumProtocolDocument.universe
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
const executionCalendar = Result.getOrThrow(
  makeExecutionCalendarObservation({
    schemaVersion: calendar.schemaVersion,
    source: calendar.source,
    ...calendar.sessions[0]!,
  }),
)
const session = Object.freeze({
  sessionDate: '2026-08-18' as const,
  openAt: calendar.sessions[0]!.openAt,
  closeAt: calendar.sessions[0]!.closeAt,
  calendarHash: executionCalendar.executionCalendarHash,
})

const success = <A, E>(result: Result.Result<A, E>): A => Result.getOrThrow(result)
const error = <A, E>(result: Result.Result<A, E>): E => Result.getOrThrow(Result.flip(result))
const instant = (epoch: number): string => new Date(epoch).toISOString()

interface FixtureOptions {
  readonly rangeEndAt: string
  readonly returnBps?: Readonly<Record<string, number>>
  readonly quoteAgeMs?: number
  readonly observedLagMs?: number
  readonly spreadBps?: number
  readonly displayedSize?: number
  readonly omitFirstBarFor?: string
}

const marketContextAt = (options: FixtureOptions) => {
  const rangeEnd = Date.parse(options.rangeEndAt)
  const rangeStart = rangeEnd - defaultIntradayMomentumProtocolDocument.lookbackMinutes * 60_000
  const observedLagMs = options.observedLagMs ?? defaultIntradayMomentumProtocolDocument.decisionDelaySeconds * 1_000
  const observedAt = instant(rangeEnd + observedLagMs)
  let barOffset = 1
  let quoteOffset = 1
  let tradeOffset = 1
  const bars = symbols.flatMap((symbol, symbolIndex) => {
    const reference = 100 + symbolIndex
    return Array.from({ length: defaultIntradayMomentumProtocolDocument.lookbackMinutes }, (_, minute) => ({
      provider: 'alpaca',
      universe_id: defaultIntradayMomentumProtocolDocument.universeId,
      universe_symbol_hash: defaultIntradayMomentumProtocolDocument.universeSymbolHash,
      feed: defaultIntradayMomentumProtocolDocument.feed,
      market_session: 'regular',
      delay_class: defaultIntradayMomentumProtocolDocument.delayClass,
      symbol,
      event_at: instant(rangeStart + minute * 60_000),
      ingested_at: instant(rangeStart + (minute + 1) * 60_000),
      source_topic: barsTopic,
      source_partition: '0',
      source_offset: String(barOffset++),
      schema_version: '1',
      channel: 'bars',
      is_final: '1',
      open: String(reference),
      high: String(reference * 1.002),
      low: String(reference * 0.999),
      close: String(reference * 1.001),
      volume: '1000',
      vwap: String(reference),
      trade_count: '100',
    })).filter((_, index) => options.omitFirstBarFor !== symbol || index !== 0)
  })
  const quoteEventAt = rangeEnd + observedLagMs - (options.quoteAgeMs ?? 1_000)
  const quotes = symbols.map((symbol, symbolIndex) => {
    const reference = 100 + symbolIndex
    const returnBps = options.returnBps?.[symbol] ?? 5
    const midpoint = reference * (1 + returnBps / 10_000)
    const halfSpread = (midpoint * (options.spreadBps ?? 2)) / 20_000
    return {
      provider: 'alpaca',
      universe_id: defaultIntradayMomentumProtocolDocument.universeId,
      universe_symbol_hash: defaultIntradayMomentumProtocolDocument.universeSymbolHash,
      feed: defaultIntradayMomentumProtocolDocument.feed,
      market_session: 'regular',
      delay_class: defaultIntradayMomentumProtocolDocument.delayClass,
      symbol,
      event_at: instant(quoteEventAt),
      ingested_at: instant(quoteEventAt + 100),
      source_topic: quotesTopic,
      source_partition: '0',
      source_offset: String(quoteOffset++),
      schema_version: '1',
      latest_payload_variants: '1',
      bid_price: String(midpoint - halfSpread),
      bid_size: String(options.displayedSize ?? 100),
      ask_price: String(midpoint + halfSpread),
      ask_size: String(options.displayedSize ?? 100),
    }
  })
  const trades = symbols.map((symbol, symbolIndex) => {
    const reference = 100 + symbolIndex
    const returnBps = options.returnBps?.[symbol] ?? 5
    return {
      provider: 'alpaca',
      universe_id: defaultIntradayMomentumProtocolDocument.universeId,
      universe_symbol_hash: defaultIntradayMomentumProtocolDocument.universeSymbolHash,
      feed: defaultIntradayMomentumProtocolDocument.feed,
      market_session: 'regular',
      delay_class: defaultIntradayMomentumProtocolDocument.delayClass,
      symbol,
      event_at: instant(quoteEventAt),
      ingested_at: instant(quoteEventAt + 100),
      source_topic: tradesTopic,
      source_partition: '0',
      source_offset: String(tradeOffset++),
      schema_version: '1',
      latest_payload_variants: '1',
      price: String(reference * (1 + returnBps / 10_000)),
      size: '10',
    }
  })
  const archiveWatermarks = [
    { sourceTopic: barsTopic, sourcePartition: 0, inclusiveLastOffset: String(barOffset - 1) },
    { sourceTopic: quotesTopic, sourcePartition: 0, inclusiveLastOffset: String(quoteOffset - 1) },
    { sourceTopic: tradesTopic, sourcePartition: 0, inclusiveLastOffset: String(tradeOffset - 1) },
  ] as const
  const request = {
    sessionDate: '2026-08-18',
    calendar,
    rangeStartAt: instant(rangeStart),
    rangeEndAt: options.rangeEndAt,
    observedAt,
    universeId: defaultIntradayMomentumProtocolDocument.universeId,
    universeSymbolHash: sha256(symbols.join(',')),
    universe: symbols,
    feed: defaultIntradayMomentumProtocolDocument.feed,
    delayClass: defaultIntradayMomentumProtocolDocument.delayClass,
    sourceTopics: { bars: barsTopic, quotes: quotesTopic, trades: tradesTopic },
    maximumQuoteAgeMs: defaultIntradayMomentumProtocolDocument.maximumQuoteAgeMs,
    minimumWatermarkLagMs: defaultIntradayMomentumProtocolDocument.decisionDelaySeconds * 1_000,
    archiveWatermarks,
  } as const
  const rows = {
    archiveWatermarks: archiveWatermarks.map((watermark) => ({
      source_topic: watermark.sourceTopic,
      source_partition: String(watermark.sourcePartition),
      inclusive_last_offset: watermark.inclusiveLastOffset,
    })),
    bars,
    quotes,
    trades,
  } satisfies IntradaySnapshotRows
  return Object.freeze({ snapshot: success(verifyIntradaySnapshot(request, rows)), session })
}

const qualifyingReturns = Object.freeze({ AMD: 50, AVGO: 45, NVDA: 40 })

describe('intraday momentum strategy', () => {
  test('binds one small result-blind protocol to the full-session execution model', () => {
    const protocol = success(decodeDefaultIntradayMomentumProtocol())
    expect(protocol).toEqual(defaultIntradayMomentumProtocolDocument)
    expect(success(hashIntradayMomentumProtocol(protocol))).toMatch(/^[0-9a-f]{64}$/)
    expect(
      error(
        decodeIntradayMomentumProtocol({
          ...defaultIntradayMomentumProtocolDocument,
          warmupMinutesAfterOpen: 10,
        }),
      ),
    ).toMatchObject({ _tag: 'IntradayMomentumProtocolDecodeError' })
    expect(
      error(
        decodeIntradayMomentumProtocol({
          ...defaultIntradayMomentumProtocolDocument,
          entryCutoffMinutesBeforeClose: 20,
        }),
      ),
    ).toMatchObject({ _tag: 'IntradayMomentumProtocolDecodeError' })
    expect(
      error(
        decodeIntradayMomentumProtocol({
          ...defaultIntradayMomentumProtocolDocument,
          executionModel: {
            ...defaultIntradayMomentumProtocolDocument.executionModel,
            order: {
              ...defaultIntradayMomentumProtocolDocument.executionModel.order,
              warmupAfterOpenMs: 31 * 60_000,
            },
          },
        }),
      ),
    ).toMatchObject({ _tag: 'IntradayMomentumProtocolDecodeError' })
    expect(
      error(
        decodeIntradayMomentumProtocol({
          ...defaultIntradayMomentumProtocolDocument,
          warmupMinutesAfterOpen: 200,
          decisionDelaySeconds: 1_200,
          entryCutoffMinutesBeforeClose: 170,
          executionModel: {
            ...defaultIntradayMomentumProtocolDocument.executionModel,
            order: {
              ...defaultIntradayMomentumProtocolDocument.executionModel.order,
              warmupAfterOpenMs: 200 * 60_000,
              submissionCutoffBeforeCloseMs: 170 * 60_000,
            },
          },
        }),
      ),
    ).toMatchObject({ _tag: 'IntradayMomentumProtocolDecodeError' })
    expect(
      error(
        decodeIntradayMomentumProtocol({
          ...defaultIntradayMomentumProtocolDocument,
          maximumQuoteAgeMs: 999,
        }),
      ),
    ).toMatchObject({ _tag: 'IntradayMomentumProtocolDecodeError' })
  })

  test.each([
    ['late morning', '2026-08-18T16:00:00.000Z'],
    ['afternoon', '2026-08-18T18:30:00.000Z'],
  ])('evaluates an eligible rolling window in the %s', (_, rangeEndAt) => {
    const protocol = success(decodeDefaultIntradayMomentumProtocol())
    const decision = success(
      decideIntradayMomentum(marketContextAt({ rangeEndAt, returnBps: qualifyingReturns }), protocol),
    )
    expect(decision.selectedSymbols).toEqual(['AMD', 'AVGO', 'NVDA'])
    expect(decision.targetWeights).toMatchObject({ AMD: 0.1, AVGO: 0.1, NVDA: 0.1 })
    expect(decision.signals.find(({ symbol }) => symbol === 'AMD')).toMatchObject({
      eligible: true,
      rejectionReasons: [],
      rank: 1,
    })
    expect(
      Schema.decodeUnknownResult(IntradayMomentumTargetPortfolioSchema, strictParseOptions)(decision),
    ).toMatchObject({ _tag: 'Success' })
  })

  test('rejects the old opening-only decision window instead of silently reusing it all day', () => {
    const protocol = success(decodeDefaultIntradayMomentumProtocol())
    expect(
      error(
        decideIntradayMomentum(
          marketContextAt({ rangeEndAt: '2026-08-18T13:50:00.000Z', returnBps: qualifyingReturns }),
          protocol,
        ),
      ),
    ).toMatchObject({ reason: 'snapshot-window' })
  })

  test('fails closed at the entry cutoff', () => {
    const protocol = success(decodeDefaultIntradayMomentumProtocol())
    expect(
      error(
        decideIntradayMomentum(
          marketContextAt({ rangeEndAt: '2026-08-18T19:00:00.000Z', returnBps: qualifyingReturns }),
          protocol,
        ),
      ),
    ).toMatchObject({ reason: 'snapshot-window' })
  })

  test.each([
    ['stale market data', { observedLagMs: 2_500, quoteAgeMs: 2_500 }, 'market-data-freshness'],
    ['wide spread', { spreadBps: 16 }, 'spread'],
    ['empty displayed book', { displayedSize: 0 }, 'displayed-liquidity'],
  ])('rejects %s without rejecting fresh peers', (_, overrides, expectedReason) => {
    const protocol = success(decodeDefaultIntradayMomentumProtocol())
    const decision = success(
      decideIntradayMomentum(
        marketContextAt({
          rangeEndAt: '2026-08-18T18:00:00.000Z',
          returnBps: qualifyingReturns,
          ...overrides,
        }),
        protocol,
      ),
    )
    expect(decision.selectedSymbols).toEqual([])
    expect(
      decision.signals.every(({ rejectionReasons }) =>
        rejectionReasons.includes(expectedReason as IntradayMomentumRejectionReason),
      ),
    ).toBe(true)
  })

  test('requires a complete rolling baseline for every configured liquid symbol', () => {
    const protocol = success(decodeDefaultIntradayMomentumProtocol())
    expect(
      error(
        decideIntradayMomentum(
          marketContextAt({
            rangeEndAt: '2026-08-18T18:00:00.000Z',
            returnBps: qualifyingReturns,
            omitFirstBarFor: 'AMD',
          }),
          protocol,
        ),
      ),
    ).toMatchObject({ reason: 'snapshot-coverage', symbol: 'AMD' })
  })

  test('exposes one pure INTRADAY definition', () => {
    const protocol = success(decodeDefaultIntradayMomentumProtocol())
    const definition = makeIntradayMomentumDefinition(protocol)
    expect(definition).toMatchObject({ name: 'intraday-momentum', holdingPeriod: 'INTRADAY', parameters: protocol })
    expect(
      success(
        definition.decide({
          market: marketContextAt({ rangeEndAt: '2026-08-18T18:30:00.000Z', returnBps: qualifyingReturns }),
        }),
      ).selectedSymbols,
    ).toEqual(['AMD', 'AVGO', 'NVDA'])
  })
})
