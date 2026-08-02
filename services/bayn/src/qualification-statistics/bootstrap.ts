import { Chunk, pipe, Result } from 'effect'

import { statisticsFailure, type QualificationStatisticsFailure } from './failure'
import { hashQualificationEvidence } from './hashing'
import type {
  BootstrapAnalysis,
  QualificationObservation,
  QualificationSeries,
  QualificationStatisticsPolicy,
} from './model'
import { annualizedSharpe, mean, nearestRankLowerQuantile, roundStatistic } from './numerical-methods'
import { qualificationTailCapacityForOrdinal } from './policy'
import type { CompleteBlockWork } from './series'

export const qualificationSelectedBenchmarkRule = {
  schemaVersion: 'bayn.qualification-selected-benchmark-rule.v1',
  eligibleBenchmarks: ['buy-and-hold', 'direct-volatility-timing'],
  score: 'cash-adjusted-annualized-sharpe',
  selection: 'maximum',
  tieBreak: 'buy-and-hold',
} as const

export type QualificationSelectedBenchmark = (typeof qualificationSelectedBenchmarkRule.eligibleBenchmarks)[number]

export interface QualificationBenchmarkCashAdjustedSharpes {
  readonly buyAndHold: number
  readonly directVolatilityTiming: number
}

interface QualificationSelectedBenchmarkDecision {
  readonly name: QualificationSelectedBenchmark
  readonly sharpe: number
}

export const selectQualificationBenchmarkFromCashAdjustedSharpes = (
  sharpes: QualificationBenchmarkCashAdjustedSharpes,
): QualificationSelectedBenchmarkDecision =>
  sharpes.directVolatilityTiming > sharpes.buyAndHold
    ? { name: 'direct-volatility-timing', sharpe: sharpes.directVolatilityTiming }
    : { name: qualificationSelectedBenchmarkRule.tieBreak, sharpe: sharpes.buyAndHold }

export const selectQualificationBenchmark = (
  observations: readonly QualificationObservation[],
  annualizationSessions: number,
): QualificationSelectedBenchmarkDecision => {
  const buyAndHold = annualizedSharpe(
    observations.map((observation) => observation.buyAndHoldReturn - observation.cashReturn),
    annualizationSessions,
  )
  const directVolatility = annualizedSharpe(
    observations.map((observation) => observation.directVolatilityReturn - observation.cashReturn),
    annualizationSessions,
  )
  return selectQualificationBenchmarkFromCashAdjustedSharpes({
    buyAndHold,
    directVolatilityTiming: directVolatility,
  })
}

export interface QualificationSelectedBenchmarkBootstrapComparison {
  readonly schemaVersion: 'bayn.selected-benchmark-bootstrap-comparison.v1'
  readonly selectedBenchmark: QualificationSelectedBenchmark
  readonly selectedBenchmarkSharpe: number
  readonly seedHash: string
  readonly requestedSamples: number
  readonly producedSamples: number
  readonly adjustedOneSidedAlpha: number
  readonly tailSampleCount: number
  readonly minimumTailSamples: number
  readonly tailResolutionSufficient: boolean
  readonly annualizedReturnDifferenceLowerBound: number
  readonly sharpeDifferenceLowerBound: number
  readonly annualizedReturnDifferenceSamples: readonly number[]
  readonly sharpeDifferenceSamples: readonly number[]
  readonly samplesHash: string
}

interface RandomState {
  readonly value: number
}

const initialRandomState = (seedHash: string): RandomState => ({
  value: Number.parseInt(seedHash.slice(0, 8), 16) || 0x9e3779b9,
})

const drawRandom = (state: RandomState): RandomState => {
  const shiftedLeft = state.value ^ (state.value << 13)
  const shiftedRight = shiftedLeft ^ (shiftedLeft >>> 17)
  return { value: (shiftedRight ^ (shiftedRight << 5)) >>> 0 }
}

const drawRandomIndex = (
  state: RandomState,
  maximum: number,
): Result.Result<{ readonly index: number; readonly state: RandomState }, QualificationStatisticsFailure> => {
  if (!Number.isInteger(maximum) || maximum <= 0) {
    return statisticsFailure({ _tag: 'QualificationRandomIndexInvalid', maximum })
  }
  const limit = Math.floor(0x1_0000_0000 / maximum) * maximum
  const select = (current: RandomState): { readonly index: number; readonly state: RandomState } => {
    const next = drawRandom(current)
    return next.value >= limit ? select(next) : { index: next.value % maximum, state: next }
  }
  return Result.succeed(select(state))
}

interface BootstrapAccumulator {
  readonly random: RandomState
  readonly annualizedExcessReturnSamples: Chunk.Chunk<number>
  readonly sharpeDifferenceSamples: Chunk.Chunk<number>
}

const sampleBlocks = (
  random: RandomState,
  blocks: readonly CompleteBlockWork[],
): Result.Result<
  {
    readonly random: RandomState
    readonly observations: readonly QualificationObservation[]
  },
  QualificationStatisticsFailure
> =>
  Array.from({ length: blocks.length })
    .reduce<
      Result.Result<
        {
          readonly random: RandomState
          readonly selected: Chunk.Chunk<CompleteBlockWork>
        },
        QualificationStatisticsFailure
      >
    >(
      (accumulated) =>
        pipe(
          accumulated,
          Result.flatMap((state) =>
            pipe(
              drawRandomIndex(state.random, blocks.length),
              Result.flatMap(({ index, state: nextRandom }) => {
                const block = blocks.at(index)
                return block === undefined
                  ? statisticsFailure({
                      _tag: 'QualificationSamplingBlockMissing',
                      index,
                      blockCount: blocks.length,
                    })
                  : Result.succeed({
                      random: nextRandom,
                      selected: Chunk.append(state.selected, block),
                    })
              }),
            ),
          ),
        ),
      Result.succeed({ random, selected: Chunk.empty() }),
    )
    .pipe(
      Result.map(({ random: nextRandom, selected }) => ({
        random: nextRandom,
        observations: Chunk.toReadonlyArray(selected).flatMap((block) => block.observations),
      })),
    )

export const runQualificationBootstrap = (
  series: QualificationSeries,
  blocks: readonly CompleteBlockWork[],
  policy: QualificationStatisticsPolicy,
  priorTrialCount: number,
): Result.Result<BootstrapAnalysis, QualificationStatisticsFailure> => {
  const candidateOrdinal = priorTrialCount + 1
  const benchmark = selectQualificationBenchmark(series.observations, policy.annualizationSessions)
  const { adjustedOneSidedAlpha, tailSampleCount } = qualificationTailCapacityForOrdinal(policy, candidateOrdinal)
  return pipe(
    hashQualificationEvidence('bootstrap-seed', {
      schemaVersion: 'bayn.qualification-bootstrap-seed.v1',
      namespace: policy.bootstrap.seedNamespace,
      runId: series.runId,
    }),
    Result.flatMap((seedHash) => {
      const sampled =
        blocks.length === 0
          ? Result.succeed<BootstrapAccumulator>({
              random: initialRandomState(seedHash),
              annualizedExcessReturnSamples: Chunk.empty(),
              sharpeDifferenceSamples: Chunk.empty(),
            })
          : Array.from({ length: policy.bootstrap.samples }).reduce<
              Result.Result<BootstrapAccumulator, QualificationStatisticsFailure>
            >(
              (accumulated) =>
                pipe(
                  accumulated,
                  Result.flatMap((state) =>
                    pipe(
                      sampleBlocks(state.random, blocks),
                      Result.flatMap(({ random, observations }) => {
                        const candidateReturns = observations.map(
                          (observation) => observation.strategyReturn - observation.cashReturn,
                        )
                        const benchmarkReturns = observations.map(
                          (observation) =>
                            (benchmark.name === 'buy-and-hold'
                              ? observation.buyAndHoldReturn
                              : observation.directVolatilityReturn) - observation.cashReturn,
                        )
                        return pipe(
                          Result.all({
                            annualizedExcessReturn: roundStatistic(
                              mean(candidateReturns) * policy.annualizationSessions,
                            ),
                            sharpeDifference: roundStatistic(
                              annualizedSharpe(candidateReturns, policy.annualizationSessions) -
                                annualizedSharpe(benchmarkReturns, policy.annualizationSessions),
                            ),
                          }),
                          Result.map(({ annualizedExcessReturn, sharpeDifference }) => ({
                            random,
                            annualizedExcessReturnSamples: Chunk.append(
                              state.annualizedExcessReturnSamples,
                              annualizedExcessReturn,
                            ),
                            sharpeDifferenceSamples: Chunk.append(state.sharpeDifferenceSamples, sharpeDifference),
                          })),
                        )
                      }),
                    ),
                  ),
                ),
              Result.succeed({
                random: initialRandomState(seedHash),
                annualizedExcessReturnSamples: Chunk.empty(),
                sharpeDifferenceSamples: Chunk.empty(),
              }),
            )
      return pipe(
        sampled,
        Result.flatMap((samples) => {
          const annualizedExcessReturnSamples = Chunk.toReadonlyArray(samples.annualizedExcessReturnSamples)
          const sharpeDifferenceSamples = Chunk.toReadonlyArray(samples.sharpeDifferenceSamples)
          return pipe(
            Result.all({
              selectedBenchmarkSharpe: roundStatistic(benchmark.sharpe),
              annualizedExcessReturnLowerBound: roundStatistic(
                nearestRankLowerQuantile(annualizedExcessReturnSamples, adjustedOneSidedAlpha),
              ),
              sharpeDifferenceLowerBound: roundStatistic(
                nearestRankLowerQuantile(sharpeDifferenceSamples, adjustedOneSidedAlpha),
              ),
              samplesHash: hashQualificationEvidence('bootstrap-samples', {
                schemaVersion: 'bayn.qualification-bootstrap-samples.v1',
                annualizedExcessReturnSamples,
                sharpeDifferenceSamples,
              }),
            }),
            Result.map((values) => ({
              schemaVersion: 'bayn.paired-block-bootstrap.v1' as const,
              method: policy.bootstrap.method,
              selectedBenchmark: benchmark.name,
              selectedBenchmarkSharpe: values.selectedBenchmarkSharpe,
              seedHash,
              requestedSamples: policy.bootstrap.samples,
              producedSamples: annualizedExcessReturnSamples.length,
              adjustedOneSidedAlpha,
              tailSampleCount,
              minimumTailSamples: policy.confidence.minimumTailSamples,
              tailResolutionSufficient: tailSampleCount >= policy.confidence.minimumTailSamples,
              annualizedExcessReturnLowerBound: values.annualizedExcessReturnLowerBound,
              sharpeDifferenceLowerBound: values.sharpeDifferenceLowerBound,
              annualizedExcessReturnSamples,
              sharpeDifferenceSamples,
              samplesHash: values.samplesHash,
            })),
          )
        }),
      )
    }),
  )
}

export const runSelectedBenchmarkBootstrapComparison = (
  series: QualificationSeries,
  blocks: readonly CompleteBlockWork[],
  policy: QualificationStatisticsPolicy,
  priorTrialCount: number,
): Result.Result<QualificationSelectedBenchmarkBootstrapComparison, QualificationStatisticsFailure> => {
  const candidateOrdinal = priorTrialCount + 1
  const benchmark = selectQualificationBenchmark(series.observations, policy.annualizationSessions)
  const { adjustedOneSidedAlpha, tailSampleCount } = qualificationTailCapacityForOrdinal(policy, candidateOrdinal)
  return pipe(
    hashQualificationEvidence('bootstrap-seed', {
      schemaVersion: 'bayn.qualification-bootstrap-seed.v1',
      namespace: policy.bootstrap.seedNamespace,
      runId: series.runId,
    }),
    Result.flatMap((seedHash) => {
      const sampled =
        blocks.length === 0
          ? Result.succeed<BootstrapAccumulator>({
              random: initialRandomState(seedHash),
              annualizedExcessReturnSamples: Chunk.empty(),
              sharpeDifferenceSamples: Chunk.empty(),
            })
          : Array.from({ length: policy.bootstrap.samples }).reduce<
              Result.Result<BootstrapAccumulator, QualificationStatisticsFailure>
            >(
              (accumulated) =>
                pipe(
                  accumulated,
                  Result.flatMap((state) =>
                    pipe(
                      sampleBlocks(state.random, blocks),
                      Result.flatMap(({ random, observations }) => {
                        const candidateReturns = observations.map(
                          (observation) => observation.strategyReturn - observation.cashReturn,
                        )
                        const benchmarkReturns = observations.map(
                          (observation) =>
                            (benchmark.name === 'buy-and-hold'
                              ? observation.buyAndHoldReturn
                              : observation.directVolatilityReturn) - observation.cashReturn,
                        )
                        return pipe(
                          Result.all({
                            annualizedReturnDifference: roundStatistic(
                              (mean(candidateReturns) - mean(benchmarkReturns)) * policy.annualizationSessions,
                            ),
                            sharpeDifference: roundStatistic(
                              annualizedSharpe(candidateReturns, policy.annualizationSessions) -
                                annualizedSharpe(benchmarkReturns, policy.annualizationSessions),
                            ),
                          }),
                          Result.map(({ annualizedReturnDifference, sharpeDifference }) => ({
                            random,
                            annualizedExcessReturnSamples: Chunk.append(
                              state.annualizedExcessReturnSamples,
                              annualizedReturnDifference,
                            ),
                            sharpeDifferenceSamples: Chunk.append(state.sharpeDifferenceSamples, sharpeDifference),
                          })),
                        )
                      }),
                    ),
                  ),
                ),
              Result.succeed({
                random: initialRandomState(seedHash),
                annualizedExcessReturnSamples: Chunk.empty(),
                sharpeDifferenceSamples: Chunk.empty(),
              }),
            )
      return pipe(
        sampled,
        Result.flatMap((samples) => {
          const annualizedReturnDifferenceSamples = Chunk.toReadonlyArray(samples.annualizedExcessReturnSamples)
          const sharpeDifferenceSamples = Chunk.toReadonlyArray(samples.sharpeDifferenceSamples)
          return pipe(
            Result.all({
              selectedBenchmarkSharpe: roundStatistic(benchmark.sharpe),
              annualizedReturnDifferenceLowerBound: roundStatistic(
                nearestRankLowerQuantile(annualizedReturnDifferenceSamples, adjustedOneSidedAlpha),
              ),
              sharpeDifferenceLowerBound: roundStatistic(
                nearestRankLowerQuantile(sharpeDifferenceSamples, adjustedOneSidedAlpha),
              ),
              samplesHash: hashQualificationEvidence('selected-benchmark-bootstrap-samples', {
                schemaVersion: 'bayn.selected-benchmark-bootstrap-samples.v1',
                selectedBenchmark: benchmark.name,
                annualizedReturnDifferenceSamples,
                sharpeDifferenceSamples,
              }),
            }),
            Result.map((values) => ({
              schemaVersion: 'bayn.selected-benchmark-bootstrap-comparison.v1' as const,
              selectedBenchmark: benchmark.name,
              selectedBenchmarkSharpe: values.selectedBenchmarkSharpe,
              seedHash,
              requestedSamples: policy.bootstrap.samples,
              producedSamples: annualizedReturnDifferenceSamples.length,
              adjustedOneSidedAlpha,
              tailSampleCount,
              minimumTailSamples: policy.confidence.minimumTailSamples,
              tailResolutionSufficient: tailSampleCount >= policy.confidence.minimumTailSamples,
              annualizedReturnDifferenceLowerBound: values.annualizedReturnDifferenceLowerBound,
              sharpeDifferenceLowerBound: values.sharpeDifferenceLowerBound,
              annualizedReturnDifferenceSamples,
              sharpeDifferenceSamples,
              samplesHash: values.samplesHash,
            })),
          )
        }),
      )
    }),
  )
}
