import { Effect } from 'effect'

import { Authority } from '../execution/contracts'
import { JevBatchPlanVersion } from '../jev/batch'
import { makeMomentumEntryQuery } from '../jev/observation-query'
import { buildStrategyCycleDecision, type ObserveDecisionInput } from '../observe-composition/decision-builder'
import { observeChartEntry, type EntryObservation } from '../observe-composition/entry-observation'
import { isIntradayAlphaRuntime, isRepeatedMomentumRuntime } from '../strategy'
import { evaluateIntradayAlphaFromSnapshot, makeIntradayAlphaEntryQuery } from '../strategy/intraday-alpha/runtime'
import { evaluateRepeatedMomentumFromSnapshot } from '../strategy/repeated-momentum/runtime'
import type { IntradayAlphaTrailingBaseline, TrailingBaselineQuery } from '../market-data/intraday/trailing-baseline'
import type { OperationalError } from '../errors'
import { JevAwaitingEvidence } from '../jev/runtime'
import { DecisionReadinessReason } from '../cycle/runner/readiness'

export type ResearchAlphaBaselineLoader = (
  query: TrailingBaselineQuery,
  observedAt: string,
) => Effect.Effect<IntradayAlphaTrailingBaseline, OperationalError>

const observeResearchEntry =
  (loadAlphaBaseline?: ResearchAlphaBaselineLoader): EntryObservation =>
  (context) => {
    const strategy = context.strategy
    if (isIntradayAlphaRuntime(strategy)) {
      const policy = strategy.definition.parameters
      return Effect.fromResult(
        makeIntradayAlphaEntryQuery({
          policy,
          calendar: context.calendar,
          sessionDate: context.sessionDate,
          observedAtMs: Date.parse(context.observedAt),
        }),
      ).pipe(
        Effect.flatMap((query) =>
          evaluateIntradayAlphaFromSnapshot({
            observation: context.observation,
            rangeEndAt: query.rangeEndAt,
            loadSnapshot: context.loadSnapshot(query),
            policy,
            admissionExpiresAt: context.admissionExpiresAt,
            ...(loadAlphaBaseline === undefined
              ? {}
              : {
                  loadTrailingBaseline: loadAlphaBaseline(
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
                    Effect.mapError((cause) =>
                      cause.retryable && cause.operation === 'replay-alpha-baseline'
                        ? new JevAwaitingEvidence({
                            message: cause.message,
                            readiness: DecisionReadinessReason.SnapshotUnavailable,
                          })
                        : cause,
                    ),
                  ),
                }),
          }),
        ),
      )
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
) =>
  buildStrategyCycleDecision(input, {
    authorityRequirement: Authority.Execution,
    documentMode: Authority.Execution,
    observeEntry: observeResearchEntry(loadAlphaBaseline),
  })
