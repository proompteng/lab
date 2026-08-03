import { pipe, Result } from 'effect'

import type { RuntimeProvenance } from '../../contracts'
import { makeEvaluationIdentity, selectEvaluationWindow } from '../../simulation'
import type { InputManifest, IsoDate, Protocol } from '../../types'
import type { QualificationPrecommit, RiskBalancedTrendFailure } from '../../risk-balanced-trend/model'
import { requiredHistory } from './shared'

const fail = <A = never>(failure: RiskBalancedTrendFailure): Result.Result<A, RiskBalancedTrendFailure> =>
  Result.fail(failure)

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
