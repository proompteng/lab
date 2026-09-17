import { expect, test } from 'bun:test'
import { Schema } from 'effect'

import { candidateObservationFixture } from '../../testing/candidate-observation-fixture'
import { cyclePassLogFacts, retainAutonomousCyclePassObservation } from './pass-decisions'
import { RetainedAutonomousCyclePassObservationSchema } from './pass-observation'
import { DecisionReadinessReason } from './readiness'
import type { CyclePassObservation } from './model'

test('retains readiness and holding reasons through the durable observation schema and log projection', () => {
  const { cycle } = candidateObservationFixture()
  const readiness = {
    reason: DecisionReadinessReason.SnapshotCoverage,
    message: 'intraday symbol lacks the complete rolling lookback baseline',
    symbol: 'IWM',
  }
  const observation: CyclePassObservation = {
    outcome: 'SUCCEEDED',
    observedAt: '2026-09-04T14:30:02.000Z',
    result: {
      outcome: 'RECOVERED',
      action: 'WAITING',
      readiness,
      observedAt: '2026-09-04T14:30:02.000Z',
      cycle,
    },
  }
  const retained = retainAutonomousCyclePassObservation(observation)
  expect(Schema.decodeUnknownSync(RetainedAutonomousCyclePassObservationSchema)(retained)).toEqual(retained)
  expect(retained).toMatchObject({ recoveryAction: 'WAITING', readiness })
  expect(cyclePassLogFacts(observation).annotations).toMatchObject({
    recoveryAction: 'WAITING',
    readiness: JSON.stringify(readiness),
  })
  const holding = retainAutonomousCyclePassObservation({
    ...observation,
    result: {
      outcome: 'RECOVERED',
      action: 'WAITING',
      observedAt: observation.observedAt,
      cycle,
      waitReason: 'ENTRY_INTENTS_SETTLED_UNTIL_CLOSE',
    },
  })
  expect(Schema.decodeUnknownSync(RetainedAutonomousCyclePassObservationSchema)(holding)).toEqual(holding)
  expect(holding).toMatchObject({ recoveryAction: 'WAITING', waitReason: 'ENTRY_INTENTS_SETTLED_UNTIL_CLOSE' })
  expect(Schema.is(RetainedAutonomousCyclePassObservationSchema)({ ...retained, recoveryAction: 'COMPLETED' })).toBe(
    false,
  )
})

test('still decodes a retained pass written before readiness details were available', () => {
  const previous = { result: 'SUCCESS', outcome: 'RECOVERED', observedAt: '2026-09-04T14:30:02.000Z' } as const
  expect(Schema.decodeUnknownSync(RetainedAutonomousCyclePassObservationSchema)(previous)).toEqual(previous)
})
