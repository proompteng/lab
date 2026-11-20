import { JevResearchPolicy } from '../jev/acceptance'
import { OperatingCostCategory, OperatingCostCoverage } from '../operating-costs'
import type { SystemAssessment } from '../system-assessment/assessment'
import type { ForwardInferenceExpenseSession } from './inference-expenses'
import type { ForwardPerformanceReceipt } from './model'

/** Each view retains its own evidence scope; metered estimates do not fill unknown charged costs. */
export const forwardCostDiagnostics = (
  receipt: ForwardPerformanceReceipt,
  expenses: readonly ForwardInferenceExpenseSession[],
  assessment: SystemAssessment | null,
) => {
  const sessions = assessment?.policies.find((policy) => policy.policy === JevResearchPolicy.Candidate)?.sessions ?? []
  const requiredCategories = Object.values(OperatingCostCategory)
  const incompleteSessions = sessions
    .filter((session) => session.costs?.fullyCosted !== true)
    .map((session) => ({
      sessionDate: session.sessionDate,
      costReportHash: session.costs?.reportHash ?? null,
      incompleteCategories: requiredCategories.flatMap((category) => {
        const recorded = session.costs?.categories.find((row) => row.category === category)
        return recorded?.coverage === OperatingCostCoverage.Complete
          ? []
          : [
              {
                category,
                coverage: recorded?.coverage ?? OperatingCostCoverage.Unknown,
                coverageSourceHash: recorded?.coverageSourceHash ?? null,
              },
            ]
      }),
    }))
  return {
    receiptOperatingCharges:
      receipt.totals.otherChargedCostsMicros === null ? ('UNVERIFIED' as const) : ('MEASURED' as const),
    meteredInference: {
      scope: 'ATTACHED_SESSION_SNAPSHOTS' as const,
      sessionSnapshots: expenses.map(({ sessionDate, authorityGenerationHash, sourceAsOf }) => ({
        sessionDate,
        authorityGenerationHash,
        sourceAsOf,
      })),
      coverage:
        expenses.length === 0
          ? ('NO_SESSION_EVIDENCE' as const)
          : expenses.every((session) => session.completeMeteredCoverage)
            ? ('COMPLETE' as const)
            : ('INCOMPLETE' as const),
      basis: 'FROZEN_TARIFF_ESTIMATE' as const,
      invoiceReconciled: false as const,
      inspectSessionCommand: 'bayn-inference-cost --ledger-session <sessionDate>',
    },
    assessmentOperatingCosts: {
      coverage:
        assessment === null
          ? ('NO_ASSESSMENT_ATTACHED' as const)
          : sessions.length === 0
            ? ('NO_CANDIDATE_SESSION_EVIDENCE' as const)
            : incompleteSessions.length === 0
              ? ('COMPLETE' as const)
              : ('INCOMPLETE' as const),
      assessmentHash: assessment?.assessmentHash ?? null,
      registration:
        assessment === null
          ? { status: 'NOT_INSPECTED' as const, registrationHash: null }
          : { status: 'ATTACHED_ASSESSMENT' as const, registrationHash: assessment.registrationHash },
      requiredEvidenceSchema: 'bayn.operating-cost-evidence.v1' as const,
      requiredCategories,
      incompleteSessions,
    },
  }
}
