import type { CandidateDevelopmentComparisonSemanticsEvidence } from './comparison'
import type { CandidateDevelopmentDoubledCostEvidence } from './doubled-cost'
import type { CandidateDevelopmentEvaluationDecision } from './evaluation'
import type { CandidateDevelopmentPreflightPass } from './preflight'
import { candidateDevelopmentComparisonSemantics, candidateDevelopmentDoubledCostContract } from './protocol'
import type { CandidateDevelopmentProtocolIdentity } from './attempt'

export interface CandidateDevelopmentReport {
  readonly schemaVersion: typeof candidateDevelopmentComparisonSemantics.evidence.reportSchemaVersion
  readonly protocolIdentity: CandidateDevelopmentProtocolIdentity
  readonly comparisonSemantics: CandidateDevelopmentComparisonSemanticsEvidence
  readonly doubledCostContract: typeof candidateDevelopmentDoubledCostContract
  readonly doubledCost: CandidateDevelopmentDoubledCostEvidence
}

export const buildCandidateDevelopmentReport = (
  preflight: CandidateDevelopmentPreflightPass,
  decision: CandidateDevelopmentEvaluationDecision,
): CandidateDevelopmentReport => ({
  schemaVersion: preflight.comparisonSemantics.evidence.reportSchemaVersion,
  protocolIdentity: preflight.protocolIdentity,
  comparisonSemantics: decision.comparisonSemantics,
  doubledCostContract: preflight.doubledCostContract,
  doubledCost: decision.doubledCost,
})
