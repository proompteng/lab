import { Result } from 'effect'
import { type AlignedSession } from '../simulation'
import type {
  CandidateDevelopmentCommandFailure,
  CandidateDevelopmentInverseVolatilityStrategyIdentity,
  CandidateDevelopmentStrategyProtocol,
} from './contracts'
import { sourceVerificationFailure } from './evaluation'

export const candidateDevelopmentArtifactSchemaVersion = 'bayn.candidate-development-artifact.v1' as const
export const candidateDevelopmentPlanArtifactSchemaVersion = 'bayn.candidate-development-plan-artifact.v1' as const
export const candidateDevelopmentArtifactEvaluationTimeoutMs = 120_000
export const candidateDevelopmentArtifactInitializationTimeoutMs = 10_000

export const candidateDevelopmentPlanFailure = (field: string, cause: unknown): CandidateDevelopmentCommandFailure =>
  sourceVerificationFailure('verify-program-binding', { field, cause })

export const exactStringSet = (expected: readonly string[], observed: readonly string[]): boolean => {
  if (expected.length !== observed.length) return false
  const expectedSorted = [...expected].sort()
  const observedSorted = [...observed].sort()
  return expectedSorted.every((value, index) => value === observedSorted[index])
}

export const quantizeCandidateDevelopmentPlanNumber = (value: number): number =>
  Math.round(value * 1_000_000_000_000) / 1_000_000_000_000

export const candidateDevelopmentSampleVariance = (values: readonly number[]): number | undefined => {
  if (values.length < 2 || values.some((value) => !Number.isFinite(value))) return undefined
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length
  const variance = values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (values.length - 1)
  return Number.isFinite(variance) ? variance : undefined
}

export const candidateDevelopmentSampleCovariance = (
  first: readonly number[],
  second: readonly number[],
): number | undefined => {
  if (first.length !== second.length || first.length < 2) return undefined
  const firstMean = first.reduce((sum, value) => sum + value, 0) / first.length
  const secondMean = second.reduce((sum, value) => sum + value, 0) / second.length
  const covariance =
    first.reduce((sum, value, index) => sum + (value - firstMean) * ((second[index] as number) - secondMean), 0) /
    (first.length - 1)
  return Number.isFinite(covariance) ? covariance : undefined
}

export interface CandidateDevelopmentInverseVolatilityFeature {
  readonly totalReturns: Readonly<Record<string, number>>
  readonly dailyReturns: Readonly<Record<string, readonly number[]>>
  readonly annualizedVolatilities: Readonly<Record<string, number>>
  readonly targetWeights: Readonly<Record<string, number>>
  readonly exposureScale: number
  readonly estimatedAnnualizedPortfolioVolatility: number
}

export const deriveCandidateDevelopmentInverseVolatilityFeature = (
  alignedSessions: readonly AlignedSession[],
  signalSessionIndex: number,
  universe: readonly string[],
  strategyIdentity: CandidateDevelopmentInverseVolatilityStrategyIdentity,
  terminal: boolean,
  field: string,
): Result.Result<CandidateDevelopmentInverseVolatilityFeature, CandidateDevelopmentCommandFailure> => {
  const parameters = strategyIdentity.parameters
  const [firstRiskAsset, secondRiskAsset] = parameters.riskAssets
  if (firstRiskAsset === secondRiskAsset || !universe.includes(firstRiskAsset) || !universe.includes(secondRiskAsset)) {
    return Result.fail(
      candidateDevelopmentPlanFailure(`${field}.riskAssets`, {
        expected: 'two distinct members of the governed universe',
        observed: parameters.riskAssets,
      }),
    )
  }
  const firstPriceSessionIndex = signalSessionIndex - parameters.lookbackSessions
  if (firstPriceSessionIndex < 0) {
    return Result.fail(
      candidateDevelopmentPlanFailure(`${field}.window`, {
        expected: parameters.lookbackSessions + 1,
        observed: signalSessionIndex + 1,
      }),
    )
  }
  const totalReturns: Record<string, number> = {}
  const dailyReturns: Record<string, readonly number[]> = {}
  const annualizedVolatilities: Record<string, number> = {}
  for (const symbol of universe) {
    const returns: number[] = []
    for (let sessionIndex = firstPriceSessionIndex + 1; sessionIndex <= signalSessionIndex; sessionIndex += 1) {
      const previousClose = alignedSessions[sessionIndex - 1]?.bars[symbol]?.close
      const currentClose = alignedSessions[sessionIndex]?.bars[symbol]?.close
      if (
        previousClose === undefined ||
        currentClose === undefined ||
        !Number.isFinite(previousClose) ||
        !Number.isFinite(currentClose) ||
        previousClose <= 0 ||
        currentClose <= 0
      ) {
        return Result.fail(
          candidateDevelopmentPlanFailure(`${field}.marketData.${symbol}`, {
            expected: 'strictly positive finite adjusted closes across the complete lookback',
            observed: { previousClose, currentClose },
          }),
        )
      }
      const dailyReturn = currentClose / previousClose - 1
      if (!Number.isFinite(dailyReturn)) {
        return Result.fail(
          candidateDevelopmentPlanFailure(`${field}.dailyReturns.${symbol}`, {
            expected: 'finite daily returns',
            observed: dailyReturn,
          }),
        )
      }
      returns.push(dailyReturn)
    }
    const variance = candidateDevelopmentSampleVariance(returns)
    const annualizedVolatility =
      variance === undefined
        ? undefined
        : quantizeCandidateDevelopmentPlanNumber(Math.sqrt(variance * parameters.annualizationSessions))
    if (annualizedVolatility === undefined || !Number.isFinite(annualizedVolatility) || annualizedVolatility <= 0) {
      return Result.fail(
        candidateDevelopmentPlanFailure(`${field}.annualizedVolatility.${symbol}`, {
          expected: 'strictly positive finite sample annualized volatility',
          observed: annualizedVolatility,
        }),
      )
    }
    const firstClose = alignedSessions[firstPriceSessionIndex]?.bars[symbol]?.close
    const signalClose = alignedSessions[signalSessionIndex]?.bars[symbol]?.close
    if (firstClose === undefined || signalClose === undefined || firstClose <= 0 || !Number.isFinite(signalClose)) {
      return Result.fail(
        candidateDevelopmentPlanFailure(`${field}.totalReturn.${symbol}`, {
          expected: 'complete finite lookback prices',
          observed: { firstClose, signalClose },
        }),
      )
    }
    totalReturns[symbol] = quantizeCandidateDevelopmentPlanNumber(signalClose / firstClose - 1)
    dailyReturns[symbol] = returns
    annualizedVolatilities[symbol] = annualizedVolatility
  }
  const firstRiskVolatility = annualizedVolatilities[firstRiskAsset]
  const secondRiskVolatility = annualizedVolatilities[secondRiskAsset]
  const firstRiskReturns = dailyReturns[firstRiskAsset]
  const secondRiskReturns = dailyReturns[secondRiskAsset]
  if (
    firstRiskVolatility === undefined ||
    secondRiskVolatility === undefined ||
    firstRiskReturns === undefined ||
    secondRiskReturns === undefined
  ) {
    return Result.fail(
      candidateDevelopmentPlanFailure(`${field}.riskAssets`, {
        expected: parameters.riskAssets,
        observed: Object.keys(annualizedVolatilities),
      }),
    )
  }
  const firstInverseVolatility = 1 / firstRiskVolatility
  const secondInverseVolatility = 1 / secondRiskVolatility
  const inverseVolatilityDenominator = firstInverseVolatility + secondInverseVolatility
  const covariance = candidateDevelopmentSampleCovariance(firstRiskReturns, secondRiskReturns)
  if (covariance === undefined || !Number.isFinite(inverseVolatilityDenominator) || inverseVolatilityDenominator <= 0) {
    return Result.fail(
      candidateDevelopmentPlanFailure(`${field}.riskGeometry`, {
        expected: 'finite sample covariance and inverse-volatility denominator',
        observed: { covariance, inverseVolatilityDenominator },
      }),
    )
  }
  const normalizedFirstWeight = firstInverseVolatility / inverseVolatilityDenominator
  const normalizedSecondWeight = secondInverseVolatility / inverseVolatilityDenominator
  const unscaledPortfolioVariance =
    normalizedFirstWeight ** 2 * firstRiskVolatility ** 2 +
    normalizedSecondWeight ** 2 * secondRiskVolatility ** 2 +
    2 * normalizedFirstWeight * normalizedSecondWeight * covariance * parameters.annualizationSessions
  if (!Number.isFinite(unscaledPortfolioVariance) || unscaledPortfolioVariance <= 0) {
    return Result.fail(
      candidateDevelopmentPlanFailure(`${field}.portfolioVariance`, {
        expected: 'strictly positive finite sample portfolio variance',
        observed: unscaledPortfolioVariance,
      }),
    )
  }
  const unscaledAnnualizedPortfolioVolatility = Math.sqrt(unscaledPortfolioVariance)
  const riskScale = quantizeCandidateDevelopmentPlanNumber(
    Math.min(
      parameters.maximumGrossExposure,
      parameters.targetAnnualizedVolatility / unscaledAnnualizedPortfolioVolatility,
    ),
  )
  if (!Number.isFinite(riskScale) || riskScale <= 0) {
    return Result.fail(
      candidateDevelopmentPlanFailure(`${field}.riskScale`, {
        expected: 'strictly positive finite bounded risk scale',
        observed: riskScale,
      }),
    )
  }
  const targetWeights = Object.fromEntries(
    universe.map((symbol) => [
      symbol,
      terminal
        ? 0
        : symbol === firstRiskAsset
          ? quantizeCandidateDevelopmentPlanNumber(normalizedFirstWeight * riskScale)
          : symbol === secondRiskAsset
            ? quantizeCandidateDevelopmentPlanNumber(normalizedSecondWeight * riskScale)
            : 0,
    ]),
  )
  const exposureScale = quantizeCandidateDevelopmentPlanNumber(
    Object.values(targetWeights).reduce((sum, weight) => sum + weight, 0),
  )
  const portfolioReturns = Array.from({ length: parameters.lookbackSessions }, (_, returnIndex) =>
    universe.reduce(
      (sum, symbol) => sum + (dailyReturns[symbol]?.[returnIndex] ?? Number.NaN) * (targetWeights[symbol] ?? 0),
      0,
    ),
  )
  const portfolioVariance = candidateDevelopmentSampleVariance(portfolioReturns)
  if (portfolioVariance === undefined) {
    return Result.fail(
      candidateDevelopmentPlanFailure(`${field}.estimatedAnnualizedPortfolioVolatility`, {
        expected: 'finite sample portfolio return variance',
        observed: portfolioReturns,
      }),
    )
  }
  return Result.succeed({
    totalReturns,
    dailyReturns,
    annualizedVolatilities,
    targetWeights,
    exposureScale,
    estimatedAnnualizedPortfolioVolatility: quantizeCandidateDevelopmentPlanNumber(
      Math.sqrt(portfolioVariance * parameters.annualizationSessions),
    ),
  })
}

export const candidateDevelopmentMaximumGrossExposure = (
  strategyProtocol: CandidateDevelopmentStrategyProtocol,
): number => {
  const strategyIdentity = strategyProtocol.strategyIdentity
  if (strategyIdentity?.schemaVersion === 'bayn.candidate-development-strategy-identity.v2') {
    return strategyIdentity.parameters.maximumGrossExposure
  }
  if (strategyIdentity?.schemaVersion === 'bayn.candidate-development-strategy-identity.v1') {
    return strategyIdentity.parameters.selectedAssetWeight
  }
  return 1
}
