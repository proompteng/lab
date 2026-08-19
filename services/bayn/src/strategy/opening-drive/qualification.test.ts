import { describe, expect, test } from 'bun:test'
import { Result } from 'effect'

import { canonicalHashV1, sha256 } from '../../hash'
import {
  verifyIntradaySnapshot,
  type IntradayMarketSnapshot,
  type IntradaySnapshotRequest,
  type IntradaySnapshotRows,
} from '../../market-data'
import type { IsoDate } from '../../types'
import { openingDriveBehaviorHash } from './decision'
import type { OpeningDriveMarketContext } from './model'
import { qualifyOpeningDrive } from './qualification'
import { openingDriveOneSidedAlphaForOrdinal } from './qualification-analysis'
import { defaultOpeningDriveQualificationPolicy } from './qualification-policy'
import { openingDriveReplayCostModelDocument, replayOpeningDriveSession } from './qualification-replay'
import {
  decodeDefaultOpeningDriveProtocol,
  defaultOpeningDriveProtocolDocument,
  defaultOpeningDriveProtocolHash,
} from './protocol'

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
  openingObserved: `${sessionDate}T14:35:02.000Z`,
  exitStart: `${sessionDate}T20:29:00.000Z`,
  exitEnd: `${sessionDate}T20:30:00.000Z`,
  exitObserved: `${sessionDate}T20:30:02.000Z`,
  close: `${sessionDate}T21:00:00.000Z`,
})

const openingMoveBySymbol = (symbol: string): number => {
  if (symbol === 'AMD') return 0.016
  if (symbol === 'AVGO') return 0.015
  if (symbol === 'NVDA') return 0.014
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
  feed: 'sip',
  delayClass: 'real_time_consolidated',
  sourceTopics: { bars: barsTopic, quotes: quotesTopic, trades: tradesTopic },
  maximumQuoteAgeMs: defaultOpeningDriveProtocolDocument.maximumQuoteAgeMs,
  minimumWatermarkLagMs: defaultOpeningDriveProtocolDocument.decisionDelaySeconds * 1_000,
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
  readonly quoteBidSize?: number
  readonly quoteAskSize?: number
  readonly quoteEventAt?: string
  readonly quoteIngestedAt?: string
  readonly observedAt?: string
}

const rowsFor = (options: SnapshotRowsOptions): IntradaySnapshotRows => {
  const { sessionDate, phase, candidateMove, benchmarkMove } = options
  const times = timesFor(sessionDate)
  const rangeStart = phase === 'opening' ? times.open : times.exitStart
  const rangeEnd = phase === 'opening' ? times.openingEnd : times.exitEnd
  const minutes = phase === 'opening' ? 5 : 1
  let offset = 1
  const bars = symbols.flatMap((symbol, symbolIndex) => {
    const openingPrice = 100 + symbolIndex
    const openingMidpoint = openingPrice * (1 + openingMoveBySymbol(symbol))
    const move = symbol === 'AMD' || symbol === 'AVGO' || symbol === 'NVDA' ? candidateMove : benchmarkMove
    const phasePrice = phase === 'opening' ? openingPrice : openingMidpoint * (1 + move)
    return Array.from({ length: minutes }, (_, minute) => {
      const eventAt = new Date(Date.parse(rangeStart) + minute * 60_000).toISOString()
      const ingestedAt = new Date(Date.parse(eventAt) + 60_000).toISOString()
      return {
        provider: 'alpaca',
        universe_id: defaultOpeningDriveProtocolDocument.universeId,
        universe_symbol_hash: sha256(symbols.join(',')),
        feed: 'sip',
        market_session: 'regular',
        delay_class: 'real_time_consolidated',
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
    const move = symbol === 'AMD' || symbol === 'AVGO' || symbol === 'NVDA' ? candidateMove : benchmarkMove
    const midpoint = phase === 'opening' ? openingMidpoint : openingMidpoint * (1 + move)
    return {
      provider: 'alpaca',
      universe_id: defaultOpeningDriveProtocolDocument.universeId,
      universe_symbol_hash: sha256(symbols.join(',')),
      feed: 'sip',
      market_session: 'regular',
      delay_class: 'real_time_consolidated',
      symbol,
      event_at: options.quoteEventAt ?? new Date(Date.parse(rangeEnd) + 1_500).toISOString(),
      ingested_at: options.quoteIngestedAt ?? new Date(Date.parse(rangeEnd) + 1_600).toISOString(),
      source_topic: quotesTopic,
      source_partition: '0',
      source_offset: String(offset++),
      schema_version: '1',
      bid_price: String(midpoint - 0.01),
      bid_size: String(options.quoteBidSize ?? 1000),
      ask_price: String(midpoint + 0.01),
      ask_size: String(options.quoteAskSize ?? 1000),
    }
  })
  const trades = symbols.map((symbol, symbolIndex) => ({
    provider: 'alpaca',
    universe_id: defaultOpeningDriveProtocolDocument.universeId,
    universe_symbol_hash: sha256(symbols.join(',')),
    feed: 'sip',
    market_session: 'regular',
    delay_class: 'real_time_consolidated',
    symbol,
    event_at: new Date(Date.parse(rangeEnd) + 1_400).toISOString(),
    ingested_at: new Date(Date.parse(rangeEnd) + 1_500).toISOString(),
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
      ? requestFor(options.sessionDate, times.open, times.openingEnd, options.observedAt ?? times.openingObserved)
      : requestFor(options.sessionDate, times.exitStart, times.exitEnd, options.observedAt ?? times.exitObserved)
  return success(verifyIntradaySnapshot(request, rowsFor(options)))
}

const rehashSnapshotWithBars = (
  snapshot: IntradayMarketSnapshot,
  bars: IntradayMarketSnapshot['bars'],
): IntradayMarketSnapshot => {
  const { contentHash: _contentHash, snapshotId: _snapshotId, ...boundMaterial } = snapshot.manifest
  const material = Object.freeze({ ...boundMaterial, barsContentHash: canonicalHashV1(bars) })
  const contentHash = canonicalHashV1(material)
  const manifest = Object.freeze({
    ...material,
    contentHash,
    snapshotId: canonicalHashV1({ ...material, contentHash }),
  })
  return Object.freeze({ ...snapshot, bars, manifest })
}

type ReplayOptions = Pick<
  SnapshotRowsOptions,
  'quoteBidSize' | 'quoteAskSize' | 'quoteEventAt' | 'quoteIngestedAt' | 'observedAt'
>

const replayInput = (ordinal: number, candidateMove: number, benchmarkMove = 0, exitOptions: ReplayOptions = {}) => {
  const sessionDate = dateAt(ordinal)
  const times = timesFor(sessionDate)
  const opening = snapshotFor({ sessionDate, phase: 'opening', candidateMove, benchmarkMove })
  const exit = snapshotFor({ sessionDate, phase: 'exit', candidateMove, benchmarkMove, ...exitOptions })
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

const calendarFor = (sessions: readonly ReturnType<typeof replayInput>[]) => {
  const calendarSessions = sessions.map((session) => session.opening.session)
  const first = calendarSessions[0]
  const last = calendarSessions.at(-1)
  if (first === undefined || last === undefined) throw new Error('qualification calendar requires sessions')
  const material = {
    schemaVersion: 'bayn.opening-drive.qualification-calendar.v1' as const,
    source: 'signal.exchange_sessions_v1' as const,
    calendarVersion: 'fixture-calendar-v1',
    firstSession: first.sessionDate,
    lastSession: last.sessionDate,
    finalizedAt: new Date(Date.parse(last.closeAt) + 1).toISOString(),
    sessions: calendarSessions,
  }
  return Object.freeze({ ...material, contentHash: canonicalHashV1(material) })
}

const binding = (calendar: ReturnType<typeof calendarFor>, priorTrialCount = 0) => ({
  sourceRevision: 'a'.repeat(40),
  strategyBehaviorHash: openingDriveBehaviorHash,
  protocolHash: defaultOpeningDriveProtocolHash,
  policyHash: canonicalHashV1(defaultOpeningDriveQualificationPolicy),
  costModelHash: canonicalHashV1(openingDriveReplayCostModelDocument),
  evaluationCalendarHash: calendar.contentHash,
  priorTrialReceiptHashes: Array.from({ length: priorTrialCount }, (_, ordinal) =>
    sha256(`prior-${ordinal}`),
  ).toSorted(),
})

describe('opening-drive after-cost qualification', () => {
  test('qualifies deterministic positive replay only after conservative quote, slippage, fee, and sample gates', () => {
    const protocol = success(decodeDefaultOpeningDriveProtocol())
    const sessions = Array.from({ length: 60 }, (_, ordinal) => replayInput(ordinal, 0.02))
    const calendar = calendarFor(sessions)
    const first = success(qualifyOpeningDrive({ sessions, calendar, protocol, binding: binding(calendar) }))
    const second = success(
      qualifyOpeningDrive({
        sessions: structuredClone(sessions),
        calendar: structuredClone(calendar),
        protocol,
        binding: binding(calendar),
      }),
    )

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
    expect(first.receipt.adjustedOneSidedAlpha).toBe(0.025)
    expect(first.receipt.excessAnnualizedReturnLowerBound).toBeGreaterThan(0)
    expect(BigInt(first.receipt.candidateQuotedSpreadCostMicros)).toBeGreaterThan(0n)
    expect(BigInt(first.receipt.candidateSlippageCostMicros)).toBeGreaterThan(0n)
    expect(BigInt(first.receipt.candidateFeeCostMicros)).toBeGreaterThan(0n)
    expect(BigInt(first.receipt.candidateNetPnlMicros)).toBeGreaterThan(0n)
    expect(first.sessions.every((session) => session.candidate.executedSymbols.length === 3)).toBe(true)
    expect(first.sessions.every((session) => BigInt(session.candidate.entryNotionalMicros) <= 10_000_000_000n)).toBe(
      true,
    )
    expect(first.sessions.every((session) => session.candidate.flat && session.benchmark.flat)).toBe(true)
  })

  test('reports the current 24-session horizon as insufficient without erasing multiplicity', () => {
    const protocol = success(decodeDefaultOpeningDriveProtocol())
    const sessions = Array.from({ length: 24 }, (_, ordinal) => replayInput(ordinal, 0.02))
    const calendar = calendarFor(sessions)
    const result = success(
      qualifyOpeningDrive({
        sessions,
        calendar,
        protocol,
        binding: binding(calendar, 20),
      }),
    )

    expect(result.receipt).toMatchObject({
      verdict: 'INSUFFICIENT',
      sessionCount: 24,
      tradeSessionCount: 24,
      candidateOrdinal: 21,
      priorTrialCount: 20,
      bootstrapTailSamples: 1,
      reasonCodes: ['session-count', 'bootstrap-tail-resolution'],
    })
    expect(result.receipt.adjustedOneSidedAlpha).toBeCloseTo(0.05 / (21 * 22), 12)
  })

  test('spends no more than the precommitted family-wise alpha across sequential trials', () => {
    const spent = Array.from({ length: 10_000 }, (_, index) =>
      openingDriveOneSidedAlphaForOrdinal(0.05, index + 1),
    ).reduce((sum, alpha) => sum + alpha, 0)

    expect(spent).toBeLessThan(0.05)
    expect(spent).toBeGreaterThan(0.04999)
  })

  test('rejects strategy, protocol, policy, or cost-model drift from the immutable binding before replay', () => {
    const protocol = success(decodeDefaultOpeningDriveProtocol())
    const sessions = [replayInput(0, 0.02)]
    const calendar = calendarFor(sessions)
    const frozen = binding(calendar)

    expect(
      error(
        qualifyOpeningDrive({
          sessions,
          calendar,
          protocol,
          binding: { ...frozen, strategyBehaviorHash: sha256('different-opening-drive-implementation') },
        }),
      ),
    ).toMatchObject({ reason: 'trial-lineage' })
    expect(
      error(
        qualifyOpeningDrive({
          sessions,
          calendar,
          protocol: { ...protocol, entryCutoffMinutesAfterOpen: protocol.entryCutoffMinutesAfterOpen + 1 },
          binding: frozen,
        }),
      ),
    ).toMatchObject({ reason: 'trial-lineage' })
    expect(
      error(
        qualifyOpeningDrive({
          sessions,
          calendar,
          protocol,
          policy: { ...defaultOpeningDriveQualificationPolicy, maximumDrawdown: 1 },
          binding: frozen,
        }),
      ),
    ).toMatchObject({ reason: 'trial-lineage' })
    expect(
      error(
        qualifyOpeningDrive({
          sessions,
          calendar,
          protocol,
          binding: { ...frozen, costModelHash: sha256('different-cost-model') },
        }),
      ),
    ).toMatchObject({ reason: 'trial-lineage' })
  })

  test('reserves entry fees and excludes orders below the execution minimum', () => {
    const protocol = success(decodeDefaultOpeningDriveProtocol())
    const fullAllocation = BigInt(defaultOpeningDriveQualificationPolicy.allocationMicros)
    const replay = success(
      replayOpeningDriveSession(replayInput(0, 0.02), protocol, defaultOpeningDriveQualificationPolicy),
    )

    expect(BigInt(replay.benchmark.entryNotionalMicros)).toBeLessThan(fullAllocation)
    expect(fullAllocation - BigInt(replay.benchmark.entryNotionalMicros)).toBeGreaterThanOrEqual(10_000n)
    expect(BigInt(replay.benchmark.feeCostMicros)).toBeGreaterThan(0n)

    const subminimum = success(
      replayOpeningDriveSession(replayInput(0, 0.02), protocol, {
        ...defaultOpeningDriveQualificationPolicy,
        allocationMicros: '9000000',
      }),
    )
    expect(subminimum.benchmark.executedSymbols).toEqual([])
    expect(subminimum.benchmark.entryNotionalMicros).toBe('0')
  })

  test('rejects late opening observations before replaying either portfolio', () => {
    const protocol = success(decodeDefaultOpeningDriveProtocol())
    const sessionDate = dateAt(0)
    const times = timesFor(sessionDate)
    const observedAt = new Date(Date.parse(times.open) + protocol.entryCutoffMinutesAfterOpen * 60_000).toISOString()
    const input = replayInput(0, 0.02)
    const lateOpening = snapshotFor({
      sessionDate,
      phase: 'opening',
      candidateMove: 0.02,
      benchmarkMove: 0,
      observedAt,
      quoteEventAt: observedAt,
      quoteIngestedAt: observedAt,
    })
    const lateInput = Object.freeze({
      ...input,
      opening: Object.freeze({ ...input.opening, snapshot: lateOpening }),
    })
    const calendar = calendarFor([lateInput])

    expect(
      error(qualifyOpeningDrive({ sessions: [lateInput], calendar, protocol, binding: binding(calendar) })),
    ).toMatchObject({ reason: 'strategy-decision', cause: { reason: 'snapshot-window' } })
  })

  test('rejects a sufficiently observed strategy that loses after all modeled costs', () => {
    const protocol = success(decodeDefaultOpeningDriveProtocol())
    const sessions = Array.from({ length: 60 }, (_, ordinal) => replayInput(ordinal, -0.02))
    const calendar = calendarFor(sessions)
    const result = success(
      qualifyOpeningDrive({
        sessions,
        calendar,
        protocol,
        binding: binding(calendar),
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
    const mutatedCalendar = calendarFor([mutated])
    expect(
      error(
        qualifyOpeningDrive({
          sessions: [mutated],
          calendar: mutatedCalendar,
          protocol,
          binding: binding(mutatedCalendar),
        }),
      ),
    ).toMatchObject({
      reason: 'snapshot-binding',
    })
    const firstOpeningBar = first.opening.snapshot.bars[0]
    if (firstOpeningBar === undefined) throw new Error('opening bar fixture is missing')
    const duplicatedBars = Object.freeze([firstOpeningBar, firstOpeningBar, ...first.opening.snapshot.bars.slice(2)])
    const selfRehashed = {
      ...first,
      opening: {
        ...first.opening,
        snapshot: rehashSnapshotWithBars(first.opening.snapshot, duplicatedBars),
      },
    }
    const selfRehashedCalendar = calendarFor([selfRehashed])
    expect(
      error(
        qualifyOpeningDrive({
          sessions: [selfRehashed],
          calendar: selfRehashedCalendar,
          protocol,
          binding: binding(selfRehashedCalendar),
        }),
      ),
    ).toMatchObject({ reason: 'snapshot-binding', cause: { reason: 'coverage' } })
    const duplicateCalendar = calendarFor([first, first])
    expect(
      error(
        qualifyOpeningDrive({
          sessions: [first, first],
          calendar: duplicateCalendar,
          protocol,
          binding: binding(duplicateCalendar),
        }),
      ),
    ).toMatchObject({ reason: 'session-order' })
    const reversed = [replayInput(1, 0.02), first]
    const reversedCalendar = calendarFor(reversed)
    expect(
      error(
        qualifyOpeningDrive({
          sessions: reversed,
          calendar: reversedCalendar,
          protocol,
          binding: binding(reversedCalendar),
        }),
      ),
    ).toMatchObject({ reason: 'session-order' })
    const firstCalendar = calendarFor([first])
    expect(
      error(
        qualifyOpeningDrive({
          sessions: [first],
          calendar: firstCalendar,
          protocol,
          binding: {
            ...binding(firstCalendar),
            priorTrialReceiptHashes: ['f'.repeat(64), '0'.repeat(64)],
          },
        }),
      ),
    ).toMatchObject({ reason: 'trial-lineage' })
  })

  test('rejects omitted finalized sessions and a calendar not frozen in the qualification binding', () => {
    const protocol = success(decodeDefaultOpeningDriveProtocol())
    const sessions = Array.from({ length: 60 }, (_, ordinal) => replayInput(ordinal, ordinal === 17 ? -0.03 : 0.02))
    const calendar = calendarFor(sessions)
    const incompleteSessions = sessions.filter((_, ordinal) => ordinal !== 17)

    expect(
      error(qualifyOpeningDrive({ sessions: incompleteSessions, calendar, protocol, binding: binding(calendar) })),
    ).toMatchObject({ reason: 'session-order' })
    expect(
      error(
        qualifyOpeningDrive({
          sessions,
          calendar,
          protocol,
          binding: { ...binding(calendar), evaluationCalendarHash: sha256('different-finalized-calendar') },
        }),
      ),
    ).toMatchObject({ reason: 'session-order' })
  })

  test('keeps entry-time quantity when exit liquidity is unavailable and rejects the unclosed position', () => {
    const protocol = success(decodeDefaultOpeningDriveProtocol())
    const sessions = Array.from({ length: 60 }, (_, ordinal) =>
      replayInput(ordinal, 0.02, 0, ordinal === 9 ? { quoteBidSize: 0 } : {}),
    )
    const calendar = calendarFor(sessions)
    const result = success(qualifyOpeningDrive({ sessions, calendar, protocol, binding: binding(calendar) }))
    const constrained = result.sessions[9]

    expect(constrained?.candidate.executedSymbols).toHaveLength(3)
    expect(constrained?.candidate.flat).toBe(false)
    expect(BigInt(constrained?.candidate.unclosedQuantityMicros ?? '0')).toBeGreaterThan(0n)
    expect(constrained?.candidate.return).toBe(-1)
    expect(result.receipt.verdict).toBe('REJECTED')
    expect(result.receipt.reasonCodes).toContain('candidate-same-session-flat')
  })

  test('rejects an old market event even when its ingestion timestamp is recent', () => {
    const protocol = success(decodeDefaultOpeningDriveProtocol())
    const sessionDate = dateAt(0)
    const sessions = [
      replayInput(0, 0.02, 0, {
        quoteEventAt: `${sessionDate}T20:30:15.000Z`,
        quoteIngestedAt: `${sessionDate}T20:43:59.000Z`,
        observedAt: `${sessionDate}T20:44:00.000Z`,
      }),
    ]
    const calendar = calendarFor(sessions)

    expect(error(qualifyOpeningDrive({ sessions, calendar, protocol, binding: binding(calendar) }))).toMatchObject({
      reason: 'snapshot-binding',
    })
  })
})
