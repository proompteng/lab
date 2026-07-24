import assert from 'node:assert/strict'

import { describe, expect, test } from 'bun:test'

import { Result, Schema } from 'effect'

import {
  QualificationAnalysisSchema,
  QualificationStatisticsPolicySchema,
  analyzeQualification,
  calculateQualificationPower,
  defaultQualificationStatisticsPolicy,
  prepareQualificationSeries,
  type QualificationSeries,
  type QualificationStatisticsPolicy,
} from './qualification-statistics'
import { canonicalHashV1 } from './hash'
import { evaluateRiskBalancedTrend } from './risk-balanced-trend'
import { fixtureProtocol, makeSnapshot, makeTestProvenance } from './test-fixtures'

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
    const baseline = calculateQualificationPower(defaultQualificationStatisticsPolicy, 0, 0)
    const smallerEffect = calculateQualificationPower(
      policy({
        power: {
          ...defaultQualificationStatisticsPolicy.power,
          minimumDetectableAnnualizedExcessReturn: 0.02,
        },
      }),
      0,
      0,
    )
    const largerEffect = calculateQualificationPower(
      policy({
        power: {
          ...defaultQualificationStatisticsPolicy.power,
          minimumDetectableAnnualizedExcessReturn: 0.05,
        },
      }),
      0,
      0,
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

describe('deterministic paired block bootstrap', () => {
  test('uses complete rebalance intervals, excludes the trailing interval, and reproduces a golden result', () => {
    const input = makeSeries()
    const first = analyzeQualification(input, policy(), [])
    const second = analyzeQualification(structuredClone(input), policy(), [])

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
    const first = analyzeQualification(input, policy(), [])
    const changedSeed = analyzeQualification(
      input,
      policy({
        bootstrap: {
          ...defaultQualificationStatisticsPolicy.bootstrap,
          samples: 1_000,
          seedNamespace: 'bayn-risk-balanced-trend-qualification-v1-alternate',
        },
      }),
      [],
    )

    expect(changedSeed.bootstrap.samplesHash).not.toBe(first.bootstrap.samplesHash)
    expect(first.bootstrap.selectedBenchmark).toBe('buy-and-hold')
    expect(first.bootstrap.sharpeDifferenceSamples.every((value) => Math.abs(value) < 1e-12)).toBe(true)
  })

  test('makes multiplicity stricter and rejects inadequate bootstrap tail resolution', () => {
    const input = makeSeries()
    const baseline = analyzeQualification(input, policy(), [])
    const onePrior = analyzeQualification(input, policy(), ['1'.repeat(64)])
    const insufficientTail = analyzeQualification(input, policy(), ['1'.repeat(64), '2'.repeat(64), '3'.repeat(64)])

    expect(onePrior.bootstrap.adjustedOneSidedAlpha).toBeLessThan(baseline.bootstrap.adjustedOneSidedAlpha)
    expect(onePrior.bootstrap.annualizedExcessReturnLowerBound).toBeLessThanOrEqual(
      baseline.bootstrap.annualizedExcessReturnLowerBound,
    )
    expect(insufficientTail.status).toBe('INSUFFICIENT')
    expect(insufficientTail.reasonCodes).toContain('INSUFFICIENT_BOOTSTRAP_TAIL')
    expect(() => analyzeQualification(input, policy(), ['2'.repeat(64), '1'.repeat(64)])).toThrow()
  })
})

describe('walk-forward and terminal qualification semantics', () => {
  test('builds chronological non-overlapping folds and passes a stable strong fixture', () => {
    const analysis = analyzeQualification(makeSeries(), policy(), [])

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
    const analysis = analyzeQualification(
      makeSeries({ strategyMean: -0.0001, buyAndHoldMean: 0.0003, directVolatilityMean: 0.0002 }),
      policy(),
      [],
    )

    expect(analysis.power.sufficient).toBe(true)
    expect(analysis.status).toBe('REJECTED')
    expect(analysis.reasonCodes).toContain('NON_POSITIVE_EXCESS_RETURN_LCB')
    expect(analysis.reasonCodes).toContain('NON_POSITIVE_SHARPE_DIFFERENCE_LCB')
    expect(analysis.gates.some((gate) => gate.name === 'walk_forward_positive_fraction' && !gate.passed)).toBe(true)
  })

  test('returns insufficient when sessions, complete blocks, or folds cannot meet the precommit', () => {
    const analysis = analyzeQualification(makeSeries({ blocks: 30 }), policy(), [])

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
    expect(() =>
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
    ).toThrow()
    expect(() =>
      analyzeQualification(
        { ...input, rebalanceExecutionDates: [isoDate(2_500), ...input.rebalanceExecutionDates] },
        policy(),
        [],
      ),
    ).toThrow()
    expect(() =>
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
    ).toThrow()
  })

  test('rejects internally inconsistent persisted analysis even with a recomputed root hash', () => {
    const original = analyzeQualification(makeSeries(), policy(), [])
    const changedBootstrap = { ...original.bootstrap, producedSamples: original.bootstrap.producedSamples - 1 }
    const { analysisHash: _analysisHash, ...originalMaterial } = original
    const changedMaterial = { ...originalMaterial, bootstrap: changedBootstrap }

    expect(() =>
      Schema.decodeUnknownSync(QualificationAnalysisSchema, { onExcessProperty: 'error' })({
        ...changedMaterial,
        analysisHash: canonicalHashV1(changedMaterial),
      }),
    ).toThrow()
  })

  test('enforces the fold drawdown limit', () => {
    const shocks = Object.fromEntries(
      Array.from({ length: 30 }, (_, offset) => [504 + offset, offset === 0 ? -0.5 : 0]),
    )
    const analysis = analyzeQualification(makeSeries({ strategyShock: shocks }), policy(), [])

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
    const series = prepareQualificationSeries(evaluation)

    expect(series.runId).toBe(evaluation.runId)
    expect(series.observations).toHaveLength(evaluation.simulation.dailyMarks.length)
    expect(series.rebalanceExecutionDates).toEqual(evaluation.signalDecisions.map((decision) => decision.executionDate))
    expect(series.observations.every((observation) => observation.cashReturn === 0)).toBe(true)
  })
})
