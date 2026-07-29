import { describe, expect, test } from 'bun:test'
import { Result } from 'effect'

import {
  candidateDevelopmentDoubledCostContract,
  officialMonthEndSignalDates,
  preflightCandidateDevelopment,
  type CandidateDevelopmentPreflightPass,
} from '../candidate-development'
import { MICROS } from '../execution-model'
import { canonicalHashV1Result } from '../hash'
import { simulate, type AlignedSession, type SimulationResult } from '../simulation'
import { calculateExactPerformanceMetrics } from '../simulation/metrics'
import { DataFeed, DataSource, PriceAdjustment, PublicationSchema, type DailyBar, type IsoDate } from '../types'
import {
  candidate15DatasetHashes,
  prepareCandidate15DevelopmentData,
  replayCandidate15FixedOrderCosts,
} from './development'
import {
  CANDIDATE_15_PREREGISTRATION_COMMIT,
  CANDIDATE_15_PREREGISTRATION_SHA256,
  CANDIDATE_15_PROTOCOL_HASH,
  CANDIDATE_15_SNAPSHOT_ID,
  candidate15DevelopmentSessions,
  candidate15PriorAttemptIds,
  candidate15SimulationProtocol,
  candidate15Specifications,
  candidate15Universe,
  type Candidate15Bar,
  type Candidate15Dataset,
  type Candidate15Symbol,
} from './model'
import {
  buildCandidate15Plan,
  candidate15DecisionAtSignal,
  candidate15TerminalLiquidationIsComplete,
  stockBondCorrelationFeature,
} from './strategy'

const successOf = <A, E>(result: Result.Result<A, E>): A => {
  expect(Result.isSuccess(result)).toBe(true)
  if (Result.isFailure(result)) throw new Error(`expected success: ${String(result.failure)}`)
  return result.success
}

const addDays = (start: Date, count: number): readonly IsoDate[] =>
  Array.from({ length: count }, (_, index) =>
    new Date(start.getTime() + index * 86_400_000).toISOString().slice(0, 10),
  ) as readonly IsoDate[]

const rounded = (value: number): number => Number.parseFloat(value.toFixed(8))

type CorrelationRegime = 'positive' | 'negative' | 'zero'

const returnFor = (symbol: Candidate15Symbol, index: number, regime: CorrelationRegime): number => {
  const ordinal = index - 1
  const spyPattern = [0.006, -0.004, 0.003, -0.005, 0.002, -0.001] as const
  const spy = spyPattern[ordinal % spyPattern.length] ?? 0
  if (symbol === 'SPY') return regime === 'zero' ? 0.004 * Math.sin((2 * Math.PI * ordinal) / 126) : spy
  if (symbol === 'IEF') {
    if (regime === 'zero') return 0.004 * Math.cos((2 * Math.PI * ordinal) / 126)
    return regime === 'positive' ? spy * 0.6 : spy * -0.6
  }
  if (symbol === 'DBC') return [0.002, -0.001, 0.001, -0.0015][ordinal % 4] ?? 0
  if (symbol === 'EFA') return spy * 0.8
  return spy * 0.4
}

const syntheticSessions = (
  dates: readonly IsoDate[],
  regime: CorrelationRegime = 'positive',
): readonly AlignedSession[] => {
  const closes: Record<Candidate15Symbol, number[]> = {
    DBC: [100],
    EFA: [110],
    IEF: [120],
    SPY: [130],
    VNQ: [140],
  }
  for (let index = 1; index < dates.length; index += 1) {
    for (const symbol of candidate15Universe) {
      const previous = closes[symbol].at(-1)
      if (previous === undefined) throw new Error(`${symbol} synthetic close missing`)
      closes[symbol].push(previous * (1 + returnFor(symbol, index, regime)))
    }
  }
  return dates.map((date, index) => {
    const bars = Object.fromEntries(
      candidate15Universe.map((symbol) => {
        const close = closes[symbol][index]
        const open = closes[symbol][Math.max(0, index - 1)]
        if (close === undefined || open === undefined) throw new Error(`${symbol} synthetic bar missing`)
        return [
          symbol,
          {
            symbol,
            sessionDate: date,
            open,
            high: rounded(Math.max(open, close) * 1.002),
            low: rounded(Math.min(open, close) * 0.998),
            close,
            volume: 1_000_000 + index,
            source: DataSource.Alpaca,
            sourceFeed: DataFeed.Sip,
            adjustment: PriceAdjustment.All,
            publicationSchemaVersion: PublicationSchema.AdjustedDailySnapshotV2,
          } satisfies DailyBar,
        ] as const
      }),
    )
    return { date, bars }
  })
}

const officialSyntheticSessions = (regime: CorrelationRegime = 'positive'): readonly AlignedSession[] =>
  syntheticSessions(candidate15DevelopmentSessions(), regime)

const preflight = (): CandidateDevelopmentPreflightPass => {
  const sessions = candidate15DevelopmentSessions()
  const result = successOf(
    preflightCandidateDevelopment({
      candidateOrdinal: 15,
      priorTrialCount: 14,
      officialSessions: sessions,
      signalSessionDates: officialMonthEndSignalDates(sessions),
      featureLookbackSessions: 126,
    }),
  )
  if (result.status !== 'PASS') throw new Error(`expected passing preflight: ${result.reason}`)
  return result
}

const datasetFrom = (sessions: readonly AlignedSession[]): Candidate15Dataset => {
  const dates = sessions.map((session) => session.date)
  const bars: Candidate15Bar[] = sessions.flatMap((session) =>
    candidate15Universe.map((symbol) => {
      const bar = session.bars[symbol]
      if (bar === undefined) throw new Error(`${symbol} missing on ${session.date}`)
      return {
        symbol,
        sessionDate: session.date,
        open: bar.open,
        high: bar.high,
        low: bar.low,
        close: bar.close,
        volume: bar.volume,
      }
    }),
  )
  const hashes = successOf(candidate15DatasetHashes(dates, bars))
  return { snapshotId: CANDIDATE_15_SNAPSHOT_ID, sessions: dates, bars, ...hashes }
}

const selectedMetrics = (
  raw: SimulationResult,
  evaluationStartDate: IsoDate,
): ReturnType<typeof calculateExactPerformanceMetrics> => {
  const offset = raw.dailyPerformance.findIndex((point) => point.sessionDate === evaluationStartDate)
  if (offset < 0) throw new Error('evaluation start missing')
  const selected = raw.dailyPerformance.slice(offset)
  const last = selected.at(-1)
  if (last === undefined) throw new Error('selected performance missing')
  return calculateExactPerformanceMetrics(
    selected.map((point) => BigInt(point.equityMicros)),
    BigInt(last.cumulativeTurnoverMicros),
    BigInt(last.cumulativeFeesMicros),
    BigInt(last.cumulativeSpreadCostMicros),
    BigInt(last.cumulativeSlippageCostMicros),
    BigInt(last.cumulativeCashYieldMicros),
    BigInt(candidate15SimulationProtocol.initialCapitalMicros),
  )
}

describe('Candidate 15 stock-bond-correlation regime allocation', () => {
  test('binds Candidate 15 to the exact v2 geometry before I/O', () => {
    const result = preflight()

    expect(result.protocolIdentity.protocolHash).toBe(CANDIDATE_15_PROTOCOL_HASH)
    expect(CANDIDATE_15_PREREGISTRATION_COMMIT).toBe('9aac01753a332aeeeac2bc20d7536eeb45d74a51')
    expect(CANDIDATE_15_PREREGISTRATION_SHA256).toBe('e11ad74f8f4d8ab8e9c57528fe021b809190a9b0e56c5c01c55e25cf3f527828')
    expect(candidate15PriorAttemptIds).toHaveLength(14)
    expect(candidate15PriorAttemptIds.at(-1)).toBe('cc3ec71d86e90308697c7ca58598d0b7cef50553fcc9d4576159da6c42e7b066')
    expect(result.attempt).toMatchObject({
      candidateOrdinal: 15,
      priorTrialCount: 14,
      bootstrapSamples: 10_000,
      adjustedOneSidedAlpha: 0.05 / 15,
      tailSampleCount: 33,
    })
    expect(result).toMatchObject({
      selectedObservationStart: '2017-02-02',
      selectedObservationEnd: '2022-12-30',
      availableObservations: 1_617,
      requiredObservations: 1_489,
      unusedEligibleObservations: 128,
      requiredFoldCount: 5,
    })
    expect(result.firstEligibleExecution).toEqual({
      signalIndex: 144,
      signalDate: '2016-07-29',
      executionIndex: 145,
      executionDate: '2016-08-01',
    })
  })

  test('selects DBC only when the rounded SPY-IEF correlation is positive', () => {
    const sessions = syntheticSessions(addDays(new Date('2020-01-01T00:00:00.000Z'), 150), 'positive')
    const signalIndex = 130
    const feature = successOf(stockBondCorrelationFeature(sessions, signalIndex, candidate15Specifications[0]))
    const decision = successOf(candidate15DecisionAtSignal(sessions, signalIndex, candidate15Specifications[0]))

    expect(feature.correlation).toBeGreaterThan(0)
    expect(feature.selectedDiversifier).toBe('DBC')
    expect(decision.selectedDiversifier).toBe('DBC')
    expect(decision.weights).toEqual({ DBC: 0.45, EFA: 0, IEF: 0, SPY: 0.45, VNQ: 0 })
  })

  test('selects IEF for negative and exact-zero rounded correlation', () => {
    const dates = addDays(new Date('2020-01-01T00:00:00.000Z'), 150)
    const negative = successOf(
      candidate15DecisionAtSignal(syntheticSessions(dates, 'negative'), 130, candidate15Specifications[0]),
    )
    const zero = successOf(
      candidate15DecisionAtSignal(syntheticSessions(dates, 'zero'), 126, candidate15Specifications[0]),
    )

    expect(negative.feature.correlation).toBeLessThan(0)
    expect(negative.selectedDiversifier).toBe('IEF')
    expect(negative.weights).toEqual({ DBC: 0, EFA: 0, IEF: 0.45, SPY: 0.45, VNQ: 0 })
    expect(zero.feature.correlation).toBe(0)
    expect(zero.selectedDiversifier).toBe('IEF')
  })

  test('uses only aligned SPY and IEF closes through the finalized signal', () => {
    const sessions = syntheticSessions(addDays(new Date('2020-01-01T00:00:00.000Z'), 150), 'positive')
    const signalIndex = 130
    const decision = successOf(candidate15DecisionAtSignal(sessions, signalIndex, candidate15Specifications[0]))
    const changedIrrelevantBars = sessions.map((session, index) => {
      if (index > signalIndex) {
        return {
          ...session,
          bars: Object.fromEntries(
            Object.entries(session.bars).map(([symbol, bar]) => [
              symbol,
              { ...bar, open: bar.open * 2, high: bar.high * 2, low: bar.low * 2, close: bar.close * 2 },
            ]),
          ),
        }
      }
      const mutate = (bar: DailyBar): DailyBar => ({
        ...bar,
        open: bar.close,
        high: rounded(bar.close * 1.01),
        low: rounded(bar.close * 0.99),
        volume: bar.volume * 3,
      })
      return {
        ...session,
        bars: {
          ...session.bars,
          DBC: { ...mutate(session.bars.DBC), close: rounded(session.bars.DBC.close * 1.1) },
          EFA: { ...mutate(session.bars.EFA), close: rounded(session.bars.EFA.close * 1.1) },
          VNQ: { ...mutate(session.bars.VNQ), close: rounded(session.bars.VNQ.close * 1.1) },
          SPY: mutate(session.bars.SPY),
          IEF: mutate(session.bars.IEF),
        },
      }
    })
    const unchanged = successOf(
      candidate15DecisionAtSignal(changedIrrelevantBars, signalIndex, candidate15Specifications[0]),
    )

    expect(unchanged).toEqual(decision)
  })

  test('fails closed for unregistered parameters, zero variance, and the price floor', () => {
    const sessions = syntheticSessions(addDays(new Date('2020-01-01T00:00:00.000Z'), 150), 'positive')
    const changed = { ...candidate15Specifications[0], lookbackSessions: 125 }
    expect(candidate15DecisionAtSignal(sessions, 130, changed as never)).toMatchObject(
      Result.fail({ _tag: 'Candidate15InvalidInput', operation: 'specification' }),
    )

    const zeroVariance = sessions.map((session) => ({
      ...session,
      bars: { ...session.bars, IEF: { ...session.bars.IEF, close: 100, open: 100, high: 101, low: 99 } },
    }))
    expect(stockBondCorrelationFeature(zeroVariance, 130, candidate15Specifications[0])).toMatchObject(
      Result.fail({ _tag: 'Candidate15InvalidInput', operation: 'correlation-window' }),
    )

    const belowFloor = sessions.map((session, index) =>
      index === 20
        ? {
            ...session,
            bars: { ...session.bars, SPY: { ...session.bars.SPY, open: 5, high: 5.01, low: 4.99, close: 4.99 } },
          }
        : session,
    )
    expect(stockBondCorrelationFeature(belowFloor, 130, candidate15Specifications[0])).toMatchObject(
      Result.fail({ _tag: 'Candidate15InvalidInput', operation: 'correlation-window' }),
    )
  })

  test('binds and validates the complete ordered dataset identity', () => {
    const dataset = datasetFrom(officialSyntheticSessions())
    const prepared = successOf(prepareCandidate15DevelopmentData(dataset))
    const reordered = { ...dataset, bars: [dataset.bars[1], dataset.bars[0], ...dataset.bars.slice(2)] }

    expect(prepared.sessions).toHaveLength(1_762)
    expect(prepared.dataset.bars).toHaveLength(8_810)
    expect(prepareCandidate15DevelopmentData(reordered as Candidate15Dataset)).toMatchObject(
      Result.fail({ _tag: 'Candidate15InvalidInput', operation: 'dataset' }),
    )
  })

  test('builds monthly next-session decisions and terminal all-cash liquidation', () => {
    const sessions = officialSyntheticSessions()
    const plan = successOf(buildCandidate15Plan(sessions, preflight(), candidate15Specifications[0]))
    const first = plan.targets.at(0)
    const terminal = plan.targets.at(-1)

    expect(first).toMatchObject({ signalIndex: 144, executionIndex: 145 })
    expect(sessions.at(first?.signalIndex ?? -1)?.date).toBe('2016-07-29')
    expect(sessions.at(first?.executionIndex ?? -1)?.date).toBe('2016-08-01')
    expect(terminal).toMatchObject({ signalIndex: 1_760, executionIndex: 1_761 })
    expect(terminal?.weights).toEqual({ DBC: 0, EFA: 0, IEF: 0, SPY: 0, VNQ: 0 })
    expect(successOf(candidate15TerminalLiquidationIsComplete())).toBe(true)
  })

  test('replays the exact baseline quantity path with doubled costs and no borrowing', () => {
    const sessions = officialSyntheticSessions()
    const geometry = preflight()
    const plan = successOf(buildCandidate15Plan(sessions, geometry, candidate15Specifications[0]))
    const runId = successOf(
      canonicalHashV1Result({ schemaVersion: 'bayn.candidate-15-test-run.v1', name: 'fixed-order-cost-replay' }),
    )
    const baseline = successOf(
      simulate(sessions, plan.targets, plan.simulationStartIndex, candidate15SimulationProtocol, MICROS, runId, true),
    )
    const baselineMetrics = successOf(selectedMetrics(baseline, geometry.selectedObservationStart))
    const baselineTrace = baseline.simulation
    if (baselineTrace === null) throw new Error('baseline trace missing')
    const replayAtOne = successOf(
      replayCandidate15FixedOrderCosts(
        sessions,
        baseline,
        plan.simulationStartIndex,
        plan.evaluationStartIndex,
        candidate15SimulationProtocol,
        MICROS,
        runId,
      ),
    )
    const replayAtTwo = successOf(
      replayCandidate15FixedOrderCosts(
        sessions,
        baseline,
        plan.simulationStartIndex,
        plan.evaluationStartIndex,
        candidate15SimulationProtocol,
        BigInt(candidate15SimulationProtocol.executionModel.doubleCostMultiplier) * MICROS,
        runId,
      ),
    )

    expect(replayAtOne.result.metrics).toEqual(baselineMetrics)
    expect(replayAtOne.result.simulation.orders).toEqual(baselineTrace.orders)
    expect(replayAtTwo.result.simulation.orders).toEqual(baselineTrace.orders)
    expect(replayAtTwo.result.signalDecisions).toEqual(baseline.signalDecisions)
    expect(replayAtTwo.result.simulation.costMultiplierMicros).toBe(
      candidateDevelopmentDoubledCostContract.stressedCostMultiplierMicros,
    )
    expect(replayAtTwo.result.metrics.totalSpreadCostMicros).not.toBe(baselineMetrics.totalSpreadCostMicros)
    expect(replayAtTwo.terminalCash).toBe(true)
  })
})
