import { Data } from 'effect'

import type { IntradayMarketSnapshot } from '../../market-data'
import type { IsoDate } from '../../types'
import type { OpeningDriveMarketContext, OpeningDriveSessionBinding } from './model'

export interface OpeningDriveQualificationPolicy {
  readonly schemaVersion: 'bayn.opening-drive.qualification-policy.v1'
  readonly allocationMicros: string
  readonly annualizationSessions: 252
  readonly minimumSessions: number
  readonly minimumTradeSessions: number
  readonly power: {
    readonly method: 'normal-approximation-independent-sessions'
    readonly oneSidedAlpha: 0.05
    readonly targetPower: 0.8
    readonly minimumDetectableAnnualizedExcessReturn: number
    readonly assumedAnnualizedTrackingVolatility: number
  }
  readonly bootstrap: {
    readonly method: 'paired-circular-session-blocks'
    readonly samples: number
    readonly blockSessions: number
    readonly familyOneSidedAlpha: 0.05
    readonly minimumTailSamples: number
    readonly seedNamespace: 'bayn-opening-drive-qualification-v1'
  }
  readonly chronologicalFolds: {
    readonly count: number
    readonly minimumPositiveFraction: number
  }
  readonly maximumDrawdown: number
}

export interface OpeningDriveQualificationBinding {
  readonly sourceRevision: string
  readonly strategyBehaviorHash: string
  readonly protocolHash: string
  readonly policyHash: string
  readonly costModelHash: string
  /** Hash frozen in the qualification lock before any replay snapshot is inspected. */
  readonly evaluationCalendarHash: string
  /** Complete query and archive-watermark graph frozen before replay rows are loaded. */
  readonly replayVersionGraphHash: string
  readonly priorTrialReceiptHashes: readonly string[]
}

/** Complete finalized exchange-session window supplied before replay inputs are inspected. */
export interface OpeningDriveQualificationCalendar {
  readonly schemaVersion: 'bayn.opening-drive.qualification-calendar.v1'
  readonly source: 'signal.exchange_sessions_v1'
  readonly calendarVersion: string
  readonly firstSession: IsoDate
  readonly lastSession: IsoDate
  readonly finalizedAt: string
  readonly sessions: readonly OpeningDriveSessionBinding[]
  readonly contentHash: string
}

export interface OpeningDriveReplaySessionInput {
  readonly opening: OpeningDriveMarketContext
  readonly exit: IntradayMarketSnapshot
}

export interface OpeningDrivePortfolioReplay {
  readonly executedSymbols: readonly string[]
  readonly entryNotionalMicros: string
  readonly exitNotionalMicros: string
  readonly unclosedQuantityMicros: string
  readonly terminalRemainderNotionalMicros: string
  readonly flat: boolean
  readonly midpointGrossPnlMicros: string
  readonly quotedSpreadCostMicros: string
  readonly slippageCostMicros: string
  readonly feeCostMicros: string
  readonly netPnlMicros: string
  readonly return: number
}

export interface OpeningDriveSessionReplayMaterial {
  readonly schemaVersion: 'bayn.opening-drive.session-replay.v1'
  readonly sessionDate: IsoDate
  readonly calendarHash: string
  readonly openingSnapshotId: string
  readonly exitSnapshotId: string
  readonly decisionHash: string
  readonly candidate: OpeningDrivePortfolioReplay
  readonly benchmark: OpeningDrivePortfolioReplay
}

export interface OpeningDriveSessionReplay extends OpeningDriveSessionReplayMaterial {
  readonly receiptHash: string
}

export interface OpeningDriveQualificationGate {
  readonly name: string
  readonly passed: boolean
  readonly actual: number | string
  readonly required: number | string
}

export interface OpeningDriveQualificationReceiptMaterial {
  readonly schemaVersion: 'bayn.opening-drive.qualification-receipt.v1'
  readonly protocolHash: string
  readonly policyHash: string
  readonly costModelHash: string
  readonly calendarHash: string
  readonly sourceRevision: string
  readonly strategyBehaviorHash: string
  readonly priorTrialsHash: string
  readonly sessionsHash: string
  readonly firstSession: IsoDate
  readonly lastSession: IsoDate
  readonly sessionCount: number
  readonly tradeSessionCount: number
  readonly priorTrialCount: number
  readonly candidateOrdinal: number
  readonly adjustedOneSidedAlpha: number
  readonly bootstrapTailSamples: number
  readonly bootstrapSeedHash: string
  readonly bootstrapSamplesHash: string
  readonly candidateNetPnlMicros: string
  readonly candidateQuotedSpreadCostMicros: string
  readonly candidateSlippageCostMicros: string
  readonly candidateFeeCostMicros: string
  readonly benchmarkNetPnlMicros: string
  readonly benchmarkQuotedSpreadCostMicros: string
  readonly benchmarkSlippageCostMicros: string
  readonly benchmarkFeeCostMicros: string
  readonly candidateCompoundedReturn: number
  readonly benchmarkCompoundedReturn: number
  readonly candidateAnnualizedReturnLowerBound: number
  readonly excessAnnualizedReturnLowerBound: number
  readonly maximumDrawdown: number
  readonly positiveChronologicalFoldFraction: number
  readonly gates: readonly OpeningDriveQualificationGate[]
  readonly verdict: 'QUALIFIED' | 'REJECTED' | 'INSUFFICIENT'
  readonly reasonCodes: readonly string[]
}

export interface OpeningDriveQualificationReceipt extends OpeningDriveQualificationReceiptMaterial {
  readonly receiptHash: string
}

export interface OpeningDriveQualificationRun {
  readonly sessions: readonly OpeningDriveSessionReplay[]
  readonly receipt: OpeningDriveQualificationReceipt
}

export type OpeningDriveQualificationFailureReason =
  | 'input'
  | 'session-order'
  | 'snapshot-binding'
  | 'strategy-decision'
  | 'execution-cost'
  | 'canonicalization'
  | 'policy'
  | 'trial-lineage'
  | 'statistic'

export class OpeningDriveQualificationFailure extends Data.TaggedError('OpeningDriveQualificationFailure')<{
  readonly reason: OpeningDriveQualificationFailureReason
  readonly message: string
  readonly sessionDate?: string
  readonly symbol?: string
  readonly cause?: unknown
}> {}
