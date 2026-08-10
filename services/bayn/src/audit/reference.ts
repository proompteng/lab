import { pipe, Result, Schema } from 'effect'

import { makeRunIdentityResult, makeStrategyProtocolHashResult, type RuntimeProvenance } from '../contracts'
import { MICROS } from '../execution-model'
import type {
  DailyBar,
  EconomicVerdict,
  GateResult,
  InputManifest,
  PerformanceMetrics,
  Protocol,
  SimulationProtocol,
} from '../types'
import { DecisionPlanSchema } from '../evidence-contracts'
import { strictParseOptions } from '../schemas'
import type { StrategyApplication } from '../strategy/core'
import {
  align,
  directVolatilityTarget,
  monthEnds,
  riskBalancedDecisionPlan,
  riskBalancedHistoryLength,
  roundWeight,
} from './reference/decisions'
import { hashReferenceMaterial } from './reference/replay/identities'
import type {
  ReferenceComputation,
  ReferenceEvaluation,
  ReferenceEvaluationFailure,
  ReferenceEvaluationWithWork,
  ReferenceEvaluationWork,
  Replay,
  ReplayWithWork,
  Session,
  Target,
} from './reference/model'
import { replay } from './reference/replay'

export type { ReferenceEvaluation, ReferenceEvaluationFailure } from './reference/model'
export { restrictReferenceBuyFill } from './reference/replay'

const makeVerdict = (
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

/**
 * Candidate qualification must replay the exact reviewed application that produced the stored
 * decisions. The reference still owns the independent session selection, benchmark construction,
 * and accounting replay; only the strategy decision is supplied by the reviewed application.
 */
const strategyTargetsFromApplication = (
  sessions: readonly Session[],
  signalIndices: readonly number[],
  application: StrategyApplication<any, any, any>,
): ReferenceComputation<readonly Target[]> =>
  Result.all(
    signalIndices.map((signalIndex) =>
      pipe(
        application.contextAtSignal(sessions, signalIndex),
        Result.mapError(
          (cause): ReferenceEvaluationFailure => ({
            _tag: 'ReferenceStrategyDecisionFailed',
            signalIndex,
            cause,
          }),
        ),
        Result.flatMap((context) =>
          pipe(
            application.definition.decide(context),
            Result.mapError(
              (cause): ReferenceEvaluationFailure => ({
                _tag: 'ReferenceStrategyDecisionFailed',
                signalIndex,
                cause,
              }),
            ),
          ),
        ),
        Result.flatMap((target) => {
          const decision = Schema.decodeUnknownResult(DecisionPlanSchema, strictParseOptions)(target)
          return Result.succeed({
            signalIndex,
            executionIndex: signalIndex + 1,
            weights: target.targetWeights,
            ...(Result.isSuccess(decision) ? { plan: decision.success } : { requireDecisionEvidence: false as const }),
          })
        }),
      ),
    ),
  )

const evaluateReferenceWithWork = (
  bars: readonly DailyBar[],
  manifest: InputManifest,
  protocol: Protocol,
  provenance: RuntimeProvenance,
  closeAtEnd: boolean,
  application?: StrategyApplication<any, any, any>,
): ReferenceComputation<ReferenceEvaluationWithWork> => {
  const sessionsResult = align(bars, manifest, protocol.universe)
  if (Result.isFailure(sessionsResult)) return Result.fail(sessionsResult.failure)
  const sessions = sessionsResult.success
  const dates = sessions.map((session) => session.date)
  const requiredHistory = riskBalancedHistoryLength(protocol)
  const eligibleSignals = monthEnds(dates).filter((index) => {
    if (index < requiredHistory || index >= dates.length - 1) return false
    const firstHistoryDate = dates.at(index - requiredHistory)
    const executionDate = dates.at(index + 1)
    return (
      firstHistoryDate !== undefined &&
      executionDate !== undefined &&
      firstHistoryDate >= manifest.bounds.lookbackStart &&
      executionDate >= manifest.bounds.evaluationStart &&
      executionDate <= manifest.bounds.evaluationEnd
    )
  })
  const firstEligibleSignal = eligibleSignals[0]
  if (firstEligibleSignal === undefined) {
    return Result.fail({
      _tag: 'ReferenceNoEligibleSignal',
      sessionCount: sessions.length,
      lookbackStart: manifest.bounds.lookbackStart,
      evaluationStart: manifest.bounds.evaluationStart,
      evaluationEnd: manifest.bounds.evaluationEnd,
    })
  }
  const startIndex = firstEligibleSignal + 1
  const firstAfterEnd = dates.findIndex((date) => date > manifest.bounds.evaluationEnd)
  const endExclusive = firstAfterEnd === -1 ? dates.length : firstAfterEnd
  const boundedSessions = sessions.slice(0, endExclusive)
  if (endExclusive - startIndex < protocol.thresholds.minimumObservations) {
    return Result.fail({
      _tag: 'ReferenceInsufficientObservations',
      actual: endExclusive - startIndex,
      required: protocol.thresholds.minimumObservations,
      startIndex,
      endExclusive,
    })
  }

  const parameterHashResult = hashReferenceMaterial('strategy-parameters', protocol)
  if (Result.isFailure(parameterHashResult)) return Result.fail(parameterHashResult.failure)
  const parameterHash = parameterHashResult.success
  const strategyIdentity = {
    name: provenance.strategy.name,
    behaviorHash: provenance.strategy.behaviorHash,
    parameterHash,
    parameterSchemaVersion: protocol.schemaVersion,
  }
  if (parameterHash !== provenance.strategy.parameterHash) {
    return Result.fail({
      _tag: 'ReferenceProvenanceMismatch',
      requiredStrategyName: provenance.strategy.name,
      actualStrategyName: provenance.strategy.name,
      expectedParameterHash: parameterHash,
      actualParameterHash: provenance.strategy.parameterHash,
    })
  }
  const runIdentityResult = makeRunIdentityResult({
    schemaVersion: 'bayn.run-identity.v1',
    sourceRevision: provenance.sourceRevision,
    image: provenance.image,
    strategy: {
      name: provenance.strategy.name,
      behaviorHash: provenance.strategy.behaviorHash,
      parameters: protocol,
    },
    finalizedSnapshot: manifest.finalizedSnapshot,
    calendarVersion: manifest.finalizedSnapshot.calendarVersion,
    bounds: manifest.bounds,
  })
  if (Result.isFailure(runIdentityResult)) return Result.fail(runIdentityResult.failure)
  const protocolHashResult = makeStrategyProtocolHashResult(strategyIdentity)
  if (Result.isFailure(protocolHashResult)) return Result.fail(protocolHashResult.failure)
  const runId = runIdentityResult.success.runId
  const protocolHash = protocolHashResult.success
  const candidateTargetsResult =
    application !== undefined &&
    (application.reviewedSource !== undefined || application.definition.name !== 'risk-balanced-trend')
      ? strategyTargetsFromApplication(sessions, eligibleSignals, application)
      : Result.all(
          eligibleSignals.map((signalIndex) =>
            pipe(
              riskBalancedDecisionPlan(signalIndex, sessions, protocol),
              Result.map(
                (plan): Target => ({
                  signalIndex,
                  executionIndex: signalIndex + 1,
                  weights: plan.targetWeights,
                  plan,
                }),
              ),
            ),
          ),
        )
  if (Result.isFailure(candidateTargetsResult)) return Result.fail(candidateTargetsResult.failure)
  const candidateTargets = candidateTargetsResult.success
  const equalWeight = roundWeight(1 / protocol.universe.length)
  const buyAndHoldTargets: readonly Target[] = [
    {
      signalIndex: startIndex - 1,
      executionIndex: startIndex,
      weights: Object.fromEntries(protocol.universe.map((symbol) => [symbol, equalWeight])),
    },
  ]
  const directVolTargetsResult = Result.all(
    eligibleSignals.map((signalIndex) =>
      pipe(
        directVolatilityTarget(sessions, signalIndex, protocol),
        Result.map(
          (weights): Target => ({
            signalIndex,
            executionIndex: signalIndex + 1,
            weights,
          }),
        ),
      ),
    ),
  )
  if (Result.isFailure(directVolTargetsResult)) return Result.fail(directVolTargetsResult.failure)
  const directVolTargets = directVolTargetsResult.success
  const strategy = replay(boundedSessions, candidateTargets, startIndex, protocol, MICROS, runId, true, closeAtEnd)
  const buyAndHold = replay(boundedSessions, buyAndHoldTargets, startIndex, protocol, MICROS, runId, false, closeAtEnd)
  const directVolTiming = replay(
    boundedSessions,
    directVolTargets,
    startIndex,
    protocol,
    MICROS,
    runId,
    false,
    closeAtEnd,
  )
  const doubleCostStrategy = replay(
    boundedSessions,
    candidateTargets,
    startIndex,
    protocol,
    BigInt(protocol.executionModel.doubleCostMultiplier) * MICROS,
    runId,
    false,
    closeAtEnd,
  )
  return pipe(
    Result.all({ strategy, buyAndHold, directVolTiming, doubleCostStrategy }),
    Result.map(
      ({ strategy, buyAndHold, directVolTiming, doubleCostStrategy }): ReferenceEvaluationWithWork => ({
        runId,
        protocolHash,
        strategy,
        buyAndHold,
        directVolTiming,
        doubleCostStrategy,
        verdict: makeVerdict(
          strategy.metrics,
          buyAndHold.metrics,
          directVolTiming.metrics,
          doubleCostStrategy.metrics,
          protocol,
        ),
      }),
    ),
  )
}

const stripReplayWork = (replay: ReplayWithWork): Replay => ({
  metrics: replay.metrics,
  events: replay.events,
  decisions: replay.decisions,
  daily: replay.daily,
  trace: replay.trace,
})

export const evaluateReference = (
  bars: readonly DailyBar[],
  manifest: InputManifest,
  protocol: Protocol,
  provenance: RuntimeProvenance,
  closeAtEnd = true,
  application?: StrategyApplication<any, any, any>,
): ReferenceComputation<ReferenceEvaluation> =>
  pipe(
    evaluateReferenceWithWork(bars, manifest, protocol, provenance, closeAtEnd, application),
    Result.map((reference) => ({
      runId: reference.runId,
      protocolHash: reference.protocolHash,
      strategy: stripReplayWork(reference.strategy),
      buyAndHold: stripReplayWork(reference.buyAndHold),
      directVolTiming: stripReplayWork(reference.directVolTiming),
      doubleCostStrategy: stripReplayWork(reference.doubleCostStrategy),
      verdict: reference.verdict,
    })),
  )

export const measureReferenceEvaluationWork = (
  bars: readonly DailyBar[],
  manifest: InputManifest,
  protocol: Protocol,
  provenance: RuntimeProvenance,
  closeAtEnd = true,
  application?: StrategyApplication<any, any, any>,
): ReferenceComputation<ReferenceEvaluationWork> =>
  pipe(
    evaluateReferenceWithWork(bars, manifest, protocol, provenance, closeAtEnd, application),
    Result.map((reference) => ({
      strategy: reference.strategy.work,
      buyAndHold: reference.buyAndHold.work,
      directVolTiming: reference.directVolTiming.work,
      doubleCostStrategy: reference.doubleCostStrategy.work,
    })),
  )
