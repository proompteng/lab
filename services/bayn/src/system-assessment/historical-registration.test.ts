import { expect, test } from 'bun:test'
import { Result } from 'effect'

import { JevAcceptanceVersion } from '../jev/acceptance'
import { canonicalHashV1Result } from '../hash'
import { historicalRegistrationFixture } from './historical-registration.test-support'
import { validateSystemRegistration, verifyStoredSystemRegistration } from './policy'
import { assessmentFixture } from './fixtures.test-support'
import { evaluateSystemAssessment, QualificationVerdict } from './assessment'

test('original v28 runtime and controls survive historical registration and assessment decoding', () => {
  const registration = historicalRegistrationFixture()
  const before = Result.getOrThrow(canonicalHashV1Result(registration))
  const stored = Result.getOrThrow(verifyStoredSystemRegistration(registration))
  expect(stored.version).toBe(JevAcceptanceVersion.RetainedV2)
  expect(stored.registrationHash).toBe(before)
  expect(stored.registration.obligations.configuration.protocol.schemaVersion).toBe('bayn.jev.protocol.v28')
  expect(Result.isFailure(validateSystemRegistration(registration))).toBe(true)
  const { input, verifiedSources } = assessmentFixture(registration)
  const report = Result.getOrThrow(evaluateSystemAssessment(input, verifiedSources, stored.version))
  expect(report.verdict).toBe(QualificationVerdict.Rejected)
  expect(Result.getOrThrow(canonicalHashV1Result(registration))).toBe(before)
})
