import { Effect, Result, Schema } from 'effect'

import { normalizeMarketCalendarResult } from '../broker/alpaca/normalizers'
import {
  makeCycleExecutionPolicyFromModel,
  makeExecutionCalendarObservation,
  makeIntradayCycleWindow,
  type CycleExecutionPolicy,
  type CycleWindow,
  type ExecutionCalendarObservation,
} from '../cycle'
import { makeStrategyProtocolHashResult } from '../contracts'
import { OrderSide } from '../execution/contracts'
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
} from '../build'
import { OperationalError, operationalError } from '../errors'
import { canonicalHashV1Result } from '../hash'
import {
  IntradaySnapshotFailure,
  IntradaySnapshotPurpose,
  type IntradayMarketDataService,
  type IntradaySnapshotQuery,
} from '../market-data'
import type { ArchiveVerifiedIntradayMarketSnapshot } from '../market-data/intraday/model'
import { isIntradaySnapshotPending } from '../market-data/intraday/pending'
import {
  adverseClosingQuotePrices,
  adverseQuotePrices,
  loadIntradaySnapshot,
  maximumBuyQuantities,
} from '../observe-composition/intraday-market-data'
import {
  IntradayMomentumCloseAwaitingSnapshot,
  IntradayMomentumEntryAwaitingSnapshot,
  intradayMomentumCloseQuery,
  intradayMomentumEntryQuery,
  intradayMomentumPricingQuery,
  maximumSellQuantities,
} from '../observe-composition/intraday-momentum-decision'
import type { IntradayMomentumQueryContext } from '../observe-composition/intraday-momentum-decision'
import { strictParseOptions, UtcInstantSchema } from '../schemas'
import type { MarketCalendarObservation } from '../broker/alpaca/model'
import type { Policy } from '../risk'
import { loadQuoteBoundExecutionRiskPolicy } from '../observe-composition/decision-builder'
import {
  activeStrategyBehaviorHash,
  activeStrategyName,
  IntradayMomentumFailure,
  makeIntradayMomentumDefinition,
} from '../strategy'
import { desiredQuantityMicros, notionalMicros } from '../execution-model'
import {
  decodeDefaultIntradayMomentumProtocol,
  hashIntradayMomentumProtocol,
  type IntradayMomentumProtocol,
} from '../strategy/intraday-momentum/protocol'
import type { IntradayMomentumTargetPortfolio } from '../strategy/intraday-momentum/model'
import { utcInstantFromEpochMillis } from '../time'
import {
  IntradayReplayFailure,
  type IntradayReplayInput,
  type IntradayReplayObservation,
  type IntradayReplayReport,
  type IntradayReplaySession,
  type IntradayReplayPosition,
  decodeIntradayReplayInput,
} from './model'
import { allocationForDecision } from './allocation'
import { applyReplayIoc, createReplayLedger, type IntradayReplayLedger } from './ledger'
import { simulateIntradayReplayIoc, type IntradayReplayIocFailure, type IntradayReplayIocOutcome } from './execution'
import { markIntradayReplayEquity, type IntradayReplayEquityFailure, type IntradayReplayEquityMark } from './equity'
import { decideIntradayMomentumCore } from '../strategy/intraday-momentum/decision-core'
import type { IntradayCandidateExclusion } from '../market-data/intraday/model'
import {
  ArchiveAvailabilityPolicy,
  type ArchiveAvailabilityReceipt,
  type ArchiveSnapshotAvailability,
  type ReplayMarketDataService,
} from '../market-data/intraday/availability'

const rollingBaselineMessage = 'intraday symbol lacks the complete rolling lookback baseline'
const replayCycleSchemaVersion = 'bayn.autonomous-cycle.v3' as const
const replayPolicySchemaVersion = 'bayn.autonomous-cycle-execution-policy.v3' as const
const minuteMs = 60_000

interface ReplayEquityState {
  peakEquityMicros: string
  maximumObservedDrawdownMicros: string
  riskLimitBreached: boolean
}

interface SessionEquityDiagnostics {
  readonly peakEquityMicros: string | null
  readonly maximumObservedDrawdownMicros: string | null
  readonly riskLimitBreached: boolean
}

interface ReplaySessionContext {
  readonly marketCalendar: MarketCalendarObservation
  readonly calendar: ExecutionCalendarObservation
  readonly window: CycleWindow
  readonly queryContext: IntradayMomentumQueryContext
}

interface FailureDescription {
  readonly reason: string
  readonly message: string
}

type SnapshotRead =
  | { readonly _tag: 'Success'; readonly snapshot: ArchiveVerifiedIntradayMarketSnapshot }
  | { readonly _tag: 'Failure'; readonly error: OperationalError }

const failureDescription = (value: unknown): FailureDescription => {
  if (value instanceof OperationalError && value.cause instanceof IntradaySnapshotFailure) {
    return { reason: value.cause.reason, message: value.cause.message }
  }
  if (value instanceof IntradaySnapshotFailure || value instanceof IntradayMomentumFailure) {
    return { reason: value.reason, message: value.message }
  }
  if (value instanceof OperationalError || value instanceof IntradayReplayFailure) {
    return { reason: value.operation, message: value.message }
  }
  if (value instanceof Error) return { reason: value.name, message: value.message }
  return { reason: 'failure', message: 'replay operation failed' }
}

const isRetryableArchiveFailure = (error: OperationalError): boolean =>
  error.retryable || isIntradaySnapshotPending(error.cause)

const iocFailure = (cause: IntradayReplayIocFailure): IntradayReplayFailure =>
  new IntradayReplayFailure({
    operation: 'execution',
    message: `${cause.field}: ${cause.reason}`,
    cause,
  })

const isValidUtcInstant = (value: string): boolean =>
  Schema.is(UtcInstantSchema)(value) && Number.isFinite(Date.parse(value))

const minBigInt = (left: bigint, right: bigint): bigint => (left < right ? left : right)

const noEquityDiagnostics: SessionEquityDiagnostics = {
  peakEquityMicros: null,
  maximumObservedDrawdownMicros: null,
  riskLimitBreached: false,
}

const pushUnavailable = (
  observations: IntradayReplayObservation[],
  purpose: IntradayReplayObservation['purpose'],
  observedAt: string,
  error: unknown,
  retryable: boolean,
): void => {
  const description = failureDescription(error)
  observations.push({
    kind: 'unavailable',
    observedAt,
    purpose,
    reason: description.reason,
    message: description.message,
    retryable,
  })
}

const readSnapshot = (
  marketData: IntradayMarketDataService,
  query: IntradaySnapshotQuery,
): Effect.Effect<SnapshotRead> =>
  loadIntradaySnapshot(marketData, query).pipe(
    Effect.map((snapshot) => ({ _tag: 'Success' as const, snapshot })),
    Effect.catch((error) => Effect.succeed({ _tag: 'Failure' as const, error })),
  )

const replayContext = (
  session: { readonly date: string; readonly openAt: string; readonly closeAt: string },
  marketCalendar: MarketCalendarObservation,
  executionPolicy: CycleExecutionPolicy,
): Result.Result<ReplaySessionContext, IntradayReplayFailure> =>
  Result.flatMap(
    makeExecutionCalendarObservation({
      schemaVersion: 'bayn.alpaca-market-calendar-observation.v1',
      source: 'alpaca-v2-calendar',
      date: session.date,
      openAt: session.openAt,
      closeAt: session.closeAt,
    }),
    (calendar) =>
      Result.mapError(
        makeIntradayCycleWindow(calendar, executionPolicy),
        (cause) =>
          new IntradayReplayFailure({
            operation: 'calendar',
            message: 'intraday replay cycle window construction failed',
            cause,
          }),
      ).pipe(
        Result.map((window) => ({
          marketCalendar,
          calendar,
          window,
          queryContext: {
            schemaVersion: replayCycleSchemaVersion,
            identity: {
              strategyName: activeStrategyName,
              executionSessionDate: calendar.executionSessionDate,
              executionPolicy,
            },
            window: {
              executionOpenAt: window.executionOpenAt,
              executionCloseAt: window.executionCloseAt,
              submissionOpenAt: window.submissionOpenAt,
              submissionCutoffAt: window.submissionCutoffAt,
            },
          },
        })),
      ),
  ).pipe(
    Result.mapError(
      (cause) =>
        new IntradayReplayFailure({
          operation: 'calendar',
          message: 'intraday replay calendar session construction failed',
          cause,
        }),
    ),
  )

const evaluateDecision = (
  protocol: IntradayMomentumProtocol,
  snapshot: ArchiveVerifiedIntradayMarketSnapshot,
  context: ReplaySessionContext,
  availabilityExclusions: readonly IntradayCandidateExclusion[],
): Result.Result<IntradayMomentumTargetPortfolio, IntradayMomentumFailure> =>
  makeIntradayMomentumDefinition(protocol)
    .decide({
      market: {
        snapshot,
        session: {
          sessionDate: context.calendar.executionSessionDate,
          openAt: context.calendar.executionOpenAt,
          closeAt: context.calendar.executionCloseAt,
          calendarHash: context.calendar.executionCalendarHash,
        },
      },
    })
    .pipe(
      Result.flatMap((decision) => {
        if (availabilityExclusions.length === 0) return Result.succeed(decision)
        // Keep canonical archive validation and identity intact. Only research inputs to the shared pure core gain
        // receipt-derived exclusions; never rewrite the archive manifest or alter the production strategy contract.
        const exclusions = new Map(
          (snapshot.manifest.candidateExclusions ?? []).map((exclusion) => [exclusion.symbol, exclusion]),
        )
        for (const exclusion of availabilityExclusions) exclusions.set(exclusion.symbol, exclusion)
        return decideIntradayMomentumCore({
          protocol,
          bars: snapshot.bars,
          latestQuotes: snapshot.latestQuotes,
          latestTrades: Object.fromEntries(snapshot.trades.map((trade) => [trade.symbol, trade])),
          observedAt: snapshot.manifest.observedAt,
          rangeStartAt: snapshot.manifest.rangeStartAt,
          candidateExclusions: [...exclusions.values()].toSorted((left, right) =>
            left.symbol < right.symbol ? -1 : left.symbol > right.symbol ? 1 : 0,
          ),
        }).pipe(Result.map((core) => Object.freeze({ ...decision, ...core })))
      }),
    )

const emptySession = (
  date: string,
  calendarHash: string,
  openingCashMicros: string,
  reason: string,
  positions: readonly IntradayReplayPosition[] = [],
  equity: SessionEquityDiagnostics = noEquityDiagnostics,
): IntradayReplaySession => ({
  date,
  calendarHash,
  status: 'INCOMPLETE',
  reason,
  observations: [],
  orders: [],
  fills: [],
  positions,
  openingCashMicros,
  cashMicros: openingCashMicros,
  executionFeesMicros: '0',
  netRealizedPnlAfterCostsMicros: null,
  maximumObservedDrawdownMicros: equity.maximumObservedDrawdownMicros,
  peakEquityMicros: equity.peakEquityMicros,
  riskLimitBreached: equity.riskLimitBreached,
})

const applyOutcome = (
  ledger: IntradayReplayLedger,
  outcome: IntradayReplayIocOutcome,
  protocol: IntradayMomentumProtocol,
  feeMultiplierPpm: number,
): Result.Result<IntradayReplayLedger, IntradayReplayFailure> =>
  Result.mapError(
    applyReplayIoc(ledger, outcome, protocol.executionModel, feeMultiplierPpm),
    (cause) =>
      new IntradayReplayFailure({ operation: 'accounting', message: 'replay ledger rejected IOC outcome', cause }),
  )

const incompleteSession = (
  context: ReplaySessionContext,
  ledger: IntradayReplayLedger,
  observations: readonly IntradayReplayObservation[],
  orders: readonly IntradayReplayIocOutcome[],
  reason: string,
  equity: SessionEquityDiagnostics = noEquityDiagnostics,
): IntradayReplaySession => ({
  date: context.calendar.executionSessionDate,
  calendarHash: context.calendar.executionCalendarHash,
  status: 'INCOMPLETE',
  reason,
  observations,
  orders,
  fills: ledger.fills,
  positions: ledger.positions,
  openingCashMicros: ledger.openingCashMicros,
  cashMicros: ledger.cashMicros,
  executionFeesMicros: ledger.executionFeesMicros,
  netRealizedPnlAfterCostsMicros: null,
  maximumObservedDrawdownMicros: equity.maximumObservedDrawdownMicros,
  peakEquityMicros: equity.peakEquityMicros,
  riskLimitBreached: equity.riskLimitBreached,
})

const completeSession = (
  context: ReplaySessionContext,
  ledger: IntradayReplayLedger,
  observations: readonly IntradayReplayObservation[],
  orders: readonly IntradayReplayIocOutcome[],
  reason: string,
  equity: SessionEquityDiagnostics = noEquityDiagnostics,
): IntradayReplaySession => ({
  date: context.calendar.executionSessionDate,
  calendarHash: context.calendar.executionCalendarHash,
  status: 'COMPLETE',
  reason,
  observations,
  orders,
  fills: ledger.fills,
  positions: ledger.positions,
  openingCashMicros: ledger.openingCashMicros,
  cashMicros: ledger.cashMicros,
  executionFeesMicros: ledger.executionFeesMicros,
  netRealizedPnlAfterCostsMicros: ledger.netRealizedPnlAfterCostsMicros,
  maximumObservedDrawdownMicros: equity.maximumObservedDrawdownMicros,
  peakEquityMicros: equity.peakEquityMicros,
  riskLimitBreached: equity.riskLimitBreached,
})

const replaySession = (
  input: IntradayReplayInput,
  marketData: IntradayMarketDataService,
  protocol: IntradayMomentumProtocol,
  policy: Policy,
  context: ReplaySessionContext,
  openingCashMicros: string,
  equityState: ReplayEquityState,
  availabilitySnapshots: ReadonlyMap<string, ArchiveSnapshotAvailability>,
): Effect.Effect<IntradayReplaySession, IntradayReplayFailure> =>
  Effect.gen(function* () {
    const ledgerResult = createReplayLedger(openingCashMicros)
    if (Result.isFailure(ledgerResult)) {
      return yield* new IntradayReplayFailure({
        operation: 'accounting',
        message: 'replay ledger could not be initialized',
        cause: ledgerResult.failure,
      })
    }
    let ledger = ledgerResult.success
    const observations: IntradayReplayObservation[] = []
    const orders: IntradayReplayIocOutcome[] = []
    let selectedDecision: IntradayMomentumTargetPortfolio | undefined
    let selectedDecisionSnapshot: ArchiveVerifiedIntradayMarketSnapshot | undefined
    let structuralFailure: string | undefined
    let retryableEntryFailure = false
    const dayStartEquityMicros = openingCashMicros
    let sessionPeakEquityMicros: string | null = null
    let sessionMaximumDrawdownMicros: string | null = null
    let sessionRiskLimitBreached = false
    let markEvidenceFailure: string | undefined

    const equityDiagnostics = (): SessionEquityDiagnostics => ({
      peakEquityMicros: sessionPeakEquityMicros,
      maximumObservedDrawdownMicros: sessionMaximumDrawdownMicros,
      riskLimitBreached: sessionRiskLimitBreached,
    })

    const recordEquityMark = (mark: IntradayReplayEquityMark): void => {
      equityState.peakEquityMicros = mark.peakEquityMicros
      equityState.maximumObservedDrawdownMicros = mark.maximumObservedDrawdownMicros
      equityState.riskLimitBreached ||= mark.dailyLossLimit?.exceeded === true || mark.drawdownLimit?.exceeded === true
      sessionPeakEquityMicros = mark.peakEquityMicros
      sessionMaximumDrawdownMicros = mark.maximumObservedDrawdownMicros
      sessionRiskLimitBreached ||= mark.dailyLossLimit?.exceeded === true || mark.drawdownLimit?.exceeded === true
    }

    const markEquity = (
      bidPriceMicros: Readonly<Record<string, string>>,
    ): Result.Result<IntradayReplayEquityMark, IntradayReplayEquityFailure> => {
      const mark = markIntradayReplayEquity({
        ledger,
        bidPriceMicros,
        dayStartEquityMicros,
        previousPeakEquityMicros: equityState.peakEquityMicros,
        previousMaximumObservedDrawdownMicros: equityState.maximumObservedDrawdownMicros,
        limits: {
          maxDailyLossMicros: policy.maxDailyLossMicros,
          maxDrawdownMicros: policy.maxDrawdownMicros,
        },
      })
      if (Result.isSuccess(mark)) recordEquityMark(mark.success)
      return mark
    }

    const entryStartMs = Date.parse(context.window.submissionOpenAt) + input.assumptions.firstPollDelayMs
    const entryCutoffMs = Date.parse(context.window.submissionCutoffAt)
    for (let observedMs = entryStartMs; observedMs < entryCutoffMs; observedMs += input.assumptions.pollIntervalMs) {
      const observedAt = utcInstantFromEpochMillis(observedMs)
      const queryResult = intradayMomentumEntryQuery(context.queryContext, protocol, context.marketCalendar, observedAt)
      if (Result.isFailure(queryResult)) {
        const cause = queryResult.failure
        const retryable = cause instanceof IntradayMomentumEntryAwaitingSnapshot
        retryableEntryFailure ||= retryable
        pushUnavailable(observations, 'decision', observedAt, cause, retryable)
        if (!retryable) {
          structuralFailure = failureDescription(cause).message
          break
        }
        continue
      }

      const loaded = yield* readSnapshot(marketData, queryResult.success)
      if (loaded._tag === 'Failure') {
        const retryable = isRetryableArchiveFailure(loaded.error)
        retryableEntryFailure ||= retryable
        pushUnavailable(observations, 'decision', observedAt, loaded.error, retryable)
        if (!retryable) {
          structuralFailure = failureDescription(loaded.error).message
          break
        }
        continue
      }

      const decisionSnapshot = loaded.snapshot
      const decisionResult = evaluateDecision(
        protocol,
        decisionSnapshot,
        context,
        availabilitySnapshots.get(decisionSnapshot.manifest.snapshotId)?.candidateExclusions ?? [],
      )
      if (Result.isFailure(decisionResult)) {
        const cause = decisionResult.failure
        const retryable = cause.reason === 'snapshot-coverage' && cause.message === rollingBaselineMessage
        retryableEntryFailure ||= retryable
        pushUnavailable(observations, 'decision', observedAt, cause, retryable)
        if (!retryable) {
          structuralFailure = failureDescription(cause).message
          break
        }
        continue
      }

      const decision = decisionResult.success
      observations.push({ kind: 'snapshot', purpose: 'decision', manifest: decisionSnapshot.manifest, decision })
      if (decision.selectedSymbols.length === 0) {
        retryableEntryFailure ||= decision.excludedCandidates?.length === protocol.candidateSymbols.length
        continue
      }
      if (decision.selectedSymbols.length > 1) {
        structuralFailure = 'active intraday-momentum selected more than one entry symbol'
        break
      }
      selectedDecision = decision
      selectedDecisionSnapshot = decisionSnapshot
      break
    }

    if (structuralFailure !== undefined) {
      return incompleteSession(context, ledger, observations, orders, `entry evidence incomplete: ${structuralFailure}`)
    }

    if (selectedDecision === undefined || selectedDecisionSnapshot === undefined) {
      if (retryableEntryFailure) {
        return incompleteSession(
          context,
          ledger,
          observations,
          orders,
          'entry evidence incomplete: no-trade result followed unavailable decision observations',
        )
      }
      const flatMark = markEquity({})
      if (Result.isFailure(flatMark)) {
        return incompleteSession(
          context,
          ledger,
          observations,
          orders,
          'flat equity accounting failed before the no-trade result',
          equityDiagnostics(),
        )
      }
      return completeSession(
        context,
        ledger,
        observations,
        orders,
        'no qualifying intraday-momentum signal',
        equityDiagnostics(),
      )
    }

    const symbol = selectedDecision.selectedSymbols[0]
    if (symbol === undefined) {
      return incompleteSession(context, ledger, observations, orders, 'entry decision selected no executable symbol')
    }
    const baselineMark = markEquity({})
    if (Result.isFailure(baselineMark)) {
      return incompleteSession(
        context,
        ledger,
        observations,
        orders,
        'baseline equity accounting failed before entry planning',
        equityDiagnostics(),
      )
    }
    const incompleteAfterBaseline = (reason: string): IntradayReplaySession =>
      incompleteSession(context, ledger, observations, orders, reason, equityDiagnostics())
    const decisionRangeEndAt = selectedDecisionSnapshot.manifest.rangeEndAt
    const decisionObservedAt = selectedDecisionSnapshot.manifest.observedAt
    const planningQueryResult = intradayMomentumPricingQuery(
      context.queryContext,
      protocol,
      context.marketCalendar,
      decisionObservedAt,
      decisionRangeEndAt,
      [symbol],
    )
    if (Result.isFailure(planningQueryResult)) {
      pushUnavailable(observations, 'planning', decisionObservedAt, planningQueryResult.failure, false)
      return incompleteAfterBaseline(
        `entry planning query failed: ${failureDescription(planningQueryResult.failure).message}`,
      )
    }
    const planningLoaded = yield* readSnapshot(marketData, planningQueryResult.success)
    if (planningLoaded._tag === 'Failure') {
      const retryable = isRetryableArchiveFailure(planningLoaded.error)
      pushUnavailable(observations, 'planning', decisionObservedAt, planningLoaded.error, retryable)
      return incompleteAfterBaseline(
        `entry planning evidence incomplete: ${failureDescription(planningLoaded.error).message}`,
      )
    }
    const planningSnapshot = planningLoaded.snapshot
    observations.push({ kind: 'snapshot', purpose: 'planning', manifest: planningSnapshot.manifest })

    const planningPrices = adverseQuotePrices(planningSnapshot, [symbol])
    if (Result.isFailure(planningPrices)) {
      pushUnavailable(observations, 'planning', decisionObservedAt, planningPrices.failure, false)
      return incompleteAfterBaseline(
        `entry price construction failed: ${failureDescription(planningPrices.failure).message}`,
      )
    }
    const askPriceMicrosText = planningPrices.success.askPriceMicros[symbol]
    if (askPriceMicrosText === undefined) {
      return incompleteAfterBaseline('entry planning omitted the selected symbol')
    }
    const askPriceMicros = BigInt(askPriceMicrosText)
    const targetWeight = selectedDecision.targetWeights[symbol]
    if (targetWeight === undefined || targetWeight <= 0) {
      return incompleteAfterBaseline('selected entry has no positive target weight')
    }
    const allocation = allocationForDecision(
      ledger,
      selectedDecision,
      symbol,
      askPriceMicros,
      input.allocationCapitalMicros,
      policy,
    )
    if (Result.isFailure(allocation)) {
      pushUnavailable(observations, 'planning', decisionObservedAt, allocation.failure, false)
      return incompleteAfterBaseline('entry allocation could not satisfy the active risk policy')
    }
    const desired = desiredQuantityMicros(allocation.success, targetWeight, askPriceMicros, protocol.executionModel)
    if (Result.isFailure(desired)) {
      pushUnavailable(observations, 'planning', decisionObservedAt, desired.failure, false)
      return incompleteAfterBaseline('entry quantity could not be represented at the active precision')
    }
    const displayed = maximumBuyQuantities(planningSnapshot, { [symbol]: targetWeight })
    if (Result.isFailure(displayed)) {
      pushUnavailable(observations, 'planning', decisionObservedAt, displayed.failure, false)
      return incompleteAfterBaseline('entry displayed-liquidity evidence could not be compiled')
    }
    const displayedQuantity = BigInt(displayed.success[symbol] ?? '0')
    const requestedQuantity = minBigInt(desired.success, displayedQuantity)
    if (requestedQuantity === 0n) {
      pushUnavailable(
        observations,
        'planning',
        decisionObservedAt,
        new Error('selected entry has no whole-share displayed ask capacity'),
        false,
      )
      return completeSession(
        context,
        ledger,
        observations,
        orders,
        'selected entry had no displayed ask capacity',
        equityDiagnostics(),
      )
    }
    const requestedNotional = notionalMicros(requestedQuantity, askPriceMicros)
    if (Result.isFailure(requestedNotional)) {
      pushUnavailable(observations, 'planning', decisionObservedAt, requestedNotional.failure, false)
      return incompleteAfterBaseline('entry notional could not be calculated')
    }
    const minimumBuyNotional = BigInt(protocol.executionModel.precision.minimumBuyNotionalMicros)
    if (requestedNotional.success < minimumBuyNotional) {
      pushUnavailable(
        observations,
        'planning',
        decisionObservedAt,
        new Error('selected entry is below the active minimum buy notional'),
        false,
      )
      return completeSession(
        context,
        ledger,
        observations,
        orders,
        'selected entry was below the minimum buy notional',
        equityDiagnostics(),
      )
    }

    const arrivalAt = utcInstantFromEpochMillis(Date.parse(decisionObservedAt) + input.assumptions.orderLatencyMs)
    const arrivalQueryResult = intradayMomentumPricingQuery(
      context.queryContext,
      protocol,
      context.marketCalendar,
      arrivalAt,
      decisionRangeEndAt,
      [symbol],
    )
    if (Result.isFailure(arrivalQueryResult)) {
      pushUnavailable(observations, 'arrival', arrivalAt, arrivalQueryResult.failure, false)
      return incompleteAfterBaseline(
        `entry arrival query failed: ${failureDescription(arrivalQueryResult.failure).message}`,
      )
    }
    const arrivalLoaded = yield* readSnapshot(marketData, arrivalQueryResult.success)
    if (arrivalLoaded._tag === 'Failure') {
      const retryable = isRetryableArchiveFailure(arrivalLoaded.error)
      pushUnavailable(observations, 'arrival', arrivalAt, arrivalLoaded.error, retryable)
      return incompleteAfterBaseline(
        `entry arrival evidence incomplete: ${failureDescription(arrivalLoaded.error).message}`,
      )
    }
    const arrivalSnapshot = arrivalLoaded.snapshot
    observations.push({ kind: 'snapshot', purpose: 'arrival', manifest: arrivalSnapshot.manifest })

    const entryOrder = {
      symbol,
      side: OrderSide.Buy,
      quantityMicros: requestedQuantity.toString(),
      limitPriceMicros: askPriceMicros.toString(),
      submittedAt: decisionObservedAt,
    }
    const entryOutcome = simulateIntradayReplayIoc({
      order: entryOrder,
      arrivalSnapshot,
      executionModel: protocol.executionModel,
      assumptions: {
        slippageBps: input.assumptions.slippageBps,
        availableLiquidityPpm: input.assumptions.availableLiquidityPpm,
      },
    })
    if (Result.isFailure(entryOutcome)) {
      pushUnavailable(observations, 'arrival', arrivalAt, iocFailure(entryOutcome.failure), false)
      return incompleteAfterBaseline('entry IOC simulation failed')
    }
    orders.push(entryOutcome.success)
    const entryLedger = applyOutcome(ledger, entryOutcome.success, protocol, input.assumptions.feeMultiplierPpm)
    if (Result.isFailure(entryLedger)) {
      pushUnavailable(observations, 'arrival', arrivalAt, entryLedger.failure, false)
      return incompleteAfterBaseline('entry IOC accounting failed')
    }
    ledger = entryLedger.success
    if (entryOutcome.success.status === 'canceled' || ledger.positions.length === 0) {
      return completeSession(
        context,
        ledger,
        observations,
        orders,
        entryOutcome.success.status === 'canceled'
          ? 'entry IOC canceled without exposure'
          : 'entry completed and left no exposure',
        equityDiagnostics(),
      )
    }

    let closeFailure: string | undefined
    const closeStartMs =
      Date.parse(context.calendar.executionCloseAt) -
      protocol.flattenBeforeCloseMinutes * 60_000 +
      input.assumptions.firstPollDelayMs
    const hardFlatMs = Date.parse(context.calendar.executionCloseAt) - protocol.hardFlatBeforeCloseMinutes * 60_000
    let nextMarkMs = Date.parse(arrivalAt)
    for (
      let observedMs = closeStartMs;
      observedMs < hardFlatMs && ledger.positions.length > 0;
      observedMs += input.assumptions.pollIntervalMs
    ) {
      while (nextMarkMs <= observedMs && nextMarkMs <= hardFlatMs && ledger.positions.length > 0) {
        const markObservedAt = utcInstantFromEpochMillis(nextMarkMs)
        const heldSymbols = ledger.positions.map(({ symbol: positionSymbol }) => positionSymbol)
        const markRangeEndMs =
          nextMarkMs % minuteMs === 0 ? nextMarkMs - minuteMs : Math.floor(nextMarkMs / minuteMs) * minuteMs
        const markRangeEndAt = utcInstantFromEpochMillis(markRangeEndMs)
        const markQueryResult = intradayMomentumPricingQuery(
          context.queryContext,
          protocol,
          context.marketCalendar,
          markObservedAt,
          markRangeEndAt,
          heldSymbols,
        )
        if (Result.isFailure(markQueryResult)) {
          const retryable = markQueryResult.failure instanceof IntradayMomentumCloseAwaitingSnapshot
          pushUnavailable(observations, 'mark', markObservedAt, markQueryResult.failure, retryable)
          markEvidenceFailure ??= `mark query failed: ${failureDescription(markQueryResult.failure).message}`
          nextMarkMs += input.assumptions.pollIntervalMs
          continue
        }
        const markLoaded = yield* readSnapshot(marketData, markQueryResult.success)
        if (markLoaded._tag === 'Failure') {
          const retryable = isRetryableArchiveFailure(markLoaded.error)
          pushUnavailable(observations, 'mark', markObservedAt, markLoaded.error, retryable)
          markEvidenceFailure ??= `mark evidence unavailable: ${failureDescription(markLoaded.error).message}`
          nextMarkMs += input.assumptions.pollIntervalMs
          continue
        }
        const markSnapshot = markLoaded.snapshot
        const markPrices = adverseClosingQuotePrices(markSnapshot, heldSymbols)
        if (Result.isFailure(markPrices)) {
          pushUnavailable(observations, 'mark', markObservedAt, markPrices.failure, false)
          markEvidenceFailure ??= `mark quote construction failed: ${failureDescription(markPrices.failure).message}`
          nextMarkMs += input.assumptions.pollIntervalMs
          continue
        }
        const mark = markEquity(markPrices.success.bidPriceMicros)
        if (Result.isFailure(mark)) {
          pushUnavailable(
            observations,
            'mark',
            markObservedAt,
            new Error(`${mark.failure.field}: ${mark.failure.reason}`),
            false,
          )
          markEvidenceFailure ??= `mark-to-market accounting failed: ${mark.failure.field}`
          nextMarkMs += input.assumptions.pollIntervalMs
          continue
        }
        observations.push({
          kind: 'snapshot',
          purpose: 'mark',
          manifest: markSnapshot.manifest,
          equity: mark.success,
        })
        nextMarkMs += input.assumptions.pollIntervalMs
      }
      const observedAt = utcInstantFromEpochMillis(observedMs)
      const positions = ledger.positions
      const closeQueryResult = intradayMomentumCloseQuery(
        context.queryContext,
        protocol,
        context.marketCalendar,
        observedAt,
        positions.map(({ symbol: positionSymbol }) => positionSymbol),
      )
      if (Result.isFailure(closeQueryResult)) {
        const retryable = closeQueryResult.failure instanceof IntradayMomentumCloseAwaitingSnapshot
        pushUnavailable(observations, 'close', observedAt, closeQueryResult.failure, retryable)
        if (!retryable) {
          closeFailure = failureDescription(closeQueryResult.failure).message
          break
        }
        continue
      }
      const closeLoaded = yield* readSnapshot(marketData, closeQueryResult.success)
      if (closeLoaded._tag === 'Failure') {
        const retryable = isRetryableArchiveFailure(closeLoaded.error)
        pushUnavailable(observations, 'close', observedAt, closeLoaded.error, retryable)
        if (!retryable) {
          closeFailure = failureDescription(closeLoaded.error).message
          break
        }
        continue
      }
      const closeSnapshot = closeLoaded.snapshot
      observations.push({ kind: 'snapshot', purpose: 'close', manifest: closeSnapshot.manifest })
      const closePrices = adverseClosingQuotePrices(
        closeSnapshot,
        positions.map(({ symbol: positionSymbol }) => positionSymbol),
      )
      if (Result.isFailure(closePrices)) {
        pushUnavailable(observations, 'close', observedAt, closePrices.failure, true)
        continue
      }
      const closeCaps = maximumSellQuantities(
        closeSnapshot,
        positions,
        Object.fromEntries(positions.map(({ symbol: positionSymbol }) => [positionSymbol, 0])),
      )
      if (Result.isFailure(closeCaps)) {
        pushUnavailable(observations, 'close', observedAt, closeCaps.failure, false)
        closeFailure = failureDescription(closeCaps.failure).message
        break
      }
      const insufficient = positions.find(
        (position) => BigInt(position.quantityMicros) > BigInt(closeCaps.success[position.symbol] ?? '0'),
      )
      if (insufficient !== undefined) {
        pushUnavailable(
          observations,
          'close',
          observedAt,
          new Error(`close displayed bid capacity is below the full ${insufficient.symbol} position`),
          true,
        )
        continue
      }

      const arrivalAt = utcInstantFromEpochMillis(Date.parse(observedAt) + input.assumptions.orderLatencyMs)
      if (Date.parse(arrivalAt) >= hardFlatMs) {
        pushUnavailable(
          observations,
          'arrival',
          arrivalAt,
          new Error('closing IOC arrival would be at or beyond the hard-flat boundary'),
          false,
        )
        closeFailure = 'closing IOC arrival exceeded the hard-flat boundary'
        break
      }
      const arrivalQueryResult = intradayMomentumPricingQuery(
        context.queryContext,
        protocol,
        context.marketCalendar,
        arrivalAt,
        closeSnapshot.manifest.rangeEndAt,
        positions.map(({ symbol: positionSymbol }) => positionSymbol),
      )
      if (Result.isFailure(arrivalQueryResult)) {
        const retryable = arrivalQueryResult.failure instanceof IntradayMomentumCloseAwaitingSnapshot
        pushUnavailable(observations, 'arrival', arrivalAt, arrivalQueryResult.failure, retryable)
        if (!retryable) {
          closeFailure = failureDescription(arrivalQueryResult.failure).message
          break
        }
        continue
      }
      const arrivalLoaded = yield* readSnapshot(marketData, {
        ...arrivalQueryResult.success,
        purpose: IntradaySnapshotPurpose.Liquidation,
      })
      if (arrivalLoaded._tag === 'Failure') {
        const retryable = isRetryableArchiveFailure(arrivalLoaded.error)
        pushUnavailable(observations, 'arrival', arrivalAt, arrivalLoaded.error, retryable)
        if (!retryable) {
          closeFailure = failureDescription(arrivalLoaded.error).message
          break
        }
        continue
      }
      const arrivalSnapshot = arrivalLoaded.snapshot
      observations.push({ kind: 'snapshot', purpose: 'arrival', manifest: arrivalSnapshot.manifest })
      for (const position of positions) {
        const limitPriceMicros = closePrices.success.bidPriceMicros[position.symbol]
        if (limitPriceMicros === undefined) {
          closeFailure = `closing quote omitted ${position.symbol}`
          break
        }
        const closeOutcome = simulateIntradayReplayIoc({
          order: {
            symbol: position.symbol,
            side: OrderSide.Sell,
            quantityMicros: position.quantityMicros,
            limitPriceMicros,
            submittedAt: observedAt,
          },
          arrivalSnapshot,
          executionModel: protocol.executionModel,
          assumptions: {
            slippageBps: input.assumptions.slippageBps,
            availableLiquidityPpm: input.assumptions.availableLiquidityPpm,
          },
        })
        if (Result.isFailure(closeOutcome)) {
          pushUnavailable(observations, 'close', observedAt, iocFailure(closeOutcome.failure), false)
          closeFailure = 'closing IOC simulation failed'
          break
        }
        orders.push(closeOutcome.success)
        const nextLedger = applyOutcome(ledger, closeOutcome.success, protocol, input.assumptions.feeMultiplierPpm)
        if (Result.isFailure(nextLedger)) {
          pushUnavailable(observations, 'close', observedAt, nextLedger.failure, false)
          closeFailure = 'closing IOC accounting failed'
          break
        }
        ledger = nextLedger.success
        if (ledger.positions.length === 0) break
      }
      if (closeFailure !== undefined) break
    }

    if (closeFailure !== undefined) {
      return incompleteAfterBaseline(`close evidence incomplete: ${closeFailure}`)
    }
    if (ledger.positions.length > 0) {
      return incompleteAfterBaseline('positions remained open at the hard-flat boundary')
    }
    const flatMark = markEquity({})
    if (Result.isFailure(flatMark)) {
      return incompleteAfterBaseline('flat equity accounting failed after position flattening')
    }
    if (markEvidenceFailure !== undefined) {
      return incompleteAfterBaseline(`mark evidence incomplete: ${markEvidenceFailure}`)
    }
    return completeSession(
      context,
      ledger,
      observations,
      orders,
      'entry executed and position flattened',
      equityDiagnostics(),
    )
  })

const skippedSession = (
  session: { readonly date: string },
  calendarHash: string,
  cashMicros: string,
  positions: readonly IntradayReplayPosition[],
): IntradayReplaySession =>
  emptySession(session.date, calendarHash, cashMicros, 'skipped after an earlier incomplete session', positions)

const reportWithHash = (
  material: Omit<IntradayReplayReport, 'reportHash'>,
): Result.Result<IntradayReplayReport, IntradayReplayFailure> =>
  Result.mapError(
    canonicalHashV1Result(material),
    (cause) =>
      new IntradayReplayFailure({ operation: 'report', message: 'replay report is not canonically hashable', cause }),
  ).pipe(Result.map((reportHash) => ({ ...material, reportHash })))

export const runIntradayReplay = (
  input: IntradayReplayInput,
  marketData: ReplayMarketDataService,
  now: string,
): Effect.Effect<IntradayReplayReport, IntradayReplayFailure> =>
  Effect.gen(function* () {
    const decodedInput = yield* Effect.fromResult(decodeIntradayReplayInput(input)).pipe(
      Effect.mapError(
        (cause) => new IntradayReplayFailure({ operation: 'input', message: 'invalid replay input', cause }),
      ),
    )
    const availabilityPolicy = decodedInput.archiveAvailability ?? ArchiveAvailabilityPolicy.RecordedReader
    const availabilitySnapshots = new Map<string, ArchiveSnapshotAvailability>()
    const availabilityReceipts = new Map<string, ArchiveAvailabilityReceipt>()
    const verifyAvailability = marketData.recordedAvailability
    const requireAvailability = (snapshot: ArchiveVerifiedIntradayMarketSnapshot) =>
      Effect.gen(function* () {
        if (availabilityPolicy === ArchiveAvailabilityPolicy.SourceReceiptAssumption) return snapshot
        if (verifyAvailability === undefined) {
          return yield* operationalError({
            component: 'market-data',
            operation: 'archive-availability',
            message: 'recorded reader availability is required; source receipt time is not a substitute',
            cause: new IntradaySnapshotFailure({
              reason: 'not-ready',
              message: 'no recorded archive availability reader was supplied',
            }),
          })
        }
        const proof = yield* verifyAvailability(snapshot)
        availabilitySnapshots.set(proof.snapshotId, proof)
        for (const receipt of proof.receipts) availabilityReceipts.set(receipt.receiptHash, receipt)
        return snapshot
      })
    const replayMarket: IntradayMarketDataService =
      availabilityPolicy === ArchiveAvailabilityPolicy.SourceReceiptAssumption
        ? marketData
        : {
            check: marketData.check,
            captureVersion: marketData.captureVersion,
            loadSnapshot: (request) => marketData.loadSnapshot(request).pipe(Effect.flatMap(requireAvailability)),
            verifyArchiveSnapshot: (snapshot) =>
              marketData.verifyArchiveSnapshot(snapshot).pipe(Effect.flatMap(requireAvailability)),
          }
    if (!isValidUtcInstant(now)) {
      return yield* new IntradayReplayFailure({
        operation: 'input',
        message: 'replay now must be a canonical UTC instant',
      })
    }
    const nowMs = Date.parse(now)
    const normalizedCalendar = yield* Effect.fromResult(
      normalizeMarketCalendarResult(decodedInput.calendar, decodedInput.range),
    ).pipe(
      Effect.mapError(
        (cause) =>
          new IntradayReplayFailure({ operation: 'calendar', message: 'input calendar normalization failed', cause }),
      ),
    )
    if (normalizedCalendar.sessions.some((session) => Date.parse(session.closeAt) >= nowMs)) {
      return yield* new IntradayReplayFailure({
        operation: 'calendar',
        message: 'replay requires every calendar session to be finalized before now',
      })
    }
    if (normalizedCalendar.sessions.length === 0) {
      return yield* new IntradayReplayFailure({
        operation: 'calendar',
        message: 'replay calendar contains no finalized sessions',
      })
    }

    const protocol = yield* Effect.fromResult(decodeDefaultIntradayMomentumProtocol()).pipe(
      Effect.mapError(
        (cause) =>
          new IntradayReplayFailure({
            operation: 'strategy',
            message: 'active intraday-momentum protocol is invalid',
            cause,
          }),
      ),
    )
    if (protocol.executionModel.schemaVersion !== 'bayn.execution-model.v5') {
      return yield* new IntradayReplayFailure({
        operation: 'strategy',
        message: 'historical replay requires the active execution model v5',
      })
    }
    const definition = makeIntradayMomentumDefinition(protocol)
    if (definition.name !== activeStrategyName || definition.holdingPeriod !== 'INTRADAY') {
      return yield* new IntradayReplayFailure({
        operation: 'strategy',
        message: 'historical replay requires the active intraday-momentum definition',
      })
    }
    const protocolHash = yield* Effect.fromResult(hashIntradayMomentumProtocol(protocol)).pipe(
      Effect.mapError(
        (cause) =>
          new IntradayReplayFailure({ operation: 'strategy', message: 'protocol hash construction failed', cause }),
      ),
    )
    const strategyProtocolHash = yield* Effect.fromResult(
      makeStrategyProtocolHashResult({
        name: activeStrategyName,
        behaviorHash: activeStrategyBehaviorHash,
        parameterHash: protocolHash,
        parameterSchemaVersion: protocol.schemaVersion,
      }),
    ).pipe(
      Effect.mapError(
        (cause) =>
          new IntradayReplayFailure({
            operation: 'strategy',
            message: 'strategy protocol hash construction failed',
            cause,
          }),
      ),
    )
    const executionPolicy = yield* Effect.fromResult(makeCycleExecutionPolicyFromModel(protocol.executionModel)).pipe(
      Effect.mapError(
        (cause) =>
          new IntradayReplayFailure({ operation: 'strategy', message: 'execution policy construction failed', cause }),
      ),
    )
    if (executionPolicy.schemaVersion !== replayPolicySchemaVersion) {
      return yield* new IntradayReplayFailure({
        operation: 'strategy',
        message: 'historical replay requires the session-relative v3 execution policy',
      })
    }
    const riskPolicy = yield* loadQuoteBoundExecutionRiskPolicy('build-contract', protocol.universe).pipe(
      Effect.mapError(
        (cause) =>
          new IntradayReplayFailure({
            operation: 'strategy',
            message: 'execution risk policy construction failed',
            cause,
          }),
      ),
    )
    const riskPolicyHash = yield* Effect.fromResult(canonicalHashV1Result(riskPolicy)).pipe(
      Effect.mapError(
        (cause) =>
          new IntradayReplayFailure({ operation: 'strategy', message: 'risk policy hash construction failed', cause }),
      ),
    )
    const embeddedProvenancePresent = embeddedBuildMetadata !== undefined || embeddedRuntimeIdentity !== undefined
    const validatedBuildMetadata = embeddedProvenancePresent
      ? yield* Schema.decodeUnknownEffect(
          EmbeddedBuildMetadataSchema,
          strictParseOptions,
        )(embeddedBuildMetadata).pipe(
          Effect.mapError(
            (cause) =>
              new IntradayReplayFailure({
                operation: 'strategy',
                message: 'embedded build metadata is incomplete or invalid',
                cause,
              }),
          ),
        )
      : undefined
    const validatedRuntimeIdentity = embeddedProvenancePresent
      ? yield* Schema.decodeUnknownEffect(
          EmbeddedRuntimeIdentitySchema,
          strictParseOptions,
        )(embeddedRuntimeIdentity).pipe(
          Effect.mapError(
            (cause) =>
              new IntradayReplayFailure({
                operation: 'strategy',
                message: 'embedded runtime identity is incomplete or invalid',
                cause,
              }),
          ),
        )
      : undefined
    if (validatedBuildMetadata !== undefined) {
      yield* Effect.all([
        verifyBehaviorHash(validatedBuildMetadata, activeStrategyBehaviorHash),
        verifyParameterHash(validatedBuildMetadata, protocolHash),
      ]).pipe(
        Effect.mapError(
          (cause) =>
            new IntradayReplayFailure({
              operation: 'strategy',
              message: 'embedded build metadata does not match active strategy',
              cause,
            }),
        ),
      )
    }
    if (validatedRuntimeIdentity !== undefined) {
      yield* Effect.all([
        verifyStrategyName(validatedRuntimeIdentity, activeStrategyName),
        verifyStrategyProtocolHash(validatedRuntimeIdentity, strategyProtocolHash),
        verifyExecutionRiskPolicyHash(validatedRuntimeIdentity, riskPolicyHash),
      ]).pipe(
        Effect.mapError(
          (cause) =>
            new IntradayReplayFailure({
              operation: 'strategy',
              message: 'embedded runtime identity does not match active strategy',
              cause,
            }),
        ),
      )
    }
    const inputHash = yield* Effect.fromResult(canonicalHashV1Result(decodedInput)).pipe(
      Effect.mapError(
        (cause) =>
          new IntradayReplayFailure({ operation: 'report', message: 'replay input hash construction failed', cause }),
      ),
    )

    const sessions: IntradayReplaySession[] = []
    let nextCashMicros = decodedInput.initialCapitalMicros
    let nextPositions: readonly IntradayReplayPosition[] = []
    let stopped = false
    const equityState: ReplayEquityState = {
      peakEquityMicros: decodedInput.initialCapitalMicros,
      maximumObservedDrawdownMicros: '0',
      riskLimitBreached: false,
    }
    for (const calendarSession of normalizedCalendar.sessions) {
      if (stopped) {
        const contextResult = replayContext(calendarSession, normalizedCalendar, executionPolicy)
        const sessionCalendarHash = Result.isSuccess(contextResult)
          ? contextResult.success.calendar.executionCalendarHash
          : normalizedCalendar.normalizedResponseHash
        sessions.push(skippedSession(calendarSession, sessionCalendarHash, nextCashMicros, nextPositions))
        continue
      }
      const contextResult = replayContext(calendarSession, normalizedCalendar, executionPolicy)
      if (Result.isFailure(contextResult)) {
        sessions.push(
          emptySession(
            calendarSession.date,
            normalizedCalendar.normalizedResponseHash,
            nextCashMicros,
            `session context incomplete: ${contextResult.failure.message}`,
            nextPositions,
          ),
        )
        stopped = true
        continue
      }
      const session = yield* replaySession(
        decodedInput,
        replayMarket,
        protocol,
        riskPolicy,
        contextResult.success,
        nextCashMicros,
        equityState,
        availabilitySnapshots,
      )
      sessions.push(session)
      nextCashMicros = session.cashMicros
      nextPositions = session.positions
      stopped = session.status === 'INCOMPLETE' || session.positions.length > 0
    }

    const completedSessionCount = sessions.filter((session) => session.status === 'COMPLETE').length
    const incompleteSessionCount = sessions.length - completedSessionCount
    const executionSessionCount = sessions.filter((session) => session.fills.length > 0).length
    const totalPnl = sessions.every((session) => session.status === 'COMPLETE')
      ? sessions
          .reduce((total, session) => total + BigInt(session.netRealizedPnlAfterCostsMicros ?? '0'), 0n)
          .toString()
      : null
    const material: Omit<IntradayReplayReport, 'reportHash'> = {
      schemaVersion: 'bayn.intraday-replay-report.v3',
      evidenceKind: 'COUNTERFACTUAL_RESEARCH',
      qualification: 'NOT_QUALIFIED',
      inputHash,
      input: decodedInput,
      build: validatedBuildMetadata ?? null,
      protocolHash,
      strategyProtocolHash,
      riskPolicyHash,
      calendarHash: normalizedCalendar.normalizedResponseHash,
      availability: {
        policy: availabilityPolicy,
        status: availabilitySnapshots.size > 0 ? 'OBSERVED_ROWS_ONLY' : 'UNPROVEN',
        snapshots: [...availabilitySnapshots.values()].map((proof) => ({
          snapshotId: proof.snapshotId,
          observedAt: proof.observedAt,
          receiptHashes: proof.receipts.map((receipt) => receipt.receiptHash),
          ...(proof.candidateExclusions === undefined ? {} : { candidateExclusions: proof.candidateExclusions }),
        })),
        receipts: [...availabilityReceipts.values()],
      },
      sessions,
      totals: {
        completedSessionCount,
        incompleteSessionCount,
        executionSessionCount,
        netRealizedPnlAfterCostsMicros: totalPnl,
        maximumObservedDrawdownMicros: sessions.some(
          ({ maximumObservedDrawdownMicros }) => maximumObservedDrawdownMicros !== null,
        )
          ? equityState.maximumObservedDrawdownMicros
          : null,
        peakEquityMicros: sessions.some(({ peakEquityMicros }) => peakEquityMicros !== null)
          ? equityState.peakEquityMicros
          : null,
        riskLimitBreached: equityState.riskLimitBreached,
      },
      limitations: [
        availabilityPolicy === ArchiveAvailabilityPolicy.RecordedReader
          ? 'every used row requires a retained production-reader receipt completed no later than replay time; unavailable decision candidates are explicitly excluded, while missing benchmark or execution-pricing evidence and all-candidate unavailability remain incomplete'
          : 'source receipt time is an explicit unproven availability assumption; Kafka/Flink/ClickHouse visibility and production reader availability are not established',
        'reader receipts are conservative observed upper bounds, not earliest archive visibility, simultaneous snapshot proof, reader uptime, or actual execution evidence',
        'counterfactual flat-start session lifecycle; only cash carries between sessions',
        'no broker, authority, PostgreSQL, TigerBeetle, or risk receipt is fabricated',
        'full broker and risk-controller gates are not modeled; replay applies sizing and declared exposure caps only',
        'holding-period marks use verified archive snapshots and adverse bids at the replay poll interval; excursions between marks can be missed',
        'mark-to-market risk limits are diagnostic only and do not authorize liquidation or alter replay order decisions',
        'a missing required holding-period mark makes that session incomplete while retaining attempted closes and open positions',
        'positive replay output remains research evidence and cannot qualify or activate the strategy',
        'execution assumptions model adverse quote crossing and declared displayed liquidity, not queue position or actual fills',
      ],
    }
    return yield* Effect.fromResult(reportWithHash(material))
  })
