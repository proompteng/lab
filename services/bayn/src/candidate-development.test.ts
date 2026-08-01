import { describe, expect, test } from 'bun:test'
import { Effect, Exit, Result } from 'effect'

import {
  bindCandidateDevelopmentAttempt,
  buildCandidateDevelopmentComparisonSemanticsEvidence,
  candidateDevelopmentAttemptHorizon,
  candidateDevelopmentBootstrapSamples,
  candidateDevelopmentCalendarContract,
  candidateDevelopmentComparisonSemantics,
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
  validateCandidateDevelopmentComparisonSemanticsEvidence,
  validateCandidateDevelopmentComparisonSeriesBinding,
  validateCandidateDevelopmentDoubledCostCausalPath,
  type CandidateDevelopmentComparisonSemanticsEvidence,
  type CandidateDevelopmentPreflightPass,
} from './candidate-development'
import { makeStrategyProtocolHashResult } from './contracts'
import { defaultExecutionModel } from './execution-model'
import { canonicalHashV1Result } from './hash'
import { makeEvaluationIdentity } from './simulation'
import {
  defaultQualificationStatisticsPolicy,
  prepareQualificationSeries,
  type QualificationSeries,
} from './qualification-statistics'
import type { IsoDate } from './schemas'
import { fixtureProtocol, makeSnapshot, makeTestProvenance } from './test-fixtures'
import type { EvaluationResult, SignalDecision, SimulatedOrder, SimulationTrace } from './types'

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

const genuineProvenance = makeTestProvenance()
const genuineInputManifest = makeSnapshot().manifest
const genuineEvaluationIdentity = successOf(
  makeEvaluationIdentity(genuineInputManifest, fixtureProtocol, genuineProvenance),
)
const genuineStrategyProtocolHash = successOf(makeStrategyProtocolHashResult(genuineProvenance.strategy))

const candidate13Input = (sessions: readonly IsoDate[]) => ({
  candidateOrdinal: 13,
  priorTrialCount: 12,
  expectedStrategyProtocolHash: genuineStrategyProtocolHash,
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

const simulationTrace = (
  costMultiplierMicros: string,
  order: SimulatedOrder = simulatedOrder(),
  dailyMarks: SimulationTrace['dailyMarks'] = [],
): SimulationTrace => ({
  schemaVersion: 'bayn.simulation-trace.v3',
  executionModel: defaultExecutionModel,
  costMultiplierMicros,
  orders: [order],
  cashChanges: [],
  dailyMarks,
})

const performanceMetrics = () => ({
  observations: 1,
  totalReturn: 0,
  annualizedReturn: 0,
  annualizedVolatility: 0,
  sharpe: 0,
  maximumDrawdown: 0,
  annualTurnover: 0,
  totalFeesMicros: '0',
  totalSpreadCostMicros: '0',
  totalSlippageCostMicros: '0',
  totalCashYieldMicros: '0',
  endingEquityMicros: '1000000',
})

const evaluationSignalDecisions = (
  preflight: CandidateDevelopmentPreflightPass,
  sessions: readonly IsoDate[],
): readonly SignalDecision[] => {
  const officialSessions = developmentSessions()
  const includedSessions = new Set(sessions)
  return preflight.expectedRebalanceSchedule
    .filter(({ executionDate }) => includedSessions.has(executionDate))
    .map(({ executionDate, signalDate }, ordinal) => {
      const executionIndex = officialSessions.indexOf(executionDate)
      if (
        officialSessions.at(executionIndex - candidateDevelopmentWalkForwardProtocol.executionLagSessions) !==
        signalDate
      ) {
        throw new Error(`invalid official signal session for ${executionDate}`)
      }
      return signalDecision({
        decisionId: (ordinal + 1).toString(16).padStart(64, '0'),
        signalDate,
        executionDate,
      })
    })
}

const everyHundredthSignalDecisions = (
  preflight: CandidateDevelopmentPreflightPass,
  sessions: readonly IsoDate[],
): readonly SignalDecision[] => {
  const officialSessions = developmentSessions()
  return sessions
    .map((executionDate, index) => ({ executionDate, index }))
    .filter(({ index }) => index % 100 === 0)
    .map(({ executionDate, index }, ordinal) =>
      signalDecision({
        decisionId: (ordinal + 1).toString(16).padStart(64, '0'),
        signalDate:
          officialSessions.at(preflight.selectedObservationStartIndex + index - 1) ??
          preflight.selectedObservationStart,
        executionDate,
      }),
    )
}

const baselineEvaluation = (
  preflight: CandidateDevelopmentPreflightPass,
  sessions: readonly IsoDate[] = preflight.selectedObservationSessions,
  overrides: {
    readonly protocolHash?: string
    readonly signalDecisions?: readonly SignalDecision[]
  } = {},
): EvaluationResult => {
  const signalDecisions = overrides.signalDecisions ?? evaluationSignalDecisions(preflight, sessions)
  const dailyMarks = sessions.map((sessionDate, index) => ({
    sessionDate,
    equityMicros: '1000000',
    netReturn: index % 2 === 0 ? 0.0012 : 0.0008,
    turnoverMicros: '0',
    cumulativeTurnoverMicros: '0',
    feeMicros: '0',
    cumulativeFeesMicros: '0',
    spreadCostMicros: '0',
    cumulativeSpreadCostMicros: '0',
    slippageCostMicros: '0',
    cumulativeSlippageCostMicros: '0',
    cashYieldMicros: '0',
    cumulativeCashYieldMicros: '0',
    peakEquityMicros: '1000000',
    drawdown: 0,
    cashMicros: '0',
    positions: [
      {
        symbol: 'SPY',
        quantityMicros: '1000000',
        costBasisMicros: '1000000',
        priceMicros: '1000000',
        marketValueMicros: '1000000',
      },
    ],
  }))
  const performancePoint = (sessionDate: IsoDate, netReturn: number) => ({
    sessionDate,
    equityMicros: '1000000',
    netReturn,
    turnoverMicros: '0',
    cumulativeTurnoverMicros: '0',
    feeMicros: '0',
    cumulativeFeesMicros: '0',
    spreadCostMicros: '0',
    cumulativeSpreadCostMicros: '0',
    slippageCostMicros: '0',
    cumulativeSlippageCostMicros: '0',
    cashYieldMicros: '0',
    cumulativeCashYieldMicros: '0',
    peakEquityMicros: '1000000',
    drawdown: 0,
  })
  const buyAndHold = sessions.map((sessionDate, index) =>
    performancePoint(sessionDate, index % 2 === 0 ? 0.0009 : 0.0007),
  )
  const directVolTiming = sessions.map((sessionDate, index) =>
    performancePoint(sessionDate, index % 2 === 0 ? 0.0007 : 0.0005),
  )
  return {
    schemaVersion: 'bayn.evaluation.v6',
    runId: genuineEvaluationIdentity.runId,
    codeRevision: genuineProvenance.sourceRevision,
    protocolHash: overrides.protocolHash ?? genuineEvaluationIdentity.protocolHash,
    initialCapitalMicros: '1000000',
    inputManifest: genuineInputManifest,
    strategy: performanceMetrics(),
    buyAndHold: performanceMetrics(),
    directVolTiming: performanceMetrics(),
    doubleCostStrategy: performanceMetrics(),
    verdict: { status: 'PASS', gates: [] },
    events: [],
    simulation: simulationTrace(
      candidateDevelopmentDoubledCostContract.baselineCostMultiplierMicros,
      simulatedOrder(),
      dailyMarks,
    ),
    benchmarkSeries: {
      buyAndHold,
      directVolTiming,
      doubleCostStrategy: buyAndHold,
    },
    equitySeries: [],
    markedEquityReconciliation: {} as EvaluationResult['markedEquityReconciliation'],
    signalDecisions,
  }
}

const comparisonSeriesOf = (baseline: EvaluationResult): QualificationSeries =>
  successOf(prepareQualificationSeries(baseline))

let cachedComparisonEvidence:
  | {
      readonly candidateDevelopmentProtocolHash: string
      readonly strategyProtocolHash: string
      readonly baseline: EvaluationResult
      readonly series: QualificationSeries
      readonly evidence: CandidateDevelopmentComparisonSemanticsEvidence
    }
  | undefined

const exactComparisonFixture = (
  preflight: CandidateDevelopmentPreflightPass,
): {
  readonly baseline: EvaluationResult
  readonly series: QualificationSeries
  readonly evidence: CandidateDevelopmentComparisonSemanticsEvidence
} => {
  if (
    cachedComparisonEvidence?.candidateDevelopmentProtocolHash ===
      preflight.protocolIdentity.candidateDevelopmentProtocolHash &&
    cachedComparisonEvidence.strategyProtocolHash === preflight.expectedStrategyProtocolHash
  ) {
    return cachedComparisonEvidence
  }
  const baseline = baselineEvaluation(preflight)
  const series = comparisonSeriesOf(baseline)
  const evidence = successOf(buildCandidateDevelopmentComparisonSemanticsEvidence(preflight, series))
  cachedComparisonEvidence = {
    candidateDevelopmentProtocolHash: preflight.protocolIdentity.candidateDevelopmentProtocolHash,
    strategyProtocolHash: preflight.expectedStrategyProtocolHash,
    baseline,
    series,
    evidence,
  }
  return cachedComparisonEvidence
}

const candidateDevelopmentEvaluation = (
  preflight: CandidateDevelopmentPreflightPass,
  overrides: {
    readonly baseline?: EvaluationResult
    readonly stressedOrder?: SimulatedOrder
    readonly stressedSignalDecisions?: readonly SignalDecision[]
    readonly comparisonSemantics?: CandidateDevelopmentComparisonSemanticsEvidence
  } = {},
) => {
  const fixture = exactComparisonFixture(preflight)
  const baseline = overrides.baseline ?? fixture.baseline
  const comparisonSemantics =
    overrides.comparisonSemantics ??
    successOf(buildCandidateDevelopmentComparisonSemanticsEvidence(preflight, comparisonSeriesOf(baseline)))
  return {
    baseline,
    comparisonSemantics,
    stressed: {
      signalDecisions: overrides.stressedSignalDecisions ?? baseline.signalDecisions,
      simulation: simulationTrace(
        candidateDevelopmentDoubledCostContract.stressedCostMultiplierMicros,
        overrides.stressedOrder ?? baseline.simulation.orders.at(0) ?? simulatedOrder(),
      ),
    },
  }
}

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
          expectedStrategyProtocolHash: genuineStrategyProtocolHash,
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
    const first = successOf(identifyCandidateDevelopmentProtocol(candidate13, 252, genuineStrategyProtocolHash))
    const second = successOf(identifyCandidateDevelopmentProtocol(candidate13, 252, genuineStrategyProtocolHash))
    const differentLookback = successOf(
      identifyCandidateDevelopmentProtocol(candidate13, 63, genuineStrategyProtocolHash),
    )
    const differentStrategy = successOf(identifyCandidateDevelopmentProtocol(candidate13, 252, 'e'.repeat(64)))
    const next = successOf(
      identifyCandidateDevelopmentProtocol(
        successOf(bindCandidateDevelopmentAttempt(14, 13)),
        252,
        genuineStrategyProtocolHash,
      ),
    )
    const preflight = successOf(preflightCandidateDevelopment(candidate13Input(developmentSessions())))

    expect(first).toEqual(second)
    expect(first).not.toEqual(differentLookback)
    expect(first).not.toEqual(differentStrategy)
    expect(first).not.toEqual(next)
    expect(first.schemaVersion).toBe('bayn.candidate-development-protocol-identity.v2')
    expect(first.candidateOrdinal).toBe(13)
    expect(first.priorTrialCount).toBe(12)
    expect(first.featureLookbackSessions).toBe(252)
    expect(first.candidateDevelopmentProtocolHash).toMatch(/^[0-9a-f]{64}$/)
    expect(preflight).toMatchObject({
      status: 'PASS',
      schemaVersion: 'bayn.candidate-development-preflight.v4',
      attempt: {
        candidateOrdinal: 13,
        priorTrialCount: 12,
        tailSampleCount: 38,
      },
      protocolIdentity: first,
      expectedStrategyProtocolHash: genuineStrategyProtocolHash,
      doubledCostContract: candidateDevelopmentDoubledCostContract,
      comparisonSemantics: candidateDevelopmentComparisonSemantics,
    })
    if (preflight.status === 'FAIL') throw new Error('expected passing preflight')
    expect(preflight.selectedObservationSessions).toHaveLength(1_489)
    expect(preflight.selectedObservationSessions.at(0)).toBe('2017-02-02')
    expect(preflight.selectedObservationSessions.at(-1)).toBe('2022-12-30')
    expect(preflight.expectedRebalanceSchedule).toHaveLength(70)
    expect(preflight.expectedRebalanceSchedule.at(0)).toEqual({
      signalDate: '2017-02-28',
      executionDate: '2017-03-01',
    })
    expect(preflight.expectedRebalanceSchedule.at(-1)).toEqual({
      signalDate: '2022-11-30',
      executionDate: '2022-12-01',
    })
  })

  test('accepts exact benchmark-relative comparison semantics for every uncertainty and walk-forward gate', () => {
    const preflight = successOf(preflightCandidateDevelopment(candidate13Input(developmentSessions())))
    expect(preflight.status).toBe('PASS')
    if (preflight.status === 'FAIL') throw new Error('expected passing preflight')
    const { baseline, evidence, series } = exactComparisonFixture(preflight)

    expect(successOf(validateCandidateDevelopmentComparisonSeriesBinding(preflight, baseline, series))).toEqual(series)
    expect(successOf(validateCandidateDevelopmentComparisonSemanticsEvidence(preflight, series, evidence))).toEqual(
      evidence,
    )
    expect(evidence.analysis.bootstrap.selectedBenchmark).toBe('buy-and-hold')
    expect(evidence.analysis.walkForward.selectedBenchmark).toBe('buy-and-hold')
    expect(evidence.comparisonSemantics.gates.annualizedExcessReturnLowerBound).toMatchObject({
      baseline: 'selected-benchmark',
    })
    expect(evidence.comparisonSemantics.gates.sharpeDifferenceLowerBound).toMatchObject({
      baseline: 'selected-benchmark',
    })
    expect(evidence.comparisonSemantics.gates.walkForwardPositiveFraction).toMatchObject({
      baseline: 'selected-benchmark',
    })
    expect(evidence.comparisonSemantics.gates.walkForwardDrawdown).toMatchObject({
      baseline: 'candidate',
    })
  })

  test('binds the derived comparison series to the baseline run, exact preflight window, and rebalance schedule', () => {
    const preflight = successOf(preflightCandidateDevelopment(candidate13Input(developmentSessions())))
    expect(preflight.status).toBe('PASS')
    if (preflight.status === 'FAIL') throw new Error('expected passing preflight')
    const { baseline, series } = exactComparisonFixture(preflight)

    expect(successOf(validateCandidateDevelopmentComparisonSeriesBinding(preflight, baseline, series))).toEqual(series)
    expect(
      validateCandidateDevelopmentComparisonSeriesBinding(
        preflight,
        { ...baseline, protocolHash: 'e'.repeat(64) },
        series,
      ),
    ).toMatchObject(
      Result.fail({
        _tag: 'CandidateDevelopmentBaselineStrategyProtocolMismatch',
        expected: preflight.expectedStrategyProtocolHash,
        observed: 'e'.repeat(64),
      }),
    )
    expect(
      validateCandidateDevelopmentComparisonSeriesBinding(preflight, baseline, {
        ...series,
        runId: 'f'.repeat(64),
      }),
    ).toMatchObject(
      Result.fail({
        _tag: 'CandidateDevelopmentComparisonSeriesRunMismatch',
        expected: baseline.runId,
        observed: 'f'.repeat(64),
      }),
    )
    expect(
      validateCandidateDevelopmentComparisonSeriesBinding(preflight, baseline, {
        ...series,
        rebalanceExecutionDates: series.rebalanceExecutionDates.slice(1),
      }),
    ).toMatchObject({
      _tag: 'Failure',
      failure: {
        _tag: 'CandidateDevelopmentComparisonRebalanceScheduleMismatch',
        index: 0,
      },
    })
  })

  test('rejects an unrelated baseline window before returning a metric-bearing report', async () => {
    const sessions = developmentSessions()
    const preflight = successOf(preflightCandidateDevelopment(candidate13Input(sessions)))
    expect(preflight.status).toBe('PASS')
    if (preflight.status === 'FAIL') throw new Error('expected passing preflight')
    const unrelatedBaseline = baselineEvaluation(preflight, preflight.selectedObservationSessions.slice(0, 800))
    const unrelatedSeries = comparisonSeriesOf(unrelatedBaseline)
    const unrelatedEvidence = successOf(
      buildCandidateDevelopmentComparisonSemanticsEvidence(preflight, unrelatedSeries),
    )

    expect(
      validateCandidateDevelopmentComparisonSeriesBinding(preflight, unrelatedBaseline, unrelatedSeries),
    ).toMatchObject(
      Result.fail({
        _tag: 'CandidateDevelopmentComparisonSeriesWindowMismatch',
        index: 800,
        expected: preflight.selectedObservationSessions.at(800),
        observed: undefined,
        expectedCount: preflight.selectedObservationSessions.length,
        observedCount: 800,
      }),
    )

    const failure = await Effect.runPromise(
      Effect.flip(
        runCandidateDevelopment(candidate13Input(sessions), {
          preregisterCandidate: () => Effect.succeed('registration'),
          loadDevelopmentData: () => Effect.succeed('data'),
          evaluateDevelopment: () =>
            Effect.succeed(
              candidateDevelopmentEvaluation(preflight, {
                baseline: unrelatedBaseline,
                comparisonSemantics: unrelatedEvidence,
              }),
            ),
        }),
      ),
    )

    expect(failure).toMatchObject({
      _tag: 'CandidateDevelopmentComparisonSemanticsInvalid',
      cause: {
        _tag: 'CandidateDevelopmentComparisonSeriesWindowMismatch',
        index: 800,
        expectedCount: preflight.selectedObservationSessions.length,
        observedCount: 800,
      },
    })
  })

  test('rejects annualized-return evidence whose baseline is cash', () => {
    const preflight = successOf(preflightCandidateDevelopment(candidate13Input(developmentSessions())))
    expect(preflight.status).toBe('PASS')
    if (preflight.status === 'FAIL') throw new Error('expected passing preflight')
    const { evidence, series } = exactComparisonFixture(preflight)
    const cashRelative = {
      ...evidence,
      comparisonSemantics: {
        ...evidence.comparisonSemantics,
        gates: {
          ...evidence.comparisonSemantics.gates,
          annualizedExcessReturnLowerBound: {
            ...evidence.comparisonSemantics.gates.annualizedExcessReturnLowerBound,
            baseline: 'cash',
          },
        },
      },
    }

    expect(validateCandidateDevelopmentComparisonSemanticsEvidence(preflight, series, cashRelative)).toMatchObject(
      Result.fail({
        _tag: 'CandidateDevelopmentComparisonBaselineMismatch',
        gate: 'annualizedExcessReturnLowerBound',
        expected: 'selected-benchmark',
        observed: 'cash',
      }),
    )
  })

  test('rejects the previously accepted every-100th-session rebalance schedule', () => {
    const preflight = successOf(preflightCandidateDevelopment(candidate13Input(developmentSessions())))
    expect(preflight.status).toBe('PASS')
    if (preflight.status === 'FAIL') throw new Error('expected passing preflight')
    const baseline = baselineEvaluation(preflight, preflight.selectedObservationSessions, {
      signalDecisions: everyHundredthSignalDecisions(preflight, preflight.selectedObservationSessions),
    })
    const series = comparisonSeriesOf(baseline)

    expect(series.rebalanceExecutionDates).toEqual(baseline.signalDecisions.map((decision) => decision.executionDate))
    expect(series.rebalanceExecutionDates).not.toEqual(
      preflight.expectedRebalanceSchedule.map(({ executionDate }) => executionDate),
    )
    expect(validateCandidateDevelopmentComparisonSeriesBinding(preflight, baseline, series)).toMatchObject({
      _tag: 'Failure',
      failure: {
        _tag: 'CandidateDevelopmentComparisonSignalExecutionMismatch',
      },
    })
  })

  test('rejects shifted, missing, and extra rebalance executions against the preregistered schedule', () => {
    const preflight = successOf(preflightCandidateDevelopment(candidate13Input(developmentSessions())))
    expect(preflight.status).toBe('PASS')
    if (preflight.status === 'FAIL') throw new Error('expected passing preflight')
    const { baseline, series } = exactComparisonFixture(preflight)
    const expected = preflight.expectedRebalanceSchedule.map(({ executionDate }) => executionDate)
    const first = expected.at(0)
    const firstIndex = first === undefined ? -1 : preflight.selectedObservationSessions.indexOf(first)
    const shiftedFirst = preflight.selectedObservationSessions.at(firstIndex + 1)
    const last = expected.at(-1)
    if (first === undefined || shiftedFirst === undefined || last === undefined) {
      throw new Error('expected complete preregistered rebalance schedule')
    }

    const cases = [
      {
        name: 'shifted',
        dates: [shiftedFirst, ...expected.slice(1)],
        index: 0,
        expected: first,
        observed: shiftedFirst,
      },
      {
        name: 'missing',
        dates: expected.slice(0, -1),
        index: expected.length - 1,
        expected: last,
        observed: undefined,
      },
      {
        name: 'extra',
        dates: [...expected, preflight.selectedObservationEnd],
        index: expected.length,
        expected: undefined,
        observed: preflight.selectedObservationEnd,
      },
    ] as const

    for (const mismatch of cases) {
      expect(
        validateCandidateDevelopmentComparisonSeriesBinding(preflight, baseline, {
          ...series,
          rebalanceExecutionDates: mismatch.dates,
        }),
        mismatch.name,
      ).toMatchObject(
        Result.fail({
          _tag: 'CandidateDevelopmentComparisonRebalanceScheduleMismatch',
          index: mismatch.index,
          expected: mismatch.expected,
          observed: mismatch.observed,
          expectedCount: expected.length,
          observedCount: mismatch.dates.length,
        }),
      )
    }
  })

  test('rejects a shifted signal date even when every execution date is preregistered', () => {
    const preflight = successOf(preflightCandidateDevelopment(candidate13Input(developmentSessions())))
    expect(preflight.status).toBe('PASS')
    if (preflight.status === 'FAIL') throw new Error('expected passing preflight')
    const { baseline } = exactComparisonFixture(preflight)
    const first = baseline.signalDecisions.at(0)
    const shiftedSignalDate = preflight.selectedObservationSessions.at(16)
    if (first === undefined || shiftedSignalDate === undefined) {
      throw new Error('expected a baseline decision and shifted signal session')
    }
    expect(shiftedSignalDate).not.toBe(preflight.expectedRebalanceSchedule.at(0)?.signalDate)
    const shiftedBaseline = {
      ...baseline,
      signalDecisions: [{ ...first, signalDate: shiftedSignalDate }, ...baseline.signalDecisions.slice(1)],
    }
    const shiftedSeries = comparisonSeriesOf(shiftedBaseline)

    expect(shiftedSeries.rebalanceExecutionDates).toEqual(
      preflight.expectedRebalanceSchedule.map(({ executionDate }) => executionDate),
    )
    expect(
      validateCandidateDevelopmentComparisonSeriesBinding(preflight, shiftedBaseline, shiftedSeries),
    ).toMatchObject(
      Result.fail({
        _tag: 'CandidateDevelopmentComparisonSignalExecutionMismatch',
        index: 0,
        expected: preflight.expectedRebalanceSchedule.at(0),
        observed: {
          signalDate: shiftedSignalDate,
          executionDate: first.executionDate,
        },
      }),
    )
  })

  test('accepts a genuine strategy protocol identity independently of the development protocol identity', () => {
    const preflight = successOf(preflightCandidateDevelopment(candidate13Input(developmentSessions())))
    expect(preflight.status).toBe('PASS')
    if (preflight.status === 'FAIL') throw new Error('expected passing preflight')
    const { baseline } = exactComparisonFixture(preflight)
    const genuineBaseline = { ...baseline, protocolHash: genuineStrategyProtocolHash }
    const genuineSeries = comparisonSeriesOf(genuineBaseline)

    expect(genuineEvaluationIdentity.protocolHash).toBe(genuineStrategyProtocolHash)
    expect(genuineStrategyProtocolHash).not.toBe(preflight.protocolIdentity.candidateDevelopmentProtocolHash)
    expect(
      successOf(validateCandidateDevelopmentComparisonSeriesBinding(preflight, genuineBaseline, genuineSeries)),
    ).toEqual(genuineSeries)
  })

  test('rejects independent strategy and candidate-development identity drift', () => {
    const preflight = successOf(preflightCandidateDevelopment(candidate13Input(developmentSessions())))
    expect(preflight.status).toBe('PASS')
    if (preflight.status === 'FAIL') throw new Error('expected passing preflight')
    const { baseline, evidence, series } = exactComparisonFixture(preflight)

    expect(
      validateCandidateDevelopmentComparisonSeriesBinding(
        preflight,
        { ...baseline, protocolHash: 'e'.repeat(64) },
        series,
      ),
    ).toMatchObject(
      Result.fail({
        _tag: 'CandidateDevelopmentBaselineStrategyProtocolMismatch',
        expected: genuineStrategyProtocolHash,
        observed: 'e'.repeat(64),
      }),
    )
    expect(
      validateCandidateDevelopmentComparisonSemanticsEvidence(preflight, series, {
        ...evidence,
        candidateDevelopmentProtocolHash: 'e'.repeat(64),
      }),
    ).toMatchObject(
      Result.fail({
        _tag: 'CandidateDevelopmentComparisonDevelopmentProtocolMismatch',
        expected: preflight.protocolIdentity.candidateDevelopmentProtocolHash,
        observed: 'e'.repeat(64),
      }),
    )
    expect(
      validateCandidateDevelopmentComparisonSemanticsEvidence(preflight, series, {
        ...evidence,
        strategyProtocolHash: 'e'.repeat(64),
      }),
    ).toMatchObject(
      Result.fail({
        _tag: 'CandidateDevelopmentComparisonStrategyProtocolMismatch',
        expected: genuineStrategyProtocolHash,
        observed: 'e'.repeat(64),
      }),
    )
  })

  test('rejects walk-forward positive-fold evidence whose baseline is cash', () => {
    const preflight = successOf(preflightCandidateDevelopment(candidate13Input(developmentSessions())))
    expect(preflight.status).toBe('PASS')
    if (preflight.status === 'FAIL') throw new Error('expected passing preflight')
    const { evidence, series } = exactComparisonFixture(preflight)
    const cashRelative = {
      ...evidence,
      comparisonSemantics: {
        ...evidence.comparisonSemantics,
        gates: {
          ...evidence.comparisonSemantics.gates,
          walkForwardPositiveFraction: {
            ...evidence.comparisonSemantics.gates.walkForwardPositiveFraction,
            baseline: 'cash',
          },
        },
      },
    }

    expect(validateCandidateDevelopmentComparisonSemanticsEvidence(preflight, series, cashRelative)).toMatchObject(
      Result.fail({
        _tag: 'CandidateDevelopmentComparisonBaselineMismatch',
        gate: 'walkForwardPositiveFraction',
        expected: 'selected-benchmark',
        observed: 'cash',
      }),
    )
  })

  test('rejects a selected benchmark that contradicts the bound cash-adjusted Sharpe rule', () => {
    const preflight = successOf(preflightCandidateDevelopment(candidate13Input(developmentSessions())))
    expect(preflight.status).toBe('PASS')
    if (preflight.status === 'FAIL') throw new Error('expected passing preflight')
    const { evidence, series } = exactComparisonFixture(preflight)
    const mismatched = {
      ...evidence,
      analysis: {
        ...evidence.analysis,
        bootstrap: {
          ...evidence.analysis.bootstrap,
          selectedBenchmark: 'direct-volatility-timing',
        },
      },
    }

    expect(validateCandidateDevelopmentComparisonSemanticsEvidence(preflight, series, mismatched)).toMatchObject(
      Result.fail({
        _tag: 'CandidateDevelopmentSelectedBenchmarkComparisonMismatch',
        expected: 'buy-and-hold',
        observedBootstrap: 'direct-volatility-timing',
        observedWalkForward: 'buy-and-hold',
      }),
    )
  })

  test('rejects a cash-relative annualized result even when its baseline label claims selected benchmark', () => {
    const preflight = successOf(preflightCandidateDevelopment(candidate13Input(developmentSessions())))
    expect(preflight.status).toBe('PASS')
    if (preflight.status === 'FAIL') throw new Error('expected passing preflight')
    const { evidence, series } = exactComparisonFixture(preflight)
    const cashRelative = {
      ...evidence,
      analysis: {
        ...evidence.analysis,
        bootstrap: {
          ...evidence.analysis.bootstrap,
          annualizedReturnDifferenceLowerBound: 0.2268,
        },
      },
    }

    expect(validateCandidateDevelopmentComparisonSemanticsEvidence(preflight, series, cashRelative)).toMatchObject(
      Result.fail({
        _tag: 'CandidateDevelopmentAnnualizedReturnComparisonMismatch',
        expected: evidence.analysis.bootstrap.annualizedReturnDifferenceLowerBound,
        observed: 0.2268,
      }),
    )
  })

  test('rejects walk-forward results that were computed against cash rather than the selected benchmark', () => {
    const preflight = successOf(preflightCandidateDevelopment(candidate13Input(developmentSessions())))
    expect(preflight.status).toBe('PASS')
    if (preflight.status === 'FAIL') throw new Error('expected passing preflight')
    const { evidence, series } = exactComparisonFixture(preflight)
    const firstFold = evidence.analysis.walkForward.folds.at(0)
    if (firstFold === undefined) throw new Error('expected a walk-forward fold')
    const cashRelative = {
      ...evidence,
      analysis: {
        ...evidence.analysis,
        walkForward: {
          ...evidence.analysis.walkForward,
          folds: [
            { ...firstFold, returnDifference: firstFold.strategyReturn },
            ...evidence.analysis.walkForward.folds.slice(1),
          ],
        },
      },
    }

    expect(validateCandidateDevelopmentComparisonSemanticsEvidence(preflight, series, cashRelative)).toMatchObject({
      _tag: 'Failure',
      failure: { _tag: 'CandidateDevelopmentComparisonEvidenceMismatch' },
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

  test('allows doubled-cost accounting to change while preserving causal signal and quantity invariants', () => {
    const decisions = [signalDecision()]
    const baselineSimulation = simulationTrace(candidateDevelopmentDoubledCostContract.baselineCostMultiplierMicros)
    const stressedSimulation: SimulationTrace = {
      ...baselineSimulation,
      costMultiplierMicros: candidateDevelopmentDoubledCostContract.stressedCostMultiplierMicros,
      cashChanges: [
        {
          id: 'c'.repeat(64),
          sourceKind: 'fee',
          sourceId: 'd'.repeat(64),
          sessionDate: '2022-01-03',
          amountMicros: '-1000',
          cashAfterMicros: '999000',
        },
      ],
    }

    const pass = successOf(
      validateCandidateDevelopmentDoubledCostCausalPath(
        { signalDecisions: decisions, simulation: baselineSimulation },
        { signalDecisions: decisions, simulation: stressedSimulation },
      ),
    )

    expect(pass.status).toBe('PASS')
    expect(stressedSimulation.cashChanges).not.toEqual(baselineSimulation.cashChanges)
    expect(pass.signalDecisionsHash).toBe(successOf(canonicalHashV1Result(decisions)))
    expect(pass.orderQuantityPathHash).toBe(
      successOf(
        canonicalHashV1Result(
          baselineSimulation.orders.map(
            ({
              decisionId,
              sessionDate,
              symbol,
              side,
              requestedQuantityMicros,
              filledQuantityMicros,
              status,
              rejectionReason,
              unfilledRemainder,
            }) => ({
              decisionId,
              sessionDate,
              symbol,
              side,
              requestedQuantityMicros,
              filledQuantityMicros,
              status,
              rejectionReason,
              unfilledRemainder,
            }),
          ),
        ),
      ),
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
        expectedStrategyProtocolHash: genuineStrategyProtocolHash,
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
            expectedStrategyProtocolHash: genuineStrategyProtocolHash,
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
            evaluateDevelopment: (_data, preflight) => {
              evaluations += 1
              return Effect.succeed(candidateDevelopmentEvaluation(preflight))
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

  test('rejects an invalid expected strategy protocol hash before preregistration or data I/O', async () => {
    const sessions = developmentSessions()
    let preregistrations = 0
    let loads = 0
    let evaluations = 0
    const failure = await Effect.runPromise(
      Effect.flip(
        runCandidateDevelopment(
          { ...candidate13Input(sessions), expectedStrategyProtocolHash: 'not-a-sha256' },
          {
            preregisterCandidate: () => {
              preregistrations += 1
              return Effect.succeed('registration')
            },
            loadDevelopmentData: () => {
              loads += 1
              return Effect.succeed('data')
            },
            evaluateDevelopment: (_data, preflight) => {
              evaluations += 1
              return Effect.succeed(candidateDevelopmentEvaluation(preflight))
            },
          },
        ),
      ),
    )

    expect(failure).toEqual({
      _tag: 'CandidateDevelopmentPreflightInvalid',
      cause: {
        _tag: 'CandidateDevelopmentStrategyProtocolHashInvalid',
        observed: 'not-a-sha256',
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
          expectedStrategyProtocolHash: genuineStrategyProtocolHash,
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
          evaluateDevelopment: (_data, preflight) => {
            evaluations += 1
            return Effect.succeed(candidateDevelopmentEvaluation(preflight))
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
          evaluateDevelopment: (_data, preflight) => {
            evaluations += 1
            return Effect.succeed(
              candidateDevelopmentEvaluation(preflight, {
                stressedOrder: simulatedOrder({
                  filledQuantityMicros: '900000',
                  status: 'partially-filled',
                  unfilledRemainder: 'canceled',
                }),
              }),
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
        evaluateDevelopment: (_data, preflight) => {
          evaluations += 1
          return Effect.succeed(candidateDevelopmentEvaluation(preflight))
        },
      }),
    )

    expect(report).toMatchObject({
      schemaVersion: 'bayn.candidate-development-report.v2',
      protocolIdentity: {
        candidateOrdinal: 13,
        priorTrialCount: 12,
        candidateDevelopmentProtocolHash: expect.stringMatching(/^[0-9a-f]{64}$/),
      },
      comparisonSemantics: {
        candidateDevelopmentProtocolHash: expect.stringMatching(/^[0-9a-f]{64}$/),
        strategyProtocolHash: genuineStrategyProtocolHash,
        analysis: {
          bootstrap: { selectedBenchmark: 'buy-and-hold' },
          walkForward: { selectedBenchmark: 'buy-and-hold' },
        },
      },
      doubledCostContract: candidateDevelopmentDoubledCostContract,
      doubledCost: {
        baseline: {
          simulation: { costMultiplierMicros: candidateDevelopmentDoubledCostContract.baselineCostMultiplierMicros },
        },
        stressed: {
          simulation: { costMultiplierMicros: candidateDevelopmentDoubledCostContract.stressedCostMultiplierMicros },
        },
      },
    })
    expect(preregistrations).toBe(1)
    expect(loads).toBe(1)
    expect(evaluations).toBe(1)
  })

  test('does not return an evaluated report when comparison semantics mismatch the preflight', async () => {
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
          evaluateDevelopment: (_data, preflight) => {
            evaluations += 1
            const evidence = exactComparisonFixture(preflight).evidence
            const cashRelative = {
              ...evidence,
              analysis: {
                ...evidence.analysis,
                bootstrap: {
                  ...evidence.analysis.bootstrap,
                  annualizedReturnDifferenceLowerBound: 0.2268,
                },
              },
            } as unknown as CandidateDevelopmentComparisonSemanticsEvidence
            return Effect.succeed(
              candidateDevelopmentEvaluation(preflight, {
                comparisonSemantics: cashRelative,
              }),
            )
          },
        }),
      ),
    )

    expect(failure).toMatchObject({
      _tag: 'CandidateDevelopmentComparisonSemanticsInvalid',
      cause: {
        _tag: 'CandidateDevelopmentAnnualizedReturnComparisonMismatch',
        observed: 0.2268,
      },
    })
    expect(preregistrations).toBe(1)
    expect(loads).toBe(1)
    expect(evaluations).toBe(1)
  })
})
