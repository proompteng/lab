import { pipe, Result } from 'effect'

import type { RuntimeProvenance } from '../contracts'
import { referencePriceMicros } from '../execution-model'
import {
  alignBars,
  makeEvaluationIdentity,
  selectEvaluationWindow,
  type AlignedSession,
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
import { evaluateStrategyDefinition } from '../strategy/evaluation-runner'
import {
  makeRiskBalancedTrendDefinition,
  riskBalancedTrendContextAtSignal,
  type RiskBalancedTrendStrategyDefinition,
} from '../strategy/risk-balanced-trend'
import {
  type CurrentDecisionCycleBinding,
  type CurrentRiskBalancedTrendDecisionResult,
  type QualificationPrecommit,
  type RiskBalancedTrendEvaluation,
  type RiskBalancedTrendFailure,
} from './model'
import { decodeCurrentDecisionCycleBinding, parseMatchingManifest } from './schema'

const fail = <A = never>(failure: RiskBalancedTrendFailure): Result.Result<A, RiskBalancedTrendFailure> =>
  Result.fail(failure)

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
  definition: RiskBalancedTrendStrategyDefinition = makeRiskBalancedTrendDefinition(protocol),
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
                  decision: decisionFromAlignedSessions(sessions, sessions.length - 1, protocol, definition),
                  priceMicros: terminalPrices(terminalSession, protocol),
                }),
                Result.flatMap(({ decision, priceMicros }) => {
                  const observedSymbols = Object.keys(priceMicros)
                  return decision.signalDate === terminalSession.date &&
                    observedSymbols.length === protocol.universe.length &&
                    protocol.universe.every((symbol) => {
                      const price = priceMicros[symbol]
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

export const evaluateRiskBalancedTrend = (
  bars: readonly DailyBar[],
  inputManifest: InputManifest,
  protocol: Protocol,
  provenance: RuntimeProvenance,
  definition: RiskBalancedTrendStrategyDefinition = makeRiskBalancedTrendDefinition(protocol),
): RiskBalancedTrendEvaluation => {
  const verifiedManifest = parseMatchingManifest(inputManifest, protocol)
  if (Result.isFailure(verifiedManifest)) return Result.fail([verifiedManifest.failure])
  return evaluateStrategyDefinition({
    definition,
    provenance,
    bars,
    inputManifest: verifiedManifest.success,
    contextAtSignal: (sessions, signalIndex) => riskBalancedTrendContextAtSignal(sessions, signalIndex, protocol),
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
