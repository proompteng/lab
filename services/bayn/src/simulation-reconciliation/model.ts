import { Result } from 'effect'

import type { ExecutionModelFailure } from '../execution-model'
import type { CanonicalJsonFailure } from '../hash'
import type {
  CashYieldEvent,
  EquityPoint,
  EvaluationEvent,
  FeeEvent,
  FillEvent,
  MarkedEquityReconciliation,
  SimulatedOrder,
  SimulationTrace,
} from '../types'

export { MARKED_EQUITY_TOLERANCE_MICROS } from './constants'

export type UnsignedIntegerEvidence =
  | {
      readonly kind: 'input'
      readonly field: 'evaluatorEndingEquityMicros' | 'evaluatorTotalFeesMicros' | 'initialCapitalMicros'
      readonly value: string
    }
  | {
      readonly kind: 'order'
      readonly orderId: string
      readonly field: 'filledQuantityMicros' | 'requestedQuantityMicros'
      readonly value: string
    }
  | {
      readonly kind: 'fill'
      readonly fillId: string
      readonly field:
        | 'costBasisMicros'
        | 'notionalMicros'
        | 'priceMicros'
        | 'quantityMicros'
        | 'referencePriceMicros'
        | 'slippageCostMicros'
        | 'spreadCostMicros'
      readonly value: string
    }
  | {
      readonly kind: 'fee'
      readonly feeId: string
      readonly field: 'catMicros' | 'commissionMicros' | 'secMicros' | 'tafMicros' | 'totalMicros'
      readonly value: string
    }
  | {
      readonly kind: 'cash-yield'
      readonly cashYieldId: string
      readonly field: 'amountMicros'
      readonly value: string
    }
  | {
      readonly kind: 'daily-mark'
      readonly sessionDate: string
      readonly field:
        | 'cashMicros'
        | 'cashYieldMicros'
        | 'cumulativeCashYieldMicros'
        | 'cumulativeFeesMicros'
        | 'cumulativeSlippageCostMicros'
        | 'cumulativeSpreadCostMicros'
        | 'cumulativeTurnoverMicros'
        | 'equityMicros'
        | 'feeMicros'
        | 'slippageCostMicros'
        | 'spreadCostMicros'
        | 'turnoverMicros'
      readonly value: string
    }
  | {
      readonly kind: 'position'
      readonly sessionDate: string
      readonly symbol: string
      readonly field: 'costBasisMicros' | 'marketValueMicros' | 'priceMicros' | 'quantityMicros'
      readonly value: string
    }

export type PositiveUnsignedIntegerEvidence = {
  readonly kind: 'simulation'
  readonly field: 'costMultiplierMicros'
  readonly value: string
}

export type SignedIntegerEvidence = {
  readonly kind: 'cash-change'
  readonly cashChangeId: string
  readonly field: 'amountMicros' | 'cashAfterMicros'
  readonly value: string
}

export type RunIdentityEvidence = { readonly kind: 'run'; readonly id: string }

export type CanonicalIdentityEvidence =
  | { readonly kind: 'decision'; readonly id: string; readonly signalDate: string }
  | { readonly kind: 'order'; readonly id: string; readonly sessionDate: string }
  | { readonly kind: 'fill'; readonly id: string; readonly sessionDate: string }
  | { readonly kind: 'fee'; readonly id: string; readonly sessionDate: string }
  | { readonly kind: 'cash-yield'; readonly id: string; readonly sessionDate: string }
  | { readonly kind: 'cash-change'; readonly id: string; readonly sourceId: string; readonly sessionDate: string }

export type IdentityEvidence = RunIdentityEvidence | CanonicalIdentityEvidence

export type InvalidIdentityIssue =
  | {
      readonly _tag: 'InvalidIdentity'
      readonly evidence: RunIdentityEvidence
      readonly problem: { readonly _tag: 'InvalidFormat'; readonly expected: 'lowercase-sha256' }
    }
  | {
      readonly _tag: 'InvalidIdentity'
      readonly evidence: CanonicalIdentityEvidence
      readonly problem:
        | { readonly _tag: 'InvalidFormat'; readonly expected: 'lowercase-sha256' }
        | { readonly _tag: 'HashMismatch'; readonly expected: string }
        | { readonly _tag: 'CanonicalizationFailed'; readonly cause: CanonicalJsonFailure }
    }

export type CanonicalIdentityProblem =
  | { readonly _tag: 'HashMismatch'; readonly expected: string }
  | { readonly _tag: 'CanonicalizationFailed'; readonly cause: CanonicalJsonFailure }

export type MissingReferenceProblem =
  | { readonly _tag: 'OrderDecision'; readonly orderId: string; readonly decisionId: string }
  | { readonly _tag: 'FillOrder'; readonly fillId: string; readonly orderId: string }
  | {
      readonly _tag: 'MonetaryEventCashChange'
      readonly eventId: string
      readonly eventKind: FillEvent['kind'] | FeeEvent['kind'] | CashYieldEvent['kind']
    }
  | {
      readonly _tag: 'ValidatedMonetaryEvent'
      readonly eventId: string
      readonly eventKind: FillEvent['kind'] | FeeEvent['kind']
    }

export type EvidenceMismatchProblem =
  | {
      readonly _tag: 'OrderExecutionSession'
      readonly orderId: string
      readonly decisionId: string
      readonly actualSessionDate: string
      readonly expectedSessionDate: string
    }
  | {
      readonly _tag: 'FillBinding'
      readonly fillId: string
      readonly orderId: string
      readonly field: 'decisionId' | 'sessionDate' | 'side' | 'symbol'
      readonly actual: string
      readonly expected: string
    }
  | {
      readonly _tag: 'FillQuantity'
      readonly fillId: string
      readonly orderId: string
      readonly actualQuantityMicros: string
      readonly expectedQuantityMicros: string
    }
  | {
      readonly _tag: 'FillTerms'
      readonly fillId: string
      readonly field: 'notionalMicros' | 'priceMicros' | 'slippageCostMicros' | 'spreadCostMicros'
      readonly actualMicros: string
      readonly expectedMicros: string
    }
  | {
      readonly _tag: 'FeeComponents'
      readonly feeId: string
      readonly actualTotalMicros: string
      readonly expectedTotalMicros: string
    }
  | {
      readonly _tag: 'FeeSchedule'
      readonly feeId: string
      readonly field: 'catMicros' | 'commissionMicros' | 'secMicros' | 'tafMicros' | 'totalMicros'
      readonly actualMicros: string
      readonly expectedMicros: string
    }
  | {
      readonly _tag: 'CashChange'
      readonly cashChangeId: string
      readonly sourceId: string
      readonly field: 'amountMicros' | 'cashAfterMicros' | 'sessionDate' | 'sourceKind'
      readonly actual: string
      readonly expected: string
    }
  | {
      readonly _tag: 'CashYield'
      readonly cashYieldId: string
      readonly field: 'amountMicros' | 'annualYieldBps'
      readonly actual: string
      readonly expected: string
    }
  | {
      readonly _tag: 'DailyMark'
      readonly sessionDate: string
      readonly field:
        | 'cashYieldMicros'
        | 'cumulativeCashYieldMicros'
        | 'cumulativeFeesMicros'
        | 'cumulativeSlippageCostMicros'
        | 'cumulativeSpreadCostMicros'
        | 'cumulativeTurnoverMicros'
        | 'feeMicros'
        | 'slippageCostMicros'
        | 'spreadCostMicros'
        | 'turnoverMicros'
      readonly actualMicros: string
      readonly expectedMicros: string
    }
  | {
      readonly _tag: 'PositionMark'
      readonly sessionDate: string
      readonly symbol: string
      readonly field: 'marketValueMicros' | 'quantityMicros'
      readonly actualMicros: string
      readonly expectedMicros: string
    }

export type InvalidEvidenceStateProblem =
  | {
      readonly _tag: 'DuplicateIdentity'
      readonly entity: 'cash-change' | 'cash-yield' | 'decision' | 'fee' | 'fill' | 'order'
      readonly id: string
    }
  | { readonly _tag: 'DuplicateFillForOrder'; readonly orderId: string; readonly secondFillId: string }
  | { readonly _tag: 'DuplicateCashChangeForEvent'; readonly eventId: string; readonly secondCashChangeId: string }
  | {
      readonly _tag: 'InvalidOrder'
      readonly rule: 'fill-presence' | 'filled-not-over-requested' | 'status-consistency'
      readonly orderId: string
      readonly status: SimulatedOrder['status']
      readonly requestedQuantityMicros: string
      readonly filledQuantityMicros: string
      readonly rejectionReason: SimulatedOrder['rejectionReason']
      readonly unfilledRemainder: SimulatedOrder['unfilledRemainder']
      readonly fillPresent: boolean
    }
  | {
      readonly _tag: 'InvalidMarkOrder'
      readonly previousSessionDate: string
      readonly sessionDate: string
    }
  | { readonly _tag: 'DuplicateMarkedPosition'; readonly sessionDate: string; readonly symbols: readonly string[] }
  | { readonly _tag: 'UnsortedMarkedPositions'; readonly sessionDate: string; readonly symbols: readonly string[] }
  | {
      readonly _tag: 'NegativeCash'
      readonly eventId: string
      readonly actualMicros: string
      readonly minimumMicros: string
    }
  | {
      readonly _tag: 'NegativeLongPosition'
      readonly fillId: string
      readonly symbol: string
      readonly actualQuantityMicros: string
    }
  | {
      readonly _tag: 'DailyOutsideTolerance'
      readonly measure: 'daily-cash' | 'daily-equity'
      readonly sessionDate: string
      readonly differenceMicros: string
      readonly toleranceMicros: string
    }
  | {
      readonly _tag: 'FinalOutsideTolerance'
      readonly measure: 'final-equity' | 'final-fees'
      readonly differenceMicros: string
      readonly toleranceMicros: string
    }
  | { readonly _tag: 'NegativeTolerance'; readonly toleranceMicros: string }
  | {
      readonly _tag: 'UnsupportedSimulationSchema'
      readonly actual: string
      readonly expected: 'bayn.simulation-trace.v3'
    }

export type IncompleteEvidenceProblem =
  | { readonly _tag: 'EmptyDailyMarks' }
  | {
      readonly _tag: 'CashChangeCountMismatch'
      readonly cashChangeCount: number
      readonly monetaryEventCount: number
    }
  | {
      readonly _tag: 'MissingSessionMark'
      readonly eventId: string
      readonly eventSessionDate: string
      readonly nextMarkSessionDate: string
    }
  | {
      readonly _tag: 'MissingOpenPositionMark'
      readonly sessionDate: string
      readonly symbol: string
      readonly quantityMicros: string
    }
  | {
      readonly _tag: 'MonetaryEventsAfterFinalMark'
      readonly firstEventId: string
      readonly firstEventSessionDate: string
    }

export type FailedComputation =
  | {
      readonly _tag: 'FillTerms'
      readonly fillId: string
      readonly side: FillEvent['side']
      readonly quantityMicros: string
      readonly referencePriceMicros: string
      readonly costMultiplierMicros: string
    }
  | {
      readonly _tag: 'FeeSchedule'
      readonly feeId: string
      readonly fillCount: number
      readonly costMultiplierMicros: string
    }
  | {
      readonly _tag: 'CashYield'
      readonly cashYieldId: string
      readonly cashMicros: string
      readonly elapsedDays: number
      readonly annualYieldBps: number
    }
  | {
      readonly _tag: 'PositionNotional'
      readonly sessionDate: string
      readonly symbol: string
      readonly quantityMicros: string
      readonly priceMicros: string
    }

export type InvalidIntegerIssue =
  | {
      readonly _tag: 'InvalidInteger'
      readonly expected: 'unsigned-integer'
      readonly evidence: UnsignedIntegerEvidence
    }
  | {
      readonly _tag: 'InvalidInteger'
      readonly expected: 'positive-unsigned-integer'
      readonly evidence: PositiveUnsignedIntegerEvidence
    }
  | {
      readonly _tag: 'InvalidInteger'
      readonly expected: 'signed-integer'
      readonly evidence: SignedIntegerEvidence
    }

export type SimulationReconciliationIssue =
  | InvalidIntegerIssue
  | InvalidIdentityIssue
  | { readonly _tag: 'MissingReference'; readonly problem: MissingReferenceProblem }
  | { readonly _tag: 'EvidenceMismatch'; readonly problem: EvidenceMismatchProblem }
  | { readonly _tag: 'InvalidEvidenceState'; readonly problem: InvalidEvidenceStateProblem }
  | { readonly _tag: 'IncompleteEvidence'; readonly problem: IncompleteEvidenceProblem }
  | {
      readonly _tag: 'ComputationFailed'
      readonly computation: FailedComputation
      readonly cause: ExecutionModelFailure
    }

export interface MarkedEquityReconciliationInput {
  readonly runId: string
  readonly initialCapitalMicros: string
  readonly evaluatorTotalFeesMicros: string
  readonly evaluatorEndingEquityMicros: string
  readonly events: readonly EvaluationEvent[]
  readonly simulation: SimulationTrace
  readonly toleranceMicros?: bigint
}

export interface MarkedEquityProof {
  readonly reconciliation: MarkedEquityReconciliation
  readonly equitySeries: readonly EquityPoint[]
}

export type SimulationReconciliationResult = Result.Result<MarkedEquityProof, readonly SimulationReconciliationIssue[]>

export type Validation<A> = Result.Result<A, readonly SimulationReconciliationIssue[]>
