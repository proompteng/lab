import { pipe, Result } from 'effect'

import { MICROS, microsToNumber } from '../execution-model'
import { DIRECT_VOLATILITY_WINDOW } from '../protocol'
import type { EconomicVerdict, GateResult, PerformanceMetrics, SimulationProtocol } from '../types'
import { requiredRecordValue, requiredSession } from './inputs'
import type { AlignedSession, SimulationFailure } from './model'
import { Pipeable } from '../pipeable'

const fail = <A = never>(failure: SimulationFailure): Result.Result<A, SimulationFailure> => Result.fail(failure)

export const TRADING_DAYS = 252

const numberToMicros = (value: number): Result.Result<string, SimulationFailure> =>
  !Number.isFinite(value)
    ? fail({
        _tag: 'InvalidMonetaryValue',
        operation: 'number-to-micros',
        value,
        reason: 'not-finite',
      })
    : value < 0
      ? fail({
          _tag: 'InvalidMonetaryValue',
          operation: 'number-to-micros',
          value,
          reason: 'negative',
        })
      : Result.succeed(Math.round(value * Number(MICROS)).toString())

export const roundWeight = (value: number): Result.Result<number, SimulationFailure> =>
  !Number.isFinite(value)
    ? fail({ _tag: 'InvalidWeight', operation: 'quantize', value, reason: 'not-finite' })
    : value < 0
      ? fail({ _tag: 'InvalidWeight', operation: 'quantize', value, reason: 'negative' })
      : Result.succeed(Number.parseFloat(value.toFixed(12)))

export const mean = (values: readonly number[]): Result.Result<number, SimulationFailure> => {
  if (values.length === 0) {
    return fail({ _tag: 'InvalidStatisticInput', statistic: 'mean', reason: 'empty', values })
  }
  if (values.some((value) => !Number.isFinite(value))) {
    return fail({ _tag: 'InvalidStatisticInput', statistic: 'mean', reason: 'not-finite', values })
  }
  return Result.succeed(values.reduce((sum, value) => sum + value, 0) / values.length)
}

export const sampleStandardDeviation = (values: readonly number[]): Result.Result<number, SimulationFailure> => {
  if (values.some((value) => !Number.isFinite(value))) {
    return fail({
      _tag: 'InvalidStatisticInput',
      statistic: 'sample-standard-deviation',
      reason: 'not-finite',
      values,
    })
  }
  if (values.length < 2) return Result.succeed(0)
  return pipe(
    mean(values),
    Result.map((average) =>
      Math.sqrt(values.reduce((sum, value) => sum + (value - average) ** 2, 0) / (values.length - 1)),
    ),
  )
}

const directVolatilityReturn = (
  sessions: readonly AlignedSession[],
  index: number,
  protocol: SimulationProtocol,
): Result.Result<number, SimulationFailure> =>
  pipe(
    Result.all({
      previous: requiredSession(sessions, index - 1, 'direct-volatility'),
      current: requiredSession(sessions, index, 'direct-volatility'),
    }),
    Result.flatMap(({ previous, current }) =>
      pipe(
        Result.all(
          protocol.universe.map((symbol) =>
            pipe(
              Result.all({
                previousBar: requiredRecordValue(previous.bars, symbol, 'bar', previous.date),
                currentBar: requiredRecordValue(current.bars, symbol, 'bar', current.date),
              }),
              Result.flatMap(({ previousBar, currentBar }) => {
                const value = currentBar.close / previousBar.close - 1
                return Number.isFinite(value)
                  ? Result.succeed(value)
                  : fail({
                      _tag: 'InvalidStatisticInput',
                      statistic: 'mean',
                      reason: 'not-finite',
                      values: [previousBar.close, currentBar.close],
                    })
              }),
            ),
          ),
        ),
        Result.flatMap(mean),
      ),
    ),
  )

const directVolatilityWeightsDataFirst = (
  sessions: readonly AlignedSession[],
  signalIndex: number,
  protocol: SimulationProtocol,
): Result.Result<Readonly<Record<string, number>>, SimulationFailure> => {
  const firstIndex = signalIndex - DIRECT_VOLATILITY_WINDOW + 1
  return pipe(
    Result.all(
      Array.from({ length: DIRECT_VOLATILITY_WINDOW }, (_, offset) =>
        directVolatilityReturn(sessions, firstIndex + offset, protocol),
      ),
    ),
    Result.flatMap(sampleStandardDeviation),
    Result.flatMap((dailyVolatility) => {
      const annualizedVolatility = dailyVolatility * Math.sqrt(TRADING_DAYS)
      const exposure =
        annualizedVolatility <= 0 ? 0 : Math.min(1, protocol.directVolatilityTarget / annualizedVolatility)
      return pipe(
        roundWeight(exposure / protocol.universe.length),
        Result.map((weight) => Object.fromEntries(protocol.universe.map((symbol) => [symbol, weight]))),
      )
    }),
  )
}

export const directVolatilityWeights = Pipeable.dual(3, directVolatilityWeightsDataFirst)

const calculatePerformanceMetricsDataFirst = (
  equity: readonly number[],
  turnover: number,
  totalFees: number,
  initialCapital: number,
): Result.Result<PerformanceMetrics, SimulationFailure> => {
  if (!Number.isFinite(initialCapital) || initialCapital <= 0) {
    return fail({
      _tag: 'InvalidPerformanceInput',
      reason: 'invalid-initial-capital',
      index: null,
      value: initialCapital,
    })
  }
  const invalidEquityIndex = equity.findIndex((value) => !Number.isFinite(value) || value <= 0)
  if (equity.length < 2 || invalidEquityIndex >= 0) {
    return fail({
      _tag: 'InvalidPerformanceInput',
      reason: equity.length === 0 ? 'empty-equity' : 'invalid-equity',
      index: invalidEquityIndex >= 0 ? invalidEquityIndex : null,
      value: invalidEquityIndex >= 0 ? (equity.at(invalidEquityIndex) ?? null) : null,
    })
  }
  if (!Number.isFinite(turnover) || turnover < 0 || !Number.isFinite(totalFees) || totalFees < 0) {
    return fail({
      _tag: 'InvalidPerformanceInput',
      reason: 'invalid-total',
      index: null,
      value: !Number.isFinite(turnover) || turnover < 0 ? turnover : totalFees,
    })
  }
  const endingEquity = equity.at(-1)
  if (endingEquity === undefined) {
    return fail({
      _tag: 'InvalidPerformanceInput',
      reason: 'empty-equity',
      index: null,
      value: null,
    })
  }
  const initialEquity = equity.at(0)
  if (initialEquity === undefined) {
    return fail({
      _tag: 'InvalidPerformanceInput',
      reason: 'empty-equity',
      index: null,
      value: null,
    })
  }
  const subsequentReturns = Result.all(
    equity.slice(1).map((value, index) => {
      const previous = equity.at(index)
      return previous === undefined
        ? fail({
            _tag: 'InvalidPerformanceInput',
            reason: 'invalid-equity',
            index,
            value: null,
          })
        : Result.succeed(value / previous - 1)
    }),
  )
  if (Result.isFailure(subsequentReturns)) return fail(subsequentReturns.failure)
  const returns = [initialEquity / initialCapital - 1, ...subsequentReturns.success]
  return pipe(
    Result.all({
      averageReturn: mean(returns),
      volatility: pipe(
        sampleStandardDeviation(returns),
        Result.map((value) => value * Math.sqrt(TRADING_DAYS)),
      ),
      totalFeesMicros: numberToMicros(totalFees),
      endingEquityMicros: numberToMicros(endingEquity),
    }),
    Result.flatMap(({ averageReturn, volatility, totalFeesMicros, endingEquityMicros }) => {
      const totalReturn = endingEquity / initialCapital - 1
      const annualizedReturn = Math.pow(endingEquity / initialCapital, TRADING_DAYS / equity.length) - 1
      const sharpe = volatility === 0 ? 0 : (averageReturn * TRADING_DAYS) / volatility
      const drawdown = equity.reduce(
        (state, value) => {
          const peak = Math.max(state.peak, value)
          return { peak, maximum: Math.max(state.maximum, 1 - value / peak) }
        },
        { peak: initialCapital, maximum: 0 },
      )
      const years = equity.length / TRADING_DAYS
      const annualTurnover = turnover / initialCapital / years
      const values = [totalReturn, annualizedReturn, volatility, sharpe, drawdown.maximum, annualTurnover]
      return values.every(Number.isFinite)
        ? Result.succeed({
            observations: equity.length,
            totalReturn,
            annualizedReturn,
            annualizedVolatility: volatility,
            sharpe,
            maximumDrawdown: drawdown.maximum,
            annualTurnover,
            totalFeesMicros,
            totalSpreadCostMicros: '0',
            totalSlippageCostMicros: '0',
            totalCashYieldMicros: '0',
            endingEquityMicros,
          })
        : fail({
            _tag: 'InvalidPerformanceInput',
            reason: 'invalid-total',
            index: values.findIndex((value) => !Number.isFinite(value)),
            value: values.find((value) => !Number.isFinite(value)) ?? null,
          })
    }),
  )
}

export const calculatePerformanceMetrics = Pipeable.dual(4, calculatePerformanceMetricsDataFirst)

const calculateExactPerformanceMetricsDataFirst = (
  equityMicros: readonly bigint[],
  turnoverMicros: bigint,
  totalFeesMicros: bigint,
  totalSpreadCostMicros: bigint,
  totalSlippageCostMicros: bigint,
  totalCashYieldMicros: bigint,
  initialCapitalMicros: bigint,
): Result.Result<PerformanceMetrics, SimulationFailure> => {
  const endingEquity = equityMicros.at(-1)
  if (endingEquity === undefined) {
    return fail({
      _tag: 'InvalidPerformanceInput',
      reason: 'empty-equity',
      index: null,
      value: null,
    })
  }
  return pipe(
    calculatePerformanceMetrics(
      equityMicros.map(microsToNumber),
      microsToNumber(turnoverMicros),
      microsToNumber(totalFeesMicros),
      microsToNumber(initialCapitalMicros),
    ),
    Result.map((metrics) => ({
      ...metrics,
      totalFeesMicros: totalFeesMicros.toString(),
      totalSpreadCostMicros: totalSpreadCostMicros.toString(),
      totalSlippageCostMicros: totalSlippageCostMicros.toString(),
      totalCashYieldMicros: totalCashYieldMicros.toString(),
      endingEquityMicros: endingEquity.toString(),
    })),
  )
}

export const calculateExactPerformanceMetrics = Pipeable.dual(7, calculateExactPerformanceMetricsDataFirst)

const buildVerdictDataFirst = (
  strategy: PerformanceMetrics,
  buyAndHold: PerformanceMetrics,
  directVolTiming: PerformanceMetrics,
  doubleCost: PerformanceMetrics,
  protocol: SimulationProtocol,
): EconomicVerdict => {
  const threshold = protocol.thresholds
  const benchmarkSharpe = Math.max(buyAndHold.sharpe, directVolTiming.sharpe)
  const finite = [
    strategy.annualizedReturn,
    strategy.sharpe,
    strategy.maximumDrawdown,
    strategy.annualTurnover,
    doubleCost.annualizedReturn,
  ].every(Number.isFinite)
  const gates: GateResult[] = [
    { name: 'finite_metrics', passed: finite, actual: finite, required: true },
    {
      name: 'minimum_observations',
      passed: strategy.observations >= threshold.minimumObservations,
      actual: strategy.observations,
      required: threshold.minimumObservations,
    },
    {
      name: 'positive_net_return',
      passed: strategy.annualizedReturn > threshold.minimumAnnualizedReturn,
      actual: strategy.annualizedReturn,
      required: `>${threshold.minimumAnnualizedReturn}`,
    },
    {
      name: 'benchmark_sharpe_improvement',
      passed: strategy.sharpe - benchmarkSharpe > threshold.minimumSharpeImprovement,
      actual: strategy.sharpe - benchmarkSharpe,
      required: `>${threshold.minimumSharpeImprovement}`,
    },
    {
      name: 'maximum_drawdown',
      passed: strategy.maximumDrawdown <= threshold.maximumDrawdown,
      actual: strategy.maximumDrawdown,
      required: `<=${threshold.maximumDrawdown}`,
    },
    {
      name: 'maximum_turnover',
      passed: strategy.annualTurnover <= threshold.maximumAnnualTurnover,
      actual: strategy.annualTurnover,
      required: `<=${threshold.maximumAnnualTurnover}`,
    },
    {
      name: 'double_cost_return',
      passed: !threshold.requirePositiveDoubleCostReturn || doubleCost.annualizedReturn > 0,
      actual: doubleCost.annualizedReturn,
      required: threshold.requirePositiveDoubleCostReturn ? '>0' : 'not-required',
    },
  ]
  return { status: gates.every((gate) => gate.passed) ? 'PASS' : 'FAIL_CLOSED', gates }
}

export const buildVerdict = Pipeable.dual(5, buildVerdictDataFirst)
