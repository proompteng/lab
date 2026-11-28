import type { IntradayAlphaDecisionReason, IntradayAlphaTarget } from '../strategy/intraday-alpha/decision'
import type { IntradayAlphaPhase } from '../strategy/intraday-alpha/constants'
import type { TargetPlanReason, TargetPlanStatus } from '../target-planner/model'
import type { ForwardPerformanceBuildBinding } from './model'

/** Verified native alpha instructions, independent of the terminal financial execution cohort. */
export interface NativeAlphaDecisionEvidence {
  readonly cycleId: string
  readonly accountId: string
  readonly authorityGenerationHash: string
  readonly decisionDocumentHash: string
  readonly decisionHash: string
  readonly decisionCreatedAt: string
  readonly sessionDate: string
  readonly phase: IntradayAlphaPhase
  readonly reason: IntradayAlphaDecisionReason
  readonly strategyProtocolHash: string
  readonly strategyBehaviorHash: string
  readonly strategyParameterHash: string
  readonly policySchemaVersion: 'bayn.intraday-alpha-policy.v2'
  readonly riskPolicyHash: string
  readonly qualificationBuild: ForwardPerformanceBuildBinding | null
  readonly activationBuild: ForwardPerformanceBuildBinding | null
  /** Neither qualification nor activation provenance proves the build that executed this decision. */
  readonly executingBuild: null
  readonly cycleState: 'PENDING' | 'ACTIVE' | 'COMPLETED' | 'NO_TRADE' | 'BLOCKED'
  readonly terminalAt: string | null
  readonly reconciledAt: string
  /** False means terminal order/fill evidence is outside the financial query, never an unfilled outcome. */
  readonly executionEvidenceInScope: boolean
  readonly dispatchable: boolean
  readonly selectedSymbols: readonly string[]
  readonly targetWeights: Readonly<Record<string, number>>
  readonly signals: IntradayAlphaTarget['signals']
  readonly targetPlan: {
    readonly status: TargetPlanStatus
    readonly reason: TargetPlanReason | null
    readonly legs: readonly {
      readonly symbol: string
      readonly side: 'BUY' | 'SELL'
      readonly quantityAtoms: string
      readonly referencePriceMicros: string | null
      /** The bound plan identity; its presence alone does not prove an intent was persisted or submitted. */
      readonly intentId: string | null
    }[]
  }
}
