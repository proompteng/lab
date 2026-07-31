import { candidateDevelopmentComparisonSemantics, candidateDevelopmentStatisticsPolicy } from './candidate-development'
import type { QualificationSelectedBenchmarkComparisonAnalysis } from './qualification-statistics'

export interface CandidateDevelopmentNextPreregistration {
  readonly schemaVersion: 'bayn.candidate-development-next-preregistration.v1'
  readonly candidateOrdinal: number
  readonly priorTrialCount: number
  readonly strategyProtocolHash: string
  readonly modulePath: string
  readonly moduleSha256: string
  readonly marketData: {
    readonly schemaVersion: 'bayn.candidate-development-market-data-source.v1'
    readonly snapshotId: string
    readonly finalizedSnapshotContentHash: string
    readonly inputManifestHash: string
    readonly boundedContentHash: string
  }
  readonly preregistration: {
    readonly sourceRevision: string
    readonly path: string
    readonly blobOid: string
  }
}

export type CandidateDevelopmentGateName =
  | (typeof candidateDevelopmentComparisonSemantics.gates)[keyof typeof candidateDevelopmentComparisonSemantics.gates]['name']
  | 'double_cost_return'
  | 'economic_verdict'
  | 'baseline_terminal_cash'
  | 'stressed_terminal_cash'

export interface CandidateDevelopmentGate {
  readonly name: CandidateDevelopmentGateName
  readonly passed: boolean
  readonly actual: number | boolean
  readonly required: number | boolean
}

export interface CandidateDevelopmentDecision {
  readonly status: 'PASS' | 'HOLD_REJECT'
  readonly selectedBenchmark: 'buy-and-hold' | 'direct-volatility-timing'
  readonly gates: readonly CandidateDevelopmentGate[]
}

export interface CandidateDevelopmentDecisionEvidence {
  readonly comparison: QualificationSelectedBenchmarkComparisonAnalysis
  readonly doubledCostAnnualizedReturn: number
  readonly economicPass: boolean
  readonly baselineTerminalCash: boolean
  readonly stressedTerminalCash: boolean
}

export const deriveCandidateDevelopmentDecision = (
  evidence: CandidateDevelopmentDecisionEvidence,
): CandidateDevelopmentDecision => {
  const { bootstrap, power, walkForward } = evidence.comparison
  const protocolGates = candidateDevelopmentComparisonSemantics.gates
  const gates: readonly CandidateDevelopmentGate[] = [
    {
      name: protocolGates.power.name,
      passed: power.sufficient,
      actual: power.sufficient,
      required: true,
    },
    {
      name: protocolGates.bootstrapTailResolution.name,
      passed: bootstrap.tailResolutionSufficient,
      actual: bootstrap.tailSampleCount,
      required: bootstrap.minimumTailSamples,
    },
    {
      name: protocolGates.annualizedExcessReturnLowerBound.name,
      passed: bootstrap.annualizedReturnDifferenceLowerBound > 0,
      actual: bootstrap.annualizedReturnDifferenceLowerBound,
      required: 0,
    },
    {
      name: protocolGates.sharpeDifferenceLowerBound.name,
      passed: bootstrap.sharpeDifferenceLowerBound > 0,
      actual: bootstrap.sharpeDifferenceLowerBound,
      required: 0,
    },
    {
      name: protocolGates.walkForwardFolds.name,
      passed: walkForward.sufficient,
      actual: walkForward.folds.length,
      required: walkForward.requiredFolds,
    },
    {
      name: protocolGates.walkForwardPositiveFraction.name,
      passed: walkForward.positiveFoldFraction >= walkForward.requiredPositiveFoldFraction,
      actual: walkForward.positiveFoldFraction,
      required: walkForward.requiredPositiveFoldFraction,
    },
    {
      name: protocolGates.walkForwardDrawdown.name,
      passed: walkForward.allDrawdownsWithinLimit,
      actual: walkForward.maximumFoldDrawdown,
      required: candidateDevelopmentStatisticsPolicy.walkForward.maximumFoldDrawdown,
    },
    {
      name: 'double_cost_return',
      passed: evidence.doubledCostAnnualizedReturn > 0,
      actual: evidence.doubledCostAnnualizedReturn,
      required: 0,
    },
    {
      name: 'economic_verdict',
      passed: evidence.economicPass,
      actual: evidence.economicPass,
      required: true,
    },
    {
      name: 'baseline_terminal_cash',
      passed: evidence.baselineTerminalCash,
      actual: evidence.baselineTerminalCash,
      required: true,
    },
    {
      name: 'stressed_terminal_cash',
      passed: evidence.stressedTerminalCash,
      actual: evidence.stressedTerminalCash,
      required: true,
    },
  ]
  return {
    status: gates.every((gate) => gate.passed) ? 'PASS' : 'HOLD_REJECT',
    selectedBenchmark: bootstrap.selectedBenchmark,
    gates,
  }
}
