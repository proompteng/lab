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
import {
  constrainExecutionTargetAllocationCapitalMicros,
  executionMandateAllocationCapitalMicros,
} from '../execution/mandate'
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
import { OperationalError } from '../errors'
import { canonicalHashV1Result } from '../hash'
import {
  IntradaySnapshotFailure,
  IntradaySnapshotPurpose,
  type IntradayMarketDataService,
  type IntradaySnapshotQuery,
} from '../market-data'
import type { ArchiveVerifiedIntradayMarketSnapshot } from '../market-data/intraday/model'
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
import { applyReplayIoc, createReplayLedger, type IntradayReplayLedger } from './ledger'
import { simulateIntradayReplayIoc, type IntradayReplayIocOutcome } from './execution'

const archiveNotMaterializedMessage = 'intraday archive has not materialized the captured source offset'
const rollingBaselineMessage = 'intraday symbol lacks the complete rolling lookback baseline'
const replayCycleSchemaVersion = 'bayn.autonomous-cycle.v3' as const
const replayPolicySchemaVersion = 'bayn.autonomous-cycle-execution-policy.v3' as const

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

const failureDescription = (value: unknown): FailureDescription => ({
  reason:
    value instanceof IntradaySnapshotFailure
      ? value.reason
      : value instanceof OperationalError && value.cause instanceof IntradaySnapshotFailure
        ? value.cause.reason
        : value instanceof IntradayMomentumFailure
          ? value.reason
          : value instanceof OperationalError
            ? value.operation
            : value instanceof Error
              ? value.name
              : 'failure',
  message:
    value instanceof OperationalError && value.cause instanceof IntradaySnapshotFailure
      ? value.cause.message
      : value instanceof Error
        ? value.message
        : 'replay operation failed',
})

const isRetryableArchiveFailure = (error: OperationalError): boolean => {
  const cause = error.cause
  return (
    cause instanceof IntradaySnapshotFailure &&
    (cause.reason === 'not-ready' || (cause.reason === 'watermark' && cause.message === archiveNotMaterializedMessage))
  )
}

const isValidUtcInstant = (value: string): boolean =>
  Schema.is(UtcInstantSchema)(value) && Number.isFinite(Date.parse(value))

const minBigInt = (left: bigint, right: bigint): bigint => (left < right ? left : right)

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
): Result.Result<IntradayMomentumTargetPortfolio, IntradayMomentumFailure> =>
  makeIntradayMomentumDefinition(protocol).decide({
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

const emptySession = (
  date: string,
  calendarHash: string,
  openingCashMicros: string,
  reason: string,
  positions: readonly IntradayReplayPosition[] = [],
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
  maximumObservedDrawdownMicros: null,
})

const allocationForDecision = (
  ledger: IntradayReplayLedger,
  decision: IntradayMomentumTargetPortfolio,
  symbol: string,
  askPriceMicros: bigint,
  configuredAllocationCapitalMicros: string,
  policy: {
    readonly maxGrossExposureMicros: string
    readonly maxNetExposureMicros: string
    readonly maxDailyTradedNotionalMicros: string
    readonly maxAdverseSlippageBps: number
    readonly maxOrderNotionalMicros: string
    readonly maxSymbolExposureMicros: string
  },
) =>
  Result.flatMap(
    executionMandateAllocationCapitalMicros({
      accountEquityMicros: BigInt(ledger.cashMicros),
      dailyTradedNotionalMicros: 0n,
      maxGrossExposureMicros: BigInt(policy.maxGrossExposureMicros),
      maxNetExposureMicros: BigInt(policy.maxNetExposureMicros),
      maxDailyTradedNotionalMicros: BigInt(policy.maxDailyTradedNotionalMicros),
      maxAdverseSlippageBps: BigInt(policy.maxAdverseSlippageBps),
      positions: [],
      referencePriceMicros: { [symbol]: askPriceMicros.toString() },
    }),
    (mandateCapital) =>
      constrainExecutionTargetAllocationCapitalMicros({
        allocationCapitalMicros: minBigInt(
          mandateCapital,
          minBigInt(BigInt(configuredAllocationCapitalMicros), BigInt(ledger.cashMicros)),
        ),
        maxOrderNotionalMicros: BigInt(policy.maxOrderNotionalMicros),
        maxSymbolExposureMicros: BigInt(policy.maxSymbolExposureMicros),
        targetWeights: decision.targetWeights,
      }),
  )

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
  maximumObservedDrawdownMicros: null,
})

const completeSession = (
  context: ReplaySessionContext,
  ledger: IntradayReplayLedger,
  observations: readonly IntradayReplayObservation[],
  orders: readonly IntradayReplayIocOutcome[],
  reason: string,
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
  maximumObservedDrawdownMicros: null,
})

const replaySession = (
  input: IntradayReplayInput,
  marketData: IntradayMarketDataService,
  protocol: IntradayMomentumProtocol,
  policy: Policy,
  context: ReplaySessionContext,
  openingCashMicros: string,
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
      const decisionResult = evaluateDecision(protocol, decisionSnapshot, context)
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
      if (decision.selectedSymbols.length === 0) continue
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
      return completeSession(context, ledger, observations, orders, 'no qualifying intraday-momentum signal')
    }

    const symbol = selectedDecision.selectedSymbols[0]
    if (symbol === undefined) {
      return incompleteSession(context, ledger, observations, orders, 'entry decision selected no executable symbol')
    }
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
      return incompleteSession(
        context,
        ledger,
        observations,
        orders,
        `entry planning query failed: ${failureDescription(planningQueryResult.failure).message}`,
      )
    }
    const planningLoaded = yield* readSnapshot(marketData, planningQueryResult.success)
    if (planningLoaded._tag === 'Failure') {
      const retryable = isRetryableArchiveFailure(planningLoaded.error)
      pushUnavailable(observations, 'planning', decisionObservedAt, planningLoaded.error, retryable)
      return incompleteSession(
        context,
        ledger,
        observations,
        orders,
        `entry planning evidence incomplete: ${failureDescription(planningLoaded.error).message}`,
      )
    }
    const planningSnapshot = planningLoaded.snapshot
    observations.push({ kind: 'snapshot', purpose: 'planning', manifest: planningSnapshot.manifest })

    const planningPrices = adverseQuotePrices(planningSnapshot, [symbol])
    if (Result.isFailure(planningPrices)) {
      pushUnavailable(observations, 'planning', decisionObservedAt, planningPrices.failure, false)
      return incompleteSession(
        context,
        ledger,
        observations,
        orders,
        `entry price construction failed: ${failureDescription(planningPrices.failure).message}`,
      )
    }
    const askPriceMicrosText = planningPrices.success.askPriceMicros[symbol]
    if (askPriceMicrosText === undefined) {
      return incompleteSession(context, ledger, observations, orders, 'entry planning omitted the selected symbol')
    }
    const askPriceMicros = BigInt(askPriceMicrosText)
    const targetWeight = selectedDecision.targetWeights[symbol]
    if (targetWeight === undefined || targetWeight <= 0) {
      return incompleteSession(context, ledger, observations, orders, 'selected entry has no positive target weight')
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
      return incompleteSession(
        context,
        ledger,
        observations,
        orders,
        'entry allocation could not satisfy the active risk policy',
      )
    }
    const desired = desiredQuantityMicros(allocation.success, targetWeight, askPriceMicros, protocol.executionModel)
    if (Result.isFailure(desired)) {
      pushUnavailable(observations, 'planning', decisionObservedAt, desired.failure, false)
      return incompleteSession(
        context,
        ledger,
        observations,
        orders,
        'entry quantity could not be represented at the active precision',
      )
    }
    const displayed = maximumBuyQuantities(planningSnapshot, { [symbol]: targetWeight })
    if (Result.isFailure(displayed)) {
      pushUnavailable(observations, 'planning', decisionObservedAt, displayed.failure, false)
      return incompleteSession(
        context,
        ledger,
        observations,
        orders,
        'entry displayed-liquidity evidence could not be compiled',
      )
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
      return completeSession(context, ledger, observations, orders, 'selected entry had no displayed ask capacity')
    }
    const requestedNotional = notionalMicros(requestedQuantity, askPriceMicros)
    if (Result.isFailure(requestedNotional)) {
      pushUnavailable(observations, 'planning', decisionObservedAt, requestedNotional.failure, false)
      return incompleteSession(context, ledger, observations, orders, 'entry notional could not be calculated')
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
      return completeSession(context, ledger, observations, orders, 'selected entry was below the minimum buy notional')
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
      return incompleteSession(
        context,
        ledger,
        observations,
        orders,
        `entry arrival query failed: ${failureDescription(arrivalQueryResult.failure).message}`,
      )
    }
    const arrivalLoaded = yield* readSnapshot(marketData, arrivalQueryResult.success)
    if (arrivalLoaded._tag === 'Failure') {
      const retryable = isRetryableArchiveFailure(arrivalLoaded.error)
      pushUnavailable(observations, 'arrival', arrivalAt, arrivalLoaded.error, retryable)
      return incompleteSession(
        context,
        ledger,
        observations,
        orders,
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
      pushUnavailable(observations, 'arrival', arrivalAt, entryOutcome.failure, false)
      return incompleteSession(context, ledger, observations, orders, 'entry IOC simulation failed')
    }
    orders.push(entryOutcome.success)
    const entryLedger = applyOutcome(ledger, entryOutcome.success, protocol, input.assumptions.feeMultiplierPpm)
    if (Result.isFailure(entryLedger)) {
      pushUnavailable(observations, 'arrival', arrivalAt, entryLedger.failure, false)
      return incompleteSession(context, ledger, observations, orders, 'entry IOC accounting failed')
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
      )
    }

    let closeFailure: string | undefined
    const closeStartMs =
      Date.parse(context.calendar.executionCloseAt) -
      protocol.flattenBeforeCloseMinutes * 60_000 +
      input.assumptions.firstPollDelayMs
    const hardFlatMs = Date.parse(context.calendar.executionCloseAt) - protocol.hardFlatBeforeCloseMinutes * 60_000
    for (
      let observedMs = closeStartMs;
      observedMs < hardFlatMs && ledger.positions.length > 0;
      observedMs += input.assumptions.pollIntervalMs
    ) {
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
          pushUnavailable(observations, 'close', observedAt, closeOutcome.failure, false)
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
      return incompleteSession(context, ledger, observations, orders, `close evidence incomplete: ${closeFailure}`)
    }
    if (ledger.positions.length > 0) {
      return incompleteSession(
        context,
        ledger,
        observations,
        orders,
        'positions remained open at the hard-flat boundary',
      )
    }
    return completeSession(context, ledger, observations, orders, 'entry executed and position flattened')
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
  marketData: IntradayMarketDataService,
  now: string,
): Effect.Effect<IntradayReplayReport, IntradayReplayFailure> =>
  Effect.gen(function* () {
    const decodedInput = yield* Effect.fromResult(decodeIntradayReplayInput(input)).pipe(
      Effect.mapError(
        (cause) => new IntradayReplayFailure({ operation: 'input', message: 'invalid replay input', cause }),
      ),
    )
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
        marketData,
        protocol,
        riskPolicy,
        contextResult.success,
        nextCashMicros,
      )
      sessions.push(session)
      nextCashMicros = session.cashMicros
      nextPositions = session.positions
      stopped = session.status === 'INCOMPLETE' || session.positions.length > 0
    }

    const completedSessionCount = sessions.filter((session) => session.status === 'COMPLETE').length
    const incompleteSessionCount = sessions.length - completedSessionCount
    const executionSessionCount = sessions.filter((session) => session.orders.length > 0).length
    const totalPnl = sessions.every((session) => session.status === 'COMPLETE')
      ? sessions
          .reduce((total, session) => total + BigInt(session.netRealizedPnlAfterCostsMicros ?? '0'), 0n)
          .toString()
      : null
    const material: Omit<IntradayReplayReport, 'reportHash'> = {
      schemaVersion: 'bayn.intraday-replay-report.v1',
      evidenceKind: 'COUNTERFACTUAL_RESEARCH',
      qualification: 'NOT_QUALIFIED',
      inputHash,
      input: decodedInput,
      build: validatedBuildMetadata ?? null,
      protocolHash,
      strategyProtocolHash,
      riskPolicyHash,
      calendarHash: normalizedCalendar.normalizedResponseHash,
      sessions,
      totals: {
        completedSessionCount,
        incompleteSessionCount,
        executionSessionCount,
        netRealizedPnlAfterCostsMicros: totalPnl,
      },
      limitations: [
        'counterfactual flat-start session lifecycle; only cash carries between sessions',
        'no broker, authority, PostgreSQL, TigerBeetle, or risk receipt is fabricated',
        'full broker and risk-controller gates are not modeled; replay applies sizing and declared exposure caps only',
        'periodic mark-to-market drawdown is not implemented and is reported as null',
        'positive replay output remains research evidence and cannot qualify or activate the strategy',
        'execution assumptions model adverse quote crossing and declared displayed liquidity, not queue position or actual fills',
      ],
    }
    return yield* Effect.fromResult(reportWithHash(material))
  })
