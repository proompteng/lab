import { createHash } from 'node:crypto'

import { describe, expect, test } from 'bun:test'
import type { ClickHouseClient } from '@clickhouse/client'
import { Effect, Result } from 'effect'

import {
  candidateDevelopmentCalendarContract,
  officialMonthEndSignalDates,
  preflightCandidateDevelopment,
  runCandidateDevelopment,
  type CandidateDevelopmentPreflightPass,
} from '../candidate-development'
import { queryCandidate11DevelopmentData } from '../candidate-11-development-command'
import { analyzeQualification, type QualificationSeries } from '../qualification-statistics'
import type { AlignedSession } from '../simulation'
import { DataFeed, DataSource, PriceAdjustment, PublicationSchema, type DailyBar, type IsoDate } from '../types'
import {
  candidate11DatasetHashes,
  evaluateCandidate11Development,
  prepareCandidate11DevelopmentData,
  selectCandidate11SpecificationId,
} from './development'
import { decideCandidate11HoldoutAccess } from './holdout-access'
import {
  CANDIDATE_11_DEVELOPMENT_END,
  CANDIDATE_11_DEVELOPMENT_START,
  CANDIDATE_11_PREREGISTRATION_COMMIT,
  CANDIDATE_11_PREREGISTRATION_SHA256,
  CANDIDATE_11_SNAPSHOT_ID,
  candidate11DevelopmentSessions,
  candidate11DevelopmentStatisticsPolicy,
  candidate11PriorAttemptIds,
  candidate11Protocol,
  candidate11SelectionMultiplicity,
  candidate11Specifications,
  candidate11Universe,
  type Candidate11Bar,
  type Candidate11Dataset,
  type Candidate11Registration,
  type Candidate11Symbol,
} from './model'
import {
  abnormalVolumeFeature,
  buildCandidate11Plan,
  candidate11DecisionAtSignal,
  candidate11TerminalLiquidationIsComplete,
} from './strategy'

const successOf = <A, E>(result: Result.Result<A, E>): A => {
  if (Result.isFailure(result)) throw new Error(`expected success: ${JSON.stringify(result.failure)}`)
  return result.success
}

const marketBar = (symbol: Candidate11Symbol, sessionDate: IsoDate, close: number, volume = 1_000_000): DailyBar => ({
  symbol,
  sessionDate,
  open: close,
  high: close * 1.01,
  low: close * 0.99,
  close,
  volume,
  source: DataSource.Alpaca,
  sourceFeed: DataFeed.Sip,
  adjustment: PriceAdjustment.All,
  publicationSchemaVersion: PublicationSchema.AdjustedDailySnapshotV2,
})

const alignedFixture = (count: number): readonly AlignedSession[] =>
  candidate11DevelopmentSessions()
    .slice(0, count)
    .map((date, index) => ({
      date,
      bars: Object.fromEntries(
        candidate11Universe.map((symbol, symbolIndex) => [symbol, marketBar(symbol, date, 100 + index + symbolIndex)]),
      ),
    }))

const decisionFixture = (signalIndex: number): readonly AlignedSession[] =>
  candidate11DevelopmentSessions()
    .slice(0, signalIndex + 20)
    .map((date, index) => ({
      date,
      bars: Object.fromEntries(
        candidate11Universe.map((symbol) => {
          const historyStart = signalIndex - candidate11Protocol.feature.sessions + 1
          const inRecentWindow = index >= signalIndex - candidate11Protocol.feature.recentDollarVolumeSessions + 1
          const afterReturnStart = index > signalIndex - candidate11Protocol.feature.relativeReturnSessions
          const returnGain = symbol === 'DBC' ? 0.08 : symbol === 'EFA' ? 0.04 : symbol === 'SPY' ? 0.01 : 0
          const progress = afterReturnStart
            ? (index - (signalIndex - candidate11Protocol.feature.relativeReturnSessions)) /
              candidate11Protocol.feature.relativeReturnSessions
            : 0
          const close = index >= historyStart ? 100 * (1 + returnGain * Math.max(0, progress)) : 100
          const volume =
            inRecentWindow && symbol === 'DBC' ? 1_600_000 : inRecentWindow && symbol === 'EFA' ? 1_400_000 : 1_000_000
          return [symbol, marketBar(symbol, date, close, volume)]
        }),
      ),
    }))

const preflight = (): CandidateDevelopmentPreflightPass => {
  const sessions = candidate11DevelopmentSessions()
  const result = successOf(
    preflightCandidateDevelopment({
      officialSessions: sessions,
      signalSessionDates: officialMonthEndSignalDates(sessions),
      featureLookbackSessions: candidate11Protocol.feature.sessions,
    }),
  )
  expect(result.status).toBe('PASS')
  if (result.status !== 'PASS') throw new Error('expected passing development geometry')
  return result
}

const syntheticDataset = (): Candidate11Dataset => {
  const sessions = candidate11DevelopmentSessions()
  const closes = Object.fromEntries(candidate11Universe.map((symbol) => [symbol, 100])) as Record<
    Candidate11Symbol,
    number
  >
  const monthEnds = new Set(officialMonthEndSignalDates(sessions))
  const bars: Candidate11Bar[] = []
  sessions.forEach((sessionDate, index) => {
    const monthEnd = monthEnds.has(sessionDate)
    const favored = candidate11Universe.filter((symbol) => symbol !== 'SPY')[Math.floor(index / 126) % 4]
    candidate11Universe.forEach((symbol, symbolIndex) => {
      const previousClose = closes[symbol]
      const drift = symbol === 'SPY' ? 0.00042 : symbol === favored ? 0.00075 : 0.00018
      const cycle = Math.sin((index + symbolIndex * 19) / 31) * 0.0003
      const close = previousClose * (1 + drift + cycle)
      const open = previousClose * (1 + Math.sin((index + symbolIndex) / 17) * 0.0002)
      closes[symbol] = close
      bars.push({
        symbol,
        sessionDate,
        open,
        high: Math.max(open, close) * 1.003,
        low: Math.min(open, close) * 0.997,
        close,
        volume: 10_000_000 * (monthEnd && symbol === favored ? 1.6 : 1),
      })
    })
  })
  const hashes = successOf(candidate11DatasetHashes(sessions, bars))
  return { snapshotId: CANDIDATE_11_SNAPSHOT_ID, sessions, bars, ...hashes }
}

describe('Candidate 11 benchmark-anchored abnormal-volume continuation', () => {
  test('binds the preregistration before metric-bearing implementation', async () => {
    const bytes = await Bun.file(
      new URL('../../candidates/ordinal-11-abnormal-volume-continuation-preregistration.md', import.meta.url),
    ).arrayBuffer()
    expect(createHash('sha256').update(new Uint8Array(bytes)).digest('hex')).toBe(CANDIDATE_11_PREREGISTRATION_SHA256)
    expect(CANDIDATE_11_PREREGISTRATION_COMMIT).toMatch(/^[0-9a-f]{40}$/)
  })

  test('freezes the exact calendar hash and merged five-fold development geometry', () => {
    const sessions = candidate11DevelopmentSessions()
    const geometry = preflight()

    expect(sessions).toHaveLength(1_762)
    expect(sessions.at(0)).toBe(CANDIDATE_11_DEVELOPMENT_START)
    expect(sessions.at(-1)).toBe(CANDIDATE_11_DEVELOPMENT_END)
    expect(candidateDevelopmentCalendarContract.sessionsHash).toBe(
      'a6df7a68249842fa35814f282b3df63db19c52f6ea0697899979d3a8c970d9b1',
    )
    expect(geometry.selectedObservationStartIndex).toBe(273)
    expect(geometry.selectedObservationEndIndex).toBe(1_761)
    expect(geometry.folds.map((fold) => fold.testObservationCount)).toEqual([197, 197, 197, 197, 197])
  })

  test('computes the frozen 5-versus-58 abnormal volume and 21-session return', () => {
    const dates = candidate11DevelopmentSessions().slice(0, 63)
    const history = dates.map((date, index) =>
      marketBar('DBC', date, index <= 41 ? 100 : 100 + ((index - 41) / 21) * 5, index < 58 ? 1_000 : 1_500),
    )
    const feature = successOf(abnormalVolumeFeature(history))

    expect(feature.return21).toBe(0.05)
    expect(feature.abnormalDollarVolume).toBeGreaterThan(1.5)
    expect(abnormalVolumeFeature(history.slice(1))).toEqual(
      Result.fail({
        _tag: 'Candidate11InvalidInput',
        operation: 'abnormal-volume',
        reason: 'expected 63 bars, observed 62',
      }),
    )
  })

  test('selects only eligible abnormal-volume continuation and preserves the SPY core', () => {
    const signalIndex = 280
    const decision = successOf(
      candidate11DecisionAtSignal(decisionFixture(signalIndex), signalIndex, candidate11Specifications[0]),
    )

    expect(decision.selectedChallenger).toBe('DBC')
    expect(decision.challengers.find(({ symbol }) => symbol === 'DBC')).toMatchObject({ eligible: true })
    expect(decision.weights).toEqual({ DBC: 0.5, EFA: 0, IEF: 0, SPY: 0.5, VNQ: 0 })
    expect(Object.values(decision.weights).reduce((sum, weight) => sum + weight, 0)).toBe(1)
  })

  test('does not leak future bars and executes each finalized signal next session', () => {
    const signalIndex = 280
    const original = decisionFixture(signalIndex)
    const originalDecision = successOf(candidate11DecisionAtSignal(original, signalIndex, candidate11Specifications[0]))
    const futureChanged = original.map((session, index) =>
      index <= signalIndex
        ? session
        : {
            ...session,
            bars: Object.fromEntries(
              candidate11Universe.map((symbol) => [symbol, marketBar(symbol, session.date, 1_000_000, 1)]),
            ),
          },
    )
    expect(successOf(candidate11DecisionAtSignal(futureChanged, signalIndex, candidate11Specifications[0]))).toEqual(
      originalDecision,
    )

    const geometry = preflight()
    const plan = successOf(buildCandidate11Plan(alignedFixture(1_762), geometry, candidate11Specifications[0]))
    expect(plan.simulationStartIndex).toBe(geometry.firstEligibleExecution.executionIndex)
    expect(plan.evaluationStartIndex).toBe(273)
    expect(plan.targets.at(0)).toMatchObject({
      signalIndex: geometry.firstEligibleExecution.signalIndex,
      executionIndex: geometry.firstEligibleExecution.executionIndex,
    })
    for (const target of plan.targets) expect(target.executionIndex).toBe(target.signalIndex + 1)
    expect(plan.targets.at(-1)).toMatchObject({ signalIndex: 1_760, executionIndex: 1_761 })
    expect(Object.values(plan.targets.at(-1)?.weights ?? {}).every((weight) => weight === 0)).toBe(true)
    expect(successOf(candidate11TerminalLiquidationIsComplete())).toBe(true)
  })

  test('runs geometry preflight and preregistration before data I/O', async () => {
    const sessions = candidate11DevelopmentSessions()
    const order: string[] = []
    const report = await Effect.runPromise(
      runCandidateDevelopment(
        {
          officialSessions: sessions,
          signalSessionDates: officialMonthEndSignalDates(sessions),
          featureLookbackSessions: candidate11Protocol.feature.sessions,
        },
        {
          preregisterCandidate: () => Effect.sync(() => (order.push('preregister'), 'registration')),
          loadDevelopmentData: () => Effect.sync(() => (order.push('data'), 'dataset')),
          evaluateDevelopment: (_data, geometry) => Effect.sync(() => (order.push('evaluate'), geometry.folds.length)),
        },
      ),
    )

    expect(report).toBe(5)
    expect(order).toEqual(['preregister', 'data', 'evaluate'])
  })

  test('queries only the bounded development calendar before adjusted bars', async () => {
    const operations: string[] = []
    const client = {
      query: async (request: {
        readonly query: string
        readonly query_id: string
        readonly query_params: Readonly<Record<string, unknown>>
      }) => {
        operations.push(`query:${request.query_id}`)
        expect(request.query_params.start).toBe(CANDIDATE_11_DEVELOPMENT_START)
        expect(request.query_params.end).toBe(CANDIDATE_11_DEVELOPMENT_END)
        expect(String(request.query_params.end) < '2023-01-03').toBe(true)
        if (request.query_id.endsWith('bars')) expect(request.query_params.symbols).toEqual(candidate11Universe)
        return {
          json: async () => {
            operations.push(`json:${request.query_id}`)
            return request.query_id.endsWith('sessions')
              ? [{ session_date: CANDIDATE_11_DEVELOPMENT_START }]
              : candidate11Universe.map((symbol) => ({
                  symbol,
                  session_date: CANDIDATE_11_DEVELOPMENT_START,
                  adjusted_open: '100.00000000',
                  adjusted_high: '101.00000000',
                  adjusted_low: '99.00000000',
                  adjusted_close: '100.50000000',
                  adjusted_volume: '1000000.00000000',
                }))
          },
        }
      },
    } as unknown as ClickHouseClient

    await Effect.runPromise(queryCandidate11DevelopmentData(client))
    expect(operations).toEqual([
      'query:bayn-candidate-11-development-sessions',
      'json:bayn-candidate-11-development-sessions',
      'query:bayn-candidate-11-development-bars',
      'json:bayn-candidate-11-development-bars',
    ])
  })

  test('applies singleton bounded selection after all ten prior attempts', () => {
    const sessions = candidate11DevelopmentSessions().slice(273)
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
      rebalanceExecutionDates: sessions.filter((_date, index) => index % 21 === 0),
    }
    const analysis = successOf(
      analyzeQualification(series, candidate11DevelopmentStatisticsPolicy, candidate11PriorAttemptIds),
    )

    expect(candidate11SelectionMultiplicity).toBe(1)
    expect(candidate11PriorAttemptIds).toHaveLength(10)
    expect(analysis.candidateOrdinal).toBe(11)
    expect(analysis.bootstrap.adjustedOneSidedAlpha).toBeCloseTo(0.05 / 11, 15)
    expect(analysis.bootstrap.tailSampleCount).toBe(22)
    expect(analysis.bootstrap.producedSamples).toBe(5_000)
    expect(analysis.walkForward.folds).toHaveLength(5)
    expect(analysis.completeBlocks.every((block) => block.endSession < block.nextRebalanceSession)).toBe(true)
  })

  test('selects the sole specification only after every development gate passes', () => {
    const id = candidate11Specifications[0].id
    expect(
      selectCandidate11SpecificationId([
        {
          specificationId: id,
          developmentPass: true,
          annualizedExcessReturnLowerBound: 0.01,
          sharpeDifferenceLowerBound: 0.02,
          annualTurnover: 2,
        },
      ]),
    ).toBe(id)
    expect(
      selectCandidate11SpecificationId([
        {
          specificationId: id,
          developmentPass: false,
          annualizedExcessReturnLowerBound: 1,
          sharpeDifferenceLowerBound: 1,
          annualTurnover: 0,
        },
      ]),
    ).toBeNull()
  })

  test('permits holdout access exactly once only after immutable development lock', () => {
    expect(
      decideCandidate11HoldoutAccess({ developmentStatus: 'HOLD_REJECT', identityLocked: true, priorAccessCount: 0 }),
    ).toEqual({ status: 'DENY', reason: 'DEVELOPMENT_NOT_PASSED' })
    expect(
      decideCandidate11HoldoutAccess({ developmentStatus: 'PASS', identityLocked: false, priorAccessCount: 0 }),
    ).toEqual({ status: 'DENY', reason: 'IDENTITY_NOT_LOCKED' })
    expect(
      decideCandidate11HoldoutAccess({ developmentStatus: 'PASS', identityLocked: true, priorAccessCount: 0 }),
    ).toEqual({ status: 'ALLOW_ONCE', nextAccessCount: 1 })
    expect(
      decideCandidate11HoldoutAccess({ developmentStatus: 'PASS', identityLocked: true, priorAccessCount: 1 }),
    ).toEqual({ status: 'DENY', reason: 'HOLDOUT_ALREADY_ACCESSED' })
  })

  test('binds data, costs, folds, multiplicity, and zero holdout access into a deterministic report', () => {
    const dataset = syntheticDataset()
    expect(successOf(prepareCandidate11DevelopmentData(dataset)).sessions).toHaveLength(1_762)
    const registration: Candidate11Registration = {
      preregistrationHash: CANDIDATE_11_PREREGISTRATION_SHA256,
      preregistrationCommit: CANDIDATE_11_PREREGISTRATION_COMMIT,
      evaluatedCommit: 'a'.repeat(40),
    }
    const first = successOf(evaluateCandidate11Development(registration, dataset, preflight()))
    const second = successOf(evaluateCandidate11Development(registration, dataset, preflight()))

    expect(second.identity).toEqual(first.identity)
    expect(first.specifications).toHaveLength(1)
    expect(first.selection).toMatchObject({
      specificationCount: 1,
      familyMultiplicityDivisor: 1,
      priorAttemptCount: 10,
    })
    expect(first.selection.adjustedOneSidedAlpha).toBeCloseTo(0.05 / 11, 15)
    const specification = first.specifications[0]
    expect(specification.metrics.strategy.observations).toBe(1_489)
    expect(specification.metrics.strategy.totalSpreadCostMicros).not.toBe('0')
    expect(specification.metrics.strategy.totalSlippageCostMicros).not.toBe('0')
    expect(BigInt(specification.metrics.doubleCostStrategy.totalFeesMicros)).toBeGreaterThanOrEqual(
      BigInt(specification.metrics.strategy.totalFeesMicros),
    )
    expect(specification.uncertainty.producedBootstrapSamples).toBe(5_000)
    expect(specification.uncertainty.walkForwardFolds).toHaveLength(5)
    expect(first.holdout).toEqual({
      start: '2023-01-03',
      end: '2025-12-31',
      inspected: false,
      accessCount: 0,
    })
  })
})
