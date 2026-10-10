import { Data, Duration, Effect, Option, Result } from 'effect'

import type { MarketCalendarObservation } from '../broker/alpaca'
import type { AutonomousCycle } from '../cycle'
import {
  DecisionReadinessReason,
  snapshotReadiness,
  type CycleWaitingDetails,
  type DecisionReadiness,
} from '../cycle/runner/readiness'
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
import { withObservedStage } from '../telemetry'
import { JevBatchPlanVersion, usableJevBatchInferences } from './batch'
import { evaluateJevBatch, recoverPendingJevBatches } from './batch-evaluation'
import { JevContractError } from './contract'
import {
  decideJevManagement,
  JevManagementAction,
  jevEntryQuoteMaximumAgeMs,
  jevPlanningTargetWeights,
  type JevEntryTarget,
} from './decision'
import {
  decideJevExit,
  jevMaximumHoldDueAt,
  jevProtectiveQuoteIsFresh,
  jevProtectiveStopCrossed,
  JevExitReason,
  type JevExitTarget,
} from './exit'
import { JevPositionStore } from './portfolio'
import { jevProtectiveQuoteDiagnostics } from './quote-diagnostics'
import { jevSnapshotSymbols, type JevProtocol } from './protocol'
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
    ...(protocol.candidateEvidencePolicy === undefined
      ? {}
      : { candidateEvidencePolicy: protocol.candidateEvidencePolicy }),
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

// Admit the durable decision window before materializing expensive signal history.
// The supplied effect stays lazy; position protection is evaluated by the caller first.
export const evaluateJevObservationFromSnapshot = <E, R>(
  input: Omit<Parameters<typeof recordJevObservation>[0], 'snapshot'>,
  rangeEndAt: string,
  loadSnapshot: Effect.Effect<Parameters<typeof recordJevObservation>[0]['snapshot'], E, R>,
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
    const observation = yield* recordJevObservation({ ...input, snapshot })
    const batchPlan = yield* Effect.suspend(() =>
      Effect.fromResult(
        makeJevTradingSignalBatch({
          observation: observation.payload,
          expiresAt: utcInstantFromEpochMillis(
            Date.parse(observation.payload.observedAt) + input.protocol.inferenceValidityMs,
          ),
          planVersion:
            input.protocol.schemaVersion === 'bayn.jev.protocol.v2' ? JevBatchPlanVersion.V4 : JevBatchPlanVersion.V3,
        }),
      ),
    ).pipe(withObservedStage('bayn.jev.batch-plan'))
    const saved = yield* evaluateJevBatch(batchPlan).pipe(
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
    const decidedAt = yield* currentUtcInstant
    if (
      saved.result === null ||
      Result.isFailure(usableJevBatchInferences(saved.plan, saved.result, Date.parse(decidedAt)))
    )
      return yield* new JevAwaitingEvidence({
        message: 'The complete committed Jev batch is not usable within its deadline',
        readiness: DecisionReadinessReason.InferenceUnavailable,
      })
    return {
      snapshot,
      evidence: { observation: observation.payload, batchPlan: saved.plan, batchResult: saved.result, decidedAt },
    }
  })

export const evaluateJevObservation = (input: Parameters<typeof recordJevObservation>[0]) =>
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
    const maximumBuyQuantityMicros = yield* maximumBuyQuantities(pricingSnapshot, planningTargetWeights)
    const entryQuotes: Record<string, EntryQuoteFreshness> = {}
    for (const symbol of symbols) {
      const quote = pricingSnapshot.latestQuotes[symbol]
      if (quote === undefined)
        return yield* Result.fail(new JevContractError({ message: `Jev target ${symbol} lacks execution pricing` }))
      const exclusion = yield* jevEntryQuoteExclusion(quote, decision.evidence.observation.protocol.maximumSpreadBps)
      if (exclusion !== null)
        return yield* Result.fail(
          new JevAwaitingEvidence({
            message: `Jev target ${symbol} no longer has an eligible execution quote: ${exclusion}`,
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
  readonly calendar: MarketCalendarObservation
  readonly brokerState: ReconciledBrokerState
  readonly marketData: IntradayMarketDataService
}) =>
  Effect.suspend(() => {
    // Per-evaluation only: failures before the validated portfolio read have no holding deadline.
    let maximumHoldDueAt: string | undefined
    let maximumHoldEvaluatedAt: string | undefined
    let maximumHoldEvidence: Parameters<typeof decideJevExit>[0] | undefined
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
      const firstFill = portfolio.entryFills[0]
      const position = portfolio.brokerState.positions.find(({ quantityMicros }) => BigInt(quantityMicros) > 0n)
      if (firstFill === undefined || position?.schemaVersion !== 'bayn.position.v2')
        return yield* new JevContractError({ message: 'Managed position is missing its validated fill or cost basis' })
      maximumHoldDueAt = jevMaximumHoldDueAt(firstFill.occurredAt, input.protocol.maximumHoldingMinutes)
      maximumHoldEvaluatedAt = observedAt
      maximumHoldEvidence = { ...evidence, trigger: { reason: JevExitReason.MaximumHold } }
      if (Date.parse(observedAt) >= Date.parse(maximumHoldDueAt))
        return yield* Effect.fromResult(decideJevExit({ ...evidence, trigger: { reason: JevExitReason.MaximumHold } }))
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
        const bid = yield* Effect.fromResult(numberToMicros(quote.bidPrice))
        if (
          quote.bidSize > 0 &&
          jevProtectiveStopCrossed(
            BigInt(position.costBasisMicros),
            BigInt(position.quantityMicros),
            bid,
            input.protocol.protectiveStopBps,
          )
        ) {
          const target = yield* Effect.fromResult(
            decideJevExit({
              ...evidence,
              trigger: {
                reason: JevExitReason.ProtectiveStop,
                manifest: pricing.manifest,
                rows: yield* Effect.fromResult(persistIntradayRecordRows(pricing)),
              },
            }),
          )
          yield* Effect.logWarning('Jev protective exit price reference').pipe(
            Effect.annotateLogs({
              ...jevProtectiveQuoteDiagnostics(quote, input.protocol.maximumSpreadBps),
              cycleId: input.cycle.identity.cycleId,
              observedAt,
            }),
          )
          return target
        }
        const query = yield* Effect.fromResult(
          jevObservationQuery(input.cycle, input.protocol, input.calendar, observedAt, [position.symbol]),
        )
        const { evidence: inference } = yield* evaluateJevObservationFromSnapshot(
          {
            cycleId: input.cycle.identity.cycleId,
            authorityGenerationHash: input.authorityGenerationHash,
            protocol: input.protocol,
            portfolio,
          },
          query.rangeEndAt,
          Effect.suspend(() => loadIntradaySnapshot(input.marketData, query)),
        )
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
        Effect.timeoutOption(Duration.millis(Date.parse(maximumHoldDueAt) - Date.parse(observedAt))),
        Effect.flatMap((result) =>
          Option.isSome(result)
            ? Effect.succeed(result.value)
            : currentUtcInstant.pipe(
                Effect.flatMap((checkedAt) =>
                  Effect.fromResult(
                    decideJevExit({
                      ...evidence,
                      observedAt: checkedAt,
                      trigger: { reason: JevExitReason.MaximumHold },
                    }),
                  ),
                ),
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
        JevAwaitingFreshWindow: (cause) =>
          Effect.succeed(
            awaitPositionEvidence({
              reason: DecisionReadinessReason.SignalWindowObserved,
              message: cause.message,
              availableAt: cause.availableAt,
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
              }),
            )
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
