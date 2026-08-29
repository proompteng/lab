import { describe, expect, test } from 'bun:test'
import { Result, Schema } from 'effect'

import { makeExecutionCalendarObservation } from '../../cycle'
import { canonicalHashV1 } from '../../hash'
import { verifyIntradaySnapshot, type IntradayMarketSnapshot, type IntradaySnapshotRows } from '../../market-data'
import type { ArchiveVerifiedIntradayMarketSnapshot } from '../../market-data/intraday/model'
import { strictParseOptions } from '../../schemas'
import { decideIntradayMomentum, makeIntradayMomentumDefinition } from './decision'
import {
  compareIntradayMomentumSignalStrength,
  IntradayMomentumTargetPortfolioSchema,
  intradayMomentumPlanningTargetWeights,
  type IntradayMomentumRejectionReason,
} from './model'
import {
  decodeDefaultIntradayMomentumProtocol,
  decodeIntradayMomentumProtocol,
  defaultIntradayMomentumProtocolDocument,
  hashIntradayMomentumProtocol,
} from './protocol'

const symbols = [
  ...defaultIntradayMomentumProtocolDocument.candidateSymbols,
  defaultIntradayMomentumProtocolDocument.benchmarkSymbol,
].sort()
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

const success = <A, E>(result: Result.Result<A, E>): A => Result.getOrThrow(result)
const error = <A, E>(result: Result.Result<A, E>): E => Result.getOrThrow(Result.flip(result))
const instant = (epoch: number): string => new Date(epoch).toISOString()

interface FixtureOptions {
  readonly rangeEndAt: string
  readonly sessionCloseAt?: string
  readonly returnBps?: Readonly<Record<string, number>>
  readonly quoteAgeMs?: number
  readonly quoteAgeMsBySymbol?: Readonly<Record<string, number>>
  readonly snapshotMaximumQuoteAgeMs?: number
  readonly observedLagMs?: number
  readonly spreadBps?: number
  readonly displayedSize?: number
  readonly displayedSizeBySymbol?: Readonly<Record<string, number>>
  readonly bidSizeBySymbol?: Readonly<Record<string, number>>
  readonly askSizeBySymbol?: Readonly<Record<string, number>>
  readonly baselineEventAt?: string
  readonly evidenceEventAt?: string
  readonly omitFirstBarFor?: string
  readonly sourceTopics?: {
    readonly bars: string
    readonly quotes: string
    readonly trades: string
  }
}

const marketContextAt = (options: FixtureOptions) => {
  const boundCalendarMaterial = {
    ...calendarMaterial,
    sessions: [
      {
        ...calendarMaterial.sessions[0]!,
        closeAt: options.sessionCloseAt ?? calendarMaterial.sessions[0]!.closeAt,
      },
    ],
  }
  const boundCalendar = {
    ...boundCalendarMaterial,
    normalizedResponseHash: canonicalHashV1(boundCalendarMaterial),
  }
  const boundExecutionCalendar = success(
    makeExecutionCalendarObservation({
      schemaVersion: boundCalendar.schemaVersion,
      source: boundCalendar.source,
      ...boundCalendar.sessions[0]!,
    }),
  )
  const boundSession = Object.freeze({
    sessionDate: '2026-08-18' as const,
    openAt: boundCalendar.sessions[0]!.openAt,
    closeAt: boundCalendar.sessions[0]!.closeAt,
    calendarHash: boundExecutionCalendar.executionCalendarHash,
  })
  const rangeEnd = Date.parse(options.rangeEndAt)
  const rangeStart = rangeEnd - defaultIntradayMomentumProtocolDocument.lookbackMinutes * 60_000
  const observedLagMs = options.observedLagMs ?? defaultIntradayMomentumProtocolDocument.decisionDelaySeconds * 1_000
  const observedAt = instant(rangeEnd + observedLagMs)
  const sourceTopics = options.sourceTopics ?? { bars: barsTopic, quotes: quotesTopic, trades: tradesTopic }
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
      event_at: minute === 0 ? (options.baselineEventAt ?? instant(rangeStart)) : instant(rangeStart + minute * 60_000),
      ingested_at: instant(rangeStart + (minute + 1) * 60_000),
      source_topic: sourceTopics.bars,
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
  const defaultEvidenceEventAt = rangeEnd + observedLagMs - (options.quoteAgeMs ?? 1_000)
  const quotes = symbols.map((symbol, symbolIndex) => {
    const reference = 100 + symbolIndex
    const returnBps = options.returnBps?.[symbol] ?? 5
    const midpoint = reference * (1 + returnBps / 10_000)
    const halfSpread = (midpoint * (options.spreadBps ?? 2)) / 20_000
    const quoteEventAt =
      rangeEnd + observedLagMs - (options.quoteAgeMsBySymbol?.[symbol] ?? options.quoteAgeMs ?? 1_000)
    return {
      provider: 'alpaca',
      universe_id: defaultIntradayMomentumProtocolDocument.universeId,
      universe_symbol_hash: defaultIntradayMomentumProtocolDocument.universeSymbolHash,
      feed: defaultIntradayMomentumProtocolDocument.feed,
      market_session: 'regular',
      delay_class: defaultIntradayMomentumProtocolDocument.delayClass,
      symbol,
      event_at: options.evidenceEventAt ?? instant(quoteEventAt),
      ingested_at: options.evidenceEventAt ?? instant(quoteEventAt + 100),
      source_topic: sourceTopics.quotes,
      source_partition: '0',
      source_offset: String(quoteOffset++),
      schema_version: '1',
      latest_payload_variants: '1',
      bid_price: String(midpoint - halfSpread),
      bid_size: String(
        options.bidSizeBySymbol?.[symbol] ?? options.displayedSizeBySymbol?.[symbol] ?? options.displayedSize ?? 100,
      ),
      ask_price: String(midpoint + halfSpread),
      ask_size: String(
        options.askSizeBySymbol?.[symbol] ?? options.displayedSizeBySymbol?.[symbol] ?? options.displayedSize ?? 100,
      ),
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
      event_at: options.evidenceEventAt ?? instant(defaultEvidenceEventAt),
      ingested_at: options.evidenceEventAt ?? instant(defaultEvidenceEventAt + 100),
      source_topic: sourceTopics.trades,
      source_partition: '0',
      source_offset: String(tradeOffset++),
      schema_version: '1',
      latest_payload_variants: '1',
      price: String(reference * (1 + returnBps / 10_000)),
      size: '10',
    }
  })
  const archiveWatermarks = [
    { sourceTopic: sourceTopics.bars, sourcePartition: 0, inclusiveLastOffset: String(barOffset - 1) },
    { sourceTopic: sourceTopics.quotes, sourcePartition: 0, inclusiveLastOffset: String(quoteOffset - 1) },
    { sourceTopic: sourceTopics.trades, sourcePartition: 0, inclusiveLastOffset: String(tradeOffset - 1) },
  ] as const
  const request = {
    sessionDate: '2026-08-18',
    calendar: boundCalendar,
    rangeStartAt: instant(rangeStart),
    rangeEndAt: options.rangeEndAt,
    observedAt,
    universeId: defaultIntradayMomentumProtocolDocument.universeId,
    universeSymbolHash: defaultIntradayMomentumProtocolDocument.universeSymbolHash,
    universe: defaultIntradayMomentumProtocolDocument.universe,
    symbols,
    feed: defaultIntradayMomentumProtocolDocument.feed,
    delayClass: defaultIntradayMomentumProtocolDocument.delayClass,
    sourceTopics,
    maximumQuoteAgeMs: options.snapshotMaximumQuoteAgeMs ?? defaultIntradayMomentumProtocolDocument.maximumQuoteAgeMs,
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
  const snapshot = success(verifyIntradaySnapshot(request, rows)) as ArchiveVerifiedIntradayMarketSnapshot
  return Object.freeze({ snapshot, session: boundSession })
}

const qualifyingReturns = Object.freeze({ AAPL: 50, AMZN: 45, NVDA: 40, SPY: 5 })

describe('intraday momentum strategy', () => {
  test('requires an archive-verified snapshot at the pure decision boundary', () => {
    type DecisionSnapshot = Parameters<typeof decideIntradayMomentum>[0]['snapshot']
    const acceptsArchiveVerified: ArchiveVerifiedIntradayMarketSnapshot extends DecisionSnapshot ? true : false = true
    const rejectsEnvelopeOnly: IntradayMarketSnapshot extends DecisionSnapshot ? false : true = true

    expect({ acceptsArchiveVerified, rejectsEnvelopeOnly }).toEqual({
      acceptsArchiveVerified: true,
      rejectsEnvelopeOnly: true,
    })
  })

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
    expect(
      error(
        decodeIntradayMomentumProtocol({
          ...defaultIntradayMomentumProtocolDocument,
          maximumDecisionLagMs: 20 * 60_000,
        }),
      ),
    ).toMatchObject({ _tag: 'IntradayMomentumProtocolDecodeError' })
    expect(
      error(
        decodeIntradayMomentumProtocol({
          ...defaultIntradayMomentumProtocolDocument,
          candidateSymbols: ['AMD', ...defaultIntradayMomentumProtocolDocument.candidateSymbols],
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
    expect(decision.benchmark).toMatchObject({ symbol: 'SPY' })
    expect(decision.selectedSymbols).toEqual(['AAPL'])
    expect(decision.targetWeights).toMatchObject({ AAPL: 0.1, AMZN: 0, NVDA: 0 })
    expect(decision.signals.find(({ symbol }) => symbol === 'AAPL')).toMatchObject({
      eligible: true,
      benchmarkReturnBps: 5,
      excessReturnBps: 45,
      rejectionReasons: [],
      rank: 1,
    })
    expect(
      Schema.decodeUnknownResult(IntradayMomentumTargetPortfolioSchema, strictParseOptions)(decision),
    ).toMatchObject({ _tag: 'Success' })
    expect(
      Schema.decodeUnknownResult(
        IntradayMomentumTargetPortfolioSchema,
        strictParseOptions,
      )({
        ...decision,
        benchmark: { ...decision.benchmark, symbol: 'AAPL' },
      }),
    ).toMatchObject({ _tag: 'Failure' })
  })

  test('breaks equally scored signal ties by canonical code-unit order', () => {
    const protocol = success(decodeDefaultIntradayMomentumProtocol())
    const decision = success(
      decideIntradayMomentum(
        marketContextAt({ rangeEndAt: '2026-08-18T16:00:00.000Z', returnBps: qualifyingReturns }),
        protocol,
      ),
    )
    const signal = decision.signals.find(({ symbol }) => symbol === 'AAPL')!
    const mrvl = { ...signal, symbol: 'MRVL' }
    const mu = { ...signal, symbol: 'MU' }
    const localeCompare = Object.getOwnPropertyDescriptor(String.prototype, 'localeCompare')
    if (localeCompare === undefined) throw new Error('String.localeCompare descriptor is unavailable')

    try {
      Object.defineProperty(String.prototype, 'localeCompare', {
        configurable: true,
        value: () => {
          throw new Error('strategy ordering must not consult the process locale')
        },
      })
      expect([mu, mrvl].toSorted(compareIntradayMomentumSignalStrength).map(({ symbol }) => symbol)).toEqual([
        'MRVL',
        'MU',
      ])
    } finally {
      Object.defineProperty(String.prototype, 'localeCompare', localeCompare)
    }
  })

  test('applies the residual threshold before basis-point rounding', () => {
    const protocol = success(decodeDefaultIntradayMomentumProtocol())
    const decision = success(
      decideIntradayMomentum(
        marketContextAt({
          rangeEndAt: '2026-08-18T16:00:00.000Z',
          returnBps: { AAPL: 19.1, SPY: 9.9 },
        }),
        protocol,
      ),
    )

    expect(decision.signals.find(({ symbol }) => symbol === 'AAPL')).toMatchObject({
      lookbackReturnBps: 19,
      benchmarkReturnBps: 9,
      excessReturnBps: 9,
      eligible: false,
      rejectionReasons: expect.arrayContaining(['excess-return']),
    })
  })

  test('ranks eligible residual returns before basis-point rounding', () => {
    const protocol = success(decodeDefaultIntradayMomentumProtocol())
    const decision = success(
      decideIntradayMomentum(
        marketContextAt({
          rangeEndAt: '2026-08-18T16:00:00.000Z',
          returnBps: { AAPL: 20.1, AMZN: 20.9, SPY: 10 },
        }),
        protocol,
      ),
    )

    expect(decision.signals.find(({ symbol }) => symbol === 'AAPL')).toMatchObject({
      excessReturnBps: 10,
      eligible: true,
      rank: null,
    })
    expect(decision.signals.find(({ symbol }) => symbol === 'AMZN')).toMatchObject({
      excessReturnBps: 10,
      eligible: true,
      rank: 1,
    })
    expect(decision.selectedSymbols).toEqual(['AMZN'])
  })

  test('uses the bound early-close duration and rejects only impossible decision intervals', () => {
    const earlyCloseAt = '2026-08-18T17:00:00.000Z'
    const defaultProtocol = success(decodeDefaultIntradayMomentumProtocol())
    expect(
      success(
        decideIntradayMomentum(
          marketContextAt({
            rangeEndAt: '2026-08-18T15:00:00.000Z',
            sessionCloseAt: earlyCloseAt,
            returnBps: qualifyingReturns,
          }),
          defaultProtocol,
        ),
      ).selectedSymbols,
    ).toEqual(['AAPL'])

    const impossibleProtocol = success(
      decodeIntradayMomentumProtocol({
        ...defaultIntradayMomentumProtocolDocument,
        warmupMinutesAfterOpen: 120,
        entryCutoffMinutesBeforeClose: 100,
        executionModel: {
          ...defaultIntradayMomentumProtocolDocument.executionModel,
          order: {
            ...defaultIntradayMomentumProtocolDocument.executionModel.order,
            warmupAfterOpenMs: 120 * 60_000,
            submissionCutoffBeforeCloseMs: 100 * 60_000,
          },
        },
      }),
    )
    expect(
      error(
        decideIntradayMomentum(
          marketContextAt({
            rangeEndAt: '2026-08-18T15:30:00.000Z',
            sessionCloseAt: earlyCloseAt,
            returnBps: qualifyingReturns,
          }),
          impossibleProtocol,
        ),
      ),
    ).toMatchObject({ reason: 'snapshot-window' })
  })

  test('rejects the old opening-only decision window instead of silently reusing it all day', () => {
    const protocol = success(decodeDefaultIntradayMomentumProtocol())
    expect(
      error(
        decideIntradayMomentum(
          marketContextAt({ rangeEndAt: '2026-08-18T14:00:00.000Z', returnBps: qualifyingReturns }),
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

  test('rejects a snapshot observed after its rolling decision window', () => {
    const protocol = success(decodeDefaultIntradayMomentumProtocol())
    expect(
      error(
        decideIntradayMomentum(
          marketContextAt({
            rangeEndAt: '2026-08-18T18:00:00.000Z',
            observedLagMs: protocol.decisionDelaySeconds * 1_000 + protocol.maximumDecisionLagMs + 1,
            returnBps: qualifyingReturns,
          }),
          protocol,
        ),
      ),
    ).toMatchObject({ reason: 'snapshot-window' })
  })

  test('rejects a snapshot whose verified freshness contract is looser than the protocol', () => {
    const protocol = success(decodeDefaultIntradayMomentumProtocol())
    expect(
      error(
        decideIntradayMomentum(
          marketContextAt({
            rangeEndAt: '2026-08-18T18:00:00.000Z',
            snapshotMaximumQuoteAgeMs: protocol.maximumQuoteAgeMs + 1,
            returnBps: qualifyingReturns,
          }),
          protocol,
        ),
      ),
    ).toMatchObject({ reason: 'snapshot-identity' })
  })

  test('rejects a fully verified snapshot sourced from alternate archive topics', () => {
    const protocol = success(decodeDefaultIntradayMomentumProtocol())
    expect(
      error(
        decideIntradayMomentum(
          marketContextAt({
            rangeEndAt: '2026-08-18T18:00:00.000Z',
            returnBps: qualifyingReturns,
            sourceTopics: {
              bars: 'torghut.bars.1m.experimental.v1',
              quotes: 'torghut.quotes.experimental.v1',
              trades: 'torghut.trades.experimental.v1',
            },
          }),
          protocol,
        ),
      ),
    ).toMatchObject({ reason: 'snapshot-identity' })
  })

  test('accepts a fresh snapshot at an arbitrary 30-second controller poll phase', () => {
    const protocol = success(decodeDefaultIntradayMomentumProtocol())
    const decision = success(
      decideIntradayMomentum(
        marketContextAt({
          rangeEndAt: '2026-08-18T18:00:00.000Z',
          observedLagMs: protocol.decisionDelaySeconds * 1_000 + 29_999,
          quoteAgeMs: 1_000,
          returnBps: qualifyingReturns,
        }),
        protocol,
      ),
    )

    expect(decision.selectedSymbols).toEqual(['AAPL'])
  })

  test('fails closed when the benchmark quote is stale while candidate evidence remains fresh', () => {
    const protocol = success(decodeDefaultIntradayMomentumProtocol())
    expect(
      error(
        decideIntradayMomentum(
          marketContextAt({
            rangeEndAt: '2026-08-18T18:00:00.000Z',
            observedLagMs: 30_000,
            quoteAgeMsBySymbol: { [protocol.benchmarkSymbol]: protocol.maximumQuoteAgeMs + 1 },
            returnBps: qualifyingReturns,
          }),
          protocol,
        ),
      ),
    ).toMatchObject({ reason: 'snapshot-coverage', symbol: protocol.benchmarkSymbol })
  })

  test.each([
    ['bid', (symbol: string) => ({ bidSizeBySymbol: { [symbol]: 0 } })],
    ['ask', (symbol: string) => ({ askSizeBySymbol: { [symbol]: 0 } })],
  ])('fails closed when the benchmark %s has no executable displayed liquidity', (_, sizes) => {
    const protocol = success(decodeDefaultIntradayMomentumProtocol())
    expect(
      error(
        decideIntradayMomentum(
          marketContextAt({
            rangeEndAt: '2026-08-18T18:00:00.000Z',
            returnBps: qualifyingReturns,
            ...sizes(protocol.benchmarkSymbol),
          }),
          protocol,
        ),
      ),
    ).toMatchObject({
      reason: 'snapshot-coverage',
      message: 'intraday benchmark quote has no executable displayed liquidity',
      symbol: protocol.benchmarkSymbol,
    })
  })

  test.each([
    ['stale market data', { observedLagMs: 2_500, quoteAgeMs: 2_500 }, 'market-data-freshness'],
    ['wide spread', { spreadBps: 6 }, 'spread'],
    [
      'empty displayed book',
      {
        displayedSizeBySymbol: Object.fromEntries(
          defaultIntradayMomentumProtocolDocument.candidateSymbols.map((symbol) => [symbol, 0]),
        ),
      },
      'displayed-liquidity',
    ],
  ])('rejects %s without rejecting fresh peers', (_, overrides, expectedReason) => {
    const protocol = success(decodeDefaultIntradayMomentumProtocol())
    const decision = success(
      decideIntradayMomentum(
        marketContextAt({
          rangeEndAt: '2026-08-18T18:00:00.000Z',
          returnBps: qualifyingReturns,
          quoteAgeMsBySymbol: { [protocol.benchmarkSymbol]: 1_000 },
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

  test.each([
    ['a negative benchmark regime', { AAPL: 50, SPY: -5 }, 'benchmark-trend'],
    ['insufficient residual momentum', { AAPL: 30, SPY: 25 }, 'excess-return'],
  ])('rejects %s', (_, returnBps, expectedReason) => {
    const protocol = success(decodeDefaultIntradayMomentumProtocol())
    const decision = success(
      decideIntradayMomentum(marketContextAt({ rangeEndAt: '2026-08-18T18:00:00.000Z', returnBps }), protocol),
    )
    const signal = decision.signals.find(({ symbol }) => symbol === 'AAPL')

    expect(decision.selectedSymbols).toEqual([])
    expect(signal?.rejectionReasons).toContain(expectedReason as IntradayMomentumRejectionReason)
  })

  test('requires a complete rolling baseline for every configured liquid symbol', () => {
    const protocol = success(decodeDefaultIntradayMomentumProtocol())
    expect(
      error(
        decideIntradayMomentum(
          marketContextAt({
            rangeEndAt: '2026-08-18T18:00:00.000Z',
            returnBps: qualifyingReturns,
            omitFirstBarFor: 'AAPL',
          }),
          protocol,
        ),
      ),
    ).toMatchObject({ reason: 'snapshot-coverage', symbol: 'AAPL' })
  })

  test('accepts a complete rolling baseline expressed at equivalent nanosecond precision', () => {
    const protocol = success(decodeDefaultIntradayMomentumProtocol())
    const rangeEndAt = '2026-08-18T18:00:00.000Z'
    const baselineEventAt = instant(Date.parse(rangeEndAt) - protocol.lookbackMinutes * 60_000).replace(
      '.000Z',
      '.000000000Z',
    )
    const millisecondDecision = success(
      decideIntradayMomentum(marketContextAt({ rangeEndAt, returnBps: qualifyingReturns }), protocol),
    )
    const nanosecondDecision = success(
      decideIntradayMomentum(
        marketContextAt({
          rangeEndAt,
          baselineEventAt,
          returnBps: qualifyingReturns,
        }),
        protocol,
      ),
    )

    const { snapshotId: millisecondSnapshotId, ...millisecondDecisionMaterial } = millisecondDecision
    const { snapshotId: nanosecondSnapshotId, ...nanosecondDecisionMaterial } = nanosecondDecision
    expect(nanosecondDecisionMaterial).toEqual(millisecondDecisionMaterial)
    expect(nanosecondSnapshotId).not.toBe(millisecondSnapshotId)
  })

  test('emits schema-valid signals from nanosecond quote and trade timestamps', () => {
    const protocol = success(decodeDefaultIntradayMomentumProtocol())
    const decision = success(
      decideIntradayMomentum(
        marketContextAt({
          rangeEndAt: '2026-08-18T18:00:00.000Z',
          evidenceEventAt: '2026-08-18T18:00:01.500999999Z',
          returnBps: qualifyingReturns,
        }),
        protocol,
      ),
    )

    expect(decision.signals[0]?.quoteObservedAt).toBe('2026-08-18T18:00:01.500999999Z')
    expect(
      Schema.decodeUnknownResult(IntradayMomentumTargetPortfolioSchema, strictParseOptions)(decision),
    ).toMatchObject({ _tag: 'Success' })
  })

  test('exposes one pure INTRADAY definition', () => {
    const protocol = success(decodeDefaultIntradayMomentumProtocol())
    const definition = makeIntradayMomentumDefinition(protocol)
    expect(definition).toMatchObject({
      name: 'intraday-momentum',
      holdingPeriod: 'INTRADAY',
      parameters: protocol,
    })
    expect(
      success(
        definition.decide({
          market: marketContextAt({ rangeEndAt: '2026-08-18T18:30:00.000Z', returnBps: qualifyingReturns }),
        }),
      ).selectedSymbols,
    ).toEqual(['AAPL'])
  })

  test('retains the complete decision universe while adding held close targets', () => {
    const protocol = success(decodeDefaultIntradayMomentumProtocol())
    const decision = success(
      decideIntradayMomentum(
        marketContextAt({ rangeEndAt: '2026-08-18T18:30:00.000Z', returnBps: qualifyingReturns }),
        protocol,
      ),
    )
    const planningWeights = intradayMomentumPlanningTargetWeights(decision, ['TSLA'])

    expect(Object.keys(planningWeights)).toEqual([...protocol.candidateSymbols, 'TSLA'].sort())
    expect(planningWeights['TSLA']).toBe(0)
  })
})
