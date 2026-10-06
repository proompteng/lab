import { BigDecimal, Data, Result, Schema } from 'effect'

import { MarketCalendarResponseSchema } from '../broker/alpaca/model'
import { normalizeMarketCalendarResult } from '../broker/alpaca/normalizers'
import { canonicalHashV1Result } from '../hash'
import { jevEntryQuoteExclusion } from '../jev/trading-signals'
import type { IntradayQuote, IntradaySnapshotQuery } from '../market-data/intraday/model'
import { intradayInstantNanos } from '../market-data/intraday/time'
import { SimulatedSnapshotSourceSchema } from '../market-data/streaming/evidence-schema'
import type { HistoricalMarketCursor } from '../market-data/streaming/historical'
import { discardedRejectionsOverlap, observedQuoteAt, topicPartitionKey } from '../market-data/streaming/projection'
import { IsoDateSchema, Sha256Schema, UtcInstantSchema, strictParseOptions } from '../schemas'
import { replayQuoteRejection, ReplayQuoteRejection } from './broker-execution-evidence'
import { extractSixBarResearchObservation, SixBarResearchStatus, sixBarResearchDefinition } from './six-bar-features'

export const gapRecoveryDefinition = {
  schemaVersion: 'bayn.gap-recovery-definition.v1',
  candidate: 'OVERNIGHT_GAP_RECOVERY_INTRADAY_V1',
  universeId: 'torghut-core-equity-v2',
  universeSymbolHash: '12d8e7ad3e0087e85c39f47896e77adde6bb8e029724a70aae1ef5fd393bddf1',
  candidates: [
    'AAPL',
    'AMD',
    'AMZN',
    'AVGO',
    'COHR',
    'CRDO',
    'IWM',
    'LITE',
    'MRVL',
    'MU',
    'NVDA',
    'QQQ',
    'SMH',
    'SNDK',
    'WDC',
  ],
  benchmarkSymbol: 'SPY',
  sourceTopics: { bars: 'torghut.bars.1m.v1', quotes: 'torghut.quotes.v1', trades: 'torghut.trades.v1' },
  featureTopic: 'torghut.market-features.v1',
  feed: 'iex',
  delayClass: 'real_time_exchange_only',
  previousCloseOffsetMs: 30_000,
  openingOffsetMs: 30_000,
  decisionOffsetMs: 1_830_000,
  maximumQuoteAgeMs: 10_000,
  maximumOvernightGapBps: -50,
  minimumOpeningRecoveryBps: 25,
  protectiveStopBps: 50,
  flattenBeforeCloseMs: 300_000,
  entryPolicy:
    'One attempt, one long position; no re-entry. Positive SPY opening return, negative candidate full return, inclusive gap and recovery thresholds. Lowest benchmark-relative overnight gap, then symbol.',
  endpointPolicy:
    'Prior close minus thirty seconds, open plus thirty seconds and decision time. Retained midquotes are not official auction prices. Original consumer availability, positive sizes and ten-second quote freshness remain required.',
  inputPolicy:
    'The native six-bar contract is required at decision. Its first-publication and original-receipt validation is stricter than the earlier archive-based development screen.',
  lifecycle:
    'Exit at the protective bid stop or five minutes before close; retain a pending exit. Missing pricing never becomes a fill. No fifteen-minute maximum hold.',
} as const

const universe = [...gapRecoveryDefinition.candidates, gapRecoveryDefinition.benchmarkSymbol].sort()
export const GapRecoverySessionSchema = Schema.Struct({
  schemaVersion: Schema.Literal('bayn.gap-recovery-session.v1'),
  sessionDate: IsoDateSchema,
  calendar: MarketCalendarResponseSchema.check(Schema.isMinLength(2), Schema.isMaxLength(32)),
  calendarHash: Sha256Schema,
})

export class GapRecoveryFailure extends Data.TaggedError('GapRecoveryFailure')<{
  readonly message: string
  readonly cause?: unknown
}> {}

const failure = (message: string, cause?: unknown) => new GapRecoveryFailure({ message, cause })

export const prepareGapRecoverySession = (raw: unknown) =>
  Result.gen(function* () {
    const input = yield* Schema.decodeUnknownResult(GapRecoverySessionSchema, strictParseOptions)(raw)
    if ((yield* canonicalHashV1Result(input.calendar)) !== input.calendarHash)
      return yield* Result.fail(failure('Gap calendar hash differs'))
    const dates = input.calendar.map((day) => day.date)
    if (dates.some((date, index) => index > 0 && date <= (dates[index - 1] ?? '')))
      return yield* Result.fail(failure('Gap calendar must contain unique chronological sessions'))
    const first = dates[0],
      last = dates.at(-1)
    if (first === undefined || last === undefined) return yield* Result.fail(failure('Gap calendar is empty'))
    const calendar = yield* normalizeMarketCalendarResult(input.calendar, { start: first, end: last })
    const index = calendar.sessions.findIndex((day) => day.date === input.sessionDate)
    const session = calendar.sessions[index],
      previous = calendar.sessions[index - 1]
    if (session === undefined || previous === undefined)
      return yield* Result.fail(failure('Gap recovery needs the preceding broker calendar session'))
    const openMs = Date.parse(session.openAt),
      closeMs = Date.parse(session.closeAt)
    const previousOpenMs = Date.parse(previous.openAt),
      previousCloseMs = Date.parse(previous.closeAt)
    if (previousCloseMs <= previousOpenMs + 30_000 || previousCloseMs >= openMs || closeMs <= openMs + 2_130_000)
      return yield* Result.fail(failure('Gap session boundaries cannot contain the frozen observations'))
    return {
      input,
      calendar,
      session,
      previous,
      openMs,
      closeMs,
      priorAtMs: previousCloseMs - gapRecoveryDefinition.previousCloseOffsetMs,
      openingAtMs: openMs + gapRecoveryDefinition.openingOffsetMs,
      decisionAtMs: openMs + gapRecoveryDefinition.decisionOffsetMs,
    }
  })

export type GapRecoverySession = Result.Result.Success<ReturnType<typeof prepareGapRecoverySession>>
export enum GapEndpointKind {
  PreviousClose = 'PREVIOUS_CLOSE',
  Opening = 'OPENING',
  Decision = 'DECISION',
}
export enum GapEndpointStatus {
  Available = 'AVAILABLE',
  Missing = 'MISSING',
  Stale = 'STALE',
  NoSize = 'NO_SIZE',
  CutUnavailable = 'CUT_UNAVAILABLE',
}
export enum GapRecoveryDecision {
  Selected = 'SELECTED',
  NoSignal = 'NO_SIGNAL',
  BenchmarkUnavailable = 'BENCHMARK_UNAVAILABLE',
  MarketFilter = 'MARKET_FILTER',
  InputsUnavailable = 'INPUTS_UNAVAILABLE',
}
export enum GapExitReason {
  Stop = 'PROTECTIVE_STOP',
  Close = 'CLOSE_WINDOW',
}
export enum GapExitAction {
  Hold = 'HOLD',
  Exit = 'EXIT',
  Unavailable = 'UNAVAILABLE',
  DeadlinePassed = 'DEADLINE_PASSED',
}

const originalSource = (cursor: HistoricalMarketCursor, atMs: number, sessionOpenMs: number) =>
  Result.gen(function* () {
    const source = yield* Schema.decodeUnknownResult(SimulatedSnapshotSourceSchema, strictParseOptions)(cursor.source)
    if (
      source.deliveryModel.schemaVersion !== 'bayn.original-capture-arrivals.v1' ||
      source.runId !== cursor.runId ||
      cursor.projection.availabilityMode !== 'simulated' ||
      source.featureTopic !== gapRecoveryDefinition.featureTopic ||
      source.featureTopic !== cursor.universe.topics.features ||
      source.technicalFeatureTopic !== cursor.universe.topics.technicalFeatures ||
      source.regeneratedFeaturesRecordedAtMs !== undefined ||
      source.regeneratedTechnicalFeaturesRecordedAtMs !== undefined ||
      cursor.regeneratedFeaturesRecordedAtMs !== undefined ||
      cursor.regeneratedTechnicalFeaturesRecordedAtMs !== undefined ||
      cursor.universe.universeId !== gapRecoveryDefinition.universeId ||
      cursor.universe.universeSymbolHash !== gapRecoveryDefinition.universeSymbolHash ||
      cursor.universe.symbols.join(',') !== universe.join(',') ||
      Object.entries(gapRecoveryDefinition.sourceTopics).some(
        ([channel, topic]) =>
          cursor.universe.topics[channel as keyof typeof gapRecoveryDefinition.sourceTopics] !== topic,
      ) ||
      (cursor.lastArrival !== null &&
        (cursor.lastArrival.availableAtMs > atMs ||
          cursor.lastArrival.receipt === undefined ||
          !('consumerSequence' in cursor.lastArrival.receipt) ||
          cursor.lastArrival.receipt.captureId !== source.deliveryModel.captureId))
    )
      return yield* Result.fail(
        failure('Gap recovery requires the frozen universe and an original-receipt cursor at the observation cut'),
      )
    if (discardedRejectionsOverlap(cursor.projection, sessionOpenMs))
      return yield* Result.fail(failure('Gap source cannot recover discarded rejection evidence'))
    for (const rejections of cursor.projection.rejections.values())
      if (rejections.some((entry) => entry.availableAtMs >= sessionOpenMs && entry.availableAtMs <= atMs))
        return yield* Result.fail(failure('Gap source contains rejected records in the session'))
    return source
  })

const quoteObservation = (cursor: HistoricalMarketCursor, symbol: string, atMs: number, sessionOpenMs: number) =>
  Result.gen(function* () {
    const quote = observedQuoteAt(cursor.projection, symbol, atMs)
    const material =
      quote === undefined
        ? null
        : {
            value: quote.value,
            availableAtMs: quote.availableAtMs,
            projectionSequence: quote.sequence,
            recordTextSha256: quote.recordHash,
            normalizedContentHash: yield* canonicalHashV1Result(quote.value),
          }
    if (cursor.projection.minimumObservationMs > atMs)
      return { symbol, status: GapEndpointStatus.CutUnavailable, record: material }
    const rejection = replayQuoteRejection(quote, symbol, atMs, gapRecoveryDefinition)
    if (rejection === ReplayQuoteRejection.Missing || quote === undefined)
      return { symbol, status: GapEndpointStatus.Missing, record: material }
    const value = quote.value
    const offset = cursor.projection.offsets.get(topicPartitionKey(value.sourceTopic, value.sourcePartition))
    const eventNs = intradayInstantNanos(value.eventAt),
      ingestNs = intradayInstantNanos(value.ingestedAt)
    if (
      value.provider !== 'alpaca' ||
      value.universeId !== gapRecoveryDefinition.universeId ||
      value.universeSymbolHash !== gapRecoveryDefinition.universeSymbolHash ||
      value.sourceTopic !== gapRecoveryDefinition.sourceTopics.quotes ||
      ingestNs < eventNs ||
      ingestNs > BigInt(quote.availableAtMs) * 1_000_000n ||
      offset === undefined ||
      BigInt(value.sourceOffset) > BigInt(offset) ||
      quote.sequence > cursor.projection.sequence ||
      !Number.isFinite(value.bidSize) ||
      !Number.isFinite(value.askSize) ||
      value.bidSize < 0 ||
      value.askSize < 0
    )
      return yield* Result.fail(
        failure('Gap endpoint record is outside its source identity, publication or receipt cut'),
      )
    if (rejection !== null && rejection !== ReplayQuoteRejection.Stale)
      return yield* Result.fail(failure(`Invalid gap endpoint quote: ${rejection}`))
    if (rejection === ReplayQuoteRejection.Stale || eventNs < BigInt(sessionOpenMs) * 1_000_000n)
      return { symbol, status: GapEndpointStatus.Stale, record: material }
    if (value.bidSize === 0 || value.askSize === 0)
      return { symbol, status: GapEndpointStatus.NoSize, record: material }
    return { symbol, status: GapEndpointStatus.Available, record: material }
  })

const endpointBrand: unique symbol = Symbol('GapEndpoint')
type EndpointMaterial = {
  readonly kind: GapEndpointKind
  readonly observedAt: string
  readonly sessionDate: string
  readonly source: typeof SimulatedSnapshotSourceSchema.Type
  readonly sequence: number
  readonly quotes: readonly Result.Result.Success<ReturnType<typeof quoteObservation>>[]
}
export type GapRecoveryEndpoint = EndpointMaterial & { readonly [endpointBrand]: true }

export const observeGapRecoveryEndpoint = (
  cursor: HistoricalMarketCursor,
  session: GapRecoverySession,
  kind: GapEndpointKind,
) =>
  Result.gen(function* () {
    const atMs =
      kind === GapEndpointKind.PreviousClose
        ? session.priorAtMs
        : kind === GapEndpointKind.Opening
          ? session.openingAtMs
          : session.decisionAtMs
    const day = kind === GapEndpointKind.PreviousClose ? session.previous : session.session
    const source = yield* originalSource(cursor, atMs, Date.parse(day.openAt))
    const quotes = yield* Result.all(
      universe.map((symbol) => quoteObservation(cursor, symbol, atMs, Date.parse(day.openAt))),
    )
    return Object.freeze({
      kind,
      observedAt: new Date(atMs).toISOString(),
      sessionDate: day.date,
      source,
      sequence: cursor.projection.sequence,
      quotes,
      [endpointBrand]: true as const,
    })
  }).pipe(Result.mapError((cause) => failure('Cannot observe the gap endpoint', cause)))

const priceScale = (quotes: readonly IntradayQuote[]) => {
  const decimals = quotes.flatMap((q) => [q.bidPrice, q.askPrice]).map(BigDecimal.fromNumberUnsafe)
  const scale = Math.max(0, ...decimals.map((v) => v.scale))
  const units = (n: number) => {
    const d = BigDecimal.fromNumberUnsafe(n)
    return d.value * 10n ** BigInt(scale - d.scale)
  }
  return (q: IntradayQuote) => units(q.bidPrice) + units(q.askPrice)
}
const ratio = (numerator: bigint, denominator: bigint) => ({
  numerator: String(numerator),
  denominator: String(denominator),
})

export const decideGapRecovery = (
  previous: GapRecoveryEndpoint,
  opening: GapRecoveryEndpoint,
  cursor: HistoricalMarketCursor,
  session: GapRecoverySession,
) =>
  Result.gen(function* () {
    if (
      previous.kind !== GapEndpointKind.PreviousClose ||
      opening.kind !== GapEndpointKind.Opening ||
      previous.observedAt !== new Date(session.priorAtMs).toISOString() ||
      previous.sessionDate !== session.previous.date ||
      opening.observedAt !== new Date(session.openingAtMs).toISOString() ||
      opening.sessionDate !== session.session.date
    )
      return yield* Result.fail(failure('Gap endpoint roles or calendar times differ'))
    const decision = yield* observeGapRecoveryEndpoint(cursor, session, GapEndpointKind.Decision)
    if (
      (yield* canonicalHashV1Result(opening.source)) !== (yield* canonicalHashV1Result(decision.source)) ||
      opening.sequence > decision.sequence
    )
      return yield* Result.fail(failure('Opening and decision must use the same chronological source'))
    const endpoints = [previous, opening, decision]
    const complete = new Map<string, readonly [IntradayQuote, IntradayQuote, IntradayQuote]>()
    const exclusions: { symbol: string; endpoints: GapEndpointKind[] }[] = []
    for (const symbol of universe) {
      const rows = endpoints.map((e) => e.quotes.find((q) => q.symbol === symbol))
      const [p, o, d] = rows
      if (
        p?.status === GapEndpointStatus.Available &&
        o?.status === GapEndpointStatus.Available &&
        d?.status === GapEndpointStatus.Available &&
        p.record !== null &&
        o.record !== null &&
        d.record !== null
      )
        complete.set(symbol, [p.record.value, o.record.value, d.record.value])
      else
        exclusions.push({
          symbol,
          endpoints: endpoints.filter((_, i) => rows[i]?.status !== GapEndpointStatus.Available).map((e) => e.kind),
        })
    }
    const mid = priceScale([...complete.values()].flat())
    const values = new Map(
      [...complete].map(([s, qs]) => [s, { prior: mid(qs[0]), open: mid(qs[1]), current: mid(qs[2]) }]),
    )
    const spy = values.get(gapRecoveryDefinition.benchmarkSymbol)
    const benchmarkQuote = complete.get(gapRecoveryDefinition.benchmarkSymbol)?.[2]
    // Check required benchmark pricing independently: a candidate may be excluded before the six-bar reader reaches SPY.
    const benchmarkExcluded =
      benchmarkQuote !== undefined &&
      (yield* jevEntryQuoteExclusion(benchmarkQuote, sixBarResearchDefinition.maximumSpreadBps)) !== null
    const candidates = []
    const endMs = Math.floor((session.decisionAtMs - 2_000) / 60_000) * 60_000
    for (const symbol of gapRecoveryDefinition.candidates) {
      const query: IntradaySnapshotQuery = {
        sessionDate: session.input.sessionDate,
        calendar: session.calendar,
        observedAt: new Date(session.decisionAtMs).toISOString(),
        rangeStartAt: new Date(endMs - 360_000).toISOString(),
        rangeEndAt: new Date(endMs).toISOString(),
        universeId: gapRecoveryDefinition.universeId,
        universeSymbolHash: gapRecoveryDefinition.universeSymbolHash,
        universe,
        symbols: [symbol, gapRecoveryDefinition.benchmarkSymbol].sort(),
        candidateSymbols: [symbol],
        candidateEvidencePolicy: sixBarResearchDefinition.candidateEvidencePolicy,
        sourceTopics: gapRecoveryDefinition.sourceTopics,
        feed: gapRecoveryDefinition.feed,
        delayClass: gapRecoveryDefinition.delayClass,
        maximumQuoteAgeMs: gapRecoveryDefinition.maximumQuoteAgeMs,
        minimumWatermarkLagMs: 2_000,
      }
      const feature = yield* extractSixBarResearchObservation(cursor, query)
      const v = values.get(symbol)
      const eligible =
        v !== undefined &&
        spy !== undefined &&
        !benchmarkExcluded &&
        spy.current > spy.open &&
        feature.status === SixBarResearchStatus.Available &&
        (v.open - v.prior) * 10_000n <= -50n * v.prior &&
        (v.current - v.open) * 10_000n >= 25n * v.open &&
        v.current < v.prior
      candidates.push({
        symbol,
        eligible,
        feature,
        returns:
          v === undefined
            ? null
            : {
                overnightGapBps: ratio((v.open - v.prior) * 10_000n, v.prior),
                openingReturnBps: ratio((v.current - v.open) * 10_000n, v.open),
                fullReturnBps: ratio((v.current - v.prior) * 10_000n, v.prior),
                relativeOvernightGapBps:
                  spy === undefined
                    ? null
                    : ratio((v.open * spy.prior - spy.open * v.prior) * 10_000n, v.prior * spy.prior),
              },
      })
    }
    const eligible = candidates
      .filter((c) => c.eligible)
      .toSorted((a, b) => {
        const left = values.get(a.symbol),
          right = values.get(b.symbol)
        if (left === undefined || right === undefined) return 0
        const comparison = left.open * right.prior - right.open * left.prior
        return comparison < 0n ? -1 : comparison > 0n ? 1 : a.symbol < b.symbol ? -1 : a.symbol > b.symbol ? 1 : 0
      })
    const inputComplete =
      !benchmarkExcluded &&
      exclusions.length === 0 &&
      candidates.every((c) => c.feature.status !== SixBarResearchStatus.Unavailable)
    const status =
      spy === undefined || benchmarkExcluded
        ? GapRecoveryDecision.BenchmarkUnavailable
        : spy.current <= spy.open
          ? GapRecoveryDecision.MarketFilter
          : eligible.length > 0
            ? GapRecoveryDecision.Selected
            : inputComplete
              ? GapRecoveryDecision.NoSignal
              : GapRecoveryDecision.InputsUnavailable
    const endpointEvidence = endpoints.map(({ [endpointBrand]: _brand, ...material }) => material)
    const report = {
      schemaVersion: 'bayn.gap-recovery-decision.v1',
      qualification: 'UNQUALIFIED',
      controllerCoverage: 'UNKNOWN',
      definition: gapRecoveryDefinition,
      definitionHash: yield* canonicalHashV1Result(gapRecoveryDefinition),
      session: session.input,
      endpoints: endpointEvidence,
      candidates,
      endpointExclusions: exclusions,
      inputComplete,
      status,
      selectedSymbol: eligible.at(0)?.symbol ?? null,
      execution: 'NOT_SIMULATED',
      profitability: 'NOT_ESTABLISHED',
      capitalAuthority: 'NONE',
    }
    return { ...report, reportHash: yield* canonicalHashV1Result(report) }
  }).pipe(Result.mapError((cause) => failure('Gap recovery decision failed', cause)))

const PositionSchema = Schema.Struct({
  symbol: Schema.Literals(gapRecoveryDefinition.candidates),
  firstFilledAt: UtcInstantSchema,
  averageEntryPrice: Schema.Finite.check(Schema.isGreaterThan(0)),
  pendingExit: Schema.NullOr(Schema.Enum(GapExitReason)),
})

export const decideGapRecoveryExit = (
  cursor: HistoricalMarketCursor,
  session: GapRecoverySession,
  at: string,
  rawPosition: unknown,
) =>
  Result.gen(function* () {
    const observedAt = yield* Schema.decodeUnknownResult(UtcInstantSchema, strictParseOptions)(at)
    const atMs = Date.parse(observedAt)
    const position = yield* Schema.decodeUnknownResult(PositionSchema, strictParseOptions)(rawPosition)
    const entryMs = Date.parse(position.firstFilledAt)
    if (
      entryMs < session.decisionAtMs ||
      entryMs >= session.closeMs - gapRecoveryDefinition.flattenBeforeCloseMs ||
      atMs < entryMs
    )
      return yield* Result.fail(failure('Gap position fill time or observation is outside the lifecycle'))
    yield* originalSource(cursor, atMs, session.openMs)
    const quote = yield* quoteObservation(cursor, position.symbol, atMs, session.openMs)
    const fresh = quote.status === GapEndpointStatus.Available && quote.record !== null
    let reason = position.pendingExit
    if (reason === null && atMs >= session.closeMs - gapRecoveryDefinition.flattenBeforeCloseMs)
      reason = GapExitReason.Close
    if (reason === null && fresh && quote.record !== null) {
      const bid = BigDecimal.fromNumberUnsafe(quote.record.value.bidPrice)
      const price = BigDecimal.fromNumberUnsafe(position.averageEntryPrice)
      if (
        BigDecimal.isLessThanOrEqualTo(
          BigDecimal.multiply(bid, BigDecimal.fromNumberUnsafe(10000)),
          BigDecimal.multiply(price, BigDecimal.fromNumberUnsafe(9950)),
        )
      )
        reason = GapExitReason.Stop
    }
    const action =
      atMs >= session.closeMs
        ? GapExitAction.DeadlinePassed
        : reason !== null
          ? GapExitAction.Exit
          : fresh
            ? GapExitAction.Hold
            : GapExitAction.Unavailable
    const outcome = {
      schemaVersion: 'bayn.gap-recovery-exit.v1',
      qualification: 'UNQUALIFIED',
      observedAt,
      position,
      action,
      reason,
      pricingAvailable: fresh,
      quote,
      capitalAuthority: 'NONE',
    }
    return { ...outcome, evidenceHash: yield* canonicalHashV1Result(outcome) }
  }).pipe(Result.mapError((cause) => failure('Gap recovery exit observation failed', cause)))
