import { Result } from 'effect'

import type { CycleRunResult } from '../cycle/runner/model'
import { DecisionReadinessReason } from '../cycle/runner/readiness'
import { Authority, KillState, ReconciliationStatus } from '../execution/contracts'
import { decodeJevPortfolio, JevPurpose } from '../jev/portfolio'
import type { ReconciliationPassResult } from '../reconciler'
import { accountEntryProtectionReasons, type Policy } from '../risk'
import { accountTradingDate, utcInstantFromEpochMillis } from '../time'

/** Recognize a blocked admission from this pass's existing preflight; never refresh or authorize from this proof. */
export const protectedAccountAdmission = (
  preflight: ReconciliationPassResult | undefined,
  policy: Policy,
  authorityGenerationHash: string,
  observedAt: string,
): Extract<CycleRunResult, { readonly outcome: 'ADMISSION_WAITING' }> | undefined => {
  if (preflight === undefined) return undefined
  const nowMs = Date.parse(observedAt)
  const { brokerState, riskContext, report } = preflight
  const authority = riskContext.authority
  if (
    !Number.isSafeInteger(nowMs) ||
    authority === null ||
    riskContext.authorityObservedAt === null ||
    authority.generationHash !== authorityGenerationHash ||
    authority.maximum !== Authority.Execution ||
    authority.effective !== Authority.Execution ||
    authority.kill !== KillState.Clear ||
    brokerState.account.accountId !== policy.accountId ||
    riskContext.tradingDate !== accountTradingDate(observedAt) ||
    riskContext.unknownMutationCount !== 0 ||
    report.reconciliation.status !== ReconciliationStatus.Exact ||
    !report.metrics.accountingExact ||
    report.reconciliation.reconciliationId !== brokerState.reconciliation.reconciliationId
  )
    return undefined
  const reasons = accountEntryProtectionReasons(
    {
      accountEquityMicros: BigInt(brokerState.account.equityMicros),
      dayStartEquityMicros: BigInt(riskContext.dayStartEquityMicros),
      peakEquityMicros: BigInt(riskContext.peakEquityMicros),
    },
    policy,
  )
  if (reasons.length === 0) return undefined
  const timestamps = [
    brokerState.account.observedAt,
    brokerState.positionsObservedAt,
    brokerState.ordersObservedAt,
    report.reconciliation.reconciledAt,
    riskContext.authorityObservedAt,
  ].map(Date.parse)
  if (timestamps.some((at) => !Number.isSafeInteger(at) || at > nowMs)) return undefined
  if (Date.parse(authority.updatedAt) > Date.parse(riskContext.authorityObservedAt)) return undefined
  const validUntilMs = Math.min(...timestamps) + policy.maxBrokerStateAgeMs
  if (!Number.isSafeInteger(validUntilMs) || nowMs >= validUntilMs) return undefined
  // This validates exact broker bytes, flat inventory and every historical order's settled state.
  // Ambiguous account state keeps its existing decision/recovery path rather than becoming a benign wait.
  if (Result.isFailure(decodeJevPortfolio({ purpose: JevPurpose.Entry, brokerState }))) return undefined
  return {
    outcome: 'ADMISSION_WAITING',
    observedAt,
    readiness: {
      reason: DecisionReadinessReason.AccountProtection,
      message: `Existing account limits block new entries: ${reasons.join(', ')}`,
    },
    admissionProtection: {
      authorityGenerationHash,
      authorityUpdatedAt: authority.updatedAt,
      reconciliationId: report.reconciliation.reconciliationId,
      tradingDate: riskContext.tradingDate,
      validUntil: utcInstantFromEpochMillis(validUntilMs),
    },
  }
}
