import { describe, expect, test } from 'bun:test'
import { Result, Schema } from 'effect'
import { registrationFixture } from './fixtures.test-support'
import { captureQualificationRuntime, qualificationDeadlines, QualificationRuntimeSchema } from './configuration'
import { currentEntryMarkets } from '../execution/trading-scope'
import { MarketKind } from '../instruments'
import { executionControllerPlanHash } from '../execution/controller-plan'
import { validateSystemRegistration } from './policy'
import { evaluateSystemAssessment } from './assessment'
import { supportedAssessmentFixture, testHash, withRegistrationCommitments } from './fixtures.test-support'
import { operationalRegistrationFixture } from './operational-period.test-support'
import { emptySourceCutFixture } from './source-cut.test-support'
import { bindOperationalObligations } from './operational-obligations'
import { measureReliability, ObligationClass, ReliabilityStatus } from './reliability'
import { strictParseOptions } from '../schemas'

describe('capture runtime compatibility', () => {
  test('a retained scoped null plan cannot borrow controller evidence or complete its scheduled obligations', () => {
    const base = operationalRegistrationFixture()
    const configuration = { ...base.obligations.configuration, controllerPlanHash: null }
    const registration = {
      ...base,
      obligations: { ...base.obligations, ...Result.getOrThrow(qualificationDeadlines(configuration)), configuration },
    }
    const captured = Result.getOrThrow(
      captureQualificationRuntime(base.obligations.configuration, registration.obligations),
    )
    expect(captured.runtimeConfiguration).toEqual(configuration)
    const { cut: original } = emptySourceCutFixture()
    const cut = {
      ...original,
      registrationHash: testHash(registration),
      runtimeConfigurationHash: captured.runtimeConfigurationHash,
      asOf: '2026-11-04T01:00:00.000Z',
      controllerPasses: [],
      durableObservations: [],
    }
    const bound = Result.getOrThrow(bindOperationalObligations(cut, registration, testHash(cut)))
    const reliability = Result.getOrThrow(measureReliability(bound.reliability, false, true))
    const reconciliation = reliability.classes.find((row) => row.class === ObligationClass.Reconciliation)
    expect(BigInt(reconciliation?.scheduled ?? '0')).toBeGreaterThan(0n)
    expect(reconciliation?.correctOnTime).toBe('0')
    expect(reliability.status).toBe(ReliabilityStatus.MissesTarget)
  })

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
    if (current.schemaVersion !== 'bayn.qualification-runtime.v1') throw new Error('Expected retained polling runtime')
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

  test('streaming registrations have no polling cadence and cannot capture a retained polling period', () => {
    const registered = registrationFixture().obligations
    const retained = registered.configuration
    if (retained.schemaVersion !== 'bayn.qualification-runtime.v1') throw new Error('Expected retained polling runtime')
    const { schemaVersion: _version, cyclePollIntervalMs: _poll, ...common } = retained
    const streaming = {
      ...common,
      schemaVersion: 'bayn.qualification-runtime.v2' as const,
      decisionTrigger: 'streaming' as const,
      entryMarkets: currentEntryMarkets,
    }
    const decoded = Result.getOrThrow(
      Schema.decodeUnknownResult(QualificationRuntimeSchema, strictParseOptions)(streaming),
    )
    expect(decoded).toEqual(streaming)
    expect(decoded).not.toHaveProperty('cyclePollIntervalMs')
    expect(
      Result.isFailure(
        Schema.decodeUnknownResult(
          QualificationRuntimeSchema,
          strictParseOptions,
        )({
          ...streaming,
          cyclePollIntervalMs: 30_000,
        }),
      ),
    ).toBe(true)
    expect(Result.isFailure(captureQualificationRuntime(streaming, registered))).toBe(true)
    const currentRegistration = { configuration: streaming, runtimeConfigurationHash: testHash(streaming) }
    expect(Result.getOrThrow(captureQualificationRuntime(streaming, currentRegistration))).toEqual({
      runtimeConfiguration: streaming,
      runtimeConfigurationHash: currentRegistration.runtimeConfigurationHash,
    })
    expect(Result.isFailure(captureQualificationRuntime(retained, currentRegistration))).toBe(true)
    expect(Schema.decodeUnknownSync(QualificationRuntimeSchema, strictParseOptions)(retained)).toEqual(retained)
    expect(testHash(registered.configuration)).toBe(registered.runtimeConfigurationHash)
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
    const captured = Result.getOrThrow(
      captureQualificationRuntime(
        {
          ...unknown.obligations.configuration,
          controllerPlanHash: executionControllerPlanHash,
          entryMarkets: currentEntryMarkets,
        },
        unknown.obligations,
      ),
    )
    expect(captured.runtimeConfiguration.controllerPlanHash).toBeNull()
    expect(captured.runtimeConfigurationHash).toBe(unknown.obligations.runtimeConfigurationHash)
    const result = Result.getOrThrow(evaluateSystemAssessment({ ...input, registration: unknown }, verifiedSources))
    expect(result.missing).toContain('MISSING_CONTROLLER_PLAN_BINDING')
    expect(result.verdict).not.toBe('QUALIFIED_PAPER')
  })
})
