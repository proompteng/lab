import { describe, expect, test } from 'bun:test'
import { Result } from 'effect'

import { JevResearchPolicy } from '../jev/acceptance'
import { currentEquityMarketProfile } from '../jev/markets'
import { normalizeMarketCalendarResult } from '../broker/alpaca/normalizers'
import { captureQualificationRuntime } from './configuration'
import { sourceFitsRegisteredSession } from './decision-work'
import {
  nativeRegistrationFixture,
  registrationFixture,
  supportedAssessmentFixture,
  testHash,
  withRegistrationCommitments,
} from './fixtures.test-support'
import {
  isNativeSystemRegistration,
  nativeBrokerRecoveryClose,
  validateProspectiveSystemRegistration,
  verifyStoredSystemRegistration,
} from './policy'
import { assessSession } from './session'
import { ResearchStrategyEngine } from './strategy-binding'
import { preparedAlphaRegistrationFixture } from './prepared-alpha-registration.test-support'

describe('prospective engine-bound registration', () => {
  test('binds candidate and independently serving incumbent to their own complete engines', () => {
    for (const candidate of [ResearchStrategyEngine.Jev, ResearchStrategyEngine.IntradayAlpha] as const)
      for (const incumbent of [ResearchStrategyEngine.Jev, ResearchStrategyEngine.IntradayAlpha] as const) {
        const registration = preparedAlphaRegistrationFixture(undefined, { candidate, incumbent })
        const accepted = Result.getOrThrow(validateProspectiveSystemRegistration(registration))
        expect(accepted.registration.schemaVersion).toBe('bayn.system-registration.v7')
        expect(
          accepted.registration.policies.find((p) => p.policy === JevResearchPolicy.Candidate)?.strategyBinding.engine,
        ).toBe(candidate)
        expect(
          accepted.registration.policies.find((p) => p.policy === JevResearchPolicy.Incumbent)?.strategyBinding.engine,
        ).toBe(incumbent)
        expect(Result.getOrThrow(verifyStoredSystemRegistration(registration)).registrationHash).toBe(
          accepted.registrationHash,
        )
        expect(isNativeSystemRegistration(registration)).toBe(true)
      }
  })

  test('retained v5 reproduces exactly and cannot be relabeled as a new engine-bound admission', () => {
    const retained = nativeRegistrationFixture(registrationFixture())
    const hash = testHash(retained)
    const verified = Result.getOrThrow(verifyStoredSystemRegistration(retained))
    expect(verified.registration).toEqual(retained)
    expect(verified.registrationHash).toBe(hash)
    expect(Result.isFailure(validateProspectiveSystemRegistration(retained))).toBe(true)
    expect(
      Result.isFailure(verifyStoredSystemRegistration({ ...retained, schemaVersion: 'bayn.system-registration.v6' })),
    ).toBe(true)
    const current = preparedAlphaRegistrationFixture(retained)
    expect(
      Result.isFailure(verifyStoredSystemRegistration({ ...current, schemaVersion: 'bayn.system-registration.v5' })),
    ).toBe(true)
    expect(
      Result.isFailure(validateProspectiveSystemRegistration({ ...current, policyHash: retained.policyHash })),
    ).toBe(true)
    expect(nativeBrokerRecoveryClose(current)).toBe(nativeBrokerRecoveryClose(retained))
  })

  test('rejects missing, substituted or role-incompatible engine material on every policy', () => {
    const registration = preparedAlphaRegistrationFixture()
    const candidate = registration.policies.find((p) => p.policy === JevResearchPolicy.Candidate)
    if (candidate === undefined) throw new Error('Missing candidate')
    for (const selected of registration.policies) {
      const { strategyBinding: _binding, ...without } = selected
      for (const replacement of [
        without,
        { ...selected, parametersHash: testHash(registration.obligations.configuration.protocol) },
        { ...selected, strategyHash: testHash('different engine') },
        { ...selected, promptsHash: testHash('different prompt lifecycle') },
        { ...selected, continuationAndExitsHash: testHash('different exits') },
        { ...selected, strategyBinding: { ...selected.strategyBinding, protocolHash: candidate.protocolHash } },
        {
          ...selected,
          strategyBinding: { ...selected.strategyBinding, engine: ResearchStrategyEngine.RepeatedMomentum },
        },
      ]) {
        if (testHash(replacement) === testHash(selected)) continue
        expect(
          Result.isFailure(
            validateProspectiveSystemRegistration({
              ...registration,
              policies: registration.policies.map((p) => (p.policy === selected.policy ? replacement : p)),
            }),
          ),
        ).toBe(true)
      }
    }
  })

  test('runtime policy equality is checked even after the supplied runtime hash is recomputed', () => {
    const registration = preparedAlphaRegistrationFixture()
    const jev = preparedAlphaRegistrationFixture(undefined, { candidate: ResearchStrategyEngine.Jev })
    const configuration = registration.obligations.configuration
    for (const changed of [
      { ...configuration, strategyBinding: jev.obligations.configuration.strategyBinding },
      {
        ...configuration,
        protocol: { ...configuration.protocol, maximumDecisionLagMs: configuration.protocol.maximumDecisionLagMs + 1 },
      },
    ]) {
      const revised = withRegistrationCommitments({
        ...registration,
        obligations: { ...registration.obligations, configuration: changed },
      })
      expect(Result.isFailure(validateProspectiveSystemRegistration(revised))).toBe(true)
      expect(Result.isFailure(captureQualificationRuntime(changed, registration.obligations))).toBe(true)
    }
    const { strategyBinding: _binding, ...without } = configuration
    expect(
      Result.isFailure(
        validateProspectiveSystemRegistration({
          ...registration,
          obligations: { ...registration.obligations, configuration: without },
        }),
      ),
    ).toBe(true)
  })

  test('disabled alpha inference requires no Jev tariff while a Jev incumbent still requires complete tariffs', () => {
    const registration = preparedAlphaRegistrationFixture()
    const candidate = registration.policies.find((p) => p.policy === JevResearchPolicy.Candidate)
    expect(candidate?.inferenceRateCard.rates).toEqual([])
    expect(Result.isSuccess(validateProspectiveSystemRegistration(registration))).toBe(true)
    expect(
      Result.isFailure(
        validateProspectiveSystemRegistration({
          ...registration,
          policies: registration.policies.map((p) =>
            p.policy === JevResearchPolicy.Incumbent
              ? { ...p, inferenceRateCard: { ...p.inferenceRateCard, rates: [] } }
              : p,
          ),
        }),
      ),
    ).toBe(true)
    const alphaIncumbent = preparedAlphaRegistrationFixture(undefined, {
      incumbent: ResearchStrategyEngine.IntradayAlpha,
    })
    expect(
      alphaIncumbent.policies.find((p) => p.policy === JevResearchPolicy.Incumbent)?.inferenceRateCard.rates,
    ).toEqual([])
    expect(Result.isSuccess(validateProspectiveSystemRegistration(alphaIncumbent))).toBe(true)
  })

  test('native source windows cannot bypass the exact registered calendar through a new schema version', () => {
    const registration = preparedAlphaRegistrationFixture()
    const first = registration.calendar.sessions[0]
    if (first === undefined) throw new Error('Missing session')
    const observedAt = new Date(Date.parse(first.openAt) + 1000).toISOString()
    const manifest = {
      sessionDate: first.sessionDate,
      calendar: registration.calendar.marketCalendar,
      feed: currentEquityMarketProfile.feed,
      universeId: currentEquityMarketProfile.universeId,
      universeSymbolHash: currentEquityMarketProfile.universeSymbolHash,
    }
    expect(sourceFitsRegisteredSession(manifest, registration, observedAt)).toBe(true)
    const altered = {
      ...registration,
      calendar: {
        ...registration.calendar,
        sessions: registration.calendar.sessions.map((s, i) =>
          i === 0 ? { ...s, closeAt: new Date(Date.parse(s.closeAt) - 1000).toISOString() } : s,
        ),
      },
    }
    expect(sourceFitsRegisteredSession(manifest, altered, observedAt)).toBe(false)
    expect(Result.isFailure(validateProspectiveSystemRegistration(altered))).toBe(true)
    const calendar = Result.getOrThrow(
      normalizeMarketCalendarResult(
        [{ date: first.sessionDate, open: '09:30', close: '13:00', session_open: '0400', session_close: '2000' }],
        { start: first.sessionDate, end: first.sessionDate },
      ),
    )
    expect(sourceFitsRegisteredSession({ ...manifest, calendar }, registration, observedAt)).toBe(false)
  })

  test('native opening allocation and missing operating costs remain enforced for alpha', () => {
    const registration = preparedAlphaRegistrationFixture(nativeRegistrationFixture(registrationFixture(undefined, 1)))
    const { input, verifiedSources } = supportedAssessmentFixture(1, registration)
    const definition = registration.policies.find((p) => p.policy === JevResearchPolicy.Candidate)
    const session = input.policies.find((p) => p.policy === JevResearchPolicy.Candidate)?.sessions[0]
    if (definition === undefined || session?.financial === undefined || session.financial === null)
      throw new Error('Missing economic fixture')
    const result = Result.getOrThrow(
      assessSession(
        {
          ...session,
          financial: {
            ...session.financial,
            cashInventory: { ...session.financial.cashInventory, openingEquityMicros: '99999999999' },
          },
        },
        registration,
        definition,
        input.asOf,
        verifiedSources,
      ),
    )
    expect(result.violations).toContain('OPENING_ALLOCATION_MISMATCH')
    expect(
      Result.isFailure(
        assessSession(
          { ...session, operatingCosts: { ...session.operatingCosts, coverage: [] } },
          registration,
          definition,
          input.asOf,
          verifiedSources,
        ),
      ),
    ).toBe(true)
  })
})
