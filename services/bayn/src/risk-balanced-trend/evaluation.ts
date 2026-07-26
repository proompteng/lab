import { pipe, Result } from 'effect'

import type { RuntimeProvenance } from '../contracts'
import { MICROS, referencePriceMicros } from '../execution-model'
import { reconcileMarkedEquity } from '../simulation-reconciliation'
import {
  alignBars,
  buildVerdict,
  directVolatilityWeights,
  makeEvaluationIdentity,
  roundWeight,
  selectEvaluationWindow,
  simulate,
  type AlignedSession,
  type SimulationTarget,
  requiredRecordValue,
  requiredSession,
} from '../simulation'
import {
  ContractVersion,
  type DailyBar,
  type EvaluationResult,
  type EvaluationSummary,
  type InputManifest,
  type IsoDate,
  type Protocol,
} from '../types'
import { decisionFromAlignedSessions, requiredHistory } from './decisions'
import {
  type CurrentDecisionCycleBinding,
  type CurrentRiskBalancedTrendDecisionResult,
  type PreparedEvaluation,
  type QualificationPrecommit,
  type RiskBalancedTrendEvaluation,
  type RiskBalancedTrendEvaluationIssue,
  type RiskBalancedTrendFailure,
} from './model'
import { decodeCurrentDecisionCycleBinding } from './schema'

const fail = <A = never>(failure: RiskBalancedTrendFailure): Result.Result<A, RiskBalancedTrendFailure> =>
  Result.fail(failure)

const failEvaluation = <A = never>(
  issues: readonly RiskBalancedTrendEvaluationIssue[],
): Result.Result<A, readonly RiskBalancedTrendEvaluationIssue[]> => Result.fail(issues)

const singleIssue = (failure: RiskBalancedTrendEvaluationIssue): readonly RiskBalancedTrendEvaluationIssue[] =>
  Object.freeze([failure])

const terminalPrices = (
  session: AlignedSession,
  protocol: Protocol,
): Result.Result<Readonly<Record<string, string>>, RiskBalancedTrendFailure> =>
  pipe(
    Result.all(
      protocol.universe.map((symbol) =>
        pipe(
          requiredRecordValue(session.bars, symbol, 'bar', session.date),
          Result.flatMap((bar) => referencePriceMicros(bar.close, protocol.executionModel)),
          Result.map((price) => [symbol, price.toString()] as const),
        ),
      ),
    ),
    Result.map((prices) => Object.fromEntries(prices)),
  )

export const compileCurrentRiskBalancedTrendDecision = (
  bars: readonly DailyBar[],
  inputManifest: InputManifest,
  protocol: Protocol,
  cycleBinding: CurrentDecisionCycleBinding,
): CurrentRiskBalancedTrendDecisionResult =>
  pipe(
    decodeCurrentDecisionCycleBinding(cycleBinding),
    Result.flatMap((binding) =>
      pipe(
        alignBars(bars, protocol.universe, inputManifest),
        Result.flatMap((sessions) =>
          pipe(
            requiredSession(sessions, sessions.length - 1, 'signal-decision'),
            Result.flatMap((terminalSession) => {
              if (
                terminalSession.date !== inputManifest.finalizedSnapshot.lastSession ||
                terminalSession.date !== inputManifest.lastSession ||
                terminalSession.date !== binding.signal.sessionDate
              ) {
                return fail({
                  _tag: 'CurrentDecisionSessionMismatch',
                  manifestSession: inputManifest.lastSession,
                  snapshotSession: inputManifest.finalizedSnapshot.lastSession,
                  bindingSession: binding.signal.sessionDate,
                  observedSession: terminalSession.date,
                })
              }
              if (
                protocol.rebalance === 'month-end' &&
                binding.signal.sessionDate.slice(0, 7) === binding.executionSession.date.slice(0, 7)
              ) {
                return fail({
                  _tag: 'CurrentDecisionNotMonthEnd',
                  signalSession: binding.signal.sessionDate,
                  executionSession: binding.executionSession.date,
                })
              }
              return pipe(
                Result.all({
                  decision: decisionFromAlignedSessions(sessions, sessions.length - 1, protocol),
                  priceMicros: terminalPrices(terminalSession, protocol),
                }),
                Result.flatMap(({ decision, priceMicros }) => {
                  const observedSymbols = Object.keys(priceMicros)
                  return decision.signalDate === terminalSession.date &&
                    observedSymbols.length === protocol.universe.length &&
                    protocol.universe.every((symbol) => {
                      const price = Reflect.get(priceMicros, symbol)
                      return typeof price === 'string' && /^[1-9][0-9]*$/.test(price)
                    })
                    ? Result.succeed({ decision, priceMicros })
                    : fail({
                        _tag: 'CurrentDecisionCoverageMismatch',
                        signalDate: decision.signalDate,
                        expectedSymbols: protocol.universe,
                        observedSymbols,
                      })
                }),
              )
            }),
          ),
        ),
      ),
    ),
  )

export const prepareRiskBalancedTrendQualification = (
  sessionDates: readonly IsoDate[],
  inputManifest: InputManifest,
  protocol: Protocol,
  provenance: RuntimeProvenance,
): Result.Result<QualificationPrecommit, RiskBalancedTrendFailure> =>
  pipe(
    Result.all({
      identity: makeEvaluationIdentity(inputManifest, protocol, provenance),
      window: selectEvaluationWindow(
        sessionDates,
        inputManifest,
        requiredHistory(protocol),
        protocol.thresholds.minimumObservations,
      ),
    }),
    Result.flatMap(({ identity, window }) =>
      pipe(
        Result.all({
          signalDates: Result.all(
            window.signalIndices.map((index) => {
              const date = sessionDates.at(index)
              return date === undefined
                ? fail({
                    _tag: 'MissingSession',
                    operation: 'qualification-window',
                    index,
                    sessionCount: sessionDates.length,
                  })
                : Result.succeed(date)
            }),
          ),
          executionDates: Result.all(
            window.signalIndices.map((index) => {
              const date = sessionDates.at(index + 1)
              return date === undefined
                ? fail({
                    _tag: 'MissingSession',
                    operation: 'qualification-window',
                    index: index + 1,
                    sessionCount: sessionDates.length,
                  })
                : Result.succeed(date)
            }),
          ),
        }),
        Result.map(({ signalDates, executionDates }) => ({
          candidateRunId: identity.runId,
          protocolHash: identity.protocolHash,
          selectedSessionCount: window.evaluationEndExclusive - window.startIndex,
          selectedRebalanceCount: window.signalIndices.length,
          signalDates,
          executionDates,
        })),
      ),
    ),
  )

interface EvaluationTargets {
  readonly strategy: readonly SimulationTarget[]
  readonly buyAndHold: readonly SimulationTarget[]
  readonly directVolatility: readonly SimulationTarget[]
}

const evaluationTargets = (
  sessions: readonly AlignedSession[],
  window: { readonly signalIndices: readonly number[]; readonly startIndex: number },
  protocol: Protocol,
): Result.Result<EvaluationTargets, RiskBalancedTrendFailure> =>
  pipe(
    Result.all({
      strategy: Result.all(
        window.signalIndices.map((signalIndex) =>
          pipe(
            decisionFromAlignedSessions(sessions, signalIndex, protocol),
            Result.map(
              (decision): SimulationTarget => ({
                signalIndex,
                executionIndex: signalIndex + 1,
                weights: decision.targetWeights,
                decision,
              }),
            ),
          ),
        ),
      ),
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

const ensureCandidateTrace = (result: {
  readonly strategy: PreparedEvaluation['strategy']
  readonly buyAndHold: PreparedEvaluation['buyAndHold']
  readonly directVolTiming: PreparedEvaluation['directVolTiming']
  readonly doubleCost: PreparedEvaluation['doubleCost']
}): Result.Result<PreparedEvaluation['simulation'], RiskBalancedTrendFailure> =>
  result.strategy.simulation === null
    ? fail({ _tag: 'CandidateSimulationTraceMissing' })
    : Result.succeed(result.strategy.simulation)

const ensureSignalDecisions = (
  decisions: PreparedEvaluation['strategy']['signalDecisions'],
): Result.Result<PreparedEvaluation['signalDecisions'], RiskBalancedTrendFailure> =>
  pipe(
    Result.all(
      decisions.map((decision) =>
        decision.schemaVersion === ContractVersion.DecisionPlan
          ? Result.succeed(decision)
          : fail({
              _tag: 'DecisionSchemaMismatch',
              observed: decision.schemaVersion,
              expected: ContractVersion.DecisionPlan,
            }),
      ),
    ),
    Result.map((values) => values),
  )

const prepareEvaluation = (
  bars: readonly DailyBar[],
  inputManifest: InputManifest,
  protocol: Protocol,
  provenance: RuntimeProvenance,
): Result.Result<PreparedEvaluation, RiskBalancedTrendFailure> =>
  pipe(
    Result.all({
      identity: makeEvaluationIdentity(inputManifest, protocol, provenance),
      sessions: alignBars(bars, protocol.universe, inputManifest),
    }),
    Result.flatMap(({ identity, sessions }) =>
      pipe(
        selectEvaluationWindow(
          sessions.map((session) => session.date),
          inputManifest,
          requiredHistory(protocol),
          protocol.thresholds.minimumObservations,
        ),
        Result.flatMap((window) =>
          pipe(
            evaluationTargets(sessions, window, protocol),
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
                  ),
                  buyAndHold: simulate(
                    evaluationSessions,
                    targets.buyAndHold,
                    window.startIndex,
                    protocol,
                    MICROS,
                    identity.runId,
                    false,
                  ),
                  directVolTiming: simulate(
                    evaluationSessions,
                    targets.directVolatility,
                    window.startIndex,
                    protocol,
                    MICROS,
                    identity.runId,
                    false,
                  ),
                  doubleCost: simulate(
                    evaluationSessions,
                    targets.strategy,
                    window.startIndex,
                    protocol,
                    BigInt(protocol.executionModel.doubleCostMultiplier) * MICROS,
                    identity.runId,
                    false,
                  ),
                }),
                Result.flatMap((simulations) =>
                  pipe(
                    Result.all({
                      signalDecisions: ensureSignalDecisions(simulations.strategy.signalDecisions),
                      simulation: ensureCandidateTrace(simulations),
                    }),
                    Result.map(({ signalDecisions, simulation }) => ({
                      ...identity,
                      ...simulations,
                      simulation,
                      signalDecisions,
                    })),
                  ),
                ),
              )
            }),
          ),
        ),
      ),
    ),
  )

export const evaluateRiskBalancedTrend = (
  bars: readonly DailyBar[],
  inputManifest: InputManifest,
  protocol: Protocol,
  provenance: RuntimeProvenance,
): RiskBalancedTrendEvaluation => {
  const prepared = prepareEvaluation(bars, inputManifest, protocol, provenance)
  if (Result.isFailure(prepared)) return failEvaluation(singleIssue(prepared.failure))
  const markedEquity = reconcileMarkedEquity({
    runId: prepared.success.runId,
    initialCapitalMicros: protocol.initialCapitalMicros,
    evaluatorTotalFeesMicros: prepared.success.strategy.metrics.totalFeesMicros,
    evaluatorEndingEquityMicros: prepared.success.strategy.metrics.endingEquityMicros,
    events: prepared.success.strategy.events,
    simulation: prepared.success.simulation,
  })
  if (Result.isFailure(markedEquity)) return failEvaluation(markedEquity.failure)
  return Result.succeed({
    schemaVersion: ContractVersion.Evaluation,
    runId: prepared.success.runId,
    codeRevision: provenance.sourceRevision,
    protocolHash: prepared.success.protocolHash,
    initialCapitalMicros: protocol.initialCapitalMicros,
    inputManifest,
    strategy: prepared.success.strategy.metrics,
    buyAndHold: prepared.success.buyAndHold.metrics,
    directVolTiming: prepared.success.directVolTiming.metrics,
    doubleCostStrategy: prepared.success.doubleCost.metrics,
    verdict: buildVerdict(
      prepared.success.strategy.metrics,
      prepared.success.buyAndHold.metrics,
      prepared.success.directVolTiming.metrics,
      prepared.success.doubleCost.metrics,
      protocol,
    ),
    events: prepared.success.strategy.events,
    signalDecisions: prepared.success.signalDecisions,
    simulation: prepared.success.simulation,
    benchmarkSeries: {
      buyAndHold: prepared.success.buyAndHold.dailyPerformance,
      directVolTiming: prepared.success.directVolTiming.dailyPerformance,
      doubleCostStrategy: prepared.success.doubleCost.dailyPerformance,
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
