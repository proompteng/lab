import { Effect, Option, Result } from 'effect'

import { DecisionReadinessReason } from '../../cycle/runner/readiness'
import { JevContractError } from '../../jev/contract'
import {
  jevFirstSignalDueMs,
  jevSignalDueAtMs,
  jevSignalIntervalMs,
  jevSignalWindowEndMs,
} from '../../jev/observation-query'
import { JevAwaitingEvidence, JevAwaitingFreshWindow } from '../../jev/runtime'
import type { MarketHours } from '../../market-hours'
import {
  IntradayBenchmarkEvidencePolicy,
  IntradayCandidateEvidencePolicy,
  type IntradaySnapshotQuery,
} from '../../market-data/intraday/model'
import {
  IntradayTrailingBaseline,
  type IntradayAlphaTrailingBaseline,
} from '../../market-data/intraday/trailing-baseline'
import { CandidateObservationStore, candidateObservationLog } from '../../observe-composition/candidate-observation'
import { currentUtcInstant, utcInstantFromEpochMillis } from '../../time'
import { evaluateCatalystVetos, type CatalystVetoRequestInput } from './catalyst-veto'
import { decideIntradayAlphaEntry } from './decision'
import { makeOwnedIntradayAlphaObservation } from './observation'
import {
  IntradayAlphaPhase,
  intradayAlphaBenchmarkSymbol,
  intradayAlphaCandidateSymbols,
  intradayAlphaEquityMarketProfile,
  intradayAlphaStrategyIdentity,
  type IntradayAlphaPolicy,
} from './policy'
import { extractIntradayAlphaCandidates, resolveAlphaRegularSession } from './signals'

export const makeIntradayAlphaEntryQuery = (input: {
  readonly policy: IntradayAlphaPolicy
  readonly calendar: MarketHours
  readonly sessionDate: IntradaySnapshotQuery['sessionDate']
  readonly observedAtMs: number
}): Result.Result<IntradaySnapshotQuery, JevContractError | JevAwaitingEvidence> => {
  const regular = resolveAlphaRegularSession(input.calendar, input.sessionDate)
  if (Result.isFailure(regular)) return Result.fail(regular.failure)
  const protocol = input.policy.sharedProtocol
  const rangeEndMs = jevSignalWindowEndMs(input.observedAtMs, protocol)
  if (rangeEndMs <= regular.success.openMs) {
    return Result.fail(
      new JevAwaitingEvidence({
        message: 'Intraday alpha awaits the first completed regular-session minute',
        readiness: DecisionReadinessReason.LookbackWarmup,
        availableAt: utcInstantFromEpochMillis(jevFirstSignalDueMs(regular.success.openMs, protocol)),
      }),
    )
  }
  const entryCutoffMs = regular.success.closeMs - protocol.entryCutoffMinutesBeforeClose * 60_000
  if (rangeEndMs > regular.success.closeMs || input.observedAtMs >= entryCutoffMs) {
    return Result.fail(
      new JevAwaitingEvidence({
        message: 'Intraday alpha regular-session entry window has closed',
        readiness: DecisionReadinessReason.NoEligibleCandidate,
      }),
    )
  }
  const market = intradayAlphaEquityMarketProfile
  const candidates = [...intradayAlphaCandidateSymbols]
  return Result.succeed({
    sessionDate: input.sessionDate,
    calendar: input.calendar,
    observedAt: utcInstantFromEpochMillis(input.observedAtMs),
    rangeStartAt: regular.success.openAt,
    rangeEndAt: utcInstantFromEpochMillis(rangeEndMs),
    universeId: market.universeId,
    universeSymbolHash: market.universeSymbolHash,
    universe: market.universe,
    symbols: [...new Set([...candidates, intradayAlphaBenchmarkSymbol])].sort(),
    candidateSymbols: candidates,
    candidateEvidencePolicy: IntradayCandidateEvidencePolicy.MarketQuotesV2,
    benchmarkEvidencePolicy: IntradayBenchmarkEvidencePolicy.CompletedBars,
    benchmarkSymbols: [intradayAlphaBenchmarkSymbol],
    feed: market.feed,
    delayClass: market.delayClass,
    sourceTopics: market.sourceTopics,
    maximumQuoteAgeMs: protocol.maximumQuoteAgeMs,
    minimumWatermarkLagMs: protocol.decisionDelaySeconds * 1000,
  })
}

export const evaluateIntradayAlphaFromSnapshot = <E, R, EE = never, RE = never, EB = never, RB = never>(input: {
  readonly observation: Omit<Parameters<typeof makeOwnedIntradayAlphaObservation>[0], 'snapshot' | 'trailingBaseline'>
  readonly rangeEndAt: string
  readonly loadSnapshot: Effect.Effect<Parameters<typeof makeOwnedIntradayAlphaObservation>[0]['snapshot'], E, R>
  readonly loadTrailingBaseline?: Effect.Effect<IntradayAlphaTrailingBaseline, EB, RB>
  readonly loadEligibility?: Effect.Effect<
    Parameters<typeof makeOwnedIntradayAlphaObservation>[0]['equityShortEligibility'],
    EE,
    RE
  >
  readonly policy: IntradayAlphaPolicy
  readonly admissionExpiresAt: number
}) =>
  Effect.gen(function* () {
    const store = yield* CandidateObservationStore
    const readSessionState = store.readIntradayAlphaSessionState
    if (readSessionState === undefined)
      return yield* new JevContractError({ message: 'Intraday alpha requires durable session history' })
    const latest = yield* store.latestJevWindowEnd({
      cycleId: input.observation.cycleId,
      purpose: input.observation.portfolio.purpose,
      schemaVersion: 'bayn.intraday-alpha-observation.v2',
    })
    if (Option.isSome(latest) && latest.value >= input.rangeEndAt)
      return yield* new JevAwaitingFreshWindow({
        message: 'Intraday alpha already committed an observation for this completed signal window',
        availableAt: utcInstantFromEpochMillis(
          jevSignalDueAtMs(Date.parse(latest.value) + jevSignalIntervalMs, input.policy.sharedProtocol),
        ),
      })
    const equityShortEligibility =
      input.loadEligibility === undefined ? input.observation.equityShortEligibility : yield* input.loadEligibility
    const snapshot = yield* input.loadSnapshot
    if (snapshot.manifest.rangeEndAt !== input.rangeEndAt)
      return yield* new JevContractError({ message: 'Intraday alpha snapshot differs from its admitted window' })

    let trailingBaseline: IntradayAlphaTrailingBaseline
    if (input.loadTrailingBaseline !== undefined) {
      trailingBaseline = yield* input.loadTrailingBaseline
    } else {
      const baselineService = yield* Effect.serviceOption(IntradayTrailingBaseline)
      if (Option.isNone(baselineService)) {
        return yield* new JevContractError({
          message: 'Intraday alpha v2 requires the causal trailing-baseline service',
        })
      }
      trailingBaseline = yield* baselineService.value.load({
        sessionDate: snapshot.manifest.sessionDate,
        symbols: input.policy.candidateSymbols,
        noiseAreaSymbols: input.policy.noiseAreaSymbols,
        lookbackSessions: input.policy.trailingBaseline.lookbackSessions,
        minimumSessions: input.policy.trailingBaseline.minimumSessions,
        sourceContract: {
          provider: 'alpaca',
          feed: snapshot.manifest.feed,
          sourceTopic: snapshot.manifest.sourceTopics.bars,
          universeId: snapshot.manifest.universeId,
        },
      })
    }

    const owned = yield* Effect.fromResult(
      makeOwnedIntradayAlphaObservation({
        ...input.observation,
        trailingBaseline,
        ...(equityShortEligibility === undefined ? {} : { equityShortEligibility }),
        snapshot,
      }),
    )
    const expiresAt = Math.min(
      input.admissionExpiresAt,
      Date.parse(owned.payload.observedAt) + input.policy.sharedProtocol.inferenceValidityMs,
    )
    const nowBeforeVeto = Date.parse(yield* currentUtcInstant)
    if (nowBeforeVeto >= expiresAt)
      return yield* new JevAwaitingEvidence({
        message: 'Intraday alpha source expired before durable admission',
        readiness: DecisionReadinessReason.SnapshotStale,
      })

    const observationRecord = { contentHash: owned.contentHash, payload: owned.payload } as const
    yield* store.record(observationRecord, input.policy)
    yield* Effect.logInfo(candidateObservationLog(observationRecord))

    const sessionState = yield* Effect.fromResult(intradayAlphaStrategyIdentity(input.policy)).pipe(
      Effect.mapError((cause) => new JevContractError({ message: 'Intraday alpha identity is invalid', cause })),
      Effect.flatMap((identity) =>
        readSessionState({
          cycleId: input.observation.cycleId,
          accountId: owned.payload.portfolio.brokerState.account.accountId,
          sessionDate: snapshot.manifest.sessionDate,
          strategyProtocolHash: identity.protocolHash,
        }),
      ),
    )

    const occupiedSymbols = owned.payload.portfolio.brokerState.positions
      .filter((position) => BigInt(position.quantityAtoms) !== 0n)
      .map((position) => position.symbol)
      .toSorted()

    const extracted = yield* Effect.fromResult(
      extractIntradayAlphaCandidates({
        snapshot,
        policy: input.policy,
        trailingBaseline,
        accountId: owned.payload.portfolio.brokerState.account.accountId,
        ...(equityShortEligibility === undefined ? {} : { equityShortEligibility }),
        occupiedSymbols,
        morningOrbTakenSymbols: sessionState.morningOrbTakenSymbols,
        middayReversionCompleted: sessionState.middayReversionCompleted,
        noiseAreaTakenSymbols: sessionState.noiseAreaTakenSymbols ?? [],
      }),
    )

    const maxPerSide = input.policy.catalystVeto.maxCandidatesPerSide
    const vetoCandidates: CatalystVetoRequestInput[] =
      !input.policy.catalystVeto.enabled || extracted.context.phase === IntradayAlphaPhase.OutsideWindow
        ? []
        : [...extracted.longPool.slice(0, maxPerSide), ...extracted.shortPool.slice(0, maxPerSide)].map(
            (candidate) => ({
              model: input.policy.catalystVeto.model,
              symbol: candidate.symbol,
              phase: candidate.phase,
              direction: candidate.direction,
              windowEndAt: snapshot.manifest.rangeEndAt,
              sessionOpenPrice: candidate.sessionOpenPrice,
              sessionVwap: candidate.sessionVwap,
              latestClose: candidate.latestClose,
              relVwapDevBps: candidate.relVwapDevBps,
              recentBars: candidate.bars.slice(-15).map(({ eventAt, open, high, low, close, volume }) => ({
                eventAt,
                open,
                high,
                low,
                close,
                volume,
              })),
            }),
          )

    const vetoRecordedAt = yield* currentUtcInstant
    const remainingBudgetMs = Math.max(0, expiresAt - Date.parse(vetoRecordedAt) - 500)
    const catalystVetos =
      vetoCandidates.length === 0
        ? []
        : yield* evaluateCatalystVetos({
            candidates: vetoCandidates,
            vetoThreshold: input.policy.catalystVeto.vetoThreshold,
            budgetMs: remainingBudgetMs,
            recordedAt: vetoRecordedAt,
          })

    const decidedAt = yield* currentUtcInstant
    if (Date.parse(decidedAt) >= expiresAt)
      return yield* new JevAwaitingEvidence({
        message: 'Intraday alpha evidence expired during catalyst veto evaluation',
        readiness: DecisionReadinessReason.NoEligibleCandidate,
      })
    const evidence = {
      schemaVersion: 'bayn.intraday-alpha-evidence.v2' as const,
      observation: owned.payload,
      morningOrbTakenSymbols: [...sessionState.morningOrbTakenSymbols].sort(),
      middayReversionCompleted: sessionState.middayReversionCompleted,
      noiseAreaTakenSymbols: [...(sessionState.noiseAreaTakenSymbols ?? [])].sort(),
      catalystVetos,
      decidedAt,
    }
    const decision = yield* Effect.fromResult(decideIntradayAlphaEntry(evidence, input.policy))
    return { snapshot, decision }
  })
