import { describe, expect, test } from 'bun:test'
import { Effect, Result } from 'effect'

import {
  candidateDevelopmentStatisticsPolicy,
  officialMonthEndSignalDates,
  preflightCandidateDevelopment,
  runCandidateDevelopment,
  type CandidateDevelopmentPreflightPass,
} from '../candidate-development'
import { analyzeQualification, type QualificationSeries } from '../qualification-statistics'
import type { AlignedSession } from '../simulation'
import { DataFeed, DataSource, PriceAdjustment, PublicationSchema, type DailyBar, type IsoDate } from '../types'
import { candidate9DatasetHashes, evaluateCandidate9Development, prepareCandidate9DevelopmentData } from './development'
import {
  CANDIDATE_9_PREREGISTRATION_SHA256,
  CANDIDATE_9_SNAPSHOT_ID,
  candidate9DevelopmentSessions,
  candidate9PriorAttemptIds,
  candidate9Protocol,
  type Candidate9Bar,
  type Candidate9Dataset,
} from './model'
import {
  asymmetricRangeForecastVariance,
  asymmetricRangeTargetWeight,
  buildCandidate9Plan,
  candidate9TerminalLiquidationIsComplete,
  candidate9WeightAtSignal,
} from './strategy'

const successOf = <A, E>(result: Result.Result<A, E>): A => {
  if (Result.isFailure(result)) throw new Error(`expected success: ${JSON.stringify(result.failure)}`)
  expect(Result.isSuccess(result)).toBe(true)
  return result.success
}

const marketBar = (sessionDate: IsoDate, close: number, overrides: Partial<DailyBar> = {}): DailyBar => ({
  symbol: 'SPY',
  sessionDate,
  open: close,
  high: close * 1.01,
  low: close * 0.99,
  close,
  volume: 1_000_000,
  source: DataSource.Alpaca,
  sourceFeed: DataFeed.Sip,
  adjustment: PriceAdjustment.All,
  publicationSchemaVersion: PublicationSchema.AdjustedDailySnapshotV2,
  ...overrides,
})

const alignedFixture = (count: number): readonly AlignedSession[] =>
  candidate9DevelopmentSessions()
    .slice(0, count)
    .map((date, index) => ({
      date,
      bars: { SPY: marketBar(date, 100 + index) },
    }))

const preflight = (): CandidateDevelopmentPreflightPass => {
  const sessions = candidate9DevelopmentSessions()
  const result = successOf(
    preflightCandidateDevelopment({
      officialSessions: sessions,
      signalSessionDates: officialMonthEndSignalDates(sessions),
      featureLookbackSessions: candidate9Protocol.feature.sessions,
    }),
  )
  expect(result.status).toBe('PASS')
  if (result.status !== 'PASS') throw new Error('expected passing development geometry')
  return result
}

const syntheticDataset = (): Candidate9Dataset => {
  const sessions = candidate9DevelopmentSessions()
  let previousClose = 100
  const bars: Candidate9Bar[] = sessions.map((sessionDate, index) => {
    const cycle = Math.sin(index / 17) * 0.002
    const shock = index % 113 === 0 ? -0.018 : 0
    const close = previousClose * (1.00035 + cycle + shock)
    const open = previousClose * (1 + Math.sin(index / 11) * 0.0005)
    const high = Math.max(open, close) * (1.006 + (index % 7) * 0.0002)
    const low = Math.min(open, close) * (0.994 - (index % 5) * 0.0002)
    previousClose = close
    return { sessionDate, open, high, low, close, volume: 10_000_000 + index }
  })
  const hashes = successOf(candidate9DatasetHashes(sessions, bars))
  return { snapshotId: CANDIDATE_9_SNAPSHOT_ID, sessions, bars, ...hashes }
}

describe('Candidate 9 asymmetric range-volatility strategy', () => {
  test('freezes the exact development calendar and five 197-session folds', () => {
    const sessions = candidate9DevelopmentSessions()
    const geometry = preflight()

    expect(sessions).toHaveLength(1_762)
    expect(sessions.at(0)).toBe('2016-01-04')
    expect(sessions.at(-1)).toBe('2022-12-30')
    expect(geometry.selectedObservationStartIndex).toBe(273)
    expect(geometry.selectedObservationEndIndex).toBe(1_761)
    expect(geometry.folds).toHaveLength(5)
    expect(geometry.folds.map((fold) => fold.testObservationCount)).toEqual([197, 197, 197, 197, 197])
  })

  test('uses range variance and negative semivariance as total deterministic calculations', () => {
    const dates = candidate9DevelopmentSessions().slice(0, 22)
    const calm = dates.map((date) => marketBar(date, 100, { high: 100.5, low: 99.5 }))
    const adverse = calm.map((bar, index) =>
      index === calm.length - 1 ? { ...bar, close: 92, low: 91.5, open: 100 } : bar,
    )

    const calmVariance = successOf(asymmetricRangeForecastVariance(calm))
    const adverseVariance = successOf(asymmetricRangeForecastVariance(adverse))
    const calmWeight = successOf(asymmetricRangeTargetWeight(calmVariance))
    const adverseWeight = successOf(asymmetricRangeTargetWeight(adverseVariance))

    expect(calmVariance).toBeGreaterThan(0)
    expect(adverseVariance).toBeGreaterThan(calmVariance)
    expect(adverseWeight).toBeLessThan(calmWeight)
    expect(calmWeight).toBeLessThanOrEqual(1)
    expect(adverseWeight).toBeGreaterThanOrEqual(0)
  })

  test('uses only finalized history and executes every decision on the next session', () => {
    const original = alignedFixture(80)
    const signalIndex = 60
    const originalWeight = successOf(candidate9WeightAtSignal(original, signalIndex))
    const futureChanged = original.map((session, index) =>
      index <= signalIndex
        ? session
        : { ...session, bars: { SPY: { ...session.bars.SPY!, open: 1, high: 10_000, low: 1, close: 5_000 } } },
    )
    const changedWeight = successOf(candidate9WeightAtSignal(futureChanged, signalIndex))

    expect(changedWeight).toBe(originalWeight)

    const plan = successOf(buildCandidate9Plan(alignedFixture(1_762), preflight()))
    expect(plan.startIndex).toBe(273)
    for (const target of plan.targets) expect(target.executionIndex).toBe(target.signalIndex + 1)
    expect(plan.targets.at(-1)).toMatchObject({
      signalIndex: 1_760,
      executionIndex: 1_761,
      weights: { SPY: 0 },
    })
    expect(successOf(candidate9TerminalLiquidationIsComplete())).toBe(true)
  })

  test('runs preregistration before data and evaluation through the production development consumer', async () => {
    const sessions = candidate9DevelopmentSessions()
    const order: string[] = []
    const report = await Effect.runPromise(
      runCandidateDevelopment(
        {
          officialSessions: sessions,
          signalSessionDates: officialMonthEndSignalDates(sessions),
          featureLookbackSessions: candidate9Protocol.feature.sessions,
        },
        {
          preregisterCandidate: () => Effect.sync(() => (order.push('preregister'), 'registration')),
          loadDevelopmentData: () => Effect.sync(() => (order.push('data'), 'dataset')),
          evaluateDevelopment: (_data, geometry) =>
            Effect.sync(() => {
              order.push('evaluate')
              return geometry.folds.length
            }),
        },
      ),
    )

    expect(report).toBe(5)
    expect(order).toEqual(['preregister', 'data', 'evaluate'])
  })

  test('applies the singleton bounded-selection penalty and non-wrapping fold geometry', () => {
    const sessions = candidate9DevelopmentSessions().slice(273)
    const rebalanceExecutionDates = sessions.filter((_date, index) => index % 21 === 0)
    const series: QualificationSeries = {
      schemaVersion: 'bayn.qualification-series.v1',
      runId: 'f'.repeat(64),
      observations: sessions.map((sessionDate, index) => ({
        sessionDate,
        strategyReturn: index % 17 === 0 ? -0.001 : 0.0008,
        cashReturn: 0,
        buyAndHoldReturn: index % 13 === 0 ? -0.001 : 0.0002,
        directVolatilityReturn: index % 15 === 0 ? -0.0008 : 0.00025,
      })),
      rebalanceExecutionDates,
    }
    const analysis = successOf(
      analyzeQualification(series, candidateDevelopmentStatisticsPolicy, candidate9PriorAttemptIds),
    )

    expect(candidate9PriorAttemptIds).toHaveLength(8)
    expect(analysis.candidateOrdinal).toBe(9)
    expect(analysis.bootstrap.adjustedOneSidedAlpha).toBeCloseTo(0.05 / 9, 15)
    expect(analysis.bootstrap.producedSamples).toBe(5_000)
    expect(analysis.walkForward.folds).toHaveLength(5)
    expect(analysis.completeBlocks.every((block) => block.endSession < block.nextRebalanceSession)).toBe(true)
  })

  test('binds dataset hashes, costs, folds, and zero holdout access into a deterministic report', () => {
    const dataset = syntheticDataset()
    const prepared = successOf(prepareCandidate9DevelopmentData(dataset))
    expect(prepared.sessions).toHaveLength(1_762)

    const registration = {
      preregistrationHash: CANDIDATE_9_PREREGISTRATION_SHA256,
      evaluatedCommit: 'a'.repeat(40),
    }
    const first = successOf(evaluateCandidate9Development(registration, dataset, preflight()))
    const second = successOf(evaluateCandidate9Development(registration, dataset, preflight()))

    expect(second.identity).toEqual(first.identity)
    expect(first.metrics.strategy.observations).toBe(1_489)
    expect(first.metrics.strategy.totalSpreadCostMicros).not.toBe('0')
    expect(first.metrics.strategy.totalSlippageCostMicros).not.toBe('0')
    expect(BigInt(first.metrics.doubleCostStrategy.totalFeesMicros)).toBeGreaterThanOrEqual(
      BigInt(first.metrics.strategy.totalFeesMicros),
    )
    expect(first.uncertainty.producedBootstrapSamples).toBe(5_000)
    expect(first.uncertainty.walkForwardFolds).toHaveLength(5)
    expect(Object.values(first.terminalCash).every((closed) => typeof closed === 'boolean')).toBe(true)
    expect(first.holdout).toEqual({
      start: '2023-01-03',
      end: '2025-12-31',
      inspected: false,
      accessCount: 0,
    })
  })
})
