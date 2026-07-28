import { Result } from 'effect'

import { canonicalHashV1Result, type CanonicalHashFailure } from '../hash'
import {
  CANDIDATE_6_ORDINAL,
  CANDIDATE_6_STRATEGY_NAME,
  CANDIDATE_6_STRATEGY_VERSION,
  candidate6Protocol,
  type Candidate6Protocol,
} from './model'
import {
  CANDIDATE_6_DEVELOPMENT_DATA_START,
  CANDIDATE_6_DEVELOPMENT_END,
  CANDIDATE_6_DEVELOPMENT_SIMULATION_START,
  CANDIDATE_6_HOLDOUT_START,
} from './research'

export const CANDIDATE_6_QUALIFICATION_END = '2025-12-31' as const

export interface CandidateTerminalLineage {
  readonly candidateOrdinal: number
  readonly runId: string
  readonly resultHash: string
  readonly verdict: 'QUALIFIED' | 'REJECTED'
}

export const candidate6PriorTerminalLineage = [
  {
    candidateOrdinal: 1,
    runId: 'b88f53887a31b6696f5bf6b56e4e10d9966057c6109a1d0721dc94677e566ec7',
    resultHash: '4623f5fc94bf9e41935b80c5c07161376d3bb0e0583ef2c546f20ba116be1b78',
    verdict: 'REJECTED',
  },
  {
    candidateOrdinal: 2,
    runId: '87c0dac69efcfa7bdedb5bbcffe26f7ee9a14de8c05baea613f488eb869a305f',
    resultHash: 'da3f914ae5ea3bf8be8bb08b4b3488b5dfbd04464045f7add8b3d7550c000bf4',
    verdict: 'REJECTED',
  },
  {
    candidateOrdinal: 3,
    runId: '7a521052ff039376267eb16f222023edf5d72f308af380c71f2d50da6e6a1b32',
    resultHash: '269489af861a0cf20bf2af1f0bc66263d6dc9f46704b5a3c139f15e5f798e6e7',
    verdict: 'REJECTED',
  },
  {
    candidateOrdinal: 4,
    runId: '440f5d079247f42c52f31111345c18bfa694263cef052dfb9a32b2b1c8f20861',
    resultHash: 'f175f99877485d8090eb7e61c7e300fecba7e49ea86001122a916ff42d0564eb',
    verdict: 'REJECTED',
  },
  {
    candidateOrdinal: 5,
    runId: 'a6530496d594a5425f091f30148012b12b6b030d49b396f925efe9ead3496217',
    resultHash: 'a603d712a8d948af7e7de42165b9e81c9a3b42a4ebd38b45753e69755d94cc75',
    verdict: 'REJECTED',
  },
] as const satisfies readonly CandidateTerminalLineage[]

export interface Candidate6PreregistrationMaterial {
  readonly schemaVersion: 'bayn.candidate-preregistration.v1'
  readonly candidateOrdinal: 6
  readonly identity: {
    readonly strategyName: typeof CANDIDATE_6_STRATEGY_NAME
    readonly strategyVersion: typeof CANDIDATE_6_STRATEGY_VERSION
    readonly parameterHash: string
    readonly strategyHash: string
  }
  readonly lineage: {
    readonly priorTerminalCandidates: readonly CandidateTerminalLineage[]
    readonly candidate5MustRemainTerminalRejected: true
  }
  readonly hypothesis: {
    readonly economicMechanism: 'institutional-month-end-liquidity-and-rebalancing-pressure-reversal'
    readonly distinctFromCandidate5: 'calendar-conditioned-short-horizon-reversal-not-time-series-trend'
    readonly expectedDirection: 'long-after-negative-pressure-otherwise-cash'
  }
  readonly data: {
    readonly universeId: 'cross-asset-taa-v1'
    readonly tradableUniverse: readonly ['SPY']
    readonly developmentDataStart: typeof CANDIDATE_6_DEVELOPMENT_DATA_START
    readonly developmentSimulationStart: typeof CANDIDATE_6_DEVELOPMENT_SIMULATION_START
    readonly developmentEnd: typeof CANDIDATE_6_DEVELOPMENT_END
    readonly qualificationStart: typeof CANDIDATE_6_HOLDOUT_START
    readonly qualificationEnd: typeof CANDIDATE_6_QUALIFICATION_END
    readonly requiredPublicationAsOf: typeof CANDIDATE_6_QUALIFICATION_END
    readonly adjustedDailyBarsOnly: true
    readonly provider: 'alpaca'
    readonly sourceFeed: 'sip'
    readonly corporateActionAdjustment: 'all'
    readonly noPostDevelopmentInspectionBeforeSeal: true
    readonly settlementRegimes: {
      readonly preTPlusOne: readonly ['2023-01-03', '2024-05-24']
      readonly excludedTransition: readonly ['2024-05-28', '2024-06-28']
      readonly postTPlusOne: readonly ['2024-07-01', '2025-12-31']
    }
  }
  readonly features: {
    readonly pressureReturn: 'adjusted-close[T-4]/adjusted-close[T-9]-1'
    readonly monthEndPosition: 'official-session-calendar-count'
    readonly liquidity: '20-session-average-adjusted-close-times-adjusted-volume'
    readonly featureAvailability: 'finalized-T-4-close-only'
    readonly missingDataPolicy: 'fail-closed-no-imputation'
  }
  readonly decisions: {
    readonly entrySignalSession: 'T-4'
    readonly entryExecutionSession: 'T-3-next-open'
    readonly exitSignalSession: 'T+3'
    readonly exitExecutionSession: 'T+4-next-open'
    readonly expectedReversionFraction: number
    readonly requiredPressureReturn: number
    readonly targetWeight: number
    readonly cashOtherwise: true
  }
  readonly benchmark: {
    readonly name: 'spy-buy-and-hold'
    readonly construction: 'buy-SPY-at-first-qualification-session-open-and-hold-through-final-close'
    readonly alignment: 'same-qualification-sessions'
    readonly costModel: 'zero-cost-conservative-upper-bound'
    readonly comparison: 'candidate-net-sharpe-minus-benchmark-net-sharpe'
    readonly cashReturn: 0
  }
  readonly execution: Candidate6Protocol['execution']
  readonly limits: Candidate6Protocol['sizing'] & {
    readonly longOnly: true
    readonly leverageAllowed: false
    readonly shortingAllowed: false
  }
  readonly statisticalGates: {
    readonly minimumObservations: 504
    readonly minimumAnnualizedNetReturnExclusive: 0
    readonly minimumPointSharpeImprovementExclusive: 0
    readonly minimumSharpeImprovementLowerConfidenceBoundExclusive: 0
    readonly maximumDrawdownInclusive: 0.35
    readonly maximumAnnualTurnoverInclusive: 12
    readonly minimumDoubleCostReturnExclusive: 0
    readonly familyOneSidedAlpha: 0.05
    readonly bootstrapReplicates: 5_000
    readonly bootstrapUnit: 'complete-month-end-event-block'
    readonly settlementRegimeGate: {
      readonly minimumCompleteEventsPerRegime: 12
      readonly requirePositiveNetReturnInEachRegime: true
    }
  }
  readonly walkForward: {
    readonly protocol: 'three-frozen-calendar-year-folds'
    readonly folds: readonly [
      readonly ['2023-01-03', '2023-12-29'],
      readonly ['2024-01-02', '2024-12-31'],
      readonly ['2025-01-02', '2025-12-31'],
    ]
    readonly minimumPositiveNetFolds: 2
    readonly noParameterUpdatesBetweenFolds: true
  }
  readonly exclusions: readonly [
    'no-post-2022-development-data',
    'no-intraday-bars',
    'no-short-sales',
    'no-options',
    'no-leverage',
    'no-corporate-action-imputation',
    'no-missing-bar-imputation',
    'no-holdout-tuning',
  ]
  readonly trialSemantics: {
    readonly officialTrialsPerIdentity: 1
    readonly terminalRejectionMayNotBeRetried: true
    readonly terminalQualificationMayNotBeRetried: true
    readonly liveCapitalEnabled: false
    readonly brokerMutationEnabled: false
  }
}

export interface Candidate6Preregistration extends Candidate6PreregistrationMaterial {
  readonly preregistrationHash: string
}

export type Candidate6PreregistrationFailure =
  | {
      readonly _tag: 'PreregistrationHashFailure'
      readonly operation: 'parameters' | 'strategy' | 'seal'
      readonly cause: CanonicalHashFailure
    }
  | { readonly _tag: 'CandidateOrdinalMismatch'; readonly observed: number }
  | { readonly _tag: 'PriorTerminalLineageMismatch' }
  | { readonly _tag: 'Candidate5MutationAttempt' }
  | { readonly _tag: 'PreregistrationIdentityMismatch'; readonly observed: string }
  | { readonly _tag: 'Candidate6AlreadyTrialed'; readonly trialIdentity: string }

type PreregistrationResult<A> = Result.Result<A, Candidate6PreregistrationFailure>

const fail = <A>(failure: Candidate6PreregistrationFailure): PreregistrationResult<A> => Result.fail(failure)

const requiredPressureReturn = (protocol: Candidate6Protocol): number => {
  const oneWayCostBps = protocol.execution.halfSpreadBps + protocol.execution.slippageBps
  const bufferedRoundTripCost = ((2 * oneWayCostBps) / 10_000) * protocol.execution.costBufferMultiplier
  return -(bufferedRoundTripCost / protocol.signal.expectedReversionFraction)
}

export const makeCandidate6PreregistrationMaterial = (
  protocol: Candidate6Protocol = candidate6Protocol,
): PreregistrationResult<Candidate6PreregistrationMaterial> => {
  const parameterHash = canonicalHashV1Result(protocol)
  if (Result.isFailure(parameterHash)) {
    return fail({ _tag: 'PreregistrationHashFailure', operation: 'parameters', cause: parameterHash.failure })
  }
  const strategyMaterial = {
    schemaVersion: 'bayn.month-end-liquidity-reversal.behavior.v1',
    strategyName: CANDIDATE_6_STRATEGY_NAME,
    strategyVersion: CANDIDATE_6_STRATEGY_VERSION,
    signal: 'five-session-adjusted-close-pressure-at-T-minus-4',
    entry: 'next-open-T-minus-3-after-cost-aware-negative-pressure',
    exit: 'next-open-T-plus-4-after-holding-through-T-plus-3',
    sizing: 'long-cash-fixed-target-with-liquidity-and-exposure-caps',
    malformedData: 'fail-closed',
    parameterHash: parameterHash.success,
  } as const
  const strategyHash = canonicalHashV1Result(strategyMaterial)
  if (Result.isFailure(strategyHash)) {
    return fail({ _tag: 'PreregistrationHashFailure', operation: 'strategy', cause: strategyHash.failure })
  }
  return Result.succeed({
    schemaVersion: 'bayn.candidate-preregistration.v1',
    candidateOrdinal: CANDIDATE_6_ORDINAL,
    identity: {
      strategyName: CANDIDATE_6_STRATEGY_NAME,
      strategyVersion: CANDIDATE_6_STRATEGY_VERSION,
      parameterHash: parameterHash.success,
      strategyHash: strategyHash.success,
    },
    lineage: {
      priorTerminalCandidates: candidate6PriorTerminalLineage,
      candidate5MustRemainTerminalRejected: true,
    },
    hypothesis: {
      economicMechanism: 'institutional-month-end-liquidity-and-rebalancing-pressure-reversal',
      distinctFromCandidate5: 'calendar-conditioned-short-horizon-reversal-not-time-series-trend',
      expectedDirection: 'long-after-negative-pressure-otherwise-cash',
    },
    data: {
      universeId: 'cross-asset-taa-v1',
      tradableUniverse: ['SPY'],
      developmentDataStart: CANDIDATE_6_DEVELOPMENT_DATA_START,
      developmentSimulationStart: CANDIDATE_6_DEVELOPMENT_SIMULATION_START,
      developmentEnd: CANDIDATE_6_DEVELOPMENT_END,
      qualificationStart: CANDIDATE_6_HOLDOUT_START,
      qualificationEnd: CANDIDATE_6_QUALIFICATION_END,
      requiredPublicationAsOf: CANDIDATE_6_QUALIFICATION_END,
      adjustedDailyBarsOnly: true,
      provider: 'alpaca',
      sourceFeed: 'sip',
      corporateActionAdjustment: 'all',
      noPostDevelopmentInspectionBeforeSeal: true,
      settlementRegimes: {
        preTPlusOne: ['2023-01-03', '2024-05-24'],
        excludedTransition: ['2024-05-28', '2024-06-28'],
        postTPlusOne: ['2024-07-01', '2025-12-31'],
      },
    },
    features: {
      pressureReturn: 'adjusted-close[T-4]/adjusted-close[T-9]-1',
      monthEndPosition: 'official-session-calendar-count',
      liquidity: '20-session-average-adjusted-close-times-adjusted-volume',
      featureAvailability: 'finalized-T-4-close-only',
      missingDataPolicy: 'fail-closed-no-imputation',
    },
    decisions: {
      entrySignalSession: 'T-4',
      entryExecutionSession: 'T-3-next-open',
      exitSignalSession: 'T+3',
      exitExecutionSession: 'T+4-next-open',
      expectedReversionFraction: protocol.signal.expectedReversionFraction,
      requiredPressureReturn: requiredPressureReturn(protocol),
      targetWeight: protocol.sizing.targetWeight,
      cashOtherwise: true,
    },
    benchmark: {
      name: 'spy-buy-and-hold',
      construction: 'buy-SPY-at-first-qualification-session-open-and-hold-through-final-close',
      alignment: 'same-qualification-sessions',
      costModel: 'zero-cost-conservative-upper-bound',
      comparison: 'candidate-net-sharpe-minus-benchmark-net-sharpe',
      cashReturn: 0,
    },
    execution: protocol.execution,
    limits: {
      ...protocol.sizing,
      longOnly: true,
      leverageAllowed: false,
      shortingAllowed: false,
    },
    statisticalGates: {
      minimumObservations: 504,
      minimumAnnualizedNetReturnExclusive: 0,
      minimumPointSharpeImprovementExclusive: 0,
      minimumSharpeImprovementLowerConfidenceBoundExclusive: 0,
      maximumDrawdownInclusive: 0.35,
      maximumAnnualTurnoverInclusive: 12,
      minimumDoubleCostReturnExclusive: 0,
      familyOneSidedAlpha: 0.05,
      bootstrapReplicates: 5_000,
      bootstrapUnit: 'complete-month-end-event-block',
      settlementRegimeGate: {
        minimumCompleteEventsPerRegime: 12,
        requirePositiveNetReturnInEachRegime: true,
      },
    },
    walkForward: {
      protocol: 'three-frozen-calendar-year-folds',
      folds: [
        ['2023-01-03', '2023-12-29'],
        ['2024-01-02', '2024-12-31'],
        ['2025-01-02', '2025-12-31'],
      ],
      minimumPositiveNetFolds: 2,
      noParameterUpdatesBetweenFolds: true,
    },
    exclusions: [
      'no-post-2022-development-data',
      'no-intraday-bars',
      'no-short-sales',
      'no-options',
      'no-leverage',
      'no-corporate-action-imputation',
      'no-missing-bar-imputation',
      'no-holdout-tuning',
    ],
    trialSemantics: {
      officialTrialsPerIdentity: 1,
      terminalRejectionMayNotBeRetried: true,
      terminalQualificationMayNotBeRetried: true,
      liveCapitalEnabled: false,
      brokerMutationEnabled: false,
    },
  })
}

export const sealCandidate6Preregistration = (
  material: Candidate6PreregistrationMaterial,
): PreregistrationResult<Candidate6Preregistration> => {
  const hash = canonicalHashV1Result(material)
  return Result.isFailure(hash)
    ? fail({ _tag: 'PreregistrationHashFailure', operation: 'seal', cause: hash.failure })
    : Result.succeed({ ...material, preregistrationHash: hash.success })
}

export const makeSealedCandidate6Preregistration = (
  protocol: Candidate6Protocol = candidate6Protocol,
): PreregistrationResult<Candidate6Preregistration> => {
  const material = makeCandidate6PreregistrationMaterial(protocol)
  return Result.isFailure(material) ? fail(material.failure) : sealCandidate6Preregistration(material.success)
}

export interface Candidate6TrialAdmissionInput {
  readonly candidateOrdinal: number
  readonly preregistrationHash: string
  readonly priorTerminalCandidates: readonly CandidateTerminalLineage[]
  readonly existingTrialIdentities: readonly string[]
}

export interface Candidate6TrialAdmission {
  readonly schemaVersion: 'bayn.candidate-6-trial-admission.v1'
  readonly candidateOrdinal: 6
  readonly preregistrationHash: string
  readonly trialIdentity: string
  readonly maximumOfficialTrials: 1
}

export const admitCandidate6Trial = (
  input: Candidate6TrialAdmissionInput,
): PreregistrationResult<Candidate6TrialAdmission> => {
  if (input.candidateOrdinal !== CANDIDATE_6_ORDINAL) {
    return fail({ _tag: 'CandidateOrdinalMismatch', observed: input.candidateOrdinal })
  }
  const sealed = makeSealedCandidate6Preregistration()
  if (Result.isFailure(sealed)) return fail(sealed.failure)
  if (input.preregistrationHash !== sealed.success.preregistrationHash) {
    return fail({ _tag: 'PreregistrationIdentityMismatch', observed: input.preregistrationHash })
  }
  const expectedLineageHash = canonicalHashV1Result(candidate6PriorTerminalLineage)
  const observedLineageHash = canonicalHashV1Result(input.priorTerminalCandidates)
  if (Result.isFailure(expectedLineageHash) || Result.isFailure(observedLineageHash)) {
    return fail({ _tag: 'PriorTerminalLineageMismatch' })
  }
  if (observedLineageHash.success !== expectedLineageHash.success) {
    const candidate5 = input.priorTerminalCandidates.find((candidate) => candidate.candidateOrdinal === 5)
    return candidate5 === undefined ||
      candidate5.runId !== candidate6PriorTerminalLineage[4].runId ||
      candidate5.resultHash !== candidate6PriorTerminalLineage[4].resultHash ||
      candidate5.verdict !== 'REJECTED'
      ? fail({ _tag: 'Candidate5MutationAttempt' })
      : fail({ _tag: 'PriorTerminalLineageMismatch' })
  }
  const trialIdentityResult = canonicalHashV1Result({
    schemaVersion: 'bayn.candidate-6-trial-identity.v1',
    candidateOrdinal: CANDIDATE_6_ORDINAL,
    preregistrationHash: input.preregistrationHash,
  })
  if (Result.isFailure(trialIdentityResult)) {
    return fail({ _tag: 'PreregistrationHashFailure', operation: 'seal', cause: trialIdentityResult.failure })
  }
  if (input.existingTrialIdentities.includes(trialIdentityResult.success)) {
    return fail({ _tag: 'Candidate6AlreadyTrialed', trialIdentity: trialIdentityResult.success })
  }
  return Result.succeed({
    schemaVersion: 'bayn.candidate-6-trial-admission.v1',
    candidateOrdinal: CANDIDATE_6_ORDINAL,
    preregistrationHash: input.preregistrationHash,
    trialIdentity: trialIdentityResult.success,
    maximumOfficialTrials: 1,
  })
}
