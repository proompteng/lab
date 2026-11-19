import { expect, test } from 'bun:test'
import { Result } from 'effect'

import { evaluateSystemAssessment, EdgeStatus, ProfitabilityStatus, QualificationVerdict } from './assessment'
import { JevNumericalVerdict, JevAcceptanceVersion } from '../jev/acceptance'
import { registrationFixture, supportedAssessmentFixture, testHash } from './fixtures.test-support'
import { verifyStoredSystemRegistration } from './policy'

test('positive bootstrap diagnostics do not establish statistical coverage or qualify the system', () => {
  const registration = registrationFixture(undefined, 4, JevAcceptanceVersion.RetainedV5)
  const { input, verifiedSources } = supportedAssessmentFixture(4, registration)
  const report = Result.getOrThrow(evaluateSystemAssessment(input, verifiedSources, JevAcceptanceVersion.RetainedV5))
  expect(report.numerical?.verdict).toBe(JevNumericalVerdict.Passed)
  expect(report.profitability.status).toBe(ProfitabilityStatus.Profitable)
  expect(report.edge.status).toBe(EdgeStatus.Undetermined)
  expect(report.verdict).toBe(QualificationVerdict.Inconclusive)
  expect(report.missing).toContain('STATISTICAL_COVERAGE_NOT_ESTABLISHED')
  // Captured by running the original evaluator at green source 4fe475892f73370382d5d63fa3d605c0bd08fb71.
  expect(testHash(registration)).toBe('479f8273ca4bf6340148051e54735a3f4a2045bde4bd38fccde3a694b19f3c52')
  expect(testHash(input)).toBe('08b1bce265501cb11c26830b14bc73425d9a220c7ddd0d162fb96081e9314e43')
  expect(report.assessmentHash).toBe('29215e0836afc9899190ae131ddbc36a933f082a9eddcef6328dc06e53df5e2f')
})

test('current reporting retains observed stress and activity diagnostics without making them qualification quotas', () => {
  const { input, verifiedSources } = supportedAssessmentFixture(4)
  const report = Result.getOrThrow(evaluateSystemAssessment(input, verifiedSources))
  if (report.numerical === null || !('metrics' in report.numerical) || report.numerical.metrics === undefined)
    throw new Error('Missing current diagnostics')
  expect(report.numerical.metrics.netPnlUsd).toBe(4000)
  expect(report.numerical.metrics.p95LatencyStressNetPnlUsd).toBe(4000)
  expect(report.numerical.metrics.netAfterDroppingBestSessionUsd).toBe(3000)
  expect(report.numerical.metrics.completedEpisodes).toBeGreaterThan(0)
  expect(report.numerical.metrics.controlNetPnlUsd.map((control) => control.netPnlUsd)).toEqual([400, 400, 400])
  expect(report.numerical.checks).not.toHaveProperty('frequency')
  expect(report.numerical.checks).not.toHaveProperty('p95BatchLatency')
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
