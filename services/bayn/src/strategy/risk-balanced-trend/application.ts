import { pipe, Result } from 'effect'

import type { RuntimeProvenance } from '../../contracts'
import type { MarketDataInspection } from '../../market-data'
import { prepareRiskBalancedTrendQualificationLock } from './qualification'
import { compileCurrentRiskBalancedTrendDecision } from './current-decision'
import { parseMatchingManifest } from '../../risk-balanced-trend/schema'
import type { CurrentDecisionCycleBinding, RiskBalancedTrendFailure } from '../../risk-balanced-trend/model'
import type { StrategyApplication, StrategyApplicationFailure } from '../core'
import {
  makeRiskBalancedTrendDefinition,
  riskBalancedTrendContextAtSignal,
  type RiskBalancedTrendStrategyDefinition,
} from './decision'
import { Pipeable } from '../../pipeable'

export type RiskBalancedTrendStrategyApplication = StrategyApplication<
  import('./decision').RiskBalancedTrendMarketContext,
  RiskBalancedTrendFailure,
  import('./decision').RiskBalancedTrendTargetPortfolio
>

const applicationFailure = (
  operation: StrategyApplicationFailure['operation'],
  cause: unknown,
): StrategyApplicationFailure => ({ _tag: 'StrategyApplicationFailure', operation, cause })

const makeRiskBalancedTrendApplicationDataFirst = (
  protocol: import('../../types').Protocol,
  suppliedDefinition?: RiskBalancedTrendStrategyDefinition,
): RiskBalancedTrendStrategyApplication => {
  const definition: RiskBalancedTrendStrategyDefinition =
    suppliedDefinition ?? makeRiskBalancedTrendDefinition(protocol)
  return {
    definition,
    closeTarget: (target) => ({
      ...target,
      exposureScale: 0,
      targetWeights: Object.fromEntries(protocol.universe.map((symbol) => [symbol, 0])),
      signals: target.signals.map((signal) => ({
        ...signal,
        eligible: false,
        uncappedWeight: 0,
        cappedWeight: 0,
        targetWeight: 0,
      })),
    }),
    contextAtSignal: (sessions, signalIndex) => riskBalancedTrendContextAtSignal(sessions, signalIndex, protocol),
    parseManifest: (input) =>
      parseMatchingManifest(input, protocol).pipe(Result.mapError((cause) => applicationFailure('manifest', cause))),
    prepareQualificationLock: (
      inspection: MarketDataInspection,
      provenance: RuntimeProvenance,
      priorTrialRunIds: readonly string[],
    ) =>
      pipe(
        parseMatchingManifest(inspection.manifest, protocol),
        Result.flatMap((manifest) =>
          prepareRiskBalancedTrendQualificationLock(
            manifest,
            inspection.sessionDates,
            priorTrialRunIds,
            protocol,
            provenance,
          ),
        ),
        Result.mapError((cause) => applicationFailure('qualification-lock', cause)),
      ),
    evaluateCurrentDecision: (bars, inputManifest, cycleBinding) =>
      pipe(
        compileCurrentRiskBalancedTrendDecision(
          bars,
          inputManifest,
          protocol,
          cycleBinding as CurrentDecisionCycleBinding,
          definition,
        ),
        Result.map(({ decision, priceMicros }) => ({ decision, priceMicros, signalDate: decision.signalDate })),
        Result.mapError((cause) => applicationFailure('current-decision', cause)),
      ),
  }
}

export const makeRiskBalancedTrendApplication = Pipeable.by<
  (
    suppliedDefinition?: RiskBalancedTrendStrategyDefinition,
  ) => (protocol: import('../../types').Protocol) => ReturnType<typeof makeRiskBalancedTrendApplicationDataFirst>,
  typeof makeRiskBalancedTrendApplicationDataFirst
>(
  (arguments_) => typeof arguments_[0] === 'object' && arguments_[0] !== null && 'schemaVersion' in arguments_[0],
  makeRiskBalancedTrendApplicationDataFirst,
)
