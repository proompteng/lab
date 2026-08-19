import { describe, expect, test } from 'bun:test'
import { Result } from 'effect'

import { sha256 } from '../../hash'
import {
  verifyIntradaySnapshot,
  type IntradayMarketSnapshot,
  type IntradaySnapshotRequest,
  type IntradaySnapshotRows,
} from '../../market-data'
import type { IsoDate } from '../../types'
import type { OpeningDriveMarketContext } from './model'
import { qualifyOpeningDrive } from './qualification'
import { decodeDefaultOpeningDriveProtocol, defaultOpeningDriveProtocolDocument } from './protocol'

const symbols = defaultOpeningDriveProtocolDocument.universe
const barsTopic = 'torghut.bars.1m.v1'
const quotesTopic = 'torghut.quotes.v1'
const tradesTopic = 'torghut.trades.v1'
const success = <A, E>(result: Result.Result<A, E>): A => Result.getOrThrow(result)
const error = <A, E>(result: Result.Result<A, E>): E => Result.getOrThrow(Result.flip(result))

const dateAt = (ordinal: number): IsoDate =>
  new Date(Date.UTC(2026, 0, 2 + ordinal)).toISOString().slice(0, 10) as IsoDate

const timesFor = (sessionDate: IsoDate) => ({
  open: `${sessionDate}T14:30:00.000Z`,
  openingEnd: `${sessionDate}T14:35:00.000Z`,
  openingObserved: `${sessionDate}T14:35:30.000Z`,
  exitStart: `${sessionDate}T20:29:00.000Z`,
  exitEnd: `${sessionDate}T20:30:00.000Z`,
  exitObserved: `${sessionDate}T20:30:30.000Z`,
  close: `${sessionDate}T21:00:00.000Z`,
})

const openingMoveBySymbol = (symbol: string): number => {
  if (symbol === 'AMD') return 0.01
  if (symbol === 'AVGO') return 0.008
  if (symbol === 'NVDA') return 0.007
  return 0.001
}

const requestFor = (
  sessionDate: IsoDate,
  rangeStartAt: string,
  rangeEndAt: string,
  observedAt: string,
): IntradaySnapshotRequest => ({
  sessionDate,
  rangeStartAt,
  rangeEndAt,
  observedAt,
  universeId: defaultOpeningDriveProtocolDocument.universeId,
  universeSymbolHash: sha256(symbols.join(',')),
  universe: symbols,
  feed: 'iex',
  delayClass: 'real_time_exchange_only',
  sourceTopics: { bars: barsTopic, quotes: quotesTopic, trades: tradesTopic },
  maximumQuoteAgeMs: defaultOpeningDriveProtocolDocument.maximumQuoteAgeMs,
  minimumWatermarkLagMs: 30_000,
  archiveWatermarks: [
    { sourceTopic: barsTopic, sourcePartition: 0, inclusiveLastOffset: '1000000' },
    { sourceTopic: quotesTopic, sourcePartition: 0, inclusiveLastOffset: '1000000' },
    { sourceTopic: tradesTopic, sourcePartition: 0, inclusiveLastOffset: '1000000' },
  ],
})

interface SnapshotRowsOptions {
  readonly sessionDate: IsoDate
  readonly phase: 'opening' | 'exit'
  readonly candidateMove: number
  readonly benchmarkMove: number
}

const rowsFor = ({ sessionDate, phase, candidateMove, benchmarkMove }: SnapshotRowsOptions): IntradaySnapshotRows => {
  const times = timesFor(sessionDate)
  const rangeStart = phase === 'opening' ? times.open : times.exitStart
  const rangeEnd = phase === 'opening' ? times.openingEnd : times.exitEnd
  const minutes = phase === 'opening' ? 5 : 1
  let offset = 1
  const bars = symbols.flatMap((symbol, symbolIndex) => {
    const openingPrice = 100 + symbolIndex
    const openingMidpoint = openingPrice * (1 + openingMoveBySymbol(symbol))
    const move = symbol === 'AMD' || symbol === 'AVGO' ? candidateMove : benchmarkMove
    const phasePrice = phase === 'opening' ? openingPrice : openingMidpoint * (1 + move)
    return Array.from({ length: minutes }, (_, minute) => {
      const eventAt = new Date(Date.parse(rangeStart) + minute * 60_000).toISOString()
      const ingestedAt = new Date(Date.parse(eventAt) + 60_000).toISOString()
      return {
        provider: 'alpaca',
        universe_id: defaultOpeningDriveProtocolDocument.universeId,
        universe_symbol_hash: sha256(symbols.join(',')),
        feed: 'iex',
        market_session: 'regular',
        delay_class: 'real_time_exchange_only',
        symbol,
        event_at: eventAt,
        ingested_at: ingestedAt,
        source_topic: barsTopic,
        source_partition: '0',
        source_offset: String(offset++),
        schema_version: '1',
        channel: 'bars',
        is_final: '1',
        open: String(phasePrice),
        high: String(phase === 'opening' ? openingPrice * 1.011 : phasePrice * 1.001),
        low: String(phase === 'opening' ? openingPrice * 0.995 : phasePrice * 0.999),
        close: String(phase === 'opening' ? openingPrice * (1 + minute * 0.001) : phasePrice),
        volume: '1000',
        vwap: String(phasePrice),
        trade_count: '100',
      }
    })
  })
  const quotes = symbols.map((symbol, symbolIndex) => {
    const openingPrice = 100 + symbolIndex
    const openingMidpoint = openingPrice * (1 + openingMoveBySymbol(symbol))
    const move = symbol === 'AMD' || symbol === 'AVGO' ? candidateMove : benchmarkMove
    const midpoint = phase === 'opening' ? openingMidpoint : openingMidpoint * (1 + move)
    return {
      provider: 'alpaca',
      universe_id: defaultOpeningDriveProtocolDocument.universeId,
      universe_symbol_hash: sha256(symbols.join(',')),
      feed: 'iex',
      market_session: 'regular',
      delay_class: 'real_time_exchange_only',
      symbol,
      event_at: new Date(Date.parse(rangeEnd) + 15_000).toISOString(),
      ingested_at: new Date(Date.parse(rangeEnd) + 16_000).toISOString(),
      source_topic: quotesTopic,
      source_partition: '0',
      source_offset: String(offset++),
      schema_version: '1',
      bid_price: String(midpoint - 0.01),
      bid_size: '1000',
      ask_price: String(midpoint + 0.01),
      ask_size: '1000',
    }
  })
  const trades = symbols.map((symbol, symbolIndex) => ({
    provider: 'alpaca',
    universe_id: defaultOpeningDriveProtocolDocument.universeId,
    universe_symbol_hash: sha256(symbols.join(',')),
    feed: 'iex',
    market_session: 'regular',
    delay_class: 'real_time_exchange_only',
    symbol,
    event_at: new Date(Date.parse(rangeEnd) + 10_000).toISOString(),
    ingested_at: new Date(Date.parse(rangeEnd) + 11_000).toISOString(),
    source_topic: tradesTopic,
    source_partition: '0',
    source_offset: String(offset++),
    schema_version: '1',
    price: quotes[symbolIndex]?.bid_price ?? '100',
    size: '10',
  }))
  return {
    archiveWatermarks: [
      { source_topic: barsTopic, source_partition: '0', inclusive_last_offset: '1000000' },
      { source_topic: quotesTopic, source_partition: '0', inclusive_last_offset: '1000000' },
      { source_topic: tradesTopic, source_partition: '0', inclusive_last_offset: '1000000' },
    ],
    bars,
    quotes,
    trades,
  }
}

const snapshotFor = (options: SnapshotRowsOptions): IntradayMarketSnapshot => {
  const times = timesFor(options.sessionDate)
  const request =
    options.phase === 'opening'
      ? requestFor(options.sessionDate, times.open, times.openingEnd, times.openingObserved)
      : requestFor(options.sessionDate, times.exitStart, times.exitEnd, times.exitObserved)
  return success(verifyIntradaySnapshot(request, rowsFor(options)))
}

const replayInput = (ordinal: number, candidateMove: number, benchmarkMove = 0) => {
  const sessionDate = dateAt(ordinal)
  const times = timesFor(sessionDate)
  const opening = snapshotFor({ sessionDate, phase: 'opening', candidateMove, benchmarkMove })
  const exit = snapshotFor({ sessionDate, phase: 'exit', candidateMove, benchmarkMove })
  const context: OpeningDriveMarketContext = Object.freeze({
    snapshot: opening,
    session: Object.freeze({
      sessionDate,
      openAt: times.open,
      closeAt: times.close,
      calendarHash: sha256(`verified-calendar-${sessionDate}`),
    }),
  })
  return Object.freeze({ opening: context, exit })
}

const binding = (priorTrialCount = 0) => ({
  sourceRevision: 'a'.repeat(40),
  strategyBehaviorHash: sha256('reviewed-opening-drive-strategy-source'),
  priorTrialReceiptHashes: Array.from({ length: priorTrialCount }, (_, ordinal) =>
    sha256(`prior-${ordinal}`),
  ).toSorted(),
})

describe('opening-drive after-cost qualification', () => {
  test('qualifies deterministic positive replay only after conservative quote, slippage, fee, and sample gates', () => {
    const protocol = success(decodeDefaultOpeningDriveProtocol())
    const sessions = Array.from({ length: 60 }, (_, ordinal) => replayInput(ordinal, 0.02))
    const first = success(qualifyOpeningDrive({ sessions, protocol, binding: binding() }))
    const second = success(qualifyOpeningDrive({ sessions: structuredClone(sessions), protocol, binding: binding() }))

    expect(second).toEqual(first)
    expect(first.receipt).toMatchObject({
      verdict: 'QUALIFIED',
      sessionCount: 60,
      tradeSessionCount: 60,
      candidateOrdinal: 1,
      priorTrialCount: 0,
      reasonCodes: [],
    })
    expect(first.receipt.candidateAnnualizedReturnLowerBound).toBeGreaterThan(0)
    expect(first.receipt.excessAnnualizedReturnLowerBound).toBeGreaterThan(0)
    expect(BigInt(first.receipt.candidateQuotedSpreadCostMicros)).toBeGreaterThan(0n)
    expect(BigInt(first.receipt.candidateSlippageCostMicros)).toBeGreaterThan(0n)
    expect(BigInt(first.receipt.candidateFeeCostMicros)).toBeGreaterThan(0n)
    expect(BigInt(first.receipt.candidateNetPnlMicros)).toBeGreaterThan(0n)
    expect(first.sessions.every((session) => session.candidate.executedSymbols.length === 2)).toBe(true)
  })

  test('reports the current 24-session horizon as insufficient without erasing multiplicity', () => {
    const protocol = success(decodeDefaultOpeningDriveProtocol())
    const result = success(
      qualifyOpeningDrive({
        sessions: Array.from({ length: 24 }, (_, ordinal) => replayInput(ordinal, 0.02)),
        protocol,
        binding: binding(20),
      }),
    )

    expect(result.receipt).toMatchObject({
      verdict: 'INSUFFICIENT',
      sessionCount: 24,
      tradeSessionCount: 24,
      candidateOrdinal: 21,
      priorTrialCount: 20,
      bootstrapTailSamples: 23,
      reasonCodes: ['session-count'],
    })
    expect(result.receipt.adjustedOneSidedAlpha).toBeCloseTo(0.05 / 21, 12)
  })

  test('rejects a sufficiently observed strategy that loses after all modeled costs', () => {
    const protocol = success(decodeDefaultOpeningDriveProtocol())
    const result = success(
      qualifyOpeningDrive({
        sessions: Array.from({ length: 60 }, (_, ordinal) => replayInput(ordinal, -0.02)),
        protocol,
        binding: binding(),
      }),
    )

    expect(result.receipt.verdict).toBe('REJECTED')
    expect(result.receipt.reasonCodes).toContain('candidate-annualized-return-lower-bound')
    expect(result.receipt.reasonCodes).toContain('candidate-total-net-pnl')
    expect(BigInt(result.receipt.candidateNetPnlMicros)).toBeLessThan(0n)
  })

  test('fails closed on snapshot mutation, reuse, and non-canonical session order', () => {
    const protocol = success(decodeDefaultOpeningDriveProtocol())
    const first = replayInput(0, 0.02)
    const exitQuote = first.exit.latestQuotes['AMD']
    if (exitQuote === undefined) throw new Error('AMD exit quote fixture is missing')
    const mutated = {
      ...first,
      exit: {
        ...first.exit,
        latestQuotes: { ...first.exit.latestQuotes, AMD: { ...exitQuote, bidPrice: exitQuote.bidPrice + 1 } },
      },
    }
    expect(error(qualifyOpeningDrive({ sessions: [mutated], protocol, binding: binding() }))).toMatchObject({
      reason: 'snapshot-binding',
    })
    expect(error(qualifyOpeningDrive({ sessions: [first, first], protocol, binding: binding() }))).toMatchObject({
      reason: 'session-order',
    })
    expect(
      error(
        qualifyOpeningDrive({
          sessions: [replayInput(1, 0.02), first],
          protocol,
          binding: binding(),
        }),
      ),
    ).toMatchObject({ reason: 'session-order' })
    expect(
      error(
        qualifyOpeningDrive({
          sessions: [first],
          protocol,
          binding: { ...binding(), priorTrialReceiptHashes: ['f'.repeat(64), '0'.repeat(64)] },
        }),
      ),
    ).toMatchObject({ reason: 'trial-lineage' })
  })
})
