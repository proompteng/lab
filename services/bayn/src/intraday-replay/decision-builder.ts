import { Authority } from '../execution/contracts'
import { JevBatchPlanVersion } from '../jev/batch'
import { makeMomentumEntryQuery } from '../jev/observation-query'
import { buildStrategyCycleDecision, type ObserveDecisionInput } from '../observe-composition/decision-builder'
import { observeChartEntry, type EntryObservation } from '../observe-composition/entry-observation'
import { isRepeatedMomentumRuntime } from '../strategy'
import { evaluateRepeatedMomentumFromSnapshot } from '../strategy/repeated-momentum/runtime'

const observeResearchEntry: EntryObservation = (context) => {
  const strategy = context.strategy
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

export const buildResearchMutationCycleDecision = <R>(input: ObserveDecisionInput<R>) =>
  buildStrategyCycleDecision(input, {
    authorityRequirement: Authority.Execution,
    documentMode: Authority.Execution,
    observeEntry: observeResearchEntry,
  })
