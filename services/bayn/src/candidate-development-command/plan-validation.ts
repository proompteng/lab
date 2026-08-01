import { Result } from 'effect'
import {
  expectedCandidateDevelopmentRebalanceSchedule,
  type CandidateDevelopmentPreflightPass,
} from '../candidate-development'
import { type DailyPerformancePoint } from '../evidence-contracts'
import { canonicalHashV1Result } from '../hash'
import { type AlignedSession } from '../simulation'
import { type EvaluationResult, type InputManifest, type IsoDate } from '../types'
import type {
  CandidateDevelopmentArtifactRuntimeInput,
  CandidateDevelopmentCommandFailure,
  CandidateDevelopmentPlannedDecision,
  CandidateDevelopmentStrategyPlan,
  CandidateDevelopmentStrategyProtocol,
} from './contracts'
import { decodeCandidateDevelopmentInputManifest, decodeCandidateDevelopmentStrategyPlan } from './contracts'
import {
  candidateDevelopmentMaximumGrossExposure,
  candidateDevelopmentPlanFailure,
  candidateDevelopmentSampleVariance,
  deriveCandidateDevelopmentInverseVolatilityFeature,
  exactStringSet,
  quantizeCandidateDevelopmentPlanNumber,
  type CandidateDevelopmentInverseVolatilityFeature,
} from './plan-math'

export const validateCandidateDevelopmentStrategyPlan = (
  value: unknown,
  preflight: CandidateDevelopmentPreflightPass,
  strategyProtocol: CandidateDevelopmentStrategyProtocol,
  officialSessions: readonly IsoDate[],
  signalSessionDates: readonly IsoDate[],
  alignedSessions: readonly AlignedSession[],
): Result.Result<CandidateDevelopmentStrategyPlan, CandidateDevelopmentCommandFailure> => {
  const decoded = decodeCandidateDevelopmentStrategyPlan(value)
  if (Result.isFailure(decoded)) {
    return Result.fail(candidateDevelopmentPlanFailure('artifact.plan', decoded.failure))
  }
  const plan = decoded.success as CandidateDevelopmentStrategyPlan
  const officialSessionIndexByDate = new Map(officialSessions.map((session, index) => [session, index] as const))
  const selectedStartIndex = officialSessionIndexByDate.get(preflight.selectedObservationStart)
  const accountingStart = selectedStartIndex === undefined ? undefined : officialSessions[selectedStartIndex - 1]
  if (accountingStart === undefined) {
    return Result.fail(
      candidateDevelopmentPlanFailure('artifact.plan.openingDecision', {
        expected: 'an official accounting predecessor for the selected observation window',
        observed: { selectedStartIndex, selectedObservationStart: preflight.selectedObservationStart },
      }),
    )
  }
  const expectedSchedule = expectedCandidateDevelopmentRebalanceSchedule(
    officialSessions,
    signalSessionDates,
    accountingStart,
    preflight.selectedObservationEnd,
  )
  const openingDecision = expectedSchedule[0]
  const selectedSchedule = expectedSchedule.slice(1)
  if (
    openingDecision?.executionDate !== accountingStart ||
    selectedSchedule.length !== preflight.expectedRebalanceSchedule.length ||
    selectedSchedule.some(
      (boundary, index) =>
        boundary.signalDate !== preflight.expectedRebalanceSchedule[index]?.signalDate ||
        boundary.executionDate !== preflight.expectedRebalanceSchedule[index]?.executionDate,
    )
  ) {
    return Result.fail(
      candidateDevelopmentPlanFailure('artifact.plan.openingDecision', {
        expected: {
          executionDate: accountingStart,
          selectedSchedule: preflight.expectedRebalanceSchedule,
        },
        observed: { openingDecision, selectedSchedule },
      }),
    )
  }
  if (plan.decisions.length !== expectedSchedule.length) {
    return Result.fail(
      candidateDevelopmentPlanFailure('artifact.plan.decisions.length', {
        expected: expectedSchedule.length,
        observed: plan.decisions.length,
      }),
    )
  }
  const universe = strategyProtocol.universe
  const strategyIdentity = strategyProtocol.strategyIdentity
  if (strategyIdentity === undefined) {
    return Result.fail(
      candidateDevelopmentPlanFailure('artifact.strategyProtocol.strategyIdentity', {
        expected: 'immutable allocation semantics',
        observed: undefined,
      }),
    )
  }
  const maximumGrossExposure = candidateDevelopmentMaximumGrossExposure(strategyProtocol)
  const lookbackSessions = strategyIdentity.parameters.lookbackSessions
  const governedAssets = new Set(
    strategyIdentity.schemaVersion === 'bayn.candidate-development-strategy-identity.v2'
      ? strategyIdentity.parameters.riskAssets
      : [...strategyIdentity.parameters.riskAssets, strategyIdentity.parameters.defensiveAsset],
  )
  if (
    alignedSessions.length !== officialSessions.length ||
    alignedSessions.some((session, index) => session.date !== officialSessions[index])
  ) {
    return Result.fail(
      candidateDevelopmentPlanFailure('artifact.plan.marketDataSessions', {
        expected: officialSessions,
        observed: alignedSessions.map(({ date }) => date),
      }),
    )
  }
  const normalizedDecisions: CandidateDevelopmentPlannedDecision[] = []
  for (let index = 0; index < plan.decisions.length; index += 1) {
    const decision = plan.decisions[index]
    const expected = expectedSchedule[index]
    if (decision.signalDate !== expected?.signalDate || decision.executionDate !== expected?.executionDate) {
      return Result.fail(
        candidateDevelopmentPlanFailure(`artifact.plan.decisions[${index}].schedule`, {
          expected,
          observed: { signalDate: decision.signalDate, executionDate: decision.executionDate },
        }),
      )
    }
    const signalSessionIndex = officialSessionIndexByDate.get(decision.signalDate)
    const covarianceWindowStartIndex = signalSessionIndex === undefined ? -1 : signalSessionIndex - lookbackSessions + 1
    const covarianceReturnSessions =
      covarianceWindowStartIndex < 0 || signalSessionIndex === undefined
        ? []
        : officialSessions.slice(covarianceWindowStartIndex, signalSessionIndex + 1)
    const covariancePriceSessions =
      covarianceWindowStartIndex < 1 || signalSessionIndex === undefined
        ? []
        : officialSessions.slice(covarianceWindowStartIndex - 1, signalSessionIndex + 1)
    const expectedFirstSession = covarianceReturnSessions[0]
    if (
      covarianceReturnSessions.length !== lookbackSessions ||
      covariancePriceSessions.length !== lookbackSessions + 1 ||
      expectedFirstSession === undefined ||
      decision.covarianceWindow.returnCount !== lookbackSessions ||
      decision.covarianceWindow.firstSession !== expectedFirstSession ||
      decision.covarianceWindow.lastSession !== decision.signalDate
    ) {
      return Result.fail(
        candidateDevelopmentPlanFailure(`artifact.plan.decisions[${index}].covarianceWindow`, {
          expected: {
            returnCount: lookbackSessions,
            firstSession: expectedFirstSession ?? null,
            lastSession: decision.signalDate,
          },
          observed: decision.covarianceWindow,
        }),
      )
    }
    const covarianceWindowHash = canonicalHashV1Result({
      schemaVersion: 'bayn.candidate-development-plan-window.v1',
      sessions: covariancePriceSessions,
    })
    if (Result.isFailure(covarianceWindowHash)) {
      return Result.fail(
        candidateDevelopmentPlanFailure(
          `artifact.plan.decisions[${index}].covarianceWindow.sessionsHash`,
          covarianceWindowHash.failure,
        ),
      )
    }
    const allocationTolerance = 1e-12 + Number.EPSILON
    let inverseVolatilityFeature: CandidateDevelopmentInverseVolatilityFeature | undefined
    if (strategyIdentity.schemaVersion === 'bayn.candidate-development-strategy-identity.v2') {
      const derived = deriveCandidateDevelopmentInverseVolatilityFeature(
        alignedSessions,
        signalSessionIndex ?? -1,
        universe,
        strategyIdentity,
        index === plan.decisions.length - 1,
        `artifact.plan.decisions[${index}].inverseVolatility`,
      )
      if (Result.isFailure(derived)) return Result.fail(derived.failure)
      inverseVolatilityFeature = derived.success
      if (
        universe.some((symbol) => {
          const expectedWeight = inverseVolatilityFeature?.targetWeights[symbol]
          const observedWeight = decision.targetWeights[symbol]
          return (
            expectedWeight === undefined ||
            observedWeight === undefined ||
            Math.abs(observedWeight - expectedWeight) > allocationTolerance
          )
        })
      ) {
        return Result.fail(
          candidateDevelopmentPlanFailure(`artifact.plan.decisions[${index}].inverseVolatility.allocation`, {
            expected: inverseVolatilityFeature.targetWeights,
            observed: decision.targetWeights,
          }),
        )
      }
      if (
        Math.abs(decision.exposureScale - inverseVolatilityFeature.exposureScale) > allocationTolerance ||
        Math.abs(
          decision.estimatedAnnualizedPortfolioVolatility -
            inverseVolatilityFeature.estimatedAnnualizedPortfolioVolatility,
        ) > allocationTolerance
      ) {
        return Result.fail(
          candidateDevelopmentPlanFailure(`artifact.plan.decisions[${index}].inverseVolatility.riskScale`, {
            expected: {
              exposureScale: inverseVolatilityFeature.exposureScale,
              estimatedAnnualizedPortfolioVolatility: inverseVolatilityFeature.estimatedAnnualizedPortfolioVolatility,
            },
            observed: {
              exposureScale: decision.exposureScale,
              estimatedAnnualizedPortfolioVolatility: decision.estimatedAnnualizedPortfolioVolatility,
            },
          }),
        )
      }
    }
    let momentumFeature:
      | {
          readonly totalReturns: Readonly<Record<string, number>>
          readonly selectedSymbol: string | null
          readonly estimatedAnnualizedPortfolioVolatility: number
        }
      | undefined
    if (strategyIdentity.schemaVersion === 'bayn.candidate-development-strategy-identity.v1') {
      const parameters = strategyIdentity.parameters
      const [firstRiskAsset, secondRiskAsset] = parameters.riskAssets
      if (
        parameters.relativeMomentumTieBreak !== firstRiskAsset &&
        parameters.relativeMomentumTieBreak !== secondRiskAsset
      ) {
        return Result.fail(
          candidateDevelopmentPlanFailure(
            'artifact.strategyProtocol.strategyIdentity.parameters.relativeMomentumTieBreak',
            {
              expected: parameters.riskAssets,
              observed: parameters.relativeMomentumTieBreak,
            },
          ),
        )
      }
      const firstFeatureSession =
        signalSessionIndex === undefined ? undefined : alignedSessions[signalSessionIndex - lookbackSessions]
      const signalSession = signalSessionIndex === undefined ? undefined : alignedSessions[signalSessionIndex]
      if (firstFeatureSession === undefined || signalSession === undefined) {
        return Result.fail(
          candidateDevelopmentPlanFailure(`artifact.plan.decisions[${index}].momentumWindow`, {
            expected: { lookbackSessions, signalDate: decision.signalDate },
            observed: null,
          }),
        )
      }
      const totalReturns: Record<string, number> = {}
      for (const symbol of universe) {
        const firstBar = firstFeatureSession.bars[symbol]
        const signalBar = signalSession.bars[symbol]
        if (firstBar === undefined || signalBar === undefined) {
          return Result.fail(
            candidateDevelopmentPlanFailure(`artifact.plan.decisions[${index}].momentumWindow.${symbol}`, {
              expected: [firstFeatureSession.date, signalSession.date],
              observed: null,
            }),
          )
        }
        totalReturns[symbol] =
          Math.round((signalBar.close / firstBar.close - 1) * 1_000_000_000_000) / 1_000_000_000_000
      }
      const firstRiskReturn = totalReturns[firstRiskAsset]
      const secondRiskReturn = totalReturns[secondRiskAsset]
      const defensiveReturn = totalReturns[parameters.defensiveAsset]
      if (firstRiskReturn === undefined || secondRiskReturn === undefined || defensiveReturn === undefined) {
        return Result.fail(
          candidateDevelopmentPlanFailure(`artifact.plan.decisions[${index}].momentumUniverse`, {
            expected: [...parameters.riskAssets, parameters.defensiveAsset],
            observed: Object.keys(totalReturns),
          }),
        )
      }
      const relativeWinner =
        firstRiskReturn === secondRiskReturn
          ? parameters.relativeMomentumTieBreak
          : firstRiskReturn > secondRiskReturn
            ? firstRiskAsset
            : secondRiskAsset
      const relativeWinnerReturn = totalReturns[relativeWinner]
      const selectedSymbol =
        relativeWinnerReturn !== undefined && relativeWinnerReturn > parameters.absoluteMomentumThreshold
          ? relativeWinner
          : defensiveReturn > parameters.absoluteMomentumThreshold
            ? parameters.defensiveAsset
            : null
      const terminal = index === plan.decisions.length - 1
      const expectedWeights = Object.fromEntries(
        universe.map((symbol) => [symbol, !terminal && selectedSymbol === symbol ? parameters.selectedAssetWeight : 0]),
      )
      if (
        universe.some((symbol) => {
          const observedWeight = decision.targetWeights[symbol]
          const expectedWeight = expectedWeights[symbol]
          return (
            observedWeight === undefined ||
            expectedWeight === undefined ||
            Math.abs(observedWeight - expectedWeight) > 1e-12 + Number.EPSILON
          )
        })
      ) {
        return Result.fail(
          candidateDevelopmentPlanFailure(`artifact.plan.decisions[${index}].momentumSelection`, {
            expected: { selectedSymbol, targetWeights: expectedWeights },
            observed: decision.targetWeights,
          }),
        )
      }
      const volatilityWindowStartIndex =
        signalSessionIndex === undefined ? -1 : signalSessionIndex - parameters.volatilityWindowSessions + 1
      if (volatilityWindowStartIndex < 1 || signalSessionIndex === undefined) {
        return Result.fail(
          candidateDevelopmentPlanFailure(`artifact.plan.decisions[${index}].momentumVolatility.window`, {
            expected: parameters.volatilityWindowSessions,
            observed: signalSessionIndex === undefined ? 0 : signalSessionIndex,
          }),
        )
      }
      const portfolioReturns: number[] = []
      for (let sessionIndex = volatilityWindowStartIndex; sessionIndex <= signalSessionIndex; sessionIndex += 1) {
        let portfolioReturn = 0
        for (const symbol of universe) {
          const weight = expectedWeights[symbol]
          if (weight === undefined || weight === 0) continue
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
              candidateDevelopmentPlanFailure(
                `artifact.plan.decisions[${index}].momentumVolatility.marketData.${symbol}`,
                {
                  expected: 'strictly positive finite adjusted closes across the complete volatility window',
                  observed: { previousClose, currentClose },
                },
              ),
            )
          }
          portfolioReturn += (currentClose / previousClose - 1) * weight
        }
        portfolioReturns.push(portfolioReturn)
      }
      const portfolioVariance = candidateDevelopmentSampleVariance(portfolioReturns)
      if (portfolioVariance === undefined) {
        return Result.fail(
          candidateDevelopmentPlanFailure(`artifact.plan.decisions[${index}].momentumVolatility`, {
            expected: 'finite sample portfolio return variance',
            observed: portfolioReturns,
          }),
        )
      }
      const estimatedAnnualizedPortfolioVolatility = quantizeCandidateDevelopmentPlanNumber(
        Math.sqrt(portfolioVariance * parameters.annualizationSessions),
      )
      if (
        Math.abs(decision.estimatedAnnualizedPortfolioVolatility - estimatedAnnualizedPortfolioVolatility) >
        allocationTolerance
      ) {
        return Result.fail(
          candidateDevelopmentPlanFailure(`artifact.plan.decisions[${index}].momentumVolatility`, {
            expected: estimatedAnnualizedPortfolioVolatility,
            observed: decision.estimatedAnnualizedPortfolioVolatility,
          }),
        )
      }
      momentumFeature = { totalReturns, selectedSymbol, estimatedAnnualizedPortfolioVolatility }
    }
    const weightSymbols = Object.keys(decision.targetWeights)
    const signalSymbols = decision.signals.map(({ symbol }) => symbol)
    if (!exactStringSet(universe, weightSymbols) || !exactStringSet(universe, signalSymbols)) {
      return Result.fail(
        candidateDevelopmentPlanFailure(`artifact.plan.decisions[${index}].universe`, {
          expected: universe,
          observed: { weightSymbols, signalSymbols },
        }),
      )
    }
    const grossExposure = Object.values(decision.targetWeights).reduce((sum, weight) => sum + weight, 0)
    const uncappedGrossExposure = decision.signals.reduce((sum, signal) => sum + signal.uncappedWeight, 0)
    const cappedGrossExposure = decision.signals.reduce((sum, signal) => sum + signal.cappedWeight, 0)
    const grossTolerance = allocationTolerance * Math.max(1, decision.signals.length)
    if (!Number.isFinite(grossExposure) || grossExposure < 0 || grossExposure > maximumGrossExposure + grossTolerance) {
      return Result.fail(
        candidateDevelopmentPlanFailure(`artifact.plan.decisions[${index}].grossExposure`, {
          expected: `finite within 0..${maximumGrossExposure}`,
          observed: grossExposure,
        }),
      )
    }
    if (
      !Number.isFinite(uncappedGrossExposure) ||
      uncappedGrossExposure < 0 ||
      Math.abs(uncappedGrossExposure - grossExposure) > grossTolerance
    ) {
      return Result.fail(
        candidateDevelopmentPlanFailure(`artifact.plan.decisions[${index}].uncappedGrossExposure`, {
          expected: 'the bounded final gross exposure',
          observed: uncappedGrossExposure,
        }),
      )
    }
    if (
      !Number.isFinite(cappedGrossExposure) ||
      cappedGrossExposure < 0 ||
      cappedGrossExposure > maximumGrossExposure + grossTolerance ||
      Math.abs(cappedGrossExposure - grossExposure) > grossTolerance
    ) {
      return Result.fail(
        candidateDevelopmentPlanFailure(`artifact.plan.decisions[${index}].cappedGrossExposure`, {
          expected: 'the bounded final gross exposure',
          observed: cappedGrossExposure,
        }),
      )
    }
    if (Math.abs(decision.exposureScale - grossExposure) > grossTolerance) {
      return Result.fail(
        candidateDevelopmentPlanFailure(`artifact.plan.decisions[${index}].exposureScale`, {
          expected: grossExposure,
          observed: decision.exposureScale,
        }),
      )
    }
    for (let signalIndex = 0; signalIndex < decision.signals.length; signalIndex += 1) {
      const signal = decision.signals[signalIndex]
      const targetWeight = decision.targetWeights[signal.symbol]
      if (
        !governedAssets.has(signal.symbol) &&
        (signal.eligible || signal.targetWeight !== 0 || signal.uncappedWeight !== 0 || signal.cappedWeight !== 0)
      ) {
        return Result.fail(
          candidateDevelopmentPlanFailure(`artifact.plan.decisions[${index}].signals[${signalIndex}].governedAsset`, {
            expected: { governedAssets: [...governedAssets], eligible: false, weight: 0 },
            observed: signal,
          }),
        )
      }
      if (signal.horizons.length !== 1 || signal.horizons[0]?.horizonSessions !== lookbackSessions) {
        return Result.fail(
          candidateDevelopmentPlanFailure(`artifact.plan.decisions[${index}].signals[${signalIndex}].horizons`, {
            expected: [{ horizonSessions: lookbackSessions }],
            observed: signal.horizons,
          }),
        )
      }
      if (momentumFeature !== undefined) {
        const expectedReturn = momentumFeature.totalReturns[signal.symbol]
        const horizon = signal.horizons[0]
        if (
          expectedReturn === undefined ||
          horizon === undefined ||
          Math.abs(horizon.return - expectedReturn) > allocationTolerance ||
          Math.abs(horizon.normalizedTrend - expectedReturn) > allocationTolerance ||
          Math.abs(signal.dailyVolatility) > allocationTolerance ||
          Math.abs(
            signal.annualizedVolatility -
              (momentumFeature.selectedSymbol === signal.symbol
                ? momentumFeature.estimatedAnnualizedPortfolioVolatility
                : 0),
          ) > allocationTolerance ||
          Math.abs(signal.compositeScore - expectedReturn) > allocationTolerance ||
          Math.abs(signal.positiveScore - Math.max(0, expectedReturn)) > allocationTolerance ||
          signal.eligible !== (momentumFeature.selectedSymbol === signal.symbol)
        ) {
          return Result.fail(
            candidateDevelopmentPlanFailure(`artifact.plan.decisions[${index}].signals[${signalIndex}].momentum`, {
              expected: {
                return: expectedReturn,
                normalizedTrend: expectedReturn,
                dailyVolatility: 0,
                annualizedVolatility:
                  momentumFeature.selectedSymbol === signal.symbol
                    ? momentumFeature.estimatedAnnualizedPortfolioVolatility
                    : 0,
                compositeScore: expectedReturn,
                positiveScore: expectedReturn === undefined ? undefined : Math.max(0, expectedReturn),
                eligible: momentumFeature.selectedSymbol === signal.symbol,
              },
              observed: signal,
            }),
          )
        }
      }
      if (inverseVolatilityFeature !== undefined) {
        const parameters = strategyIdentity.parameters
        const expectedReturn = inverseVolatilityFeature.totalReturns[signal.symbol]
        const expectedAnnualizedVolatility = inverseVolatilityFeature.annualizedVolatilities[signal.symbol]
        const expectedEligible = parameters.riskAssets.includes(signal.symbol)
        const expectedScore =
          expectedEligible && expectedAnnualizedVolatility !== undefined ? 1 / expectedAnnualizedVolatility : 0
        const horizon = signal.horizons[0]
        if (
          expectedReturn === undefined ||
          expectedAnnualizedVolatility === undefined ||
          horizon === undefined ||
          Math.abs(horizon.return - expectedReturn) > allocationTolerance ||
          Math.abs(horizon.normalizedTrend - expectedReturn) > allocationTolerance ||
          Math.abs(
            signal.dailyVolatility - expectedAnnualizedVolatility / Math.sqrt(parameters.annualizationSessions),
          ) > allocationTolerance ||
          Math.abs(signal.annualizedVolatility - expectedAnnualizedVolatility) > allocationTolerance ||
          Math.abs(signal.compositeScore - expectedScore) > allocationTolerance ||
          Math.abs(signal.positiveScore - expectedScore) > allocationTolerance ||
          signal.eligible !== expectedEligible
        ) {
          return Result.fail(
            candidateDevelopmentPlanFailure(
              `artifact.plan.decisions[${index}].signals[${signalIndex}].inverseVolatility`,
              {
                expected: {
                  return: expectedReturn,
                  normalizedTrend: expectedReturn,
                  dailyVolatility: expectedAnnualizedVolatility / Math.sqrt(parameters.annualizationSessions),
                  annualizedVolatility: expectedAnnualizedVolatility,
                  compositeScore: expectedScore,
                  positiveScore: expectedScore,
                  eligible: expectedEligible,
                },
                observed: signal,
              },
            ),
          )
        }
      }
      if (
        targetWeight === undefined ||
        !Object.is(signal.targetWeight, targetWeight) ||
        Math.abs(signal.cappedWeight - signal.targetWeight) > allocationTolerance ||
        Math.abs(signal.uncappedWeight - signal.targetWeight) > allocationTolerance
      ) {
        return Result.fail(
          candidateDevelopmentPlanFailure(`artifact.plan.decisions[${index}].signals[${signalIndex}]`, {
            expected: {
              targetWeight,
              cappedWeight: targetWeight,
              uncappedWeight: targetWeight,
            },
            observed: {
              targetWeight: signal.targetWeight,
              cappedWeight: signal.cappedWeight,
              uncappedWeight: signal.uncappedWeight,
            },
          }),
        )
      }
    }
    if (strategyIdentity.schemaVersion === 'bayn.candidate-development-strategy-identity.v1') {
      const allocatedWeights = Object.values(decision.targetWeights).filter((weight) => weight > allocationTolerance)
      if (
        allocatedWeights.length > 1 ||
        (allocatedWeights[0] !== undefined &&
          Math.abs(allocatedWeights[0] - strategyIdentity.parameters.selectedAssetWeight) > allocationTolerance)
      ) {
        return Result.fail(
          candidateDevelopmentPlanFailure(`artifact.plan.decisions[${index}].allocation`, {
            expected: `all cash or one governed asset at ${strategyIdentity.parameters.selectedAssetWeight}`,
            observed: decision.targetWeights,
          }),
        )
      }
    }
    normalizedDecisions.push({
      ...decision,
      covarianceWindow: { ...decision.covarianceWindow, sessionsHash: covarianceWindowHash.success },
    })
  }
  const terminal = plan.decisions.at(-1)
  if (terminal === undefined || Object.values(terminal.targetWeights).some((weight) => weight !== 0)) {
    return Result.fail(
      candidateDevelopmentPlanFailure('artifact.plan.terminalDecision', {
        expected: 'all-cash target weights',
        observed: terminal?.targetWeights ?? null,
      }),
    )
  }
  return Result.succeed({ ...plan, decisions: normalizedDecisions })
}

export const validateCandidateDevelopmentPlanInputManifest = (
  value: unknown,
  runtimeInput: CandidateDevelopmentArtifactRuntimeInput,
  strategyProtocol: CandidateDevelopmentStrategyProtocol,
  preflight: CandidateDevelopmentPreflightPass,
): Result.Result<InputManifest, CandidateDevelopmentCommandFailure> => {
  const decoded = decodeCandidateDevelopmentInputManifest(value)
  if (Result.isFailure(decoded)) {
    return Result.fail(candidateDevelopmentPlanFailure('artifact.inputManifest', decoded.failure))
  }
  const manifest = decoded.success as InputManifest
  const { hash: declaredManifestHash, ...manifestMaterial } = manifest
  const recomputedManifestHash = canonicalHashV1Result(manifestMaterial)
  if (Result.isFailure(recomputedManifestHash)) {
    return Result.fail(candidateDevelopmentPlanFailure('artifact.inputManifest.hash', recomputedManifestHash.failure))
  }
  if (recomputedManifestHash.success !== declaredManifestHash) {
    return Result.fail(
      candidateDevelopmentPlanFailure('artifact.inputManifest.hash', {
        expected: recomputedManifestHash.success,
        observed: declaredManifestHash,
      }),
    )
  }
  const committedMarketData = runtimeInput.sourceManifest.marketData
  const bindings = [
    ['hash', runtimeInput.marketData.inputManifestHash, manifest.hash],
    ['committedInputManifestHash', committedMarketData.inputManifestHash, manifest.hash],
    ['snapshotId', runtimeInput.marketData.snapshotId, manifest.finalizedSnapshot.snapshotId],
    [
      'finalizedSnapshotContentHash',
      committedMarketData.finalizedSnapshotContentHash,
      manifest.finalizedSnapshot.contentHash,
    ],
    ['sessionCount', runtimeInput.preflightInput.officialSessions.length, manifest.sessionCount],
    ['rowCount', runtimeInput.marketData.bars.length, manifest.rowCount],
  ] as const
  for (const [field, expected, observed] of bindings) {
    if (expected !== observed) {
      return Result.fail(candidateDevelopmentPlanFailure(`artifact.inputManifest.${field}`, { expected, observed }))
    }
  }
  const manifestSessions = [manifest.firstSession, manifest.lastSession]
  const expectedSessions = [
    runtimeInput.preflightInput.officialSessions[0],
    runtimeInput.preflightInput.officialSessions.at(-1),
  ]
  const manifestUniverse = manifest.symbols.map(({ symbol }) => symbol)
  if (
    manifestSessions[0] !== expectedSessions[0] ||
    manifestSessions[1] !== expectedSessions[1] ||
    !exactStringSet(strategyProtocol.universe, manifestUniverse)
  ) {
    return Result.fail(
      candidateDevelopmentPlanFailure('artifact.inputManifest.coverage', {
        expected: { sessions: expectedSessions, universe: strategyProtocol.universe },
        observed: { sessions: manifestSessions, universe: manifestUniverse },
      }),
    )
  }
  const expectedBounds = {
    dataStart: expectedSessions[0],
    dataEnd: expectedSessions[1],
    lookbackStart: expectedSessions[0],
    evaluationStart: preflight.selectedObservationStart,
    evaluationEnd: preflight.selectedObservationEnd,
  } as const
  for (const field of ['dataStart', 'dataEnd', 'lookbackStart', 'evaluationStart', 'evaluationEnd'] as const) {
    if (manifest.bounds[field] !== expectedBounds[field]) {
      return Result.fail(
        candidateDevelopmentPlanFailure(`artifact.inputManifest.bounds.${field}`, {
          expected: expectedBounds[field],
          observed: manifest.bounds[field],
        }),
      )
    }
  }
  return Result.succeed(manifest)
}

export const selectedCandidateDevelopmentTrace = (
  simulation: EvaluationResult['simulation'],
  selectedSessions: readonly IsoDate[],
): Result.Result<EvaluationResult['simulation'], CandidateDevelopmentCommandFailure> => {
  const bySession = new Map(simulation.dailyMarks.map((mark) => [mark.sessionDate, mark] as const))
  const dailyMarks = selectedSessions.map((sessionDate) => bySession.get(sessionDate))
  const missing = dailyMarks.findIndex((mark) => mark === undefined)
  if (missing >= 0) {
    return Result.fail(
      candidateDevelopmentPlanFailure('artifact.plan.selectedTrace', {
        index: missing,
        expected: selectedSessions[missing],
        observed: null,
      }),
    )
  }
  return Result.succeed({ ...simulation, dailyMarks: dailyMarks as EvaluationResult['simulation']['dailyMarks'] })
}

export const selectedCandidateDevelopmentPerformance = (
  series: readonly DailyPerformancePoint[],
  selectedSessions: readonly IsoDate[],
  field: string,
): Result.Result<readonly DailyPerformancePoint[], CandidateDevelopmentCommandFailure> => {
  const bySession = new Map(series.map((point) => [point.sessionDate, point] as const))
  const selected = selectedSessions.map((sessionDate) => bySession.get(sessionDate))
  const missing = selected.findIndex((point) => point === undefined)
  return missing < 0
    ? Result.succeed(selected as readonly DailyPerformancePoint[])
    : Result.fail(
        candidateDevelopmentPlanFailure(field, {
          index: missing,
          expected: selectedSessions[missing],
          observed: null,
        }),
      )
}
