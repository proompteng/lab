import { Effect, Result, Schema } from 'effect'
import type * as FileSystem from 'effect/FileSystem'

import { normalizeMarketCalendarResult } from '../../broker/alpaca/normalizers'
import {
  makeCycleExecutionPolicyFromModel,
  makeExecutionCalendarObservation,
  makeIntradayCycleWindow,
} from '../../cycle/construction'
import type { CycleExecutionPolicy, CycleWindow, ExecutionCalendarObservation } from '../../cycle/model'
import { makeStrategyProtocolHashResult } from '../../contracts'
import {
  embeddedBuildMetadata,
  embeddedRuntimeIdentity,
  EmbeddedBuildMetadataSchema,
  EmbeddedRuntimeIdentitySchema,
  verifyBehaviorHash,
  verifyExecutionRiskPolicyHash,
  verifyParameterHash,
  verifyStrategyName,
  verifyStrategyProtocolHash,
} from '../../build'
import { canonicalHashV1Result } from '../../hash'
import { OrderSide } from '../../execution/contracts'
import { desiredQuantityMicros, numberToMicros, notionalMicros } from '../../execution-model'
import { loadQuoteBoundExecutionRiskPolicy } from '../../observe-composition/decision-builder'
import { adverseQuotePrices, maximumBuyQuantities } from '../../observe-composition/intraday-market-data'
import { IsoDateSchema, strictParseOptions, UtcInstantSchema } from '../../schemas'
import type { IsoDate } from '../../schemas'
import { activeStrategyBehaviorHash, activeStrategyName, makeIntradayMomentumDefinition } from '../../strategy'
import {
  decodeDefaultIntradayMomentumProtocol,
  hashIntradayMomentumProtocol,
  intradayMomentumSnapshotSymbols,
  type IntradayMomentumProtocol,
} from '../../strategy/intraday-momentum/protocol'
import {
  decideIntradayMomentumCore,
  type IntradayMomentumCoreOutput,
} from '../../strategy/intraday-momentum/decision-core'
import { utcInstantFromEpochMillis } from '../../time'
import { compareIntradayInstants } from '../../market-data/intraday/time'
import { markIntradayReplayEquity, type IntradayReplayEquityMark } from '../equity'
import { allocationForDecision } from '../allocation'
import { applyReplayFill, createReplayLedger, type ReplayLedger } from '../ledger'
import { simulateIntradayReplayIocCore, type IntradayReplayIocCoreOutcome } from '../execution-core'
import {
  decodeVendorReplayInput,
  VendorReplayFailure,
  type VendorReplayFill,
  type VendorReplayInput,
  type VendorReplayObservation,
  type VendorReplayOrder,
  type VendorReplayReport,
  type VendorReplayScenario,
  type VendorReplaySession,
} from './model'
import {
  validateVendorDecisionWindow,
  validateVendorQuoteWindow,
  type VendorBar,
  type VendorCaptureHashes,
  type VendorCalendarSession,
  type VendorQuote,
  type VendorTrade,
} from './window'
import {
  AlpacaHistoricalKind,
  type AlpacaHistoricalClient,
  type AlpacaHistoricalQuery,
  type VendorHistoricalCapture,
  type VendorHistoricalFailure,
} from './alpaca/model'

const minuteMs = 60_000
const secondMs = 1_000
const replayPolicySchemaVersion = 'bayn.autonomous-cycle-execution-policy.v3' as const
const quoteBundleSchemaVersion = 'bayn.vendor-replay-quote-observation.v1' as const

interface VendorReplayContext {
  readonly calendar: ExecutionCalendarObservation
  readonly session: VendorCalendarSession & { readonly date: IsoDate }
  readonly window: CycleWindow
}

interface ScenarioState {
  ledger: ReplayLedger<VendorReplayFill>
  peakEquityMicros: string
  maximumObservedDrawdownMicros: string
  riskLimitBreached: boolean
  stopped: boolean
}

interface SessionRun {
  readonly session: VendorReplaySession
  readonly state: ScenarioState
}

type CaptureAttempt =
  | { readonly _tag: 'Success'; readonly capture: VendorHistoricalCapture }
  | { readonly _tag: 'Failure'; readonly error: VendorHistoricalFailure }

type ObservationPurpose = 'decision' | 'planning' | 'arrival' | 'mark' | 'close'

const replayFailure = (
  operation: VendorReplayFailure['operation'],
  message: string,
  cause?: unknown,
): VendorReplayFailure => new VendorReplayFailure({ operation, message, ...(cause === undefined ? {} : { cause }) })

const resultFailure = <A>(
  operation: VendorReplayFailure['operation'],
  message: string,
  result: Result.Result<A, unknown>,
): Result.Result<A, VendorReplayFailure> =>
  Result.isFailure(result)
    ? Result.fail(replayFailure(operation, message, result.failure))
    : Result.succeed(result.success)

const parseMillis = (value: string): number => Date.parse(value)

const floorToMinute = (millis: number): number => Math.floor(millis / minuteMs) * minuteMs

const asOf = (millis: number): string => utcInstantFromEpochMillis(millis)

const compareEventAt = (left: string, right: string): number => {
  return compareIntradayInstants(left, right)
}

const failureMessage = (error: unknown): string => {
  if (error instanceof Error) return error.message
  if (typeof error === 'object' && error !== null && 'message' in error && typeof error.message === 'string') {
    return error.message
  }
  return 'vendor replay operation failed'
}

const unavailable = (
  observations: VendorReplayObservation[],
  purpose: ObservationPurpose,
  observedAt: string,
  error: unknown,
): void => {
  const details: { reasonCode?: string; symbol?: string; field?: string } = {}
  if (typeof error === 'object' && error !== null) {
    if ('reason' in error && typeof error.reason === 'string') details.reasonCode = error.reason
    if ('symbol' in error && typeof error.symbol === 'string') details.symbol = error.symbol
    if ('field' in error && typeof error.field === 'string') details.field = error.field
  }
  observations.push({ kind: 'unavailable', purpose, observedAt, reason: failureMessage(error), ...details })
}

const query = (
  kind: AlpacaHistoricalKind,
  context: VendorReplayContext,
  symbols: readonly string[],
  startAt: string,
  endAt: string,
  cacheDirectory: string,
): AlpacaHistoricalQuery => ({
  kind,
  sessionDate: context.session.date,
  sessionOpenAt: context.session.openAt,
  sessionCloseAt: context.session.closeAt,
  startAt,
  endAt,
  symbols: [...symbols].sort(),
  cacheDirectory,
})

const boundedQuoteQuery = (
  context: VendorReplayContext,
  symbols: readonly string[],
  observedAt: string,
  maximumQuoteAgeMs: number,
  cacheDirectory: string,
): AlpacaHistoricalQuery => {
  const observedMs = parseMillis(observedAt)
  return query(
    AlpacaHistoricalKind.Quotes,
    context,
    symbols,
    asOf(Math.max(parseMillis(context.session.openAt), observedMs - maximumQuoteAgeMs)),
    observedAt,
    cacheDirectory,
  )
}

const historicalQueryMatches = (requested: AlpacaHistoricalQuery, returned: AlpacaHistoricalQuery): boolean =>
  requested.kind === returned.kind &&
  requested.sessionDate === returned.sessionDate &&
  requested.sessionOpenAt === returned.sessionOpenAt &&
  requested.sessionCloseAt === returned.sessionCloseAt &&
  requested.startAt === returned.startAt &&
  requested.endAt === returned.endAt &&
  requested.symbols.length === returned.symbols.length &&
  requested.symbols.every((symbol, index) => symbol === returned.symbols[index])

const captureAttemptEffect = (
  client: AlpacaHistoricalClient,
  input: AlpacaHistoricalQuery,
): Effect.Effect<CaptureAttempt, VendorReplayFailure, FileSystem.FileSystem> =>
  client.capture(input).pipe(
    Effect.flatMap((capture) =>
      historicalQueryMatches(input, capture.query)
        ? Effect.succeed({ _tag: 'Success' as const, capture })
        : Effect.fail(
            replayFailure('market-data', 'historical capture query does not match the requested query identity'),
          ),
    ),
    Effect.catchTag('VendorHistoricalFailure', (error) => Effect.succeed({ _tag: 'Failure' as const, error })),
  )

const recordCapture = (
  captures: Map<
    string,
    { readonly provenanceHash: string; readonly provenance: VendorHistoricalCapture['provenance'] }
  >,
  capture: VendorHistoricalCapture,
): Result.Result<void, VendorReplayFailure> => {
  if (capture.provenance.queryHash !== capture.queryHash) {
    return Result.fail(replayFailure('market-data', 'historical capture query and provenance hashes disagree'))
  }
  const prior = captures.get(capture.queryHash)
  if (prior !== undefined && prior.provenanceHash !== capture.provenanceHash) {
    return Result.fail(replayFailure('market-data', 'historical query returned conflicting provenance receipts'))
  }
  captures.set(capture.queryHash, { provenanceHash: capture.provenanceHash, provenance: capture.provenance })
  return Result.succeed(undefined)
}

const captureIdentity = (capture: VendorHistoricalCapture) => ({
  kind: capture.kind,
  queryHash: capture.queryHash,
  provenanceHash: capture.provenanceHash,
  normalizedHash: capture.provenance.normalizedHash,
})

const hashValue = (
  operation: VendorReplayFailure['operation'],
  message: string,
  value: unknown,
): Result.Result<string, VendorReplayFailure> => resultFailure(operation, message, canonicalHashV1Result(value))

const captureHashesFor = (captures: readonly VendorHistoricalCapture[]): VendorCaptureHashes => {
  const hashes: VendorCaptureHashes = {}
  for (const capture of captures) {
    if (capture.kind === 'bars') hashes.bars = capture.provenanceHash
    if (capture.kind === 'quotes') hashes.quotes = capture.provenanceHash
    if (capture.kind === 'trades') hashes.trades = capture.provenanceHash
  }
  return hashes
}

const quoteObservationHash = (
  purpose: ObservationPurpose,
  context: VendorReplayContext,
  observedAt: string,
  quotes: Readonly<Record<string, VendorQuote>>,
  capture: VendorHistoricalCapture,
): Result.Result<string, VendorReplayFailure> =>
  hashValue('market-data', 'vendor quote observation cannot be hashed', {
    schemaVersion: quoteBundleSchemaVersion,
    purpose,
    session: context.session,
    observedAt,
    capture: captureIdentity(capture),
    quotes,
  })

const makeContext = (
  session: { readonly date: string; readonly openAt: string; readonly closeAt: string },
  executionPolicy: CycleExecutionPolicy,
): Result.Result<VendorReplayContext, VendorReplayFailure> => {
  const date = Schema.decodeUnknownResult(IsoDateSchema, strictParseOptions)(session.date)
  if (Result.isFailure(date)) {
    return Result.fail(replayFailure('calendar', 'vendor calendar session date is not a valid ISO date', date.failure))
  }
  const calendar = makeExecutionCalendarObservation({
    schemaVersion: 'bayn.alpaca-market-calendar-observation.v1',
    source: 'alpaca-v2-calendar',
    ...session,
  })
  if (Result.isFailure(calendar)) {
    return Result.fail(replayFailure('calendar', 'vendor calendar session construction failed', calendar.failure))
  }
  const window = makeIntradayCycleWindow(calendar.success, executionPolicy)
  if (Result.isFailure(window)) {
    return Result.fail(replayFailure('calendar', 'vendor intraday cycle window construction failed', window.failure))
  }
  return Result.succeed({
    calendar: calendar.success,
    session: {
      date: date.success,
      openAt: session.openAt,
      closeAt: session.closeAt,
      calendarHash: calendar.success.executionCalendarHash,
    },
    window: window.success,
  })
}

const toBars = (capture: VendorHistoricalCapture): Result.Result<readonly VendorBar[], VendorReplayFailure> =>
  capture.kind === 'bars'
    ? Result.succeed(capture.rows.map(({ symbol, eventAt, open, high, low }) => ({ symbol, eventAt, open, high, low })))
    : Result.fail(replayFailure('market-data', 'historical capture kind does not match the bars query'))

const toQuotes = (capture: VendorHistoricalCapture): Result.Result<readonly VendorQuote[], VendorReplayFailure> =>
  capture.kind === 'quotes'
    ? Result.succeed(
        capture.rows.map(({ symbol, eventAt, bidPrice, bidSize, askPrice, askSize }) => ({
          symbol,
          eventAt,
          bidPrice,
          bidSize,
          askPrice,
          askSize,
        })),
      )
    : Result.fail(replayFailure('market-data', 'historical capture kind does not match the quotes query'))

const toTrades = (capture: VendorHistoricalCapture): Result.Result<readonly VendorTrade[], VendorReplayFailure> =>
  capture.kind === 'trades'
    ? Result.succeed(capture.rows.map(({ symbol, eventAt, price }) => ({ symbol, eventAt, price })))
    : Result.fail(replayFailure('market-data', 'historical capture kind does not match the trades query'))

const displayedSellCapacity = (
  quotes: Readonly<Record<string, VendorQuote>>,
  symbol: string,
): Result.Result<bigint, VendorReplayFailure> => {
  const quantity = quotes[symbol]
  if (quantity === undefined) return Result.fail(replayFailure('market-data', `closing quote omitted ${symbol}`))
  const size = numberToMicros(quantity.bidSize, `close bid size for ${symbol}`)
  if (Result.isFailure(size))
    return Result.fail(replayFailure('market-data', 'close displayed bid size is invalid', size.failure))
  return Result.succeed((size.success / 1_000_000n) * 1_000_000n)
}

const orderFromOutcome = (
  symbol: string,
  side: OrderSide,
  submittedAt: string,
  arrivalAt: string,
  limitPriceMicros: string,
  requestedQuantityMicros: string,
  planningProvenanceHash: string,
  arrivalProvenanceHash: string,
  outcome: IntradayReplayIocCoreOutcome,
): VendorReplayOrder => ({
  symbol,
  side: side === OrderSide.Buy ? 'BUY' : 'SELL',
  submittedAt,
  arrivalAt,
  planningProvenanceHash,
  arrivalProvenanceHash,
  limitPriceMicros,
  requestedQuantityMicros,
  status: outcome.status,
  filledQuantityMicros: outcome.filledQuantityMicros.toString(),
  ...(outcome.status === 'filled'
    ? {
        fillPriceMicros: outcome.fillPriceMicros.toString(),
        fillNotionalMicros: outcome.fillNotionalMicros.toString(),
      }
    : { reason: outcome.reason }),
  unfilledRemainder: outcome.unfilledRemainder,
})

const applyOutcome = (
  ledger: ReplayLedger<VendorReplayFill>,
  outcome: IntradayReplayIocCoreOutcome,
  symbol: string,
  side: OrderSide,
  observedAt: string,
  provenanceHash: string,
  executionModel: IntradayMomentumProtocol['executionModel'],
  feeMultiplierPpm: number,
): Result.Result<ReplayLedger<VendorReplayFill>, VendorReplayFailure> => {
  if (outcome.status === 'canceled' || outcome.filledQuantityMicros === 0n) return Result.succeed(ledger)
  const fill: VendorReplayFill = {
    symbol,
    side: side === OrderSide.Buy ? 'buy' : 'sell',
    observedAt,
    quantityMicros: outcome.filledQuantityMicros.toString(),
    priceMicros: outcome.fillPriceMicros.toString(),
    notionalMicros: outcome.fillNotionalMicros.toString(),
    provenanceHash,
  }
  return Result.mapError(
    applyReplayFill(ledger, fill, outcome.requestedQuantityMicros.toString(), executionModel, feeMultiplierPpm),
    (cause) => replayFailure('accounting', 'vendor replay ledger rejected an IOC fill', cause),
  )
}

const riskMark = (
  state: ScenarioState,
  dayStartEquityMicros: string,
  policy: {
    readonly maxDailyLossMicros: string
    readonly maxDrawdownMicros: string
  },
): Result.Result<IntradayReplayEquityMark, VendorReplayFailure> =>
  Result.mapError(
    markIntradayReplayEquity({
      ledger: state.ledger,
      bidPriceMicros: {},
      dayStartEquityMicros,
      previousPeakEquityMicros: state.peakEquityMicros,
      previousMaximumObservedDrawdownMicros: state.maximumObservedDrawdownMicros,
      limits: policy,
    }),
    (cause) => replayFailure('accounting', 'vendor replay equity mark failed', cause),
  )

const sessionResult = (
  context: VendorReplayContext | undefined,
  date: string,
  calendarHash: string,
  state: ScenarioState,
  observations: readonly VendorReplayObservation[],
  orders: readonly VendorReplayOrder[],
  status: VendorReplaySession['status'],
  reason: string,
  sessionPeakEquityMicros: string | null,
  sessionMaximumDrawdownMicros: string | null,
  riskLimitBreached: boolean,
): VendorReplaySession => ({
  date: context?.session.date ?? date,
  calendarHash: context?.session.calendarHash ?? calendarHash,
  status,
  reason,
  observations: Object.freeze([...observations]),
  orders: Object.freeze([...orders]),
  ledger: state.ledger,
  maximumObservedDrawdownMicros: sessionMaximumDrawdownMicros,
  peakEquityMicros: sessionPeakEquityMicros,
  riskLimitBreached,
})

const skipSession = (
  context: VendorReplayContext | undefined,
  date: string,
  calendarHash: string,
  state: ScenarioState,
): SessionRun => ({
  session: sessionResult(
    context,
    date,
    calendarHash,
    state,
    [],
    [],
    'INCOMPLETE',
    'skipped after an earlier incomplete session',
    null,
    null,
    false,
  ),
  state,
})

const isRetryableWindowReason = (reason: string): boolean => reason === 'coverage' || reason === 'freshness'

const replaySession = (
  input: VendorReplayInput,
  scenario: VendorReplayInput['scenarios'][number],
  context: VendorReplayContext,
  state: ScenarioState,
  client: AlpacaHistoricalClient,
  cacheDirectory: string,
  protocol: IntradayMomentumProtocol,
  policy: {
    readonly maxOrderNotionalMicros: string
    readonly maxSymbolExposureMicros: string
    readonly maxGrossExposureMicros: string
    readonly maxNetExposureMicros: string
    readonly maxDailyTradedNotionalMicros: string
    readonly maxAdverseSlippageBps: number
    readonly maxDailyLossMicros: string
    readonly maxDrawdownMicros: string
  },
  captures: Map<
    string,
    { readonly provenanceHash: string; readonly provenance: VendorHistoricalCapture['provenance'] }
  >,
): Effect.Effect<SessionRun, VendorReplayFailure, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const observations: VendorReplayObservation[] = []
    const orders: VendorReplayOrder[] = []
    const symbols = intradayMomentumSnapshotSymbols(protocol)
    const dayStartEquityMicros = state.ledger.cashMicros
    let sessionPeakEquityMicros: string | null = null
    let sessionMaximumDrawdownMicros: string | null = null
    const priorRiskLimitBreached = state.riskLimitBreached
    let riskLimitBreached = false
    const sessionState = (stopped: boolean): ScenarioState => ({
      ...state,
      stopped,
      riskLimitBreached: priorRiskLimitBreached || riskLimitBreached,
    })

    const barsQuery = query(
      AlpacaHistoricalKind.Bars,
      context,
      symbols,
      context.window.executionOpenAt,
      context.window.submissionCutoffAt,
      cacheDirectory,
    )
    const barsAttempt = yield* captureAttemptEffect(client, barsQuery)
    if (barsAttempt._tag === 'Failure') {
      unavailable(observations, 'decision', context.window.submissionOpenAt, barsAttempt.error)
      const nextState = sessionState(true)
      return {
        session: sessionResult(
          context,
          context.session.date,
          context.session.calendarHash,
          nextState,
          observations,
          orders,
          'INCOMPLETE',
          `decision evidence unavailable: ${barsAttempt.error.message}`,
          sessionPeakEquityMicros,
          sessionMaximumDrawdownMicros,
          riskLimitBreached,
        ),
        state: nextState,
      }
    }
    const recordedBars = recordCapture(captures, barsAttempt.capture)
    if (Result.isFailure(recordedBars)) return yield* recordedBars.failure
    const bars = toBars(barsAttempt.capture)
    if (Result.isFailure(bars)) return yield* bars.failure

    let selectedDecision: IntradayMomentumCoreOutput | undefined
    let decisionObservedAt: string | undefined
    let decisionProvenanceHash: string | undefined
    let decisionRangeEndAt: string | undefined
    let hadUnavailableDecision = false
    let structuralFailure: string | undefined
    const entryStart = parseMillis(context.window.submissionOpenAt) + scenario.assumptions.firstPollDelayMs
    const entryCutoff = parseMillis(context.window.submissionCutoffAt)
    for (let observedMs = entryStart; observedMs < entryCutoff; observedMs += scenario.assumptions.pollIntervalMs) {
      const observedAt = asOf(observedMs)
      const rangeEndAt = asOf(floorToMinute(observedMs - protocol.decisionDelaySeconds * secondMs))
      const rangeStartAt = asOf(
        floorToMinute(observedMs - protocol.decisionDelaySeconds * secondMs) - protocol.lookbackMinutes * minuteMs,
      )
      const quoteQuery = query(
        AlpacaHistoricalKind.Quotes,
        context,
        symbols,
        asOf(Math.max(parseMillis(context.window.executionOpenAt), observedMs - protocol.maximumQuoteAgeMs)),
        observedAt,
        cacheDirectory,
      )
      const tradeQuery = query(
        AlpacaHistoricalKind.Trades,
        context,
        symbols,
        asOf(Math.max(parseMillis(context.window.executionOpenAt), observedMs - protocol.maximumQuoteAgeMs)),
        observedAt,
        cacheDirectory,
      )
      const quoteAttempt = yield* captureAttemptEffect(client, quoteQuery)
      const tradeAttempt = yield* captureAttemptEffect(client, tradeQuery)
      if (quoteAttempt._tag === 'Failure' || tradeAttempt._tag === 'Failure') {
        hadUnavailableDecision = true
        if (quoteAttempt._tag === 'Failure') unavailable(observations, 'decision', observedAt, quoteAttempt.error)
        if (tradeAttempt._tag === 'Failure') unavailable(observations, 'decision', observedAt, tradeAttempt.error)
        if (
          (quoteAttempt._tag === 'Failure' && !quoteAttempt.error.retryable) ||
          (tradeAttempt._tag === 'Failure' && !tradeAttempt.error.retryable)
        ) {
          structuralFailure = 'historical decision capture failed'
          break
        }
        continue
      }
      const recordQuote = recordCapture(captures, quoteAttempt.capture)
      const recordTrade = recordCapture(captures, tradeAttempt.capture)
      if (Result.isFailure(recordQuote)) return yield* recordQuote.failure
      if (Result.isFailure(recordTrade)) return yield* recordTrade.failure
      const quoteRows = toQuotes(quoteAttempt.capture)
      const tradeRows = toTrades(tradeAttempt.capture)
      if (Result.isFailure(quoteRows)) return yield* quoteRows.failure
      if (Result.isFailure(tradeRows)) return yield* tradeRows.failure
      const decisionWindow = validateVendorDecisionWindow({
        protocol,
        session: context.session,
        observedAt,
        rangeStartAt,
        rangeEndAt,
        bars: bars.success.filter(
          (bar) => compareEventAt(bar.eventAt, rangeStartAt) >= 0 && compareEventAt(bar.eventAt, rangeEndAt) < 0,
        ),
        quotes: quoteRows.success,
        trades: tradeRows.success,
        captureHashes: captureHashesFor([barsAttempt.capture, quoteAttempt.capture, tradeAttempt.capture]),
      })
      if (Result.isFailure(decisionWindow)) {
        hadUnavailableDecision = true
        unavailable(observations, 'decision', observedAt, decisionWindow.failure)
        if (!isRetryableWindowReason(decisionWindow.failure.reason)) {
          structuralFailure = decisionWindow.failure.message
          break
        }
        continue
      }
      const decision = decideIntradayMomentumCore(decisionWindow.success.coreInput)
      if (Result.isFailure(decision)) {
        hadUnavailableDecision = true
        unavailable(observations, 'decision', observedAt, decision.failure)
        if (decision.failure.reason !== 'snapshot-coverage') {
          structuralFailure = decision.failure.message
          break
        }
        continue
      }
      observations.push({
        kind: 'decision',
        observedAt,
        provenanceHash: decisionWindow.success.provenanceHash,
        decision: decision.success,
      })
      if (decision.success.selectedSymbols.length === 0) continue
      if (decision.success.selectedSymbols.length > 1) {
        structuralFailure = 'active intraday-momentum selected more than one entry symbol'
        break
      }
      selectedDecision = decision.success
      decisionObservedAt = observedAt
      decisionProvenanceHash = decisionWindow.success.provenanceHash
      decisionRangeEndAt = rangeEndAt
      break
    }

    const incomplete = (reason: string): SessionRun => {
      const nextState = sessionState(true)
      return {
        session: sessionResult(
          context,
          context.session.date,
          context.session.calendarHash,
          nextState,
          observations,
          orders,
          'INCOMPLETE',
          reason,
          sessionPeakEquityMicros,
          sessionMaximumDrawdownMicros,
          riskLimitBreached,
        ),
        state: nextState,
      }
    }
    if (structuralFailure !== undefined) return incomplete(`entry evidence incomplete: ${structuralFailure}`)
    if (selectedDecision === undefined || decisionObservedAt === undefined || decisionRangeEndAt === undefined) {
      return hadUnavailableDecision
        ? incomplete('entry evidence incomplete: no-trade result followed unavailable decision observations')
        : (() => {
            const flatMark = riskMark(state, dayStartEquityMicros, policy)
            if (Result.isFailure(flatMark)) return incomplete(flatMark.failure.message)
            state.peakEquityMicros = flatMark.success.peakEquityMicros
            state.maximumObservedDrawdownMicros = flatMark.success.maximumObservedDrawdownMicros
            sessionPeakEquityMicros = flatMark.success.peakEquityMicros
            sessionMaximumDrawdownMicros = flatMark.success.maximumObservedDrawdownMicros
            riskLimitBreached ||=
              flatMark.success.dailyLossLimit?.exceeded === true || flatMark.success.drawdownLimit?.exceeded === true
            const completedState = sessionState(false)
            return {
              session: sessionResult(
                context,
                context.session.date,
                context.session.calendarHash,
                completedState,
                observations,
                orders,
                'COMPLETE',
                'no qualifying intraday-momentum signal',
                sessionPeakEquityMicros,
                sessionMaximumDrawdownMicros,
                riskLimitBreached,
              ),
              state: completedState,
            }
          })()
    }
    const symbol = selectedDecision.selectedSymbols[0]
    if (symbol === undefined || decisionProvenanceHash === undefined)
      return incomplete('selected entry is missing its symbol or provenance')

    const baselineRisk = riskMark(state, dayStartEquityMicros, policy)
    if (Result.isFailure(baselineRisk)) return incomplete(baselineRisk.failure.message)
    state.peakEquityMicros = baselineRisk.success.peakEquityMicros
    state.maximumObservedDrawdownMicros = baselineRisk.success.maximumObservedDrawdownMicros
    sessionPeakEquityMicros = baselineRisk.success.peakEquityMicros
    sessionMaximumDrawdownMicros = baselineRisk.success.maximumObservedDrawdownMicros
    const baselineRiskLimitBreached =
      baselineRisk.success.dailyLossLimit?.exceeded === true || baselineRisk.success.drawdownLimit?.exceeded === true
    riskLimitBreached ||= baselineRiskLimitBreached
    if (baselineRiskLimitBreached) return incomplete('entry blocked by the active daily-loss or drawdown limit')

    const planningObservedAt = decisionObservedAt
    const planningMs = parseMillis(planningObservedAt)
    const planningQuery = query(
      AlpacaHistoricalKind.Quotes,
      context,
      [symbol],
      asOf(Math.max(parseMillis(context.window.executionOpenAt), planningMs - protocol.maximumQuoteAgeMs)),
      planningObservedAt,
      cacheDirectory,
    )
    const planningAttempt = yield* captureAttemptEffect(client, planningQuery)
    if (planningAttempt._tag === 'Failure') {
      unavailable(observations, 'planning', planningObservedAt, planningAttempt.error)
      return incomplete(`entry planning evidence unavailable: ${planningAttempt.error.message}`)
    }
    const recordedPlanning = recordCapture(captures, planningAttempt.capture)
    if (Result.isFailure(recordedPlanning)) return yield* recordedPlanning.failure
    const planningRows = toQuotes(planningAttempt.capture)
    if (Result.isFailure(planningRows)) return yield* planningRows.failure
    const planningQuotes = validateVendorQuoteWindow({
      protocol,
      session: context.session,
      symbols: [symbol],
      observedAt: planningObservedAt,
      rangeEndAt: asOf(floorToMinute(planningMs)),
      quotes: planningRows.success,
      captureHashes: captureHashesFor([planningAttempt.capture]),
    })
    if (Result.isFailure(planningQuotes)) {
      unavailable(observations, 'planning', planningObservedAt, planningQuotes.failure)
      return incomplete(`entry planning evidence incomplete: ${planningQuotes.failure.message}`)
    }
    const planningHash = quoteObservationHash(
      'planning',
      context,
      planningObservedAt,
      planningQuotes.success,
      planningAttempt.capture,
    )
    if (Result.isFailure(planningHash)) return yield* planningHash.failure
    observations.push({
      kind: 'quote',
      purpose: 'planning',
      observedAt: planningObservedAt,
      provenanceHash: planningHash.success,
    })
    const planningPrices = adverseQuotePrices({ latestQuotes: planningQuotes.success }, [symbol])
    if (Result.isFailure(planningPrices)) return incomplete('entry planning price construction failed')
    const askPriceMicrosText = planningPrices.success.askPriceMicros[symbol]
    if (askPriceMicrosText === undefined) return incomplete('entry planning omitted the selected symbol')
    const askPriceMicros = BigInt(askPriceMicrosText)
    const targetWeight = selectedDecision.targetWeights[symbol]
    if (targetWeight === undefined || targetWeight <= 0)
      return incomplete('selected entry has no positive target weight')
    const allocation = allocationForDecision(
      state.ledger,
      selectedDecision,
      symbol,
      askPriceMicros,
      input.allocationCapitalMicros,
      policy,
    )
    if (Result.isFailure(allocation)) return incomplete('entry allocation could not satisfy the active risk policy')
    const desired = desiredQuantityMicros(allocation.success, targetWeight, askPriceMicros, protocol.executionModel)
    if (Result.isFailure(desired)) return incomplete('entry quantity could not be represented at the active precision')
    const displayed = maximumBuyQuantities({ latestQuotes: planningQuotes.success }, { [symbol]: targetWeight })
    if (Result.isFailure(displayed)) return incomplete('entry displayed ask capacity could not be compiled')
    const requestedQuantity =
      BigInt(displayed.success[symbol] ?? '0') < desired.success
        ? BigInt(displayed.success[symbol] ?? '0')
        : desired.success
    if (requestedQuantity === 0n) {
      const completedState = sessionState(false)
      return {
        session: sessionResult(
          context,
          context.session.date,
          context.session.calendarHash,
          completedState,
          observations,
          orders,
          'COMPLETE',
          'selected entry had no displayed ask capacity',
          sessionPeakEquityMicros,
          sessionMaximumDrawdownMicros,
          riskLimitBreached,
        ),
        state: completedState,
      }
    }
    const requestedNotional = notionalMicros(requestedQuantity, askPriceMicros)
    if (Result.isFailure(requestedNotional)) return incomplete('entry notional could not be calculated')
    if (requestedNotional.success < BigInt(protocol.executionModel.precision.minimumBuyNotionalMicros)) {
      const completedState = sessionState(false)
      return {
        session: sessionResult(
          context,
          context.session.date,
          context.session.calendarHash,
          completedState,
          observations,
          orders,
          'COMPLETE',
          'selected entry was below the minimum buy notional',
          sessionPeakEquityMicros,
          sessionMaximumDrawdownMicros,
          riskLimitBreached,
        ),
        state: completedState,
      }
    }

    const arrivalAt = asOf(planningMs + scenario.assumptions.orderLatencyMs)
    const arrivalQuery = query(
      AlpacaHistoricalKind.Quotes,
      context,
      [symbol],
      asOf(Math.max(parseMillis(context.window.executionOpenAt), parseMillis(arrivalAt) - protocol.maximumQuoteAgeMs)),
      arrivalAt,
      cacheDirectory,
    )
    const arrivalAttempt = yield* captureAttemptEffect(client, arrivalQuery)
    if (arrivalAttempt._tag === 'Failure') {
      unavailable(observations, 'arrival', arrivalAt, arrivalAttempt.error)
      return incomplete(`entry arrival evidence unavailable: ${arrivalAttempt.error.message}`)
    }
    const recordedArrival = recordCapture(captures, arrivalAttempt.capture)
    if (Result.isFailure(recordedArrival)) return yield* recordedArrival.failure
    const arrivalRows = toQuotes(arrivalAttempt.capture)
    if (Result.isFailure(arrivalRows)) return yield* arrivalRows.failure
    const arrivalQuotes = validateVendorQuoteWindow({
      protocol,
      session: context.session,
      symbols: [symbol],
      observedAt: arrivalAt,
      rangeEndAt: asOf(floorToMinute(parseMillis(arrivalAt))),
      quotes: arrivalRows.success,
      captureHashes: captureHashesFor([arrivalAttempt.capture]),
    })
    if (Result.isFailure(arrivalQuotes)) {
      unavailable(observations, 'arrival', arrivalAt, arrivalQuotes.failure)
      return incomplete(`entry arrival evidence incomplete: ${arrivalQuotes.failure.message}`)
    }
    const arrivalHash = quoteObservationHash(
      'arrival',
      context,
      arrivalAt,
      arrivalQuotes.success,
      arrivalAttempt.capture,
    )
    if (Result.isFailure(arrivalHash)) return yield* arrivalHash.failure
    observations.push({ kind: 'quote', purpose: 'arrival', observedAt: arrivalAt, provenanceHash: arrivalHash.success })
    const arrivalQuote = arrivalQuotes.success[symbol]
    if (arrivalQuote === undefined) return incomplete('entry arrival omitted the selected symbol')
    const arrivalPrice = numberToMicros(arrivalQuote.askPrice, `entry arrival ask price for ${symbol}`)
    const arrivalSize = numberToMicros(arrivalQuote.askSize, `entry arrival ask size for ${symbol}`)
    if (Result.isFailure(arrivalPrice) || Result.isFailure(arrivalSize))
      return incomplete('entry arrival quote is outside the exact domain')
    const entryOutcome = simulateIntradayReplayIocCore({
      order: { side: OrderSide.Buy, quantityMicros: requestedQuantity, limitPriceMicros: askPriceMicros },
      quote: { priceMicros: arrivalPrice.success, displayedQuantityMicros: arrivalSize.success },
      executionModel: protocol.executionModel,
      assumptions: scenario.assumptions,
    })
    if (Result.isFailure(entryOutcome)) return incomplete('entry IOC simulation failed')
    orders.push(
      orderFromOutcome(
        symbol,
        OrderSide.Buy,
        planningObservedAt,
        arrivalAt,
        askPriceMicrosText,
        requestedQuantity.toString(),
        planningHash.success,
        arrivalHash.success,
        entryOutcome.success,
      ),
    )
    const entryLedger = applyOutcome(
      state.ledger,
      entryOutcome.success,
      symbol,
      OrderSide.Buy,
      arrivalAt,
      arrivalHash.success,
      protocol.executionModel,
      scenario.assumptions.feeMultiplierPpm,
    )
    if (Result.isFailure(entryLedger)) return incomplete(entryLedger.failure.message)
    state.ledger = entryLedger.success
    if (entryOutcome.success.status === 'canceled' || state.ledger.positions.length === 0) {
      const completedState = sessionState(false)
      return {
        session: sessionResult(
          context,
          context.session.date,
          context.session.calendarHash,
          completedState,
          observations,
          orders,
          'COMPLETE',
          'entry IOC canceled without exposure',
          sessionPeakEquityMicros,
          sessionMaximumDrawdownMicros,
          riskLimitBreached,
        ),
        state: completedState,
      }
    }

    const hardFlatMs = parseMillis(context.window.executionCloseAt) - protocol.hardFlatBeforeCloseMinutes * minuteMs
    const closeStartMs =
      parseMillis(context.window.executionCloseAt) -
      protocol.flattenBeforeCloseMinutes * minuteMs +
      scenario.assumptions.firstPollDelayMs
    if (parseMillis(arrivalAt) >= hardFlatMs) return incomplete('entry arrived at or beyond the hard-flat boundary')

    let nextMarkMs = parseMillis(arrivalAt)
    let nextCloseMs = closeStartMs
    let closeFailure: string | undefined
    while (state.ledger.positions.length > 0 && (nextMarkMs <= hardFlatMs || nextCloseMs < hardFlatMs)) {
      if (nextMarkMs <= nextCloseMs && nextMarkMs <= hardFlatMs) {
        const observedAt = asOf(nextMarkMs)
        const markAttempt = yield* captureAttemptEffect(
          client,
          boundedQuoteQuery(context, [symbol], observedAt, protocol.maximumQuoteAgeMs, cacheDirectory),
        )
        if (markAttempt._tag === 'Failure') {
          unavailable(observations, 'mark', observedAt, markAttempt.error)
          closeFailure = `mark evidence unavailable: ${markAttempt.error.message}`
          break
        }
        const recordedMark = recordCapture(captures, markAttempt.capture)
        if (Result.isFailure(recordedMark)) return yield* recordedMark.failure
        const markRows = toQuotes(markAttempt.capture)
        if (Result.isFailure(markRows)) return yield* markRows.failure
        const quotes = validateVendorQuoteWindow({
          protocol,
          session: context.session,
          symbols: [symbol],
          observedAt,
          rangeEndAt: asOf(floorToMinute(nextMarkMs)),
          quotes: markRows.success,
          captureHashes: captureHashesFor([markAttempt.capture]),
        })
        if (Result.isFailure(quotes)) {
          unavailable(observations, 'mark', observedAt, quotes.failure)
          closeFailure = `mark evidence incomplete: ${quotes.failure.message}`
          break
        }
        const quote = quotes.success[symbol]
        if (quote === undefined) {
          unavailable(observations, 'mark', observedAt, new Error(`mark quote omitted ${symbol}`))
          closeFailure = `mark evidence incomplete: quote omitted ${symbol}`
          break
        }
        const bid = numberToMicros(quote.bidPrice, `mark bid price for ${symbol}`)
        if (Result.isFailure(bid)) {
          unavailable(observations, 'mark', observedAt, bid.failure)
          closeFailure = 'mark price is outside the exact domain'
          break
        }
        const mark = markIntradayReplayEquity({
          ledger: state.ledger,
          bidPriceMicros: { [symbol]: bid.success.toString() },
          dayStartEquityMicros,
          previousPeakEquityMicros: state.peakEquityMicros,
          previousMaximumObservedDrawdownMicros: state.maximumObservedDrawdownMicros,
          limits: policy,
        })
        if (Result.isFailure(mark)) {
          unavailable(observations, 'mark', observedAt, mark.failure)
          closeFailure = 'mark-to-market accounting failed'
          break
        }
        state.peakEquityMicros = mark.success.peakEquityMicros
        state.maximumObservedDrawdownMicros = mark.success.maximumObservedDrawdownMicros
        sessionPeakEquityMicros = mark.success.peakEquityMicros
        sessionMaximumDrawdownMicros = mark.success.maximumObservedDrawdownMicros
        riskLimitBreached ||=
          mark.success.dailyLossLimit?.exceeded === true || mark.success.drawdownLimit?.exceeded === true
        const provenance = quoteObservationHash('mark', context, observedAt, quotes.success, markAttempt.capture)
        if (Result.isFailure(provenance)) return yield* provenance.failure
        observations.push({
          kind: 'quote',
          purpose: 'mark',
          observedAt,
          provenanceHash: provenance.success,
          equity: mark.success,
        })
        nextMarkMs += scenario.assumptions.pollIntervalMs
        continue
      }
      if (nextCloseMs >= hardFlatMs) break
      const observedAt = asOf(nextCloseMs)
      const positions = state.ledger.positions
      const heldSymbols = positions.map(({ symbol: heldSymbol }) => heldSymbol).sort()
      const planningAttempt = yield* captureAttemptEffect(
        client,
        boundedQuoteQuery(context, heldSymbols, observedAt, protocol.maximumQuoteAgeMs, cacheDirectory),
      )
      if (planningAttempt._tag === 'Failure') {
        unavailable(observations, 'close', observedAt, planningAttempt.error)
        if (!planningAttempt.error.retryable) {
          closeFailure = `closing planning evidence unavailable: ${planningAttempt.error.message}`
          break
        }
        nextCloseMs += scenario.assumptions.pollIntervalMs
        continue
      }
      const recordedPlanning = recordCapture(captures, planningAttempt.capture)
      if (Result.isFailure(recordedPlanning)) return yield* recordedPlanning.failure
      const planningRows = toQuotes(planningAttempt.capture)
      if (Result.isFailure(planningRows)) return yield* planningRows.failure
      const planningQuotes = validateVendorQuoteWindow({
        protocol,
        session: context.session,
        symbols: heldSymbols,
        observedAt,
        rangeEndAt: asOf(floorToMinute(nextCloseMs)),
        quotes: planningRows.success,
        captureHashes: captureHashesFor([planningAttempt.capture]),
      })
      if (Result.isFailure(planningQuotes)) {
        unavailable(observations, 'close', observedAt, planningQuotes.failure)
        if (!isRetryableWindowReason(planningQuotes.failure.reason)) {
          closeFailure = `closing planning evidence incomplete: ${planningQuotes.failure.message}`
          break
        }
        nextCloseMs += scenario.assumptions.pollIntervalMs
        continue
      }
      const closeProvenance = quoteObservationHash(
        'close',
        context,
        observedAt,
        planningQuotes.success,
        planningAttempt.capture,
      )
      if (Result.isFailure(closeProvenance)) return yield* closeProvenance.failure
      observations.push({ kind: 'quote', purpose: 'close', observedAt, provenanceHash: closeProvenance.success })
      const closePrices = adverseQuotePrices({ latestQuotes: planningQuotes.success }, heldSymbols)
      if (Result.isFailure(closePrices)) {
        unavailable(observations, 'close', observedAt, closePrices.failure)
        nextCloseMs += scenario.assumptions.pollIntervalMs
        continue
      }
      const insufficient = positions.find((position) => {
        const capacity = displayedSellCapacity(planningQuotes.success, position.symbol)
        return Result.isFailure(capacity) || capacity.success < BigInt(position.quantityMicros)
      })
      if (insufficient !== undefined) {
        unavailable(
          observations,
          'close',
          observedAt,
          new Error(`close displayed bid capacity is below the full ${insufficient.symbol} position`),
        )
        nextCloseMs += scenario.assumptions.pollIntervalMs
        continue
      }
      const arrivalMs = nextCloseMs + scenario.assumptions.orderLatencyMs
      if (arrivalMs >= hardFlatMs) {
        unavailable(
          observations,
          'arrival',
          asOf(arrivalMs),
          new Error('closing IOC arrival would be at or beyond the hard-flat boundary'),
        )
        closeFailure = 'closing IOC arrival exceeded the hard-flat boundary'
        break
      }
      const arrivalAtClose = asOf(arrivalMs)
      const arrivalAttempt = yield* captureAttemptEffect(
        client,
        boundedQuoteQuery(context, heldSymbols, arrivalAtClose, protocol.maximumQuoteAgeMs, cacheDirectory),
      )
      if (arrivalAttempt._tag === 'Failure') {
        unavailable(observations, 'arrival', arrivalAtClose, arrivalAttempt.error)
        if (!arrivalAttempt.error.retryable) {
          closeFailure = `closing arrival evidence unavailable: ${arrivalAttempt.error.message}`
          break
        }
        nextCloseMs += scenario.assumptions.pollIntervalMs
        continue
      }
      const recordedArrival = recordCapture(captures, arrivalAttempt.capture)
      if (Result.isFailure(recordedArrival)) return yield* recordedArrival.failure
      const arrivalRows = toQuotes(arrivalAttempt.capture)
      if (Result.isFailure(arrivalRows)) return yield* arrivalRows.failure
      const arrivalQuotes = validateVendorQuoteWindow({
        protocol,
        session: context.session,
        symbols: heldSymbols,
        observedAt: arrivalAtClose,
        rangeEndAt: asOf(floorToMinute(arrivalMs)),
        quotes: arrivalRows.success,
        captureHashes: captureHashesFor([arrivalAttempt.capture]),
      })
      if (Result.isFailure(arrivalQuotes)) {
        unavailable(observations, 'arrival', arrivalAtClose, arrivalQuotes.failure)
        if (!isRetryableWindowReason(arrivalQuotes.failure.reason)) {
          closeFailure = `closing arrival evidence incomplete: ${arrivalQuotes.failure.message}`
          break
        }
        nextCloseMs += scenario.assumptions.pollIntervalMs
        continue
      }
      const arrivalCloseProvenance = quoteObservationHash(
        'arrival',
        context,
        arrivalAtClose,
        arrivalQuotes.success,
        arrivalAttempt.capture,
      )
      if (Result.isFailure(arrivalCloseProvenance)) return yield* arrivalCloseProvenance.failure
      observations.push({
        kind: 'quote',
        purpose: 'arrival',
        observedAt: arrivalAtClose,
        provenanceHash: arrivalCloseProvenance.success,
      })
      for (const position of positions) {
        const limitPriceMicros = closePrices.success.bidPriceMicros[position.symbol]
        const arrivalQuote = arrivalQuotes.success[position.symbol]
        if (limitPriceMicros === undefined || arrivalQuote === undefined) {
          closeFailure = `closing quote omitted ${position.symbol}`
          break
        }
        const price = numberToMicros(arrivalQuote.bidPrice, `close bid price for ${position.symbol}`)
        const displayed = numberToMicros(arrivalQuote.bidSize, `close bid size for ${position.symbol}`)
        if (Result.isFailure(price) || Result.isFailure(displayed)) {
          closeFailure = 'closing quote is outside the exact domain'
          break
        }
        const outcome = simulateIntradayReplayIocCore({
          order: {
            side: OrderSide.Sell,
            quantityMicros: BigInt(position.quantityMicros),
            limitPriceMicros: BigInt(limitPriceMicros),
          },
          quote: { priceMicros: price.success, displayedQuantityMicros: displayed.success },
          executionModel: protocol.executionModel,
          assumptions: scenario.assumptions,
        })
        if (Result.isFailure(outcome)) {
          closeFailure = 'closing IOC simulation failed'
          break
        }
        orders.push(
          orderFromOutcome(
            position.symbol,
            OrderSide.Sell,
            observedAt,
            arrivalAtClose,
            limitPriceMicros,
            position.quantityMicros,
            closeProvenance.success,
            arrivalCloseProvenance.success,
            outcome.success,
          ),
        )
        const nextLedger = applyOutcome(
          state.ledger,
          outcome.success,
          position.symbol,
          OrderSide.Sell,
          arrivalAtClose,
          arrivalCloseProvenance.success,
          protocol.executionModel,
          scenario.assumptions.feeMultiplierPpm,
        )
        if (Result.isFailure(nextLedger)) {
          closeFailure = nextLedger.failure.message
          break
        }
        state.ledger = nextLedger.success
      }
      if (closeFailure !== undefined) break
      nextCloseMs += scenario.assumptions.pollIntervalMs
    }

    if (state.ledger.positions.length === 0 && closeFailure === undefined) {
      const flatMark = riskMark(state, dayStartEquityMicros, policy)
      if (Result.isFailure(flatMark)) return incomplete(flatMark.failure.message)
      state.peakEquityMicros = flatMark.success.peakEquityMicros
      state.maximumObservedDrawdownMicros = flatMark.success.maximumObservedDrawdownMicros
      sessionPeakEquityMicros = flatMark.success.peakEquityMicros
      sessionMaximumDrawdownMicros = flatMark.success.maximumObservedDrawdownMicros
      riskLimitBreached ||=
        flatMark.success.dailyLossLimit?.exceeded === true || flatMark.success.drawdownLimit?.exceeded === true
      const completedState = sessionState(false)
      return {
        session: sessionResult(
          context,
          context.session.date,
          context.session.calendarHash,
          completedState,
          observations,
          orders,
          'COMPLETE',
          'entry executed and position flattened',
          sessionPeakEquityMicros,
          sessionMaximumDrawdownMicros,
          riskLimitBreached,
        ),
        state: completedState,
      }
    }
    return incomplete(closeFailure ?? 'positions remained open at the hard-flat boundary')
  })

const reportWithHash = (
  material: Omit<VendorReplayReport, 'reportHash'>,
): Result.Result<VendorReplayReport, VendorReplayFailure> =>
  Result.mapError(canonicalHashV1Result(material), (cause) =>
    replayFailure('report', 'vendor replay report is not canonically hashable', cause),
  ).pipe(Result.map((reportHash) => ({ ...material, reportHash })))

export const runVendorIntradayReplay = (
  input: VendorReplayInput,
  client: AlpacaHistoricalClient,
  cacheDirectory: string,
  now: string,
): Effect.Effect<VendorReplayReport, VendorReplayFailure, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const decodedInput = yield* Effect.fromResult(decodeVendorReplayInput(input)).pipe(
      Effect.mapError((cause) => replayFailure('input', 'invalid vendor replay input', cause)),
    )
    const evaluatedAt = yield* Effect.fromResult(
      Schema.decodeUnknownResult(UtcInstantSchema, strictParseOptions)(now),
    ).pipe(
      Effect.mapError((cause) => replayFailure('input', 'vendor replay now must be a canonical UTC instant', cause)),
    )
    if (cacheDirectory.trim().length === 0)
      return yield* replayFailure('input', 'vendor replay cache directory must be non-empty')
    const normalizedCalendar = yield* Effect.fromResult(
      normalizeMarketCalendarResult(decodedInput.calendar, decodedInput.range),
    ).pipe(Effect.mapError((cause) => replayFailure('calendar', 'vendor replay calendar normalization failed', cause)))
    if (normalizedCalendar.sessions.length === 0)
      return yield* replayFailure('calendar', 'vendor replay calendar contains no sessions')
    if (normalizedCalendar.sessions.some((session) => parseMillis(session.closeAt) >= parseMillis(now))) {
      return yield* replayFailure(
        'calendar',
        'vendor replay requires every calendar session to be finalized before now',
      )
    }

    const protocol = yield* Effect.fromResult(decodeDefaultIntradayMomentumProtocol()).pipe(
      Effect.mapError((cause) => replayFailure('strategy', 'active intraday-momentum protocol is invalid', cause)),
    )
    if (protocol.executionModel.schemaVersion !== 'bayn.execution-model.v5')
      return yield* replayFailure('strategy', 'vendor replay requires execution model v5')
    const definition = makeIntradayMomentumDefinition(protocol)
    if (definition.name !== activeStrategyName || definition.holdingPeriod !== 'INTRADAY') {
      return yield* replayFailure('strategy', 'vendor replay requires the active intraday-momentum definition')
    }
    const parameterHash = yield* Effect.fromResult(hashIntradayMomentumProtocol(protocol)).pipe(
      Effect.mapError((cause) =>
        replayFailure('strategy', 'intraday-momentum parameter hash construction failed', cause),
      ),
    )
    const strategyProtocolHash = yield* Effect.fromResult(
      makeStrategyProtocolHashResult({
        name: activeStrategyName,
        behaviorHash: activeStrategyBehaviorHash,
        parameterHash,
        parameterSchemaVersion: protocol.schemaVersion,
      }),
    ).pipe(Effect.mapError((cause) => replayFailure('strategy', 'strategy protocol hash construction failed', cause)))
    const executionPolicy = yield* Effect.fromResult(makeCycleExecutionPolicyFromModel(protocol.executionModel)).pipe(
      Effect.mapError((cause) => replayFailure('strategy', 'execution policy construction failed', cause)),
    )
    if (executionPolicy.schemaVersion !== replayPolicySchemaVersion)
      return yield* replayFailure('strategy', 'vendor replay requires the session-relative v3 execution policy')
    const riskPolicy = yield* loadQuoteBoundExecutionRiskPolicy('build-contract', protocol.universe).pipe(
      Effect.mapError((cause) => replayFailure('strategy', 'execution risk policy construction failed', cause)),
    )
    const riskPolicyHash = yield* Effect.fromResult(canonicalHashV1Result(riskPolicy)).pipe(
      Effect.mapError((cause) => replayFailure('strategy', 'execution risk policy hash construction failed', cause)),
    )
    if (decodedInput.strategyProtocolHash !== strategyProtocolHash)
      return yield* replayFailure('strategy', 'input strategy protocol hash does not match the active strategy')
    if (decodedInput.behaviorHash !== activeStrategyBehaviorHash)
      return yield* replayFailure('strategy', 'input behavior hash does not match the active strategy')
    if (decodedInput.parameterHash !== parameterHash)
      return yield* replayFailure('strategy', 'input parameter hash does not match the active protocol')
    if (decodedInput.riskPolicyHash !== riskPolicyHash)
      return yield* replayFailure('strategy', 'input risk policy hash does not match the active policy')

    const embeddedProvenancePresent = embeddedBuildMetadata !== undefined || embeddedRuntimeIdentity !== undefined
    const validatedBuildMetadata = embeddedProvenancePresent
      ? yield* Schema.decodeUnknownEffect(
          EmbeddedBuildMetadataSchema,
          strictParseOptions,
        )(embeddedBuildMetadata).pipe(
          Effect.mapError((cause) =>
            replayFailure('strategy', 'embedded build metadata is incomplete or invalid', cause),
          ),
        )
      : undefined
    const validatedRuntimeIdentity = embeddedProvenancePresent
      ? yield* Schema.decodeUnknownEffect(
          EmbeddedRuntimeIdentitySchema,
          strictParseOptions,
        )(embeddedRuntimeIdentity).pipe(
          Effect.mapError((cause) =>
            replayFailure('strategy', 'embedded runtime identity is incomplete or invalid', cause),
          ),
        )
      : undefined
    if (validatedBuildMetadata !== undefined) {
      yield* Effect.all([
        verifyBehaviorHash(validatedBuildMetadata, activeStrategyBehaviorHash),
        verifyParameterHash(validatedBuildMetadata, parameterHash),
      ]).pipe(
        Effect.mapError((cause) =>
          replayFailure('strategy', 'embedded build metadata does not match the active strategy', cause),
        ),
      )
    }
    if (validatedRuntimeIdentity !== undefined) {
      yield* Effect.all([
        verifyStrategyName(validatedRuntimeIdentity, activeStrategyName),
        verifyStrategyProtocolHash(validatedRuntimeIdentity, strategyProtocolHash),
        verifyExecutionRiskPolicyHash(validatedRuntimeIdentity, riskPolicyHash),
      ]).pipe(
        Effect.mapError((cause) =>
          replayFailure('strategy', 'embedded runtime identity does not match the active strategy', cause),
        ),
      )
    }
    for (const scenario of decodedInput.scenarios) {
      if (scenario.assumptions.slippageBps > riskPolicy.maxAdverseSlippageBps) {
        return yield* replayFailure('strategy', `scenario ${scenario.name} exceeds the active adverse-slippage policy`)
      }
    }
    const inputHash = yield* Effect.fromResult(canonicalHashV1Result(decodedInput)).pipe(
      Effect.mapError((cause) => replayFailure('report', 'vendor replay input hash construction failed', cause)),
    )

    const captures = new Map<
      string,
      { readonly provenanceHash: string; readonly provenance: VendorHistoricalCapture['provenance'] }
    >()
    const scenarios: VendorReplayScenario[] = []
    for (const scenarioInput of decodedInput.scenarios) {
      const ledger = yield* Effect.fromResult(
        createReplayLedger<VendorReplayFill>(decodedInput.initialCapitalMicros),
      ).pipe(
        Effect.mapError((cause) => replayFailure('accounting', 'vendor replay ledger initialization failed', cause)),
      )
      const state: ScenarioState = {
        ledger,
        peakEquityMicros: decodedInput.initialCapitalMicros,
        maximumObservedDrawdownMicros: '0',
        riskLimitBreached: false,
        stopped: false,
      }
      const sessions: VendorReplaySession[] = []
      for (const calendarSession of normalizedCalendar.sessions) {
        if (!state.stopped && state.ledger.positions.length === 0) {
          const sessionLedger = yield* Effect.fromResult(
            createReplayLedger<VendorReplayFill>(state.ledger.cashMicros),
          ).pipe(
            Effect.mapError((cause) =>
              replayFailure('accounting', 'vendor replay session ledger initialization failed', cause),
            ),
          )
          state.ledger = sessionLedger
        }
        yield* Effect.logInfo('vendor intraday replay session started').pipe(
          Effect.annotateLogs({ scenario: scenarioInput.name, date: calendarSession.date }),
        )
        const contextResult = makeContext(calendarSession, executionPolicy)
        const calendarHash = Result.isSuccess(contextResult)
          ? contextResult.success.session.calendarHash
          : normalizedCalendar.normalizedResponseHash
        let sessionRun: SessionRun
        if (state.stopped) {
          sessionRun = skipSession(undefined, calendarSession.date, calendarHash, state)
        } else if (Result.isFailure(contextResult)) {
          const failedState = { ...state, stopped: true }
          sessionRun = {
            session: sessionResult(
              undefined,
              calendarSession.date,
              calendarHash,
              failedState,
              [],
              [],
              'INCOMPLETE',
              `session context incomplete: ${contextResult.failure.message}`,
              null,
              null,
              false,
            ),
            state: failedState,
          }
        } else {
          sessionRun = yield* replaySession(
            decodedInput,
            scenarioInput,
            contextResult.success,
            state,
            client,
            cacheDirectory,
            protocol,
            riskPolicy,
            captures,
          )
        }
        sessions.push(sessionRun.session)
        state.ledger = sessionRun.state.ledger
        state.peakEquityMicros = sessionRun.state.peakEquityMicros
        state.maximumObservedDrawdownMicros = sessionRun.state.maximumObservedDrawdownMicros
        state.riskLimitBreached = sessionRun.state.riskLimitBreached
        state.stopped = sessionRun.state.stopped
        yield* Effect.logInfo('vendor intraday replay session completed').pipe(
          Effect.annotateLogs({
            scenario: scenarioInput.name,
            date: calendarSession.date,
            status: sessionRun.session.status,
            fillCount: sessionRun.state.ledger.fills.length,
          }),
        )
      }
      const completedSessionCount = sessions.filter(({ status }) => status === 'COMPLETE').length
      const incompleteSessionCount = sessions.length - completedSessionCount
      const executionSessionCount = sessions.filter(({ orders }) =>
        orders.some(({ filledQuantityMicros }) => filledQuantityMicros !== '0'),
      ).length
      const finalLedger = state.ledger
      scenarios.push({
        name: scenarioInput.name,
        sessions,
        totals: {
          completedSessionCount,
          incompleteSessionCount,
          executionSessionCount,
          netRealizedPnlAfterCostsMicros:
            incompleteSessionCount === 0 && finalLedger.positions.length === 0
              ? (BigInt(finalLedger.cashMicros) - BigInt(decodedInput.initialCapitalMicros)).toString()
              : null,
          maximumObservedDrawdownMicros: sessions.some(
            ({ maximumObservedDrawdownMicros }) => maximumObservedDrawdownMicros !== null,
          )
            ? state.maximumObservedDrawdownMicros
            : null,
          riskLimitBreached: state.riskLimitBreached,
        },
      })
    }
    const captureList = Object.freeze(
      [...captures.entries()]
        .toSorted(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
        .map(([, value]) => ({ provenanceHash: value.provenanceHash, provenance: value.provenance })),
    )
    const material: Omit<VendorReplayReport, 'reportHash'> = {
      schemaVersion: 'bayn.vendor-intraday-replay-report.v1',
      evidenceKind: 'COUNTERFACTUAL_RESEARCH',
      qualification: 'NOT_QUALIFIED',
      availability: 'event-time-only',
      quoteSizePolicy: 'native-unit-share-cap.v1',
      evaluatedAt,
      input: decodedInput,
      inputHash,
      calendarHash: normalizedCalendar.normalizedResponseHash,
      build: validatedBuildMetadata ?? null,
      captures: captureList,
      scenarios,
      limitations: [
        'event-time-only Alpaca historical bars, quotes, and trades; provider captures are complete only within each bounded query',
        'counterfactual continuous cash ledger; broker, authority, PostgreSQL, TigerBeetle, queue position, and live fills are not modeled',
        'IOC fills use declared adverse slippage, displayed liquidity, and latency assumptions; no automatic mid-position liquidation is claimed',
        'daily-loss and drawdown values are diagnostics from adverse bid marks and do not grant execution authority',
        'drawdown is measured at 30-second adverse-bid marks; excursions between sampled events or unobserved venues can be missed',
        'historical trade confirmation uses the bounded raw trade capture; it is not a latest-trades endpoint projection',
        'IEX is the single historical exchange feed used for this liquidity counterfactual',
        'displayed quote sizes retain provider-native units; capacity uses one modeled share per native size unit, matching the active strategy; this is a conservative capacity assumption, not a verified round-lot conversion',
        'positive replay output remains research evidence and cannot qualify or activate the strategy',
      ],
    }
    return yield* Effect.fromResult(reportWithHash(material))
  })
