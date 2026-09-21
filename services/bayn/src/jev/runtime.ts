import { Data, Effect, Option, Result } from 'effect'

import type { MarketCalendarObservation } from '../broker/alpaca'
import type { AutonomousCycle } from '../cycle'
import { DecisionReadinessReason } from '../cycle/runner/readiness'
import { IntradaySnapshotPurpose, type IntradaySnapshotQuery, type IntradayMarketDataService } from '../market-data'
import { isIntradaySnapshotPending } from '../market-data/intraday/pending'
import type { ReconciledBrokerState } from '../reconciliation'
import { numberToMicros } from '../strategy/execution-model/fixed-point'
import { persistIntradayRecordRows } from '../market-data/intraday/verification'
import type { StrategyMarketSnapshot } from '../market-data/streaming/snapshot'
import { CandidateObservationStore, recordJevObservation } from '../observe-composition/candidate-observation'
import {
  adverseQuotePrices,
  executionMarketDataBinding,
  maximumBuyQuantities,
  loadIntradaySnapshot,
} from '../observe-composition/intraday-market-data'
import type { EntryQuoteFreshness } from '../risk'
import { currentUtcInstant, utcInstantFromEpochMillis } from '../time'
import { JevCandidateResultStatus } from './batch'
import { evaluateJevBatch, recoverPendingJevBatches } from './batch-evaluation'
import { JevContractError } from './contract'
import {
  decideJevManagement,
  JevManagementAction,
  jevEntryQuoteMaximumAgeMs,
  jevPlanningTargetWeights,
  type JevEntryTarget,
} from './decision'
import { decideJevExit, jevProtectiveQuoteIsFresh, jevProtectiveStopCrossed, JevExitReason } from './exit'
import { JevPositionStore } from './portfolio'
import { JevOutcome } from './evidence'
import { JevResolutionStatus } from './resolution'
import { jevSnapshotSymbols, type JevProtocol } from './protocol'
import { jevStalePricingSymbols, makeJevTradingSignalBatch } from './trading-signals'

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
  calendar: MarketCalendarObservation,
  observedAt: string,
  candidates = protocol.candidateSymbols,
): Result.Result<IntradaySnapshotQuery, JevContractError | JevAwaitingEvidence> => {
  const end = Math.floor((Date.parse(observedAt) - protocol.decisionDelaySeconds * 1000) / 60_000) * 60_000
  const start = end - protocol.lookbackMinutes * 60_000
  if (
    cycle.identity.strategyName !== 'jev' ||
    cycle.schemaVersion !== 'bayn.autonomous-cycle.v4' ||
    observedAt < cycle.window.submissionOpenAt ||
    observedAt >= cycle.window.submissionCutoffAt
  )
    return Result.fail(new JevContractError({ message: 'Jev observation is outside its native entry cycle' }))
  if (start < Date.parse(cycle.window.executionOpenAt))
    return Result.fail(
      new JevAwaitingEvidence({
        message: 'Jev is waiting for its complete rolling signal window',
        readiness: DecisionReadinessReason.LookbackWarmup,
        availableAt: utcInstantFromEpochMillis(
          Date.parse(cycle.window.executionOpenAt) +
            protocol.lookbackMinutes * 60_000 +
            protocol.decisionDelaySeconds * 1000,
        ),
      }),
    )
  return Result.succeed({
    sessionDate: cycle.identity.executionSessionDate,
    calendar,
    observedAt,
    rangeStartAt: utcInstantFromEpochMillis(start),
    rangeEndAt: utcInstantFromEpochMillis(end),
    universeId: protocol.universeId,
    universeSymbolHash: protocol.universeSymbolHash,
    universe: protocol.universe,
    symbols: jevSnapshotSymbols(protocol, candidates),
    candidateSymbols: candidates,
    feed: protocol.feed,
    delayClass: protocol.delayClass,
    sourceTopics: protocol.sourceTopics,
    maximumQuoteAgeMs: protocol.maximumQuoteAgeMs,
    minimumWatermarkLagMs: protocol.decisionDelaySeconds * 1000,
  })
}

export const jevPricingQuery = (
  cycle: Pick<AutonomousCycle, 'identity' | 'window'>,
  protocol: JevProtocol,
  calendar: MarketCalendarObservation,
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
    start < Date.parse(cycle.window.executionOpenAt) ||
    end >= Date.parse(cycle.window.executionCloseAt) ||
    Date.parse(observedAt) <= end
  )
    return Result.fail(
      new JevContractError({
        message: 'Jev pricing requires a completed minute, native cycle and canonical universe symbols',
      }),
    )
  return Result.succeed({
    sessionDate: cycle.identity.executionSessionDate,
    calendar,
    observedAt,
    purpose,
    rangeStartAt: utcInstantFromEpochMillis(start),
    rangeEndAt: utcInstantFromEpochMillis(end),
    universeId: protocol.universeId,
    universeSymbolHash: protocol.universeSymbolHash,
    universe: protocol.universe,
    symbols: [...symbols].sort(),
    feed: protocol.feed,
    delayClass: protocol.delayClass,
    sourceTopics: protocol.sourceTopics,
    maximumQuoteAgeMs: protocol.maximumQuoteAgeMs,
    minimumWatermarkLagMs: 0,
  })
}

export const evaluateJevObservation = (input: Parameters<typeof recordJevObservation>[0]) =>
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
    if (Option.isSome(latest) && latest.value >= input.snapshot.manifest.rangeEndAt)
      return yield* new JevAwaitingFreshWindow({
        message: 'Jev already committed an observation for this completed signal window',
        availableAt: utcInstantFromEpochMillis(
          Date.parse(latest.value) + 60_000 + input.protocol.decisionDelaySeconds * 1000,
        ),
      })
    const staleSymbols = jevStalePricingSymbols(input.snapshot)
    if (staleSymbols.length > 0)
      return yield* new JevAwaitingEvidence({
        message: `Jev is waiting for fresh signal pricing for ${staleSymbols.join(', ')}`,
        readiness: DecisionReadinessReason.SnapshotStale,
      })
    const observation = yield* recordJevObservation(input)
    const batchPlan = yield* Effect.fromResult(
      makeJevTradingSignalBatch({
        observation: observation.payload,
        expiresAt: utcInstantFromEpochMillis(
          Date.parse(observation.payload.observedAt) + input.protocol.inferenceValidityMs,
        ),
      }),
    )
    const saved = yield* evaluateJevBatch(batchPlan)
    const decidedAt = yield* currentUtcInstant
    if (
      saved.result === null ||
      decidedAt >= batchPlan.expiresAt ||
      saved.result.candidates.some(
        (candidate) =>
          candidate.status !== JevCandidateResultStatus.Excluded &&
          (candidate.status !== JevCandidateResultStatus.Resolved ||
            candidate.resolution.status !== JevResolutionStatus.Recorded ||
            candidate.receipt?.outcome.status !== JevOutcome.Received),
      )
    )
      return yield* new JevAwaitingEvidence({
        message: 'The complete committed Jev batch is not usable within its deadline',
        readiness: DecisionReadinessReason.InferenceUnavailable,
      })
    return { observation: observation.payload, batchPlan: saved.plan, batchResult: saved.result, decidedAt }
  })

export const compileJevEntry = (
  decision: JevEntryTarget,
  decisionSnapshot: StrategyMarketSnapshot,
  pricingSnapshot: StrategyMarketSnapshot,
) =>
  Result.gen(function* () {
    const symbols = [...decision.selectedSymbols].sort()
    const planningTargetWeights = jevPlanningTargetWeights(decision)
    const quotePrices = yield* adverseQuotePrices(pricingSnapshot, symbols)
    const maximumBuyQuantityMicros = yield* maximumBuyQuantities(pricingSnapshot, planningTargetWeights)
    const entryQuotes: Record<string, EntryQuoteFreshness> = {}
    for (const symbol of symbols) {
      const quote = pricingSnapshot.latestQuotes[symbol]
      if (quote === undefined)
        return yield* Result.fail(new JevContractError({ message: `Jev target ${symbol} lacks execution pricing` }))
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
      maximumBuyQuantityMicros,
      maximumSellQuantityMicros: Object.fromEntries(symbols.map((symbol) => [symbol, '0'])),
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

export const evaluateJevPositionExit = (input: {
  readonly cycle: AutonomousCycle
  readonly entryDecisionHash: string
  readonly authorityGenerationHash: string
  readonly protocol: JevProtocol
  readonly calendar: MarketCalendarObservation
  readonly brokerState: ReconciledBrokerState
  readonly marketData: IntradayMarketDataService
}) =>
  Effect.gen(function* () {
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
    const firstFill = portfolio.entryFills[0]
    const position = portfolio.brokerState.positions.find(({ quantityMicros }) => BigInt(quantityMicros) > 0n)
    if (firstFill === undefined || position?.schemaVersion !== 'bayn.position.v2')
      return yield* new JevContractError({ message: 'Managed position is missing its validated fill or cost basis' })
    if (Date.parse(observedAt) >= Date.parse(firstFill.occurredAt) + input.protocol.maximumHoldingMinutes * 60_000)
      return yield* Effect.fromResult(decideJevExit({ ...evidence, trigger: { reason: JevExitReason.MaximumHold } }))
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
    const bid = yield* Effect.fromResult(numberToMicros(quote.bidPrice))
    if (
      quote.bidSize > 0 &&
      jevProtectiveStopCrossed(
        BigInt(position.costBasisMicros),
        BigInt(position.quantityMicros),
        bid,
        input.protocol.protectiveStopBps,
      )
    )
      return yield* Effect.fromResult(
        decideJevExit({
          ...evidence,
          trigger: {
            reason: JevExitReason.ProtectiveStop,
            manifest: pricing.manifest,
            rows: yield* Effect.fromResult(persistIntradayRecordRows(pricing)),
          },
        }),
      )
    const query = yield* Effect.fromResult(
      jevObservationQuery(input.cycle, input.protocol, input.calendar, observedAt, [position.symbol]),
    )
    const snapshot = yield* loadIntradaySnapshot(input.marketData, query)
    const inference = yield* evaluateJevObservation({
      cycleId: input.cycle.identity.cycleId,
      authorityGenerationHash: input.authorityGenerationHash,
      protocol: input.protocol,
      portfolio,
      snapshot,
    })
    if (inference.decidedAt >= input.cycle.window.submissionCutoffAt) return undefined
    const decision = yield* Effect.fromResult(decideJevManagement(inference))
    return decision.action === JevManagementAction.Exit
      ? yield* Effect.fromResult(
          decideJevExit({
            ...evidence,
            observedAt: inference.decidedAt,
            trigger: { reason: JevExitReason.Model, decision },
          }),
        )
      : undefined
  }).pipe(
    Effect.catchTags({
      JevAwaitingEvidence: () => Effect.void,
      JevAwaitingFreshWindow: () => Effect.void,
      OperationalError: (cause) =>
        isIntradaySnapshotPending(cause.cause) || cause.retryable ? Effect.void : Effect.fail(cause),
    }),
  )
