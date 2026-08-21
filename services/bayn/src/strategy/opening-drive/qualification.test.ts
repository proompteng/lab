import { describe, expect, test } from 'bun:test'
import { Result } from 'effect'

import { canonicalHashV1, sha256 } from '../../hash'
import { makeExecutionCalendarObservation } from '../../cycle'
import {
  reverifyIntradayMarketSnapshot,
  verifyIntradaySnapshot,
  type IntradayMarketSnapshot,
  type IntradaySnapshotRequest,
} from '../../market-data'
import type { IsoDate } from '../../types'
import { decideOpeningDrive, openingDriveBehaviorHash } from './decision'
import type { OpeningDriveMarketContext } from './model'
import { qualifyOpeningDrive } from './qualification'
import { openingDriveOneSidedAlphaForOrdinal } from './qualification-analysis'
import {
  defaultOpeningDriveQualificationPolicy,
  openingDriveRequiredQualificationSessions,
  validateOpeningDriveQualificationPolicy,
} from './qualification-policy'
import { openingDriveReplayCostModelDocument, replayOpeningDriveSession } from './qualification-replay'
import { hashOpeningDriveReplayVersionGraphFromInputs } from './qualification-version'
import {
  decodeDefaultOpeningDriveProtocol,
  decodeOpeningDriveProtocol,
  defaultOpeningDriveProtocolDocument,
  type OpeningDriveProtocol,
} from './protocol'

const symbols = defaultOpeningDriveProtocolDocument.universe
const barsTopic = 'torghut.bars.1m.v1'
const quotesTopic = 'torghut.quotes.v1'
const tradesTopic = 'torghut.trades.v1'
const success = <A, E>(result: Result.Result<A, E>): A => Result.getOrThrow(result)
const error = <A, E>(result: Result.Result<A, E>): E => Result.getOrThrow(Result.flip(result))
const sufficientlyPoweredSessionCount = openingDriveRequiredQualificationSessions(
  defaultOpeningDriveQualificationPolicy,
)
const qualificationTestPolicy = Object.freeze({
  ...defaultOpeningDriveQualificationPolicy,
  power: Object.freeze({
    ...defaultOpeningDriveQualificationPolicy.power,
    minimumDetectableAnnualizedExcessReturn: 0.6,
  }),
})
const qualificationTestSessionCount = openingDriveRequiredQualificationSessions(qualificationTestPolicy)

const dateAt = (ordinal: number): IsoDate => {
  let remaining = ordinal
  const date = new Date(Date.UTC(2026, 0, 2))
  while (true) {
    const day = date.getUTCDay()
    if (day !== 0 && day !== 6) {
      if (remaining === 0) return date.toISOString().slice(0, 10) as IsoDate
      remaining -= 1
    }
    date.setUTCDate(date.getUTCDate() + 1)
  }
}

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
): IntradaySnapshotRequest => {
  const times = timesFor(sessionDate)
  const calendarMaterial = {
    schemaVersion: 'bayn.alpaca-market-calendar-observation.v1' as const,
    source: 'alpaca-v2-calendar' as const,
    requestedRange: { start: sessionDate, end: sessionDate },
    timeZone: 'UTC' as const,
    sessions: [{ date: sessionDate, openAt: times.open, closeAt: times.close }],
  }
  return {
    sessionDate,
    calendar: { ...calendarMaterial, normalizedResponseHash: canonicalHashV1(calendarMaterial) },
    rangeStartAt,
    rangeEndAt,
    observedAt,
    universeId: defaultOpeningDriveProtocolDocument.universeId,
    universeSymbolHash: sha256(symbols.join(',')),
    universe: symbols,
    feed: defaultOpeningDriveProtocolDocument.feed,
    delayClass: defaultOpeningDriveProtocolDocument.delayClass,
    sourceTopics: { bars: barsTopic, quotes: quotesTopic, trades: tradesTopic },
    maximumQuoteAgeMs: defaultOpeningDriveProtocolDocument.maximumQuoteAgeMs,
    minimumWatermarkLagMs: defaultOpeningDriveProtocolDocument.decisionDelaySeconds * 1_000,
    archiveWatermarks: [
      { sourceTopic: barsTopic, sourcePartition: 0, inclusiveLastOffset: '1000000' },
      { sourceTopic: quotesTopic, sourcePartition: 0, inclusiveLastOffset: '1000000' },
      { sourceTopic: tradesTopic, sourcePartition: 0, inclusiveLastOffset: '1000000' },
    ],
  }
}

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
  readonly quoteMidpointBySymbol?: Readonly<Record<string, number>>
}

const rowsFor = (options: SnapshotRowsOptions) => {
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
        feed: defaultOpeningDriveProtocolDocument.feed,
        market_session: 'regular',
        delay_class: defaultOpeningDriveProtocolDocument.delayClass,
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
    const midpoint =
      options.quoteMidpointBySymbol?.[symbol] ?? (phase === 'opening' ? openingMidpoint : openingMidpoint * (1 + move))
    return {
      provider: 'alpaca',
      universe_id: defaultOpeningDriveProtocolDocument.universeId,
      universe_symbol_hash: sha256(symbols.join(',')),
      feed: defaultOpeningDriveProtocolDocument.feed,
      market_session: 'regular',
      delay_class: defaultOpeningDriveProtocolDocument.delayClass,
      symbol,
      event_at: options.quoteEventAt ?? new Date(Date.parse(rangeEnd) + 1_500).toISOString(),
      ingested_at: options.quoteIngestedAt ?? new Date(Date.parse(rangeEnd) + 1_600).toISOString(),
      source_topic: quotesTopic,
      source_partition: '0',
      source_offset: String(offset++),
      schema_version: '1',
      latest_payload_variants: '1',
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
    feed: defaultOpeningDriveProtocolDocument.feed,
    market_session: 'regular',
    delay_class: defaultOpeningDriveProtocolDocument.delayClass,
    symbol,
    event_at: new Date(Date.parse(rangeEnd) + 1_400).toISOString(),
    ingested_at: new Date(Date.parse(rangeEnd) + 1_500).toISOString(),
    source_topic: tradesTopic,
    source_partition: '0',
    source_offset: String(offset++),
    schema_version: '1',
    latest_payload_variants: '1',
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
  const calendarSession = opening.manifest.calendar.sessions.find(({ date }) => date === sessionDate)
  if (calendarSession === undefined)
    throw new Error('qualification snapshot fixture requires its bound calendar session')
  const executionCalendar = success(
    makeExecutionCalendarObservation({
      schemaVersion: opening.manifest.calendar.schemaVersion,
      source: opening.manifest.calendar.source,
      ...calendarSession,
    }),
  )
  const context: OpeningDriveMarketContext = Object.freeze({
    snapshot: opening,
    session: Object.freeze({
      sessionDate,
      openAt: times.open,
      closeAt: times.close,
      calendarHash: executionCalendar.executionCalendarHash,
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

const binding = (
  calendar: ReturnType<typeof calendarFor>,
  sessions: readonly ReturnType<typeof replayInput>[],
  priorTrialCount = 0,
  policy = defaultOpeningDriveQualificationPolicy,
  protocol: OpeningDriveProtocol = success(decodeDefaultOpeningDriveProtocol()),
) => ({
  sourceRevision: 'a'.repeat(40),
  strategyBehaviorHash: openingDriveBehaviorHash,
  protocolHash: canonicalHashV1(protocol),
  policyHash: canonicalHashV1(policy),
  costModelHash: canonicalHashV1(openingDriveReplayCostModelDocument),
  evaluationCalendarHash: calendar.contentHash,
  replayVersionGraphHash: success(hashOpeningDriveReplayVersionGraphFromInputs(sessions)),
  priorTrialReceiptHashes: Array.from({ length: priorTrialCount }, (_, ordinal) =>
    sha256(`prior-${ordinal}`),
  ).toSorted(),
})

const fullFillProtocol = (): OpeningDriveProtocol =>
  success(
    decodeOpeningDriveProtocol({
      ...defaultOpeningDriveProtocolDocument,
      executionModel: {
        ...defaultOpeningDriveProtocolDocument.executionModel,
        partialFills: {
          ...defaultOpeningDriveProtocolDocument.executionModel.partialFills,
          probabilityPpm: 0,
        },
      },
    }),
  )

describe('opening-drive after-cost qualification', () => {
  test('rejects runtime drift in every fixed qualification-policy literal', () => {
    const fixedDrift = [
      { ...defaultOpeningDriveQualificationPolicy, annualizationSessions: 365 },
      {
        ...defaultOpeningDriveQualificationPolicy,
        bootstrap: { ...defaultOpeningDriveQualificationPolicy.bootstrap, familyOneSidedAlpha: 1 },
      },
      {
        ...defaultOpeningDriveQualificationPolicy,
        bootstrap: { ...defaultOpeningDriveQualificationPolicy.bootstrap, method: 'unpaired-bootstrap' },
      },
      {
        ...defaultOpeningDriveQualificationPolicy,
        power: {
          ...defaultOpeningDriveQualificationPolicy.power,
          minimumDetectableAnnualizedExcessReturn: Number.MIN_VALUE,
        },
      },
    ]

    for (const policy of fixedDrift) {
      expect(Result.isFailure(validateOpeningDriveQualificationPolicy(policy as never))).toBe(true)
    }
  })

  test('qualifies deterministic positive replay only after conservative quote, slippage, fee, and sample gates', () => {
    const protocol = fullFillProtocol()
    const sessions = Array.from({ length: qualificationTestSessionCount }, (_, ordinal) => replayInput(ordinal, 0.02))
    const calendar = calendarFor(sessions)
    const first = success(
      qualifyOpeningDrive({
        sessions,
        calendar,
        protocol,
        policy: qualificationTestPolicy,
        binding: binding(calendar, sessions, 0, qualificationTestPolicy, protocol),
      }),
    )
    const second = success(
      qualifyOpeningDrive({
        sessions: structuredClone(sessions),
        calendar: structuredClone(calendar),
        protocol,
        policy: qualificationTestPolicy,
        binding: binding(calendar, sessions, 0, qualificationTestPolicy, protocol),
      }),
    )

    expect(second).toEqual(first)
    expect(sufficientlyPoweredSessionCount).toBe(21_977)
    expect(qualificationTestSessionCount).toBe(defaultOpeningDriveQualificationPolicy.minimumSessions)
    expect(first.receipt).toMatchObject({
      verdict: 'QUALIFIED',
      sessionCount: qualificationTestSessionCount,
      tradeSessionCount: qualificationTestSessionCount,
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

  test('reports an otherwise positive replay as insufficient when it is below the precommitted power requirement', () => {
    const protocol = fullFillProtocol()
    const sessions = Array.from({ length: defaultOpeningDriveQualificationPolicy.minimumSessions }, (_, ordinal) =>
      replayInput(ordinal, 0.02),
    )
    const calendar = calendarFor(sessions)
    const result = success(
      qualifyOpeningDrive({
        sessions,
        calendar,
        protocol,
        binding: binding(calendar, sessions, 0, undefined, protocol),
      }),
    )

    expect(sufficientlyPoweredSessionCount).toBeGreaterThan(defaultOpeningDriveQualificationPolicy.minimumSessions)
    expect(result.receipt).toMatchObject({
      verdict: 'INSUFFICIENT',
      reasonCodes: ['statistical-power-session-count'],
    })
    expect(result.receipt.gates).toContainEqual({
      name: 'statistical-power-session-count',
      passed: false,
      actual: defaultOpeningDriveQualificationPolicy.minimumSessions,
      required: sufficientlyPoweredSessionCount,
    })
  })

  test('reports the current 24-session horizon as insufficient without erasing multiplicity', () => {
    const protocol = fullFillProtocol()
    const sessions = Array.from({ length: 24 }, (_, ordinal) => replayInput(ordinal, 0.02))
    const calendar = calendarFor(sessions)
    const result = success(
      qualifyOpeningDrive({
        sessions,
        calendar,
        protocol,
        binding: binding(calendar, sessions, 20, undefined, protocol),
      }),
    )

    expect(result.receipt).toMatchObject({
      verdict: 'INSUFFICIENT',
      sessionCount: 24,
      tradeSessionCount: 24,
      candidateOrdinal: 21,
      priorTrialCount: 20,
      bootstrapTailSamples: 1,
      reasonCodes: ['session-count', 'statistical-power-session-count', 'bootstrap-tail-resolution'],
    })
    expect(result.receipt.adjustedOneSidedAlpha).toBeCloseTo(0.05 / (21 * 22), 12)
    expect(
      openingDriveRequiredQualificationSessions(
        defaultOpeningDriveQualificationPolicy,
        openingDriveOneSidedAlphaForOrdinal(0.05, 21),
      ),
    ).toBeGreaterThan(sufficientlyPoweredSessionCount)
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
    const frozen = binding(calendar, sessions)

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
          protocol,
          binding: { ...frozen, replayVersionGraphHash: sha256('different-replay-version-graph') },
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

    const boundaryInput = replayInput(0, 0.02)
    const boundaryOpening = snapshotFor({
      sessionDate: boundaryInput.opening.session.sessionDate,
      phase: 'opening',
      candidateMove: 0.02,
      benchmarkMove: 0,
      quoteMidpointBySymbol: { AMD: 111.09 },
    })
    const boundaryDecision = success(
      decideOpeningDrive({ ...boundaryInput.opening, snapshot: boundaryOpening }, protocol),
    )
    expect(boundaryDecision.signals.find((signal) => signal.symbol === 'AMD')?.askPriceMicros).toBe('111100000')
    const referenceBoundary = success(
      replayOpeningDriveSession(
        {
          ...boundaryInput,
          opening: { ...boundaryInput.opening, snapshot: boundaryOpening },
        },
        protocol,
        { ...defaultOpeningDriveQualificationPolicy, allocationMicros: '10000000' },
      ),
    )
    expect(referenceBoundary.candidate.executedSymbols).not.toContain('AMD')
  })

  test('applies the bound deterministic partial-fill model to entry and exit quantities', () => {
    const input = replayInput(3, 0.02)
    const defaultProtocol = success(decodeDefaultOpeningDriveProtocol())
    const deterministic = success(
      replayOpeningDriveSession(input, defaultProtocol, defaultOpeningDriveQualificationPolicy),
    )
    const fullFill = success(
      replayOpeningDriveSession(input, fullFillProtocol(), defaultOpeningDriveQualificationPolicy),
    )

    expect(BigInt(deterministic.candidate.entryNotionalMicros)).toBeLessThan(
      BigInt(fullFill.candidate.entryNotionalMicros),
    )
    expect(BigInt(deterministic.candidate.unclosedQuantityMicros)).toBeGreaterThan(0n)
    expect(BigInt(deterministic.candidate.terminalRemainderNotionalMicros)).toBeGreaterThan(0n)
    expect(BigInt(deterministic.candidate.netPnlMicros)).toBe(
      BigInt(deterministic.candidate.exitNotionalMicros) +
        BigInt(deterministic.candidate.terminalRemainderNotionalMicros) -
        BigInt(deterministic.candidate.entryNotionalMicros) -
        BigInt(deterministic.candidate.feeCostMicros),
    )
    expect(fullFill.candidate.unclosedQuantityMicros).toBe('0')
    expect(fullFill.candidate.terminalRemainderNotionalMicros).toBe('0')
  })

  test('terminal-values synthetic benchmark exit remainders instead of making them a structural failure', () => {
    const replay = success(
      replayOpeningDriveSession(
        replayInput(1, 0.02),
        success(decodeDefaultOpeningDriveProtocol()),
        defaultOpeningDriveQualificationPolicy,
      ),
    )

    expect(BigInt(replay.benchmark.unclosedQuantityMicros)).toBeGreaterThan(0n)
    expect(BigInt(replay.benchmark.terminalRemainderNotionalMicros)).toBeGreaterThan(0n)
    expect(replay.benchmark.flat).toBe(false)
    expect(BigInt(replay.benchmark.netPnlMicros)).toBe(
      BigInt(replay.benchmark.exitNotionalMicros) +
        BigInt(replay.benchmark.terminalRemainderNotionalMicros) -
        BigInt(replay.benchmark.entryNotionalMicros) -
        BigInt(replay.benchmark.feeCostMicros),
    )
    expect(replay.benchmark.return).toBeGreaterThanOrEqual(-1)
  })

  test('rejects ambiguous latest exit quotes across Kafka partitions before replay pricing', () => {
    const protocol = success(decodeDefaultOpeningDriveProtocol())
    const input = replayInput(0, 0.02)
    const sessionDate = input.opening.session.sessionDate
    const times = timesFor(sessionDate)
    const rows = rowsFor({ sessionDate, phase: 'exit', candidateMove: 0.02, benchmarkMove: 0 })
    const amdQuote = rows.quotes.find((quote) => quote.symbol === 'AMD')
    if (amdQuote === undefined) throw new Error('AMD exit quote fixture is missing')
    const partitionOneWatermark = {
      sourceTopic: quotesTopic,
      sourcePartition: 1,
      inclusiveLastOffset: '1',
    } as const
    const archiveWatermarks = [
      ...requestFor(sessionDate, times.exitStart, times.exitEnd, times.exitObserved).archiveWatermarks,
      partitionOneWatermark,
    ].toSorted(
      (left, right) =>
        left.sourceTopic.localeCompare(right.sourceTopic) || left.sourcePartition - right.sourcePartition,
    )
    const exit = success(
      verifyIntradaySnapshot(
        { ...requestFor(sessionDate, times.exitStart, times.exitEnd, times.exitObserved), archiveWatermarks },
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
              bid_price: String(Number(amdQuote.bid_price) + 1),
              ask_price: String(Number(amdQuote.ask_price) + 1),
            },
          ],
        },
      ),
    )

    expect(
      error(replayOpeningDriveSession({ ...input, exit }, protocol, defaultOpeningDriveQualificationPolicy)),
    ).toMatchObject({ reason: 'snapshot-binding', symbol: 'AMD' })
  })

  test('rejects an independently valid exit snapshot from a different calendar observation', () => {
    const protocol = success(decodeDefaultOpeningDriveProtocol())
    const input = replayInput(0, 0.02)
    const sessionDate = input.opening.session.sessionDate
    const times = timesFor(sessionDate)
    const request = requestFor(sessionDate, times.exitStart, times.exitEnd, times.exitObserved)
    const priorDate = new Date(Date.parse(`${sessionDate}T00:00:00.000Z`) - 86_400_000)
      .toISOString()
      .slice(0, 10) as IsoDate
    const calendarMaterial = {
      schemaVersion: request.calendar.schemaVersion,
      source: request.calendar.source,
      requestedRange: { start: priorDate, end: sessionDate },
      timeZone: 'UTC' as const,
      sessions: [
        { date: priorDate, openAt: `${priorDate}T14:30:00.000Z`, closeAt: `${priorDate}T21:00:00.000Z` },
        { date: sessionDate, openAt: times.open, closeAt: times.close },
      ],
    }
    const exit = success(
      verifyIntradaySnapshot(
        {
          ...request,
          calendar: { ...calendarMaterial, normalizedResponseHash: canonicalHashV1(calendarMaterial) },
        },
        rowsFor({ sessionDate, phase: 'exit', candidateMove: 0.02, benchmarkMove: 0 }),
      ),
    )

    expect(success(reverifyIntradayMarketSnapshot(exit))).toEqual(exit)
    expect(
      error(replayOpeningDriveSession({ ...input, exit }, protocol, defaultOpeningDriveQualificationPolicy)),
    ).toMatchObject({ reason: 'snapshot-binding' })
  })

  test('rejects late opening observations at the immutable snapshot boundary', () => {
    const protocol = success(decodeDefaultOpeningDriveProtocol())
    const sessionDate = dateAt(0)
    const times = timesFor(sessionDate)
    const observedAt = new Date(Date.parse(times.open) + protocol.entryCutoffMinutesAfterOpen * 60_000).toISOString()
    const options = {
      sessionDate,
      phase: 'opening' as const,
      candidateMove: 0.02,
      benchmarkMove: 0,
      observedAt,
      quoteEventAt: observedAt,
      quoteIngestedAt: observedAt,
    }
    const verified = verifyIntradaySnapshot(
      requestFor(sessionDate, times.open, times.openingEnd, observedAt),
      rowsFor(options),
    )

    const failure = error(verified)
    expect(failure.reason).toBe('request')
    expect(failure.message).toContain('twenty minutes')
  })

  test('rejects a sufficiently observed strategy that loses after all modeled costs', () => {
    const protocol = success(decodeDefaultOpeningDriveProtocol())
    const sessions = Array.from({ length: qualificationTestSessionCount }, (_, ordinal) => replayInput(ordinal, -0.02))
    const calendar = calendarFor(sessions)
    const result = success(
      qualifyOpeningDrive({
        sessions,
        calendar,
        protocol,
        policy: qualificationTestPolicy,
        binding: binding(calendar, sessions, 0, qualificationTestPolicy),
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
          binding: binding(mutatedCalendar, [mutated]),
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
          binding: binding(selfRehashedCalendar, [selfRehashed]),
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
          binding: binding(duplicateCalendar, [first, first]),
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
          binding: binding(reversedCalendar, reversed),
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
            ...binding(firstCalendar, [first]),
            priorTrialReceiptHashes: ['f'.repeat(64), '0'.repeat(64)],
          },
        }),
      ),
    ).toMatchObject({ reason: 'trial-lineage' })
  })

  test('rejects omitted finalized sessions and a calendar not frozen in the qualification binding', () => {
    const protocol = success(decodeDefaultOpeningDriveProtocol())
    const sessions = Array.from({ length: qualificationTestSessionCount }, (_, ordinal) =>
      replayInput(ordinal, ordinal === 17 ? -0.03 : 0.02),
    )
    const calendar = calendarFor(sessions)
    const incompleteSessions = sessions.filter((_, ordinal) => ordinal !== 17)

    expect(
      error(
        qualifyOpeningDrive({ sessions: incompleteSessions, calendar, protocol, binding: binding(calendar, sessions) }),
      ),
    ).toMatchObject({ reason: 'session-order' })
    expect(
      error(
        qualifyOpeningDrive({
          sessions,
          calendar,
          protocol,
          binding: {
            ...binding(calendar, sessions),
            evaluationCalendarHash: sha256('different-finalized-calendar'),
          },
        }),
      ),
    ).toMatchObject({ reason: 'session-order' })
  })

  test('rejects forged qualification calendar schema and source literals before replay', () => {
    const protocol = success(decodeDefaultOpeningDriveProtocol())
    const sessions = [replayInput(0, 0.02)]
    const calendar = calendarFor(sessions)

    for (const forged of [
      { ...calendar, schemaVersion: 'bayn.opening-drive.qualification-calendar.v2' },
      { ...calendar, source: 'unreviewed.exchange_sessions' },
    ]) {
      expect(
        error(
          qualifyOpeningDrive({
            sessions,
            calendar: forged as never,
            protocol,
            binding: binding(calendar, sessions),
          }),
        ),
      ).toMatchObject({
        reason: 'session-order',
        message: 'opening-drive qualification calendar schema and source do not match the reviewed contract',
      })
    }
  })

  test('keeps entry-time quantity when exit liquidity is unavailable and rejects the unclosed position', () => {
    const protocol = success(decodeDefaultOpeningDriveProtocol())
    const sessions = Array.from({ length: qualificationTestSessionCount }, (_, ordinal) =>
      replayInput(ordinal, 0.02, 0, ordinal === 9 ? { quoteBidSize: 0 } : {}),
    )
    const calendar = calendarFor(sessions)
    const result = success(
      qualifyOpeningDrive({
        sessions,
        calendar,
        protocol,
        policy: qualificationTestPolicy,
        binding: binding(calendar, sessions, 0, qualificationTestPolicy),
      }),
    )
    const constrained = result.sessions[9]

    expect(constrained?.candidate.executedSymbols).toHaveLength(3)
    expect(constrained?.candidate.flat).toBe(false)
    expect(BigInt(constrained?.candidate.unclosedQuantityMicros ?? '0')).toBeGreaterThan(0n)
    expect(BigInt(constrained?.candidate.unclosedQuantityMicros ?? '0') % 1_000_000n).toBe(0n)
    expect(BigInt(constrained?.candidate.terminalRemainderNotionalMicros ?? '0')).toBeGreaterThan(0n)
    expect(constrained?.candidate.return).toBeGreaterThan(-1)
    expect(result.receipt.verdict).toBe('REJECTED')
    expect(result.receipt.reasonCodes).toContain('candidate-same-session-flat')
  })

  test('rejects an old market event even when its ingestion timestamp is recent', () => {
    const sessionDate = dateAt(0)
    const times = timesFor(sessionDate)
    const request = requestFor(sessionDate, times.exitStart, times.exitEnd, `${sessionDate}T20:44:00.000Z`)
    const result = verifyIntradaySnapshot(
      request,
      rowsFor({
        sessionDate,
        phase: 'exit',
        candidateMove: 0.02,
        benchmarkMove: 0,
        quoteEventAt: `${sessionDate}T20:30:15.000Z`,
        quoteIngestedAt: `${sessionDate}T20:43:59.000Z`,
        observedAt: `${sessionDate}T20:44:00.000Z`,
      }),
    )

    expect(error(result)).toMatchObject({ reason: 'freshness' })
  })
})
