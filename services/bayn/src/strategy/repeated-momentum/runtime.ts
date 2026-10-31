import { Effect } from 'effect'

import { DecisionReadinessReason } from '../../cycle/runner/readiness'
import { makeJevObservation } from '../../jev/observation'
import { JevAwaitingEvidence, loadNativeEntryObservation } from '../../jev/runtime'
import { CandidateObservationStore, candidateObservationLog } from '../../observe-composition/candidate-observation'
import { currentUtcInstant } from '../../time'
import { decideRepeatedMomentumEntry } from './decision'
import type { RepeatedMomentumPolicy } from './policy'

/** Deterministic decisions retain the original window and commit source evidence before admission. */
export const evaluateRepeatedMomentumFromSnapshot = <E, R>(
  input: Omit<Parameters<typeof makeJevObservation>[0], 'snapshot'>,
  rangeEndAt: string,
  loadSnapshot: Effect.Effect<Parameters<typeof makeJevObservation>[0]['snapshot'], E, R>,
  policy: RepeatedMomentumPolicy,
  admissionExpiresAt: number,
) =>
  Effect.gen(function* () {
    const { snapshot, observation } = yield* loadNativeEntryObservation(input, rangeEndAt, loadSnapshot)
    const expiresAt = Math.min(
      admissionExpiresAt,
      Date.parse(observation.payload.observedAt) + input.protocol.inferenceValidityMs,
    )
    if (Date.parse(yield* currentUtcInstant) >= expiresAt)
      return yield* new JevAwaitingEvidence({
        message: 'Momentum source expired before durable admission',
        readiness: DecisionReadinessReason.SnapshotStale,
      })
    yield* (yield* CandidateObservationStore).record(observation, policy)
    yield* Effect.logInfo(candidateObservationLog(observation))
    const evidence = {
      schemaVersion: 'bayn.repeated-momentum-evidence.v1' as const,
      observation: observation.payload,
      decidedAt: yield* currentUtcInstant,
    }
    if (Date.parse(evidence.decidedAt) >= expiresAt)
      return yield* new JevAwaitingEvidence({
        message: 'Momentum evidence expired during durable admission',
        readiness: DecisionReadinessReason.NoEligibleCandidate,
      })
    const decision = yield* Effect.fromResult(decideRepeatedMomentumEntry(evidence, policy))
    return { snapshot, decision }
  })
