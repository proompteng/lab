import { expect, test } from 'bun:test'
import { Result } from 'effect'

import { evaluateSystemAssessment, EdgeStatus, ProfitabilityStatus, QualificationVerdict } from './assessment'
import { JevNumericalVerdict, JevAcceptanceVersion } from '../jev/acceptance'
import { registrationFixture, supportedAssessmentFixture } from './fixtures.test-support'
import { verifyStoredSystemRegistration } from './policy'

test('positive bootstrap diagnostics do not establish statistical coverage or qualify the system', () => {
  const { input, verifiedSources } = supportedAssessmentFixture(4)
  const report = Result.getOrThrow(evaluateSystemAssessment(input, verifiedSources))
  expect(report.numerical?.verdict).toBe(JevNumericalVerdict.Passed)
  expect(report.profitability.status).toBe(ProfitabilityStatus.Profitable)
  expect(report.edge.status).toBe(EdgeStatus.Undetermined)
  expect(report.verdict).toBe(QualificationVerdict.Inconclusive)
  expect(report.missing).toContain('STATISTICAL_COVERAGE_NOT_ESTABLISHED')
})

test('retained v4 receipts keep the recorded qualification semantics without reopening admission', () => {
  const registration = registrationFixture(undefined, 4, JevAcceptanceVersion.RetainedV4)
  expect(Result.getOrThrow(verifyStoredSystemRegistration(registration)).version).toBe(JevAcceptanceVersion.RetainedV4)
  const { input, verifiedSources } = supportedAssessmentFixture(4, registration)
  const report = Result.getOrThrow(evaluateSystemAssessment(input, verifiedSources, JevAcceptanceVersion.RetainedV4))
  expect(report.verdict).toBe(QualificationVerdict.Qualified)
  expect(report.edge.status).toBe(EdgeStatus.Established)
  expect(report.missing).not.toContain('STATISTICAL_COVERAGE_NOT_ESTABLISHED')
  expect(Result.isFailure(evaluateSystemAssessment(input, verifiedSources))).toBe(true)
})
