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
  candidate14DatasetHashes,
  prepareCandidate14DevelopmentData,
  replayCandidate14FixedOrderCosts,
} from './development'
import {
  CANDIDATE_14_PROTOCOL_HASH,
  CANDIDATE_14_SNAPSHOT_ID,
  candidate14DevelopmentSessions,
  candidate14SimulationProtocol,
  candidate14Specifications,
  candidate14Universe,
  type Candidate14Bar,
  type Candidate14Dataset,
  type Candidate14Symbol,
} from './model'
import {
  buildCandidate14Plan,
  candidate14DecisionAtSignal,
  candidate14TerminalLiquidationIsComplete,
  relativeIntradayContinuationFeature,
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

const intradayReturn: Readonly<Record<Candidate14Symbol, number>> = {
  DBC: 0.0012,
  EFA: -0.0004,
  IEF: 0.0001,
  SPY: 0.0002,
  VNQ: 0.0006,
}

const syntheticSessions = (dates: readonly IsoDate[]): readonly AlignedSession[] =>
  dates.map((date, index) => {
    const bars = Object.fromEntries(
      candidate14Universe.map((symbol, symbolIndex) => {
        const open = rounded(100 + symbolIndex * 5 + index * 0.01)
        const close = rounded(open * (1 + intradayReturn[symbol]))
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

const officialSyntheticSessions = (): readonly AlignedSession[] => syntheticSessions(candidate14DevelopmentSessions())

const preflight = (): CandidateDevelopmentPreflightPass => {
  const result = successOf(
    preflightCandidateDevelopment({
      candidateOrdinal: 14,
      priorTrialCount: 13,
      officialSessions: candidate14DevelopmentSessions(),
      signalSessionDates: officialMonthEndSignalDates(candidate14DevelopmentSessions()),
      featureLookbackSessions: 126,
    }),
  )
  if (result.status !== 'PASS') throw new Error(`expected passing preflight: ${result.reason}`)
  return result
}

const datasetFrom = (sessions: readonly AlignedSession[]): Candidate14Dataset => {
  const dates = sessions.map((session) => session.date)
  const bars: Candidate14Bar[] = sessions.flatMap((session) =>
    candidate14Universe.map((symbol) => {
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
  const hashes = successOf(candidate14DatasetHashes(dates, bars))
  return { snapshotId: CANDIDATE_14_SNAPSHOT_ID, sessions: dates, bars, ...hashes }
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
    BigInt(candidate14SimulationProtocol.initialCapitalMicros),
  )
}

describe('Candidate 14 intraday-information continuation', () => {
  test('binds Candidate 14 to exact v2 geometry before I/O', () => {
    const result = preflight()

    expect(result.protocolIdentity.protocolHash).toBe(CANDIDATE_14_PROTOCOL_HASH)
    expect(result.attempt).toMatchObject({
      candidateOrdinal: 14,
      priorTrialCount: 13,
      bootstrapSamples: 10_000,
      adjustedOneSidedAlpha: 0.05 / 14,
      tailSampleCount: 35,
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

  test('selects the strongest positive relative intraday return and ignores overnight and future bars', () => {
    const sessions = syntheticSessions(addDays(new Date('2020-01-01T00:00:00.000Z'), 150))
    const signalIndex = 130
    const feature = successOf(
      relativeIntradayContinuationFeature(sessions, signalIndex, 'DBC', candidate14Specifications[0]),
    )
    const decision = successOf(candidate14DecisionAtSignal(sessions, signalIndex, candidate14Specifications[0]))
    const changedIrrelevantBars = sessions.map((session, index) => {
      if (index > signalIndex) {
        return {
          ...session,
          bars: Object.fromEntries(
            Object.entries(session.bars).map(([symbol, bar]) => [
              symbol,
              { ...bar, open: bar.open * 10, high: bar.high * 10, low: bar.low * 10, close: bar.close * 10 },
            ]),
          ),
        }
      }
      if (index === signalIndex - 10) {
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
      return session
    })
    const unchanged = successOf(
      candidate14DecisionAtSignal(changedIrrelevantBars, signalIndex, candidate14Specifications[0]),
    )

    expect(feature).toMatchObject({ symbol: 'DBC', eligible: true, windowEnd: sessions[signalIndex]?.date })
    expect(feature.score).toBeGreaterThan(0)
    expect(decision.selectedSymbol).toBe('DBC')
    expect(decision.weights).toEqual({ DBC: 0.9, EFA: 0, IEF: 0, SPY: 0, VNQ: 0 })
    expect(unchanged).toEqual(decision)
  })

  test('fails closed for unregistered parameters and the frozen price floor', () => {
    const sessions = syntheticSessions(addDays(new Date('2020-01-01T00:00:00.000Z'), 150))
    const changed = { ...candidate14Specifications[0], lookbackSessions: 125 }
    expect(candidate14DecisionAtSignal(sessions, 130, changed as never)).toMatchObject(
      Result.fail({ _tag: 'Candidate14InvalidInput', operation: 'specification' }),
    )

    const belowFloor = sessions.map((session, index) =>
      index === 20
        ? {
            ...session,
            bars: { ...session.bars, DBC: { ...session.bars.DBC, open: 4.99, low: 4.98, close: 5 } },
          }
        : session,
    )
    expect(relativeIntradayContinuationFeature(belowFloor, 130, 'DBC', candidate14Specifications[0])).toMatchObject(
      Result.fail({ _tag: 'Candidate14InvalidInput', operation: 'feature-window' }),
    )
  })

  test('binds and validates the complete ordered dataset identity', () => {
    const dataset = datasetFrom(officialSyntheticSessions())
    const prepared = successOf(prepareCandidate14DevelopmentData(dataset))
    const reordered = { ...dataset, bars: [dataset.bars[1], dataset.bars[0], ...dataset.bars.slice(2)] }

    expect(prepared.sessions).toHaveLength(1_762)
    expect(prepared.dataset.bars).toHaveLength(8_810)
    expect(prepareCandidate14DevelopmentData(reordered as Candidate14Dataset)).toMatchObject(
      Result.fail({ _tag: 'Candidate14InvalidInput', operation: 'dataset' }),
    )
  })

  test('builds monthly next-session decisions and terminal all-cash liquidation', () => {
    const sessions = officialSyntheticSessions()
    const plan = successOf(buildCandidate14Plan(sessions, preflight(), candidate14Specifications[0]))
    const first = plan.targets.at(0)
    const terminal = plan.targets.at(-1)

    expect(first).toMatchObject({ signalIndex: 144, executionIndex: 145 })
    expect(sessions.at(first?.signalIndex ?? -1)?.date).toBe('2016-07-29')
    expect(sessions.at(first?.executionIndex ?? -1)?.date).toBe('2016-08-01')
    expect(terminal).toMatchObject({ signalIndex: 1_760, executionIndex: 1_761 })
    expect(terminal?.weights).toEqual({ DBC: 0, EFA: 0, IEF: 0, SPY: 0, VNQ: 0 })
    expect(successOf(candidate14TerminalLiquidationIsComplete())).toBe(true)
  })

  test('replays the exact baseline quantity path with doubled costs and no borrowing', () => {
    const sessions = officialSyntheticSessions()
    const geometry = preflight()
    const plan = successOf(buildCandidate14Plan(sessions, geometry, candidate14Specifications[0]))
    const runId = successOf(
      canonicalHashV1Result({ schemaVersion: 'bayn.candidate-14-test-run.v1', name: 'fixed-order-cost-replay' }),
    )
    const baseline = successOf(
      simulate(sessions, plan.targets, plan.simulationStartIndex, candidate14SimulationProtocol, MICROS, runId, true),
    )
    const baselineMetrics = successOf(selectedMetrics(baseline, geometry.selectedObservationStart))
    const baselineTrace = baseline.simulation
    if (baselineTrace === null) throw new Error('baseline trace missing')
    const replayAtOne = successOf(
      replayCandidate14FixedOrderCosts(
        sessions,
        baseline,
        plan.simulationStartIndex,
        plan.evaluationStartIndex,
        candidate14SimulationProtocol,
        MICROS,
        runId,
      ),
    )
    const replayAtTwo = successOf(
      replayCandidate14FixedOrderCosts(
        sessions,
        baseline,
        plan.simulationStartIndex,
        plan.evaluationStartIndex,
        candidate14SimulationProtocol,
        BigInt(candidate14SimulationProtocol.executionModel.doubleCostMultiplier) * MICROS,
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
