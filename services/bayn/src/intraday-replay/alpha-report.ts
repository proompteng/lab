import { Result, Schema } from 'effect'

import { canonicalHashV1Result } from '../hash'
import { IsoDateSchema, Sha256Schema, UtcInstantSchema } from '../schemas'
import { decodeExecutionDecisionDocument } from '../shadow-decision-contract'
import {
  IntradayAlphaObservationSchema,
  reproduceIntradayAlphaObservation,
} from '../strategy/intraday-alpha/observation'
import { ResearchStrategyEngine, type ResearchStrategyBinding } from '../system-assessment/strategy-binding'
import type { AlphaBaselineSource } from '../system-assessment/alpha-observation-witness'
import { selectReplayAlphaBaseline } from './alpha-baseline'
import { ReplayBrokerFailure } from './broker'

export const ReplayAlphaObservationSchema = Schema.Struct({
  contentHash: Sha256Schema,
  payload: IntradayAlphaObservationSchema,
})
export const ReplayAlphaBaselineGapSchema = Schema.Struct({
  reason: Schema.Literal('MISSING_CAUSAL_ALPHA_BASELINE'),
  sessionDate: IsoDateSchema,
  observedAt: UtcInstantSchema,
  firstAvailableAt: Schema.NullOr(UtcInstantSchema),
})
export type ReplayAlphaBaselineGap = typeof ReplayAlphaBaselineGapSchema.Type

/** Source portfolio and eligibility never replace the replay broker; only the witnessed historical baseline is reused. */
export const verifyReplayAlphaEvidence = (input: {
  readonly binding: ResearchStrategyBinding
  readonly sources: readonly AlphaBaselineSource[]
  readonly observations: readonly (typeof ReplayAlphaObservationSchema.Type)[]
  readonly baselineGaps: readonly ReplayAlphaBaselineGap[]
  readonly decisions: readonly unknown[]
  readonly runId: string
}) =>
  Result.gen(function* () {
    const fail = (message: string) => Result.fail(new ReplayBrokerFailure({ message }))
    const binding = input.binding
    if (binding.engine !== ResearchStrategyEngine.IntradayAlpha) {
      if (input.observations.length !== 0 || input.baselineGaps.length !== 0)
        return yield* fail('A different replay engine cannot claim alpha observations or baseline gaps')
      return []
    }
    const accountId = `replay-${input.runId}`
    const observations = []
    const seen = new Set<string>()
    for (const row of input.observations) {
      const observed = yield* reproduceIntradayAlphaObservation(row.payload)
      const manifest = observed.snapshot.manifest
      if (
        seen.has(row.contentHash) ||
        observed.contentHash !== row.contentHash ||
        observed.portfolio.brokerState.account.accountId !== accountId ||
        (yield* canonicalHashV1Result(observed.protocol)) !==
          (yield* canonicalHashV1Result(binding.parameters.sharedProtocol))
      )
        return yield* fail('Alpha replay observation is duplicated or differs from its engine, account or content')
      const baseline = yield* selectReplayAlphaBaseline(
        binding,
        input.sources,
        {
          sessionDate: manifest.sessionDate,
          symbols: binding.parameters.candidateSymbols,
          noiseAreaSymbols: binding.parameters.noiseAreaSymbols,
          lookbackSessions: binding.parameters.trailingBaseline.lookbackSessions,
          minimumSessions: binding.parameters.trailingBaseline.minimumSessions,
          sourceContract: {
            provider: 'alpaca',
            feed: manifest.feed,
            sourceTopic: manifest.sourceTopics.bars,
            universeId: manifest.universeId,
          },
        },
        observed.observedAt,
      )
      if ((yield* canonicalHashV1Result(baseline)) !== (yield* canonicalHashV1Result(observed.trailingBaseline)))
        return yield* fail('Alpha replay observation changed its causally available retained baseline')
      seen.add(row.contentHash)
      observations.push(observed)
    }
    const decisions = new Set<string>()
    for (const raw of input.decisions) {
      const document = yield* decodeExecutionDecisionDocument(raw)
      const target = document.strategyDecision
      if (
        target?.schemaVersion !== 'bayn.intraday-alpha-target.v2' ||
        decisions.has(document.contentHash) ||
        document.bindings.accountId !== accountId ||
        document.bindings.strategyProtocolHash !== binding.protocolHash ||
        (yield* canonicalHashV1Result(target.policy)) !== (yield* canonicalHashV1Result(binding.parameters)) ||
        !seen.has(yield* canonicalHashV1Result(target.evidence.observation))
      )
        return yield* fail('Alpha replay decision does not bind its complete native policy and retained observation')
      decisions.add(document.contentHash)
    }
    const gapKeys = new Set<string>()
    for (const gap of input.baselineGaps) {
      const key = `${gap.sessionDate}:${gap.observedAt}`
      const firstAvailable =
        input.sources
          .filter((source) => source.payload.trailingBaseline.sessionDate === gap.sessionDate)
          .toSorted((a, b) => Date.parse(a.availableAt) - Date.parse(b.availableAt))[0]?.availableAt ?? null
      if (
        gapKeys.has(key) ||
        gap.firstAvailableAt !== firstAvailable ||
        (firstAvailable !== null && Date.parse(firstAvailable) <= Date.parse(gap.observedAt))
      )
        return yield* fail('Alpha baseline gap invents missing data or changes its first causal availability')
      gapKeys.add(key)
    }
    return observations
  })
