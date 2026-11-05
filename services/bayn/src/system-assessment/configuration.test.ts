import { describe, expect, test } from 'bun:test'
import { Result } from 'effect'
import { registrationFixture } from './fixtures.test-support'
import { captureQualificationRuntime, qualificationDeadlines } from './configuration'
import { currentEntryMarkets } from '../execution/trading-scope'
import { MarketKind } from '../instruments'
import { validateSystemRegistration } from './policy'
import { evaluateSystemAssessment } from './assessment'
import { supportedAssessmentFixture, testHash, withRegistrationCommitments } from './fixtures.test-support'

describe('capture runtime compatibility', () => {
  test('reproduces an unchanged historical financial registration without changing its original hash', () => {
    const registered = registrationFixture().obligations
    expect(registered.configuration.entryMarkets).toBeUndefined()
    expect(registered.runtimeConfigurationHash).toBe(testHash(registered.configuration))
    const current = { ...registered.configuration, entryMarkets: currentEntryMarkets }
    const captured = Result.getOrThrow(captureQualificationRuntime(current, registered))
    expect(captured.runtimeConfiguration).toEqual(registered.configuration)
    expect(captured.runtimeConfiguration).not.toHaveProperty('entryMarkets')
    expect(captured.runtimeConfigurationHash).toBe(registered.runtimeConfigurationHash)
    expect(testHash(captured.runtimeConfiguration)).toBe(captured.runtimeConfigurationHash)
    expect(current.entryMarkets).toEqual(currentEntryMarkets)
  })

  test('still rejects every changed field committed by a historical financial registration', () => {
    const registered = registrationFixture().obligations
    const current = { ...registered.configuration, entryMarkets: currentEntryMarkets }
    for (const changed of [
      { ...current, controllerPlanHash: testHash('different controller') },
      { ...current, cyclePollIntervalMs: current.cyclePollIntervalMs + 1 },
      { ...current, operationTimeoutMs: current.operationTimeoutMs + 1 },
      { ...current, reconciliationIntervalMs: current.reconciliationIntervalMs + 1 },
      { ...current, reconciliationStaleThresholdMs: current.reconciliationStaleThresholdMs + 1 },
      { ...current, unknownMutationThresholdMs: current.unknownMutationThresholdMs + 1 },
      {
        ...current,
        protocol: { ...current.protocol, maximumDecisionLagMs: current.protocol.maximumDecisionLagMs + 1 },
      },
    ])
      expect(Result.isFailure(captureQualificationRuntime(changed, registered))).toBe(true)
    expect(
      Result.isFailure(
        captureQualificationRuntime(current, { ...registered, runtimeConfigurationHash: testHash('wrong') }),
      ),
    ).toBe(true)
  })

  test('keeps the entry-market commitment for registrations that include it', () => {
    const previous = registrationFixture().obligations
    const configuration = { ...previous.configuration, entryMarkets: currentEntryMarkets }
    const registered = { ...previous, configuration, runtimeConfigurationHash: testHash(configuration) }
    expect(Result.getOrThrow(captureQualificationRuntime(configuration, registered))).toEqual({
      runtimeConfiguration: configuration,
      runtimeConfigurationHash: registered.runtimeConfigurationHash,
    })
    expect(
      Result.isFailure(
        captureQualificationRuntime(
          { ...configuration, entryMarkets: [MarketKind.Equity, MarketKind.Crypto] },
          registered,
        ),
      ),
    ).toBe(true)
    expect(Result.isFailure(captureQualificationRuntime(previous.configuration, registered))).toBe(true)
    expect(
      Result.isFailure(
        captureQualificationRuntime(configuration, {
          ...registered,
          runtimeConfigurationHash: testHash(previous.configuration),
        }),
      ),
    ).toBe(true)
  })
})

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
