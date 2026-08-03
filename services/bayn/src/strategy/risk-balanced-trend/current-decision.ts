import { pipe, Result } from 'effect'

import { referencePriceMicros } from '../../execution-model'
import { alignBars, requiredRecordValue, requiredSession, type AlignedSession } from '../../simulation'
import type { DailyBar, InputManifest, Protocol } from '../../types'
import {
  decisionFromAlignedSessions,
  makeRiskBalancedTrendDefinition,
  type RiskBalancedTrendStrategyDefinition,
} from './decision'
import type {
  CurrentDecisionCycleBinding,
  CurrentRiskBalancedTrendDecisionResult,
  RiskBalancedTrendFailure,
} from '../../risk-balanced-trend/model'
import { decodeCurrentDecisionCycleBinding } from '../../risk-balanced-trend/schema'

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
