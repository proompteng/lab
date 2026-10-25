import { jevProfitTargetCrossed } from './profit-target'
import { maximumFundedBuyQuantities } from './entry-sizing'
import { jevMaximumEntryAskMicros } from './entry-economics'
import { jevMarketForSymbol } from './markets'
import { jevMarketForCycle, jevCycleCandidates } from './markets'
import { isContinuousMarket, type MarketHours } from '../market-hours'
import { makeJevEntryQuery } from './observation-query'
import { Data, Duration, Effect, Option, Result } from 'effect'

import type { AutonomousCycle } from '../cycle/model'
import {
  DecisionReadinessReason,
  snapshotReadiness,
  type CycleWaitingDetails,
  type DecisionReadiness,
} from '../cycle/runner/readiness'
import {
  IntradaySnapshotPurpose,
  type IntradaySnapshotQuery,
  type IntradayMarketDataService,
} from '../market-data/intraday/model'
import { isIntradaySnapshotPending } from '../market-data/intraday/pending'
import type { ReconciledBrokerState } from '../simulation-reconciliation/broker-model'
import { priceNumberToMicros } from '../strategy/execution-model/fixed-point'
import { persistIntradayRecordRows } from '../market-data/intraday/verification'
import type { StrategyMarketSnapshot } from '../market-data/streaming/snapshot'
import { CandidateObservationStore, candidateObservationLog } from '../observe-composition/candidate-observation'
import { makeJevObservation } from './observation'
import {
  adverseQuotePrices,
  executionMarketDataBinding,
  loadIntradaySnapshot,
} from '../observe-composition/intraday-market-data'
import type { EntryQuoteFreshness } from '../risk'
import { currentUtcInstant, utcInstantFromEpochMillis } from '../time'
import { withObservedStage } from '../telemetry'
import {
  JevBatchPlanVersion,
  JevCandidatePlanStatus,
  JevSourceExclusion,
  decodeJevBatchPlan,
  decodeJevBatchResult,
  usableJevBatchInferences,
} from './batch'
import { evaluateJevBatch, recoverPendingJevBatches } from './batch-evaluation'
import { JevContractError } from './contract'
import { jevEntryQuoteMaximumAgeMs, jevPlanningTargetWeights, type JevEntryTarget } from './decision'
import {
  decideJevExit,
  jevBrokerEvidenceFreshUntilMs,
  jevMaximumHoldDueAt,
  jevProtectiveQuoteIsFresh,
  jevProtectiveStopCrossed,
  JevExitReason,
  type JevExitEvidence,
  type JevExitTarget,
} from './exit'
import { JevPositionStore, JevPurpose, jevManagedExitPlan } from './portfolio'
import { jevProtectiveQuoteDiagnostics } from './quote-diagnostics'
import { type JevProtocol } from './protocol'
import { jevEntryQuoteExclusion, jevStalePricingSymbols, makeJevTradingSignalBatch } from './trading-signals'

export class JevAwaitingEvidence extends Data.TaggedError('JevAwaitingEvidence')<{
  readonly message: string
  readonly availableAt?: string
  readonly readiness: DecisionReadinessReason
}> {}

export class JevAwaitingFreshWindow extends Data.TaggedError('JevAwaitingFreshWindow')<{
  readonly message: string
  readonly availableAt: string
}> {}

export const jevObservationQuery = (
  cycle: Pick<AutonomousCycle, 'identity' | 'window' | 'schemaVersion'>,
  protocol: JevProtocol,
  calendar: MarketHours,
  observedAt: string,
  purpose: JevPurpose,
  candidates = jevCycleCandidates(cycle, protocol.candidateSymbols),
): Result.Result<IntradaySnapshotQuery, JevContractError | JevAwaitingEvidence> => {
  const end = Math.floor((Date.parse(observedAt) - protocol.decisionDelaySeconds * 1000) / 60_000) * 60_000
  if (
    cycle.identity.strategyName !== 'jev' ||
    cycle.schemaVersion !== 'bayn.autonomous-cycle.v4' ||
    observedAt < cycle.window.submissionOpenAt ||
    observedAt >= (purpose === JevPurpose.Entry ? cycle.window.submissionCutoffAt : cycle.window.executionCloseAt)
  )
    return Result.fail(new JevContractError({ message: 'Jev observation is outside its native purpose window' }))
  if (!isContinuousMarket(calendar) && end <= Date.parse(cycle.window.executionOpenAt))
    return Result.fail(
      new JevAwaitingEvidence({
        message: 'Jev is waiting for the first completed source minute',
        readiness: DecisionReadinessReason.LookbackWarmup,
        availableAt: utcInstantFromEpochMillis(
          Date.parse(cycle.window.executionOpenAt) + 60_000 + protocol.decisionDelaySeconds * 1000,
        ),
      }),
    )
  return Result.succeed(
    makeJevEntryQuery({
      protocol,
      calendar,
      sessionDate: cycle.identity.executionSessionDate,
      observedAtMs: Date.parse(observedAt),
      candidates,
    }),
  )
}

export const jevPricingQuery = (
  cycle: Pick<AutonomousCycle, 'identity' | 'window'>,
  protocol: JevProtocol,
  calendar: MarketHours,
  observedAt: string,
  symbols: readonly string[],
  purpose: IntradaySnapshotPurpose = IntradaySnapshotPurpose.EntryPricing,
): Result.Result<IntradaySnapshotQuery, JevContractError | JevAwaitingEvidence> => {
  const end = Math.floor(Date.parse(observedAt) / 60_000) * 60_000
  const start = end - 60_000
  if (Date.parse(observedAt) === end)
    return Result.fail(
      new JevAwaitingEvidence({
        message: 'Jev pricing awaits the first observation after the completed-minute boundary',
        readiness: DecisionReadinessReason.LookbackWarmup,
        availableAt: utcInstantFromEpochMillis(end + 1),
      }),
    )
  if (
    cycle.identity.strategyName !== 'jev' ||
    symbols.length === 0 ||
    new Set(symbols).size !== symbols.length ||
    symbols.some((symbol) => !protocol.universe.includes(symbol)) ||
    (!isContinuousMarket(calendar) && start < Date.parse(cycle.window.executionOpenAt)) ||
    end >= Date.parse(cycle.window.executionCloseAt) ||
    Date.parse(observedAt) <= end
  )
    return Result.fail(
      new JevContractError({
        message: 'Jev pricing requires a completed minute, native cycle and canonical universe symbols',
      }),
    )
  const market = jevMarketForCycle(cycle)
  return Result.succeed({
    sessionDate: cycle.identity.executionSessionDate,
    calendar,
    observedAt,
    purpose,
    rangeStartAt: utcInstantFromEpochMillis(start),
    rangeEndAt: utcInstantFromEpochMillis(end),
    universeId: market.universeId,
    universeSymbolHash: market.universeSymbolHash,
    universe: market.universe,
    symbols: [...symbols].sort(),
    feed: market.feed,
    delayClass: market.delayClass,
    sourceTopics: market.sourceTopics,
    maximumQuoteAgeMs: protocol.maximumQuoteAgeMs,
    minimumWatermarkLagMs: 0,
  })
}

// Admit the durable decision window before materializing expensive signal history.
// The supplied effect stays lazy; position protection is evaluated by the caller first.
export const evaluateJevObservationFromSnapshot = <E, R>(
  input: Omit<Parameters<typeof makeJevObservation>[0], 'snapshot'>,
  rangeEndAt: string,
  loadSnapshot: Effect.Effect<Parameters<typeof makeJevObservation>[0]['snapshot'], E, R>,
) =>
  Effect.gen(function* () {
    if (!(yield* recoverPendingJevBatches(input.cycleId, input.authorityGenerationHash)))
      return yield* new JevAwaitingEvidence({
        message: 'A committed Jev batch still awaits its original deadline',
        readiness: DecisionReadinessReason.DecisionPending,
      })
    const latest = yield* (yield* CandidateObservationStore).latestJevWindowEnd({
      cycleId: input.cycleId,
      purpose: input.portfolio.purpose,
    })
    if (Option.isSome(latest) && latest.value >= rangeEndAt)
      return yield* new JevAwaitingFreshWindow({
        message: 'Jev already committed an observation for this completed signal window',
        availableAt: utcInstantFromEpochMillis(
          Date.parse(latest.value) + 60_000 + input.protocol.decisionDelaySeconds * 1000,
        ),
      })
    const snapshot = yield* loadSnapshot
    if (snapshot.manifest.rangeEndAt !== rangeEndAt)
      return yield* new JevContractError({ message: 'Jev signal snapshot differs from its admitted window' })
    const staleSymbols = jevStalePricingSymbols(snapshot)
    if (staleSymbols.length > 0)
      return yield* new JevAwaitingEvidence({
        message: `Jev is waiting for fresh signal pricing for ${staleSymbols.join(', ')}`,
        readiness: DecisionReadinessReason.SnapshotStale,
      })
    const inputAvailableAt = yield* currentUtcInstant
    const observation = yield* Effect.fromResult(makeJevObservation({ ...input, snapshot })).pipe(
      withObservedStage('bayn.jev.observation'),
    )
    const batchPlan = yield* Effect.suspend(() =>
      Effect.fromResult(
        makeJevTradingSignalBatch({
          observation: observation.payload,
          expiresAt: utcInstantFromEpochMillis(
            Date.parse(observation.payload.observedAt) + input.protocol.inferenceValidityMs,
          ),
          planVersion: JevBatchPlanVersion.V6,
        }),
      ),
    ).pipe(
      Effect.tap((plan) =>
        Effect.gen(function* () {
          yield* Effect.annotateCurrentSpan({
            'bayn.entry_timing.batch_id': plan.batchId,
            'bayn.entry_timing.observation_hash': plan.observationHash,
            'bayn.entry_timing.snapshot_hash': snapshot.manifest.contentHash,
            'bayn.entry_timing.input_available_at': inputAvailableAt,
          })
          if (input.portfolio.purpose === JevPurpose.Entry && plan.schemaVersion === JevBatchPlanVersion.V6)
            yield* Effect.annotateCurrentSpan('bayn.entry_timing.deterministic_selected_at', yield* currentUtcInstant)
        }),
      ),
      withObservedStage('bayn.jev.batch-plan'),
    )
    const saved = yield* evaluateJevBatch(batchPlan, observation.payload).pipe(
      Effect.catchTag('JevBatchExpired', (cause) =>
        Effect.logWarning('Jev observation expired before batch admission').pipe(
          Effect.annotateLogs({
            batchId: cause.batchId,
            cycleId: cause.cycleId,
            observedAt: cause.observedAt,
            expiresAt: cause.expiresAt,
            checkedAt: cause.checkedAt,
            admissionLagMs: Date.parse(cause.checkedAt) - Date.parse(cause.observedAt),
          }),
          Effect.andThen(
            Effect.fail(
              new JevAwaitingEvidence({
                message: 'The committed Jev observation expired before batch admission',
                readiness: DecisionReadinessReason.InferenceUnavailable,
              }),
            ),
          ),
        ),
      ),
    )
    yield* Effect.logInfo(candidateObservationLog(observation))
    const decidedAt = yield* currentUtcInstant
    if (
      saved.result === null ||
      Result.isFailure(usableJevBatchInferences(saved.plan, saved.result, Date.parse(decidedAt)))
    ) {
      // Explain verified source exclusions without reclassifying expired or corrupt evidence.
      // This remains a failed observation and cannot authorize a no-entry decision or an order.
      const sourceExclusions = batchPlan.candidates.flatMap((candidate) =>
        candidate.status === JevCandidatePlanStatus.Excluded &&
        (candidate.reason === JevSourceExclusion.NotReady || candidate.reason === JevSourceExclusion.Freshness)
          ? [{ symbol: candidate.symbol, reason: candidate.reason }]
          : [],
      )
      if (
        saved.result !== null &&
        saved.plan.batchId === batchPlan.batchId &&
        Date.parse(decidedAt) >= Date.parse(saved.result.completedAt) &&
        Date.parse(decidedAt) < Date.parse(batchPlan.expiresAt) &&
        batchPlan.candidates.every(({ status }) => status === JevCandidatePlanStatus.Excluded) &&
        sourceExclusions.length > 0 &&
        Result.isSuccess(decodeJevBatchPlan(saved.plan)) &&
        Result.isSuccess(decodeJevBatchResult(batchPlan, saved.result))
      )
        return yield* new JevAwaitingEvidence({
          message: `Jev has no inference candidate because market evidence is unavailable: ${sourceExclusions
            .map((candidate) => `${candidate.symbol} (${candidate.reason})`)
            .join(', ')}`,
          readiness: sourceExclusions.some((candidate) => candidate.reason === JevSourceExclusion.NotReady)
            ? DecisionReadinessReason.SnapshotUnavailable
            : DecisionReadinessReason.SnapshotStale,
        })
      return yield* new JevAwaitingEvidence({
        message: 'The complete committed Jev batch is not usable within its deadline',
        readiness: DecisionReadinessReason.InferenceUnavailable,
      })
    }
    return {
      snapshot,
      evidence: { observation: observation.payload, batchPlan: saved.plan, batchResult: saved.result, decidedAt },
    }
  })

export const evaluateJevObservation = (input: Parameters<typeof makeJevObservation>[0]) =>
  evaluateJevObservationFromSnapshot(input, input.snapshot.manifest.rangeEndAt, Effect.succeed(input.snapshot)).pipe(
    Effect.map(({ evidence }) => evidence),
  )

export const compileJevEntry = (
  decision: JevEntryTarget,
  decisionSnapshot: StrategyMarketSnapshot,
  pricingSnapshot: StrategyMarketSnapshot,
) =>
  Result.gen(function* () {
    const symbols = [...decision.selectedSymbols].sort()
    const planningTargetWeights = jevPlanningTargetWeights(decision)
    const quotePrices = yield* adverseQuotePrices(pricingSnapshot, symbols)
    const maximumBuyQuantityAtoms = {
      ...(yield* maximumFundedBuyQuantities({
        plans: decision.exitPolicy.plans,
        askPriceMicros: quotePrices.askPriceMicros,
        targetWeights: planningTargetWeights,
        capitalMicros: decision.evidence.observation.portfolio.brokerState.account.equityMicros,
        precision: decision.evidence.observation.protocol.executionModel.precision,
      })),
    }
    const entryQuotes: Record<string, EntryQuoteFreshness> = {}
    for (const symbol of symbols) {
      const plan = decision.exitPolicy.plans[symbol]
      const quote = pricingSnapshot.latestQuotes[symbol]
      const originalQuote = decisionSnapshot.latestQuotes[symbol]
      if (plan === undefined || quote === undefined || originalQuote === undefined)
        return yield* Result.fail(new JevContractError({ message: `Jev target ${symbol} lacks execution pricing` }))
      const exclusion = yield* jevEntryQuoteExclusion(quote)
      const originalAsk = yield* priceNumberToMicros(originalQuote.askPrice, 'ask', 'UP')
      const withinCostBound =
        BigInt(quotePrices.askPriceMicros[symbol] ?? '0') <=
        jevMaximumEntryAskMicros(decision.evidence.observation.protocol, originalAsk)
      const bid = yield* priceNumberToMicros(quote.bidPrice, 'bid', 'DOWN')
      if (exclusion !== null || !withinCostBound || bid <= BigInt(plan.levels.stopPriceMicros))
        return yield* Result.fail(
          new JevAwaitingEvidence({
            message: `Jev target ${symbol} no longer has an eligible execution quote: ${exclusion ?? 'entry cost price ceiling'}`,
            readiness: DecisionReadinessReason.NoEligibleCandidate,
          }),
        )
      entryQuotes[symbol] = {
        eventAt: quote.eventAt,
        maximumAgeMs: jevEntryQuoteMaximumAgeMs(decision, quote.eventAt, pricingSnapshot.manifest.maximumQuoteAgeMs),
      }
    }
    const dedicated = pricingSnapshot.manifest.purpose === IntradaySnapshotPurpose.EntryPricing
    return {
      decision,
      entryQuotes,
      priceMicros: quotePrices.askPriceMicros,
      ...quotePrices,
      maximumBuyQuantityAtoms,
      maximumSellQuantityAtoms: Object.fromEntries(symbols.map((symbol) => [symbol, '0'])),
      planningTargetWeights,
      decisionMarketDataRows: yield* persistIntradayRecordRows(decisionSnapshot),
      ...(dedicated
        ? {
            decisionMarketData: yield* executionMarketDataBinding(decisionSnapshot),
            executionMarketDataRows: yield* persistIntradayRecordRows(pricingSnapshot),
          }
        : {}),
      executionMarketData: yield* executionMarketDataBinding(pricingSnapshot),
    }
  })

type JevPositionManagement =
  | { readonly _tag: 'Exit'; readonly target: JevExitTarget }
  | { readonly _tag: 'Wait'; readonly details: CycleWaitingDetails }

const awaitPositionEvidence = (readiness: DecisionReadiness): JevPositionManagement => ({
  _tag: 'Wait',
  details: { readiness },
})

export const evaluateJevPositionManagement = (input: {
  readonly cycle: AutonomousCycle
  readonly entryDecisionHash: string
  readonly authorityGenerationHash: string
  readonly protocol: JevProtocol
  readonly calendar: MarketHours
  readonly brokerState: ReconciledBrokerState
  readonly marketData: IntradayMarketDataService
}) =>
  Effect.suspend(() => {
    // Per-evaluation only: failures before the validated portfolio read have no holding deadline.
    let maximumHoldDueAt: string | undefined
    let maximumHoldEvaluatedAt: string | undefined
    let maximumHoldEvidence: JevExitEvidence | undefined
    return Effect.gen(function* () {
      const store = yield* JevPositionStore
      const portfolio = yield* store.read({
        cycleId: input.cycle.identity.cycleId,
        entryDecisionHash: input.entryDecisionHash,
        brokerState: input.brokerState,
      })
      const observedAt = yield* currentUtcInstant
      const evidence = {
        cycleId: input.cycle.identity.cycleId,
        sessionDate: input.cycle.identity.executionSessionDate,
        protocol: input.protocol,
        portfolio,
        observedAt,
      }
      if (portfolio.exitRequestedAt !== null)
        return yield* Effect.fromResult(
          decideJevExit({ ...evidence, trigger: { reason: JevExitReason.ProtectionReleased } }),
        )
      const firstFill = portfolio.entryFills[0]
      const position = portfolio.brokerState.positions.find(({ quantityAtoms }) => BigInt(quantityAtoms) > 0n)
      if (firstFill === undefined || position === undefined)
        return yield* new JevContractError({ message: 'Managed position is missing its validated fill or cost basis' })
      maximumHoldDueAt = jevMaximumHoldDueAt(firstFill.occurredAt, portfolio.exitPolicy.maximumHoldingMinutes)
      maximumHoldEvaluatedAt = observedAt
      maximumHoldEvidence = { ...evidence, trigger: { reason: JevExitReason.MaximumHold } }
      if (Date.parse(observedAt) >= Date.parse(maximumHoldDueAt)) {
        if (Date.parse(observedAt) >= jevBrokerEvidenceFreshUntilMs(portfolio.brokerState)) return undefined
        return yield* Effect.fromResult(decideJevExit({ ...evidence, trigger: { reason: JevExitReason.MaximumHold } }))
      }
      const pricingBudgetMs = Math.max(
        0,
        Math.min(
          Date.parse(maximumHoldDueAt) - Date.parse(observedAt),
          input.protocol.maximumQuoteAgeMs,
          jevBrokerEvidenceFreshUntilMs(portfolio.brokerState) - Date.parse(observedAt) - 1,
        ),
      )
      return yield* Effect.gen(function* () {
        const pricingQuery = yield* Effect.fromResult(
          jevPricingQuery(
            input.cycle,
            input.protocol,
            input.calendar,
            observedAt,
            [position.symbol],
            IntradaySnapshotPurpose.Liquidation,
          ),
        )
        const pricing = yield* loadIntradaySnapshot(input.marketData, pricingQuery)
        const quote = pricing.latestQuotes[position.symbol]
        if (quote === undefined || !jevProtectiveQuoteIsFresh(quote, observedAt, input.protocol.maximumQuoteAgeMs))
          return yield* new JevAwaitingEvidence({
            message: 'Held position has no verified current quote',
            readiness: DecisionReadinessReason.SnapshotStale,
          })
        const bid = yield* Effect.fromResult(priceNumberToMicros(quote.bidPrice, 'bid', 'DOWN'))
        if (quote.bidSize <= 0)
          return yield* new JevAwaitingEvidence({
            message: 'Held position has no executable bid quantity',
            readiness: DecisionReadinessReason.SnapshotStale,
          })
        const exitPlan = yield* Effect.fromResult(jevManagedExitPlan(portfolio))
        const stopped = jevProtectiveStopCrossed(bid, exitPlan.levels)
        const reason = stopped
          ? JevExitReason.ProtectiveStop
          : (yield* Effect.fromResult(jevProfitTargetCrossed(portfolio, bid)))
            ? JevExitReason.ProfitTarget
            : undefined
        if (reason === undefined) return undefined
        const target = yield* Effect.fromResult(
          decideJevExit({
            ...evidence,
            trigger: {
              reason,
              manifest: pricing.manifest,
              rows: yield* Effect.fromResult(persistIntradayRecordRows(pricing)),
            },
          }),
        )
        yield* Effect.logInfo('Entry-bound position exit').pipe(
          Effect.annotateLogs({
            ...jevProtectiveQuoteDiagnostics(quote, jevMarketForSymbol(quote.symbol).maximumEntrySpreadBps),
            cycleId: input.cycle.identity.cycleId,
            reason,
            observedAt,
          }),
        )
        return target
      }).pipe(
        Effect.timeoutOption(Duration.millis(pricingBudgetMs)),
        Effect.flatMap((result) =>
          Option.isSome(result)
            ? Effect.succeed(result.value)
            : Effect.fail(
                new JevAwaitingEvidence({
                  message: 'Position pricing exhausted its validity window; retry with current position evidence',
                  readiness: DecisionReadinessReason.SnapshotUnavailable,
                }),
              ),
        ),
      )
    }).pipe(
      Effect.map(
        (target): JevPositionManagement =>
          target === undefined
            ? { _tag: 'Wait', details: { waitReason: 'JEV_POSITION_HELD' } }
            : { _tag: 'Exit', target },
      ),
      Effect.catchTags({
        JevAwaitingEvidence: (cause) =>
          Effect.succeed(
            awaitPositionEvidence({
              reason: cause.readiness,
              message: cause.message,
              ...(cause.availableAt === undefined ? {} : { availableAt: cause.availableAt }),
            }),
          ),
        OperationalError: (cause) =>
          isIntradaySnapshotPending(cause.cause)
            ? Effect.succeed(awaitPositionEvidence(snapshotReadiness(cause.cause)))
            : cause.retryable
              ? Effect.succeed(
                  awaitPositionEvidence({
                    reason: DecisionReadinessReason.SnapshotUnavailable,
                    message: cause.message,
                  }),
                )
              : Effect.fail(cause),
      }),
      Effect.flatMap((management) =>
        Effect.gen(function* () {
          if (
            maximumHoldDueAt === undefined ||
            maximumHoldEvidence === undefined ||
            maximumHoldEvaluatedAt === undefined
          )
            return management
          const checkedAt = yield* currentUtcInstant
          if (Date.parse(checkedAt) >= Date.parse(maximumHoldDueAt)) {
            yield* Effect.logInfo('Jev holding deadline reached').pipe(
              Effect.annotateLogs({
                cycleId: input.cycle.identity.cycleId,
                maximumHoldDueAt,
                checkedAt,
                deadlineOverrunMs: Date.parse(checkedAt) - Date.parse(maximumHoldDueAt),
                brokerEvidenceFreshUntil: utcInstantFromEpochMillis(
                  jevBrokerEvidenceFreshUntilMs(maximumHoldEvidence.portfolio.brokerState),
                ),
              }),
            )
            if (Date.parse(checkedAt) >= jevBrokerEvidenceFreshUntilMs(maximumHoldEvidence.portfolio.brokerState))
              return {
                _tag: 'Wait' as const,
                details: {
                  waitReason: 'JEV_POSITION_AWAITING_RECONCILIATION' as const,
                  maximumHoldDueAt,
                  maximumHoldEvaluatedAt,
                },
              }
            return {
              _tag: 'Exit' as const,
              target: yield* Effect.fromResult(decideJevExit({ ...maximumHoldEvidence, observedAt: checkedAt })),
            }
          }
          return management._tag === 'Wait'
            ? { ...management, details: { ...management.details, maximumHoldDueAt, maximumHoldEvaluatedAt } }
            : management
        }),
      ),
    )
  })
