import { Result, Schema } from 'effect'

import { makeCycleExecutionPolicyFromModel } from '../cycle/construction'
import { makeIntradayCycleDraft } from '../cycle/runner/calendar-decisions'
import { makeInitialCycle } from '../cycle/store/decisions'
import { makeStrategyProtocolHashResult } from '../contracts'
import { makeCandidateObservation } from '../observe-composition/candidate-observation'
import { decideIntradayMomentum } from '../strategy/intraday-momentum/decision'
import { IsoDateSchema } from '../schemas'
import { fixtureRuntime } from './runtime-fixtures'
import { streamingFixture } from './streaming-market-fixture'

export const candidateObservationFixture = () => {
  const fixture = streamingFixture()
  const { snapshot, protocol } = fixture
  const session = snapshot.manifest.calendar.sessions[0]
  if (session === undefined) throw new Error('candidate observation fixture requires a session')
  const executionPolicy = Result.getOrThrow(makeCycleExecutionPolicyFromModel(protocol.executionModel))
  if (executionPolicy.schemaVersion !== 'bayn.autonomous-cycle-execution-policy.v3')
    throw new Error('candidate observation fixture requires an intraday policy')
  const draft = Result.getOrThrow(
    makeIntradayCycleDraft(
      {
        cycleBindingId: 'a'.repeat(64),
        strategyName: 'intraday-momentum',
        strategyProtocolHash: Result.getOrThrow(makeStrategyProtocolHashResult(fixtureRuntime.provenance.strategy)),
        accountId: 'candidate-observation-test',
        executionPolicy,
      },
      snapshot.manifest.calendar,
      session,
    ),
  )
  const decision = Result.getOrThrow(
    decideIntradayMomentum(
      {
        snapshot,
        session: {
          sessionDate: Schema.decodeUnknownSync(IsoDateSchema)(draft.identity.executionSessionDate),
          openAt: session.openAt,
          closeAt: session.closeAt,
          calendarHash: draft.window.executionCalendarHash,
        },
      },
      protocol,
    ),
  )
  const input = {
    cycleId: draft.identity.cycleId,
    authorityGenerationHash: 'b'.repeat(64),
    observedAt: snapshot.manifest.observedAt,
    protocol,
    snapshot,
    decision,
  }
  return {
    ...fixture,
    input,
    draft,
    cycle: makeInitialCycle(draft, session.openAt),
    observation: Result.getOrThrow(makeCandidateObservation(input)),
  }
}
