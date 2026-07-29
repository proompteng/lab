import { describe, expect, test } from 'bun:test'
import { Result } from 'effect'

import { MICROS } from '../execution-model'
import { simulate, type AlignedSession } from '../simulation'
import { DataFeed, DataSource, PriceAdjustment, PublicationSchema, type DailyBar, type IsoDate } from '../types'
import { buildCandidate7Plan, makeCandidate7Decision } from './decision'
import {
  CANDIDATE_7_DEVELOPMENT_END,
  CANDIDATE_7_EVALUATION_START,
  CANDIDATE_7_TERMINAL_SIGNAL,
  CANDIDATE_7_UNIVERSE,
  type Candidate7Symbol,
} from './model'
import { candidate7SimulationProtocol } from './development'

const isoDate = (date: Date): IsoDate => date.toISOString().slice(0, 10) as IsoDate

const sessionDates = (start: string, count: number): readonly IsoDate[] =>
  Array.from({ length: count }, (_, index) => {
    const date = new Date(`${start}T00:00:00.000Z`)
    date.setUTCDate(date.getUTCDate() + index)
    return isoDate(date)
  })

const weekdayDates = (start: string, end: string): readonly IsoDate[] => {
  const dates: IsoDate[] = []
  const current = new Date(`${start}T00:00:00.000Z`)
  const terminal = new Date(`${end}T00:00:00.000Z`)
  while (current <= terminal) {
    const day = current.getUTCDay()
    if (day !== 0 && day !== 6) dates.push(isoDate(current))
    current.setUTCDate(current.getUTCDate() + 1)
  }
  return dates
}

const bar = (symbol: Candidate7Symbol, sessionDate: IsoDate, close: number): DailyBar => ({
  symbol,
  sessionDate,
  open: close * 0.999,
  high: close * 1.002,
  low: close * 0.998,
  close,
  volume: 10_000_000,
  source: DataSource.Alpaca,
  sourceFeed: DataFeed.Sip,
  adjustment: PriceAdjustment.All,
  publicationSchemaVersion: PublicationSchema.AdjustedDailySnapshotV2,
})

const makeSessions = (
  dates: readonly IsoDate[],
  drifts: Readonly<Record<Candidate7Symbol, number>>,
  equalPhases = false,
): readonly AlignedSession[] =>
  dates.map((date, index) => ({
    date,
    bars: Object.fromEntries(
      CANDIDATE_7_UNIVERSE.map((symbol, symbolIndex) => {
        const phase = equalPhases ? 0 : symbolIndex * 0.43
        const close = 100 * Math.exp(drifts[symbol] * index + 0.01 * Math.sin(index * 0.7 + phase))
        return [symbol, bar(symbol, date, close)]
      }),
    ),
  }))

const positiveDrifts = {
  DBC: 0.001,
  EFA: 0.0008,
  IEF: 0.0004,
  SPY: -0.0002,
  VNQ: 0.0001,
} as const

describe('Candidate 7 relative-strength decision', () => {
  test('ranks 12-minus-1-month winners and selects exactly the top two positive assets', () => {
    const sessions = makeSessions(sessionDates('2016-01-04', 254), positiveDrifts)
    const result = makeCandidate7Decision(sessions, 252)

    expect(Result.isSuccess(result)).toBe(true)
    if (Result.isFailure(result)) return
    expect(result.success.signals.slice(0, 2).map((signal) => signal.symbol)).toEqual(['DBC', 'EFA'])
    expect(result.success.signals.filter((signal) => signal.selected).map((signal) => signal.symbol)).toEqual([
      'DBC',
      'EFA',
    ])
    expect(result.success.targetWeights.DBC).toBeGreaterThan(0)
    expect(result.success.targetWeights.EFA).toBeGreaterThan(0)
    expect(result.success.targetWeights.DBC).toBeLessThanOrEqual(0.5)
    expect(
      Object.values(result.success.targetWeights).reduce((total, weight) => total + weight, 0),
    ).toBeLessThanOrEqual(1)
    expect(result.success.estimatedAnnualizedVolatility).toBeGreaterThan(0)
    expect(result.success.exposureScale).toBeGreaterThan(0)
    expect(result.success.exposureScale).toBeLessThanOrEqual(1)
  })

  test('breaks exact score ties by ascending symbol', () => {
    const sessions = makeSessions(
      sessionDates('2016-01-04', 254),
      { DBC: 0.001, EFA: 0.001, IEF: 0.0003, SPY: -0.001, VNQ: -0.0005 },
      true,
    )
    const result = makeCandidate7Decision(sessions, 252)

    expect(Result.isSuccess(result)).toBe(true)
    if (Result.isFailure(result)) return
    expect(result.success.signals.slice(0, 2).map((signal) => signal.symbol)).toEqual(['DBC', 'EFA'])
  })

  test('holds cash when every relative-strength score is non-positive', () => {
    const sessions = makeSessions(sessionDates('2016-01-04', 254), {
      DBC: -0.001,
      EFA: -0.0011,
      IEF: -0.0007,
      SPY: -0.0013,
      VNQ: -0.0009,
    })
    const result = makeCandidate7Decision(sessions, 252)

    expect(Result.isSuccess(result)).toBe(true)
    if (Result.isFailure(result)) return
    expect(result.success.signals.some((signal) => signal.selected)).toBe(false)
    expect(Object.values(result.success.targetWeights)).toEqual([0, 0, 0, 0, 0])
    expect(result.success.exposureScale).toBe(0)
  })

  test('builds causal month-end targets and closes at the frozen development boundary', () => {
    const dates = weekdayDates('2016-01-04', CANDIDATE_7_DEVELOPMENT_END)
    const sessions = makeSessions(dates, positiveDrifts)
    const plan = buildCandidate7Plan(sessions)

    expect(Result.isSuccess(plan)).toBe(true)
    if (Result.isFailure(plan)) return
    const firstEvaluationSession = sessions.at(plan.success.startIndex)
    expect(firstEvaluationSession).toBeDefined()
    expect((firstEvaluationSession?.date ?? '') >= CANDIDATE_7_EVALUATION_START).toBe(true)
    expect(plan.success.decisions.every((decision) => decision.signalDate < decision.executionDate)).toBe(true)
    expect(plan.success.decisions.every((decision) => decision.executionDate < CANDIDATE_7_DEVELOPMENT_END)).toBe(true)
    const terminal = plan.success.targets.at(-1)
    expect(sessions.at(terminal?.signalIndex ?? -1)?.date).toBe(CANDIDATE_7_TERMINAL_SIGNAL)
    expect(sessions.at(terminal?.executionIndex ?? -1)?.date).toBe(CANDIDATE_7_DEVELOPMENT_END)
    expect(Object.values(terminal?.weights ?? {})).toEqual([0, 0, 0, 0, 0])

    const simulated = simulate(
      sessions,
      plan.success.targets,
      plan.success.startIndex,
      candidate7SimulationProtocol,
      MICROS,
      '0'.repeat(64),
      false,
    )
    expect(Result.isSuccess(simulated)).toBe(true)
    if (Result.isFailure(simulated)) return
    expect(simulated.success.metrics.observations).toBe(sessions.length - plan.success.startIndex)
    expect(simulated.success.metrics.annualTurnover).toBeGreaterThan(0)
  })
})
