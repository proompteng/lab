import type { ProtectedEntryTarget } from '../strategy/runtime-decision'
import { quantizeInstrumentPriceMicros } from '../broker/alpaca-price'
import { jevProfitTargetCrossed } from './profit-target'
import { maximumFundedBuyQuantities, maximumFundedSellQuantities } from './entry-sizing'
import { isShortExitPlan } from '../strategy/funded-exit-plan'
import { jevMaximumEntryAskMicros } from './entry-economics'
import { jevMarketForSymbol } from './markets'
import { MarketKind } from '../instruments'
import { jevMarketForCycle, jevCycleCandidates } from './markets'
import { isContinuousMarket, type MarketHours } from '../market-hours'
import {
  jevFirstSignalDueMs,
  jevSignalDueAtMs,
  jevSignalIntervalMs,
  jevSignalWindowEndMs,
  makeJevEntryQuery,
} from './observation-query'
import { Clock, Data, Duration, Effect, Option, Result } from 'effect'

import type { AutonomousCycle } from '../cycle/model'
import {
  DecisionReadinessReason,
  snapshotReadiness,
  type CycleWaitingDetails,
  type DecisionReadiness,
} from '../cycle/runner/readiness'
import {
  IntradaySnapshotPurpose,
  sameIntradaySource,
  type IntradaySnapshotQuery,
  type IntradayMarketDataService,
} from '../market-data/intraday/model'
import { isIntradaySnapshotPending } from '../market-data/intraday/pending'
import type { ReconciledBrokerState } from '../simulation-reconciliation/broker-model'
import { priceNumberToMicros } from '../strategy/execution-model/fixed-point'
import { persistIntradayRecordRows } from '../market-data/intraday/verification'
import type { StrategyMarketSnapshot } from '../market-data/streaming/snapshot'
import { CandidateObservationStore, candidateObservationLog } from '../observe-composition/candidate-observation'
import { makeOwnedJevObservation } from './observation'
import { canonicalHashV1Result } from '../hash'
import { JevInferenceWorkStore } from './inference-work'
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
  usableEntryBatchInferences,
} from './batch'
import {
  evaluateJevBatch,
  JevBatchStore,
  recoverPendingJevBatches,
  retainedJevBatchPreparation,
  type JevBatchEvaluationOptions,
} from './batch-evaluation'
import { JevContractError } from './contract'
import { JevAvailabilityReason, jevAvailabilityMessage } from './evidence'
import { jevEntryQuoteMaximumAgeMs, jevPlanningTargetWeights } from './decision'
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
import { decideJevPositionHold, type JevPositionHold } from './hold'
import { type JevProtocol } from './protocol'
import { jevEntryQuoteExclusion, jevStalePricingSymbols, prepareJevTradingSignalBatch } from './trading-signals'

export class JevAwaitingEvidence extends Data.TaggedError('JevAwaitingEvidence')<{
  readonly message: string
  readonly availableAt?: string
  readonly readiness: Exclude<DecisionReadinessReason, DecisionReadinessReason.ExecutionRiskExpired>
  readonly entryAbstention?: ProtectedEntryTarget
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
  candidates = jevCycleCandidates(cycle, protocol.candidateSymbols, protocol.marketProfiles),
): Result.Result<IntradaySnapshotQuery, JevContractError | JevAwaitingEvidence> => {
  const end = jevSignalWindowEndMs(Date.parse(observedAt), protocol)
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
        availableAt: utcInstantFromEpochMillis(jevFirstSignalDueMs(Date.parse(cycle.window.executionOpenAt), protocol)),
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
  const expectedMarket = jevMarketForCycle(cycle)
  const market = protocol.marketProfiles.find((profile) => profile.market === expectedMarket.market) ?? expectedMarket
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

export const loadNativeEntryObservation = <E, R>(
  input: Omit<Parameters<typeof makeOwnedJevObservation>[0], 'snapshot'>,
  rangeEndAt: string,
  loadSnapshot: Effect.Effect<Parameters<typeof makeOwnedJevObservation>[0]['snapshot'], E, R>,
  loadEligibility?: Effect.Effect<Parameters<typeof makeOwnedJevObservation>[0]['equityShortEligibility'], E, R>,
) =>
  Effect.gen(function* () {
    const latest = yield* (yield* CandidateObservationStore).latestJevWindowEnd({
      cycleId: input.cycleId,
      purpose: input.portfolio.purpose,
    })
    if (Option.isSome(latest) && latest.value >= rangeEndAt)
      return yield* new JevAwaitingFreshWindow({
        message: 'Jev already committed an observation for this completed signal window',
        availableAt: utcInstantFromEpochMillis(
          jevSignalDueAtMs(Date.parse(latest.value) + jevSignalIntervalMs, input.protocol),
        ),
      })
    const equityShortEligibility = loadEligibility === undefined ? input.equityShortEligibility : yield* loadEligibility
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
    const source = yield* Effect.suspend(() =>
      Effect.fromResult(
        makeOwnedJevObservation({
          ...input,
          ...(equityShortEligibility === undefined ? {} : { equityShortEligibility }),
          snapshot,
        }),
      ),
    ).pipe(withObservedStage('bayn.jev.observation'))
    return {
      snapshot: source.verified.snapshot,
      observation: { payload: source.payload, contentHash: source.verified.contentHash },
      source,
      inputAvailableAt,
    }
  })

// Admit the durable decision window before materializing expensive signal history.
// The supplied effect stays lazy; position protection is evaluated by the caller first.
export const evaluateJevObservationFromSnapshot = <E, R>(
  input: Omit<Parameters<typeof makeOwnedJevObservation>[0], 'snapshot'>,
  rangeEndAt: string,
  loadSnapshot: Effect.Effect<Parameters<typeof makeOwnedJevObservation>[0]['snapshot'], E, R>,
  planVersion: JevBatchPlanVersion,
  options: JevBatchEvaluationOptions = {},
  loadEligibility?: Effect.Effect<Parameters<typeof makeOwnedJevObservation>[0]['equityShortEligibility'], E, R>,
) =>
  Effect.gen(function* () {
    const { snapshot, observation, batchPlan, saved, preparation } = yield* Effect.gen(function* () {
      const deferred = yield* Effect.serviceOption(JevInferenceWorkStore)
      if (Option.isSome(deferred)) {
        const resumed = yield* deferred.value.resume(input.cycleId, input.authorityGenerationHash)
        if (resumed !== null) {
          const batches = yield* JevBatchStore
          const retained = yield* batches.read(resumed.batchId)
          const preparation = retained === null ? undefined : retainedJevBatchPreparation(retained)
          const original =
            preparation === undefined
              ? yield* resumed.loadSource
              : {
                  observation: preparation.source.payload,
                  snapshot: preparation.source.verified.snapshot,
                  contentHash: preparation.source.verified.contentHash,
                }
          if (
            retained === null ||
            retained.result === null ||
            retained.plan.batchId !== resumed.batchId ||
            retained.plan.cycleId !== input.cycleId ||
            retained.plan.authorityGenerationHash !== input.authorityGenerationHash ||
            retained.plan.schemaVersion !== planVersion ||
            retained.plan.protocolHash !== (yield* Effect.fromResult(canonicalHashV1Result(input.protocol))) ||
            retained.plan.observationHash !== original.contentHash ||
            original.snapshot.manifest.rangeEndAt > rangeEndAt ||
            (yield* Clock.currentTimeMillis) >= Date.parse(retained.plan.expiresAt) ||
            (options.admissionDeadlineAt !== undefined &&
              (yield* Clock.currentTimeMillis) >= options.admissionDeadlineAt)
          )
            return yield* new JevAwaitingEvidence({
              message: 'Completed Jev inference no longer matches the current admission',
              readiness: DecisionReadinessReason.InferenceExpired,
            })
          return {
            snapshot: original.snapshot,
            observation: { payload: original.observation, contentHash: original.contentHash },
            batchPlan: retained.plan,
            saved: retained,
            preparation,
          }
        }
      }
      const pending = yield* recoverPendingJevBatches(input.cycleId, input.authorityGenerationHash)
      if (pending.length > 0)
        return yield* new JevAwaitingEvidence({
          message: 'A committed Jev batch still awaits its original deadline',
          availableAt: utcInstantFromEpochMillis(
            pending.reduce(
              (earliest, plan) => Math.min(earliest, Date.parse(plan.expiresAt)),
              options.admissionDeadlineAt ?? Number.POSITIVE_INFINITY,
            ),
          ),
          readiness: DecisionReadinessReason.DecisionPending,
        })
      const beforeSourceAt = yield* Clock.currentTimeMillis
      if (options.admissionDeadlineAt !== undefined && beforeSourceAt >= options.admissionDeadlineAt)
        return yield* new JevAwaitingEvidence({
          message: 'Entry admission expired before Jev observation dispatch',
          readiness: DecisionReadinessReason.DecisionPending,
        })
      // A nearly spent lease must leave the next minute unconsumed for its successor.
      // Existing admitted work above retains its original, possibly shorter remaining lifetime.
      if (
        options.admissionDeadlineAt !== undefined &&
        beforeSourceAt + input.protocol.inferenceValidityMs > options.admissionDeadlineAt
      )
        return yield* new JevAwaitingEvidence({
          message: 'Entry admission cannot cover the original inference interval; awaiting its successor',
          readiness: DecisionReadinessReason.DecisionPending,
          availableAt: utcInstantFromEpochMillis(options.admissionDeadlineAt),
        })
      const { snapshot, observation, source, inputAvailableAt } = yield* loadNativeEntryObservation(
        input,
        rangeEndAt,
        loadSnapshot,
        loadEligibility,
      )
      if (options.admissionDeadlineAt !== undefined && (yield* Clock.currentTimeMillis) >= options.admissionDeadlineAt)
        return yield* new JevAwaitingEvidence({
          message: 'Entry admission expired before Jev batch admission',
          readiness: DecisionReadinessReason.DecisionPending,
        })
      const inferenceExpiresAt = Date.parse(observation.payload.observedAt) + input.protocol.inferenceValidityMs
      if (options.admissionDeadlineAt !== undefined && inferenceExpiresAt > options.admissionDeadlineAt)
        return yield* new JevAwaitingEvidence({
          message: 'Entry admission cannot cover the original inference interval; awaiting its successor',
          readiness: DecisionReadinessReason.DecisionPending,
          availableAt: utcInstantFromEpochMillis(options.admissionDeadlineAt),
        })
      const batch = yield* Effect.suspend(() =>
        Effect.fromResult(
          prepareJevTradingSignalBatch(source, utcInstantFromEpochMillis(inferenceExpiresAt), planVersion),
        ),
      ).pipe(
        Effect.tap(({ plan }) =>
          Effect.gen(function* () {
            yield* Effect.annotateCurrentSpan({
              'bayn.entry_timing.batch_id': plan.batchId,
              'bayn.entry_timing.observation_hash': plan.observationHash,
              'bayn.entry_timing.snapshot_hash': snapshot.manifest.contentHash,
              'bayn.entry_timing.input_available_at': inputAvailableAt,
            })
            if (
              input.portfolio.purpose === JevPurpose.Entry &&
              (plan.schemaVersion === JevBatchPlanVersion.V8 || plan.schemaVersion === JevBatchPlanVersion.Ablation)
            )
              yield* Effect.annotateCurrentSpan('bayn.entry_timing.deterministic_selected_at', yield* currentUtcInstant)
          }),
        ),
        withObservedStage('bayn.jev.batch-plan'),
      )
      if (options.admissionDeadlineAt !== undefined && (yield* Clock.currentTimeMillis) >= options.admissionDeadlineAt)
        return yield* new JevAwaitingEvidence({
          message: 'Entry admission expired before Jev provider dispatch',
          readiness: DecisionReadinessReason.DecisionPending,
        })
      const saved = yield* evaluateJevBatch(batch, options).pipe(
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
                  readiness: DecisionReadinessReason.InferenceExpired,
                }),
              ),
            ),
          ),
        ),
      )
      return { snapshot, observation, batchPlan: batch.plan, saved, preparation: undefined }
    })
    yield* Effect.logInfo(candidateObservationLog(observation))
    const decidedAt = yield* currentUtcInstant
    const decidedAtMs = Date.parse(decidedAt)
    const batchExpiresAtMs = Date.parse(saved.plan.expiresAt)
    if (saved.result === null) {
      const deadlineMs = Math.min(batchExpiresAtMs, options.admissionDeadlineAt ?? batchExpiresAtMs)
      if (Date.parse(saved.plan.observedAt) <= decidedAtMs && decidedAtMs < deadlineMs)
        return yield* new JevAwaitingEvidence({
          message: 'Jev batch is awaiting its durable result',
          availableAt: utcInstantFromEpochMillis(deadlineMs),
          readiness: DecisionReadinessReason.DecisionPending,
        })
      return yield* new JevAwaitingEvidence({
        message: jevAvailabilityMessage(JevAvailabilityReason.NotCommitted),
        readiness:
          decidedAtMs >= deadlineMs
            ? DecisionReadinessReason.InferenceExpired
            : DecisionReadinessReason.InferenceUnavailable,
      })
    }
    const availability = usableEntryBatchInferences(saved.plan, saved.result, decidedAtMs, planVersion)
    if (Result.isFailure(availability)) {
      // Explain verified source exclusions without reclassifying expired or corrupt evidence.
      // This remains a failed observation and cannot authorize a no-entry decision or an order.
      const sourceExclusions = batchPlan.candidates.flatMap((candidate) =>
        candidate.status === JevCandidatePlanStatus.Excluded &&
        (candidate.reason === JevSourceExclusion.NotReady || candidate.reason === JevSourceExclusion.Freshness)
          ? [{ symbol: candidate.symbol, reason: candidate.reason }]
          : [],
      )
      if (
        saved.plan.batchId === batchPlan.batchId &&
        decidedAtMs >= Date.parse(saved.result.completedAt) &&
        decidedAtMs < batchExpiresAtMs &&
        batchPlan.candidates.every(({ status }) => status === JevCandidatePlanStatus.Excluded) &&
        sourceExclusions.length > 0 &&
        Result.isSuccess(decodeJevBatchPlan(saved.plan)) &&
        Result.isSuccess(decodeJevBatchResult(batchPlan, saved.result))
      )
        return yield* new JevAwaitingEvidence({
          message: `Jev has no inference candidate because market evidence is unavailable: ${sourceExclusions
            .map((candidate) => `${candidate.symbol} (${candidate.reason})`)
            .join(', ')}`,
          availableAt: utcInstantFromEpochMillis(
            jevSignalDueAtMs(Date.parse(rangeEndAt) + jevSignalIntervalMs, input.protocol),
          ),
          readiness: sourceExclusions.some((candidate) => candidate.reason === JevSourceExclusion.NotReady)
            ? DecisionReadinessReason.SnapshotUnavailable
            : DecisionReadinessReason.SnapshotStale,
        })
      const reason =
        availability.failure._tag === 'JevEvidenceError'
          ? (availability.failure.availabilityReason ?? JevAvailabilityReason.InvalidEvidence)
          : JevAvailabilityReason.InvalidEvidence
      return yield* new JevAwaitingEvidence({
        message: jevAvailabilityMessage(reason),
        readiness:
          reason === JevAvailabilityReason.OutsideValidityWindow &&
          decidedAtMs >= Date.parse(saved.result.completedAt) &&
          decidedAtMs >= batchExpiresAtMs
            ? DecisionReadinessReason.InferenceExpired
            : DecisionReadinessReason.InferenceUnavailable,
      })
    }
    return {
      snapshot,
      evidence: { observation: observation.payload, batchPlan: saved.plan, batchResult: saved.result, decidedAt },
      preparation,
    }
  })

export const evaluateJevObservation = (input: Parameters<typeof makeOwnedJevObservation>[0]) =>
  evaluateJevObservationFromSnapshot(
    input,
    input.snapshot.manifest.rangeEndAt,
    Effect.succeed(input.snapshot),
    JevBatchPlanVersion.V8,
  ).pipe(Effect.map(({ evidence }) => evidence))

export const compileJevEntry = (
  decision: ProtectedEntryTarget,
  decisionSnapshot: StrategyMarketSnapshot,
  pricingSnapshot: StrategyMarketSnapshot,
) =>
  Result.gen(function* () {
    if (!sameIntradaySource(decisionSnapshot.manifest, pricingSnapshot.manifest))
      return yield* Result.fail(
        new JevContractError({ message: 'Entry pricing must use the same market source as its signal' }),
      )
    const symbols = [...decision.selectedSymbols].sort()
    const planningTargetWeights = jevPlanningTargetWeights(decision)
    const isIntradayAlpha = decision.schemaVersion === 'bayn.intraday-alpha-target.v2'
    const quotePrices = isIntradayAlpha
      ? yield* Result.gen(function* () {
          const expectedBarMs = Date.parse(decisionSnapshot.manifest.rangeEndAt) - 60_000
          const bidPriceMicros: Record<string, string> = {}
          const askPriceMicros: Record<string, string> = {}
          for (const symbol of symbols) {
            const bar = decisionSnapshot.bars.find(
              (entry) => entry.symbol === symbol && Date.parse(entry.eventAt) === expectedBarMs,
            )
            if (bar === undefined || !Number.isFinite(bar.close) || bar.close <= 0) {
              return yield* Result.fail(
                new JevContractError({ message: `Intraday alpha target ${symbol} lacks completed bar close` }),
              )
            }
            const down = quantizeInstrumentPriceMicros(
              symbol,
              yield* priceNumberToMicros(bar.close, `bar close for ${symbol}`, 'DOWN'),
              'DOWN',
            )
            const up = quantizeInstrumentPriceMicros(
              symbol,
              yield* priceNumberToMicros(bar.close, `bar close for ${symbol}`, 'UP'),
              'UP',
            )
            if (down <= 0n || up <= 0n) {
              return yield* Result.fail(
                new JevContractError({
                  message: `Intraday alpha bar close for ${symbol} is outside exact price domain`,
                }),
              )
            }
            bidPriceMicros[symbol] = down.toString()
            askPriceMicros[symbol] = up.toString()
          }
          return {
            bidPriceMicros: Object.freeze(bidPriceMicros),
            askPriceMicros: Object.freeze(askPriceMicros),
          }
        })
      : yield* adverseQuotePrices(pricingSnapshot, symbols)
    const maximumBuyQuantityAtoms = {
      ...(yield* maximumFundedBuyQuantities({
        plans: decision.exitPolicy.plans,
        askPriceMicros: quotePrices.askPriceMicros,
        targetWeights: Object.fromEntries(
          Object.entries(planningTargetWeights).map(([symbol, weight]) => [symbol, Math.max(0, weight)]),
        ),
        capitalMicros: decision.evidence.observation.portfolio.brokerState.account.equityMicros,
        precision: decision.evidence.observation.protocol.executionModel.precision,
      })),
    }
    const maximumSellQuantityAtoms = yield* maximumFundedSellQuantities({
      bidPriceMicros: quotePrices.bidPriceMicros,
      bidSize: Object.fromEntries(
        symbols.map((symbol) => [symbol, pricingSnapshot.latestQuotes[symbol]?.bidSize ?? 0]),
      ),
      targetWeights: planningTargetWeights,
      capitalMicros: decision.evidence.observation.portfolio.brokerState.account.equityMicros,
      precision: decision.evidence.observation.protocol.executionModel.precision,
      plans: decision.exitPolicy.plans,
      ...(isIntradayAlpha ? { ignoreDisplayedBidSize: true } : {}),
    })
    const entryQuotes: Record<string, EntryQuoteFreshness> = {}
    for (const symbol of symbols) {
      const plan = decision.exitPolicy.plans[symbol]
      const quote = pricingSnapshot.latestQuotes[symbol]
      const originalQuote = decisionSnapshot.latestQuotes[symbol]
      if (plan === undefined || quote === undefined || originalQuote === undefined)
        return yield* Result.fail(new JevContractError({ message: `Jev target ${symbol} lacks execution pricing` }))
      const maximumAgeMs = jevEntryQuoteMaximumAgeMs(
        decision,
        quote.eventAt,
        pricingSnapshot.manifest.maximumQuoteAgeMs,
      )
      if (
        pricingSnapshot.manifest.purpose === IntradaySnapshotPurpose.EntryPricing &&
        !jevProtectiveQuoteIsFresh(quote, pricingSnapshot.manifest.observedAt, maximumAgeMs)
      )
        return yield* Result.fail(
          new JevAwaitingEvidence({
            message: `Jev target ${symbol} has no fresh execution quote`,
            readiness: DecisionReadinessReason.SnapshotStale,
          }),
        )
      const short = isShortExitPlan(plan)
      const bid = yield* priceNumberToMicros(quote.bidPrice, 'bid', 'DOWN')
      const ask = yield* priceNumberToMicros(quote.askPrice, 'ask', 'UP')
      let ineligibleReason: string | null = null
      if (isIntradayAlpha) {
        // Bar-close-anchored limits execute against consolidated NBBO; ignore wide single-exchange IEX
        // spreads and only reject when both positive sides of the live quote cross the stop or target.
        const stopMicros = BigInt(plan.levels.stopPriceMicros)
        const targetMicros = BigInt(plan.levels.profitLimitPriceMicros)
        const twoSided = bid > 0n && ask > 0n
        if (twoSided && (short ? bid >= stopMicros && ask >= stopMicros : bid <= stopMicros && ask <= stopMicros)) {
          ineligibleReason = 'protective stop crossed'
        } else if (
          twoSided &&
          (short ? bid <= targetMicros && ask <= targetMicros : bid >= targetMicros && ask >= targetMicros)
        ) {
          ineligibleReason = 'profit target already reached'
        }
      } else {
        const exclusion = yield* jevEntryQuoteExclusion(quote)
        const originalAsk = yield* priceNumberToMicros(originalQuote.askPrice, 'ask', 'UP')
        const withinCostBound =
          BigInt(quotePrices.askPriceMicros[symbol] ?? '0') <=
          jevMaximumEntryAskMicros(decision.evidence.observation.protocol, symbol, originalAsk)
        const requiresMarketableLimit = jevMarketForSymbol(symbol).market === MarketKind.Crypto
        ineligibleReason =
          exclusion ??
          (requiresMarketableLimit && !withinCostBound
            ? 'entry cost price ceiling'
            : (short ? ask >= BigInt(plan.levels.stopPriceMicros) : bid <= BigInt(plan.levels.stopPriceMicros))
              ? 'protective stop crossed'
              : (
                    short
                      ? ask <= BigInt(plan.levels.profitLimitPriceMicros)
                      : bid >= BigInt(plan.levels.profitLimitPriceMicros)
                  )
                ? 'profit target already reached'
                : null)
      }
      if (ineligibleReason !== null)
        return yield* Result.fail(
          new JevAwaitingEvidence({
            message: `Jev target ${symbol} no longer has an eligible execution quote: ${ineligibleReason}`,
            readiness: DecisionReadinessReason.NoEligibleCandidate,
          }),
        )
      entryQuotes[symbol] = {
        eventAt: quote.eventAt,
        maximumAgeMs,
      }
    }
    const dedicated = pricingSnapshot.manifest.purpose === IntradaySnapshotPurpose.EntryPricing
    return {
      decision,
      entryQuotes,
      priceMicros: quotePrices.askPriceMicros,
      ...quotePrices,
      maximumBuyQuantityAtoms,
      maximumSellQuantityAtoms,
      planningTargetWeights,
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
  readonly symbol?: string
}) =>
  Effect.suspend(() => {
    // Per-evaluation only: failures before the validated portfolio read have no holding deadline.
    let maximumHoldDueAt: string | undefined
    let maximumHoldEvaluatedAt: string | undefined
    let maximumHoldEvidence: JevExitEvidence | undefined
    let positionHold: JevPositionHold | undefined
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
        ...(input.symbol === undefined ? {} : { symbol: input.symbol }),
      }
      if (portfolio.exitRequestedAt !== null)
        return yield* Effect.fromResult(
          decideJevExit({ ...evidence, trigger: { reason: JevExitReason.ProtectionReleased } }),
        )
      const position =
        input.symbol === undefined
          ? (portfolio.brokerState.positions.find(
              (entry) => BigInt(entry.quantityAtoms) !== 0n && entry.symbol in portfolio.exitPolicy.plans,
            ) ?? portfolio.brokerState.positions.find(({ quantityAtoms }) => BigInt(quantityAtoms) !== 0n))
          : portfolio.brokerState.positions.find(
              (entry) => entry.symbol === input.symbol && BigInt(entry.quantityAtoms) !== 0n,
            )
      const firstFill =
        position === undefined
          ? undefined
          : (portfolio.entryFills.find((fill) => fill.symbol === position.symbol) ?? portfolio.entryFills[0])
      if (firstFill === undefined || position === undefined)
        return yield* new JevContractError({ message: 'Managed position is missing its validated fill or cost basis' })
      const exitPlan = yield* Effect.fromResult(jevManagedExitPlan(portfolio, position.symbol))
      maximumHoldDueAt = jevMaximumHoldDueAt(firstFill.occurredAt, exitPlan.levels.maximumHoldingMinutes)
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
        const short = isShortExitPlan(exitPlan)
        const bid = yield* Effect.fromResult(
          priceNumberToMicros(short ? quote.askPrice : quote.bidPrice, short ? 'ask' : 'bid', short ? 'UP' : 'DOWN'),
        )
        if (short ? quote.askSize <= 0 : quote.bidSize <= 0)
          return yield* new JevAwaitingEvidence({
            message: 'Held position has no executable bid quantity',
            readiness: DecisionReadinessReason.SnapshotStale,
          })
        const stopped = jevProtectiveStopCrossed(bid, exitPlan.levels)
        const reason = stopped
          ? JevExitReason.ProtectiveStop
          : (yield* Effect.fromResult(jevProfitTargetCrossed(portfolio, bid, position.symbol)))
            ? JevExitReason.ProfitTarget
            : undefined
        if (reason === undefined) {
          positionHold = yield* Effect.fromResult(
            decideJevPositionHold({
              ...evidence,
              authorityGenerationHash: input.authorityGenerationHash,
              source: {
                manifest: pricing.manifest,
                rows: yield* Effect.fromResult(persistIntradayRecordRows(pricing)),
              },
            }),
          )
          return undefined
        }
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
            ? {
                _tag: 'Wait',
                details: { waitReason: 'JEV_POSITION_HELD', ...(positionHold === undefined ? {} : { positionHold }) },
              }
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
