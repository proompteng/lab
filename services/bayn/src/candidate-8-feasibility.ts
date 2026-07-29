export type Candidate8GeometryInput = {
  readonly availableSessions: number
  readonly firstExecutionIndex: number
  readonly minimumTrainingSessions: number
  readonly testSessions: number
  readonly minimumFolds: number
}

export type Candidate8GeometryAssessment =
  | {
      readonly status: 'INVALID'
      readonly reason:
        | 'NON_INTEGER_INPUT'
        | 'NEGATIVE_INPUT'
        | 'NON_POSITIVE_TEST_SESSIONS'
        | 'EXECUTION_OUTSIDE_DATASET'
        | 'ARITHMETIC_OVERFLOW'
    }
  | {
      readonly status: 'FEASIBLE' | 'INFEASIBLE'
      readonly maximumComparableObservations: number
      readonly requiredObservations: number
      readonly availableFolds: number
      readonly requiredFolds: number
      readonly observationDeficit: number
    }

const valuesOf = (input: Candidate8GeometryInput): readonly number[] => [
  input.availableSessions,
  input.firstExecutionIndex,
  input.minimumTrainingSessions,
  input.testSessions,
  input.minimumFolds,
]

export const assessCandidate8ShrinkageMinimumVarianceGeometry = (
  input: Candidate8GeometryInput,
): Candidate8GeometryAssessment => {
  const values = valuesOf(input)
  if (!values.every(Number.isSafeInteger)) return { status: 'INVALID', reason: 'NON_INTEGER_INPUT' }
  if (values.some((value) => value < 0)) return { status: 'INVALID', reason: 'NEGATIVE_INPUT' }
  if (input.testSessions === 0) return { status: 'INVALID', reason: 'NON_POSITIVE_TEST_SESSIONS' }
  if (input.firstExecutionIndex > input.availableSessions) {
    return { status: 'INVALID', reason: 'EXECUTION_OUTSIDE_DATASET' }
  }

  const requiredTestObservations = input.testSessions * input.minimumFolds
  const requiredObservations = input.minimumTrainingSessions + requiredTestObservations
  if (!Number.isSafeInteger(requiredTestObservations) || !Number.isSafeInteger(requiredObservations)) {
    return { status: 'INVALID', reason: 'ARITHMETIC_OVERFLOW' }
  }

  const maximumComparableObservations = input.availableSessions - input.firstExecutionIndex
  const availableFolds = Math.max(
    0,
    Math.floor((maximumComparableObservations - input.minimumTrainingSessions) / input.testSessions),
  )
  const observationDeficit = Math.max(0, requiredObservations - maximumComparableObservations)

  return {
    status: availableFolds >= input.minimumFolds ? 'FEASIBLE' : 'INFEASIBLE',
    maximumComparableObservations,
    requiredObservations,
    availableFolds,
    requiredFolds: input.minimumFolds,
    observationDeficit,
  }
}
