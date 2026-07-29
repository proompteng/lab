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
import { calculateExactPerformanceMetrics } from '../simulation/metrics'
import { simulate, type AlignedSession, type SimulationResult } from '../simulation'
import { DataFeed, DataSource, PriceAdjustment, PublicationSchema, type DailyBar, type IsoDate } from '../types'
import {
  candidate13DatasetHashes,
  prepareCandidate13DevelopmentData,
  replayCandidate13FixedOrderCosts,
} from './development'
import {
  CANDIDATE_13_PROTOCOL_HASH,
  CANDIDATE_13_SNAPSHOT_ID,
  candidate13DevelopmentSessions,
  candidate13SimulationProtocol,
  candidate13Specifications,
  candidate13Universe,
  type Candidate13Bar,
  type Candidate13Dataset,
  type Candidate13Symbol,
} from './model'
import {
  buildCandidate13Plan,
  candidate13DecisionAtSignal,
  candidate13TerminalLiquidationIsComplete,
  spyResidualMomentumFeature,
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

const syntheticSessions = (dates: readonly IsoDate[]): readonly AlignedSession[] => {
  const prices: Record<Candidate13Symbol, number> = { DBC: 100, EFA: 100, IEF: 100, SPY: 100, VNQ: 100 }
  return dates.map((date, index) => {
    const spyReturn = 0.0004 + 0.0015 * Math.sin(index / 9)
    const residuals: Record<Exclude<Candidate13Symbol, 'SPY'>, number> = {
      DBC: 0.0012 + 0.0007 * Math.sin(index / 5),
      EFA: -0.0008 + 0.0005 * Math.cos(index / 7),
      IEF: -0.0001 + 0.0004 * Math.sin(index / 11),
      VNQ: 0.0005 + 0.0008 * Math.cos(index / 6),
    }
    prices.SPY *= 1 + spyReturn
    prices.DBC *= 1 + 0.7 * spyReturn + residuals.DBC
    prices.EFA *= 1 + 1.1 * spyReturn + residuals.EFA
    prices.IEF *= 1 - 0.2 * spyReturn + residuals.IEF
    prices.VNQ *= 1 + 0.9 * spyReturn + residuals.VNQ
    const bars = Object.fromEntries(
      candidate13Universe.map((symbol) => {
        const close = rounded(prices[symbol])
        const open = rounded(close * (1 + 0.0002 * Math.sin(index / 3)))
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

const officialSyntheticSessions = (): readonly AlignedSession[] => syntheticSessions(candidate13DevelopmentSessions())

const preflight = (): CandidateDevelopmentPreflightPass => {
  const result = successOf(
    preflightCandidateDevelopment({
      candidateOrdinal: 13,
      priorTrialCount: 12,
      officialSessions: candidate13DevelopmentSessions(),
      signalSessionDates: officialMonthEndSignalDates(candidate13DevelopmentSessions()),
      featureLookbackSessions: 252,
    }),
  )
  if (result.status !== 'PASS') throw new Error(`expected passing preflight: ${result.reason}`)
  return result
}

const datasetFrom = (sessions: readonly AlignedSession[]): Candidate13Dataset => {
  const dates = sessions.map((session) => session.date)
  const bars: Candidate13Bar[] = sessions.flatMap((session) =>
    candidate13Universe.map((symbol) => {
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
  const hashes = successOf(candidate13DatasetHashes(dates, bars))
  return { snapshotId: CANDIDATE_13_SNAPSHOT_ID, sessions: dates, bars, ...hashes }
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
    BigInt(candidate13SimulationProtocol.initialCapitalMicros),
  )
}

describe('Candidate 13 SPY-residual momentum', () => {
  test('binds Candidate 13 to the exact v2 geometry before I/O', () => {
    const result = preflight()

    expect(result.protocolIdentity.protocolHash).toBe(CANDIDATE_13_PROTOCOL_HASH)
    expect(result.attempt).toMatchObject({
      candidateOrdinal: 13,
      priorTrialCount: 12,
      bootstrapSamples: 10_000,
      tailSampleCount: 38,
    })
    expect(result).toMatchObject({
      selectedObservationStart: '2017-02-02',
      selectedObservationEnd: '2022-12-30',
      availableObservations: 1_490,
      requiredObservations: 1_489,
      unusedEligibleObservations: 1,
      requiredFoldCount: 5,
    })
    expect(result.folds).toHaveLength(5)
  })

  test('selects positive factor-residual momentum and ignores all future bars', () => {
    const sessions = syntheticSessions(addDays(new Date('2020-01-01T00:00:00.000Z'), 270))
    const signalIndex = 252
    const feature = successOf(spyResidualMomentumFeature(sessions, signalIndex, 'DBC', candidate13Specifications[0]))
    const decision = successOf(candidate13DecisionAtSignal(sessions, signalIndex, candidate13Specifications[0]))
    const changedFuture = sessions.map((session, index) =>
      index <= signalIndex
        ? session
        : {
            ...session,
            bars: Object.fromEntries(
              Object.entries(session.bars).map(([symbol, bar]) => [symbol, { ...bar, close: bar.close * 100 }]),
            ),
          },
    )
    const futureDecision = successOf(
      candidate13DecisionAtSignal(changedFuture, signalIndex, candidate13Specifications[0]),
    )

    expect(feature).toMatchObject({ symbol: 'DBC', eligible: true })
    expect(feature.score).toBeGreaterThan(0)
    expect(decision.selectedSymbol).toBe('DBC')
    expect(decision.weights).toEqual({ DBC: 0.495, EFA: 0, IEF: 0, SPY: 0.495, VNQ: 0 })
    expect(futureDecision).toEqual(decision)
  })

  test('fails closed for an unregistered specification and zero SPY variance', () => {
    const sessions = syntheticSessions(addDays(new Date('2020-01-01T00:00:00.000Z'), 260))
    const changed = { ...candidate13Specifications[0], formationReturnCount: 230 }
    expect(candidate13DecisionAtSignal(sessions, 252, changed as never)).toMatchObject(
      Result.fail({ _tag: 'Candidate13InvalidInput', operation: 'specification' }),
    )

    const flatSpy = sessions.map((session) => ({
      ...session,
      bars: {
        ...session.bars,
        SPY: { ...session.bars.SPY, open: 100, high: 101, low: 99, close: 100 },
      },
    }))
    expect(spyResidualMomentumFeature(flatSpy, 252, 'DBC', candidate13Specifications[0])).toMatchObject(
      Result.fail({
        _tag: 'Candidate13InvalidInput',
        operation: 'residual-regression',
        reason: 'SPY return variance is not strictly positive',
      }),
    )
  })

  test('binds and validates the complete ordered dataset identity', () => {
    const dataset = datasetFrom(officialSyntheticSessions())
    const prepared = successOf(prepareCandidate13DevelopmentData(dataset))
    const reordered = { ...dataset, bars: [dataset.bars[1], dataset.bars[0], ...dataset.bars.slice(2)] }

    expect(prepared.sessions).toHaveLength(1_762)
    expect(prepared.dataset.bars).toHaveLength(8_810)
    expect(prepareCandidate13DevelopmentData(reordered as Candidate13Dataset)).toMatchObject(
      Result.fail({ _tag: 'Candidate13InvalidInput', operation: 'dataset' }),
    )
  })

  test('builds monthly next-session decisions and terminal all-cash liquidation', () => {
    const sessions = officialSyntheticSessions()
    const plan = successOf(buildCandidate13Plan(sessions, preflight(), candidate13Specifications[0]))
    const first = plan.targets.at(0)
    const terminal = plan.targets.at(-1)

    expect(first).toMatchObject({ signalIndex: 271, executionIndex: 272 })
    expect(sessions.at(first?.signalIndex ?? -1)?.date).toBe('2017-01-31')
    expect(sessions.at(first?.executionIndex ?? -1)?.date).toBe('2017-02-01')
    expect(terminal).toMatchObject({ signalIndex: 1_760, executionIndex: 1_761 })
    expect(terminal?.weights).toEqual({ DBC: 0, EFA: 0, IEF: 0, SPY: 0, VNQ: 0 })
    expect(successOf(candidate13TerminalLiquidationIsComplete())).toBe(true)
  })

  test('replays the exact baseline quantity path and changes only costs', () => {
    const sessions = officialSyntheticSessions()
    const geometry = preflight()
    const plan = successOf(buildCandidate13Plan(sessions, geometry, candidate13Specifications[0]))
    const runId = successOf(
      canonicalHashV1Result({ schemaVersion: 'bayn.candidate-13-test-run.v1', name: 'fixed-order-cost-replay' }),
    )
    const baseline = successOf(
      simulate(sessions, plan.targets, plan.simulationStartIndex, candidate13SimulationProtocol, MICROS, runId, true),
    )
    const baselineMetrics = successOf(selectedMetrics(baseline, geometry.selectedObservationStart))
    const baselineTrace = baseline.simulation
    if (baselineTrace === null) throw new Error('baseline trace missing')
    const replayAtOne = successOf(
      replayCandidate13FixedOrderCosts(
        sessions,
        baseline,
        plan.simulationStartIndex,
        plan.evaluationStartIndex,
        candidate13SimulationProtocol,
        MICROS,
        runId,
      ),
    )
    const replayAtTwo = successOf(
      replayCandidate13FixedOrderCosts(
        sessions,
        baseline,
        plan.simulationStartIndex,
        plan.evaluationStartIndex,
        candidate13SimulationProtocol,
        BigInt(candidate13SimulationProtocol.executionModel.doubleCostMultiplier) * MICROS,
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
