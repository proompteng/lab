import { Result, Schema, pipe } from 'effect'

import type { RuntimeProvenance } from '../contracts'
import { MICROS } from '../execution-model'
import { reconcileMarkedEquity, type SimulationReconciliationIssue } from '../simulation-reconciliation'
import {
  alignBars,
  buildVerdict,
  directVolatilityWeights,
  makeEvaluationIdentity,
  roundWeight,
  selectEvaluationWindow,
  simulate,
  type AlignedSession,
  type SimulationFailure,
  type SimulationResult,
  type SimulationTarget,
} from '../simulation'
import { DecisionPlanSchema } from '../evidence-contracts'
import {
  ContractVersion,
  type DecisionPlan,
  type EvaluationResult,
  type EvaluationSummary,
  type InputManifest,
  type Protocol,
} from '../types'
import { canonicalHashV1Result } from '../hash'
import { strictParseOptions } from '../schemas'
import type { StrategyApplication, StrategyDecisionFailure, TargetPortfolio } from './core'

export type StrategyEvaluationFailure<TFailure extends StrategyDecisionFailure> =
  | SimulationFailure
  | TFailure
  | SimulationReconciliationIssue

export interface StrategyEvaluationInput<
  TMarket,
  TFailure extends StrategyDecisionFailure,
  TTarget extends TargetPortfolio = TargetPortfolio,
> {
  readonly application: StrategyApplication<TMarket, TFailure, TTarget>
  readonly provenance: RuntimeProvenance
  readonly bars: readonly import('../types').DailyBar[]
  readonly inputManifest: InputManifest
}

export interface PreparedStrategyEvaluation {
  readonly runId: string
  readonly protocolHash: string
  readonly strategy: SimulationResult
  readonly buyAndHold: SimulationResult
  readonly directVolTiming: SimulationResult
  readonly doubleCost: SimulationResult
  readonly simulation: NonNullable<SimulationResult['simulation']>
}

const fail = <A = never, E = never>(failure: E): Result.Result<A, E> => Result.fail(failure)

const decisionPlanFromTarget = (target: TargetPortfolio): DecisionPlan | undefined => {
  const decoded = Schema.decodeUnknownResult(DecisionPlanSchema, strictParseOptions)(target)
  return Result.isSuccess(decoded) ? decoded.success : undefined
}

const strategyTargets = <TMarket, TFailure extends StrategyDecisionFailure, TTarget extends TargetPortfolio>(
  sessions: readonly AlignedSession[],
  signalIndices: readonly number[],
  application: StrategyApplication<TMarket, TFailure, TTarget>,
): Result.Result<readonly SimulationTarget[], SimulationFailure | TFailure> =>
  Result.all(
    signalIndices.map((signalIndex) =>
      pipe(
        application.contextAtSignal(sessions, signalIndex),
        Result.flatMap((context) => application.definition.decide(context)),
        Result.map(
          (target): SimulationTarget => ({
            signalIndex,
            executionIndex: signalIndex + 1,
            weights: target.targetWeights,
            decision: decisionPlanFromTarget(target),
            requireDecisionEvidence: decisionPlanFromTarget(target) === undefined ? false : undefined,
          }),
        ),
      ),
    ),
  )

const closeStrategyTarget = <TMarket, TFailure extends StrategyDecisionFailure, TTarget extends TargetPortfolio>(
  target: SimulationTarget,
  application: StrategyApplication<TMarket, TFailure, TTarget>,
): SimulationTarget => {
  const closedWeights =
    target.decision === undefined
      ? Object.fromEntries(Object.keys(target.weights).map((symbol) => [symbol, 0]))
      : application.closeTarget(target.decision as unknown as TTarget).targetWeights
  return {
    ...target,
    weights: closedWeights,
    decision: undefined,
    requireDecisionEvidence: false,
    terminalClose: true,
  }
}

const evaluationTargets = <TMarket, TFailure extends StrategyDecisionFailure, TTarget extends TargetPortfolio>(
  sessions: readonly AlignedSession[],
  window: { readonly signalIndices: readonly number[]; readonly startIndex: number },
  protocol: Protocol,
  application: StrategyApplication<TMarket, TFailure, TTarget>,
): Result.Result<
  {
    readonly strategy: readonly SimulationTarget[]
    readonly buyAndHold: readonly SimulationTarget[]
    readonly directVolatility: readonly SimulationTarget[]
  },
  SimulationFailure | TFailure
> =>
  pipe(
    Result.all({
      strategy: strategyTargets(sessions, window.signalIndices, application),
      equalWeight: roundWeight(1 / protocol.universe.length),
      directVolatility: Result.all(
        window.signalIndices.map((signalIndex) =>
          pipe(
            directVolatilityWeights(sessions, signalIndex, protocol),
            Result.map(
              (weights): SimulationTarget => ({
                signalIndex,
                executionIndex: signalIndex + 1,
                weights,
              }),
            ),
          ),
        ),
      ),
    }),
    Result.map(({ strategy, equalWeight, directVolatility }) => ({
      strategy,
      buyAndHold: [
        {
          signalIndex: window.startIndex - 1,
          executionIndex: window.startIndex,
          weights: Object.fromEntries(protocol.universe.map((symbol) => [symbol, equalWeight])),
        },
      ],
      directVolatility,
    })),
  )

const prepareStrategyEvaluation = <TMarket, TFailure extends StrategyDecisionFailure, TTarget extends TargetPortfolio>(
  input: StrategyEvaluationInput<TMarket, TFailure, TTarget>,
): Result.Result<PreparedStrategyEvaluation, SimulationFailure | TFailure> => {
  const protocol = input.application.definition.parameters
  return pipe(
    Result.all({
      identity: makeEvaluationIdentity(
        input.inputManifest,
        protocol,
        input.provenance,
        input.application.definition.name,
      ),
      sessions: alignBars(input.bars, protocol.universe, input.inputManifest),
    }),
    Result.flatMap(({ identity, sessions }) =>
      pipe(
        selectEvaluationWindow(
          sessions.map((session) => session.date),
          input.inputManifest,
          Math.max(protocol.volatilityWindow, ...protocol.horizons),
          protocol.thresholds.minimumObservations,
        ),
        Result.flatMap((window) =>
          pipe(
            evaluationTargets(sessions, window, protocol, input.application),
            Result.flatMap((targets) => {
              const evaluationSessions = sessions.slice(0, window.evaluationEndExclusive)
              return pipe(
                Result.all({
                  strategy: simulate(
                    evaluationSessions,
                    targets.strategy,
                    window.startIndex,
                    protocol,
                    MICROS,
                    identity.runId,
                    true,
                    (target, executionIndex) => closeStrategyTarget({ ...target, executionIndex }, input.application),
                  ),
                  buyAndHold: simulate(
                    evaluationSessions,
                    targets.buyAndHold,
                    window.startIndex,
                    protocol,
                    MICROS,
                    identity.runId,
                    false,
                    (target, executionIndex) => closeStrategyTarget({ ...target, executionIndex }, input.application),
                  ),
                  directVolTiming: simulate(
                    evaluationSessions,
                    targets.directVolatility,
                    window.startIndex,
                    protocol,
                    MICROS,
                    identity.runId,
                    false,
                    (target, executionIndex) => closeStrategyTarget({ ...target, executionIndex }, input.application),
                  ),
                  doubleCost: simulate(
                    evaluationSessions,
                    targets.strategy,
                    window.startIndex,
                    protocol,
                    BigInt(protocol.executionModel.doubleCostMultiplier) * MICROS,
                    identity.runId,
                    false,
                    (target, executionIndex) => closeStrategyTarget({ ...target, executionIndex }, input.application),
                  ),
                }),
                Result.flatMap((simulations) =>
                  simulations.strategy.simulation === null
                    ? fail<PreparedStrategyEvaluation, SimulationFailure | TFailure>({
                        _tag: 'SimulationTraceMissing',
                      })
                    : Result.succeed({
                        ...identity,
                        ...simulations,
                        simulation: simulations.strategy.simulation,
                      }),
                ),
              )
            }),
          ),
        ),
      ),
    ),
  )
}

export const evaluateStrategyApplication = <
  TMarket,
  TFailure extends StrategyDecisionFailure,
  TTarget extends TargetPortfolio,
>(
  input: StrategyEvaluationInput<TMarket, TFailure, TTarget>,
): Result.Result<EvaluationResult, readonly StrategyEvaluationFailure<TFailure>[]> => {
  const prepared = prepareStrategyEvaluation(input)
  if (Result.isFailure(prepared)) return Result.fail([prepared.failure])
  const { strategy, buyAndHold, directVolTiming, doubleCost } = prepared.success
  const markedEquity = reconcileMarkedEquity({
    runId: prepared.success.runId,
    initialCapitalMicros: input.application.definition.parameters.initialCapitalMicros,
    evaluatorTotalFeesMicros: strategy.metrics.totalFeesMicros,
    evaluatorEndingEquityMicros: strategy.metrics.endingEquityMicros,
    events: strategy.events,
    simulation: prepared.success.simulation,
  })
  if (Result.isFailure(markedEquity)) return Result.fail(markedEquity.failure)
  return Result.succeed({
    schemaVersion: ContractVersion.Evaluation,
    runId: prepared.success.runId,
    codeRevision: input.provenance.sourceRevision,
    protocolHash: prepared.success.protocolHash,
    initialCapitalMicros: input.application.definition.parameters.initialCapitalMicros,
    inputManifest: input.inputManifest,
    strategy: strategy.metrics,
    buyAndHold: buyAndHold.metrics,
    directVolTiming: directVolTiming.metrics,
    doubleCostStrategy: doubleCost.metrics,
    verdict: buildVerdict(
      strategy.metrics,
      buyAndHold.metrics,
      directVolTiming.metrics,
      doubleCost.metrics,
      input.application.definition.parameters,
    ),
    events: strategy.events,
    signalDecisions: strategy.signalDecisions,
    simulation: prepared.success.simulation,
    benchmarkSeries: {
      buyAndHold: buyAndHold.dailyPerformance,
      directVolTiming: directVolTiming.dailyPerformance,
      doubleCostStrategy: doubleCost.dailyPerformance,
    },
    equitySeries: markedEquity.success.equitySeries,
    markedEquityReconciliation: markedEquity.success.reconciliation,
  })
}

export const summarizeEvaluation = (evaluation: EvaluationResult): EvaluationSummary => ({
  schemaVersion: ContractVersion.EvaluationSummary,
  evaluationSchemaVersion: ContractVersion.Evaluation,
  runId: evaluation.runId,
  codeRevision: evaluation.codeRevision,
  protocolHash: evaluation.protocolHash,
  initialCapitalMicros: evaluation.initialCapitalMicros,
  input: {
    snapshotId: evaluation.inputManifest.finalizedSnapshot.snapshotId,
    publicationId: evaluation.inputManifest.finalizedSnapshot.publicationId,
    manifestHash: evaluation.inputManifest.hash,
    bounds: evaluation.inputManifest.bounds,
    rowCount: evaluation.inputManifest.rowCount,
    sessionCount: evaluation.inputManifest.sessionCount,
    symbols: evaluation.inputManifest.symbols.map((coverage) => coverage.symbol),
  },
  strategy: evaluation.strategy,
  buyAndHold: evaluation.buyAndHold,
  directVolTiming: evaluation.directVolTiming,
  doubleCostStrategy: evaluation.doubleCostStrategy,
  verdict: evaluation.verdict,
  eventCount: evaluation.events.length,
  signalDecisionCount: evaluation.signalDecisions.length,
  orderCount: evaluation.simulation.orders.length,
  cashChangeCount: evaluation.simulation.cashChanges.length,
  dailyMarkCount: evaluation.simulation.dailyMarks.length,
  benchmarkSeriesCounts: {
    buyAndHold: evaluation.benchmarkSeries.buyAndHold.length,
    directVolTiming: evaluation.benchmarkSeries.directVolTiming.length,
    doubleCostStrategy: evaluation.benchmarkSeries.doubleCostStrategy.length,
  },
  markedEquityReconciliation: evaluation.markedEquityReconciliation,
})

export const hashTargetPortfolio = (
  target: TargetPortfolio,
): Result.Result<string, import('../hash').CanonicalHashFailure> => canonicalHashV1Result(target)

export const hashTargetPortfolios = (
  targets: readonly TargetPortfolio[],
): Result.Result<string, import('../hash').CanonicalHashFailure> =>
  Result.all(targets.map(hashTargetPortfolio)).pipe(Result.flatMap((hashes) => canonicalHashV1Result(hashes)))

export const hashEvaluationTargets = (
  evaluation: EvaluationResult,
): Result.Result<string, import('../hash').CanonicalHashFailure> =>
  hashTargetPortfolios(evaluation.signalDecisions.map((decision) => ({ targetWeights: decision.targetWeights })))

export const hashStrategyEvaluation = (
  evaluation: EvaluationResult,
): Result.Result<string, import('../hash').CanonicalHashFailure> => canonicalHashV1Result(evaluation)
