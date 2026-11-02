import type { CycleRunResult } from '../cycle/runner/model'
import { DecisionReadinessReason } from '../cycle/runner/readiness'
import { JevPurpose } from '../jev/portfolio'
import type { ReconciliationPassResult } from '../reconciler'
import type { Policy } from '../risk'
import { decideAccountProtection, type AccountProtectionFacts } from '../jev/account-protection'

/** Recognize a blocked admission from this pass's existing preflight; never refresh or authorize from this proof. */
export const protectedAccountAdmission = (
  preflight: ReconciliationPassResult | undefined,
  policy: Policy,
  authorityGenerationHash: string,
  observedAt: string,
): Extract<CycleRunResult, { readonly outcome: 'ADMISSION_WAITING' }> | undefined => {
  if (preflight === undefined) return undefined
  const { brokerState, riskContext, report } = preflight
  const authority = riskContext.authority
  if (authority === null || riskContext.authorityObservedAt === null) return undefined
  const inputs: AccountProtectionFacts = {
    schemaVersion: 'bayn.account-protection-inputs.v1',
    observedAt,
    portfolio: { purpose: JevPurpose.Entry, brokerState },
    policy,
    authority,
    authorityObservedAt: riskContext.authorityObservedAt,
    reconciliation: report.reconciliation,
    accountingExact: report.metrics.accountingExact,
    tradingDate: riskContext.tradingDate,
    unknownMutationCount: riskContext.unknownMutationCount,
    dayStartEquityMicros: riskContext.dayStartEquityMicros,
    peakEquityMicros: riskContext.peakEquityMicros,
  }
  const decision = decideAccountProtection(inputs, authorityGenerationHash)
  if (decision === undefined) return undefined
  return {
    outcome: 'ADMISSION_WAITING',
    observedAt,
    readiness: {
      reason: DecisionReadinessReason.AccountProtection,
      message: `Existing account limits block new entries: ${decision.reasons.join(', ')}`,
    },
    admissionProtection: {
      ...decision.protection,
      inputs: decision.inputs,
    },
  }
}
