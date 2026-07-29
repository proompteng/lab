import { describe, expect, test } from 'bun:test'

import { assessCandidate8ShrinkageMinimumVarianceGeometry } from './candidate-8-feasibility'
import { defaultQualificationStatisticsPolicy } from './qualification-statistics'

const walkForward = defaultQualificationStatisticsPolicy.walkForward

describe('Candidate 8 pre-registration geometry', () => {
  test('rejects the exact 63-return monthly design before evaluation', () => {
    expect(
      assessCandidate8ShrinkageMinimumVarianceGeometry({
        availableSessions: 1_762,
        firstExecutionIndex: 82,
        minimumTrainingSessions: walkForward.minimumTrainingSessions,
        testSessions: walkForward.testSessions,
        minimumFolds: walkForward.minimumFolds,
      }),
    ).toEqual({
      status: 'INFEASIBLE',
      maximumComparableObservations: 1_680,
      requiredObservations: 1_764,
      availableFolds: 4,
      requiredFolds: 5,
      observationDeficit: 84,
    })
  })

  test('proves the raw development boundary is insufficient even with zero lookback', () => {
    expect(
      assessCandidate8ShrinkageMinimumVarianceGeometry({
        availableSessions: 1_762,
        firstExecutionIndex: 0,
        minimumTrainingSessions: walkForward.minimumTrainingSessions,
        testSessions: walkForward.testSessions,
        minimumFolds: walkForward.minimumFolds,
      }),
    ).toEqual({
      status: 'INFEASIBLE',
      maximumComparableObservations: 1_762,
      requiredObservations: 1_764,
      availableFolds: 4,
      requiredFolds: 5,
      observationDeficit: 2,
    })
  })

  test('is total for malformed geometry inputs', () => {
    expect(
      assessCandidate8ShrinkageMinimumVarianceGeometry({
        availableSessions: Number.NaN,
        firstExecutionIndex: 0,
        minimumTrainingSessions: 504,
        testSessions: 252,
        minimumFolds: 5,
      }),
    ).toEqual({ status: 'INVALID', reason: 'NON_INTEGER_INPUT' })
    expect(
      assessCandidate8ShrinkageMinimumVarianceGeometry({
        availableSessions: 1_762,
        firstExecutionIndex: 0,
        minimumTrainingSessions: 504,
        testSessions: 0,
        minimumFolds: 5,
      }),
    ).toEqual({ status: 'INVALID', reason: 'NON_POSITIVE_TEST_SESSIONS' })
  })
})
