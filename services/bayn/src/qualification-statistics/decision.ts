import type { QualificationAnalysis, QualificationStatisticsPolicy } from '../qualification-statistics'

type PowerAnalysis = QualificationAnalysis['power']
type BootstrapAnalysis = QualificationAnalysis['bootstrap']
type WalkForwardAnalysis = QualificationAnalysis['walkForward']
type QualificationGate = QualificationAnalysis['gates'][number]
type QualificationStatus = QualificationAnalysis['status']

export interface QualificationDecision {
  readonly gates: readonly QualificationGate[]
  readonly status: QualificationStatus
  readonly reasonCodes: readonly string[]
}

export interface QualificationDecisionInput {
  readonly policy: QualificationStatisticsPolicy
  readonly power: PowerAnalysis
  readonly bootstrap: BootstrapAnalysis
  readonly walkForward: WalkForwardAnalysis
}

export const buildQualificationGates = ({
  policy,
  power,
  bootstrap,
  walkForward,
}: QualificationDecisionInput): readonly QualificationGate[] => [
  {
    name: 'power',
    passed: power.sufficient,
    actual: `${power.availableCompleteRebalanceBlocks} blocks/${power.availableCompleteSessions} sessions`,
    required: `${power.requiredCompleteRebalanceBlocks} blocks/${power.requiredSessions} sessions`,
  },
  {
    name: 'bootstrap_tail_resolution',
    passed: bootstrap.tailResolutionSufficient,
    actual: bootstrap.tailSampleCount,
    required: bootstrap.minimumTailSamples,
  },
  {
    name: 'annualized_excess_return_lower_bound',
    passed: bootstrap.annualizedExcessReturnLowerBound > 0,
    actual: bootstrap.annualizedExcessReturnLowerBound,
    required: '>0',
  },
  {
    name: 'sharpe_difference_lower_bound',
    passed: bootstrap.sharpeDifferenceLowerBound > 0,
    actual: bootstrap.sharpeDifferenceLowerBound,
    required: '>0',
  },
  {
    name: 'walk_forward_folds',
    passed: walkForward.sufficient,
    actual: walkForward.folds.length,
    required: walkForward.requiredFolds,
  },
  {
    name: 'walk_forward_positive_fraction',
    passed: walkForward.sufficient && walkForward.positiveFoldFraction >= walkForward.requiredPositiveFoldFraction,
    actual: walkForward.positiveFoldFraction,
    required: `>=${walkForward.requiredPositiveFoldFraction}`,
  },
  {
    name: 'walk_forward_drawdown',
    passed: walkForward.sufficient && walkForward.allDrawdownsWithinLimit,
    actual: walkForward.maximumFoldDrawdown,
    required: `<=${policy.walkForward.maximumFoldDrawdown}`,
  },
]

export const decideQualification = (input: QualificationDecisionInput): QualificationDecision => {
  const { power, bootstrap, walkForward } = input
  const insufficientReasons = [
    ...(power.availableCompleteRebalanceBlocks < power.requiredCompleteRebalanceBlocks
      ? ['INSUFFICIENT_POWER_BLOCKS']
      : []),
    ...(power.availableCompleteSessions < power.requiredSessions ? ['INSUFFICIENT_POWER_SESSIONS'] : []),
    ...(!bootstrap.tailResolutionSufficient ? ['INSUFFICIENT_BOOTSTRAP_TAIL'] : []),
    ...(!walkForward.sufficient ? ['INSUFFICIENT_WALK_FORWARD_FOLDS'] : []),
  ]
  const rejectedReasons = [
    ...(bootstrap.annualizedExcessReturnLowerBound <= 0 ? ['NON_POSITIVE_EXCESS_RETURN_LCB'] : []),
    ...(bootstrap.sharpeDifferenceLowerBound <= 0 ? ['NON_POSITIVE_SHARPE_DIFFERENCE_LCB'] : []),
    ...(walkForward.sufficient && walkForward.positiveFoldFraction < walkForward.requiredPositiveFoldFraction
      ? ['WALK_FORWARD_POSITIVE_FRACTION_FAILED']
      : []),
    ...(walkForward.sufficient && !walkForward.allDrawdownsWithinLimit ? ['WALK_FORWARD_DRAWDOWN_FAILED'] : []),
  ]
  const status = insufficientReasons.length > 0 ? 'INSUFFICIENT' : rejectedReasons.length > 0 ? 'REJECTED' : 'PASS'
  return {
    gates: buildQualificationGates(input),
    status,
    reasonCodes: status === 'INSUFFICIENT' ? insufficientReasons : rejectedReasons,
  }
}
