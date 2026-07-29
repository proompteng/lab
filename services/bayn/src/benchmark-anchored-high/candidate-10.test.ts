import { createHash } from 'node:crypto'

import { describe, expect, test } from 'bun:test'
import type { ClickHouseClient } from '@clickhouse/client'
import { Effect, Result } from 'effect'

import {
  officialMonthEndSignalDates,
  preflightCandidateDevelopment,
  runCandidateDevelopment,
  type CandidateDevelopmentPreflightPass,
} from '../candidate-development'
import { queryCandidate10DevelopmentData } from '../candidate-10-development-command'
import { analyzeQualificationWithSelectionMultiplicity, type QualificationSeries } from '../qualification-statistics'
import type { AlignedSession } from '../simulation'
import { DataFeed, DataSource, PriceAdjustment, PublicationSchema, type DailyBar, type IsoDate } from '../types'
import {
  candidate10DatasetHashes,
  evaluateCandidate10Development,
  prepareCandidate10DevelopmentData,
  selectCandidate10SpecificationId,
} from './development'
import {
  CANDIDATE_10_DEVELOPMENT_END,
  CANDIDATE_10_DEVELOPMENT_START,
  CANDIDATE_10_PREREGISTRATION_COMMIT,
  CANDIDATE_10_PREREGISTRATION_SHA256,
  CANDIDATE_10_SNAPSHOT_ID,
  candidate10DevelopmentSessions,
  candidate10DevelopmentStatisticsPolicy,
  candidate10PriorAttemptIds,
  candidate10Protocol,
  candidate10SelectionMultiplicity,
  candidate10Specifications,
  candidate10Universe,
  type Candidate10Bar,
  type Candidate10Dataset,
  type Candidate10Registration,
  type Candidate10Symbol,
} from './model'
import {
  buildCandidate10Plan,
  candidate10DecisionAtSignal,
  candidate10TerminalLiquidationIsComplete,
  trailingHighProximity,
} from './strategy'

const successOf = <A, E>(result: Result.Result<A, E>): A => {
  if (Result.isFailure(result)) throw new Error(`expected success: ${JSON.stringify(result.failure)}`)
  expect(Result.isSuccess(result)).toBe(true)
  return result.success
}

const marketBar = (symbol: Candidate10Symbol, sessionDate: IsoDate, close: number): DailyBar => ({
  symbol,
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
})

const alignedFixture = (count: number): readonly AlignedSession[] =>
  candidate10DevelopmentSessions()
    .slice(0, count)
    .map((date, index) => ({
      date,
      bars: Object.fromEntries(
        candidate10Universe.map((symbol, symbolIndex) => [symbol, marketBar(symbol, date, 100 + index + symbolIndex)]),
      ),
    }))

const decisionFixture = (signalIndex: number, spyFinal: number, dbcFinal: number): readonly AlignedSession[] =>
  candidate10DevelopmentSessions()
    .slice(0, signalIndex + 20)
    .map((date, index) => ({
      date,
      bars: Object.fromEntries(
        candidate10Universe.map((symbol) => {
          const final = symbol === 'SPY' ? spyFinal : symbol === 'DBC' ? dbcFinal : 90
          const close = index === signalIndex ? final : 100
          return [symbol, marketBar(symbol, date, close)]
        }),
      ),
    }))

const preflight = (): CandidateDevelopmentPreflightPass => {
  const sessions = candidate10DevelopmentSessions()
  const result = successOf(
    preflightCandidateDevelopment({
      officialSessions: sessions,
      signalSessionDates: officialMonthEndSignalDates(sessions),
      featureLookbackSessions: candidate10Protocol.feature.sessions,
    }),
  )
  expect(result.status).toBe('PASS')
  if (result.status !== 'PASS') throw new Error('expected passing development geometry')
  return result
}

const syntheticDataset = (): Candidate10Dataset => {
  const sessions = candidate10DevelopmentSessions()
  const closes = Object.fromEntries(candidate10Universe.map((symbol) => [symbol, 100])) as Record<
    Candidate10Symbol,
    number
  >
  const bars: Candidate10Bar[] = []
  sessions.forEach((sessionDate, index) => {
    const regime = Math.floor(index / 84) % candidate10Universe.length
    candidate10Universe.forEach((symbol, symbolIndex) => {
      const previousClose = closes[symbol]
      const regimeReturn = symbolIndex === regime ? 0.001 : -0.00005
      const cycle = Math.sin((index + symbolIndex * 13) / 23) * 0.00035
      const shock = index % (131 + symbolIndex * 7) === 0 ? -0.012 : 0
      const close = previousClose * (1.00025 + regimeReturn + cycle + shock)
      const open = previousClose * (1 + Math.sin((index + symbolIndex) / 17) * 0.0004)
      const high = Math.max(open, close) * (1.004 + symbolIndex * 0.0001)
      const low = Math.min(open, close) * (0.996 - symbolIndex * 0.0001)
      closes[symbol] = close
      bars.push({
        symbol,
        sessionDate,
        open,
        high,
        low,
        close,
        volume: 10_000_000 + index * 10 + symbolIndex,
      })
    })
  })
  const hashes = successOf(candidate10DatasetHashes(sessions, bars))
  return { snapshotId: CANDIDATE_10_SNAPSHOT_ID, sessions, bars, ...hashes }
}

describe('Candidate 10 benchmark-anchored 52-week-high rotation', () => {
  test('binds the preregistration before any metric-bearing implementation', async () => {
    const bytes = await Bun.file(
      new URL('../../candidates/ordinal-10-benchmark-anchored-52-week-high-preregistration.md', import.meta.url),
    ).arrayBuffer()
    expect(createHash('sha256').update(new Uint8Array(bytes)).digest('hex')).toBe(CANDIDATE_10_PREREGISTRATION_SHA256)
    expect(CANDIDATE_10_PREREGISTRATION_COMMIT).toMatch(/^[0-9a-f]{40}$/)
  })

  test('freezes the exact development calendar and five 197-session folds', () => {
    const sessions = candidate10DevelopmentSessions()
    const geometry = preflight()

    expect(sessions).toHaveLength(1_762)
    expect(sessions.at(0)).toBe(CANDIDATE_10_DEVELOPMENT_START)
    expect(sessions.at(-1)).toBe(CANDIDATE_10_DEVELOPMENT_END)
    expect(geometry.selectedObservationStartIndex).toBe(273)
    expect(geometry.selectedObservationEndIndex).toBe(1_761)
    expect(geometry.folds).toHaveLength(5)
    expect(geometry.folds.map((fold) => fold.testObservationCount)).toEqual([197, 197, 197, 197, 197])
  })

  test('uses exactly 252 causal closes and applies the frozen SPY hurdle', () => {
    const dates = candidate10DevelopmentSessions().slice(0, 252)
    const history = dates.map((date, index) => marketBar('SPY', date, index === 100 ? 120 : 100))
    expect(successOf(trailingHighProximity(history))).toBeCloseTo(100 / 120, 12)

    const signalIndex = 280
    const sessions = decisionFixture(signalIndex, 98, 98.5)
    const noHurdle = successOf(candidate10DecisionAtSignal(sessions, signalIndex, candidate10Specifications[0]))
    const onePointHurdle = successOf(candidate10DecisionAtSignal(sessions, signalIndex, candidate10Specifications[1]))

    expect(noHurdle.scores.SPY).toBe(0.98)
    expect(noHurdle.scores.DBC).toBe(0.985)
    expect(noHurdle.challenger).toBe('DBC')
    expect(noHurdle.selected).toBe('DBC')
    expect(onePointHurdle.selected).toBe('SPY')
    expect(Object.values(noHurdle.weights).reduce((sum, weight) => sum + weight, 0)).toBe(1)
  })

  test('does not leak future bars and executes every signal on the next session', () => {
    const signalIndex = 280
    const original = decisionFixture(signalIndex, 98, 98.5)
    const originalDecision = successOf(candidate10DecisionAtSignal(original, signalIndex, candidate10Specifications[0]))
    const futureChanged = original.map((session, index) =>
      index <= signalIndex
        ? session
        : {
            ...session,
            bars: Object.fromEntries(
              candidate10Universe.map((symbol) => [symbol, marketBar(symbol, session.date, 1_000_000 + index)]),
            ),
          },
    )
    const changedDecision = successOf(
      candidate10DecisionAtSignal(futureChanged, signalIndex, candidate10Specifications[0]),
    )
    expect(changedDecision).toEqual(originalDecision)

    const plan = successOf(buildCandidate10Plan(alignedFixture(1_762), preflight(), candidate10Specifications[0]))
    expect(plan.simulationStartIndex).toBe(272)
    expect(plan.evaluationStartIndex).toBe(273)
    expect(plan.targets.at(0)).toMatchObject({ signalIndex: 271, executionIndex: 272 })
    for (const target of plan.targets) expect(target.executionIndex).toBe(target.signalIndex + 1)
    for (const target of plan.targets.slice(0, -1)) {
      expect(Object.keys(target.weights).toSorted()).toEqual([...candidate10Universe])
      expect(Object.values(target.weights).reduce((sum, weight) => sum + weight, 0)).toBe(1)
    }
    expect(plan.targets.at(-1)).toMatchObject({ signalIndex: 1_760, executionIndex: 1_761 })
    expect(Object.values(plan.targets.at(-1)?.weights ?? {}).every((weight) => weight === 0)).toBe(true)
    expect(successOf(candidate10TerminalLiquidationIsComplete())).toBe(true)
  })

  test('runs preflight and preregistration before data I/O and evaluation', async () => {
    const sessions = candidate10DevelopmentSessions()
    const order: string[] = []
    const report = await Effect.runPromise(
      runCandidateDevelopment(
        {
          officialSessions: sessions,
          signalSessionDates: officialMonthEndSignalDates(sessions),
          featureLookbackSessions: candidate10Protocol.feature.sessions,
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

  test('materializes the bounded calendar before the five-symbol return query', async () => {
    const operations: string[] = []
    const client = {
      query: async (request: {
        readonly query: string
        readonly query_id: string
        readonly query_params: Readonly<Record<string, unknown>>
      }) => {
        operations.push(`query:${request.query_id}`)
        expect(request.query).toContain('toString(session_date) >= {start:String}')
        expect(request.query).toContain('toString(session_date) <= {end:String}')
        expect(request.query_params.start).toBe(CANDIDATE_10_DEVELOPMENT_START)
        expect(request.query_params.end).toBe(CANDIDATE_10_DEVELOPMENT_END)
        if (request.query_id.endsWith('bars')) {
          expect(request.query).toContain('symbol IN {symbols:Array(String)}')
          expect(request.query_params.symbols).toEqual(candidate10Universe)
        }
        return {
          json: async () => {
            operations.push(`json:${request.query_id}`)
            return request.query_id.endsWith('sessions')
              ? [{ session_date: CANDIDATE_10_DEVELOPMENT_START }]
              : candidate10Universe.map((symbol) => ({
                  symbol,
                  session_date: CANDIDATE_10_DEVELOPMENT_START,
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

    const loaded = await Effect.runPromise(queryCandidate10DevelopmentData(client))

    expect(loaded.sessions).toEqual([CANDIDATE_10_DEVELOPMENT_START])
    expect(loaded.bars.map((bar) => bar.symbol)).toEqual([...candidate10Universe])
    expect(operations).toEqual([
      'query:bayn-candidate-10-development-sessions',
      'json:bayn-candidate-10-development-sessions',
      'query:bayn-candidate-10-development-bars',
      'json:bayn-candidate-10-development-bars',
    ])
  })

  test('applies the three-way bounded-selection penalty after nine prior attempts', () => {
    const sessions = candidate10DevelopmentSessions().slice(273)
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
      analyzeQualificationWithSelectionMultiplicity(
        series,
        candidate10DevelopmentStatisticsPolicy,
        candidate10PriorAttemptIds,
        candidate10SelectionMultiplicity,
      ),
    )

    expect(candidate10PriorAttemptIds).toHaveLength(9)
    expect(analysis.candidateOrdinal).toBe(10)
    expect(analysis.bootstrap.adjustedOneSidedAlpha).toBeCloseTo(0.05 / 3 / 10, 15)
    expect(analysis.bootstrap.producedSamples).toBe(5_000)
    expect(analysis.walkForward.folds).toHaveLength(5)
    expect(analysis.completeBlocks.every((block) => block.endSession < block.nextRebalanceSession)).toBe(true)
  })

  test('selects only passing specifications by the frozen total ordering', () => {
    expect(
      selectCandidate10SpecificationId([
        {
          specificationId: 'high-proximity-h000',
          developmentPass: true,
          annualizedExcessReturnLowerBound: 0.01,
          sharpeDifferenceLowerBound: 0.02,
          annualTurnover: 2,
        },
        {
          specificationId: 'high-proximity-h010',
          developmentPass: true,
          annualizedExcessReturnLowerBound: 0.01,
          sharpeDifferenceLowerBound: 0.03,
          annualTurnover: 4,
        },
        {
          specificationId: 'high-proximity-h020',
          developmentPass: false,
          annualizedExcessReturnLowerBound: 1,
          sharpeDifferenceLowerBound: 1,
          annualTurnover: 0,
        },
      ]),
    ).toBe('high-proximity-h010')
    expect(
      selectCandidate10SpecificationId(
        candidate10Specifications.map((specification) => ({
          specificationId: specification.id,
          developmentPass: false,
          annualizedExcessReturnLowerBound: 0,
          sharpeDifferenceLowerBound: 0,
          annualTurnover: 0,
        })),
      ),
    ).toBeNull()
  })

  test('binds data, costs, folds, selection, and zero holdout access into a deterministic report', () => {
    const dataset = syntheticDataset()
    expect(successOf(prepareCandidate10DevelopmentData(dataset)).sessions).toHaveLength(1_762)
    const registration: Candidate10Registration = {
      preregistrationHash: CANDIDATE_10_PREREGISTRATION_SHA256,
      preregistrationCommit: CANDIDATE_10_PREREGISTRATION_COMMIT,
      evaluatedCommit: 'a'.repeat(40),
    }
    const first = successOf(evaluateCandidate10Development(registration, dataset, preflight()))
    const second = successOf(evaluateCandidate10Development(registration, dataset, preflight()))

    expect(second.identity).toEqual(first.identity)
    expect(first.specifications).toHaveLength(3)
    expect(first.selection).toMatchObject({
      specificationCount: 3,
      familyMultiplicityDivisor: 3,
      priorAttemptCount: 9,
    })
    expect(first.selection.adjustedOneSidedAlpha).toBeCloseTo(0.05 / 3 / 10, 15)
    for (const specification of first.specifications) {
      expect(specification.metrics.strategy.observations).toBe(1_489)
      expect(specification.metrics.strategy.totalSpreadCostMicros).not.toBe('0')
      expect(specification.metrics.strategy.totalSlippageCostMicros).not.toBe('0')
      expect(BigInt(specification.metrics.doubleCostStrategy.totalFeesMicros)).toBeGreaterThanOrEqual(
        BigInt(specification.metrics.strategy.totalFeesMicros),
      )
      expect(specification.uncertainty.producedBootstrapSamples).toBe(5_000)
      expect(specification.uncertainty.walkForwardFolds).toHaveLength(5)
    }
    expect(first.holdout).toEqual({
      start: '2023-01-03',
      end: '2025-12-31',
      inspected: false,
      accessCount: 0,
    })
  })
})
