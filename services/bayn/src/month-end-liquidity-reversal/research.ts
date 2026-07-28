import { Result } from 'effect'

import { canonicalHashV1Result } from '../hash'
import type { DailyBar, IsoDate } from '../types'
import {
  CANDIDATE_6_STRATEGY_NAME,
  CANDIDATE_6_STRATEGY_VERSION,
  CANDIDATE_6_SYMBOL,
  candidate6Protocol,
  type Candidate6DevelopmentDataset,
  type Candidate6Protocol,
} from './model'
import {
  CANDIDATE_6_SESSIONS_PER_YEAR,
  candidate6Mean,
  candidate6Metrics,
  candidate6Quantile,
  candidate6SampleStandardDeviation,
  candidate6SubsetMetrics,
  simulateCandidate6,
  simulateCandidate6BuyAndHold,
  type Candidate6DailyObservation,
  type Candidate6PerformanceMetrics,
  type Candidate6SimulationFailure,
} from './simulation'

export const CANDIDATE_6_DEVELOPMENT_DATA_START = '2016-01-04' as IsoDate
export const CANDIDATE_6_DEVELOPMENT_SIMULATION_START = '2017-01-03' as IsoDate
export const CANDIDATE_6_DEVELOPMENT_END = '2022-12-30' as IsoDate
export const CANDIDATE_6_HOLDOUT_START = '2023-01-03' as IsoDate

const BOOTSTRAP_REPLICATES = 2_000
const BOOTSTRAP_BLOCK_LENGTH = 20

export type Candidate6ResearchFailure =
  | Candidate6SimulationFailure
  | { readonly _tag: 'InvalidDevelopmentBoundary'; readonly field: string; readonly observed: string | number }
  | { readonly _tag: 'MissingDevelopmentSymbol'; readonly symbol: string }
  | { readonly _tag: 'DuplicateDevelopmentBar'; readonly symbol: string; readonly sessionDate: IsoDate }

export interface Candidate6ConfidenceInterval {
  readonly confidenceLevel: 0.95
  readonly method: 'deterministic-moving-block-bootstrap'
  readonly replicates: number
  readonly blockLengthSessions: number
  readonly annualizedReturn: readonly [number, number]
  readonly sharpe: readonly [number, number]
}

export interface Candidate6DevelopmentReport {
  readonly schemaVersion: 'bayn.candidate-6-development-report.v1'
  readonly candidateOrdinal: 6
  readonly strategyName: typeof CANDIDATE_6_STRATEGY_NAME
  readonly status: 'DEVELOPMENT_ONLY_HOLDOUT_UNTOUCHED'
  readonly identity: {
    readonly strategyVersion: typeof CANDIDATE_6_STRATEGY_VERSION
    readonly parameterHash: string
  }
  readonly dataset: {
    readonly snapshotId: string
    readonly rawExportSha256: string
    readonly requestedDataStart: IsoDate
    readonly observedFirstSession: IsoDate
    readonly simulationStart: IsoDate
    readonly developmentEnd: IsoDate
    readonly untouchedHoldoutStart: IsoDate
    readonly totalBarCount: number
    readonly strategyBarCount: number
  }
  readonly assumptions: {
    readonly initialCapitalUsd: 1_000_000
    readonly signalPrice: string
    readonly fillPrice: string
    readonly latencySessions: number
    readonly halfSpreadBps: number
    readonly slippageBps: number
    readonly regulatoryFeesIncluded: true
    readonly deterministicPartialFillsIncluded: true
  }
  readonly gross: Candidate6PerformanceMetrics
  readonly net: Candidate6PerformanceMetrics
  readonly buyAndHoldSpy: Candidate6PerformanceMetrics
  readonly confidenceInterval: Candidate6ConfidenceInterval
  readonly walkForward: readonly {
    readonly start: IsoDate
    readonly end: IsoDate
    readonly metrics: Candidate6PerformanceMetrics
  }[]
  readonly regimes: {
    readonly calendarYears: Readonly<Record<string, number>>
    readonly lowVolatility: Candidate6PerformanceMetrics
    readonly highVolatility: Candidate6PerformanceMetrics
    readonly medianSpyAnnualizedVolatility: number
    readonly settlementCycle: {
      readonly developmentRegime: 'pre-t-plus-one'
      readonly tPlusOneComplianceDate: '2024-05-28'
      readonly postTransitionDevelopmentObservations: 0
    }
  }
  readonly costSensitivity: readonly {
    readonly costMultiplier: number
    readonly metrics: Candidate6PerformanceMetrics
  }[]
  readonly caveats: readonly string[]
  readonly reportHash: string
}

type ResearchResult<A> = Result.Result<A, Candidate6ResearchFailure>

const fail = <A>(failure: Candidate6ResearchFailure): ResearchResult<A> => Result.fail(failure)

const prepareDataset = (
  dataset: Candidate6DevelopmentDataset,
): ResearchResult<{ readonly calendar: readonly IsoDate[]; readonly bars: readonly DailyBar[] }> => {
  if (dataset.firstSession !== CANDIDATE_6_DEVELOPMENT_DATA_START) {
    return fail({ _tag: 'InvalidDevelopmentBoundary', field: 'firstSession', observed: dataset.firstSession })
  }
  if (dataset.lastSession !== CANDIDATE_6_DEVELOPMENT_END) {
    return fail({ _tag: 'InvalidDevelopmentBoundary', field: 'lastSession', observed: dataset.lastSession })
  }
  if (dataset.barCount !== dataset.bars.length) {
    return fail({ _tag: 'InvalidDevelopmentBoundary', field: 'barCount', observed: dataset.barCount })
  }
  const seen = new Set<string>()
  const spyBars: DailyBar[] = []
  for (const bar of dataset.bars) {
    if (bar.sessionDate > CANDIDATE_6_DEVELOPMENT_END) {
      return fail({ _tag: 'InvalidDevelopmentBoundary', field: 'futureBar', observed: bar.sessionDate })
    }
    const key = `${bar.symbol}\u001f${bar.sessionDate}`
    if (seen.has(key))
      return fail({ _tag: 'DuplicateDevelopmentBar', symbol: bar.symbol, sessionDate: bar.sessionDate })
    seen.add(key)
    if (bar.symbol === CANDIDATE_6_SYMBOL) spyBars.push(bar)
  }
  if (spyBars.length === 0) return fail({ _tag: 'MissingDevelopmentSymbol', symbol: CANDIDATE_6_SYMBOL })
  spyBars.sort((left, right) => left.sessionDate.localeCompare(right.sessionDate))
  const calendar = spyBars.map((bar) => bar.sessionDate)
  if (calendar[0] !== CANDIDATE_6_DEVELOPMENT_DATA_START || calendar.at(-1) !== CANDIDATE_6_DEVELOPMENT_END) {
    return fail({ _tag: 'InvalidDevelopmentBoundary', field: 'strategyCalendar', observed: calendar.length })
  }
  return Result.succeed({ calendar, bars: spyBars })
}

const xorshift32 = (seed: number): (() => number) => {
  let state = seed >>> 0
  return () => {
    state ^= state << 13
    state ^= state >>> 17
    state ^= state << 5
    return (state >>> 0) / 0x1_0000_0000
  }
}

const bootstrapConfidenceInterval = (
  observations: readonly Candidate6DailyObservation[],
): Candidate6ConfidenceInterval => {
  const returns = observations
    .map((observation) => observation.dailyReturn)
    .filter((value): value is number => value !== null)
  const random = xorshift32(0xc6_2026_07)
  const annualizedReturns: number[] = []
  const sharpes: number[] = []
  for (let replicate = 0; replicate < BOOTSTRAP_REPLICATES; replicate += 1) {
    const sample: number[] = []
    while (sample.length < returns.length) {
      const start = Math.floor(random() * returns.length)
      for (let offset = 0; offset < BOOTSTRAP_BLOCK_LENGTH && sample.length < returns.length; offset += 1) {
        sample.push(returns[(start + offset) % returns.length] ?? 0)
      }
    }
    const growth = sample.reduce((value, dailyReturn) => value * (1 + dailyReturn), 1)
    annualizedReturns.push(growth > 0 ? growth ** (CANDIDATE_6_SESSIONS_PER_YEAR / sample.length) - 1 : -1)
    const volatility = candidate6SampleStandardDeviation(sample) * Math.sqrt(CANDIDATE_6_SESSIONS_PER_YEAR)
    sharpes.push(volatility > 0 ? (candidate6Mean(sample) * CANDIDATE_6_SESSIONS_PER_YEAR) / volatility : 0)
  }
  return {
    confidenceLevel: 0.95,
    method: 'deterministic-moving-block-bootstrap',
    replicates: BOOTSTRAP_REPLICATES,
    blockLengthSessions: BOOTSTRAP_BLOCK_LENGTH,
    annualizedReturn: [candidate6Quantile(annualizedReturns, 0.025), candidate6Quantile(annualizedReturns, 0.975)],
    sharpe: [candidate6Quantile(sharpes, 0.025), candidate6Quantile(sharpes, 0.975)],
  }
}

const calendarYearReturns = (observations: readonly Candidate6DailyObservation[]): Readonly<Record<string, number>> => {
  const years = [...new Set(observations.map((observation) => observation.sessionDate.slice(0, 4)))]
  return Object.fromEntries(
    years.map((year) => [
      year,
      candidate6SubsetMetrics(observations, (observation) => observation.sessionDate.startsWith(year)).totalReturn,
    ]),
  )
}

export const buildCandidate6DevelopmentReport = (
  dataset: Candidate6DevelopmentDataset,
  protocol: Candidate6Protocol = candidate6Protocol,
): ResearchResult<Candidate6DevelopmentReport> => {
  const prepared = prepareDataset(dataset)
  if (Result.isFailure(prepared)) return fail(prepared.failure)
  const parameterHash = canonicalHashV1Result(protocol)
  if (Result.isFailure(parameterHash)) {
    return fail({ _tag: 'ResearchHashFailure', operation: 'protocol', cause: parameterHash.failure })
  }
  const { bars, calendar } = prepared.success
  const gross = simulateCandidate6(calendar, bars, CANDIDATE_6_DEVELOPMENT_SIMULATION_START, protocol, 0, false)
  if (Result.isFailure(gross)) return fail(gross.failure)
  const net = simulateCandidate6(calendar, bars, CANDIDATE_6_DEVELOPMENT_SIMULATION_START, protocol, 1, true)
  if (Result.isFailure(net)) return fail(net.failure)
  const buyAndHold = simulateCandidate6BuyAndHold(calendar, bars, CANDIDATE_6_DEVELOPMENT_SIMULATION_START)
  if (Result.isFailure(buyAndHold)) return fail(buyAndHold.failure)
  const volatilityValues = net.success.observations
    .map((observation) => observation.spyAnnualizedVolatility)
    .filter((value): value is number => value !== null)
  const medianVolatility = candidate6Quantile(volatilityValues, 0.5)
  const folds = [
    ['2017-01-03', '2018-12-31'],
    ['2019-01-02', '2020-12-31'],
    ['2021-01-04', '2022-12-30'],
  ] as const satisfies readonly (readonly [IsoDate, IsoDate])[]
  const costSensitivity: Array<{ readonly costMultiplier: number; readonly metrics: Candidate6PerformanceMetrics }> = []
  for (const costMultiplier of [0.5, 1, 2, 3] as const) {
    const outcome = simulateCandidate6(
      calendar,
      bars,
      CANDIDATE_6_DEVELOPMENT_SIMULATION_START,
      protocol,
      costMultiplier,
      true,
    )
    if (Result.isFailure(outcome)) return fail(outcome.failure)
    costSensitivity.push({ costMultiplier, metrics: outcome.success.metrics })
  }
  const reportWithoutHash = {
    schemaVersion: 'bayn.candidate-6-development-report.v1',
    candidateOrdinal: 6,
    strategyName: CANDIDATE_6_STRATEGY_NAME,
    status: 'DEVELOPMENT_ONLY_HOLDOUT_UNTOUCHED',
    identity: {
      strategyVersion: CANDIDATE_6_STRATEGY_VERSION,
      parameterHash: parameterHash.success,
    },
    dataset: {
      snapshotId: dataset.snapshotId,
      rawExportSha256: dataset.rawExportSha256,
      requestedDataStart: CANDIDATE_6_DEVELOPMENT_DATA_START,
      observedFirstSession: dataset.firstSession,
      simulationStart: CANDIDATE_6_DEVELOPMENT_SIMULATION_START,
      developmentEnd: CANDIDATE_6_DEVELOPMENT_END,
      untouchedHoldoutStart: CANDIDATE_6_HOLDOUT_START,
      totalBarCount: dataset.barCount,
      strategyBarCount: bars.length,
    },
    assumptions: {
      initialCapitalUsd: 1_000_000,
      signalPrice: protocol.execution.signalPrice,
      fillPrice: protocol.execution.fillPrice,
      latencySessions: protocol.execution.latencySessions,
      halfSpreadBps: protocol.execution.halfSpreadBps,
      slippageBps: protocol.execution.slippageBps,
      regulatoryFeesIncluded: true,
      deterministicPartialFillsIncluded: true,
    },
    gross: gross.success.metrics,
    net: net.success.metrics,
    buyAndHoldSpy: buyAndHold.success.metrics,
    confidenceInterval: bootstrapConfidenceInterval(net.success.observations),
    walkForward: folds.map(([start, end]) => ({
      start,
      end,
      metrics: candidate6SubsetMetrics(
        net.success.observations,
        (observation) => observation.sessionDate >= start && observation.sessionDate <= end,
      ),
    })),
    regimes: {
      calendarYears: calendarYearReturns(net.success.observations),
      lowVolatility: candidate6SubsetMetrics(
        net.success.observations,
        (observation) =>
          observation.spyAnnualizedVolatility !== null && observation.spyAnnualizedVolatility <= medianVolatility,
      ),
      highVolatility: candidate6SubsetMetrics(
        net.success.observations,
        (observation) =>
          observation.spyAnnualizedVolatility !== null && observation.spyAnnualizedVolatility > medianVolatility,
      ),
      medianSpyAnnualizedVolatility: medianVolatility,
      settlementCycle: {
        developmentRegime: 'pre-t-plus-one',
        tPlusOneComplianceDate: '2024-05-28',
        postTransitionDevelopmentObservations: 0,
      },
    },
    costSensitivity,
    caveats: [
      'Development results are in-sample design evidence, not an official qualification result or profitability claim.',
      'The immutable source snapshot was finalized after the development period; the export query selected no session after 2022-12-30.',
      'The untouched holdout begins on 2023-01-03 and was not queried, simulated, or inspected for this report.',
      'Confidence intervals are wide because exposure occurs only around qualifying month ends and the development period contains six years.',
      'Daily adjusted bars cannot represent intraday spread variation or queue position; costs are explicit conservative model assumptions.',
      'All development observations predate the May 28, 2024 U.S. T+1 transition; the sealed official trial excludes the transition month and requires positive pre- and post-transition regime results.',
    ],
  } as const
  const reportHash = canonicalHashV1Result(reportWithoutHash)
  if (Result.isFailure(reportHash)) {
    return fail({ _tag: 'ResearchHashFailure', operation: 'development-report', cause: reportHash.failure })
  }
  return Result.succeed({ ...reportWithoutHash, reportHash: reportHash.success })
}

export { candidate6Metrics }
export type { Candidate6PerformanceMetrics }
