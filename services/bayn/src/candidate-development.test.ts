import { describe, expect, test } from 'bun:test'
import { Effect, Exit, Result } from 'effect'

import {
  candidateDevelopmentCalendarContract,
  candidateDevelopmentStatisticsPolicy,
  candidateDevelopmentWalkForwardProtocol,
  computeEndAnchoredWalkForwardBoundaries,
  firstEligibleExecutionAfterLookback,
  officialMonthEndSignalDates,
  preflightCandidateDevelopment,
  requiredObservationsForWalkForward,
  runCandidateDevelopment,
} from './candidate-development'
import { defaultQualificationStatisticsPolicy } from './qualification-statistics'
import type { IsoDate } from './schemas'

const fullMarketClosures = new Set<IsoDate>([
  '2016-01-18',
  '2016-02-15',
  '2016-03-25',
  '2016-05-30',
  '2016-07-04',
  '2016-09-05',
  '2016-11-24',
  '2016-12-26',
  '2017-01-02',
  '2017-01-16',
  '2017-02-20',
  '2017-04-14',
  '2017-05-29',
  '2017-07-04',
  '2017-09-04',
  '2017-11-23',
  '2017-12-25',
  '2018-01-01',
  '2018-01-15',
  '2018-02-19',
  '2018-03-30',
  '2018-05-28',
  '2018-07-04',
  '2018-09-03',
  '2018-11-22',
  '2018-12-05',
  '2018-12-25',
  '2019-01-01',
  '2019-01-21',
  '2019-02-18',
  '2019-04-19',
  '2019-05-27',
  '2019-07-04',
  '2019-09-02',
  '2019-11-28',
  '2019-12-25',
  '2020-01-01',
  '2020-01-20',
  '2020-02-17',
  '2020-04-10',
  '2020-05-25',
  '2020-07-03',
  '2020-09-07',
  '2020-11-26',
  '2020-12-25',
  '2021-01-01',
  '2021-01-18',
  '2021-02-15',
  '2021-04-02',
  '2021-05-31',
  '2021-07-05',
  '2021-09-06',
  '2021-11-25',
  '2021-12-24',
  '2022-01-17',
  '2022-02-21',
  '2022-04-15',
  '2022-05-30',
  '2022-06-20',
  '2022-07-04',
  '2022-09-05',
  '2022-11-24',
  '2022-12-26',
])

const isoDate = (date: Date): IsoDate => date.toISOString().slice(0, 10) as IsoDate

const developmentSessions = (): readonly IsoDate[] => {
  const sessions: IsoDate[] = []
  for (
    let date = new Date(`${candidateDevelopmentCalendarContract.start}T00:00:00.000Z`);
    date <= new Date(`${candidateDevelopmentCalendarContract.end}T00:00:00.000Z`);
    date = new Date(date.getTime() + 86_400_000)
  ) {
    const session = isoDate(date)
    if (date.getUTCDay() !== 0 && date.getUTCDay() !== 6 && !fullMarketClosures.has(session)) {
      sessions.push(session)
    }
  }
  return sessions
}

const expectedFolds = [
  {
    ordinal: 0,
    trainingStartIndex: 273,
    trainingStart: '2017-02-02',
    trainingEndIndex: 776,
    trainingEnd: '2019-02-04',
    trainingObservationCount: 504,
    testStartIndex: 777,
    testStart: '2019-02-05',
    testEndIndex: 973,
    testEnd: '2019-11-13',
    testObservationCount: 197,
  },
  {
    ordinal: 1,
    trainingStartIndex: 273,
    trainingStart: '2017-02-02',
    trainingEndIndex: 973,
    trainingEnd: '2019-11-13',
    trainingObservationCount: 701,
    testStartIndex: 974,
    testStart: '2019-11-14',
    testEndIndex: 1_170,
    testEnd: '2020-08-26',
    testObservationCount: 197,
  },
  {
    ordinal: 2,
    trainingStartIndex: 273,
    trainingStart: '2017-02-02',
    trainingEndIndex: 1_170,
    trainingEnd: '2020-08-26',
    trainingObservationCount: 898,
    testStartIndex: 1_171,
    testStart: '2020-08-27',
    testEndIndex: 1_367,
    testEnd: '2021-06-09',
    testObservationCount: 197,
  },
  {
    ordinal: 3,
    trainingStartIndex: 273,
    trainingStart: '2017-02-02',
    trainingEndIndex: 1_367,
    trainingEnd: '2021-06-09',
    trainingObservationCount: 1_095,
    testStartIndex: 1_368,
    testStart: '2021-06-10',
    testEndIndex: 1_564,
    testEnd: '2022-03-21',
    testObservationCount: 197,
  },
  {
    ordinal: 4,
    trainingStartIndex: 273,
    trainingStart: '2017-02-02',
    trainingEndIndex: 1_564,
    trainingEnd: '2022-03-21',
    trainingObservationCount: 1_292,
    testStartIndex: 1_565,
    testStart: '2022-03-22',
    testEndIndex: 1_761,
    testEnd: '2022-12-30',
    testObservationCount: 197,
  },
] as const

const successOf = <A, E>(result: Result.Result<A, E>): A => {
  expect(Result.isSuccess(result)).toBe(true)
  if (Result.isFailure(result)) throw new Error('expected Result success')
  return result.success
}

describe('candidate development walk-forward protocol', () => {
  test('freezes the exact 1,762-session development calendar without touching the holdout', () => {
    const sessions = developmentSessions()
    const result = successOf(
      preflightCandidateDevelopment({
        officialSessions: sessions,
        signalSessionDates: officialMonthEndSignalDates(sessions),
        featureLookbackSessions: 252,
      }),
    )

    expect(sessions).toHaveLength(1_762)
    expect(sessions.at(0)).toBe('2016-01-04')
    expect(sessions.at(-1)).toBe('2022-12-30')
    expect(result.status).toBe('PASS')
  })

  test('computes exact first next-session executions for zero, 63, and 252-session lookbacks', () => {
    const sessions = developmentSessions()
    const signals = officialMonthEndSignalDates(sessions)
    const expected = [
      [0, 18, '2016-01-29', 19, '2016-02-01'],
      [63, 81, '2016-04-29', 82, '2016-05-02'],
      [252, 271, '2017-01-31', 272, '2017-02-01'],
    ] as const

    for (const [lookback, signalIndex, signalDate, executionIndex, executionDate] of expected) {
      expect(successOf(firstEligibleExecutionAfterLookback(sessions, signals, lookback))).toEqual({
        signalIndex,
        signalDate,
        executionIndex,
        executionDate,
      })
    }
  })

  test('uses deterministic end-anchored folds for every supported lookback', () => {
    const sessions = developmentSessions()
    const signals = officialMonthEndSignalDates(sessions)
    const expectedAvailability = [
      [0, 1_743, 254, 6],
      [63, 1_680, 191, 5],
      [252, 1_490, 1, 5],
    ] as const

    for (const [
      featureLookbackSessions,
      availableObservations,
      unusedEligibleObservations,
      availableFoldCount,
    ] of expectedAvailability) {
      const preflight = successOf(
        preflightCandidateDevelopment({
          officialSessions: sessions,
          signalSessionDates: signals,
          featureLookbackSessions,
        }),
      )
      expect(preflight).toMatchObject({
        status: 'PASS',
        requiredObservations: 1_489,
        availableObservations,
        availableFoldCount,
        requiredFoldCount: 5,
        unusedEligibleObservations,
        selectedObservationStartIndex: 273,
        selectedObservationStart: '2017-02-02',
        selectedObservationEndIndex: 1_761,
        selectedObservationEnd: '2022-12-30',
        folds: expectedFolds,
      })
    }
  })

  test('proves the official terminal geometry is impossible while the distinct development geometry is feasible', () => {
    const sessions = developmentSessions()
    const official = successOf(
      computeEndAnchoredWalkForwardBoundaries(sessions, 0, {
        minimumTrainingSessions: defaultQualificationStatisticsPolicy.walkForward.minimumTrainingSessions,
        testSessions: defaultQualificationStatisticsPolicy.walkForward.testSessions,
        requiredFolds: defaultQualificationStatisticsPolicy.walkForward.minimumFolds,
      }),
    )
    const development = successOf(
      computeEndAnchoredWalkForwardBoundaries(sessions, 272, candidateDevelopmentWalkForwardProtocol),
    )

    expect(official).toEqual({
      status: 'FAIL',
      reason: 'INSUFFICIENT_WALK_FORWARD_OBSERVATIONS',
      requiredObservations: 1_764,
      availableObservations: 1_762,
      availableFoldCount: 4,
      requiredFoldCount: 5,
      observationDeficit: 2,
    })
    expect(development).toMatchObject({
      status: 'PASS',
      requiredObservations: 1_489,
      availableObservations: 1_490,
      unusedEligibleObservations: 1,
      folds: expectedFolds,
    })
    expect(candidateDevelopmentStatisticsPolicy.walkForward.testSessions).toBe(197)
    expect(defaultQualificationStatisticsPolicy.walkForward.testSessions).toBe(252)
    expect(candidateDevelopmentStatisticsPolicy.bootstrap).toEqual(defaultQualificationStatisticsPolicy.bootstrap)
  })

  test('covers exact off-by-one pass/fail boundaries and an infeasible 198-session protocol', () => {
    const sessions = developmentSessions()
    expect(successOf(requiredObservationsForWalkForward(candidateDevelopmentWalkForwardProtocol))).toBe(1_489)
    expect(
      successOf(computeEndAnchoredWalkForwardBoundaries(sessions, 273, candidateDevelopmentWalkForwardProtocol)),
    ).toMatchObject({
      status: 'PASS',
      availableObservations: 1_489,
      unusedEligibleObservations: 0,
    })
    expect(
      successOf(computeEndAnchoredWalkForwardBoundaries(sessions, 274, candidateDevelopmentWalkForwardProtocol)),
    ).toEqual({
      status: 'FAIL',
      reason: 'INSUFFICIENT_WALK_FORWARD_OBSERVATIONS',
      requiredObservations: 1_489,
      availableObservations: 1_488,
      availableFoldCount: 4,
      requiredFoldCount: 5,
      observationDeficit: 1,
    })
    expect(
      successOf(
        computeEndAnchoredWalkForwardBoundaries(sessions, 272, {
          ...candidateDevelopmentWalkForwardProtocol,
          testSessions: 198,
        }),
      ),
    ).toEqual({
      status: 'FAIL',
      reason: 'INSUFFICIENT_WALK_FORWARD_OBSERVATIONS',
      requiredObservations: 1_494,
      availableObservations: 1_490,
      availableFoldCount: 4,
      requiredFoldCount: 5,
      observationDeficit: 4,
    })
  })

  test('fails closed for a calendar with the right endpoints, count, and order but wrong identity', () => {
    const sessions = [...developmentSessions()]
    sessions[102] = '2016-05-30'

    expect(
      preflightCandidateDevelopment({
        officialSessions: sessions,
        signalSessionDates: officialMonthEndSignalDates(sessions),
        featureLookbackSessions: 63,
      }),
    ).toMatchObject(
      Result.fail({
        _tag: 'CandidateDevelopmentCalendarMismatch',
        field: 'sessionsHash',
        expected: candidateDevelopmentCalendarContract.sessionsHash,
      }),
    )
  })

  test('returns typed failures for invalid geometry, excessive lookback, and a malformed later signal', () => {
    const sessions = developmentSessions()
    const signals = officialMonthEndSignalDates(sessions)

    expect(
      requiredObservationsForWalkForward({
        ...candidateDevelopmentWalkForwardProtocol,
        minimumTrainingSessions: 0,
      }),
    ).toEqual(
      Result.fail({
        _tag: 'CandidateDevelopmentGeometryPositiveIntegerRequired',
        field: 'minimumTrainingSessions',
        value: 0,
      }),
    )
    expect(firstEligibleExecutionAfterLookback(sessions, signals, 253)).toEqual(
      Result.fail({
        _tag: 'CandidateDevelopmentLookbackInvalid',
        featureLookbackSessions: 253,
        maximumFeatureLookbackSessions: 252,
      }),
    )
    expect(firstEligibleExecutionAfterLookback(sessions, ['2015-12-31', signals[0]], 0)).toEqual(
      Result.fail({
        _tag: 'CandidateDevelopmentSignalOutsideCalendar',
        signalDate: '2015-12-31',
      }),
    )
    expect(firstEligibleExecutionAfterLookback(sessions, signals.slice(1), 0)).toEqual(
      Result.fail({
        _tag: 'CandidateDevelopmentSignalScheduleMismatch',
        index: 0,
        expected: '2016-01-29',
        observed: '2016-02-29',
        expectedCount: signals.length,
        observedCount: signals.length - 1,
      }),
    )
  })

  test('stops before preregistration, data loading, and evaluation when the schedule is infeasible', async () => {
    const sessions = developmentSessions()
    let preregistrations = 0
    let loads = 0
    let evaluations = 0
    const exit = await Effect.runPromiseExit(
      runCandidateDevelopment(
        {
          officialSessions: sessions,
          signalSessionDates: [sessions[273]],
          featureLookbackSessions: 0,
        },
        {
          preregisterCandidate: () => {
            preregistrations += 1
            return Effect.succeed('registration')
          },
          loadDevelopmentData: () => {
            loads += 1
            return Effect.succeed('data')
          },
          evaluateDevelopment: () => {
            evaluations += 1
            return Effect.succeed('report')
          },
        },
      ),
    )

    expect(Exit.isFailure(exit)).toBe(true)
    expect(preregistrations).toBe(0)
    expect(loads).toBe(0)
    expect(evaluations).toBe(0)
  })

  test('preregisters, loads, and evaluates exactly once only after a passing preflight', async () => {
    const sessions = developmentSessions()
    let preregistrations = 0
    let loads = 0
    let evaluations = 0
    const report = await Effect.runPromise(
      runCandidateDevelopment(
        {
          officialSessions: sessions,
          signalSessionDates: officialMonthEndSignalDates(sessions),
          featureLookbackSessions: 252,
        },
        {
          preregisterCandidate: (preflight) => {
            preregistrations += 1
            return Effect.succeed(preflight.schemaVersion)
          },
          loadDevelopmentData: (registration, preflight) => {
            loads += 1
            return Effect.succeed(`${registration}:${preflight.selectedObservationStart}`)
          },
          evaluateDevelopment: (data, preflight) => {
            evaluations += 1
            return Effect.succeed(`${data}:${preflight.selectedObservationEnd}`)
          },
        },
      ),
    )

    expect(report).toBe('bayn.candidate-development-preflight.v1:2017-02-02:2022-12-30')
    expect(preregistrations).toBe(1)
    expect(loads).toBe(1)
    expect(evaluations).toBe(1)
  })
})
