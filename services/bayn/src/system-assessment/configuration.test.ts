import { describe, expect, test } from 'bun:test'
import { Result } from 'effect'
import { registrationFixture } from './fixtures.test-support'
import { qualificationDeadlines } from './configuration'
import { validateSystemRegistration } from './policy'
import { evaluateSystemAssessment } from './assessment'
import { supportedAssessmentFixture, testHash, withRegistrationCommitments } from './fixtures.test-support'

describe('runtime-derived qualification deadlines', () => {
  test('locks the scheduler, reconciliation, request and recovery bounds independently', () => {
    const registration = registrationFixture()
    const runtime = registration.obligations.configuration
    const deadlines = Result.getOrThrow(qualificationDeadlines(runtime))
    expect(deadlines).toEqual({
      runtimeConfigurationHash: testHash(runtime),
      decisionIntervalMs: 60_000,
      decisionWindowMs: runtime.protocol.maximumDecisionLagMs,
      reconciliationIntervalMs: runtime.reconciliationIntervalMs,
      reconciliationFreshnessMs: runtime.reconciliationStaleThresholdMs,
      mutationDeadlineMs: runtime.operationTimeoutMs,
      recoveryDeadlineMs: runtime.unknownMutationThresholdMs,
    })
    for (const key of [
      'decisionIntervalMs',
      'decisionWindowMs',
      'reconciliationIntervalMs',
      'reconciliationFreshnessMs',
      'mutationDeadlineMs',
      'recoveryDeadlineMs',
    ] as const)
      expect(
        Result.isFailure(
          validateSystemRegistration({
            ...registration,
            obligations: { ...registration.obligations, [key]: registration.obligations[key] + 1 },
          }),
        ),
      ).toBe(true)
  })
  test('a changed protocol or unknown controller plan cannot establish the registered reliability claim', () => {
    const { input, verifiedSources } = supportedAssessmentFixture()
    const registration = input.registration
    const different = {
      ...registration,
      obligations: {
        ...registration.obligations,
        configuration: {
          ...registration.obligations.configuration,
          protocol: { ...registration.obligations.configuration.protocol, maximumDecisionLagMs: 30000 },
        },
      },
    }
    expect(Result.isFailure(validateSystemRegistration(withRegistrationCommitments(different)))).toBe(true)
    const unknown = withRegistrationCommitments({
      ...registration,
      obligations: {
        ...registration.obligations,
        configuration: { ...registration.obligations.configuration, controllerPlanHash: null },
      },
    })
    const result = Result.getOrThrow(evaluateSystemAssessment({ ...input, registration: unknown }, verifiedSources))
    expect(result.missing).toContain('MISSING_CONTROLLER_PLAN_BINDING')
    expect(result.verdict).not.toBe('QUALIFIED_PAPER')
  })
})
