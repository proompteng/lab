import { Result } from 'effect'

import type { RuntimeProvenance } from '../contracts'
import type { DailyBar, InputManifest, Protocol } from '../types'
import { evaluateStrategyApplication } from '../strategy/evaluation-runner'
import { makeRiskBalancedTrendApplication } from '../strategy/risk-balanced-trend/application'
import {
  makeRiskBalancedTrendDefinition,
  type RiskBalancedTrendStrategyDefinition,
} from '../strategy/risk-balanced-trend/decision'
import type { RiskBalancedTrendEvaluation } from './model'
import { parseMatchingManifest } from './schema'

export { compileCurrentRiskBalancedTrendDecision } from '../strategy/risk-balanced-trend/current-decision'
export { prepareRiskBalancedTrendQualification } from '../strategy/risk-balanced-trend/qualification-precommit'

export const evaluateRiskBalancedTrend = (
  bars: readonly DailyBar[],
  inputManifest: InputManifest,
  protocol: Protocol,
  provenance: RuntimeProvenance,
  definition: RiskBalancedTrendStrategyDefinition = makeRiskBalancedTrendDefinition(protocol),
): RiskBalancedTrendEvaluation => {
  const verifiedManifest = parseMatchingManifest(inputManifest, protocol)
  if (Result.isFailure(verifiedManifest)) return Result.fail([verifiedManifest.failure])
  return evaluateStrategyApplication({
    application: makeRiskBalancedTrendApplication(protocol, definition),
    provenance,
    bars,
    inputManifest: verifiedManifest.success,
  })
}

/** @deprecated Historical callers should use the generic evaluator summary. */
export { summarizeEvaluation } from '../strategy/evaluation-runner'
