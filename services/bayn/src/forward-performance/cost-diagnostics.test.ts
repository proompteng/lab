import { expect, test } from 'bun:test'
import { Result } from 'effect'

import { canonicalHashV1Result } from '../hash'
import { JevResearchPolicy } from '../jev/acceptance'
import { OperatingCostCategory, OperatingCostCoverage } from '../operating-costs'
import { evaluateSystemAssessment } from '../system-assessment/assessment'
import { supportedAssessmentFixture } from '../system-assessment/fixtures.test-support'
import { executionQualityFixture } from './execution-quality.test-support'
import type { ForwardInferenceExpenseSession } from './inference-expenses'
import { makeForwardPerformanceReport, recordForwardPerformancePersistence } from './report'

const evidence = () => {
  const input = executionQualityFixture(0)
  if (input.ledgerTotals === undefined) throw new Error('Expected ledger fixture')
  return { ...input, ledgerTotals: { ...input.ledgerTotals, otherChargedCostsMicros: null } }
}

test('keeps read-only evidence provisional and names missing cost sources', () => {
  const report = Result.getOrThrow(makeForwardPerformanceReport(evidence(), [], 'a'.repeat(64)))
  expect(report.receiptPersistence).toBe('NOT_CHECKED')
  expect(report.costDiagnostics).toMatchObject({
    receiptOperatingCharges: 'UNVERIFIED',
    meteredInference: { coverage: 'NO_SESSION_EVIDENCE', basis: 'FROZEN_TARIFF_ESTIMATE', invoiceReconciled: false },
    assessmentOperatingCosts: {
      coverage: 'NO_ASSESSMENT_ATTACHED',
      assessmentHash: null,
      registration: { status: 'NOT_INSPECTED', registrationHash: null },
      requiredEvidenceSchema: 'bayn.operating-cost-evidence.v1',
      requiredCategories: ['INFERENCE', 'DATA', 'INFRASTRUCTURE', 'RESEARCH'],
    },
  })
  expect(report.receipt.totals.otherChargedCostsMicros).toBeNull()
  expect(report.receipt.totals.netRealizedPnlAfterCostsMicros).toBeNull()
  const { reportHash, ...material } = report
  expect(Result.getOrThrow(canonicalHashV1Result(material))).toBe(reportHash)
})

test('scopes complete operating costs to their assessment without finalizing the generation receipt', () => {
  const { input, verifiedSources } = supportedAssessmentFixture()
  const assessment = Result.getOrThrow(evaluateSystemAssessment(input, verifiedSources))
  const report = Result.getOrThrow(makeForwardPerformanceReport(evidence(), [], undefined, assessment))
  expect(report.costDiagnostics.assessmentOperatingCosts).toMatchObject({
    coverage: 'COMPLETE',
    assessmentHash: assessment.assessmentHash,
    registration: { status: 'ATTACHED_ASSESSMENT', registrationHash: assessment.registrationHash },
    incompleteSessions: [],
  })
  expect(report.operatingCostCoverage).toBe('COMPLETE')
  expect(report.costDiagnostics.receiptOperatingCharges).toBe('UNVERIFIED')
  expect(report.receiptPersistence).toBe('NOT_CHECKED')
})

test('limits metered completeness to attached session cuts without completing receipt operating costs', () => {
  const expense: ForwardInferenceExpenseSession = {
    sessionDate: '2026-07-20',
    authorityGenerationHash: 'a'.repeat(64),
    sourceAsOf: '2026-07-20T14:00:00.100Z',
    knownEstimatedCostPicoUsd: '42000',
    claimedRequestCount: 1,
    missingQuoteCount: 0,
    unverifiedRequestCount: 0,
    gapRequestCount: 0,
    matchedQuoteHashes: ['b'.repeat(64)],
    requestsWithCoverageIssues: [],
    completeMeteredCoverage: true,
    exactSessionLedger: true,
    ledgerTimestampMax: '1791050000000000000',
    verifiedSessionTransferCount: 1,
    invoiceReconciled: false,
  }
  const report = Result.getOrThrow(makeForwardPerformanceReport(evidence(), [expense], 'a'.repeat(64)))
  expect(report.costDiagnostics.meteredInference).toMatchObject({
    scope: 'ATTACHED_SESSION_SNAPSHOTS',
    coverage: 'COMPLETE',
    invoiceReconciled: false,
    sessionSnapshots: [
      {
        sessionDate: expense.sessionDate,
        authorityGenerationHash: expense.authorityGenerationHash,
        sourceAsOf: expense.sourceAsOf,
      },
    ],
  })
  expect(report.operatingCostCoverage).toBe('INCOMPLETE')
  expect(report.costDiagnostics.receiptOperatingCharges).toBe('UNVERIFIED')
  expect(report.receipt.totals.netRealizedPnlAfterCostsMicros).toBeNull()
  const unverified = Result.getOrThrow(
    makeForwardPerformanceReport(
      evidence(),
      [{ ...expense, unverifiedRequestCount: 1, completeMeteredCoverage: false }],
      'a'.repeat(64),
    ),
  )
  expect(unverified.costDiagnostics.meteredInference.coverage).toBe('INCOMPLETE')
  expect(unverified.inferenceExpenses[0]?.knownEstimatedCostPicoUsd).toBe('42000')
  expect(unverified.costDiagnostics.meteredInference.basis).toBe('FROZEN_TARIFF_ESTIMATE')
})

test('identifies exact session and category sources instead of treating partial invoices as complete', () => {
  const { input, verifiedSources } = supportedAssessmentFixture()
  const assessment = Result.getOrThrow(evaluateSystemAssessment(input, verifiedSources))
  const candidate = assessment.policies.find((policy) => policy.policy === JevResearchPolicy.Candidate)
  const firstSession = candidate?.sessions[0]
  if (firstSession?.costs === null || firstSession === undefined) throw new Error('Expected session cost fixture')
  const incomplete = {
    ...assessment,
    policies: assessment.policies.map((policy) =>
      policy.policy !== JevResearchPolicy.Candidate
        ? policy
        : {
            ...policy,
            sessions: policy.sessions.map((session, index) =>
              index !== 0 || session.costs === null
                ? session
                : {
                    ...session,
                    costs: {
                      ...session.costs,
                      fullyCosted: false,
                      categories: session.costs.categories.map((category) =>
                        category.category === OperatingCostCategory.Infrastructure
                          ? { ...category, coverage: OperatingCostCoverage.Partial }
                          : category,
                      ),
                    },
                  },
            ),
          },
    ),
  }
  const report = Result.getOrThrow(makeForwardPerformanceReport(evidence(), [], undefined, incomplete))
  expect(report.costDiagnostics.assessmentOperatingCosts).toMatchObject({
    coverage: 'INCOMPLETE',
    incompleteSessions: [
      {
        sessionDate: firstSession.sessionDate,
        costReportHash: firstSession.costs.reportHash,
        incompleteCategories: [{ category: 'INFRASTRUCTURE', coverage: 'PARTIAL' }],
      },
    ],
  })
  expect(report.operatingCostCoverage).toBe('INCOMPLETE')
})

test('records successful persistence in the report hash without changing the immutable receipt', () => {
  const report = Result.getOrThrow(makeForwardPerformanceReport(executionQualityFixture(2), [], 'a'.repeat(64)))
  const persisted = Result.getOrThrow(recordForwardPerformancePersistence(report))
  expect(persisted.receiptPersistence).toBe('PERSISTED_TERMINAL')
  expect(persisted.receipt).toEqual(report.receipt)
  expect(persisted.reportHash).not.toBe(report.reportHash)
  const { reportHash, ...material } = persisted
  expect(Result.getOrThrow(canonicalHashV1Result(material))).toBe(reportHash)
})
