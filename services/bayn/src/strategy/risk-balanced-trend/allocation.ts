import { Result, pipe } from 'effect'

import type { RiskBalancedTrendFailure } from '../../risk-balanced-trend/model'
import { compareKeys, fail, WEIGHT_SCALE } from './shared'
import { Pipeable } from '../../pipeable'

interface ScoredSymbol {
  readonly symbol: string
  readonly score: number
}

interface WeightAllocation {
  readonly weights: Readonly<Record<string, number>>
  readonly remainingWeight: number
  readonly remaining: readonly ScoredSymbol[]
}

const allocateWeights = (
  maximumWeight: number,
  state: WeightAllocation,
): Result.Result<Readonly<Record<string, number>>, RiskBalancedTrendFailure> => {
  if (state.remaining.length === 0 || state.remainingWeight <= 0) return Result.succeed(state.weights)
  const remainingScore = state.remaining.reduce((total, candidate) => total + candidate.score, 0)
  if (!Number.isFinite(remainingScore)) {
    return fail({
      _tag: 'InvalidRiskBalancedTrendNumber',
      operation: 'weight-allocation',
      value: remainingScore,
      symbol: null,
      reason: 'not-finite',
    })
  }
  if (remainingScore <= 0) return Result.succeed(state.weights)
  const capped = state.remaining.filter(({ score }) => (state.remainingWeight * score) / remainingScore > maximumWeight)
  if (capped.length === 0) {
    return Result.succeed({
      ...state.weights,
      ...Object.fromEntries(
        state.remaining.map(({ symbol, score }) => [symbol, (state.remainingWeight * score) / remainingScore]),
      ),
    })
  }
  const cappedSymbols = new Set(capped.map(({ symbol }) => symbol))
  return allocateWeights(maximumWeight, {
    weights: {
      ...state.weights,
      ...Object.fromEntries(capped.map(({ symbol }) => [symbol, maximumWeight])),
    },
    remainingWeight: Math.max(0, state.remainingWeight - maximumWeight * capped.length),
    remaining: state.remaining.filter(({ symbol }) => !cappedSymbols.has(symbol)),
  })
}

const redistributeWithCapDataFirst = (
  scores: Readonly<Record<string, number>>,
  maximumWeight: number,
): Result.Result<Readonly<Record<string, number>>, RiskBalancedTrendFailure> => {
  const candidates = Object.entries(scores)
    .sort(compareKeys)
    .map(([symbol, score]) => ({ symbol, score }))
  return allocateWeights(maximumWeight, {
    weights: Object.fromEntries(candidates.map(({ symbol }) => [symbol, 0])),
    remainingWeight: 1,
    remaining: candidates.filter(({ score }) => score > 0),
  })
}

export const redistributeWithCap = Pipeable.dual(2, redistributeWithCapDataFirst)

interface QuantizedUnits {
  readonly units: Readonly<Record<string, number>>
  readonly totalUnits: number
}

const quantizedUnits = (
  weights: Readonly<Record<string, number>>,
  maximumUnits: number,
): Result.Result<QuantizedUnits, RiskBalancedTrendFailure> =>
  pipe(
    Result.all(
      Object.entries(weights)
        .sort(compareKeys)
        .map(([symbol, weight]) =>
          !Number.isFinite(weight) || weight < 0
            ? fail({
                _tag: 'InvalidRiskBalancedTrendNumber',
                operation: 'weight-allocation',
                value: weight,
                symbol,
                reason: Number.isFinite(weight) ? 'negative' : 'not-finite',
              })
            : Result.succeed([symbol, Math.min(maximumUnits, Math.max(0, Math.round(weight * WEIGHT_SCALE)))] as const),
        ),
    ),
    Result.map((entries) => {
      const units = Object.fromEntries(entries)
      return {
        units,
        totalUnits: Object.values(units).reduce((total, value) => total + value, 0),
      }
    }),
  )

const removeExcessUnits = (
  input: QuantizedUnits,
): Result.Result<Readonly<Record<string, number>>, RiskBalancedTrendFailure> => {
  const initialExcess = Math.max(0, input.totalUnits - WEIGHT_SCALE)
  const bounded = Object.entries(input.units)
    .sort(compareKeys)
    .reverse()
    .reduce(
      (state, [symbol, units]) => {
        if (state.excess === 0) return state
        const removed = Math.min(units, state.excess)
        return {
          units: { ...state.units, [symbol]: units - removed },
          excess: state.excess - removed,
        }
      },
      { units: input.units, excess: initialExcess },
    )
  return bounded.excess === 0
    ? Result.succeed(
        Object.fromEntries(Object.entries(bounded.units).map(([symbol, value]) => [symbol, value / WEIGHT_SCALE])),
      )
    : fail({
        _tag: 'InvalidRiskBalancedTrendNumber',
        operation: 'weight-allocation',
        value: bounded.excess,
        symbol: null,
        reason: 'negative',
      })
}

const quantizeWeightsDataFirst = (
  weights: Readonly<Record<string, number>>,
  maximumSymbolWeight: number,
): Result.Result<Readonly<Record<string, number>>, RiskBalancedTrendFailure> =>
  pipe(
    quantizedUnits(weights, Math.floor(maximumSymbolWeight * WEIGHT_SCALE + Number.EPSILON)),
    Result.flatMap(removeExcessUnits),
  )

export const quantizeWeights = Pipeable.dual(2, quantizeWeightsDataFirst)
