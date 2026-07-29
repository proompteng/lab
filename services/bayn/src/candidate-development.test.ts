import { describe, expect, test } from 'bun:test'
import { Effect, Exit, Result } from 'effect'

import {
  bindCandidateDevelopmentAttempt,
  candidateDevelopmentAttemptHorizon,
  candidateDevelopmentBootstrapSamples,
  candidateDevelopmentCalendarContract,
  candidateDevelopmentDoubledCostContract,
  candidateDevelopmentStatisticsPolicy,
  candidateDevelopmentWalkForwardProtocol,
  computeEndAnchoredWalkForwardBoundaries,
  firstEligibleExecutionAfterLookback,
  identifyCandidateDevelopmentProtocol,
  officialMonthEndSignalDates,
  preflightCandidateDevelopment,
  requiredObservationsForWalkForward,
  runCandidateDevelopment,
  validateCandidateDevelopmentDoubledCostCausalPath,
} from './candidate-development'
import { defaultExecutionModel } from './execution-model'
import { canonicalHashV1Result } from './hash'
import { defaultQualificationStatisticsPolicy } from './qualification-statistics'
import type { IsoDate } from './schemas'
import type { SignalDecision, SimulatedOrder, SimulationTrace } from './types'

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

const candidate13Input = (sessions: readonly IsoDate[]) => ({
  candidateOrdinal: 13,
  priorTrialCount: 12,
  officialSessions: sessions,
  signalSessionDates: officialMonthEndSignalDates(sessions),
  featureLookbackSessions: 252,
})

const simulatedOrder = (overrides: Partial<SimulatedOrder> = {}): SimulatedOrder => ({
  id: 'a'.repeat(64),
  decisionId: 'b'.repeat(64),
  sessionDate: '2022-01-03',
  symbol: 'SPY',
  side: 'buy',
  requestedQuantityMicros: '1000000',
  filledQuantityMicros: '1000000',
  status: 'filled',
  rejectionReason: null,
  unfilledRemainder: 'none',
  ...overrides,
})

const signalDecision = (overrides: Partial<SignalDecision> = {}): SignalDecision => ({
  schemaVersion: 'bayn.risk-balanced-trend-decision-plan.v1',
  decisionId: 'b'.repeat(64),
  signalDate: '2021-12-31',
  executionDate: '2022-01-03',
  covarianceWindow: {
    returnCount: 63,
    firstSession: '2021-10-01',
    lastSession: '2021-12-31',
    sessionsHash: 'c'.repeat(64),
  },
  estimatedAnnualizedPortfolioVolatility: 0.16,
  exposureScale: 1,
  targetWeights: { SPY: 1 },
  signals: [
    {
      symbol: 'SPY',
      horizons: [{ horizonSessions: 21, return: 0.05, normalizedTrend: 0.5 }],
      dailyVolatility: 0.01,
      annualizedVolatility: 0.16,
      compositeScore: 0.5,
      positiveScore: 0.5,
      eligible: true,
      uncappedWeight: 1,
      cappedWeight: 1,
      targetWeight: 1,
    },
  ],
  ...overrides,
})

const simulationTrace = (costMultiplierMicros: string, order: SimulatedOrder = simulatedOrder()): SimulationTrace => ({
  schemaVersion: 'bayn.simulation-trace.v3',
  executionModel: defaultExecutionModel,
  costMultiplierMicros,
  orders: [order],
  cashChanges: [],
  dailyMarks: [],
})

const candidateDevelopmentEvaluation = <Report>(
  report: Report,
  stressedOrder: SimulatedOrder = simulatedOrder(),
  stressedSignalDecisions: readonly SignalDecision[] = [signalDecision()],
) => ({
  report,
  doubledCost: {
    baseline: {
      signalDecisions: [signalDecision()],
      simulation: simulationTrace(candidateDevelopmentDoubledCostContract.baselineCostMultiplierMicros),
    },
    stressed: {
      signalDecisions: stressedSignalDecisions,
      simulation: simulationTrace(candidateDevelopmentDoubledCostContract.stressedCostMultiplierMicros, stressedOrder),
    },
  },
})

describe('candidate development walk-forward protocol', () => {
  test('freezes the exact 1,762-session development calendar without touching the holdout', () => {
    const sessions = developmentSessions()
    const result = successOf(preflightCandidateDevelopment(candidate13Input(sessions)))

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
          candidateOrdinal: 13,
          priorTrialCount: 12,
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

  test('binds Candidate 13 and the deterministic bootstrap horizon before any effects', () => {
    const candidate13 = successOf(bindCandidateDevelopmentAttempt(13, 12))
    const horizon = successOf(bindCandidateDevelopmentAttempt(25, 24))

    expect(candidateDevelopmentBootstrapSamples).toBe(10_000)
    expect(candidateDevelopmentStatisticsPolicy.bootstrap.samples).toBe(10_000)
    expect(defaultQualificationStatisticsPolicy.bootstrap.samples).toBe(5_000)
    expect(bindCandidateDevelopmentAttempt(13, 11)).toEqual(
      Result.fail({
        _tag: 'CandidateDevelopmentAttemptLineageMismatch',
        candidateOrdinal: 13,
        priorTrialCount: 11,
        expectedCandidateOrdinal: 12,
      }),
    )
    expect(candidate13).toMatchObject({
      candidateOrdinal: 13,
      priorTrialCount: 12,
      bootstrapSamples: 10_000,
      tailSampleCount: 38,
      minimumTailSamples: 20,
      maximumCandidateOrdinal: 25,
    })
    expect(horizon.tailSampleCount).toBe(20)
    expect(Math.floor((candidateDevelopmentBootstrapSamples - 1) * (0.05 / 25))).toBe(19)
    expect(bindCandidateDevelopmentAttempt(26, 25)).toMatchObject(
      Result.fail({
        _tag: 'CandidateDevelopmentBootstrapTailInfeasible',
        candidateOrdinal: 26,
        priorTrialCount: 25,
        bootstrapSamples: 10_000,
        tailSampleCount: 19,
        minimumTailSamples: 20,
        maximumCandidateOrdinal: 25,
      }),
    )
  })

  test('binds one deterministic versioned protocol identity into preflight', () => {
    const candidate13 = successOf(bindCandidateDevelopmentAttempt(13, 12))
    const first = successOf(identifyCandidateDevelopmentProtocol(candidate13, 252))
    const second = successOf(identifyCandidateDevelopmentProtocol(candidate13, 252))
    const differentLookback = successOf(identifyCandidateDevelopmentProtocol(candidate13, 63))
    const next = successOf(
      identifyCandidateDevelopmentProtocol(successOf(bindCandidateDevelopmentAttempt(14, 13)), 252),
    )
    const preflight = successOf(preflightCandidateDevelopment(candidate13Input(developmentSessions())))

    expect(first).toEqual(second)
    expect(first).not.toEqual(differentLookback)
    expect(first).not.toEqual(next)
    expect(first.schemaVersion).toBe('bayn.candidate-development-protocol-identity.v1')
    expect(first.candidateOrdinal).toBe(13)
    expect(first.priorTrialCount).toBe(12)
    expect(first.featureLookbackSessions).toBe(252)
    expect(first.protocolHash).toBe('e9cc365a8b1c2cffe2aa37b496387000695e2a78d1093ad36e142261eab88454')
    expect(preflight).toMatchObject({
      status: 'PASS',
      schemaVersion: 'bayn.candidate-development-preflight.v2',
      attempt: {
        candidateOrdinal: 13,
        priorTrialCount: 12,
        tailSampleCount: 38,
      },
      protocolIdentity: first,
      doubledCostContract: candidateDevelopmentDoubledCostContract,
    })
  })

  test('rejects Candidate 12 quantity-changing doubled-cost reruns as protocol deviations', () => {
    const decisions = [signalDecision()]
    const baseline = {
      signalDecisions: decisions,
      simulation: simulationTrace(candidateDevelopmentDoubledCostContract.baselineCostMultiplierMicros),
    }
    const invariantStress = {
      signalDecisions: decisions,
      simulation: simulationTrace(candidateDevelopmentDoubledCostContract.stressedCostMultiplierMicros),
    }
    const quantityChangingStress = {
      signalDecisions: decisions,
      simulation: simulationTrace(
        candidateDevelopmentDoubledCostContract.stressedCostMultiplierMicros,
        simulatedOrder({ filledQuantityMicros: '900000', status: 'partially-filled', unfilledRemainder: 'canceled' }),
      ),
    }
    const signalChangingStress = {
      signalDecisions: [signalDecision({ exposureScale: 0.5, targetWeights: { SPY: 0.5 } })],
      simulation: simulationTrace(candidateDevelopmentDoubledCostContract.stressedCostMultiplierMicros),
    }

    expect(successOf(validateCandidateDevelopmentDoubledCostCausalPath(baseline, invariantStress))).toMatchObject({
      schemaVersion: 'bayn.candidate-development-doubled-cost-check.v1',
      status: 'PASS',
    })
    expect(validateCandidateDevelopmentDoubledCostCausalPath(baseline, quantityChangingStress)).toMatchObject(
      Result.fail({
        _tag: 'CandidateDevelopmentDoubledCostProtocolDeviation',
        disposition: 'INVALID_PROTOCOL_DEVIATION',
        reason: 'ORDER_QUANTITY_PATH_CHANGED',
      }),
    )
    expect(validateCandidateDevelopmentDoubledCostCausalPath(baseline, signalChangingStress)).toMatchObject(
      Result.fail({
        _tag: 'CandidateDevelopmentDoubledCostProtocolDeviation',
        disposition: 'INVALID_PROTOCOL_DEVIATION',
        reason: 'SIGNAL_DECISIONS_CHANGED',
      }),
    )
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
    expect(candidateDevelopmentStatisticsPolicy.bootstrap).toEqual({
      ...defaultQualificationStatisticsPolicy.bootstrap,
      samples: 10_000,
    })
    expect(defaultQualificationStatisticsPolicy).toMatchObject({
      schemaVersion: 'bayn.qualification-statistics-policy.v1',
      annualizationSessions: 252,
      confidence: {
        familyOneSidedAlpha: 0.05,
        multiplicityAdjustment: 'bonferroni',
        minimumTailSamples: 20,
      },
      bootstrap: {
        method: 'paired-complete-rebalance-blocks',
        samples: 5_000,
        seedNamespace: 'bayn-risk-balanced-trend-qualification-v1',
        lowerQuantile: 'nearest-rank',
      },
      walkForward: {
        method: 'expanding-origin',
        minimumTrainingSessions: 504,
        testSessions: 252,
        minimumFolds: 5,
        minimumPositiveFoldFraction: 0.6,
        maximumFoldDrawdown: 0.35,
      },
    })
    expect(successOf(canonicalHashV1Result(defaultQualificationStatisticsPolicy))).toBe(
      '8090c35a5e76e02bde5c74f7a71b5d0b005c3e0409165fde96f2748e827e88de',
    )
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
        candidateOrdinal: 13,
        priorTrialCount: 12,
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

  test('rejects the first infeasible ordinal before preregistration or data I/O', async () => {
    let preregistrations = 0
    let loads = 0
    let evaluations = 0
    const failure = await Effect.runPromise(
      Effect.flip(
        runCandidateDevelopment(
          {
            candidateOrdinal: candidateDevelopmentAttemptHorizon.maximumCandidateOrdinal + 1,
            priorTrialCount: candidateDevelopmentAttemptHorizon.maximumCandidateOrdinal,
            officialSessions: [],
            signalSessionDates: [],
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
              return Effect.succeed(candidateDevelopmentEvaluation('report'))
            },
          },
        ),
      ),
    )

    expect(failure).toMatchObject({
      _tag: 'CandidateDevelopmentPreflightInvalid',
      cause: {
        _tag: 'CandidateDevelopmentBootstrapTailInfeasible',
        candidateOrdinal: 26,
        tailSampleCount: 19,
      },
    })
    expect(preregistrations).toBe(0)
    expect(loads).toBe(0)
    expect(evaluations).toBe(0)
  })

  test('stops before preregistration, data loading, and evaluation when the schedule is infeasible', async () => {
    const sessions = developmentSessions()
    let preregistrations = 0
    let loads = 0
    let evaluations = 0
    const exit = await Effect.runPromiseExit(
      runCandidateDevelopment(
        {
          candidateOrdinal: 13,
          priorTrialCount: 12,
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
            return Effect.succeed(candidateDevelopmentEvaluation('report'))
          },
        },
      ),
    )

    expect(Exit.isFailure(exit)).toBe(true)
    expect(preregistrations).toBe(0)
    expect(loads).toBe(0)
    expect(evaluations).toBe(0)
  })

  test('rejects an evaluated report when doubled-cost quantities diverge', async () => {
    const sessions = developmentSessions()
    let preregistrations = 0
    let loads = 0
    let evaluations = 0
    const failure = await Effect.runPromise(
      Effect.flip(
        runCandidateDevelopment(candidate13Input(sessions), {
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
            return Effect.succeed(
              candidateDevelopmentEvaluation(
                'invalid-report',
                simulatedOrder({
                  filledQuantityMicros: '900000',
                  status: 'partially-filled',
                  unfilledRemainder: 'canceled',
                }),
              ),
            )
          },
        }),
      ),
    )

    expect(failure).toMatchObject({
      _tag: 'CandidateDevelopmentDoubledCostInvalid',
      cause: {
        _tag: 'CandidateDevelopmentDoubledCostProtocolDeviation',
        disposition: 'INVALID_PROTOCOL_DEVIATION',
        reason: 'ORDER_QUANTITY_PATH_CHANGED',
      },
    })
    expect(preregistrations).toBe(1)
    expect(loads).toBe(1)
    expect(evaluations).toBe(1)
  })

  test('preregisters, loads, and evaluates exactly once only after a passing preflight', async () => {
    const sessions = developmentSessions()
    let preregistrations = 0
    let loads = 0
    let evaluations = 0
    const report = await Effect.runPromise(
      runCandidateDevelopment(candidate13Input(sessions), {
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
          return Effect.succeed(candidateDevelopmentEvaluation(`${data}:${preflight.selectedObservationEnd}`))
        },
      }),
    )

    expect(report).toBe('bayn.candidate-development-preflight.v2:2017-02-02:2022-12-30')
    expect(preregistrations).toBe(1)
    expect(loads).toBe(1)
    expect(evaluations).toBe(1)
  })
})
