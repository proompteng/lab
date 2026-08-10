import assert from 'node:assert/strict'

import { describe, expect, test } from 'bun:test'

import { Result, Schema } from 'effect'

import {
  QualificationAnalysisSchema,
  QualificationStatisticsPolicySchema,
  analyzeQualification,
  analyzeQualificationAtOrdinal,
  analyzeQualificationInput,
  analyzeSelectedBenchmarkComparison,
  calculateQualificationPower,
  defaultQualificationStatisticsPolicy,
  makeQualificationStatisticsPolicy,
  prepareQualificationSeries,
  qualificationPolicyMaximumCandidateOrdinal,
  qualificationTailCapacityForOrdinal,
  qualificationSelectedBenchmarkRule,
  selectQualificationBenchmarkFromCashAdjustedSharpes,
  type QualificationSeries,
  type QualificationStatisticsPolicy,
} from './qualification-statistics'
import { canonicalHashV1 } from './hash'
import { buildQualificationGates, decideQualification } from './qualification-statistics/decision'
import {
  annualizedSharpe,
  compoundedReturn,
  maximumDrawdown,
  mean,
  nearestRankLowerQuantile,
  roundStatistic,
  sampleStandardDeviation,
} from './qualification-statistics/numerical-methods'
import { evaluateRiskBalancedTrend } from './risk-balanced-trend'
import { fixtureProtocol, makeSnapshot, makeTestProvenance } from './test-fixtures'

const successOf = <A, E>(result: Result.Result<A, E>): A => {
  assert(Result.isSuccess(result), 'qualification statistics fixture must succeed')
  return result.success
}

const isoDate = (index: number): `${number}-${number}-${number}` => {
  const date = new Date('2000-01-01T00:00:00.000Z')
  date.setUTCDate(date.getUTCDate() + index)
  return date.toISOString().slice(0, 10) as `${number}-${number}-${number}`
}

const makeSeries = (
  options: {
    readonly blocks?: number
    readonly trailingSessions?: number
    readonly strategyMean?: number
    readonly buyAndHoldMean?: number
    readonly directVolatilityMean?: number
    readonly strategyShock?: Readonly<Record<number, number>>
  } = {},
): QualificationSeries => {
  const blocks = options.blocks ?? 90
  const trailingSessions = options.trailingSessions ?? 10
  const observations = Array.from({ length: blocks * 21 + trailingSessions }, (_, index) => {
    const sharedNoise = (((index * 17) % 23) - 11) / 100_000
    return {
      sessionDate: isoDate(index),
      strategyReturn: (options.strategyMean ?? 0.0005) + sharedNoise + (options.strategyShock?.[index] ?? 0),
      cashReturn: 0,
      buyAndHoldReturn: (options.buyAndHoldMean ?? 0.00015) + sharedNoise * 1.1,
      directVolatilityReturn: (options.directVolatilityMean ?? 0.0001) + sharedNoise * 0.8,
    }
  })
  return {
    schemaVersion: 'bayn.qualification-series.v1',
    runId: 'a'.repeat(64),
    observations,
    rebalanceExecutionDates: Array.from({ length: blocks + 1 }, (_, index) => isoDate(index * 21)),
  }
}

const policy = (overrides: Partial<QualificationStatisticsPolicy> = {}): QualificationStatisticsPolicy => ({
  ...defaultQualificationStatisticsPolicy,
  ...overrides,
  confidence: {
    ...defaultQualificationStatisticsPolicy.confidence,
    minimumTailSamples: 20,
    ...overrides.confidence,
  },
  bootstrap: {
    ...defaultQualificationStatisticsPolicy.bootstrap,
    samples: 1_000,
    ...overrides.bootstrap,
  },
  power: { ...defaultQualificationStatisticsPolicy.power, ...overrides.power },
  walkForward: { ...defaultQualificationStatisticsPolicy.walkForward, ...overrides.walkForward },
  cashReturn: { ...defaultQualificationStatisticsPolicy.cashReturn, ...overrides.cashReturn },
})

describe('qualification statistics policy and power', () => {
  test('derives one exact policy for the declared ordinal horizon and preserves historical v1 decoding', () => {
    const policyFromHorizon = successOf(
      makeQualificationStatisticsPolicy({
        maximumCandidateOrdinal: qualificationPolicyMaximumCandidateOrdinal,
      }),
    )

    expect(policyFromHorizon).toEqual(defaultQualificationStatisticsPolicy)
    expect(defaultQualificationStatisticsPolicy).toMatchObject({
      schemaVersion: 'bayn.qualification-statistics-policy.v1',
      confidence: {
        familyOneSidedAlpha: 0.05,
        multiplicityAdjustment: 'bonferroni',
        minimumTailSamples: 20,
      },
      bootstrap: { samples: 10_000 },
    })
    for (
      let candidateOrdinal = 1;
      candidateOrdinal <= qualificationPolicyMaximumCandidateOrdinal;
      candidateOrdinal += 1
    ) {
      const capacity = qualificationTailCapacityForOrdinal(defaultQualificationStatisticsPolicy, candidateOrdinal)
      expect(capacity.candidateOrdinal).toBe(candidateOrdinal)
      expect(capacity.tailSampleCount).toBeGreaterThanOrEqual(20)
      expect(capacity.minimumTailSamples).toBe(20)
    }
    expect(qualificationTailCapacityForOrdinal(defaultQualificationStatisticsPolicy, 21)).toMatchObject({
      candidateOrdinal: 21,
      adjustedOneSidedAlpha: 0.05 / 21,
      tailSampleCount: 23,
    })

    const historicalPolicy: QualificationStatisticsPolicy = {
      ...defaultQualificationStatisticsPolicy,
      bootstrap: { ...defaultQualificationStatisticsPolicy.bootstrap, samples: 5_000 },
    }
    const decode = Schema.decodeUnknownSync(QualificationStatisticsPolicySchema, { onExcessProperty: 'error' })
    expect(decode(historicalPolicy)).toEqual(historicalPolicy)
  })

  test('rejects policy options that cannot produce schema-valid policies', () => {
    expect(Result.isFailure(makeQualificationStatisticsPolicy({ maximumCandidateOrdinal: 0 }))).toBe(true)
    expect(Result.isFailure(makeQualificationStatisticsPolicy({ maximumCandidateOrdinal: 1.5 }))).toBe(true)
    expect(Result.isFailure(makeQualificationStatisticsPolicy({ maximumCandidateOrdinal: 251 }))).toBe(true)
    expect(
      Result.isFailure(
        makeQualificationStatisticsPolicy({
          maximumCandidateOrdinal: qualificationPolicyMaximumCandidateOrdinal,
          walkForward: { testSessions: 0 },
        }),
      ),
    ).toBe(true)
    expect(
      Result.isFailure(
        makeQualificationStatisticsPolicy({
          maximumCandidateOrdinal: qualificationPolicyMaximumCandidateOrdinal,
          walkForward: { minimumFolds: 1.5 },
        }),
      ),
    ).toBe(true)
  })

  test('strictly decodes the precommit and rejects invalid or unknown fields', () => {
    const decode = Schema.decodeUnknownSync(QualificationStatisticsPolicySchema, {
      onExcessProperty: 'error',
    })

    expect(decode(defaultQualificationStatisticsPolicy)).toEqual(defaultQualificationStatisticsPolicy)
    expect(() =>
      decode({
        ...defaultQualificationStatisticsPolicy,
        power: {
          ...defaultQualificationStatisticsPolicy.power,
          minimumDetectableAnnualizedExcessReturn: 0,
        },
      }),
    ).toThrow()
    expect(() => decode({ ...defaultQualificationStatisticsPolicy, futureField: true })).toThrow()
  })

  test('precommits 69 complete blocks and 1,449 sessions and is monotone in effect size', () => {
    const baseline = successOf(calculateQualificationPower(defaultQualificationStatisticsPolicy, 0, 0))
    const smallerEffect = successOf(
      calculateQualificationPower(
        policy({
          power: {
            ...defaultQualificationStatisticsPolicy.power,
            minimumDetectableAnnualizedExcessReturn: 0.02,
          },
        }),
        0,
        0,
      ),
    )
    const largerEffect = successOf(
      calculateQualificationPower(
        policy({
          power: {
            ...defaultQualificationStatisticsPolicy.power,
            minimumDetectableAnnualizedExcessReturn: 0.05,
          },
        }),
        0,
        0,
      ),
    )

    expect(baseline).toMatchObject({
      requiredCompleteRebalanceBlocks: 69,
      requiredSessions: 1_449,
      standardizedEffect: 0.3,
      sufficient: false,
    })
    expect(smallerEffect.requiredCompleteRebalanceBlocks).toBeGreaterThan(baseline.requiredCompleteRebalanceBlocks)
    expect(largerEffect.requiredCompleteRebalanceBlocks).toBeLessThan(baseline.requiredCompleteRebalanceBlocks)
  })
})

describe('pure numerical and decision kernels', () => {
  test('defines degenerate samples without ambient state or non-finite output', () => {
    expect(mean([])).toBe(0)
    expect(sampleStandardDeviation([])).toBe(0)
    expect(sampleStandardDeviation([0.25])).toBe(0)
    expect(annualizedSharpe([0.25], 252)).toBe(0)
    expect(nearestRankLowerQuantile([], 0.05)).toBe(0)
    expect(nearestRankLowerQuantile([3, 1, 2], 0.5)).toBe(2)
    expect(compoundedReturn([])).toBe(0)
    expect(successOf(maximumDrawdown([]))).toBe(0)
    expect(successOf(maximumDrawdown([0.1, -0.5, 0.1]))).toBe(0.5)
    for (const value of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      expect(roundStatistic(value)).toEqual(
        Result.fail({ _tag: 'QualificationStatisticNotFinite', operation: 'round', value }),
      )
    }
  })

  test('aggregates gates and reasons with insufficient evidence taking precedence over rejection', () => {
    const analysis = successOf(analyzeQualification(makeSeries({ blocks: 30 }), policy(), []))
    const input = {
      policy: analysis.policy,
      power: analysis.power,
      bootstrap: analysis.bootstrap,
      walkForward: analysis.walkForward,
    }

    expect(buildQualificationGates(input)).toEqual(analysis.gates)
    expect(decideQualification(input)).toEqual({
      gates: analysis.gates,
      status: analysis.status,
      reasonCodes: analysis.reasonCodes,
    })
    expect(analysis.status).toBe('INSUFFICIENT')
    expect(analysis.bootstrap.annualizedExcessReturnLowerBound).toBeGreaterThan(0)
  })

  test('classifies every gate boundary from explicit evidence', () => {
    const baseline = successOf(analyzeQualification(makeSeries(), policy(), []))
    const baseInput = {
      policy: baseline.policy,
      power: baseline.power,
      bootstrap: baseline.bootstrap,
      walkForward: baseline.walkForward,
    }
    const cases = [
      {
        name: 'power blocks one below',
        input: {
          ...baseInput,
          power: {
            ...baseInput.power,
            availableCompleteRebalanceBlocks: baseInput.power.requiredCompleteRebalanceBlocks - 1,
            sufficient: false,
          },
        },
        status: 'INSUFFICIENT',
        reason: 'INSUFFICIENT_POWER_BLOCKS',
      },
      {
        name: 'power sessions one below',
        input: {
          ...baseInput,
          power: {
            ...baseInput.power,
            availableCompleteSessions: baseInput.power.requiredSessions - 1,
            sufficient: false,
          },
        },
        status: 'INSUFFICIENT',
        reason: 'INSUFFICIENT_POWER_SESSIONS',
      },
      {
        name: 'tail one below',
        input: {
          ...baseInput,
          bootstrap: {
            ...baseInput.bootstrap,
            tailSampleCount: baseInput.bootstrap.minimumTailSamples - 1,
            tailResolutionSufficient: false,
          },
        },
        status: 'INSUFFICIENT',
        reason: 'INSUFFICIENT_BOOTSTRAP_TAIL',
      },
      {
        name: 'walk-forward folds one below',
        input: {
          ...baseInput,
          walkForward: {
            ...baseInput.walkForward,
            folds: baseInput.walkForward.folds.slice(0, baseInput.walkForward.requiredFolds - 1),
            sufficient: false,
          },
        },
        status: 'INSUFFICIENT',
        reason: 'INSUFFICIENT_WALK_FORWARD_FOLDS',
      },
      {
        name: 'excess exactly zero',
        input: { ...baseInput, bootstrap: { ...baseInput.bootstrap, annualizedExcessReturnLowerBound: 0 } },
        status: 'REJECTED',
        reason: 'NON_POSITIVE_EXCESS_RETURN_LCB',
      },
      {
        name: 'sharpe exactly zero',
        input: { ...baseInput, bootstrap: { ...baseInput.bootstrap, sharpeDifferenceLowerBound: 0 } },
        status: 'REJECTED',
        reason: 'NON_POSITIVE_SHARPE_DIFFERENCE_LCB',
      },
      {
        name: 'positive fraction one epsilon below',
        input: {
          ...baseInput,
          walkForward: {
            ...baseInput.walkForward,
            positiveFoldFraction: baseInput.walkForward.requiredPositiveFoldFraction - Number.EPSILON,
          },
        },
        status: 'REJECTED',
        reason: 'WALK_FORWARD_POSITIVE_FRACTION_FAILED',
      },
      {
        name: 'drawdown above limit',
        input: {
          ...baseInput,
          walkForward: {
            ...baseInput.walkForward,
            allDrawdownsWithinLimit: false,
            maximumFoldDrawdown: baseInput.policy.walkForward.maximumFoldDrawdown + Number.EPSILON,
          },
        },
        status: 'REJECTED',
        reason: 'WALK_FORWARD_DRAWDOWN_FAILED',
      },
    ] as const

    for (const item of cases) {
      const decision = decideQualification(item.input)
      expect(decision.status, item.name).toBe(item.status)
      expect(decision.reasonCodes, item.name).toContain(item.reason)
    }

    const equality = decideQualification({
      ...baseInput,
      walkForward: {
        ...baseInput.walkForward,
        positiveFoldFraction: baseInput.walkForward.requiredPositiveFoldFraction,
        maximumFoldDrawdown: baseInput.policy.walkForward.maximumFoldDrawdown,
        allDrawdownsWithinLimit: true,
      },
    })
    expect(equality.status).toBe('PASS')
  })
})

describe('deterministic paired block bootstrap', () => {
  test('uses one executable cash-adjusted Sharpe selection rule with buy-and-hold as the exact tie-break', () => {
    expect(qualificationSelectedBenchmarkRule).toEqual({
      schemaVersion: 'bayn.qualification-selected-benchmark-rule.v1',
      eligibleBenchmarks: ['buy-and-hold', 'direct-volatility-timing'],
      score: 'cash-adjusted-annualized-sharpe',
      selection: 'maximum',
      tieBreak: 'buy-and-hold',
    })
    expect(
      selectQualificationBenchmarkFromCashAdjustedSharpes({
        buyAndHold: 0.6,
        directVolatilityTiming: 0.7,
      }),
    ).toEqual({ name: 'direct-volatility-timing', sharpe: 0.7 })
    expect(
      selectQualificationBenchmarkFromCashAdjustedSharpes({
        buyAndHold: 0.7,
        directVolatilityTiming: 0.7,
      }),
    ).toEqual({ name: 'buy-and-hold', sharpe: 0.7 })
  })

  test('uses complete rebalance intervals, excludes the trailing interval, and reproduces a golden result', () => {
    const input = makeSeries()
    const first = successOf(analyzeQualification(input, policy(), []))
    const second = successOf(analyzeQualification(structuredClone(input), policy(), []))

    expect(first.completeBlocks).toHaveLength(90)
    expect(first.completeBlocks[0]).toMatchObject({
      startSession: isoDate(0),
      endSession: isoDate(20),
      nextRebalanceSession: isoDate(21),
      observationCount: 21,
    })
    expect(first.completeBlocks.at(-1)).toMatchObject({
      startSession: isoDate(89 * 21),
      endSession: isoDate(90 * 21 - 1),
      nextRebalanceSession: isoDate(90 * 21),
    })
    expect(first.bootstrap.producedSamples).toBe(1_000)
    expect(first.bootstrap.samplesHash).toBe('e7e3f0e6947361137b7eb2376100fdb559fbcb268b3482474b3e311adf80109a')
    expect(second).toEqual(first)
  })

  test('recomputes annualized and walk-forward evidence against the selected benchmark without changing terminal cash-relative behavior', () => {
    const base = makeSeries()
    const input: QualificationSeries = {
      ...base,
      observations: base.observations.map((observation) => ({
        ...observation,
        strategyReturn: 0.0005,
        cashReturn: 0,
        buyAndHoldReturn: 0.0003,
        directVolatilityReturn: 0.0002,
      })),
    }
    const terminal = successOf(analyzeQualification(input, policy(), []))
    const comparison = successOf(analyzeSelectedBenchmarkComparison(input, policy(), 0))

    expect(terminal.bootstrap.selectedBenchmark).toBe('buy-and-hold')
    expect(comparison.bootstrap.selectedBenchmark).toBe('buy-and-hold')
    expect(comparison.bootstrap.seedHash).toBe(terminal.bootstrap.seedHash)
    expect(terminal.bootstrap.annualizedExcessReturnLowerBound).toBe(0.126)
    expect(comparison.bootstrap.annualizedReturnDifferenceLowerBound).toBe(0.0504)
    expect(terminal.walkForward.folds.every((fold) => fold.excessReturn > 0)).toBe(true)
    expect(comparison.walkForward.folds.every((fold) => fold.returnDifference > 0)).toBe(true)
    expect(comparison.walkForward.folds.every((fold) => fold.selectedBenchmark === 'buy-and-hold')).toBe(true)
  })

  test('changes samples with the precommitted seed and preserves paired equality', () => {
    const base = makeSeries({ strategyMean: 0.0002, buyAndHoldMean: 0.0002 })
    const input: QualificationSeries = {
      ...base,
      observations: base.observations.map((observation) => ({
        ...observation,
        buyAndHoldReturn: observation.strategyReturn,
        directVolatilityReturn: observation.strategyReturn - 0.0001,
      })),
    }
    const first = successOf(analyzeQualification(input, policy(), []))
    const changedSeed = successOf(
      analyzeQualification(
        input,
        policy({
          bootstrap: {
            ...defaultQualificationStatisticsPolicy.bootstrap,
            samples: 1_000,
            seedNamespace: 'bayn-risk-balanced-trend-qualification-v1-alternate',
          },
        }),
        [],
      ),
    )

    expect(changedSeed.bootstrap.samplesHash).not.toBe(first.bootstrap.samplesHash)
    expect(first.bootstrap.selectedBenchmark).toBe('buy-and-hold')
    expect(first.bootstrap.sharpeDifferenceSamples.every((value) => Math.abs(value) < 1e-12)).toBe(true)
  })

  test('makes multiplicity stricter and rejects inadequate bootstrap tail resolution', () => {
    const input = makeSeries()
    const baseline = successOf(analyzeQualification(input, policy(), []))
    const onePrior = successOf(analyzeQualification(input, policy(), ['1'.repeat(64)]))
    const insufficientTail = successOf(
      analyzeQualification(input, policy(), ['1'.repeat(64), '2'.repeat(64), '3'.repeat(64)]),
    )

    expect(onePrior.bootstrap.adjustedOneSidedAlpha).toBeLessThan(baseline.bootstrap.adjustedOneSidedAlpha)
    expect(onePrior.bootstrap.annualizedExcessReturnLowerBound).toBeLessThanOrEqual(
      baseline.bootstrap.annualizedExcessReturnLowerBound,
    )
    expect(insufficientTail.status).toBe('INSUFFICIENT')
    expect(insufficientTail.reasonCodes).toContain('INSUFFICIENT_BOOTSTRAP_TAIL')
    expect(analyzeQualification(input, policy(), ['2'.repeat(64), '1'.repeat(64)])).toEqual(
      Result.fail({
        _tag: 'QualificationLineageInvalid',
        priorTrialRunIds: ['2'.repeat(64), '1'.repeat(64)],
      }),
    )
  })

  test('consumes a bound preregistered ordinal without fabricating prior run IDs', () => {
    const first = successOf(
      analyzeQualificationAtOrdinal(makeSeries(), policy(), {
        candidateOrdinal: 1,
        priorTrialCount: 0,
        priorTrialsHash: 'a'.repeat(64),
      }),
    )
    const twentyFirst = successOf(
      analyzeQualificationAtOrdinal(makeSeries(), policy(), {
        candidateOrdinal: 21,
        priorTrialCount: 20,
        priorTrialsHash: 'b'.repeat(64),
      }),
    )

    expect(first.priorTrialRunIds).toEqual([])
    expect(first.priorTrialCount).toBe(0)
    expect(twentyFirst.priorTrialRunIds).toEqual([])
    expect(twentyFirst.priorTrialCount).toBe(20)
    expect(twentyFirst.candidateOrdinal).toBe(21)
    expect(twentyFirst.bootstrap.adjustedOneSidedAlpha).toBe(0.05 / 21)
    expect(twentyFirst.bootstrap.adjustedOneSidedAlpha).toBeLessThan(first.bootstrap.adjustedOneSidedAlpha)
  })
})

describe('walk-forward and terminal qualification semantics', () => {
  test('builds chronological non-overlapping folds and passes a stable strong fixture', () => {
    const analysis = successOf(analyzeQualification(makeSeries(), policy(), []))

    expect(analysis.walkForward.folds).toHaveLength(5)
    for (let index = 0; index < analysis.walkForward.folds.length; index += 1) {
      const fold = analysis.walkForward.folds[index]
      expect(fold.trainingEnd < fold.testStart).toBe(true)
      if (index > 0) expect(analysis.walkForward.folds[index - 1].testEnd < fold.testStart).toBe(true)
    }
    expect(analysis.walkForward.positiveFoldFraction).toBe(1)
    expect(analysis.walkForward.allDrawdownsWithinLimit).toBe(true)
    expect(analysis.status).toBe('PASS')
  })

  test('rejects a sufficiently powered weak candidate without relabeling it insufficient', () => {
    const analysis = successOf(
      analyzeQualification(
        makeSeries({ strategyMean: -0.0001, buyAndHoldMean: 0.0003, directVolatilityMean: 0.0002 }),
        policy(),
        [],
      ),
    )

    expect(analysis.power.sufficient).toBe(true)
    expect(analysis.status).toBe('REJECTED')
    expect(analysis.reasonCodes).toContain('NON_POSITIVE_EXCESS_RETURN_LCB')
    expect(analysis.reasonCodes).toContain('NON_POSITIVE_SHARPE_DIFFERENCE_LCB')
    expect(analysis.gates.some((gate) => gate.name === 'walk_forward_positive_fraction' && !gate.passed)).toBe(true)
  })

  test('returns insufficient when sessions, complete blocks, or folds cannot meet the precommit', () => {
    const analysis = successOf(analyzeQualification(makeSeries({ blocks: 30 }), policy(), []))

    expect(analysis.status).toBe('INSUFFICIENT')
    expect(analysis.reasonCodes).toEqual(
      expect.arrayContaining([
        'INSUFFICIENT_POWER_BLOCKS',
        'INSUFFICIENT_POWER_SESSIONS',
        'INSUFFICIENT_WALK_FORWARD_FOLDS',
      ]),
    )
  })

  test('rejects malformed, non-finite, or misaligned evidence before computation', () => {
    const input = makeSeries()
    expect(
      Result.isFailure(
        analyzeQualification(
          {
            ...input,
            observations: input.observations.map((observation, index) =>
              index === 10 ? { ...observation, strategyReturn: Number.NaN } : observation,
            ),
          },
          policy(),
          [],
        ),
      ),
    ).toBe(true)
    expect(
      Result.isFailure(
        analyzeQualification(
          { ...input, rebalanceExecutionDates: [isoDate(2_500), ...input.rebalanceExecutionDates] },
          policy(),
          [],
        ),
      ),
    ).toBe(true)
    expect(
      Result.isFailure(
        analyzeQualification(
          {
            ...input,
            observations: input.observations.map((observation, index) =>
              index === 10 ? { ...observation, strategyReturn: -1.01 } : observation,
            ),
          },
          policy(),
          [],
        ),
      ),
    ).toBe(true)
  })

  test('rejects internally inconsistent persisted analysis even with a recomputed root hash', () => {
    const original = successOf(analyzeQualification(makeSeries(), policy(), []))
    const changedBootstrap = { ...original.bootstrap, producedSamples: original.bootstrap.producedSamples - 1 }
    const { analysisHash: _analysisHash, ...originalMaterial } = original
    const changedMaterial = { ...originalMaterial, bootstrap: changedBootstrap }

    expect(() =>
      Schema.decodeSync(QualificationAnalysisSchema, { onExcessProperty: 'error' })({
        ...changedMaterial,
        analysisHash: canonicalHashV1(changedMaterial),
      }),
    ).toThrow()
  })

  test('enforces the fold drawdown limit', () => {
    const shocks = Object.fromEntries(
      Array.from({ length: 30 }, (_, offset) => [504 + offset, offset === 0 ? -0.5 : 0]),
    )
    const analysis = successOf(analyzeQualification(makeSeries({ strategyShock: shocks }), policy(), []))

    expect(analysis.walkForward.allDrawdownsWithinLimit).toBe(false)
    expect(analysis.status).toBe('REJECTED')
    expect(analysis.reasonCodes).toContain('WALK_FORWARD_DRAWDOWN_FAILED')
  })
})

describe('evaluation adapter', () => {
  test('prepares exact aligned strategy, cash, benchmark, and rebalance dates from decoded evidence', () => {
    const snapshot = makeSnapshot()
    const evaluationResult = evaluateRiskBalancedTrend(
      snapshot.bars,
      snapshot.manifest,
      fixtureProtocol,
      makeTestProvenance(),
    )
    assert(Result.isSuccess(evaluationResult), 'strategy evaluation fixture must succeed')
    const evaluation = evaluationResult.success
    const series = successOf(prepareQualificationSeries(evaluation))

    expect(series.runId).toBe(evaluation.runId)
    expect(series.observations).toHaveLength(evaluation.simulation.dailyMarks.length)
    expect(series.rebalanceExecutionDates).toEqual(evaluation.signalDecisions.map((decision) => decision.executionDate))
    expect(series.observations.every((observation) => observation.cashReturn === 0)).toBe(true)
  })

  test('is deterministic across irrelevant benchmark input orderings and rejects semantic order changes', () => {
    const snapshot = makeSnapshot()
    const evaluationResult = evaluateRiskBalancedTrend(
      snapshot.bars,
      snapshot.manifest,
      fixtureProtocol,
      makeTestProvenance(),
    )
    assert(Result.isSuccess(evaluationResult), 'strategy evaluation fixture must succeed')
    const evaluation = evaluationResult.success
    const canonical = successOf(prepareQualificationSeries(evaluation))
    const reordered = successOf(
      prepareQualificationSeries({
        ...evaluation,
        benchmarkSeries: {
          ...evaluation.benchmarkSeries,
          buyAndHold: [...evaluation.benchmarkSeries.buyAndHold].reverse(),
          directVolTiming: [...evaluation.benchmarkSeries.directVolTiming].reverse(),
        },
      }),
    )
    expect(reordered).toEqual(canonical)
    expect(
      Result.isFailure(
        analyzeQualificationInput({
          series: { ...canonical, observations: [...canonical.observations].reverse() },
          policy: policy(),
          priorTrialRunIds: [],
        }),
      ),
    ).toBe(true)
  })
})
