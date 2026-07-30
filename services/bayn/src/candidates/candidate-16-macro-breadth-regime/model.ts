import {
  candidateDevelopmentStatisticsPolicy,
  type CandidateDevelopmentPreflightPass,
} from '../../candidate-development'
import { frozenCandidateDevelopmentSessions } from '../../candidate-development-calendar'
import { defaultExecutionModel } from '../../execution-model'
import type { CanonicalHashFailure } from '../../hash'
import type { FinalizedSnapshotProvenance } from '../../contracts'
import type { AlignedSession, SimulationFailure, SimulationResult, SimulationTarget } from '../../simulation'
import type { DecisionPlan, EvaluationResult, IsoDate, SimulationProtocol, SimulationTrace } from '../../types'

export const CANDIDATE_16_ORDINAL = 16 as const
export const CANDIDATE_16_PRIOR_TRIAL_COUNT = 15 as const
export const CANDIDATE_16_STRATEGY_NAME = 'macro-breadth-regime-rotation' as const
export const CANDIDATE_16_STRATEGY_VERSION = '1.0.0' as const
export const CANDIDATE_16_DEVELOPMENT_START = '2016-01-04' as const
export const CANDIDATE_16_DEVELOPMENT_END = '2022-12-30' as const
export const CANDIDATE_16_HOLDOUT_START = '2023-01-03' as const
export const CANDIDATE_16_HOLDOUT_END = '2025-12-31' as const
export const CANDIDATE_16_SNAPSHOT_ID = '2a91f0177684f7022f746207333e510c8268f9b77a04b778a04220a33ccf79e0'
export const CANDIDATE_16_PREREGISTRATION_SHA256 = '76d913aafbc880bf54f777a17680e1c6c82697a2c2e52842cfc7a9053f265318'
export const CANDIDATE_16_PREREGISTRATION_COMMIT = 'e1bf3c906a5fa8a697ebc566f83eb1bbe6cb6dc3'

export const candidate16Universe = ['DBC', 'EFA', 'IEF', 'SPY', 'VNQ'] as const
export type Candidate16Symbol = (typeof candidate16Universe)[number]
export type Candidate16State = 'GROWTH' | 'INFLATION_DEFENSE' | 'DEFLATION_DEFENSE'

export const candidate16Specification = {
  id: 'breadth-2of3-spy-positive-dbc-over-ief-126-gross95',
  lookbackSessions: 126,
  grossExposure: 0.95,
  requiredPositiveRiskSleeves: 2,
} as const

export const candidate16Protocol = {
  schemaVersion: 'bayn.macro-breadth-regime.protocol.v1',
  candidateOrdinal: CANDIDATE_16_ORDINAL,
  priorTrialCount: CANDIDATE_16_PRIOR_TRIAL_COUNT,
  strategyName: CANDIDATE_16_STRATEGY_NAME,
  strategyVersion: CANDIDATE_16_STRATEGY_VERSION,
  universe: candidate16Universe,
  dataValidity: {
    requirePositiveAdjustedOhlc: true,
    requirePositiveVolume: true,
  },
  feature: {
    name: 'macro-breadth-and-defense-total-return' as const,
    declaredLookbackSessions: candidate16Specification.lookbackSessions,
    closeCount: candidate16Specification.lookbackSessions + 1,
    return: 'adjusted-close-simple-total-return-rounded-to-12-decimals' as const,
    riskSleeves: ['SPY', 'EFA', 'VNQ'] as const,
    defenseSleeves: ['DBC', 'IEF'] as const,
  },
  classification: {
    growth: 'at-least-two-risk-sleeves-positive-and-spy-positive' as const,
    inflationDefense: 'growth-false-and-dbc-return-strictly-greater-than-ief-return' as const,
    deflationDefense: 'otherwise-including-dbc-ief-tie' as const,
  },
  allocation: {
    growthSymbol: 'SPY' as const,
    inflationDefenseSymbol: 'DBC' as const,
    deflationDefenseSymbol: 'IEF' as const,
    selectedWeight: candidate16Specification.grossExposure,
    cashReserveWeight: 1 - candidate16Specification.grossExposure,
    maximumPositionCount: 1,
  },
  schedule: {
    signal: 'canonical-official-month-end-finalized-close' as const,
    execution: 'next-official-session-open' as const,
    terminalSignalDate: '2022-11-30' as const,
    terminalExecutionDate: '2022-12-01' as const,
    terminalAction: 'all-cash-through-development-end' as const,
  },
  selection: {
    specifications: [candidate16Specification],
    maximumSpecifications: 1,
    precedingAttempts: CANDIDATE_16_PRIOR_TRIAL_COUNT,
    familyOneSidedAlpha: candidateDevelopmentStatisticsPolicy.confidence.familyOneSidedAlpha,
    selectionMultiplicity: 1,
  },
} as const

export const candidate16BehaviorMaterial = {
  schemaVersion: 'bayn.macro-breadth-regime.behavior.v1',
  input: '127-adjusted-closes-ending-at-each-finalized-month-end-for-dbc-efa-ief-spy-vnq',
  feature: '126-session-total-return-breadth-plus-dbc-versus-ief-defense-comparison',
  growth: 'two-of-three-positive-risk-sleeves-and-positive-spy',
  inflationDefense: 'non-growth-and-dbc-strictly-outreturns-ief',
  deflationDefense: 'all-other-states-including-defense-tie',
  allocation: '95-percent-one-selected-sleeve-and-5-percent-cash',
  schedule: 'official-month-end-finalized-close-to-next-session-open',
  terminal: '2022-11-30-signal-liquidates-at-2022-12-01-open-and-remains-cash',
  excludedSignals: 'correlation-covariance-ranking-volume-volatility-seasonality-intraday-residual-optimization',
  missingData: 'fail-closed-no-imputation',
  doubledCost: 'fixed-baseline-signal-and-ordered-requested-filled-quantity-path-repriced-at-two-times-cost',
} as const

export const candidate16StrategyProtocolMaterial = {
  schemaVersion: 'bayn.candidate-strategy-protocol.v1',
  name: CANDIDATE_16_STRATEGY_NAME,
  version: CANDIDATE_16_STRATEGY_VERSION,
  parameters: candidate16Protocol,
  behavior: candidate16BehaviorMaterial,
} as const

export const CANDIDATE_16_STRATEGY_PROTOCOL_HASH = '74f933da46e64d172b52f4a3d5553cd96358a396da1822ad239786a3eb9c69af'

export const candidate16SimulationProtocol: SimulationProtocol = {
  universe: candidate16Universe,
  directVolatilityTarget: 0.1,
  initialCapitalMicros: '1000000000000',
  executionModel: defaultExecutionModel,
  thresholds: {
    minimumObservations: 504,
    minimumAnnualizedReturn: 0,
    minimumSharpeImprovement: 0,
    maximumDrawdown: 0.35,
    maximumAnnualTurnover: 12,
    requirePositiveDoubleCostReturn: true,
  },
}

export const candidate16PriorAttemptIds = [
  '300feda2b9815e05575b6bc9bb9d8dd633b446a88fc04f1335c31be934b6ad47',
  '36ff96549ce78538a9503840a373a4b04049761cf0f8b30467f084078de3185c',
  '440f5d079247f42c52f31111345c18bfa694263cef052dfb9a32b2b1c8f20861',
  '70763f839afd9359a34ea70dd833bf7a6fb1553aad98921b8f25282851fcf773',
  '7a521052ff039376267eb16f222023edf5d72f308af380c71f2d50da6e6a1b32',
  '87c0dac69efcfa7bdedb5bbcffe26f7ee9a14de8c05baea613f488eb869a305f',
  '8d0d63f4a709797658002b89d4cf5c6f755e479085c6275ee2464d6e174661be',
  '8e19c7466efa706ef37ed135525f4f420ecbbce02f70d10f04678e77ff3d51bc',
  '9c495c857a67659a56ca9381ff03d6839cf1812abbf70c73bc75de372bcaf118',
  'a6530496d594a5425f091f30148012b12b6b030d49b396f925efe9ead3496217',
  'a673b246253836ab95a1836e10efeb8315c0978cebda8dbf00d8767c60d399eb',
  'b38d784ce8124bbbff7513a9f8c94ec6ac4d51d7c01bf5c369bcfe3bc5aa2183',
  'b88f53887a31b6696f5bf6b56e4e10d9966057c6109a1d0721dc94677e566ec7',
  'bf19a5d8b29032146effeadca2bf129924c9062dd5b516a0483927207c333cfc',
  'cc3ec71d86e90308697c7ca58598d0b7cef50553fcc9d4576159da6c42e7b066',
] as const

export const candidate16DevelopmentSessions = frozenCandidateDevelopmentSessions

export interface Candidate16Bar {
  readonly symbol: Candidate16Symbol
  readonly sessionDate: IsoDate
  readonly open: number
  readonly high: number
  readonly low: number
  readonly close: number
  readonly volume: number
}

export interface Candidate16Dataset {
  readonly snapshotId: string
  readonly finalizedSnapshot: FinalizedSnapshotProvenance
  readonly sessions: readonly IsoDate[]
  readonly bars: readonly Candidate16Bar[]
  readonly sessionsContentHash: string
  readonly barsContentHash: string
}

export interface Candidate16Registration {
  readonly preregistrationHash: typeof CANDIDATE_16_PREREGISTRATION_SHA256
  readonly preregistrationCommit: typeof CANDIDATE_16_PREREGISTRATION_COMMIT
  readonly evaluatedCommit: string
}

export interface Candidate16Feature {
  readonly windowStart: IsoDate
  readonly windowEnd: IsoDate
  readonly totalReturns: Readonly<Record<Candidate16Symbol, number>>
  readonly positiveRiskSleeves: number
  readonly state: Candidate16State
  readonly selectedSymbol: 'DBC' | 'IEF' | 'SPY'
}

export interface Candidate16Plan {
  readonly targets: readonly SimulationTarget[]
  readonly rebalanceExecutionDates: readonly IsoDate[]
  readonly simulationStartIndex: number
  readonly evaluationStartIndex: number
}

export interface Candidate16SignalDecision {
  readonly signalDate: IsoDate
  readonly executionDate: IsoDate
  readonly feature: Candidate16Feature
  readonly weights: Readonly<Record<Candidate16Symbol, number>>
  readonly decisionPlan: DecisionPlan
}

export interface Candidate16PreparedData {
  readonly dataset: Candidate16Dataset
  readonly sessions: readonly AlignedSession[]
}

export interface Candidate16CostReplay {
  readonly result: Omit<SimulationResult, 'simulation'> & { readonly simulation: SimulationTrace }
  readonly terminalCash: boolean
}

export interface Candidate16DevelopmentEvaluation {
  readonly baseline: EvaluationResult
  readonly comparisonSemantics: import('../../candidate-development').CandidateDevelopmentComparisonSemanticsEvidence
  readonly stressed: import('../../candidate-development').CandidateDevelopmentDoubledCostRun
}

export type Candidate16Failure =
  | { readonly _tag: 'Candidate16InvalidInput'; readonly operation: string; readonly reason: string }
  | { readonly _tag: 'Candidate16HashFailure'; readonly operation: string; readonly cause: CanonicalHashFailure }
  | { readonly _tag: 'Candidate16SimulationFailure'; readonly simulation: string; readonly cause: SimulationFailure }
  | { readonly _tag: 'Candidate16QualificationFailure'; readonly cause: unknown }
  | {
      readonly _tag: 'Candidate16DoubledCostReplayInvalid'
      readonly disposition: 'INVALID_PROTOCOL_DEVIATION'
      readonly reason: string
    }
  | { readonly _tag: 'Candidate16IoFailure'; readonly operation: string; readonly cause: unknown }

export interface Candidate16EvaluationContext {
  readonly registration: Candidate16Registration
  readonly dataset: Candidate16Dataset
  readonly preflight: CandidateDevelopmentPreflightPass
}
