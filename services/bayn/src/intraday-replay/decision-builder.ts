import { Effect } from 'effect'

import { Authority } from '../execution/contracts'
import { JevBatchPlanVersion } from '../jev/batch'
import { makeMomentumEntryQuery } from '../jev/observation-query'
import { buildStrategyCycleDecision, type ObserveDecisionInput } from '../observe-composition/decision-builder'
import {
  observeChartEntry,
  observeNativeAlphaEntry,
  type EntryObservation,
} from '../observe-composition/entry-observation'
import { isIntradayAlphaRuntime, isRepeatedMomentumRuntime } from '../strategy'
import { evaluateRepeatedMomentumFromSnapshot } from '../strategy/repeated-momentum/runtime'
import type { TrailingBaselineQuery } from '../market-data/intraday/trailing-baseline'
import { operationalError, type OperationalError } from '../errors'
import { JevAwaitingEvidence } from '../jev/runtime'
import { DecisionReadinessReason } from '../cycle/runner/readiness'
import { canonicalHashV1Result } from '../hash'
import { utcInstantFromEpochMillis } from '../time'
import type { AlphaBaselineSource } from '../system-assessment/alpha-observation-witness'
import type { PreparedAlphaBaselineSource } from '../system-assessment/alpha-baseline-witness'
import { ReplayAlphaObservationCommit, type AnyReplayAlphaBaselineAdmissionUse } from './alpha-baseline-use'

export type ResearchAlphaBaselineSource = AlphaBaselineSource | PreparedAlphaBaselineSource

export type ResearchAlphaBaselineLoader = (
  query: TrailingBaselineQuery,
  observedAt: string,
) => Effect.Effect<ResearchAlphaBaselineSource, OperationalError>

export type ResearchAlphaBaselineUseRecorder = (
  use: AnyReplayAlphaBaselineAdmissionUse,
) => Effect.Effect<void, OperationalError>

export const observeResearchEntry =
  (
    loadAlphaBaseline?: ResearchAlphaBaselineLoader,
    recordAlphaBaselineUse?: ResearchAlphaBaselineUseRecorder,
  ): EntryObservation =>
  (context) => {
    const strategy = context.strategy
    if (isIntradayAlphaRuntime(strategy)) {
      const policy = strategy.definition.parameters
      if (loadAlphaBaseline === undefined) return observeNativeAlphaEntry(context)
      return Effect.gen(function* () {
        let selected: { readonly source: ResearchAlphaBaselineSource; readonly windowEndAt: string } | undefined
        const record: ReplayAlphaObservationCommit['Service']['record'] = (observation) =>
          Effect.gen(function* () {
            const selection = selected
            if (
              selection === undefined ||
              observation.payload.schemaVersion !== 'bayn.intraday-alpha-observation.v2' ||
              observation.payload.cycleId !== context.observation.cycleId ||
              observation.payload.authorityGenerationHash !== context.observation.authorityGenerationHash
            )
              return yield* operationalError({
                component: 'strategy',
                operation: 'replay-alpha-baseline',
                message: 'Alpha observation has no exact original admission and selected baseline',
              })
            const baselineHash = yield* Effect.fromResult(
              canonicalHashV1Result(
                'preparationHash' in selection.source
                  ? selection.source.payload.acquisition.trailingBaseline
                  : selection.source.payload.trailingBaseline,
              ),
            )
            if (
              baselineHash !== (yield* Effect.fromResult(canonicalHashV1Result(observation.payload.trailingBaseline)))
            )
              return yield* operationalError({
                component: 'strategy',
                operation: 'replay-alpha-baseline',
                message: 'Alpha observation changed the baseline selected at its original admission',
              })
            if (recordAlphaBaselineUse !== undefined)
              yield* recordAlphaBaselineUse({
                ...('preparationHash' in selection.source
                  ? {
                      schemaVersion: 'bayn.replay-alpha-baseline-use.v2' as const,
                      sourcePreparationHash: selection.source.preparationHash,
                    }
                  : {
                      schemaVersion: 'bayn.replay-alpha-baseline-use.v1' as const,
                      sourceObservationHash: selection.source.observationHash,
                    }),
                observationHash: observation.contentHash,
                cycleId: context.observation.cycleId,
                authorityGenerationHash: context.observation.authorityGenerationHash,
                sessionDate: context.sessionDate,
                windowEndAt: selection.windowEndAt,
                admissionObservedAt: context.observedAt,
                admissionExpiresAt: utcInstantFromEpochMillis(context.admissionExpiresAt),
                sourceWitnessHash: selection.source.witnessSourceHash,
                baselineHash,
              })
          }).pipe(
            Effect.mapError((cause) =>
              operationalError({
                component: 'strategy',
                operation: 'replay-alpha-baseline',
                message: 'Alpha original admission receipt could not be captured',
                cause,
              }),
            ),
          )
        return yield* observeNativeAlphaEntry(context, (query) =>
          loadAlphaBaseline(
            {
              sessionDate: context.sessionDate,
              symbols: policy.candidateSymbols,
              noiseAreaSymbols: policy.noiseAreaSymbols,
              lookbackSessions: policy.trailingBaseline.lookbackSessions,
              minimumSessions: policy.trailingBaseline.minimumSessions,
              sourceContract: {
                provider: 'alpaca',
                feed: query.feed,
                sourceTopic: query.sourceTopics.bars,
                universeId: query.universeId,
              },
            },
            context.observedAt,
          ).pipe(
            Effect.map((source) => {
              selected = { source, windowEndAt: query.rangeEndAt }
              return 'preparationHash' in source
                ? source.payload.acquisition.trailingBaseline
                : source.payload.trailingBaseline
            }),
            Effect.mapError((cause) =>
              cause.retryable && cause.operation === 'replay-alpha-baseline'
                ? new JevAwaitingEvidence({
                    message: cause.message,
                    readiness: DecisionReadinessReason.SnapshotUnavailable,
                  })
                : cause,
            ),
          ),
        ).pipe(Effect.provideService(ReplayAlphaObservationCommit, { record }))
      })
    }
    if (isRepeatedMomentumRuntime(strategy)) {
      const query = makeMomentumEntryQuery({
        protocol: context.observation.protocol,
        calendar: context.calendar,
        sessionDate: context.sessionDate,
        observedAtMs: Date.parse(context.observedAt),
        candidates: context.query.candidateSymbols ?? [],
      })
      return evaluateRepeatedMomentumFromSnapshot(
        context.observation,
        query.rangeEndAt,
        context.loadSnapshot(query),
        strategy.definition.parameters,
        context.admissionExpiresAt,
      )
    }
    return observeChartEntry(
      context,
      strategy.definition.parameters.schemaVersion === 'bayn.entry-ablation-policy.v1'
        ? JevBatchPlanVersion.Ablation
        : JevBatchPlanVersion.V8,
    )
  }

export const buildResearchMutationCycleDecision = <R>(
  input: ObserveDecisionInput<R>,
  loadAlphaBaseline?: ResearchAlphaBaselineLoader,
  recordAlphaBaselineUse?: ResearchAlphaBaselineUseRecorder,
) =>
  buildStrategyCycleDecision(input, {
    authorityRequirement: Authority.Execution,
    documentMode: Authority.Execution,
    observeEntry: observeResearchEntry(loadAlphaBaseline, recordAlphaBaselineUse),
  })
